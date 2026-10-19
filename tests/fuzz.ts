// Robustness: broken files, corrupted robots and silly Workshop settings must either be rejected with a
// readable error, or simulate without NaNs. Nothing may crash, hang or poison the physics.
import { gzipSync } from 'node:zlib';
import { BUILTINS } from '../src/builtin';
import { TIMESTEP } from '../src/build';
import { buildDef, defaultElectrics, initParts, type ImportSettings, type RawPart, type Tag } from '../src/importer';
import { loadBot, saveBot, validateDef } from '../src/robotfile';
import { getMujoco, Sim } from '../src/sim';
import type { RobotDef, WeaponType } from '../src/types';

const mj = await getMujoco();
let bad = 0, rejected = 0, ran = 0;
const fail = (what: string, msg: string) => { bad++; console.log(`FAIL ${what}: ${msg}`); };

/** Run a robot for a second against the dummy; returns a problem or null. */
function run(def: RobotDef, secs = 1): string | null {
  let sim: Sim;
  try { sim = new Sim(mj, { p1: def, p2: BUILTINS[1], dummy: false, timestep: TIMESTEP }); }
  catch (e) { return 'Sim build threw: ' + (e instanceof Error ? e.message : e); }
  try {
    const bot = sim.bots[0];
    for (let i = 0; i < secs / TIMESTEP; i += 100) {
      sim.step(100, (c, qv, xm) => { bot.setControls(c, qv, xm, 1, 0.3, 1); sim.bots[1].setControls(c, qv, xm, 1, 0, 1); });
      for (const x of sim.d.qpos) if (!Number.isFinite(x)) return `NaN at t=${sim.d.time.toFixed(3)}`;
      if (sim.d.qvel.some((x: number) => Math.abs(x) > 1e5)) return `velocity blow-up at t=${sim.d.time.toFixed(3)}`;
    }
    return null;
  } finally { sim.dispose(); }
}

async function expectRejectOrRun(what: string, make: () => RobotDef | Promise<RobotDef>) {
  let def: RobotDef;
  try { def = await make(); validateDef(def); }
  catch (e) {
    if (!(e instanceof Error) || /undefined|null|cannot read|is not a function/i.test(e.message)) fail(what, 'unhelpful error: ' + (e instanceof Error ? e.message : e));
    else { rejected++; console.log(`  rejected ${what}: ${e.message.slice(0, 110)}`); }
    return;
  }
  const p = run(def);
  if (p) fail(what, p); else { ran++; console.log(`  ran      ${what}`); }
}

// ------------------------------------------------------------ 1. broken files
console.log('== broken files');
const good = await (await saveBot(BUILTINS[0])).arrayBuffer();
const files: [string, ArrayBuffer][] = [
  ['empty file', new ArrayBuffer(0)],
  ['random bytes', Uint8Array.from({ length: 5000 }, () => (Math.random() * 256) | 0).buffer],
  ['truncated gzip', good.slice(0, good.byteLength / 2)],
  ['gzip of junk', gzipSync(Buffer.from('hello world')).buffer as ArrayBuffer],
  ['JSON array', new TextEncoder().encode('[1,2,3]').buffer],
  ['JSON null', new TextEncoder().encode('null').buffer],
  ['other app JSON', new TextEncoder().encode('{"format":"something"}').buffer],
  ['future version', new TextEncoder().encode('{"format":"botsim-robot","version":7}').buffer],
  ['v1 skeleton', new TextEncoder().encode('{"format":"botsim-robot","version":1}').buffer],
  ['STEP file', new TextEncoder().encode('ISO-10303-21;\nHEADER;').buffer],
];
// a format-2 file whose JSON header length points past the end
const lie = new Uint8Array(64); lie.set(new TextEncoder().encode('BOTSIM2\n')); new DataView(lie.buffer).setUint32(8, 1e6, true);
files.push(['header length lies', gzipSync(lie).buffer as ArrayBuffer]);
for (const [what, buf] of files) {
  try { await loadBot(buf); fail(what, 'was accepted'); }
  catch (e) {
    const m = e instanceof Error ? e.message : String(e);
    if (/undefined|null|cannot read/i.test(m)) fail(what, 'unhelpful error: ' + m); else { rejected++; console.log(`  rejected ${what}: ${m.slice(0, 90)}`); }
  }
}

