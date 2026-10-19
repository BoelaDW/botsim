// MuJoCo world + per-robot runtime (DC motor + ESC model ported from the desktop sim).
import loadMujoco from '@mujoco/mujoco';
import { derive, worldXml, type Derived, type Entry } from './build';
import type { RobotDef } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Mj = any;
let mjPromise: Promise<Mj> | null = null;
export const getMujoco = () => (mjPromise ??= loadMujoco());

const ke = (kv: number) => 60 / (2 * Math.PI * kv);     // V s/rad == N m/A

/** Brushless motor + ESC as a DC motor: throttle sets the applied voltage, the ESC limits current. */
export class Motor {
  k: number; current = 0;
  constructor(kv: number, public r: number, public iLimit: number) { this.k = ke(kv); }
  torque(throttle: number, omega: number, vBus: number): number {
    const v = Math.max(-1, Math.min(1, throttle)) * vBus;
    this.current = Math.max(-this.iLimit, Math.min(this.iLimit, (v - this.k * omega) / this.r));
    return this.k * this.current;
  }
}

export const ARM_HOLD = 1.0, ARM_RETURN = -0.35;    // weapon command for arms: button held / released

export class Bot {
  D: Derived;
  drive: Record<'l' | 'r', Motor>;
  weapon: Motor;
  rootQ: number; rootV: number; chassis: number; weaponBody: number;
  wQ: number; wV: number;
  drvV: Record<'l' | 'r', number> = { l: -1, r: -1 };
  act: Record<string, number> = {};
  bodyIds: Record<string, number> = {};
  vBus: number;
  cmd = { thr: 0, steer: 0, weapon: 0 };
  private inv = false;

  constructor(public mj: Mj, public m: Mj, public def: RobotDef, D: Derived, public prefix: string) {
    this.D = D;
    const E = def.elec;
    this.drive = { l: new Motor(E.drive.kv, E.drive.r, E.drive.iLimit), r: new Motor(E.drive.kv, E.drive.r, E.drive.iLimit) };
    this.weapon = new Motor(E.weapon.kv, E.weapon.r, E.weapon.iLimit);
    const id = (t: string, n: string) => mj.mj_name2id(m, mj.mjtObj[t].value, prefix + n);
    const root = id('mjOBJ_JOINT', 'root'), wj = id('mjOBJ_JOINT', 'weapon');
    this.rootQ = m.jnt_qposadr[root]; this.rootV = m.jnt_dofadr[root];
    this.wQ = m.jnt_qposadr[wj]; this.wV = m.jnt_dofadr[wj];
    for (const s of ['l', 'r'] as const) {
      const d = D.driven[s];
      if (d >= 0) { this.drvV[s] = m.jnt_dofadr[id('mjOBJ_JOINT', 'wheel' + d)]; this.act['drive_' + s] = id('mjOBJ_ACTUATOR', 'drive_' + s); }
    }
    this.act.weapon = id('mjOBJ_ACTUATOR', 'weapon');
    for (const b of D.bodies) this.bodyIds[b] = id('mjOBJ_BODY', b);
    this.chassis = this.bodyIds.chassis; this.weaponBody = this.bodyIds.weapon;
    this.vBus = D.vBatt;
  }

  get kind() { return this.def.weapon.type; }
  get spinner() { return this.kind === 'spinner' || this.kind === 'drum'; }

  // state (pass the per-frame typed-array views from Sim)
  zz(xmat: Float64Array) { return xmat[this.chassis * 9 + 8]; }
  upsideDown(xmat: Float64Array) {
    const z = this.zz(xmat);
    if (z < -0.6) this.inv = true; else if (z > 0.6) this.inv = false;
    return this.inv;
  }
  onSide(xmat: Float64Array) { return Math.abs(this.zz(xmat)) < 0.5; }
  forwardSpeed(xmat: Float64Array, qvel: Float64Array) {
    const b = this.chassis * 9, v = this.rootV;     // robot +Y in world = column 1 of xmat
    return xmat[b + 1] * qvel[v] + xmat[b + 4] * qvel[v + 1] + xmat[b + 7] * qvel[v + 2];
  }
  weaponOmega(qvel: Float64Array) { return qvel[this.wV]; }
  tipSpeed(qvel: Float64Array) { return Math.abs(qvel[this.wV]) * this.D.tipRadius; }
  energy(qvel: Float64Array) { return 0.5 * this.D.weaponJ * qvel[this.wV] ** 2; }
  armDeg(qpos: Float64Array) { return (qpos[this.wQ] * 180) / Math.PI; }

