# Capy Maze 🍊

A capybara-themed maze game made for iPad (and any modern browser). Help Capy
waddle through the maze to the hot spring — then build your own mazes and share
them.

## Modes

- **🍊 Play** — generates a fresh maze (Easy 8×8 → Epic 22×22) in any shape:
  square, heart 🧡, donut 🍩, diamond 🔷, or capybara head 🦫. Drag Capy with
  your finger (or use arrow keys). Drag back along your trail to backtrack.
  💡 Hint flashes the next few steps of the shortest path, 🔁 Restart replays
  the same maze.
- **🍊 Yuzu Ten** (toggle in the Play bar) — first-grade math mode: yuzus
  (worth 1) and golden yuzus (worth 5) are scattered through the maze, and the
  spring only opens when Capy arrives with *exactly* the target count.
  Munched too many? Stand with Capy's little friend near the spring and Capy
  shares one at a time (never below the target), so every maze stays winnable
  — route planning becomes addition and subtraction within 20. Layouts derive
  from the maze seed, so a shared link gives both players identical yuzus for
  fair races.
- **🛠️ Build** — start from solid ground and **⛏️ Dig** tunnels by dragging.
  **🧱 Fill** fills passages back in, **🐾 Capy** and **♨️ Spring** move the
  start and goal. Pick a canvas shape — square, heart 🧡, donut 🍩, diamond 🔷,
  or capybara head 🦫 — at any size. A live badge shows whether the maze is
  solvable. **▶️ Test** playtests it, **💾 Save** stores it in My Mazes
  (localStorage), **📤 Share** encodes the whole maze (including its shape)
  into a link you can send.

## Running it

It's a fully static site — no build step, no dependencies.

```sh
cd maze
python3 -m http.server 4173
# open http://localhost:4173
```

Serve it over HTTP(S) rather than file:// so that Share links and clipboard
access work.

## Tech notes

- Plain HTML/CSS/JS, canvas-rendered, pointer events with `touch-action: none`
  and pixel-space swipe interpolation so fast finger drags never skip cells.
- Mazes are perfect mazes (iterative recursive backtracker); solvability is
  checked with BFS. Shared mazes are sanitized on decode (symmetric walls,
  solid border, clamped size).
- Share links are short: generated mazes encode as just their PRNG seed
  (`#r=seed-cols-rows`, ~45 chars total), and built mazes use a compact binary
  format (`#m=…`, 2 bits/cell + 1 mask bit/cell for shapes) so iMessage
  reliably linkifies them. Legacy JSON links still decode.