// ------------------------------------------------------------ 2. corrupted robots
console.log('== corrupted robots');
const clone = (d: RobotDef): RobotDef => structuredClone(d);
type Mut = [string, (d: RobotDef) => void];
const muts: Mut[] = [
  ['NaN part mass', (d) => (d.parts[0].mass = NaN)],
  ['negative part mass', (d) => (d.parts[0].mass = -1)],
  ['zero total mass', (d) => d.parts.forEach((p) => (p.mass = 0))],
  ['every part massless but one gram', (d) => d.parts.forEach((p, i) => (p.mass = i ? 0 : 0.001))],
  ['huge mass', (d) => (d.parts[0].mass = 1e9)],
  ['no parts', (d) => (d.parts = [])],
  ['unknown body', (d) => (d.parts[0].body = 'wheel99')],
  ['no wheels at all', (d) => { d.parts = d.parts.filter((p) => !p.body.startsWith('wheel')); d.wheels = []; }],
  ['one wheel', (d) => { d.parts = d.parts.filter((p) => !p.body.startsWith('wheel') || p.body === 'wheel0'); d.wheels = d.wheels.slice(0, 1); }],
  ['wheels only on the left', (d) => d.wheels.forEach((w) => (w.center[0] = -Math.abs(w.center[0])))],
  ['zero wheel radius', (d) => (d.wheels[0].radius = 0)],
  ['NaN wheel axis', (d) => (d.wheels[0].axis = [NaN, 0, 0])],
  ['zero wheel axis', (d) => (d.wheels[0].axis = [0, 0, 0])],
  ['vertical wheel axis', (d) => (d.wheels[0].axis = [0, 0, 1])],
  ['no weapon parts', (d) => (d.parts = d.parts.filter((p) => p.body !== 'weapon'))],
  ['weapon type nonsense', (d) => ((d.weapon as { type: string }).type = 'laser')],
  ['weapon axis zero', (d) => (d.weapon.axis = [0, 0, 0])],
  ['weapon axis not unit', (d) => (d.weapon.axis = [0, 0, 7])],
  ['weapon pivot far away', (d) => (d.weapon.pivot = [3, 3, 3])],
  ['kv zero', (d) => (d.elec.weapon.kv = 0)],
  ['kv negative', (d) => (d.elec.drive.kv = -1000)],
  ['resistance zero', (d) => (d.elec.weapon.r = 0)],
  ['current limit zero', (d) => (d.elec.drive.iLimit = 0)],
  ['reduction zero', (d) => (d.elec.weapon.ratio = 0)],
  ['reduction NaN', (d) => (d.elec.drive.ratio = NaN)],
  ['tiny reduction (overspeed)', (d) => (d.elec.weapon.ratio = 0.05)],
  ['huge reduction', (d) => (d.elec.drive.ratio = 5000)],
  ['no tip speed nor ratio', (d) => { delete d.elec.weapon.tipSpeed; delete d.elec.weapon.ratio; }],
  ['zero volts', (d) => (d.elec.volts = 0)],
  ['100 cells', (d) => (d.elec.cells = 100)],
  ['motors per side 0', (d) => (d.elec.drive.motorsPerSide = 0)],
  ['tyre grip 0', (d) => (d.tyreMu = 0)],
  ['tyre grip 50', (d) => (d.tyreMu = 50)],
  ['name missing', (d) => ((d as { name?: string }).name = undefined)],
  ['script in name', (d) => (d.name = '<img src=x onerror=alert(1)>')],
  ['mesh index out of range', (d) => { d.parts[0] = { ...d.parts[0], prim: undefined, mesh: { pos: new Float32Array([0, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), idx: new Uint32Array([0, 1, 7]) } }; }],
  ['mesh with NaN vertex', (d) => { d.parts[0] = { ...d.parts[0], prim: undefined, mesh: { pos: new Float32Array([NaN, 0, 0, 0.1, 0, 0, 0, 0.1, 0]), idx: new Uint32Array([0, 1, 2]) } }; }],
  ['flat mesh (one triangle)', (d) => { d.parts[0] = { ...d.parts[0], collide: true, prim: undefined, mesh: { pos: new Float32Array([0, 0, 0.05, 0.1, 0, 0.05, 0, 0.1, 0.05]), idx: new Uint32Array([0, 1, 2]) } }; }],
  ['collinear mesh', (d) => { d.parts[0] = { ...d.parts[0], collide: true, prim: undefined, mesh: { pos: new Float32Array([0, 0, 0.05, 0.1, 0, 0.05, 0.2, 0, 0.05, 0.3, 0, 0.05]), idx: new Uint32Array([0, 1, 2, 1, 2, 3]) } }; }],
  ['empty mesh', (d) => { d.parts[0] = { ...d.parts[0], collide: true, prim: undefined, mesh: { pos: new Float32Array(0), idx: new Uint32Array(0) } }; }],
  ['part in metres-as-mm (2 km away)', (d) => { d.parts[0] = { ...d.parts[0], prim: { type: 'box', pos: [2000, 0, 0], size: [0.1, 0.1, 0.1] } }; }],
  ['arm range reversed', (d) => { d.weapon.type = 'lifter'; d.weapon.rangeDeg = [100, 0]; delete d.elec.weapon.ratio; d.elec.weapon.armDps = 200; }],
  ['arm range 720 degrees', (d) => { d.weapon.type = 'hammer'; d.weapon.rangeDeg = [-360, 360]; d.elec.weapon.armDps = 200; }],
  ['spinner that is an arm', (d) => { d.weapon.type = 'lifter'; d.weapon.rangeDeg = [0, 90]; d.elec.weapon.armDps = 300; }],
];
for (const base of BUILTINS) for (const [what, mut] of muts) await expectRejectOrRun(`${base.name}: ${what}`, () => { const d = clone(base); mut(d); return d; });

// ------------------------------------------------------------ 3. Workshop pipeline with silly input
console.log('== workshop pipeline');
function box(name: string, lo: number[], hi: number[]): RawPart {
  const v = [];
  for (const z of [lo[2], hi[2]]) for (const y of [lo[1], hi[1]]) for (const x of [lo[0], hi[0]]) v.push(x, y, z);
  const f = [0, 2, 1, 1, 2, 3, 4, 5, 6, 5, 7, 6, 0, 1, 4, 1, 5, 4, 2, 6, 3, 3, 6, 7, 0, 4, 2, 2, 4, 6, 1, 3, 5, 3, 7, 5];
  return { name, color: null, pos: Float32Array.from(v), idx: Uint32Array.from(f) };
}
function cyl(name: string, c: number[], r: number, w: number, n = 24): RawPart {
  const v: number[] = [], f: number[] = [];
  for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; for (const s of [-1, 1]) v.push(c[0] + (s * w) / 2, c[1] + r * Math.cos(a), c[2] + r * Math.sin(a)); }
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push(2 * i, 2 * j, 2 * i + 1, 2 * i + 1, 2 * j, 2 * j + 1); }
  v.push(c[0] - w / 2, c[1], c[2], c[0] + w / 2, c[1], c[2]);
  const L = 2 * n, R = 2 * n + 1;
  for (let i = 0; i < n; i++) { const j = (i + 1) % n; f.push(L, 2 * j, 2 * i, R, 2 * i + 1, 2 * j + 1); }
  return { name, color: null, pos: Float32Array.from(v), idx: Uint32Array.from(f) };
}
const robot = (): RawPart[] => [
  box('Base plate', [-0.15, -0.2, 0.01], [0.15, 0.2, 0.02]), box('Top plate', [-0.15, -0.2, 0.09], [0.15, 0.2, 0.1]),
  box('Rail L', [-0.16, -0.2, 0.01], [-0.15, 0.2, 0.1]), box('Rail R', [0.15, -0.2, 0.01], [0.16, 0.2, 0.1]),
  cyl('Wheel L', [-0.19, -0.1, 0.04], 0.04, 0.03), cyl('Wheel R', [0.19, -0.1, 0.04], 0.04, 0.03),
  box('Bar', [-0.2, 0.22, 0.05], [0.2, 0.26, 0.06]), cyl('Axle', [0, 0.24, 0.055], 0.01, 0.02),
];
const tags: [RegExp, Tag][] = [[/Wheel L/, 'wheel1'], [/Wheel R/, 'wheel2'], [/Bar|Axle/, 'weapon']];
const settings = (o: Partial<ImportSettings> = {}, type: WeaponType = 'spinner'): ImportSettings =>
  ({ name: 'Fuzz', rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], weaponType: type, weaponAxis: 'z', reverse: false, pivot: null,
    rangeDeg: [0, 100], elec: defaultElectrics(type), targetMass: 13.6, ballast: true, ...o });
