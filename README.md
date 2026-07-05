# Capy Maze 🍊

A capybara-themed maze game made for iPad (and any modern browser). Help Capy
waddle through the maze to the hot spring — then build your own mazes and share
them.

## Modes

- **🍊 Play** — generates a fresh maze (Easy 8×8 → Epic 22×22). Drag Capy with
  your finger (or use arrow keys). Drag back along your trail to backtrack.
  💡 Hint flashes the next few steps of the shortest path.
- **🛠️ Build** — start from solid ground and **⛏️ Dig** tunnels by dragging.
  **🧱 Wall** fills passages back in, **🐾 Capy** and **♨️ Spring** move the
  start and goal. A live badge shows whether the maze is solvable. **▶️ Test**
  playtests it, **💾 Save** stores it in My Mazes (localStorage), **📤 Share**
  encodes the whole maze into a link you can send.

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
- Saved/shared mazes serialize to base64url JSON: wall bitmask + start/goal.
