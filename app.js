/* ============================================================
   Capy Maze — a capybara maze game for iPad
   Play mode: generate mazes, drag Capy to the hot spring.
   Build mode: dig your own maze, test it, save it, share it.
   ============================================================ */

'use strict';

/* ---------------- helpers ---------------- */

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const key = c => c.x + ',' + c.y;
const same = (a, b) => a.x === b.x && a.y === b.y;
const manhattan = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

function rr(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function el(c, x, y, rx, ry) {
  c.beginPath();
  c.ellipse(x, y, Math.max(rx, 0.1), Math.max(ry, 0.1), 0, 0, TAU);
}

function b64urlEncode(str) {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return atob(str);
}

function bytesToB64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(str) {
  const raw = b64urlDecode(str);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

// Small deterministic PRNG so a generated maze can be shared as just its seed.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// localStorage access throws under iOS "Block All Cookies" and some WebViews
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } }

/* ---------------- maze model ---------------- */
// Wall bits per cell: 1=top, 2=right, 4=bottom, 8=left.

class Maze {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.walls = new Uint8Array(cols * rows).fill(15);
    this.mask = new Uint8Array(cols * rows).fill(1);  // 1 = playable cell, 0 = void (shaped mazes)
    this.start = { x: 0, y: 0 };
    this.goal = { x: cols - 1, y: rows - 1 };
    this.gen = null;  // {seed, cols, rows} while the maze is an untouched generator output
  }

  static DIRS = [
    { d: 1, dx: 0, dy: -1, o: 4 },
    { d: 2, dx: 1, dy: 0, o: 8 },
    { d: 4, dx: 0, dy: 1, o: 1 },
    { d: 8, dx: -1, dy: 0, o: 2 },
  ];

  i(x, y) { return y * this.cols + x; }
  inb(x, y) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }
  active(x, y) { return this.inb(x, y) && this.mask[this.i(x, y)] === 1; }

  dirBetween(a, b) {
    return Maze.DIRS.find(D => a.x + D.dx === b.x && a.y + D.dy === b.y) || null;
  }

  canPass(a, b) {
    if (!this.active(a.x, a.y) || !this.active(b.x, b.y)) return false;
    const D = this.dirBetween(a, b);
    if (!D) return false;
    return (this.walls[this.i(a.x, a.y)] & D.d) === 0;
  }

  removeWallBetween(a, b) {
    const D = this.dirBetween(a, b);
    if (!D || !this.active(a.x, a.y) || !this.active(b.x, b.y)) return false;
    this.walls[this.i(a.x, a.y)] &= ~D.d;
    this.walls[this.i(b.x, b.y)] &= ~D.o;
    this.gen = null;  // no longer reproducible from a seed
    return true;
  }

  addWallBetween(a, b) {
    const D = this.dirBetween(a, b);
    if (!D || !this.active(a.x, a.y) || !this.active(b.x, b.y)) return false;
    this.walls[this.i(a.x, a.y)] |= D.d;
    this.walls[this.i(b.x, b.y)] |= D.o;
    this.gen = null;
    return true;
  }

  // Iterative recursive-backtracker over the active mask: a perfect maze
  // (unique solution) covering every active cell of the shape.
  // Deterministic for a given seed — seed share links depend on this exact
  // algorithm, so changes here break previously shared #r= links.
  static generate(cols, rows, seed, shapeKey) {
    const s = seed === undefined ? (Math.random() * 0xFFFFFFFF) >>> 0 : seed >>> 0;
    const rng = mulberry32(s);
    const shape = SHAPES[shapeKey] ? shapeKey : 'square';
    const m = Maze.shaped(cols, rows, SHAPES[shape]);  // mask + farthest-apart start/goal
    const seen = new Uint8Array(cols * rows);
    // rejection-sample the carve origin: for squares this is the same two rng
    // calls as the original generator, so pre-shape seed links still reproduce
    let sx, sy, guard = 0;
    do {
      sx = Math.floor(rng() * cols);
      sy = Math.floor(rng() * rows);
    } while (!m.active(sx, sy) && ++guard < 1000);
    if (!m.active(sx, sy)) {
      const fi = m.mask.indexOf(1);
      sx = fi % cols;
      sy = (fi / cols) | 0;
    }
    const stack = [{ x: sx, y: sy }];
    seen[m.i(sx, sy)] = 1;
    while (stack.length) {
      const cur = stack[stack.length - 1];
      const options = [];
      for (const D of Maze.DIRS) {
        const nx = cur.x + D.dx, ny = cur.y + D.dy;
        if (m.active(nx, ny) && !seen[m.i(nx, ny)]) options.push({ x: nx, y: ny });
      }
      if (!options.length) { stack.pop(); continue; }
      const next = options[Math.floor(rng() * options.length)];
      m.removeWallBetween(cur, next);
      seen[m.i(next.x, next.y)] = 1;
      stack.push(next);
    }
    m.gen = { seed: s, cols, rows, shape };  // stamped last: carving above cleared it
    return m;
  }

  bfsFrom(sx, sy) {
    const n = this.cols * this.rows;
    const dist = new Int32Array(n).fill(-1);
    const prev = new Int32Array(n).fill(-1);
    if (!this.active(sx, sy)) return { dist, prev };
    const q = [this.i(sx, sy)];
    dist[q[0]] = 0;
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      const x = cur % this.cols, y = (cur / this.cols) | 0;
      for (const D of Maze.DIRS) {
        if (this.walls[cur] & D.d) continue;
        const nx = x + D.dx, ny = y + D.dy;
        if (!this.active(nx, ny)) continue;
        const ni = this.i(nx, ny);
        if (dist[ni] < 0) {
          dist[ni] = dist[cur] + 1;
          prev[ni] = cur;
          q.push(ni);
        }
      }
    }
    return { dist, prev };
  }

  isSolvable() {
    const { dist } = this.bfsFrom(this.start.x, this.start.y);
    return dist[this.i(this.goal.x, this.goal.y)] >= 0;
  }

  // Shortest path from an arbitrary cell to the goal, as a list of cells.
  pathToGoal(from) {
    const { dist, prev } = this.bfsFrom(from.x, from.y);
    const gi = this.i(this.goal.x, this.goal.y);
    if (dist[gi] < 0) return null;
    const path = [];
    let cur = gi;
    while (cur >= 0) {
      path.push({ x: cur % this.cols, y: (cur / this.cols) | 0 });
      cur = prev[cur];
    }
    return path.reverse();
  }

  clone() {
    const m = new Maze(this.cols, this.rows);
    m.walls.set(this.walls);
    m.mask.set(this.mask);
    m.start = { ...this.start };
    m.goal = { ...this.goal };
    m.gen = this.gen ? { ...this.gen } : null;
    return m;
  }

  // Compact v2 binary: header + 2 bits per cell (open right / open down),
  // plus 1 bit per cell of mask for shaped mazes. Keeps share URLs short
  // enough that iMessage reliably linkifies them.
  encode() {
    const n = this.cols * this.rows;
    const hasMask = this.mask.includes(0);
    const wallBytes = new Uint8Array(Math.ceil((n * 2) / 8));
    for (let i = 0; i < n; i++) {
      const x = i % this.cols, y = (i / this.cols) | 0;
      if (x + 1 < this.cols && !(this.walls[i] & 2)) wallBytes[(2 * i) >> 3] |= 1 << ((2 * i) & 7);
      if (y + 1 < this.rows && !(this.walls[i] & 4)) wallBytes[(2 * i + 1) >> 3] |= 1 << ((2 * i + 1) & 7);
    }
    const head = [2, this.cols, this.rows, hasMask ? 1 : 0,
      this.start.x, this.start.y, this.goal.x, this.goal.y];
    const maskBytes = hasMask ? new Uint8Array(Math.ceil(n / 8)) : new Uint8Array(0);
    if (hasMask) {
      for (let i = 0; i < n; i++) if (this.mask[i]) maskBytes[i >> 3] |= 1 << (i & 7);
    }
    const bytes = new Uint8Array(head.length + wallBytes.length + maskBytes.length);
    bytes.set(head);
    bytes.set(wallBytes, head.length);
    bytes.set(maskBytes, head.length + wallBytes.length);
    return bytesToB64url(bytes);
  }

  static decode(str) {
    const bytes = b64urlToBytes(str);
    if (bytes.length > 8 && bytes[0] === 2) return Maze.decodeV2(bytes);
    return Maze.decodeV1(str);  // legacy JSON links and old saved mazes
  }

  static decodeV2(bytes) {
    const c = bytes[1], r = bytes[2], flags = bytes[3];
    if (c < 2 || r < 2 || c > 40 || r > 40) throw new Error('bad size');
    const n = c * r;
    const wallLen = Math.ceil((n * 2) / 8);
    const maskLen = (flags & 1) ? Math.ceil(n / 8) : 0;
    if (bytes.length !== 8 + wallLen + maskLen) throw new Error('bad length');
    const m = new Maze(c, r);
    if (flags & 1) {
      for (let i = 0; i < n; i++) m.mask[i] = (bytes[8 + wallLen + (i >> 3)] >> (i & 7)) & 1;
      if (!m.mask.includes(1)) throw new Error('empty mask');
    }
    m.start = { x: clamp(bytes[4], 0, c - 1), y: clamp(bytes[5], 0, r - 1) };
    m.goal = { x: clamp(bytes[6], 0, c - 1), y: clamp(bytes[7], 0, r - 1) };
    if (same(m.start, m.goal)) throw new Error('bad endpoints');
    if (!m.active(m.start.x, m.start.y) || !m.active(m.goal.x, m.goal.y)) throw new Error('bad endpoints');
    for (let i = 0; i < n; i++) {
      const x = i % c, y = (i / c) | 0;
      if ((bytes[8 + ((2 * i) >> 3)] >> ((2 * i) & 7)) & 1) m.removeWallBetween({ x, y }, { x: x + 1, y });
      if ((bytes[8 + ((2 * i + 1) >> 3)] >> ((2 * i + 1) & 7)) & 1) m.removeWallBetween({ x, y }, { x, y: y + 1 });
    }
    m.sanitize();
    return m;
  }

  static decodeV1(str) {
    const o = JSON.parse(b64urlDecode(str));
    if (o.v !== 1) throw new Error('bad version');
    const c = o.c | 0, r = o.r | 0;
    if (c < 2 || r < 2 || c > 40 || r > 40) throw new Error('bad size');
    const raw = atob(o.w);
    if (raw.length !== c * r) throw new Error('bad walls');
    const m = new Maze(c, r);
    for (let i = 0; i < raw.length; i++) m.walls[i] = raw.charCodeAt(i) & 15;
    if (o.k) {
      const rawk = atob(o.k);
      if (rawk.length !== c * r) throw new Error('bad mask');
      for (let i = 0; i < rawk.length; i++) m.mask[i] = rawk.charCodeAt(i) & 1;
      if (!m.mask.includes(1)) throw new Error('empty mask');
    }
    m.start = { x: clamp(o.s[0] | 0, 0, c - 1), y: clamp(o.s[1] | 0, 0, r - 1) };
    m.goal = { x: clamp(o.g[0] | 0, 0, c - 1), y: clamp(o.g[1] | 0, 0, r - 1) };
    if (same(m.start, m.goal)) throw new Error('bad endpoints');
    if (!m.active(m.start.x, m.start.y) || !m.active(m.goal.x, m.goal.y)) throw new Error('bad endpoints');
    m.sanitize();
    return m;
  }

  // Enforce symmetric interior walls, solid outer border, and sealed void cells.
  sanitize() {
    for (let i = 0; i < this.mask.length; i++) {
      if (!this.mask[i]) this.walls[i] = 15;  // symmetry pass below seals the active side too
    }
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = this.i(x, y);
        if (x === 0) this.walls[i] |= 8;
        if (y === 0) this.walls[i] |= 1;
        if (x === this.cols - 1) this.walls[i] |= 2;
        if (y === this.rows - 1) this.walls[i] |= 4;
        if (x + 1 < this.cols) {
          const j = this.i(x + 1, y);
          if ((this.walls[i] & 2) || (this.walls[j] & 8)) {
            this.walls[i] |= 2; this.walls[j] |= 8;
          }
        }
        if (y + 1 < this.rows) {
          const j = this.i(x, y + 1);
          if ((this.walls[i] & 4) || (this.walls[j] & 1)) {
            this.walls[i] |= 4; this.walls[j] |= 1;
          }
        }
      }
    }
  }

  // BFS over grid adjacency within the mask (ignores walls) — used for shape
  // connectivity and placing start/goal, not for solving.
  maskBfs(sx, sy) {
    const dist = new Int32Array(this.cols * this.rows).fill(-1);
    if (!this.active(sx, sy)) return dist;
    const q = [this.i(sx, sy)];
    dist[q[0]] = 0;
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      const x = cur % this.cols, y = (cur / this.cols) | 0;
      for (const D of Maze.DIRS) {
        const nx = x + D.dx, ny = y + D.dy;
        if (!this.active(nx, ny)) continue;
        const ni = this.i(nx, ny);
        if (dist[ni] < 0) { dist[ni] = dist[cur] + 1; q.push(ni); }
      }
    }
    return dist;
  }

  // Shape functions can produce islands (grid rounding); keep only the biggest.
  pruneToLargestRegion() {
    const seen = new Uint8Array(this.cols * this.rows);
    let best = null;
    for (let i0 = 0; i0 < this.mask.length; i0++) {
      if (!this.mask[i0] || seen[i0]) continue;
      const comp = [i0];
      seen[i0] = 1;
      for (let h = 0; h < comp.length; h++) {
        const cur = comp[h];
        const x = cur % this.cols, y = (cur / this.cols) | 0;
        for (const D of Maze.DIRS) {
          const nx = x + D.dx, ny = y + D.dy;
          if (!this.inb(nx, ny)) continue;
          const ni = this.i(nx, ny);
          if (this.mask[ni] && !seen[ni]) { seen[ni] = 1; comp.push(ni); }
        }
      }
      if (!best || comp.length > best.length) best = comp;
    }
    if (!best) return;
    this.mask.fill(0);
    for (const i of best) this.mask[i] = 1;
  }

  // Two active cells as far apart as possible (double BFS), lower index first
  // so squares keep the traditional top-left start.
  farthestActivePair() {
    const toCell = i => ({ x: i % this.cols, y: (i / this.cols) | 0 });
    const far = d => { let bi = -1, bv = -1; for (let i = 0; i < d.length; i++) if (d[i] > bv) { bv = d[i]; bi = i; } return bi; };
    const first = this.mask.indexOf(1);
    if (first < 0) return [{ x: 0, y: 0 }, { x: this.cols - 1, y: this.rows - 1 }];
    const c0 = toCell(first);
    const a = far(this.maskBfs(c0.x, c0.y));
    const ca = toCell(a);
    const b = far(this.maskBfs(ca.x, ca.y));
    return a <= b ? [ca, toCell(b)] : [toCell(b), ca];
  }

  // Build a fully-walled maze whose playable area follows a shape function
  // over normalized cell-center coordinates u,v in [0,1].
  static shaped(cols, rows, shapeFn) {
    const m = new Maze(cols, rows);
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const u = (x + 0.5) / cols, v = (y + 0.5) / rows;
        m.mask[m.i(x, y)] = shapeFn(u, v) ? 1 : 0;
      }
    }
    m.pruneToLargestRegion();
    if (m.mask.reduce((s, b) => s + b, 0) < 8) m.mask.fill(1);  // degenerate shape → square
    m.sanitize();
    const [a, b] = m.farthestActivePair();
    m.start = a;
    m.goal = b;
    return m;
  }
}

