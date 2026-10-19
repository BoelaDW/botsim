// Torture: physics extremes, long fights and many build/teardown cycles. Each case reports what
// happened; anything that blows up, leaks or hangs is a failure.
import { BUILTINS } from '../src/builtin';
import { derive, TIMESTEP } from '../src/build';
import { buildDef, defaultElectrics, initParts, type RawPart, type Tag } from '../src/importer';
import { AI } from '../src/input';
import { getMujoco, Sim } from '../src/sim';
import type { RobotDef } from '../src/types';

const mj = await getMujoco();
let failures = 0;
const fail = (what: string, msg: string) => { failures++; console.log(`FAIL ${what}: ${msg}`); };
const only = process.argv[2] ? new RegExp(process.argv[2], 'i') : null;
const clone = (d: RobotDef): RobotDef => structuredClone(d);

interface Res { maxV: number; maxW: number; nan: boolean; out: boolean; ms: number; ups: string }
function fight(a: RobotDef, b: RobotDef | null, secs: number, opts: { ai?: boolean; thr?: number; weapon?: number; ts?: number } = {}): Res {
  const ts = opts.ts ?? TIMESTEP;
  const sim = new Sim(mj, { p1: a, p2: b, dummy: !b, timestep: ts });
  const ais = sim.bots.map(() => new AI());
  const r: Res = { maxV: 0, maxW: 0, nan: false, out: false, ms: 0, ups: '' };
  const t0 = performance.now(), per = Math.round(1 / 60 / ts);
  for (let f = 0; f < secs * 60 && !r.nan; f++) {
    const d = sim.d, v = { qpos: d.qpos, qvel: d.qvel, xpos: d.xpos, xmat: d.xmat };
    const cmds = sim.bots.map((bot, i) => (opts.ai === false ? { thr: opts.thr ?? 1, steer: 0, weapon: opts.weapon ?? 1 } : ais[i].controls(bot, sim.bots[1 - i] ?? null, v, 1 / 60)));
    sim.step(per, (c, qv, xm) => sim.bots.forEach((bot, i) => bot.setControls(c, qv, xm, cmds[i].thr, cmds[i].steer, cmds[i].weapon)));
    for (const bot of sim.bots) {
      const q = d.qvel, o = bot.rootV, p = bot.chassis * 3;
      const lin = Math.hypot(q[o], q[o + 1], q[o + 2]), ang = Math.hypot(q[o + 3], q[o + 4], q[o + 5]);
      if (!Number.isFinite(lin + ang) || !Number.isFinite(d.xpos[p + 2])) r.nan = true;
      r.maxV = Math.max(r.maxV, lin); r.maxW = Math.max(r.maxW, ang);
      if (Math.abs(d.xpos[p]) > 3.8 || Math.abs(d.xpos[p + 1]) > 3.8 || d.xpos[p + 2] > 2.6 || d.xpos[p + 2] < -0.2) r.out = true;
    }
  }
  r.ms = performance.now() - t0;
  r.ups = sim.bots.map((b) => b.zz(sim.d.xmat).toFixed(2)).join('/');
  sim.dispose();
  return r;
}
const sane = (what: string, r: Res, vLim = 30) => {
  const s = `max v ${r.maxV.toFixed(1)} m/s, ω ${r.maxW.toFixed(0)} rad/s, up ${r.ups}, ${r.ms.toFixed(0)} ms`;
  if (r.nan) fail(what, 'NaN: ' + s);
  else if (r.out) fail(what, 'escaped the arena: ' + s);
  else if (r.maxV > vLim) fail(what, 'blew up: ' + s);
  else console.log(`  ok   ${what}: ${s}`);
};
async function test(name: string, fn: () => void | Promise<void>) {
  if (only && !only.test(name)) return;
  console.log('== ' + name);
  try { await fn(); } catch (e) { fail(name, 'threw: ' + (e instanceof Error ? e.message : e)); }
}

