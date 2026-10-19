// Headless check of the physics core: every built-in robot drives, spins up and stays sane.
import { BUILTINS } from '../src/builtin';
import { derive, TIMESTEP as TS0 } from '../src/build';
import { getMujoco, Sim } from '../src/sim';

const TIMESTEP = +(process.env.TS ?? TS0);   // TS=0.0005 npm test checks the faster step
const mj = await getMujoco();
for (const def of BUILTINS) {
  const D = derive(def);
  const sim = new Sim(mj, { p1: def, p2: null, dummy: false, timestep: TIMESTEP });
  const bot = sim.bots[0];
  const steps = Math.round(3 / TIMESTEP);
  const t0 = performance.now();
  let maxTip = 0, maxArm = -1e9;
  sim.step(steps, (ctrl, qvel, xmat) => {
    const t = sim.d.time;
    bot.setControls(ctrl, qvel, xmat, t > 0.5 ? 1 : 0, 0, bot.spinner ? 1 : (t > 1 ? 1 : -0.35));
    maxTip = Math.max(maxTip, bot.tipSpeed(qvel));
  });
  const ms = performance.now() - t0;
  const p = sim.d.xpos, b = bot.chassis * 3;
  maxArm = bot.armDeg(sim.d.qpos);
  console.log(`${def.name.padEnd(10)} mass ${D.mass.toFixed(2)} kg  tipR ${(D.tipRadius * 1000).toFixed(0)} mm  J ${D.weaponJ.toExponential(2)}  ` +
    `| 3 s sim in ${ms.toFixed(0)} ms (${((3000 / ms) * 100).toFixed(0)}% realtime, ${(steps / ms * 1000).toFixed(0)} steps/s)  ` +
    `y ${p[b + 1].toFixed(2)} z ${p[b + 2].toFixed(3)} up ${bot.zz(sim.d.xmat).toFixed(2)} speed ${bot.forwardSpeed(sim.d.xmat, sim.d.qvel).toFixed(2)} m/s ` +
    (bot.spinner ? `tip ${maxTip.toFixed(1)} m/s E ${(bot.energy(sim.d.qvel) / 1000).toFixed(2)} kJ` : `arm ${maxArm.toFixed(0)} deg`) + ` compile ${sim.compileMs.toFixed(0)} ms`);
  sim.dispose();
}
// a fight: two robots, both full ahead into each other
const sim = new Sim(mj, { p1: BUILTINS[0], p2: BUILTINS[1], dummy: false, timestep: TIMESTEP });
const t0 = performance.now();
sim.step(Math.round(4 / TIMESTEP), (ctrl, qvel, xmat) => {
  for (const b of sim.bots) b.setControls(ctrl, qvel, xmat, sim.d.time > 1.5 ? 1 : 0, 0, 1);
});
const ms = performance.now() - t0;
console.log(`fight vert vs drum: 4 s in ${ms.toFixed(0)} ms (${(4000 / ms * 100).toFixed(0)}% realtime), ncon ${sim.d.ncon}, ` +
  sim.bots.map((b) => `${b.def.name} up ${b.zz(sim.d.xmat).toFixed(2)}`).join(', '));