// Shape templates over normalized coordinates (u across, v down, cell centers).
const SHAPES = {
  square: () => true,
  heart: (u, v) => {
    const x = (u - 0.5) * 2.4;
    const y = 1.375 - 2.5 * v;
    const q = x * x + y * y - 1;
    return q * q * q - x * x * y * y * y <= 0;
  },
  ring: (u, v) => {
    const dx = (u - 0.5) / 0.5, dy = (v - 0.5) / 0.5;
    const d = dx * dx + dy * dy;
    return d <= 1.02 && d >= 0.16;
  },
  diamond: (u, v) => Math.abs(u - 0.5) + Math.abs(v - 0.5) <= 0.52,
  capy: (u, v) => {
    const inEll = (cx, cy, rx, ry) => {
      const dx = (u - cx) / rx, dy = (v - cy) / ry;
      return dx * dx + dy * dy <= 1;
    };
    // head + two ears
    return inEll(0.5, 0.6, 0.44, 0.38) || inEll(0.22, 0.2, 0.15, 0.16) || inEll(0.78, 0.2, 0.15, 0.16);
  },
};

/* ---------------- sound ---------------- */

let audioCtx = null;
let muted = lsGet('capymaze.muted') === '1';
let yuzuMode = lsGet('capymaze.yuzumode') === '1';

function ac() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