// ---- simple CAD-like parts for import cases
function box(name: string, lo: number[], hi: number[]): RawPart {
  const v = [];
  for (const z of [lo[2], hi[2]]) for (const y of [lo[1], hi[1]]) for (const x of [lo[0], hi[0]]) v.push(x, y, z);
  const f = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { name, color: null, pos: Float32Array.from(v), idx: Uint32Array.from(f) };
}
function cyl(name: string, c: number[], r: number, w: number, axis: 0 | 1 | 2 = 0, n = 24): RawPart {
  const v: number[] = [], f: number[] = [];
  const P = (a: number, h: number) => { const p = [0, 0, 0]; const u = (axis + 1) % 3, t = (axis + 2) % 3; p[axis] = c[axis] + h; p[u] = c[u] + r * Math.cos(a); p[t] = c[t] + r * Math.sin(a); return p; };
  for (let i = 0; i < n; i++) for (const s of [-1, 1]) v.push(...P((i / n) * 2 * Math.PI, (s * w) / 2));
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push(2 * i, 2 * j, 2 * i + 1, 2 * i + 1, 2 * j, 2 * j + 1); }
  const e0 = [...c], e1 = [...c]; e0[axis] -= w / 2; e1[axis] += w / 2; v.push(...e0, ...e1);
  const L = 2 * n, R = 2 * n + 1;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push(L, 2 * j, 2 * i, R, 2 * i + 1, 2 * j + 1); }
  return { name, color: null, pos: Float32Array.from(v), idx: Uint32Array.from(f) };
}
function build(raw: RawPart[], tags: [RegExp, Tag][], o: Partial<Parameters<typeof buildDef>[1]> = {}) {
  const parts = initParts(raw);
  for (const [rx, t] of tags) parts.forEach((p) => rx.test(p.name) && (p.tag = t));
  const type = o.weaponType ?? 'spinner';
  return buildDef(parts, { name: 'T', rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], weaponType: type, weaponAxis: 'auto', reverse: false, pivot: null,
    rangeDeg: [0, 100], elec: defaultElectrics(type), targetMass: 13.6, ballast: true, ...o });
}
const basic = (extra: RawPart[] = []) => [box('Base', [-0.15, -0.2, 0.01], [0.15, 0.2, 0.02]), box('Lid', [-0.15, -0.2, 0.09], [0.15, 0.2, 0.1]),
  box('Side L', [-0.16, -0.2, 0.01], [-0.15, 0.2, 0.1]), box('Side R', [0.15, -0.2, 0.01], [0.16, 0.2, 0.1]),
  cyl('Wheel L', [-0.19, -0.1, 0.04], 0.04, 0.03), cyl('Wheel R', [0.19, -0.1, 0.04], 0.04, 0.03), ...extra];
const wheelTags: [RegExp, Tag][] = [[/Wheel L/, 'wheel1'], [/Wheel R/, 'wheel2']];

// ------------------------------------------------------------------ physics extremes
await test('absurd weapon energy (FROG-like bar at 1000 m/s no-load)', () => {
  const elec = defaultElectrics('spinner'); elec.weapon.ratio = 0.3; elec.weapon.iLimit = 500;
  const res = build(basic([box('Bar', [-0.3, 0.22, 0.03], [0.3, 0.27, 0.05])]), [...wheelTags, [/Bar/, 'weapon']], { weaponAxis: 'z', elec });
  const d = res.def;
  console.log(`  no-load tip ${derive(d).noLoadTip.toFixed(0)} m/s, warnings: ${res.warnings.join(' | ')}`);
  sane('vs Wide vert', fight(d, BUILTINS[0], 20), 60);
  sane('vs itself', fight(d, d, 20), 60);
});
await test('unbalanced spinner (pivot 60 mm off the bar centre)', () => {
  const res = build(basic([box('Bar', [-0.3, 0.22, 0.03], [0.3, 0.27, 0.05])]), [...wheelTags, [/Bar/, 'weapon']], { weaponAxis: 'z', pivot: [0.06, 0.245, 0.04] });
  console.log(`  warnings: ${res.warnings.join(' | ') || '(none)'}`);
  if (!res.warnings.some((w) => /unbalanced/.test(w))) fail('unbalanced spinner', 'no balance warning');
  sane('spin up alone', fight(res.def, null, 10, { ai: false, thr: 0, weapon: 1 }), 30);
  sane('vs Drum', fight(res.def, BUILTINS[1], 15));
});
await test('arm whose CAD pose is outside its range', () => {
  for (const range of [[30, 100], [-100, -20], [200, 300]] as [number, number][]) {
    const d = clone(BUILTINS[2]); d.weapon.rangeDeg = range;
    sane(`lifter range ${range}`, fight(d, BUILTINS[0], 8));
  }
});
await test('huge robot (1.9 m long) vs huge robot: spawn overlap', () => {
  const raw = [box('Base', [-0.25, -0.9, 0.01], [0.25, 0.9, 0.02]), box('Lid', [-0.25, -0.9, 0.09], [0.25, 0.9, 0.1]),
    cyl('Wheel L', [-0.29, 0, 0.04], 0.04, 0.03), cyl('Wheel R', [0.29, 0, 0.04], 0.04, 0.03), box('Bar', [-0.5, 0.9, 0.03], [0.5, 0.96, 0.05])];
  const res = build(raw, [...wheelTags, [/Bar/, 'weapon']], { weaponAxis: 'z' });
  sane('long vs long', fight(res.def, res.def, 8));
});
await test('wheels whose axle runs front-to-back (model not rotated)', () => {
  const raw = [box('Base', [-0.2, -0.15, 0.01], [0.2, 0.15, 0.02]), box('Lid', [-0.2, -0.15, 0.09], [0.2, 0.15, 0.1]),
    cyl('Wheel L', [-0.1, -0.19, 0.04], 0.04, 0.03, 1), cyl('Wheel R', [-0.1, 0.19, 0.04], 0.04, 0.03, 1)];
  const res = build(raw, wheelTags);
  console.log(`  wheel axes ${res.def.wheels.map((w) => w.axis.map((x) => x.toFixed(2)).join(',')).join(' / ')}; warnings: ${res.warnings.join(' | ') || '(none)'}`);
  const four = build([...raw, cyl('Wheel L2', [0.1, -0.19, 0.04], 0.04, 0.03, 1), cyl('Wheel R2', [0.1, 0.19, 0.04], 0.04, 0.03, 1)], [...wheelTags, [/Wheel L2/, 'wheel3'], [/Wheel R2/, 'wheel4']]);
  console.log(`  4 wheels: ${four.warnings.join(' | ') || '(none)'}`);
  if (!four.warnings.some((w) => /round about/i.test(w))) fail('front-to-back wheels (4)', 'no warning that the wheels point the wrong way');
  if (!res.warnings.some((w) => /axle|axis|orient/i.test(w))) fail('front-to-back wheels', 'no warning that the wheels point the wrong way');
});
await test('everything collides (FROG-sized hull count)', () => {
  const extra: RawPart[] = [];
  for (let i = 0; i < 200; i++) extra.push(box('Bolt ' + i, [-0.14 + (i % 20) * 0.014, -0.19 + Math.floor(i / 20) * 0.038, 0.02], [-0.134 + (i % 20) * 0.014, -0.184 + Math.floor(i / 20) * 0.038, 0.03]));
  const parts = initParts(basic(extra));
  parts.forEach((p) => (p.collide = true));
  for (const [rx, t] of wheelTags) parts.forEach((p) => rx.test(p.name) && (p.tag = t));
  const res = buildDef(parts, { name: 'Bolty', rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], weaponType: 'spinner', weaponAxis: 'z', reverse: false, pivot: null, rangeDeg: [0, 100], elec: defaultElectrics('spinner'), targetMass: 13.6, ballast: true });
  console.log(`  warnings: ${res.warnings.join(' | ')}`);
  const r = fight(res.def, BUILTINS[0], 10);
  sane('206 hulls vs vert', r);
  if (r.ms > 10000 / 1.5) fail('206 hulls', `only ${(10000 / r.ms * 100).toFixed(0)}% realtime headless`);
});
await test('ballast to 100 kg (wrong weight class typed)', () => {
  const res = build(basic(), wheelTags, { targetMass: 100 });
  console.log(`  mass ${derive(res.def).mass.toFixed(1)} kg, warnings: ${res.warnings.join(' | ') || '(none)'}`);
  sane('100 kg brick vs vert', fight(res.def, BUILTINS[0], 8));
});
await test('full throttle into a wall for 30 s, weapons on', () => {
  for (const d of BUILTINS) sane(d.name, fight(d, d, 30, { ai: false, thr: 1, weapon: 1 }));
});

