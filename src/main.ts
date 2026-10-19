// App shell: tabs, match setup, the game loop and the HUD.
import { BUILTINS } from './builtin';
import { busy, done, paint, readFile } from './busy';
import { fetchBot, Gallery } from './gallery';
import { setupTouch, touch } from './touch';
import { AI, clearPresses, gamepads, Human, padEdge, takePress, type Driver } from './input';
import { ArenaView } from './render';
import { loadBot } from './robotfile';
import { getMujoco, Sim } from './sim';
import type { RobotDef } from './types';
import { Workshop } from './workshop';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => ($('status').textContent = s);

const robots: RobotDef[] = [...BUILTINS];
const view = new ArenaView($<HTMLCanvasElement>('arena-canvas'));
let mj: Awaited<ReturnType<typeof getMujoco>> | null = null;
let sim: Sim | null = null;
let drivers: Driver[] = [];
let defs: RobotDef[] = [];
let paused = false;
let page: 'arena' | 'gallery' | 'workshop' = 'arena';

// ---------------------------------------------------------------- setup panel
function fillRobotLists(p1?: number, p2?: number) {
  const opts = robots.map((r, i) => `<option value="${i}">${r.name}</option>`).join('');
  const a = $<HTMLSelectElement>('p1-robot'), b = $<HTMLSelectElement>('p2-robot');
  const keepA = p1 ?? +a.value, keepB = p2 ?? (b.value === '' ? 1 : +b.value);
  a.innerHTML = opts;
  b.innerHTML = '<option value="-1">None (test drive + dummy block)</option>' + opts;
  a.value = String(keepA || 0);
  b.value = String(isNaN(keepB) ? 1 : keepB);
}

function showSetup(show: boolean) {
  $('setup').classList.toggle('hidden', !show);
}

let starting = false;
async function startMatch() {
  if (!mj || starting) return;
  const i1 = +$<HTMLSelectElement>('p1-robot').value, i2 = +$<HTMLSelectElement>('p2-robot').value;
  const p2 = i2 >= 0 ? robots[i2] : null;
  const timestep = parseFloat($<HTMLSelectElement>('timestep').value);
  starting = true;
  try {
    sim?.dispose();
    sim = null;
    status('Building scene…');
    busy('Building the arena', undefined, 'collision shapes for ' + [robots[i1], p2].filter(Boolean).map((r) => r!.name).join(' and '));
    await paint();
    sim = new Sim(mj, { p1: robots[i1], p2, dummy: true, timestep });
  } catch (e) {
    status(String(e instanceof Error ? e.message : e));
    console.error(e);
    return;
  } finally {
    starting = false;
    done();
  }
  defs = p2 ? [robots[i1], p2] : [robots[i1]];
  const p2human = $<HTMLSelectElement>('p2-driver').value === 'human';
  drivers = [new Human(1, 0, true)];
  if (p2) drivers.push(p2human ? new Human(2, 1, true) : new AI());
  view.load(sim, defs);
  paused = false;
  showSetup(false);
  clearPresses();
  perf.simT = 0; perf.wallT = 0; perf.slow = 0;
  status(`${defs.map((d) => d.name).join(' vs ')} — scene built in ${sim.compileMs.toFixed(0)} ms`);
}

$('start').addEventListener('click', startMatch);
$<HTMLInputElement>('bot-file').addEventListener('change', async (e) => {
  const files = (e.target as HTMLInputElement).files;
  if (!files) return;
  for (const f of files) {
    try {
      const buf = (await readFile(f, 'buffer', `Loading ${f.name}`)) as ArrayBuffer;
      busy(`Unpacking ${f.name}`);
      await paint();
      robots.push(await loadBot(buf));
      fillRobotLists(robots.length - 1);
      status(`Loaded ${f.name}`);
    } catch (err) {
      status(`${f.name}: ${err instanceof Error ? err.message : err}`);
    } finally {
      done();
    }
  }
  (e.target as HTMLInputElement).value = '';
});