function tone(f0, f1, dur, delay = 0, type = 'sine', vol = 0.12) {
  if (muted) return;
  try {
    const a = ac();
    const t0 = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(vol, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(a.destination);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  } catch (e) { /* audio is optional */ }
}

function squeak(delay = 0) {
  tone(700, 1500, 0.12, delay);
  tone(900, 1700, 0.1, delay + 0.13);
}

function winSound() {
  [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => tone(f, f, 0.2, i * 0.11, 'triangle', 0.14));
  squeak(0.55);
}

function collectSound(golden) {
  tone(golden ? 660 : 880, golden ? 990 : 1320, 0.08, 0, 'triangle', 0.08);
  if (golden) tone(1320, 1760, 0.1, 0.09, 'triangle', 0.07);
}

function nopeSound() {
  tone(220, 185, 0.12, 0, 'sine', 0.08);
  tone(185, 150, 0.14, 0.13, 'sine', 0.08);
}

/* ---------------- palette ---------------- */

const C = {
  ground: '#F6E7C6',
  groundEdge: '#E8D3A8',
  wall: '#7A4E2A',
  trail: 'rgba(232, 140, 44, .5)',
  hint: 'rgba(245, 158, 45, .8)',
  grid: 'rgba(122, 78, 42, .13)',
  capy: '#96683C',
  capyDark: '#6E4522',
  capyMuzzle: '#C49A6C',
  ink: '#2E2013',
  pool: '#7CC6DE',
  poolDeep: '#5FB2CB',
  poolLight: '#B7E4F0',
  stone: '#CBB38C',
  orange: '#F59E2D',
  orangeDeep: '#E5822B',
  leaf: '#7CB05B',
  grass: 'rgba(124, 176, 91, .4)',
  pink: 'rgba(240, 147, 122, .4)',
  steam: 'rgba(255, 255, 255, .55)',
};

const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------------- DOM ---------------- */

const $ = id => document.getElementById(id);
const canvas = $('mazeCanvas');
const ctx = canvas.getContext('2d');
const stage = $('stage');
const playBar = $('playBar');
const buildBar = $('buildBar');
const toastEl = $('toast');

/* ---------------- state ---------------- */

let mode = 'play';               // 'play' | 'build'
let play = null;                 // active play session
let build = null;                // builder session
let view = { ox: 0, oy: 0, cs: 0, w: 0, h: 0 };
let playerPx = { x: 0, y: 0, snap: true };
let toastTimer = null;
const sessionHints = { play: false, build: false };

function currentMaze() {
  return mode === 'build' ? (build && build.maze) : (play && play.maze);
}

/* ---------------- canvas sizing ---------------- */

function resizeCanvas() {
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.floor(rect.width - 16));  // stage side padding
  const h = Math.max(1, Math.floor(rect.height - 8));
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  view.w = w;
  view.h = h;
}

new ResizeObserver(resizeCanvas).observe(stage);
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 250));

function layout() {
  const m = currentMaze();
  if (!m) { view.cs = 0; return; }
  const pad = 16;
  const cs = Math.floor(Math.min((view.w - pad * 2) / m.cols, (view.h - pad * 2) / m.rows));
  view.cs = Math.max(cs, 0);
  view.ox = Math.round((view.w - view.cs * m.cols) / 2);
  view.oy = Math.round((view.h - view.cs * m.rows) / 2);
}

function cellCenter(c) {
  return { x: view.ox + (c.x + 0.5) * view.cs, y: view.oy + (c.y + 0.5) * view.cs };
}

function cellFromPoint(px, py) {
  const m = currentMaze();
  if (!m || view.cs <= 0) return null;
  return {
    x: clamp(Math.floor((px - view.ox) / view.cs), 0, m.cols - 1),
    y: clamp(Math.floor((py - view.oy) / view.cs), 0, m.rows - 1),
  };
}

/* ---------------- drawing ---------------- */

function drawGround(m) {
  const cs = view.cs;
  if (!m.mask.includes(0)) {
    const gw = cs * m.cols, gh = cs * m.rows;
    rr(ctx, view.ox - 9, view.oy - 9, gw + 18, gh + 18, 16);
    ctx.fillStyle = C.groundEdge;
    ctx.fill();
    rr(ctx, view.ox - 3, view.oy - 3, gw + 6, gh + 6, 11);
    ctx.fillStyle = C.ground;
    ctx.fill();
    return;
  }
  // shaped maze: draw ground per playable cell so the silhouette shows
  ctx.fillStyle = C.groundEdge;
  ctx.beginPath();
  for (let y = 0; y < m.rows; y++)
    for (let x = 0; x < m.cols; x++)
      if (m.mask[m.i(x, y)]) ctx.rect(view.ox + x * cs - 6, view.oy + y * cs - 6, cs + 12, cs + 12);
  ctx.fill();
  ctx.fillStyle = C.ground;
  ctx.beginPath();
  for (let y = 0; y < m.rows; y++)
    for (let x = 0; x < m.cols; x++)
      if (m.mask[m.i(x, y)]) ctx.rect(view.ox + x * cs - 1, view.oy + y * cs - 1, cs + 2, cs + 2);
  ctx.fill();
}

function drawGrid(m) {
  const cs = view.cs;
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      if (!m.mask[m.i(x, y)]) continue;
      const px = view.ox + x * cs, py = view.oy + y * cs;
      if (x > 0 && m.mask[m.i(x - 1, y)]) { ctx.moveTo(px, py); ctx.lineTo(px, py + cs); }
      if (y > 0 && m.mask[m.i(x, y - 1)]) { ctx.moveTo(px, py); ctx.lineTo(px + cs, py); }
    }
  }
  ctx.stroke();
}

// Build mode: cells that are still fully walled read as solid "dirt" you can dig.
function drawDirt(m) {
  const cs = view.cs;
  ctx.fillStyle = 'rgba(150, 106, 55, .30)';
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      if (!m.mask[m.i(x, y)] || m.walls[m.i(x, y)] !== 15) continue;
      rr(ctx, view.ox + x * cs + cs * 0.07, view.oy + y * cs + cs * 0.07, cs * 0.86, cs * 0.86, cs * 0.2);
      ctx.fill();
    }
  }
}

function drawSpringGlow(m, t) {
  const c = cellCenter(m.goal);
  const pulse = REDUCED ? 0.5 : 0.5 + 0.5 * Math.sin(t / 350);
  ctx.save();
  ctx.globalAlpha = 0.3 + 0.4 * pulse;
  ctx.strokeStyle = '#F5C24D';
  ctx.lineWidth = Math.max(2, view.cs * 0.06);
  ctx.beginPath();
  ctx.arc(c.x, c.y, view.cs * (0.4 + 0.05 * pulse), 0, TAU);
  ctx.stroke();
  ctx.restore();
}

function drawWalls(m) {
  const cs = view.cs;
  ctx.strokeStyle = C.wall;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(3, cs * 0.16);
  ctx.beginPath();
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      if (!m.mask[m.i(x, y)]) continue;  // void cells draw nothing; active side owns the boundary
      const b = m.walls[m.i(x, y)];
      const px = view.ox + x * cs, py = view.oy + y * cs;
      if (b & 1) { ctx.moveTo(px, py); ctx.lineTo(px + cs, py); }
      if (b & 8) { ctx.moveTo(px, py); ctx.lineTo(px, py + cs); }
      if ((x === m.cols - 1 || !m.mask[m.i(x + 1, y)]) && (b & 2)) { ctx.moveTo(px + cs, py); ctx.lineTo(px + cs, py + cs); }
      if ((y === m.rows - 1 || !m.mask[m.i(x, y + 1)]) && (b & 4)) { ctx.moveTo(px, py + cs); ctx.lineTo(px + cs, py + cs); }
    }
  }
  ctx.stroke();
}

function drawStartPad(m) {
  const c = cellCenter(m.start);
  const s = view.cs;
  ctx.fillStyle = C.grass;
  el(ctx, c.x, c.y + s * 0.22, s * 0.34, s * 0.14);
  ctx.fill();
}