await test('every pairing at the 0.5 ms and 0.1 ms physics steps', () => {
  const shell = build([box('Plate', [-0.15, -0.15, 0.008], [0.15, 0.15, 0.014]), cyl('Wheel L', [-0.09, 0, 0.03], 0.03, 0.02), cyl('Wheel R', [0.09, 0, 0.03], 0.03, 0.02),
    ...[0, 1, 2, 3].map((k) => box('Shell ' + k, k < 2 ? [-0.21, k ? 0.195 : -0.21, 0.012] : [k === 3 ? 0.195 : -0.21, -0.21, 0.012], k < 2 ? [0.21, k ? 0.21 : -0.195, 0.072] : [k === 3 ? 0.21 : -0.195, 0.21, 0.072])),
    box('Skid', [-0.02, 0.12, 0.0005], [0.02, 0.14, 0.008])], [...wheelTags, [/Shell/, 'weapon']], { weaponAxis: 'z' }).def;
  shell.name = 'Box shell';
  for (const ts of [0.0005, 0.0001]) {
    for (const a of [...BUILTINS, shell]) for (const b of [...BUILTINS, shell]) if (a.name <= b.name)
      sane(`${ts * 1000} ms ${a.name} vs ${b.name}`, fight(a, b, ts === 0.0001 ? 4 : 12, { ts }));
  }
});

// ------------------------------------------------------------------ endurance
await test('5-minute AI fight (Wide vert vs Hammer)', () => sane('300 s', fight(BUILTINS[0], BUILTINS[3], 300)));
await test('500 build/teardown cycles (memory)', () => {
  const rss0 = process.memoryUsage().rss;
  for (let i = 0; i < 500; i++) { const s = new Sim(mj, { p1: BUILTINS[i % 4], p2: BUILTINS[(i + 1) % 4], dummy: false, timestep: TIMESTEP }); s.step(50, () => {}); s.dispose(); }
  const grew = (process.memoryUsage().rss - rss0) / 1e6;
  console.log(`  RSS grew ${grew.toFixed(0)} MB over 500 matches`);
  if (grew > 150) fail('build/teardown', `memory grew ${grew.toFixed(0)} MB`);
});

console.log(`\n${failures} failure(s)`);
process.exit(failures ? 1 : 0);
