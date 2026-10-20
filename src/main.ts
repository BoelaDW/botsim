// App shell: tabs, match setup, the game loop and the HUD.
import { BUILTINS } from './builtin';
import { EXAMPLES } from './config';
import { busy, done, paint, readFile } from './busy';
import { fetchBot, Gallery } from './gallery';
import { setupTouch, touch } from './touch';
import { AI, clearPresses, feel, gamepads, Human, padEdge, resetFeel, saveFeel, takePress, type Driver } from './input';
import { ArenaView } from './render';
import { loadBot } from './robotfile';
import { getMujoco, Sim } from './sim';
import type { RobotDef } from './types';
import { esc } from './util';
import { Workshop } from './workshop';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = (s: string) => ($('status').textContent = s);

const robots: RobotDef[] = [...BUILTINS];
const builtIn = new Set<RobotDef>(BUILTINS);          // can't be removed (plus the mock-ups loaded at start)
// without WebGL (switched off, blocklisted driver, locked-down PC) there is no 3D: say so plainly and keep the
// rest (gallery, file handling) working instead of dying on a blank page
const hasWebGL = (() => { try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; } })();
const NO_GL = "This browser can't show 3D graphics right now (WebGL is switched off or not supported). " +
  'Try an up-to-date Chrome, Edge or Firefox, and make sure hardware acceleration is on in its settings.';
if (!hasWebGL) for (const id of ['arena', 'workshop']) {
  const m = document.createElement('div');
  m.className = 'no-gl panel';
  m.textContent = NO_GL;
  $(id).prepend(m);
}
const view: ArenaView = hasWebGL ? new ArenaView($<HTMLCanvasElement>('arena-canvas'))
  : ({ follow: 0, load() {}, clear() {}, resize() {}, draw() {} } as unknown as ArenaView);
let mj: Awaited<ReturnType<typeof getMujoco>> | null = null;
let sim: Sim | null = null;
let drivers: Driver[] = [];
let defs: RobotDef[] = [];
let paused = false;
let page: 'arena' | 'gallery' | 'workshop' = 'arena';

// ---------------------------------------------------------------- setup panel
function fillRobotLists(p1?: number, p2?: number) {
  const opts = robots.map((r, i) => `<option value="${i}">${esc(r.name)}${r.author && !builtIn.has(r) ? ' — ' + esc(r.author) : ''}</option>`).join('');
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
  if (!hasWebGL) { status(NO_GL); return; }
  if (!mj) { status('The physics engine is still loading: try again in a moment'); return; }
  if (starting) return;
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
  if (!r || builtIn.has(r)) { status(r ? `${r.name} is built in and can't be removed` : 'Pick a robot first'); return false; }
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
  const existing = robots.findIndex((r) => r.name === def.name && !builtIn.has(r));
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

const workshop: Workshop = !hasWebGL ? ({ active: false, resize() {}, loadFiles() { status(NO_GL); } } as unknown as Workshop) : new Workshop($('workshop'), (def) => {
  addRobot(def);
  setPage('arena');
  startMatch();
}, (name) => {
  const i = robots.findIndex((r) => r.name === name && !builtIn.has(r));
  if (i >= 0) removeRobot(i);
});

// ---------------------------------------------------------------- loop
const perf = { slow: 0, simT: 0, wallT: 0, steps: 0, stepMs: 0, frames: 0, fpsT: performance.now(), fps: 0, hudT: 0 };
let last = performance.now();

function globalKeys() {
  if (takePress('Escape')) showSetup($('setup').classList.contains('hidden'));
  if (!$('setup').classList.contains('hidden') && takePress('Enter')) { startMatch(); return; }
  const s = sim;
  if (!s || starting) return;
  // a reset rebuilds the match asynchronously (sim is null meanwhile): nothing else may run this frame
  if (takePress('KeyR')) { startMatch(); return; }
  if (takePress('KeyP')) paused = !paused;
  if (takePress('KeyC')) view.follow = (view.follow + 1) % (s.bots.length + 1);
  if (takePress('KeyF')) flip(0);
  if (takePress('KeyG')) flip(1);
  for (const [slot, pad] of gamepads().entries()) {
    if (padEdge(pad, 0)) { startMatch(); return; }                   // A
    if (padEdge(pad, 1)) flip(slot);                                 // B
    if (padEdge(pad, 3)) view.follow = (view.follow + 1) % (s.bots.length + 1);   // Y
    if (padEdge(pad, 8)) paused = !paused;                           // Back / Share
    if (padEdge(pad, 9)) showSetup($('setup').classList.contains('hidden'));   // Start / Options
  }
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
    return `<div class="bot"><h4><span class="p${i + 1}">P${i + 1}</span> ${esc(b.def.name)} <span class="hint">${esc(drivers[i].label)}</span></h4>
      <div class="row"><span>Speed</span><span>${b.forwardSpeed(d.xmat, d.qvel).toFixed(1)} m/s</span></div>${wpn}
      <div class="row"><span>Battery</span><span>${b.D.splitBattery ? `${b.vBus.toFixed(1)} V weapon · ${b.vDriveBus.toFixed(1)} V drive` : `${b.vBus.toFixed(1)} V`} · ${amps.toFixed(0)} A</span></div>
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

// a file dropped anywhere must never make the browser navigate away from the app (losing the Workshop setup)
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', async (e) => {
  e.preventDefault();
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.length || !$('busy')?.hidden) return;
  if (files.some((f) => /\.(step|stp|iges|igs|stl)$/i.test(f.name))) {
    if (page !== 'workshop') setPage('workshop');
    if (!(e.target as HTMLElement).closest?.('#ws-view')) workshop.loadFiles(files);   // the view handles its own drops
  } else if (files.some((f) => /\.bot$/i.test(f.name))) {
    setPage('arena');
    for (const f of files) {
      try { robots.push(await loadBot((await readFile(f, 'buffer', `Loading ${f.name}`)) as ArrayBuffer)); fillRobotLists(robots.length - 1); status(`Loaded ${f.name}`); }
      catch (err) { status(`${f.name}: ${err instanceof Error ? err.message : err}`); }
      finally { done(); }
    }
  } else status(`Can't use ${files[0].name}: drop STEP / STL files (Workshop) or .bot robots (Arena)`);
});