/** Drop a robot from the lists (built-ins stay). */
function removeRobot(i: number) {
  const r = robots[i];
  if (!r || BUILTINS.includes(r)) { status(r ? `${r.name} is built in and can't be removed` : 'Pick a robot first'); return false; }
  if (sim && defs.includes(r)) { sim.dispose(); sim = null; view.clear(); showSetup(true); }
  const a = +$<HTMLSelectElement>('p1-robot').value, b = +$<HTMLSelectElement>('p2-robot').value;
  robots.splice(i, 1);
  const fix = (k: number, dflt: number) => (k === i ? dflt : k > i ? k - 1 : k);
  fillRobotLists(fix(a, 0), b < 0 ? -1 : fix(b, 1));
  status(`Removed ${r.name}`);
  return true;
}
$('p1-remove').addEventListener('click', () => removeRobot(+$<HTMLSelectElement>('p1-robot').value));
$('p2-remove').addEventListener('click', () => removeRobot(+$<HTMLSelectElement>('p2-robot').value));

document.querySelectorAll<HTMLButtonElement>('.tab').forEach((t) => t.addEventListener('click', () => setPage(t.dataset.tab as typeof page)));
function setPage(p: typeof page) {
  page = p;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', (t as HTMLElement).dataset.tab === p));
  document.querySelectorAll('.page').forEach((s) => s.classList.toggle('active', s.id === p));
  workshop.active = p === 'workshop';
  if (p === 'gallery') gallery.open();
  clearPresses();
  if (p === 'workshop') workshop.resize(); else view.resize();
}

/** Add (or replace a same-named) robot and pick it for player 1. */
function addRobot(def: RobotDef): number {
  const existing = robots.findIndex((r) => r.name === def.name && !BUILTINS.includes(r));
  if (existing >= 0) robots[existing] = def; else robots.push(def);
  const i = existing >= 0 ? existing : robots.length - 1;
  fillRobotLists(i);
  return i;
}

const gallery = new Gallery($('gallery'), (def, fight) => {
  addRobot(def);
  status(`${def.name} added to the robot lists`);
  if (fight) { setPage('arena'); startMatch(); }
});

const workshop = new Workshop($('workshop'), (def) => {
  addRobot(def);
  setPage('arena');
  startMatch();
}, (name) => {
  const i = robots.findIndex((r) => r.name === name && !BUILTINS.includes(r));
  if (i >= 0) removeRobot(i);
});

// ---------------------------------------------------------------- loop
const perf = { slow: 0, simT: 0, wallT: 0, steps: 0, stepMs: 0, frames: 0, fpsT: performance.now(), fps: 0, hudT: 0 };
let last = performance.now();

function globalKeys() {
  if (takePress('Escape')) showSetup($('setup').classList.contains('hidden'));
  if (!$('setup').classList.contains('hidden') && takePress('Enter')) { startMatch(); return; }
  if (!sim) return;
  if (takePress('KeyR')) startMatch();
  if (takePress('KeyP')) paused = !paused;
  if (takePress('KeyC')) view.follow = (view.follow + 1) % (sim.bots.length + 1);
  if (takePress('KeyF')) flip(0);
  if (takePress('KeyG')) flip(1);
  gamepads().forEach((pad, slot) => {
    if (padEdge(pad, 0)) startMatch();                               // A
    if (padEdge(pad, 1)) flip(slot);                                 // B
    if (padEdge(pad, 3)) view.follow = (view.follow + 1) % (sim!.bots.length + 1);   // Y
    if (padEdge(pad, 8)) paused = !paused;                           // Back / Share
    if (padEdge(pad, 9)) showSetup($('setup').classList.contains('hidden'));   // Start / Options
  });
}

function flip(i: number) {
  if (!sim || !sim.bots[i]) return;
  sim.bots[i].flip(sim.d.qpos, sim.d.qvel);
  sim.forward();
}

