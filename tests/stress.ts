// Stress test: import STEP files with per-robot tagging rules, then drive them, fight every
// built-in with the AI, and look for physics blow-ups. Rules live in a JSON file (see README):
//   npm run stress -- testfiles/robots.json [name filter]
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { BUILTINS } from '../src/builtin';
import { derive, TIMESTEP } from '../src/build';
import {
  buildDef, defaultElectrics, defaultRange, initParts, rot90, rotMul, type ImportPart, type ImportSettings, type RawPart, type Tag,
} from '../src/importer';
import { AI } from '../src/input';
import { loadBot, saveBot } from '../src/robotfile';
import { Sim, getMujoco, type Bot } from '../src/sim';
import type { RobotDef, Vec3, WeaponType } from '../src/types';

interface Rule {
  name: string;
  file: string;
  units?: number;                       // STL scale (default mm)
  rot?: [string, number][];             // 90 degree turns applied in order, e.g. [["z", 2]]
  weapon: WeaponType;
  weaponAxis?: 'auto' | 'x' | 'y' | 'z';
  reverse?: boolean;
  tags: [string, Tag][];                // [regex on part name, tag]; later rules win
  material?: [string, string][];        // [regex, material]
  fill?: [string, number][];            // [regex, fill 0..1]
  collide?: [string, boolean][];        // [regex, collide]
  pivot?: string;                       // regex: parts whose bbox centre is the arm pivot
  range?: [number, number];
  elec?: { volts?: number; weapon?: Record<string, number>; drive?: Record<string, number> };
  targetMass?: number;
  fightSeconds?: number;
}

const require = createRequire(import.meta.url);
const occt = await require(process.cwd() + '/node_modules/occt-import-js')();
const mj = await getMujoco();
const rules: Rule[] = JSON.parse(readFileSync(process.argv[2] ?? 'testfiles/robots.json', 'utf8'));
const only = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
const problems: string[] = [];
const flag = (who: string, msg: string) => { problems.push(`${who}: ${msg}`); console.log(`  !! ${msg}`); };

function readCad(path: string, units = 0.001): RawPart[] {
  if (path.endsWith('/')) return readdirSync(path).filter((f) => /\.stl$/i.test(f)).sort().flatMap((f) => readCad(path + f, units));
  const buf = readFileSync(path);
  if (/\.stl$/i.test(path)) {
    const pos = parseStl(buf, units);
    return [{ name: path.split('/').pop()!.replace(/\.stl$/i, ''), color: null, pos, idx: Uint32Array.from({ length: pos.length / 3 }, (_, i) => i) }];
  }
  const r = (/\.(iges|igs)$/i.test(path) ? occt.ReadIgesFile : occt.ReadStepFile)(buf,
    { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 });
  if (!r.success) throw new Error('OpenCascade could not read ' + path);
  return r.meshes.map((m: any) => ({ name: m.name ?? '', color: m.color ?? null, pos: Float32Array.from(m.attributes.position.array, (v: number) => v * 0.001), idx: new Uint32Array(m.index.array) }));
}

function parseStl(buf: Buffer, scale: number): Float32Array {
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 === buf.length) {
    const out = new Float32Array(n * 9);
    for (let i = 0; i < n; i++) for (let k = 0; k < 9; k++) out[i * 9 + k] = buf.readFloatLE(84 + i * 50 + 12 + k * 4) * scale;
    return out;
  }
  const v = [...buf.toString('utf8').matchAll(/vertex\s+(\S+)\s+(\S+)\s+(\S+)/g)].flatMap((m) => [+m[1], +m[2], +m[3]].map((x) => x * scale));
  return Float32Array.from(v);
}