const cases: [string, (parts: ReturnType<typeof initParts>) => ImportSettings][] = [
  ['normal', () => settings()],
  ['kv NaN (empty box)', () => { const s = settings(); s.elec.weapon.kv = NaN; return s; }],
  ['ratio 0', () => { const s = settings(); s.elec.drive.ratio = 0; return s; }],
  ['volts 0', () => { const s = settings(); s.elec.volts = 0; return s; }],
  ['motors per side NaN', () => { const s = settings(); s.elec.drive.motorsPerSide = NaN; return s; }],
  ['weight limit 0', () => settings({ targetMass: 0 })],
  ['weight limit NaN', () => settings({ targetMass: NaN })],
  ['arm range reversed', () => settings({ rangeDeg: [90, 10] }, 'lifter')],
  ['arm range NaN', () => settings({ rangeDeg: [NaN, 90] }, 'hammer')],
  ['pivot NaN', () => settings({ pivot: [NaN, 0, 0] }, 'lifter')],
  ['no tags at all', (p) => { p.forEach((x) => (x.tag = 'chassis')); return settings(); }],
  ['everything ignored', (p) => { p.forEach((x) => (x.tag = 'ignore')); return settings(); }],
  ['everything weapon', (p) => { p.forEach((x) => (x.tag = 'weapon')); return settings(); }],
  ['wheels tagged as one wheel', (p) => { p.forEach((x) => /Wheel/.test(x.name) && (x.tag = 'wheel1')); return settings(); }],
  ['weighed mass 0 on everything', (p) => { p.forEach((x) => (x.massKg = 0)); return settings(); }],
  ['fill 0', (p) => { p.forEach((x) => (x.fill = 0)); return settings(); }],
  ['upside down (X 180)', () => settings({ rot: [1, 0, 0, 0, -1, 0, 0, 0, -1] })],
  ['wrong units (x1000)', () => settings()],
  ['tiny units (/1000)', () => settings()],
];
for (const [what, mk] of cases) {
  let raw = robot();
  if (what.includes('x1000')) raw = raw.map((r) => ({ ...r, pos: r.pos.map((x) => x * 1000) }));
  if (what.includes('/1000')) raw = raw.map((r) => ({ ...r, pos: r.pos.map((x) => x / 1000) }));
  const parts = initParts(raw);
  for (const [rx, t] of tags) parts.forEach((p) => rx.test(p.name) && (p.tag = t));
  await expectRejectOrRun(`workshop: ${what}`, () => {
    const res = buildDef(parts, mk(parts));
    if (res.warnings.length) console.log(`           warnings: ${res.warnings.join(' | ').slice(0, 160)}`);
    return res.def;
  });
}

console.log(`\n${ran} ran, ${rejected} rejected, ${bad} failures`);
process.exit(bad ? 1 : 0);