// driving feel sliders: live, so they can be adjusted mid-match from the menu
const feelInputs = [...document.querySelectorAll<HTMLInputElement>('#feel input[type=range]')];
const showFeel = () => {
  for (const el of feelInputs) el.value = String(Math.round(feel[+el.dataset.p! as 1 | 2][el.dataset.k as 'steer'] * 100));
  $('feel-values').textContent = ([1, 2] as const).map((p) => `P${p}: steering ${Math.round(feel[p].steer * 100)}%, expo ${Math.round(feel[p].steerExpo * 100)}%, throttle expo ${Math.round(feel[p].thrExpo * 100)}%`).join(' · ');
};
for (const el of feelInputs) el.addEventListener('input', () => { feel[+el.dataset.p! as 1 | 2][el.dataset.k as 'steer'] = +el.value / 100; saveFeel(); showFeel(); });
$('feel-reset').addEventListener('click', () => { resetFeel(1); resetFeel(2); saveFeel(); showFeel(); });
showFeel();

// ---------------------------------------------------------------- boot
fillRobotLists(0, 1);
requestAnimationFrame(frame);
// example robots made from CAD: they replace the code-built ones (kept only as an offline fallback)
const examples = Promise.all(EXAMPLES.map(async (f) => {
  try {
    const res = await fetch('builtin/' + f);
    if (!res.ok || res.headers.get('content-type')?.includes('text/html')) return null;
    return await loadBot(await res.arrayBuffer());
  } catch (e) { console.warn('example robot', f, e); return null; }
})).then((defs) => {
  const ok = defs.filter((d): d is RobotDef => !!d);
  if (!ok.length) return;
  const names = (i: number) => robots[i]?.name;
  const a = names(+$<HTMLSelectElement>('p1-robot').value), b = names(+$<HTMLSelectElement>('p2-robot').value);
  // CAD versions take over the code-built robots of the same name; the rest of those stay as fallbacks
  const keep = robots.filter((r) => !(builtIn.has(r) && ok.some((d) => d.name === r.name)));
  robots.splice(0, robots.length, ...ok, ...keep.filter((r) => !builtIn.has(r)), ...keep.filter((r) => builtIn.has(r)));
  ok.forEach((d) => builtIn.add(d));
  const at = (n: string | undefined, dflt: number) => { const i = robots.findIndex((r) => r.name === n); return i >= 0 ? i : dflt; };
  fillRobotLists(at(a, 0), $<HTMLSelectElement>('p2-robot').value === '-1' ? -1 : at(b, 1));
});

getMujoco().then(async (m) => {
  await examples;
  mj = m;
  status(hasWebGL ? 'Physics ready. Pick robots and press Start (or Enter).' : NO_GL);
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
