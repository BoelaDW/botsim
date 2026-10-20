# BotSim — proof of concept

A combat robot simulator that runs in the browser: **MuJoCo** physics (the official WebAssembly build)
+ **Three.js** graphics + **OpenCascade** (WebAssembly) to read STEP files.

**Play it online: https://boeladw.github.io/botsim/** (no install; Chrome, Firefox or Edge on a PC).

Three pages:

- **Arena** — 1v1 featherweight fights, test drives, AI opponent, gamepads, keyboard or touch (phones / tablets).
  **Driving feel** in the menu: steering sensitivity and expo for each player.
- **Gallery** — robots other builders have shared: fight them, or copy a link that opens the arena with one loaded.
- **Workshop** — load a STEP / IGES / STL, orient it, tag parts (chassis / weapon / wheel 1–6 / ignore),
  set materials, motors and battery, then test it in the arena or save a `.bot` file to share.

Example robots (eleven): Wide vert, Drum, Lifter, Hammer, Shell Shock, Eggbeater, Six Pack, Sidewinder, Tilt,
Frog-ish Block (a blocky FROG V3) and Thorn (a front-axle drum). Each one is a **parametric FreeCAD model** in
`cad/examples/*.FCStd`: open it, change the values in its **Params** VarSet (wheel sizes, weapon size and height, body
size...), recompute, save, then run `npm run examples` to export STEP and rebuild the arena robots
(`FULL=1 npm run examples` also test-drives and fights them). Tags, materials and motors per robot are in
`cad/examples.json`. `cad/make_examples.py` regenerates the models from scratch (it won't overwrite your edits
without `FORCE=1`).

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
5. Motors & battery: cells / voltage (tick **separate drive battery** if the drive has its own pack), then for weapon and drive the kV, winding resistance, ESC current limit and the
   **reduction** (motor turns per output turn: `3`, `36/12`, `3:1`, or stages multiplied like `5.2*36/16`).
   The lines underneath show motor rpm → output rpm, and after **Check** the tip speed, energy and drive speed.
6. **Check** shows detected wheels (blue) and the weapon axis (yellow) on the model, plus mass and energy.
   **Test in arena** drops it straight into a match.

A file that arrives as one mesh (IGES, or a whole robot saved as one STL) is split into its separate solids
automatically; **Split** does the same for selected parts (a body holding both wheels, say).

On import, exact duplicate parts, reference shapes (keep-outs, ghosts, envelopes, ground slabs) and spare parts
lying well away from the robot are set to Ignore automatically (hover them in the list to see why; re-tag them if
that's wrong). **Check** warns about parts that reach below the wheels (the robot would sit on them), spinning
weapons that sweep into the floor, absurd sizes from wrong units, and overweight robots; sort the parts list by
"heaviest first" to find what to trim.

Mass = material density × CAD volume × fill %. For 3D-printed parts set a fill % (walls + infill), pick
**Custom density…** for other materials, or type a **weighed mass** (several selected parts share it by volume).
**Remove robot** clears the Workshop and drops that robot from the arena list; the arena's **Remove** buttons drop
loaded robots (built-ins stay). Anything not modelled (wires, electronics) can be filled up to the weight limit
as ballast at the chassis centre of mass. Only parts on the outside of the robot get collision shapes by default
(convex hull per part); toggle with Collide / No collide.

## Phones and tablets

The Arena works on phones: on-screen sticks appear on the first touch (left = drive, right = steer, or one stick in
the menu), plus WEAPON and FLIP buttons. Bluetooth gamepads work too. Play sideways; if the phone can't keep up,
pick the 0.5 ms physics step. The Workshop runs on a phone but is meant for a PC.

## Robot gallery

The gallery is the `.bot` files in [`public/robots/`](public/robots/). To add one, upload it there on GitHub
(**Add file → Upload files**); that opens a pull request, and the **Check gallery robots** workflow loads it, checks
the weight limit and runs it in the arena. Merge it and the site redeploys with the robot listed.
`npm run validate` runs the same check locally.

`.bot` files are gzipped with quantised meshes (0.01 mm), about 12× smaller than the first format, which still loads.

## Tests

```sh
npm test              # headless: every built-in robot drives / spins up / stays upright, plus a fight
npm run fuzz          # broken files, corrupted robots, silly Workshop settings: rejected cleanly or simulated without NaNs
npm run league        # every arena robot fights every other (AI vs AI), scored on damage / control / aggression
npm run torture       # physics extremes, every pairing at 0.5 / 0.1 ms steps, a 5-minute fight, 500 build/teardowns
npm run validate      # the gallery check (public/robots/*.bot, or files given as arguments)
npm run stress -- tests/synth.json        # import STEP robots by rules, drive them, fight every built-in, flag blow-ups
```

`stress` reads a JSON list of robots: file, weapon type, tag rules (regex on part names), pivot parts, motor
settings (see `tests/stress.ts`). The synthetic robots in `tests/synth.json` (shell spinner, eggbeater, 6WD flipper,
sideways hammer, cambered wheels, Y-up export, inch STLs, single-mesh STL) are made with FreeCAD:
`OUT=testfiles/synth freecad -c "exec(open('tests/cad/make_test_robots.py').read())" </dev/null`.
Keep rules for your own robots in `testfiles/` (not in git).

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
| `src/gallery.ts` | Gallery page and share links (`?bot=file.bot`) |
| `src/touch.ts` | on-screen touch controls |
| `src/robotfile.ts` | `.bot` file read / write |
| `scripts/robot-index.mjs` | builds the gallery list at build time |
| `src/massprops.ts` | mesh volume / inertia, convex hulls |
| `public/occt/step-worker.js` | reads STEP files in a background thread |

## License

MIT (see `LICENSE`). Uses MuJoCo (Apache-2.0), Three.js (MIT) and occt-import-js / OpenCascade (LGPL-2.1, loaded
unmodified as a separate file).
