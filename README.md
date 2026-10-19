# BotSim — proof of concept

A combat robot simulator that runs in the browser: **MuJoCo** physics (the official WebAssembly build)
+ **Three.js** graphics + **OpenCascade** (WebAssembly) to read STEP files.

**Play it online: https://boeladw.github.io/botsim/** (no install; Chrome, Firefox or Edge on a PC).

Two pages:

- **Arena** — 1v1 featherweight fights, test drives, AI opponent, gamepads + keyboard.
- **Workshop** — load a STEP / IGES / STL, orient it, tag parts (chassis / weapon / wheel 1–6 / ignore),
  set materials, motors and battery, then test it in the arena or save a `.bot` file to share.

Built-in robots (boxes and cylinders, guessed specs): Wide vert (spinner), Drum, Lifter, Hammer.

## Run it

Needs [Node.js](https://nodejs.org) 20 or newer (any OS).

```sh
npm install
npm run dev          # opens on http://localhost:5173 (and prints a LAN address for other PCs)
```

`npm run build` makes a static site in `dist/` (pushes to `main` publish it to GitHub Pages automatically);
`npm run preview` serves it. It must be served over http(s): opening `index.html` from disk won't load the WebAssembly.

## Controls

| | Gamepad | P1 keys | P2 keys |
|---|---|---|---|
| Drive / steer | left stick ↕ / right stick ↔ | W S / A D | ↑ ↓ / ← → |
| Weapon | right trigger (throttle) | Space (toggle) | Enter |
| Half speed | LB | L-Shift | R-Shift |
| Self-right (cheat) | B | F | G |
| Reset / camera / pause / menu | A / Y / Back / Start | R / C / P / Esc | |

First pad = P1, second pad = P2. Browsers only report a pad after one of its buttons is pressed.

## Importing a robot (Workshop)

1. Export your assembly as **STEP** (FreeCAD: select the assembly → File → Export → STEP).
2. Drop it on the Workshop view. Turn it with the X/Y/Z buttons until the front faces the green **FRONT** arrow.
3. Tag parts: click them (shift-click to add), or use the name filter + **All**. Put each wheel's tyre, hub and pulley
   on the same Wheel tag. Weapon parts go on **Weapon**. Fasteners etc. can stay chassis (mass only).
4. Weapon: pick the type. Spinner/drum axes are auto-detected; for lifters and hammers select the hinge parts and press
   **Pivot = selection**. Use **reverse direction** if it spins/lifts the wrong way.
5. Motors & battery: cells / voltage, then for weapon and drive the kV, winding resistance, ESC current limit and the
   **reduction** (motor turns per output turn: `3`, `36/12`, `3:1`, or stages multiplied like `5.2*36/16`).
   The lines underneath show motor rpm → output rpm, and after **Check** the tip speed, energy and drive speed.
6. **Check** shows detected wheels (blue) and the weapon axis (yellow) on the model, plus mass and energy.
   **Test in arena** drops it straight into a match.

Mass = material density × CAD volume × fill %. For 3D-printed parts set a fill % (walls + infill), pick
**Custom density…** for other materials, or type a **weighed mass** (several selected parts share it by volume).
**Remove robot** clears the Workshop and drops that robot from the arena list; the arena's **Remove** buttons drop
loaded robots (built-ins stay). Anything not modelled (wires, electronics) can be filled up to the weight limit
as ballast at the chassis centre of mass. Only parts on the outside of the robot get collision shapes by default
(convex hull per part); toggle with Collide / No collide.

## Tests

```sh
npm test              # headless: every built-in robot drives / spins up / stays upright, plus a fight
npm run test:import -- testfiles/your_robot.step   # needs your own STEP; tag rules in tests/import_frog.ts
```

## Layout

| File | What |
|---|---|
| `src/types.ts` | the robot definition (`.bot` file) format |
| `src/build.ts` | robot definition → MuJoCo XML |
| `src/sim.ts` | MuJoCo world, DC motor + ESC model, per-robot state |
| `src/input.ts` | keyboard / gamepad drivers and the AI |
| `src/render.ts` | Three.js arena |
| `src/importer.ts` | CAD parts + tags → robot definition (wheel / weapon axis detection, mass) |
| `src/workshop.ts` | Workshop page |
| `src/massprops.ts` | mesh volume / inertia, convex hulls |
| `public/occt/step-worker.js` | reads STEP files in a background thread |

## License

MIT (see `LICENSE`). Uses MuJoCo (Apache-2.0), Three.js (MIT) and occt-import-js / OpenCascade (LGPL-2.1, loaded
unmodified as a separate file).