function frame(now: number) {
  requestAnimationFrame(frame);
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  if (page !== 'arena') return;
  globalKeys();
  $('paused').hidden = !paused || !sim;
  if (sim && !paused) {
    const d = sim.d;
    const v = { qpos: d.qpos, qvel: d.qvel, xpos: d.xpos, xmat: d.xmat };
    const cmds = sim.bots.map((b, i) => drivers[i].controls(b, sim!.bots[1 - i] ?? null, v, dt));
    const ts = sim.m.opt.timestep;
    let want = Math.round(dt / ts);
    const t0 = performance.now();
    const t0sim = sim.time;
    // run the physics in chunks until caught up or out of frame budget (then the sim runs slow-mo)
    while (want > 0 && performance.now() - t0 < 30) {
      const n = Math.min(want, 100);
      sim.step(n, (ctrl, qvel, xmat) => {
        for (let i = 0; i < sim!.bots.length; i++) sim!.bots[i].setControls(ctrl, qvel, xmat, cmds[i].thr, cmds[i].steer, cmds[i].weapon);
      });
      want -= n;
      perf.steps += n;
    }
    perf.stepMs += performance.now() - t0;
    perf.simT += sim.time - t0sim;
    perf.wallT += dt;
  }
  view.draw(sim);
  perf.frames++;
  if (now - perf.fpsT > 500) {
    const span = (now - perf.fpsT) / 1000;
    perf.fps = perf.frames / span;
    const rt = perf.wallT > 0 ? (perf.simT / perf.wallT) * 100 : 0;
    $('perf').textContent = sim
      ? `${perf.fps.toFixed(0)} fps   sim speed ${rt.toFixed(0)}% of real time\n` +
        `physics ${(perf.stepMs / perf.frames).toFixed(1)} ms/frame, ${(perf.steps / span / 1000).toFixed(1)}k steps/s, ${sim.d.ncon} contacts`
      : `${perf.fps.toFixed(0)} fps`;
    if (sim && !paused) {
      perf.slow = rt < 80 ? perf.slow + 1 : 0;
      if (perf.slow === 6 && sim.m.opt.timestep < 0.0004)
        status(`This device runs the physics at ${rt.toFixed(0)}% speed: pick "Physics step 0.5 ms" in the menu for smoother play`);
    }
    perf.frames = 0; perf.steps = 0; perf.stepMs = 0; perf.fpsT = now; perf.simT = 0; perf.wallT = 0;
    hud();
    const pads = gamepads();
    $('pads').textContent = pads.length ? '' : 'No gamepad seen yet — press a button on your controller (keyboard works too)';
  }
}

function hud() {
  if (!sim) { $('hud').innerHTML = ''; return; }
  const d = sim.d;
  $('hud').innerHTML = sim.bots.map((b, i) => {
    const up = b.upsideDown(d.xmat), side = b.onSide(d.xmat);
    const wpn = b.spinner
      ? `<div class="row"><span>Weapon tip</span><span>${b.tipSpeed(d.qvel).toFixed(0)} m/s · ${(b.energy(d.qvel) / 1000).toFixed(2)} kJ</span></div>`
      : `<div class="row"><span>Arm</span><span>${b.armDeg(d.qpos).toFixed(0)}°</span></div>`;
    const amps = Math.abs(b.drive.l.current) + Math.abs(b.drive.r.current) + Math.abs(b.weapon.current);
    return `<div class="bot"><h4><span class="p${i + 1}">P${i + 1}</span> ${b.def.name} <span class="hint">${drivers[i].label}</span></h4>
      <div class="row"><span>Speed</span><span>${b.forwardSpeed(d.xmat, d.qvel).toFixed(1)} m/s</span></div>${wpn}
      <div class="row"><span>Battery</span><span>${b.vBus.toFixed(1)} V · ${amps.toFixed(0)} A</span></div>
      ${up ? '<div class="bad">UPSIDE DOWN (driving inverted)</div>' : side ? '<div class="bad">ON ITS SIDE</div>' : ''}</div>`;
  }).join('');
}

setupTouch($('arena'), {
  menu: () => showSetup($('setup').classList.contains('hidden')),
  reset: () => startMatch(),
  camera: () => { if (sim) view.follow = (view.follow + 1) % (sim.bots.length + 1); },
  flip: () => flip(0),
  pause: () => { paused = !paused; },
});
$<HTMLSelectElement>('touch-mode').addEventListener('change', (e) => { touch.oneStick = (e.target as HTMLSelectElement).value === 'one'; document.body.classList.toggle('one-stick', touch.oneStick); });

// ---------------------------------------------------------------- boot
fillRobotLists(0, 1);
requestAnimationFrame(frame);
getMujoco().then(async (m) => {
  mj = m;
  status('Physics ready. Pick robots and press Start (or Enter).');
  const linked = new URLSearchParams(location.search).get('bot');     // share links: ?bot=file.bot
  if (linked) {
    try {
      const def = await fetchBot(linked);
      addRobot(def);
      status(`${def.name} loaded from the gallery link. Pick an opponent and press Start.`);
    } catch (e) {
      status(`Gallery link: ${e instanceof Error ? e.message : e}`);
    }
  }
}).catch((e) => {
  status('Could not load MuJoCo WebAssembly: ' + e);
  console.error(e);
});