function importRobot(R: Rule): { def: RobotDef; parts: ImportPart[] } {
  let t = performance.now();
  const raw = readCad(R.file, R.units);
  const parts = initParts(raw);
  for (const [re, tag] of R.tags) { const rx = new RegExp(re, 'i'); parts.forEach((p) => rx.test(p.name) && (p.tag = tag)); }
  for (const [re, m] of R.material ?? []) { const rx = new RegExp(re, 'i'); parts.forEach((p) => rx.test(p.name) && (p.material = m)); }
  for (const [re, c] of R.collide ?? []) { const rx = new RegExp(re, 'i'); parts.forEach((p) => rx.test(p.name) && (p.collide = c)); }
  for (const [re, f] of R.fill ?? []) { const rx = new RegExp(re, 'i'); parts.forEach((p) => rx.test(p.name) && (p.fill = f)); }
  let rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (const [ax, n] of R.rot ?? []) for (let i = 0; i < Math.abs(n); i++) rot = rotMul(rot90(ax as 'x', Math.sign(n)), rot);
  let pivot: Vec3 | null = null;
  if (R.pivot) {
    const rx = new RegExp(R.pivot, 'i'), sel = parts.filter((p) => rx.test(p.name));
    if (!sel.length) throw new Error(`pivot rule matched nothing: ${R.pivot}`);
    const lo = [0, 1, 2].map((k) => Math.min(...sel.map((p) => p.center[k] - p.size[k] / 2)));
    const hi = [0, 1, 2].map((k) => Math.max(...sel.map((p) => p.center[k] + p.size[k] / 2)));
    pivot = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec3;
  }
  const elec = defaultElectrics(R.weapon, R.targetMass ?? 13.6);
  if (R.elec?.volts) elec.volts = R.elec.volts;
  Object.assign(elec.weapon, R.elec?.weapon ?? {});
  Object.assign(elec.drive, R.elec?.drive ?? {});
  const S: ImportSettings = {
    name: R.name, rot, weaponType: R.weapon, weaponAxis: R.weaponAxis ?? 'auto', reverse: !!R.reverse, pivot,
    rangeDeg: R.range ?? defaultRange(R.weapon), elec, targetMass: R.targetMass ?? 13.6, ballast: true,
  };
  const res = buildDef(parts, S);
  console.log(`  ${raw.length} parts read+built in ${(performance.now() - t).toFixed(0)} ms; tags: ` +
    Object.entries(parts.reduce((m, p) => ((m[p.tag] = (m[p.tag] ?? 0) + 1), m), {} as Record<string, number>)).map(([k, v]) => `${k} ${v}`).join(', '));
  res.info.forEach((l) => console.log('    ' + l));
  res.warnings.forEach((l) => console.log('    WARN ' + l));
  t = performance.now();
  return { def: res.def, parts };
}

interface Watch { deepPair?: string; outAt?: string; maxV: number; maxW: number; minZ: number; maxZ: number; out: boolean; nan: boolean; deepest: number; maxCon: number }
const watch = (): Watch => ({ maxV: 0, maxW: 0, minZ: Infinity, maxZ: -Infinity, out: false, nan: false, deepest: 0, maxCon: 0 });

function observe(sim: Sim, w: Watch) {
  const d = sim.d;
  for (const b of sim.bots) {
    const v = b.rootV, qv = d.qvel;
    const lin = Math.hypot(qv[v], qv[v + 1], qv[v + 2]), ang = Math.hypot(qv[v + 3], qv[v + 4], qv[v + 5]);
    if (!isFinite(lin) || !isFinite(ang)) w.nan = true;
    w.maxV = Math.max(w.maxV, lin); w.maxW = Math.max(w.maxW, ang);
    const p = b.chassis * 3, z = d.xpos[p + 2];
    w.minZ = Math.min(w.minZ, z); w.maxZ = Math.max(w.maxZ, z);
    if (!w.out && (Math.abs(d.xpos[p]) > 3.7 || Math.abs(d.xpos[p + 1]) > 3.7)) { w.out = true; w.outAt = `(${[0, 1, 2].map((k) => d.xpos[p + k].toFixed(2)).join(', ')}) at t=${d.time.toFixed(2)} s`; }
  }
  w.maxCon = Math.max(w.maxCon, d.ncon);
  const con = d.contact;                 // embind handles: delete them or the WASM heap fills up
  for (let i = 0; i < d.ncon; i++) {
    const c = con.get(i);
    if (c.dist < w.deepest) { w.deepest = c.dist; w.deepPair = [c.geom1, c.geom2].map((g: number) => geomName(sim, g)).join(' / '); }
    c.delete?.();
  }
  con.delete?.();
}

function geomName(sim: Sim, g: number): string {
  const n = sim.mj.mj_id2name(sim.m, sim.mj.mjtObj.mjOBJ_GEOM.value, g);
  const part = n?.match(/^p(\d)_part(\d+)$/);
  if (part) return `p${part[1]}:"${sim.bots[+part[1] - 1].def.parts[+part[2]].name.slice(0, 40)}"`;
  if (n && n !== 'emsc') return n;           // the WASM binding returns "emsc" for unnamed geoms
  const b = sim.m.geom_bodyid[g];
  return (sim.mj.mj_id2name(sim.m, sim.mj.mjtObj.mjOBJ_BODY.value, b) ?? 'world') + '#' + g;
}

function check(who: string, w: Watch) {
  if (w.nan) flag(who, 'NaN in the simulation');
  if (w.maxV > 25) flag(who, `chassis reached ${w.maxV.toFixed(1)} m/s (launch / explosion?)`);
  if (w.maxW > 150) flag(who, `chassis spun at ${w.maxW.toFixed(0)} rad/s`);
  if (w.out) flag(who, 'left the arena ' + w.outAt);
  if (w.deepest < -0.02) flag(who, `contact penetration ${(-w.deepest * 1000).toFixed(0)} mm`);
}

