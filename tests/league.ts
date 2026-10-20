// League: every arena robot fights every other with the AI driving both, scored like a judge would.
//   damage     energy put into the opponent through the weapon (launch + spin + lift), in J
//   control    seconds the opponent spent flipped, on its side, or stuck
//   aggression seconds spent within 0.7 m of the opponent and closing / attacking
// A robot that is flipped and can't drive for 10 s loses by knockout.
//   npm run league [-- seconds [name filter]]
import { readFileSync } from 'node:fs';
import { BUILTINS } from '../src/builtin';
import { TIMESTEP } from '../src/build';
import { EXAMPLES } from '../src/config';
import { AI } from '../src/input';
import { loadBot } from '../src/robotfile';
import { getMujoco, Sim, type Bot } from '../src/sim';
import type { RobotDef } from '../src/types';

const mj = await getMujoco();
const SECS = +(process.argv[2] ?? 40);
const only = process.argv[3] ? new RegExp(process.argv[3], 'i') : null;
// the arena's examples (the code-built BUILTINS only if the CAD ones haven't been built)
const robots: RobotDef[] = [];
for (const f of EXAMPLES) { const b = readFileSync('public/builtin/' + f); robots.push(await loadBot(b.buffer.slice(b.byteOffset, b.byteOffset + b.length) as ArrayBuffer)); }
if (!robots.length) robots.push(...BUILTINS);

interface Side { damage: number; hits: number; control: number; aggression: number; ko: boolean; stuck: number; wobble: number; closing: number; closingN: number }
const side = (): Side => ({ damage: 0, hits: 0, control: 0, aggression: 0, ko: false, stuck: 0, wobble: 0, closing: 0, closingN: 0 });

function energy(sim: Sim, b: Bot): number {
  const q = sim.d.qvel, o = b.rootV, m = b.D.mass;
  return 0.5 * m * (q[o] ** 2 + q[o + 1] ** 2 + q[o + 2] ** 2) + 0.5 * m * 0.02 * (q[o + 3] ** 2 + q[o + 4] ** 2 + q[o + 5] ** 2) + m * 9.81 * sim.d.xpos[b.chassis * 3 + 2];
}

function match(A: RobotDef, B: RobotDef, swap: boolean): [Side, Side, string] {
  const sim = new Sim(mj, { p1: swap ? B : A, p2: swap ? A : B, dummy: false, timestep: TIMESTEP });
  const bots = swap ? [sim.bots[1], sim.bots[0]] : [sim.bots[0], sim.bots[1]];
  const ais = [new AI(), new AI()], S = [side(), side()];
  const weaponGeoms = bots.map((b) => new Set<number>());
  const bodyOf = bots.map((b) => new Set<number>(Object.values(b.bodyIds)));
  for (let g = 0; g < sim.m.ngeom; g++) bots.forEach((b, i) => sim.m.geom_bodyid[g] === b.weaponBody && weaponGeoms[i].add(g));
  const per = Math.round(1 / 60 / TIMESTEP), sub = 10;
  const flippedT = [0, 0], lastSteer = [0, 0];
  let result = 'points';
  const v = { qpos: sim.d.qpos, qvel: sim.d.qvel, xpos: sim.d.xpos, xmat: sim.d.xmat };
  for (let f = 0; f < SECS * 60; f++) {
    const cmds = bots.map((b, i) => ais[i].controls(b, bots[1 - i], v, 1 / 60));
    // weapon contacts are short: sample every 2 ms and credit opponent energy gained while touching my weapon
    for (let k = 0; k < per; k += sub) {
      const e0 = bots.map((b) => energy(sim, b));
      sim.step(sub, (c, qv, xm) => bots.forEach((b, i) => b.setControls(c, qv, xm, cmds[i].thr, cmds[i].steer, cmds[i].weapon)));
      const touch = [false, false], con = sim.d.contact;
      for (let n = 0; n < sim.d.ncon; n++) {
        const c = con.get(n), g1 = c.geom1, g2 = c.geom2; c.delete?.();
        for (const i of [0, 1]) {
          const opp = bodyOf[1 - i];
          if ((weaponGeoms[i].has(g1) && opp.has(sim.m.geom_bodyid[g2])) || (weaponGeoms[i].has(g2) && opp.has(sim.m.geom_bodyid[g1]))) touch[i] = true;
        }
      }
      con.delete?.();
      for (const i of [0, 1]) if (touch[i]) {
        const gain = energy(sim, bots[1 - i]) - e0[1 - i];
        if (gain > 0) { S[i].damage += gain; if (gain > 20) S[i].hits++; }
      }
    }
    // control, aggression, driving quality (once per frame)
    for (const i of [0, 1]) {
      const me = bots[i], op = bots[1 - i], x = sim.d.xpos;
      const dx = x[op.chassis * 3] - x[me.chassis * 3], dy = x[op.chassis * 3 + 1] - x[me.chassis * 3 + 1], dist = Math.hypot(dx, dy);
      const q = sim.d.qvel, o = me.rootV, vToward = (q[o] * dx + q[o + 1] * dy) / Math.max(dist, 1e-6);
      if (dist < 0.7 && (vToward > 0.1 || cmds[i].weapon > 0.5)) S[i].aggression += 1 / 60;
      if (dist > 0.9) { S[i].closing += vToward; S[i].closingN++; }
      const disabled = op.upsideDown(sim.d.xmat) || op.onSide(sim.d.xmat);
      if (disabled) S[i].control += 1 / 60;
      const speed = Math.hypot(q[op.rootV], q[op.rootV + 1]);
      if (Math.abs(cmds[1 - i].thr) > 0.5 && speed < 0.05) S[1 - i].stuck += 1 / 60;
      if (Math.sign(cmds[i].steer) !== Math.sign(lastSteer[i]) && Math.abs(cmds[i].steer - lastSteer[i]) > 0.3) S[i].wobble++;
      lastSteer[i] = cmds[i].steer;
      // knockout: flipped / on its side and not moving for 10 s
      flippedT[i] = (me.upsideDown(sim.d.xmat) && Math.hypot(q[o], q[o + 1]) < 0.2) || me.onSide(sim.d.xmat) ? flippedT[i] + 1 / 60 : 0;
      if (flippedT[i] > 10 && !S[i].ko) {
        S[i].ko = true; result = `KO ${me.def.name}`;
        if (process.env.DEBUG) console.log(`   KO at ${(f / 60).toFixed(1)} s: zz ${me.zz(sim.d.xmat).toFixed(2)} pos ${[0, 1, 2].map((k) => x[me.chassis * 3 + k].toFixed(2))} speed ${Math.hypot(q[o], q[o + 1]).toFixed(2)}`);
      }
    }
    if (S[0].ko || S[1].ko) break;
  }
  sim.dispose();
  return [S[0], S[1], result];
}

