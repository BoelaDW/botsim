// Headless check of the import pipeline on a real STEP export (testfiles/, not in git).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { buildDef, defaultElectrics, defaultRange, initParts, type RawPart, type Tag } from '../src/importer';
import { BUILTINS } from '../src/builtin';
import { TIMESTEP } from '../src/build';
import { getMujoco, Sim } from '../src/sim';
import { loadBot, saveBot } from '../src/robotfile';

const require = createRequire(import.meta.url);
const occt = await require(process.cwd() + '/node_modules/occt-import-js')();
let t = performance.now();
const r = occt.ReadStepFile(readFileSync(process.argv[2]), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 });
const raw: RawPart[] = r.meshes.map((m: any) => ({ name: m.name, color: m.color ?? null, pos: Float32Array.from(m.attributes.position.array, (v: number) => v * 0.001), idx: new Uint32Array(m.index.array) }));
console.log(`parsed ${raw.length} parts in ${(performance.now() - t).toFixed(0)} ms`);
t = performance.now();
const parts = initParts(raw);
const tag = (re: RegExp, tg: Tag) => parts.filter((p) => re.test(p.name)).forEach((p) => (p.tag = tg));
tag(/^(Spinner bar|Weapon shaft)/, 'weapon');
tag(/^Rear (tread|wheel hub).*\(right\)/, 'wheel1');
tag(/^Front (tread|wheel hub).*\(right\)/, 'wheel2');
tag(/^Rear (tread|wheel hub).*\(left\)/, 'wheel3');
tag(/^Front (tread|wheel hub).*\(left\)/, 'wheel4');
const elec = defaultElectrics('spinner');
elec.weapon = { kv: 1550, r: 0.009, iLimit: 135, rotorJ: 6e-5, tipSpeed: 156 };   // Rocket 4092, CAD gearing: 156 m/s no-load
const { def, warnings, info } = buildDef(parts, { name: 'FROG V3', rot: [1, 0, 0, 0, 1, 0, 0, 0, 1], weaponType: 'spinner', weaponAxis: 'auto', reverse: false, pivot: null, rangeDeg: defaultRange('spinner'), elec, targetMass: 13.6, ballast: true });
console.log(`initParts + buildDef ${(performance.now() - t).toFixed(0)} ms`);
info.forEach((l) => console.log('  ' + l));
warnings.forEach((l) => console.log('  WARN ' + l));

const mj = await getMujoco();
t = performance.now();
const sim = new Sim(mj, { p1: def, p2: BUILTINS[0], dummy: false, timestep: TIMESTEP });
console.log(`scene compile ${sim.compileMs.toFixed(0)} ms (ngeom ${sim.m.ngeom}, nmesh ${sim.m.nmesh})`);
const bot = sim.bots[0];
const t0 = performance.now();
let at90 = -1;
sim.step(Math.round(6 / TIMESTEP), (ctrl, qvel, xmat) => {
  bot.setControls(ctrl, qvel, xmat, sim.d.time > 5 ? 1 : 0, 0, 1);
  sim.bots[1].setControls(ctrl, qvel, xmat, 0, 0, 0);
  if (at90 < 0 && bot.tipSpeed(qvel) >= 90) at90 = sim.d.time;
});
const ms = performance.now() - t0;
const b = bot.chassis * 3;
console.log(`6 s in ${ms.toFixed(0)} ms (${(6000 / ms * 100).toFixed(0)}% realtime). 90 m/s tip at ${at90.toFixed(2)} s; at 6 s tip ${bot.tipSpeed(sim.d.qvel).toFixed(0)} m/s, ` +
  `${(bot.energy(sim.d.qvel) / 1000).toFixed(1)} kJ; up ${bot.zz(sim.d.xmat).toFixed(2)}, z ${sim.d.xpos[b + 2].toFixed(3)}, y ${sim.d.xpos[b + 1].toFixed(2)}, speed ${bot.forwardSpeed(sim.d.xmat, sim.d.qvel).toFixed(2)} m/s`);

// .bot round trip
const blob = await saveBot(def);
const buf = await blob.arrayBuffer();
if (process.argv[3]) (await import('node:fs')).writeFileSync(process.argv[3], new Uint8Array(buf));
const back = await loadBot(buf);
const maxErr = Math.max(...back.parts.map((p, i) => p.mesh ? p.mesh.pos.reduce((m, v, k) => Math.max(m, Math.abs(v - def.parts[i].mesh!.pos[k])), 0) : 0));
const same = back.parts.length === def.parts.length && back.parts.every((p, i) => (p.mesh?.pos.length ?? 0) === (def.parts[i].mesh?.pos.length ?? 0) &&
  (p.mesh?.idx.every((x, k) => x === def.parts[i].mesh!.idx[k]) ?? true) && p.mass === def.parts[i].mass);
console.log(`.bot file ${(buf.byteLength / 1e6).toFixed(2)} MB, round trip ${same && maxErr < 1e-5 ? 'OK' : 'MISMATCH'} (max vertex error ${(maxErr * 1e3).toFixed(4)} mm)`);
if (process.argv[4]) {   // an old-format file must still load
  const old = await loadBot((await import('node:fs')).readFileSync(process.argv[4]).buffer as ArrayBuffer);
  console.log(`old-format file: ${old.name}, ${old.parts.length} parts`);
}