function drive(def: RobotDef, who: string) {
  const sim = new Sim(mj, { p1: def, p2: null, dummy: true, timestep: TIMESTEP });
  const bot = sim.bots[0], w = watch();
  let maxFwd = 0, maxTip = 0, maxArm = -1e9, minArm = 1e9;
  const t0 = performance.now();
  const N = Math.round(6 / TIMESTEP);
  for (let i = 0; i < N; i += 50) {
    sim.step(50, (ctrl, qvel, xmat) => {
      const t = sim.d.time;
      const thr = t < 0.3 ? 0 : t < 2.3 ? 1 : t < 3.3 ? -1 : 0, steer = t > 3.3 && t < 4.5 ? 1 : 0;
      const wpn = bot.spinner ? (t > 0.3 ? 1 : 0) : (t % 1.5 < 0.75 ? 1 : -0.35);
      bot.setControls(ctrl, qvel, xmat, thr, steer, wpn);
    });
    observe(sim, w);
    maxFwd = Math.max(maxFwd, bot.forwardSpeed(sim.d.xmat, sim.d.qvel));
    maxTip = Math.max(maxTip, bot.tipSpeed(sim.d.qvel));
    const a = bot.armDeg(sim.d.qpos); maxArm = Math.max(maxArm, a); minArm = Math.min(minArm, a);
  }
  const ms = performance.now() - t0;
  const D = bot.D;
  console.log(`  drive: ${(6000 / ms * 100).toFixed(0)}% realtime, top ${maxFwd.toFixed(2)} m/s (no-load ${D.topSpeed.toFixed(1)}), ` +
    (bot.spinner ? `tip ${maxTip.toFixed(0)} m/s (no-load ${D.noLoadTip.toFixed(0)})` : `arm ${minArm.toFixed(0)}..${maxArm.toFixed(0)}°`) +
    `, upright ${bot.zz(sim.d.xmat).toFixed(2)}, max contacts ${w.maxCon}`);
  check(who + ' drive', w);
  if (maxFwd < 0.3 * D.topSpeed) flag(who, `only reached ${maxFwd.toFixed(2)} m/s of ${D.topSpeed.toFixed(1)} driving straight`);
  if (bot.spinner && maxTip < 0.3 * D.noLoadTip) flag(who, `weapon only reached ${maxTip.toFixed(0)} of ${D.noLoadTip.toFixed(0)} m/s in 6 s`);
  if (!bot.spinner && maxArm - minArm < 0.5 * ((def.weapon.rangeDeg![1] - def.weapon.rangeDeg![0]))) flag(who, `arm only moved ${(maxArm - minArm).toFixed(0)}°`);
  sim.dispose();
}

function upsideDown(def: RobotDef, who: string) {
  const sim = new Sim(mj, { p1: def, p2: null, dummy: false, timestep: TIMESTEP });
  const bot = sim.bots[0], q = sim.d.qpos, a = bot.rootQ;
  // roll 180 degrees about the robot's forward axis and lift so nothing starts in the floor
  const qw = q[a + 3], qz = q[a + 6];                 // heading-only quaternion (w, 0, 0, z)
  const r = [0, 0, 1, 0];                             // 180 deg about world Y (robot faces +Y at spawn)
  q[a + 3] = qw * r[0] - qz * r[3]; q[a + 4] = qw * r[1] + qz * r[2]; q[a + 5] = qw * r[2] - qz * r[1]; q[a + 6] = qw * r[3] + qz * r[0];
  q[a + 2] = 0.3;
  sim.forward();
  const w = watch();
  sim.step(Math.round(1 / TIMESTEP), (c, qv, xm) => bot.setControls(c, qv, xm, 0, 0, 0));
  const m = sim.d.xmat, mb = bot.chassis * 9, fwd = [m[mb + 1], m[mb + 4]];   // robot +Y in world after landing
  const zz0 = bot.zz(sim.d.xmat), p0 = [sim.d.xpos[bot.chassis * 3], sim.d.xpos[bot.chassis * 3 + 1]];
  let best = 0;
  for (let i = 0; i < 60; i++) {
    sim.step(Math.round(0.05 / TIMESTEP), (c, qv, xm) => bot.setControls(c, qv, xm, 1, 0, bot.spinner ? 0 : -0.35));
    observe(sim, w);
    best = Math.max(best, bot.forwardSpeed(sim.d.xmat, sim.d.qvel));      // rolled over: its front is still its front
  }
  const dx = sim.d.xpos[bot.chassis * 3] - p0[0], dy = sim.d.xpos[bot.chassis * 3 + 1] - p0[1];
  const along = dx * fwd[0] + dy * fwd[1], inv = bot.upsideDown(sim.d.xmat);
  console.log(`  dropped upside down: landed ${zz0 < -0.6 ? 'inverted' : zz0 > 0.6 ? 'upright (rolled back)' : 'on its side'}; ` +
    `full throttle: best ${best.toFixed(2)} m/s towards the driver's "forward", moved ${along.toFixed(2)} m along the landing heading, ends ${inv ? 'inverted' : 'upright'}`);
  // not invertible is a design choice (lifters, most wedges); only an upright robot that can't move is a problem
  if (best < 0.5 && zz0 > 0.6) flag(who, `can't drive after rolling back upright (best ${best.toFixed(2)} m/s)`);
  else if (best < 0.5 && zz0 < -0.6) console.log('  (not invertible: its wheels don\'t reach the floor upside down)');
  check(who + ' inverted', w);
  sim.dispose();
}