function drawTrail(path) {
  if (!path || path.length < 2) return;
  ctx.strokeStyle = C.trail;
  ctx.lineWidth = view.cs * 0.3;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const p0 = cellCenter(path[0]);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < path.length; i++) {
    const p = cellCenter(path[i]);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function drawHint(t) {
  if (mode !== 'play' || !play || !play.hint) return;
  const remaining = play.hint.until - t;
  if (remaining <= 0) { play.hint = null; return; }
  const alpha = Math.min(1, remaining / 800);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = C.hint;
  for (const cell of play.hint.cells) {
    const c = cellCenter(cell);
    el(ctx, c.x, c.y, view.cs * 0.13, view.cs * 0.13);
    ctx.fill();
  }
  ctx.restore();
}

function drawSpring(m, t) {
  const c = cellCenter(m.goal);
  const s = view.cs * 0.86;
  // stone rim + pool
  ctx.fillStyle = C.stone;
  el(ctx, c.x, c.y, s * 0.44, s * 0.35);
  ctx.fill();
  ctx.fillStyle = C.poolDeep;
  el(ctx, c.x, c.y, s * 0.37, s * 0.28);
  ctx.fill();
  ctx.fillStyle = C.pool;
  el(ctx, c.x, c.y - s * 0.02, s * 0.32, s * 0.23);
  ctx.fill();
  ctx.fillStyle = C.poolLight;
  el(ctx, c.x - s * 0.09, c.y - s * 0.08, s * 0.14, s * 0.07);
  ctx.fill();
  // floating yuzu
  const bx = REDUCED ? 0 : Math.sin(t / 1100) * s * 0.05;
  const by = REDUCED ? 0 : Math.cos(t / 900) * s * 0.02;
  ctx.fillStyle = C.orange;
  el(ctx, c.x + s * 0.1 + bx, c.y + s * 0.03 + by, s * 0.1, s * 0.085);
  ctx.fill();
  ctx.strokeStyle = C.orangeDeep;
  ctx.lineWidth = Math.max(1, s * 0.018);
  ctx.stroke();
  // steam
  if (!REDUCED) {
    ctx.lineWidth = Math.max(1.5, s * 0.045);
    ctx.lineCap = 'round';
    for (const k of [-0.12, 0.1]) {
      const phase = t / 600 + k * 30;
      ctx.strokeStyle = C.steam;
      ctx.save();
      ctx.globalAlpha = 0.35 + 0.25 * Math.sin(phase);
      ctx.beginPath();
      const x0 = c.x + k * s;
      ctx.moveTo(x0, c.y - s * 0.22);
      ctx.quadraticCurveTo(
        x0 + Math.sin(phase) * s * 0.09, c.y - s * 0.38,
        x0 + Math.sin(phase + 1.2) * s * 0.05, c.y - s * 0.52
      );
      ctx.stroke();
      ctx.restore();
    }
  }
}

function drawYuzuItems(t) {
  if (mode !== 'play' || !play || !play.yuzu) return;
  const cs = view.cs;
  for (const [k, it] of play.yuzu.items) {
    if (it.collected) continue;
    const [x, y] = k.split(',').map(Number);
    const c = cellCenter({ x, y });
    const bob = REDUCED ? 0 : Math.sin(t / 400 + x * 1.7 + y * 2.3) * cs * 0.02;
    const golden = it.v === 5;
    ctx.fillStyle = golden ? '#F5C24D' : C.orange;
    el(ctx, c.x, c.y + bob, cs * (golden ? 0.19 : 0.15), cs * (golden ? 0.17 : 0.14));
    ctx.fill();
    ctx.strokeStyle = golden ? '#D99A1B' : C.orangeDeep;
    ctx.lineWidth = Math.max(1, cs * 0.02);
    ctx.stroke();
    ctx.fillStyle = C.leaf;
    ctx.save();
    ctx.translate(c.x + cs * 0.02, c.y + bob - cs * (golden ? 0.17 : 0.14));
    ctx.rotate(-0.5);
    el(ctx, 0, 0, cs * 0.055, cs * 0.028);
    ctx.fill();
    ctx.restore();
    if (golden) {
      ctx.strokeStyle = 'rgba(255,255,255,.9)';
      ctx.lineWidth = Math.max(1, cs * 0.025);
      ctx.lineCap = 'round';
      const sx = c.x + cs * 0.11, sy = c.y + bob - cs * 0.1, r = cs * 0.05;
      ctx.beginPath();
      ctx.moveTo(sx - r, sy); ctx.lineTo(sx + r, sy);
      ctx.moveTo(sx, sy - r); ctx.lineTo(sx, sy + r);
      ctx.stroke();
    }
  }
}

function drawYuzuSign(m) {
  if (mode !== 'play' || !play || !play.yuzu) return;
  const cs = view.cs;
  const c = cellCenter(m.goal);
  const w = cs * 1.25, h = cs * 0.44;
  const y = m.goal.y === 0 ? c.y + cs * 0.46 : c.y - cs * 0.84;
  rr(ctx, c.x - w / 2, y, w, h, h / 2);
  ctx.fillStyle = 'rgba(122, 78, 42, .92)';
  ctx.fill();
  ctx.fillStyle = '#FFF3DC';
  ctx.font = `700 ${Math.max(10, cs * 0.26)}px "Baloo 2", ui-rounded, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`🍊 ${play.yuzu.pouch}/${play.yuzu.target}`, c.x, y + h / 2 + 1);
}

function drawCapy(cx, cy, size, fx, t, happy) {
  const s = size;
  ctx.save();
  ctx.translate(cx, cy);
  const bob = (REDUCED || happy) ? 0 : Math.sin(t / 300) * s * 0.03;
  ctx.translate(0, bob);
  ctx.scale(fx, 1);
  // legs
  ctx.fillStyle = C.capyDark;
  rr(ctx, -0.32 * s, 0.14 * s, 0.15 * s, 0.24 * s, 0.07 * s); ctx.fill();
  rr(ctx, 0.08 * s, 0.14 * s, 0.15 * s, 0.24 * s, 0.07 * s); ctx.fill();
  // body
  ctx.fillStyle = C.capy;
  el(ctx, -0.06 * s, 0, 0.42 * s, 0.3 * s); ctx.fill();
  // head
  el(ctx, 0.28 * s, -0.14 * s, 0.24 * s, 0.21 * s); ctx.fill();
  // ears
  ctx.fillStyle = C.capyDark;
  el(ctx, 0.16 * s, -0.32 * s, 0.06 * s, 0.06 * s); ctx.fill();
  el(ctx, 0.34 * s, -0.3 * s, 0.055 * s, 0.055 * s); ctx.fill();
  // yuzu hat
  ctx.fillStyle = C.orange;
  el(ctx, -0.02 * s, -0.31 * s, 0.085 * s, 0.08 * s); ctx.fill();
  ctx.strokeStyle = C.orangeDeep;
  ctx.lineWidth = Math.max(1, s * 0.018);
  ctx.stroke();
  ctx.fillStyle = C.leaf;
  ctx.save();
  ctx.translate(0.045 * s, -0.38 * s);
  ctx.rotate(-0.5);
  el(ctx, 0, 0, 0.05 * s, 0.024 * s); ctx.fill();
  ctx.restore();
  // muzzle
  ctx.fillStyle = C.capyMuzzle;
  el(ctx, 0.46 * s, -0.08 * s, 0.12 * s, 0.1 * s); ctx.fill();
  // nose
  ctx.fillStyle = C.ink;
  el(ctx, 0.51 * s, -0.12 * s, 0.032 * s, 0.024 * s); ctx.fill();
  // eye
  if (happy) {
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = Math.max(1.5, s * 0.035);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0.31 * s, -0.19 * s, 0.045 * s, Math.PI * 1.15, Math.PI * 1.85);
    ctx.stroke();
  } else {
    ctx.fillStyle = C.ink;
    el(ctx, 0.31 * s, -0.2 * s, 0.034 * s, 0.034 * s); ctx.fill();
  }
  // blush
  ctx.fillStyle = C.pink;
  el(ctx, 0.36 * s, -0.09 * s, 0.045 * s, 0.038 * s); ctx.fill();
  ctx.restore();
}

function render(t) {
  ctx.clearRect(0, 0, view.w, view.h);
  layout();
  const m = currentMaze();
  if (!m || view.cs <= 2) return;

  drawGround(m);
  if (mode === 'build') { drawDirt(m); drawGrid(m); }
  drawStartPad(m);
  if (mode === 'play' && play) drawTrail(play.path);
  drawHint(t);
  drawSpring(m, t);
  drawYuzuItems(t);
  drawWalls(m);
  if (mode === 'build' && build && build.solvable) drawSpringGlow(m, t);
  drawYuzuSign(m);

  // capybara
  const capySize = view.cs * 0.74;
  if (mode === 'play' && play) {
    const head = play.path[play.path.length - 1];
    const target = cellCenter(head);
    if (playerPx.snap) {
      playerPx.x = target.x; playerPx.y = target.y; playerPx.snap = false;
    } else {
      playerPx.x += (target.x - playerPx.x) * 0.35;
      playerPx.y += (target.y - playerPx.y) * 0.35;
    }
    drawCapy(playerPx.x, playerPx.y, capySize, play.fx, t, play.done);
  } else if (mode === 'build' && build) {
    const c = cellCenter(build.maze.start);
    drawCapy(c.x, c.y, capySize, 1, t, false);
  }
}

/* ---------------- HUD / main loop ---------------- */

const statTime = $('statTime');
const statSteps = $('statSteps');

function fmtTime(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = Math.floor(total / 60);
  const ss = String(total % 60).padStart(2, '0');
  return mm + ':' + ss;
}

function updateHud() {
  if (!play) return;
  let elapsed = 0;
  if (play.started) {
    elapsed = (play.done ? play.finishedAt : performance.now()) - play.started;
  }
  const timeText = fmtTime(elapsed);
  if (statTime.textContent !== timeText) statTime.textContent = timeText;
  const stepsText = String(play.moves);
  if (statSteps.textContent !== stepsText) statSteps.textContent = stepsText;
  const yz = $('statYuzu');
  if (play.yuzu) {
    const txt = `🍊 ${play.yuzu.pouch}/${play.yuzu.target} · `;
    if (yz.textContent !== txt) yz.textContent = txt;
    yz.style.display = '';
  } else {
    yz.style.display = 'none';
  }
}

function frame(t) {
  // no point repainting the maze underneath a modal overlay
  if (!document.querySelector('.overlay:not(.hidden)')) {
    render(t);
    updateHud();
  }
  requestAnimationFrame(frame);
}

/* ---------------- pointer input ---------------- */

let activePointer = null;
let lastPointPx = null;
let dragLastCell = null;   // build-mode drag anchor

function pointFromEvent(e) {
  // recompute each event: the canvas can move mid-drag (toolbar rewrap, Split View resize)
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

canvas.addEventListener('pointerdown', e => {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (activePointer !== null) return;
  if (!muted) { try { ac(); } catch (err) { /* iOS unlocks audio on this gesture */ } }
  activePointer = e.pointerId;
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
  const p = pointFromEvent(e);
  lastPointPx = p;
  dragLastCell = null;
  handleSample(p, true);
  e.preventDefault();
});

canvas.addEventListener('pointermove', e => {
  if (e.pointerId !== activePointer) return;
  const p = pointFromEvent(e);
  // interpolate in pixel space so fast swipes touch every cell on the way
  const step = Math.max(4, view.cs / 3);
  const d = Math.hypot(p.x - lastPointPx.x, p.y - lastPointPx.y);
  const n = Math.max(1, Math.ceil(d / step));
  for (let i = 1; i <= n; i++) {
    handleSample({
      x: lastPointPx.x + (p.x - lastPointPx.x) * i / n,
      y: lastPointPx.y + (p.y - lastPointPx.y) * i / n,
    }, false);
  }
  lastPointPx = p;
  e.preventDefault();
});

function endPointer(e) {
  if (e.pointerId !== activePointer) return;
  finishBuildStroke();
  activePointer = null;
  lastPointPx = null;
  dragLastCell = null;
}

// Runs only for the stroke-owning pointer (endPointer guards the id), on both
// pointerup and pointercancel.
function finishBuildStroke() {
  if (mode !== 'build' || !build) return;
  // drop no-op snapshots so Undo always does something visible
  if (build.undo.length > 0 && !strokeChanged) {
    const s = build.undo[build.undo.length - 1];
    const sameWalls = build.maze.walls.every((v, i) => v === s.walls[i]);
    if (sameWalls && same(s.start, build.maze.start) && same(s.goal, build.maze.goal)) {
      build.undo.pop();
      updateUndoBtn();
    }
  }
  // after placing Capy or the spring, hop back to digging so kids don't get stuck in a tool
  if (placedThisStroke) {
    placedThisStroke = false;
    setTool('dig');
  }
}

canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('gesturestart', e => e.preventDefault());

function handleSample(p, isDown) {
  const cell = cellFromPoint(p.x, p.y);
  if (!cell) return;
  if (mode === 'play') playSample(cell);
  else buildSample(cell, isDown);
}

/* ---------------- play mode ---------------- */

function playSample(cell) {
  if (!play || play.done) return;
  const head = play.path[play.path.length - 1];
  if (same(cell, head)) return;

  const k = key(cell);
  const existing = play.idx.get(k);
  if (existing !== undefined) {
    // dragged back onto an earlier part of the trail: truncate to there —
    // but only via a legal step, never by teleporting through a wall
    const prev = play.path.length > 1 ? play.path[play.path.length - 2] : null;
    const legalBack = (prev && same(cell, prev)) ||
      (manhattan(head, cell) === 1 && play.maze.canPass(head, cell));
    if (!legalBack) return;
    while (play.path.length - 1 > existing) {
      const removed = play.path.pop();
      play.idx.delete(key(removed));
      if (play.yuzu) {
        const it = play.yuzu.items.get(key(removed));
        if (it && it.collected) {
          it.collected = false;   // un-munch: walking back returns the yuzu
          play.yuzu.pouch -= it.v;
        }
      }
    }
    const newHead = play.path[play.path.length - 1];
    if (newHead.x !== head.x) play.fx = newHead.x > head.x ? 1 : -1;
    return;
  }

  if (manhattan(head, cell) === 1) {
    if (play.maze.canPass(head, cell)) extendTo(cell, head);
    return;
  }

  // forgiving corner handling: pointer skipped diagonally by one cell
  if (manhattan(head, cell) === 2 && Math.abs(head.x - cell.x) === 1) {
    const midA = { x: cell.x, y: head.y };
    const midB = { x: head.x, y: cell.y };
    for (const mid of [midA, midB]) {
      if (play.maze.canPass(head, mid) && play.maze.canPass(mid, cell)) {
        if (play.idx.get(key(mid)) === undefined) extendTo(mid, head);
        else playSample(mid);
        const h2 = play.path[play.path.length - 1];
        if (same(h2, mid) && play.maze.canPass(mid, cell)) extendTo(cell, mid);
        return;
      }
    }
  }
}

function extendTo(cell, from) {
  if (play.done) return;
  play.path.push(cell);
  play.idx.set(key(cell), play.path.length - 1);
  play.moves++;
  if (!play.started) play.started = performance.now();
  if (cell.x !== from.x) play.fx = cell.x > from.x ? 1 : -1;
  if (play.yuzu) {
    const it = play.yuzu.items.get(key(cell));
    if (it && !it.collected) {
      it.collected = true;
      play.yuzu.pouch += it.v;
      collectSound(it.v === 5);
    }
  }
  if (same(cell, play.maze.goal)) {
    if (!play.yuzu || play.yuzu.pouch === play.yuzu.target) onWin();
    else yuzuNotYet();
  }
}

/* ---------------- Yuzu Ten (make-the-target collecting) ---------------- */

// Layout derives from the maze's generation seed, so a shared seed link gives
// both players identical yuzus — fair races. Non-generated mazes fall back to
// a random layout.
function setupYuzu(maze) {
  const seedBase = maze.gen ? maze.gen.seed : (Math.random() * 0xFFFFFFFF) >>> 0;
  const rng = mulberry32((seedBase ^ 0x9E3779B9) >>> 0);
  const size = Math.max(maze.cols, maze.rows);
  const [lo, hi] = size >= 22 ? [15, 20] : size >= 16 ? [13, 17] : size >= 12 ? [10, 14] : [8, 10];
  let target = lo + Math.floor(rng() * (hi - lo + 1));
  const goldens = target >= 12 ? 2 : 1;                    // golden yuzu = 5
  const surplus = 4 + Math.floor(rng() * 4);               // extra value forces choosing a route
  const singles = target + surplus - goldens * 5;          // all-goldens + singles always compose the target
  const cells = [];
  for (let y = 0; y < maze.rows; y++) {
    for (let x = 0; x < maze.cols; x++) {
      if (!maze.active(x, y)) continue;
      if (same({ x, y }, maze.start) || same({ x, y }, maze.goal)) continue;
      cells.push({ x, y });
    }
  }
  for (let i = cells.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cells[i], cells[j]] = [cells[j], cells[i]];
  }
  const need = goldens + singles;
  const picked = [];
  const nearPicked = c => picked.some(p => Math.abs(p.x - c.x) + Math.abs(p.y - c.y) <= 1);
  for (const c of cells) { if (picked.length >= need) break; if (!nearPicked(c)) picked.push(c); }
  for (const c of cells) { if (picked.length >= need) break; if (!picked.includes(c)) picked.push(c); }
  const items = new Map();
  picked.slice(0, goldens).forEach(c => items.set(key(c), { v: 5, collected: false }));
  picked.slice(goldens).forEach(c => items.set(key(c), { v: 1, collected: false }));
  let placedValue = 0;
  items.forEach(it => { placedValue += it.v; });
  if (placedValue < target) target = Math.max(2, placedValue);  // tiny shaped mazes: collect everything
  return { target, items, pouch: 0 };
}

function yuzuNotYet() {
  const { pouch, target } = play.yuzu;
  nopeSound();
  toast(pouch < target
    ? `Capy has ${pouch} — he needs ${target - pouch} more 🍊!`
    : `${pouch - target} too many! Walk back along the trail to un-munch 🍊`, 2600);
}

function currentShape() {
  const active = document.querySelector('#playBar .shape.active');
  return active && SHAPES[active.dataset.shape] ? active.dataset.shape : 'square';
}

function newRandomMaze(cols, rows) {
  enterPlay(Maze.generate(cols, rows, undefined, currentShape()), { kind: 'random' });
}

function currentDiff() {
  const active = document.querySelector('.diff.active');
  return active
    ? { cols: +active.dataset.cols, rows: +active.dataset.rows }
    : { cols: 12, rows: 12 };
}

function enterPlay(maze, opts) {
  play = {
    maze,
    kind: opts.kind,
    name: opts.name || null,
    path: [{ ...maze.start }],
    idx: new Map([[key(maze.start), 0]]),
    moves: 0,
    hints: 0,
    started: null,
    finishedAt: null,
    done: false,
    fx: 1,
    hint: null,
  };
  play.yuzu = (yuzuMode && (opts.kind === 'random' || opts.kind === 'shared'))
    ? setupYuzu(maze)
    : null;
  playerPx.snap = true;
  playBar.classList.toggle('testing', opts.kind === 'test');
  hideOverlay('winOverlay');
  updateHud();
}

const PRAISE = ['Capy-tastic!', 'Yuzu-riffic!', 'Squeak-cess!', 'Maze munched!', 'So chill. So solved.'];

function onWin() {
  play.done = true;
  play.finishedAt = performance.now();
  winSound();
  const title = play.yuzu
    ? `Perfect ${play.yuzu.target}! 🍊`
    : PRAISE[Math.floor(Math.random() * PRAISE.length)];
  const time = fmtTime(play.finishedAt - (play.started || play.finishedAt));
  let stats = `Solved in ${time} with ${play.moves} steps`;
  if (play.yuzu) stats += ` and exactly ${play.yuzu.target} yuzus`;
  if (play.hints > 0) stats += ` and ${play.hints} hint${play.hints === 1 ? '' : 's'}`;
  stats += '! Capy is soaking happily. ♨️';
  $('winTitle').textContent = title;
  $('winStats').textContent = stats;
  $('winNextBtn').textContent = play.kind === 'test' ? '🛠️ Back to Build' : '🔀 New Maze';
  const session = play;
  setTimeout(() => {
    if (play === session && play.done && mode === 'play') {
      showOverlay('winOverlay');
      startConfetti();
      $('winNextBtn').focus();
    }
  }, 550);
}

function useHint() {
  if (mode !== 'play' || !play || play.done) return;
  const head = play.path[play.path.length - 1];
  const path = play.maze.pathToGoal(head);
  if (!path || path.length < 2) return;
  play.hint = {
    cells: path.slice(1, 7),
    until: performance.now() + 2400,
  };
  play.hints++;
  squeak();
}

/* ---------------- keyboard (desktop convenience) ---------------- */

window.addEventListener('keydown', e => {
  if (mode !== 'play' || !play || play.done) return;
  if (document.querySelector('.overlay:not(.hidden)')) return;
  const map = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] };
  const d = map[e.key];
  if (!d) return;
  e.preventDefault();
  const head = play.path[play.path.length - 1];
  const next = { x: head.x + d[0], y: head.y + d[1] };
  if (!play.maze.inb(next.x, next.y)) return;
  playSample(next);
});

/* ---------------- build mode ---------------- */

function newBuild(cols, rows, shapeKey) {
  const shape = SHAPES[shapeKey] ? shapeKey
    : (build && SHAPES[build.shape] ? build.shape : 'square');
  build = {
    maze: Maze.shaped(cols, rows, SHAPES[shape]),
    shape,
    tool: (build && build.tool) || 'dig',
    dirty: false,
    solvable: false,
    undo: [],
  };
  updateSolvable();
  updateUndoBtn();
  syncSizeChips();
  syncShapeChips();
}

function snapshot() {
  build.undo.push({
    walls: new Uint8Array(build.maze.walls),
    start: { ...build.maze.start },
    goal: { ...build.maze.goal },
  });
  if (build.undo.length > 60) build.undo.shift();
  updateUndoBtn();
}

function undo() {
  const s = build.undo.pop();
  if (!s) return;
  build.maze.walls.set(s.walls);
  build.maze.start = s.start;
  build.maze.goal = s.goal;
  build.dirty = true;  // restored work is still work worth confirming before it's lost
  updateSolvable();
  updateUndoBtn();
}

function updateUndoBtn() {
  $('undoBtn').disabled = !build || build.undo.length === 0;
}

function updateSolvable(announce = false) {
  if (!build) return;
  const was = build.solvable;
  build.solvable = build.maze.isSolvable();
  const badge = $('solvableBadge');
  badge.textContent = build.solvable ? '⭐ Capy can reach the spring!' : '⛏️ Keep digging to the spring!';
  badge.className = 'badge ' + (build.solvable ? 'yes' : 'no');
  if (announce && !was && build.solvable) {
    squeak();
    toast('You did it — Capy can reach the spring! ⭐', 2200);
  }
}

let strokeChanged = false;
let placedThisStroke = false;
let lastDigSoundAt = 0;

function buildSample(cell, isDown) {
  if (!build) return;
  const m = build.maze;

  if (isDown) {
    snapshot();
    strokeChanged = false;
  }

  if (build.tool === 'capy') {
    if (m.active(cell.x, cell.y) && !same(cell, m.start) && !same(cell, m.goal)) {
      m.start = { ...cell };
      build.dirty = true;
      placedThisStroke = true;
      updateSolvable(true);
    }
    return;
  }
  if (build.tool === 'spring') {
    if (m.active(cell.x, cell.y) && !same(cell, m.goal) && !same(cell, m.start)) {
      m.goal = { ...cell };
      build.dirty = true;
      placedThisStroke = true;
      updateSolvable(true);
    }
    return;
  }

  // dig / wall: act on boundaries crossed while dragging
  if (dragLastCell === null) { dragLastCell = cell; return; }
  if (same(cell, dragLastCell)) return;

  let cur = dragLastCell;
  let guard = 0;
  while (!same(cur, cell) && guard++ < 120) {
    const dx = Math.sign(cell.x - cur.x);
    const dy = Math.sign(cell.y - cur.y);
    const next = (Math.abs(cell.x - cur.x) >= Math.abs(cell.y - cur.y))
      ? { x: cur.x + dx, y: cur.y }
      : { x: cur.x, y: cur.y + dy };
    const changed = build.tool === 'dig'
      ? build.maze.removeWallBetween(cur, next)
      : build.maze.addWallBetween(cur, next);
    if (changed) {
      build.dirty = true;
      strokeChanged = true;
      const now = performance.now();
      if (now - lastDigSoundAt > 70) {
        lastDigSoundAt = now;
        if (build.tool === 'dig') tone(420 + Math.random() * 160, 260, 0.06, 0, 'triangle', 0.05);
        else tone(210, 150, 0.07, 0, 'sine', 0.05);
      }
    }
    cur = next;
  }
  dragLastCell = cell;
  updateSolvable(true);
}


/* ---------------- storage & gallery ---------------- */

function loadSaved() {
  try {
    const raw = localStorage.getItem('capymaze.mazes');
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

function persistSaved(list) {
  try {
    localStorage.setItem('capymaze.mazes', JSON.stringify(list));
    return true;
  } catch (e) {
    toast('Could not save — storage is full 😢');
    return false;
  }
}

function renderGallery() {
  const list = loadSaved();
  const container = $('galleryList');
  container.innerHTML = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'galleryEmpty';
    empty.textContent = 'No mazes yet! Switch to Build mode, dig some tunnels, and save your first maze. 🐾';
    container.appendChild(empty);
    return;
  }
  for (const item of list) {
    let maze = null;
    try { maze = Maze.decode(item.data); } catch (e) { continue; }
    const row = document.createElement('div');
    row.className = 'galleryItem';

    const thumb = document.createElement('canvas');
    thumb.width = 168;
    thumb.height = 168;
    drawThumb(thumb, maze);
    row.appendChild(thumb);

    const info = document.createElement('div');
    info.className = 'galleryInfo';
    const name = document.createElement('div');
    name.className = 'gname';
    name.textContent = item.name;
    const meta = document.createElement('div');
    meta.className = 'gmeta';
    meta.textContent = `${maze.cols}×${maze.rows} · ${new Date(item.created).toLocaleDateString()}`;
    info.appendChild(name);
    info.appendChild(meta);
    row.appendChild(info);

    const btns = document.createElement('div');
    btns.className = 'galleryBtns';
    const mk = (label, cls, fn, aria) => {
      const b = document.createElement('button');
      b.className = 'chip ' + cls;
      b.textContent = label;
      if (aria) b.setAttribute('aria-label', aria);
      b.addEventListener('click', fn);
      btns.appendChild(b);
    };
    mk('▶️ Play', 'action', () => {
      hideOverlay('galleryOverlay');
      enterPlay(maze.clone(), { kind: 'saved', name: item.name });
      setMode('play');
    });
    mk('✏️ Edit', '', () => {
      hideOverlay('galleryOverlay');
      build = { maze: maze.clone(), shape: 'custom', tool: 'dig', dirty: false, solvable: false, undo: [] };
      setTool('dig');
      updateSolvable();
      updateUndoBtn();
      syncSizeChips();
      syncShapeChips();
      setMode('build');
      toast(`Editing “${item.name}” ✏️`);
    });
    mk('📤', '', () => shareMaze(maze, `“${item.name}”`), 'Share maze');
    mk('🗑️', '', () => {
      if (!confirm(`Delete “${item.name}”?`)) return;
      persistSaved(loadSaved().filter(x => x.id !== item.id));
      renderGallery();
    }, 'Delete maze');
    row.appendChild(btns);
    container.appendChild(row);
  }
}

function drawThumb(cv, m) {
  const c = cv.getContext('2d');
  const pad = 10;
  const cs = Math.min((cv.width - pad * 2) / m.cols, (cv.height - pad * 2) / m.rows);
  const ox = (cv.width - cs * m.cols) / 2;
  const oy = (cv.height - cs * m.rows) / 2;
  const shaped = m.mask.includes(0);
  if (shaped) {
    c.fillStyle = '#FFF8EA';
    c.fillRect(0, 0, cv.width, cv.height);
    c.fillStyle = C.ground;
    c.beginPath();
    for (let y = 0; y < m.rows; y++)
      for (let x = 0; x < m.cols; x++)
        if (m.mask[m.i(x, y)]) c.rect(ox + x * cs - 0.5, oy + y * cs - 0.5, cs + 1, cs + 1);
    c.fill();
  } else {
    c.fillStyle = C.ground;
    c.fillRect(0, 0, cv.width, cv.height);
  }
  c.strokeStyle = C.wall;
  c.lineWidth = Math.max(1.5, cs * 0.18);
  c.lineCap = 'round';
  c.beginPath();
  for (let y = 0; y < m.rows; y++) {
    for (let x = 0; x < m.cols; x++) {
      if (!m.mask[m.i(x, y)]) continue;
      const b = m.walls[m.i(x, y)];
      const px = ox + x * cs, py = oy + y * cs;
      if (b & 1) { c.moveTo(px, py); c.lineTo(px + cs, py); }
      if (b & 8) { c.moveTo(px, py); c.lineTo(px, py + cs); }
      if ((x === m.cols - 1 || !m.mask[m.i(x + 1, y)]) && (b & 2)) { c.moveTo(px + cs, py); c.lineTo(px + cs, py + cs); }
      if ((y === m.rows - 1 || !m.mask[m.i(x, y + 1)]) && (b & 4)) { c.moveTo(px, py + cs); c.lineTo(px + cs, py + cs); }
    }
  }
  c.stroke();
  c.fillStyle = C.orange;
  c.beginPath();
  c.arc(ox + (m.start.x + 0.5) * cs, oy + (m.start.y + 0.5) * cs, cs * 0.28, 0, TAU);
  c.fill();
  c.fillStyle = C.pool;
  c.beginPath();
  c.arc(ox + (m.goal.x + 0.5) * cs, oy + (m.goal.y + 0.5) * cs, cs * 0.28, 0, TAU);
  c.fill();
}

function saveCurrentBuild(name) {
  const list = loadSaved();
  list.unshift({
    id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    name,
    data: build.maze.encode(),
    created: Date.now(),
  });
  if (persistSaved(list)) {
    build.dirty = false;
    toast('Saved to My Mazes! 📚');
  }
}

/* ---------------- share ---------------- */

function mazeShareUrl(maze) {
  // untouched generated mazes travel as just their seed — a ~45-char link
  let tag;
  if (maze.gen) {
    tag = 'r=' + maze.gen.seed.toString(36) + '-' + maze.gen.cols + '-' + maze.gen.rows;
    if (maze.gen.shape && maze.gen.shape !== 'square') tag += '-' + maze.gen.shape;
  } else {
    tag = 'm=' + maze.encode();
  }
  return location.origin + location.pathname + '#' + tag;
}

async function shareMaze(maze, label) {
  if (!maze) return;
  const url = mazeShareUrl(maze);
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Capy Maze',
        text: `Can you get Capy to the hot spring? ${label} 🍊`,
        url,
      });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    toast('Link copied! 📋');
  } catch (e) {
    prompt('Copy this link:', url);
  }
}

function parseHashMaze() {
  const rm = location.hash.match(/#r=([0-9a-z]+)-(\d+)-(\d+)(?:-([a-z]+))?/);
  if (rm) {
    const c = +rm[2], r = +rm[3];
    const shapeKey = rm[4];
    if (c >= 2 && c <= 40 && r >= 2 && r <= 40 && (!shapeKey || SHAPES[shapeKey])) {
      try {
        const m = Maze.generate(c, r, parseInt(rm[1], 36) >>> 0, shapeKey);
        if (m.isSolvable()) return { present: true, maze: m };
      } catch (e) { /* fall through to broken-link handling */ }
    }
    return { present: true, maze: null };
  }
  const match = location.hash.match(/#m=([A-Za-z0-9_-]+)/);
  if (!match) return { present: false, maze: null };
  try {
    const m = Maze.decode(match[1]);
    if (!m.isSolvable()) throw new Error('unsolvable');
    return { present: true, maze: m };
  } catch (e) {
    return { present: true, maze: null };
  }
}

/* ---------------- overlays & toast ---------------- */

function showOverlay(id) { $(id).classList.remove('hidden'); }
function hideOverlay(id) { $(id).classList.add('hidden'); }

function toast(msg, ms = 2600) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

/* ---------------- confetti ---------------- */

const confettiCanvas = $('confettiCanvas');
const confettiCtx = confettiCanvas.getContext('2d');
let confettiParts = [];
let confettiRunning = false;

function startConfetti() {
  if (REDUCED) return;
  const dpr = window.devicePixelRatio || 1;
  const w = confettiCanvas.clientWidth || window.innerWidth;
  const h = confettiCanvas.clientHeight || window.innerHeight;
  confettiCanvas.width = w * dpr;
  confettiCanvas.height = h * dpr;
  confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const colors = ['#F59E2D', '#E5822B', '#7CB05B', '#F0937A', '#FFF3DC', '#7CC6DE'];
  confettiParts = [];
  for (let i = 0; i < 90; i++) {
    confettiParts.push({
      x: Math.random() * w,
      y: -20 - Math.random() * h * 0.4,
      vx: (Math.random() - 0.5) * 1.6,
      vy: 1.5 + Math.random() * 2.5,
      rot: Math.random() * TAU,
      vr: (Math.random() - 0.5) * 0.2,
      size: 5 + Math.random() * 7,
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: Math.random() < 0.4 ? 'circle' : (Math.random() < 0.5 ? 'leaf' : 'square'),
    });
  }
  if (!confettiRunning) {
    confettiRunning = true;
    requestAnimationFrame(confettiFrame);
  }
}

function confettiFrame() {
  const w = confettiCanvas.clientWidth || window.innerWidth;
  const h = confettiCanvas.clientHeight || window.innerHeight;
  confettiCtx.clearRect(0, 0, w, h);
  if ($('winOverlay').classList.contains('hidden')) {
    confettiRunning = false;
    confettiParts = [];
    return;
  }
  let alive = false;
  for (const p of confettiParts) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.03;
    p.rot += p.vr;
    if (p.y < h + 30) alive = true;
    confettiCtx.save();
    confettiCtx.translate(p.x, p.y);
    confettiCtx.rotate(p.rot);
    confettiCtx.fillStyle = p.color;
    if (p.shape === 'circle') {
      confettiCtx.beginPath();
      confettiCtx.arc(0, 0, p.size / 2, 0, TAU);
      confettiCtx.fill();
    } else if (p.shape === 'leaf') {
      confettiCtx.beginPath();
      confettiCtx.ellipse(0, 0, p.size * 0.7, p.size * 0.3, 0, 0, TAU);
      confettiCtx.fill();
    } else {
      confettiCtx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
    }
    confettiCtx.restore();
  }
  if (alive) {
    requestAnimationFrame(confettiFrame);
  } else {
    confettiRunning = false;
  }
}

/* ---------------- mode switching ---------------- */

function setMode(m) {
  mode = m;
  $('modePlay').classList.toggle('active', m === 'play');
  $('modeBuild').classList.toggle('active', m === 'build');
  $('modePlay').setAttribute('aria-selected', m === 'play');
  $('modeBuild').setAttribute('aria-selected', m === 'build');
  playBar.classList.toggle('hidden', m !== 'play');
  buildBar.classList.toggle('hidden', m !== 'build');
  if (m === 'build' && !build) newBuild(6, 6);
  if (m === 'play') playerPx.snap = true;
  if (!sessionHints[m]) {
    sessionHints[m] = true;
    toast(m === 'play'
      ? 'Drag Capy through the maze to the hot spring! ♨️'
      : 'Drag your finger to dig tunnels for Capy! ⛏️', 3400);
  }
}

function syncSizeChips() {
  document.querySelectorAll('.bsize').forEach(b => {
    b.classList.toggle('active',
      build && +b.dataset.cols === build.maze.cols && +b.dataset.rows === build.maze.rows);
  });
}

function syncShapeChips() {
  document.querySelectorAll('#buildBar .shape').forEach(b => {
    b.classList.toggle('active', !!build && b.dataset.shape === build.shape);
  });
}

/* ---------------- wire up UI ---------------- */

$('modePlay').addEventListener('click', () => {
  if (mode === 'play') return;
  if (!play || play.kind === 'test') {
    const d = currentDiff();
    newRandomMaze(d.cols, d.rows);
  }
  setMode('play');
});

$('modeBuild').addEventListener('click', () => {
  if (mode === 'build') return;
  setMode('build');
});

document.querySelectorAll('.diff').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    newRandomMaze(+btn.dataset.cols, +btn.dataset.rows);
  });
});

$('newMazeBtn').addEventListener('click', () => {
  const d = currentDiff();
  newRandomMaze(d.cols, d.rows);
});

$('hintBtn').addEventListener('click', useHint);

$('restartBtn').addEventListener('click', () => {
  if (mode !== 'play' || !play) return;
  enterPlay(play.maze, { kind: play.kind, name: play.name });
});

$('shareBtn').addEventListener('click', () => {
  if (play) shareMaze(play.maze, play.name ? `“${play.name}”` : 'This maze is tricky!');
});

$('backToBuildBtn').addEventListener('click', () => setMode('build'));

$('galleryBtnPlay').addEventListener('click', () => { renderGallery(); showOverlay('galleryOverlay'); });
$('galleryBtnBuild').addEventListener('click', () => { renderGallery(); showOverlay('galleryOverlay'); });

document.querySelectorAll('.closeBtn').forEach(b => {
  b.addEventListener('click', () => hideOverlay(b.dataset.close));
});

function setTool(tool) {
  if (build) build.tool = tool;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
}

document.querySelectorAll('.tool').forEach(btn => {
  btn.addEventListener('click', () => {
    setTool(btn.dataset.tool);
    const tips = {
      dig: 'Drag your finger to dig tunnels! ⛏️',
      wall: 'Drag over tunnels to fill them back in 🧱',
      capy: 'Tap where Capy should start 🐾',
      spring: 'Tap where the hot spring should go ♨️',
    };
    toast(tips[btn.dataset.tool], 2000);
  });
});

document.querySelectorAll('#playBar .shape').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#playBar .shape').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const d = currentDiff();
    newRandomMaze(d.cols, d.rows);
  });
});

document.querySelectorAll('#buildBar .shape').forEach(btn => {
  btn.addEventListener('click', () => {
    const shape = btn.dataset.shape;
    if (build && build.shape === shape) return;
    if (build && build.dirty && !confirm('Start a fresh maze? Your current digging will be lost.')) return;
    newBuild(build ? build.maze.cols : 10, build ? build.maze.rows : 10, shape);
    const names = { square: 'Square', heart: 'Heart', ring: 'Donut', diamond: 'Diamond', capy: 'Capybara' };
    toast(`${names[shape] || 'New'} maze! ${btn.textContent}`, 1600);
  });
});

document.querySelectorAll('.bsize').forEach(btn => {
  btn.addEventListener('click', () => {
    const cols = +btn.dataset.cols, rows = +btn.dataset.rows;
    if (build && build.maze.cols === cols && build.maze.rows === rows) return;
    if (build && build.dirty && !confirm('Start a fresh maze? Your current digging will be lost.')) return;
    newBuild(cols, rows);
    syncSizeChips();
  });
});

$('undoBtn').addEventListener('click', undo);

$('clearBtn').addEventListener('click', () => {
  if (!build) return;
  if (build.maze.walls.every(v => v === 15)) return;  // already blank
  if (build.dirty && !confirm('Clear the whole maze?')) return;
  snapshot();
  build.maze.walls.fill(15);
  build.dirty = true;
  updateSolvable();
});

$('testBtn').addEventListener('click', () => {
  if (!build) return;
  if (!build.solvable) {
    toast("Capy can't reach the spring yet! Keep digging 🐾");
    return;
  }
  enterPlay(build.maze.clone(), { kind: 'test' });
  setMode('play');
});

$('saveBtn').addEventListener('click', () => {
  if (!build) return;
  if (!build.solvable) {
    toast("Capy can't reach the spring yet! Keep digging 🐾");
    return;
  }
  $('saveName').value = '';
  $('saveName').placeholder = `Capy Maze #${loadSaved().length + 1}`;
  showOverlay('saveOverlay');
  // synchronous focus keeps the user-gesture chain so iPad raises the keyboard
  $('saveName').focus();
});

