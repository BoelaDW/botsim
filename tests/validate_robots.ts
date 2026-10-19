// Checks every gallery robot (public/robots/*.bot), or the files given as arguments:
// it loads, is within the weight limit, can drive, and survives a few seconds in the arena.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { derive, TIMESTEP } from '../src/build';
import { loadBot } from '../src/robotfile';
import { getMujoco, Sim } from '../src/sim';
import { FEATHERWEIGHT_KG } from '../src/types';

const dir = 'public/robots';
const files = process.argv.length > 2 ? process.argv.slice(2)
  : readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.bot')).map((f) => `${dir}/${f}`);
const mj = await getMujoco();
let failed = 0;

for (const path of files) {
  const problems: string[] = [];
  let line = path;
  try {
    const size = statSync(path).size;
    if (size > 15e6) problems.push(`file is ${(size / 1e6).toFixed(1)} MB (limit 15 MB): set fewer parts to collide or re-save with this version`);
    const buf = readFileSync(path);
    const def = await loadBot(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer);
    const D = derive(def);
    line = `${path}: "${def.name}"${def.author ? ' by ' + def.author : ''}, ${def.weapon.type}, ${D.mass.toFixed(2)} kg`;
    if (D.mass > FEATHERWEIGHT_KG + 0.005) problems.push(`overweight: ${D.mass.toFixed(2)} kg (limit ${FEATHERWEIGHT_KG} kg)`);
    if (D.driven.l < 0 || D.driven.r < 0) problems.push('needs driven wheels on both sides');
    const sim = new Sim(mj, { p1: def, p2: null, dummy: false, timestep: TIMESTEP });
    const bot = sim.bots[0];
    let bad = false;
    sim.step(Math.round(3 / TIMESTEP), (ctrl, qvel, xmat) => {
      const t = sim.d.time;
      bot.setControls(ctrl, qvel, xmat, t > 0.5 && t < 2 ? 1 : 0, 0, bot.spinner ? 1 : t > 1 ? 1 : -0.35);
      if (!isFinite(qvel[bot.rootV])) bad = true;
    });
    const z = sim.d.xpos[bot.chassis * 3 + 2];
    if (bad || !isFinite(z)) problems.push('the simulation blew up (NaN): check the wheel and weapon setup');
    else if (Math.abs(z) > 1) problems.push(`robot ended up at height ${z.toFixed(2)} m: it may be launching itself`);
    line += `, ${bot.spinner ? `tip ${bot.tipSpeed(sim.d.qvel).toFixed(0)} m/s after 3 s` : `arm ${bot.armDeg(sim.d.qpos).toFixed(0)}°`}`;
    sim.dispose();
  } catch (e) {
    problems.push(`could not load: ${e instanceof Error ? e.message : e}`);
  }
  console.log((problems.length ? 'FAIL ' : 'ok   ') + line);
  for (const p of problems) console.log('       - ' + p);
  if (problems.length) failed++;
}
console.log(`${files.length - failed}/${files.length} robots passed`);
process.exit(failed ? 1 : 0);