function fight(a: RobotDef, b: RobotDef, secs: number, who: string) {
  const sim = new Sim(mj, { p1: a, p2: b, dummy: false, timestep: TIMESTEP });
  const ais = [new AI(), new AI()], w = watch();
  const t0 = performance.now();
  const dt = 1 / 60, per = Math.round(dt / TIMESTEP);
  for (let f = 0; f < secs * 60; f++) {
    const d = sim.d, v = { qpos: d.qpos, qvel: d.qvel, xpos: d.xpos, xmat: d.xmat };
    const cmds = sim.bots.map((bot, i) => ais[i].controls(bot, sim.bots[1 - i], v, dt));
    sim.step(per, (ctrl, qvel, xmat) => sim.bots.forEach((bot, i) => bot.setControls(ctrl, qvel, xmat, cmds[i].thr, cmds[i].steer, cmds[i].weapon)));
    observe(sim, w);
  }
  const ms = performance.now() - t0;
  const ups = sim.bots.map((bt: Bot) => bt.zz(sim.d.xmat).toFixed(2)).join('/');
  console.log(`  vs ${b.name.padEnd(12)} ${(secs * 1000 / ms * 100).toFixed(0).padStart(4)}% rt, up ${ups}, max v ${w.maxV.toFixed(1)} m/s, ω ${w.maxW.toFixed(0)}, ` +
    `contacts ≤${w.maxCon}, deepest ${(-w.deepest * 1000).toFixed(1)} mm (${w.deepPair ?? '-'})`);
  check(`${who} vs ${b.name}`, w);
  if (secs * 1000 / ms < 1.2) flag(`${who} vs ${b.name}`, `only ${(secs * 1000 / ms * 100).toFixed(0)}% realtime headless (browser is ~2x slower)`);
  sim.dispose();
}

function restingContacts(def: RobotDef, who: string) {
  const sim = new Sim(mj, { p1: def, p2: null, dummy: false, timestep: TIMESTEP });
  const bot = sim.bots[0];
  sim.step(Math.round(1 / TIMESTEP), (c, qv, xm) => bot.setControls(c, qv, xm, 0, 0, 0));
  const con = sim.d.contact, seen = new Map<string, number>();
  for (let i = 0; i < sim.d.ncon; i++) {
    const c = con.get(i);
    const pair = [c.geom1, c.geom2].map((g: number) => geomName(sim, g)).join(' / ');
    seen.set(pair, Math.min(seen.get(pair) ?? 0, c.dist));
    c.delete?.();
  }
  con.delete?.();
  console.log(`  at rest touching: ${[...seen].map(([k, v]) => `${k} ${(v * 1000).toFixed(1)}mm`).join(', ')}`);
  const treads = [...seen].filter(([k]) => k.startsWith('floor') && k.includes('tread')).length;
  if (treads < 2) flag(who, `only ${treads} wheel(s) touch the floor at rest`);
  sim.dispose();
}

for (const R of rules) {
  if (only && !only.test(R.name)) continue;
  console.log(`\n=== ${R.name} (${R.file})`);
  try {
    const { def } = importRobot(R);
    const D = derive(def);
    if (D.mass > (R.targetMass ?? 13.6) + 0.01) flag(R.name, `mass ${D.mass.toFixed(2)} kg over the limit`);
    const back = await loadBot(await (await saveBot(def)).arrayBuffer());
    if (process.env.SAVE) (await import('node:fs')).writeFileSync(`${process.env.SAVE}/${R.name.replace(/\W+/g, '_')}.bot`, new Uint8Array(await (await saveBot(def)).arrayBuffer()));
    if (back.parts.length !== def.parts.length) flag(R.name, '.bot round trip lost parts');
    restingContacts(back, R.name);
    drive(back, R.name);
    upsideDown(back, R.name);
    for (const opp of [...BUILTINS, back]) fight(back, opp, R.fightSeconds ?? 15, R.name);
  } catch (e) {
    flag(R.name, `crashed: ${e instanceof Error ? e.stack : e}`);
  }
}
console.log(`\n${problems.length} problem(s)`);
problems.forEach((p) => console.log(' - ' + p));