$('saveConfirmBtn').addEventListener('click', () => {
  const name = $('saveName').value.trim() || $('saveName').placeholder;
  hideOverlay('saveOverlay');
  saveCurrentBuild(name);
});

$('saveCancelBtn').addEventListener('click', () => hideOverlay('saveOverlay'));

$('saveName').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('saveConfirmBtn').click();
});

$('shareBtnBuild').addEventListener('click', () => {
  if (!build) return;
  if (!build.solvable) {
    toast("Capy can't reach the spring yet! Keep digging 🐾");
    return;
  }
  shareMaze(build.maze, 'I built this one myself!');
});

$('winAgainBtn').addEventListener('click', () => {
  hideOverlay('winOverlay');
  enterPlay(play.maze, { kind: play.kind, name: play.name });
});

$('winNextBtn').addEventListener('click', () => {
  hideOverlay('winOverlay');
  if (play.kind === 'test') {
    setMode('build');
  } else {
    const d = currentDiff();
    newRandomMaze(d.cols, d.rows);
  }
});

const yuzuModeBtn = $('yuzuModeBtn');
function syncYuzuBtn() {
  yuzuModeBtn.classList.toggle('active', yuzuMode);
  yuzuModeBtn.setAttribute('aria-pressed', String(yuzuMode));
}
yuzuModeBtn.addEventListener('click', () => {
  yuzuMode = !yuzuMode;
  lsSet('capymaze.yuzumode', yuzuMode ? '1' : '0');
  syncYuzuBtn();
  if (yuzuMode) {
    toast('Collect exactly the target number of yuzus, then hop in the spring! Gold ones are worth 5 🍊', 3800);
  }
  if (play && (play.kind === 'random' || play.kind === 'shared')) {
    enterPlay(play.maze, { kind: play.kind, name: play.name });
  }
});
syncYuzuBtn();