  /** throttle, steer in [-1, 1] (tank mix). weapon: spinner 0..1; arm -1..1 (+ = lift / swing). */
  setControls(ctrl: Float64Array, qvel: Float64Array, xmat: Float64Array, thr: number, steer: number, weapon: number) {
    this.cmd = { thr, steer, weapon };
    if (this.upsideDown(xmat)) thr = -thr;
    const E = this.def.elec, D = this.D;
    const cmds = { l: Math.max(-1, Math.min(1, thr + steer)), r: Math.max(-1, Math.min(1, thr - steer)) };
    let iTotal = 0;
    // wheel joints spin about +X: + joint speed rolls the robot backwards
    for (const s of ['l', 'r'] as const) {
      const w = D.driven[s];
      if (w < 0) continue;
      const om = -qvel[this.drvV[s]] * D.driveRatio[w];
      const t = this.drive[s].torque(cmds[s], om, this.vBus) * E.drive.motorsPerSide;
      ctrl[this.act['drive_' + s]] = -t;
      iTotal += Math.abs(this.drive[s].current) * E.drive.motorsPerSide;
    }
    const wv = qvel[this.wV];
    const tw = this.weapon.torque(weapon, wv * D.weaponRatio, this.vBus);
    const drag = this.spinner ? 2.5e-6 * wv * Math.abs(wv) : 0;
    ctrl[this.act.weapon] = tw - drag / D.weaponRatio;
    iTotal += Math.abs(this.weapon.current);
    this.vBus = D.vBatt - E.rBatt * iTotal;
  }

  /** Put the robot back on its wheels where it is (the desktop sim's "flip" key). */
  flip(qpos: Float64Array, qvel: Float64Array) {
    const q = this.rootQ, v = this.rootV;
    const w = qpos[q + 3], x = qpos[q + 4], y = qpos[q + 5], z = qpos[q + 6];
    const yaw = Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z));
    qpos[q + 2] = -this.D.minZ + 0.08;
    qpos[q + 3] = Math.cos(yaw / 2); qpos[q + 4] = 0; qpos[q + 5] = 0; qpos[q + 6] = Math.sin(yaw / 2);
    for (let k = 0; k < 6; k++) qvel[v + k] = 0;
  }
}

export interface Setup { p1: RobotDef; p2: RobotDef | null; dummy: boolean; timestep: number }

export class Sim {
  m: Mj; d: Mj; bots: Bot[] = [];
  compileMs = 0;
  constructor(public mj: Mj, setup: Setup) {
    const t0 = performance.now();
    const entries: Entry[] = [{ def: setup.p1, derived: derive(setup.p1), prefix: 'p1_', xy: [0, -1.5], heading: 90 }];
    if (setup.p2) entries.push({ def: setup.p2, derived: derive(setup.p2), prefix: 'p2_', xy: [0, 1.5], heading: -90 });
    const xml = worldXml(entries, setup.dummy && !setup.p2, setup.timestep);
    try {
      this.m = mj.MjModel.from_xml_string(xml);
    } catch (e) {
      console.error(xml);
      throw new Error('MuJoCo rejected the scene: ' + (e instanceof Error ? e.message : String(e)));
    }
    this.d = new mj.MjData(this.m);
    mj.mj_forward(this.m, this.d);
    this.bots = entries.map((e) => new Bot(mj, this.m, e.def, e.derived, e.prefix));
    this.compileMs = performance.now() - t0;
  }

  get time(): number { return this.d.time; }

  /** Advance n physics steps; control(views) is called before every step. */
  step(n: number, control: (ctrl: Float64Array, qvel: Float64Array, xmat: Float64Array) => void) {
    const { mj, m, d } = this;
    const ctrl = d.ctrl, qvel = d.qvel, xmat = d.xmat;
    for (let i = 0; i < n; i++) {
      control(ctrl, qvel, xmat);
      mj.mj_step(m, d);
    }
  }

  forward() { this.mj.mj_forward(this.m, this.d); }

  dispose() { this.d.delete(); this.m.delete(); }
}