const pts = (s: Side, o: Side) => (s.ko ? 0 : o.ko ? 100 : 50 * (s.damage + 1) / (s.damage + o.damage + 2) + 30 * (s.control + 0.1) / (s.control + o.control + 0.2) + 20 * (s.aggression + 0.1) / (s.aggression + o.aggression + 0.2));
const table = new Map<string, { w: number; l: number; pts: number; dmg: number; hits: number; ctl: number; agg: number; stuck: number; wobble: number; close: number; n: number }>();
const row = (n: string) => table.get(n) ?? table.set(n, { w: 0, l: 0, pts: 0, dmg: 0, hits: 0, ctl: 0, agg: 0, stuck: 0, wobble: 0, close: 0, n: 0 }).get(n)!;
const t0 = performance.now();
for (let i = 0; i < robots.length; i++) for (let j = i + 1; j < robots.length; j++) {
  const A = robots[i], B = robots[j];
  if (only && !only.test(A.name) && !only.test(B.name)) continue;
  for (const swap of [false, true]) {
    const [a, b, res] = match(A, B, swap);
    const pa = pts(a, b), pb = pts(b, a);
    console.log(`${A.name.padEnd(12)} vs ${B.name.padEnd(12)} ${swap ? '(swapped)' : '         '} ${pa.toFixed(0).padStart(3)}-${pb.toFixed(0).padEnd(3)} ${res.padEnd(18)} ` +
      `dmg ${a.damage.toFixed(0)}/${b.damage.toFixed(0)} J  hits ${a.hits}/${b.hits}  ctl ${a.control.toFixed(1)}/${b.control.toFixed(1)} s  agg ${a.aggression.toFixed(1)}/${b.aggression.toFixed(1)} s`);
    for (const [name, s, o, p, q] of [[A.name, a, b, pa, pb], [B.name, b, a, pb, pa]] as const) {
      const r = row(name);
      r.pts += p; r.n++; if (p > q) r.w++; else r.l++;
      r.dmg += s.damage; r.hits += s.hits; r.ctl += s.control; r.agg += s.aggression; r.stuck += s.stuck; r.wobble += s.wobble / SECS; r.close += s.closingN ? s.closing / s.closingN : 0;
    }
  }
}
console.log(`\n${'robot'.padEnd(13)} W-L    avg pts  dmg J/match hits  control s  aggr s  stuck s  wobble/s  closing m/s   (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
for (const [n, r] of [...table].sort((a, b) => b[1].pts / b[1].n - a[1].pts / a[1].n))
  console.log(`${n.padEnd(13)} ${(r.w + '-' + r.l).padEnd(6)} ${(r.pts / r.n).toFixed(1).padStart(6)}  ${(r.dmg / r.n).toFixed(0).padStart(8)}  ${(r.hits / r.n).toFixed(1).padStart(5)}  ${(r.ctl / r.n).toFixed(1).padStart(8)}  ${(r.agg / r.n).toFixed(1).padStart(6)}  ${(r.stuck / r.n).toFixed(1).padStart(6)}  ${(r.wobble / r.n).toFixed(2).padStart(8)}  ${(r.close / r.n).toFixed(2).padStart(10)}`);