const soundBtn = $('soundBtn');
function syncSoundBtn() {
  soundBtn.textContent = muted ? '🔇' : '🔊';
  soundBtn.setAttribute('aria-pressed', String(!muted));
}
soundBtn.addEventListener('click', () => {
  muted = !muted;
  lsSet('capymaze.muted', muted ? '1' : '0');
  syncSoundBtn();
  if (!muted) squeak();
});
syncSoundBtn();

window.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.overlay:not(.hidden)');
  if (open) hideOverlay(open.id);
});

window.addEventListener('hashchange', () => {
  const shared = parseHashMaze();
  if (!shared.present) return;
  if (!shared.maze) { toast('That maze link looks broken 😢'); return; }
  enterPlay(shared.maze, { kind: 'shared' });
  setMode('play');
  toast('Someone sent you a maze! 💌');
});

/* ---------------- init ---------------- */

resizeCanvas();
const sharedAtLoad = parseHashMaze();
if (sharedAtLoad.maze) {
  enterPlay(sharedAtLoad.maze, { kind: 'shared' });
} else {
  newRandomMaze(12, 12);
}
setMode('play');
if (sharedAtLoad.maze) toast('Someone sent you a maze! 💌');
else if (sharedAtLoad.present) toast('That maze link looks broken 😢 Here’s a fresh one!');
requestAnimationFrame(frame);

/* ---------------- test hooks (harmless in production) ---------------- */

window.__capyTest = {
  Maze,
  SHAPES,
  get state() { return { mode, play, build, view }; },
  cellCenter,
  canvas,
  renderNow: () => render(performance.now()),
};
