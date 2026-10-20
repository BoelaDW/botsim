// Drivers: keyboard + gamepad humans, and the desktop sim's AI.
import { cross, dot, norm, partPoints, sub } from './build';
import { ARM_HOLD, ARM_RETURN, type Bot } from './sim';
import type { RobotDef, Vec3 } from './types';
import { setWeaponLit, touch } from './touch';

export interface Cmd { thr: number; steer: number; weapon: number }
export interface View { qpos: Float64Array; qvel: Float64Array; xpos: Float64Array; xmat: Float64Array }

const keys = new Set<string>();
const pressedOnce = new Set<string>();
if (typeof window !== 'undefined') {           // (headless tests import the AI without a DOM)
  addEventListener('keydown', (e) => {
    if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
    if (!keys.has(e.code)) pressedOnce.add(e.code);
    keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());
}

/** True once per key press (edge). */
export function takePress(code: string): boolean {
  const had = pressedOnce.has(code);
  pressedOnce.delete(code);
  return had;
}
export function clearPresses() { pressedOnce.clear(); }

/** Connected gamepads in slot order. Browsers only list a pad after one of its buttons is pressed. */
export function gamepads(): Gamepad[] {
  return (navigator.getGamepads?.() ?? []).filter((g): g is Gamepad => !!g && g.connected);
}

const padPrev = new Map<string, boolean>();
/** True on the frame a gamepad button goes down. */
export function padEdge(pad: Gamepad, button: number): boolean {
  const k = pad.index + ':' + button, down = !!pad.buttons[button]?.pressed;
  const was = padPrev.get(k) ?? false;
  padPrev.set(k, down);
  return down && !was;
}

const KEYSETS = {
  1: { fwd: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'], weapon: ['Space'], half: ['ShiftLeft'] },
  2: { fwd: ['ArrowUp'], back: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'], weapon: ['Enter', 'NumpadEnter'], half: ['ShiftRight'] },
};

/** How a human's sticks / keys map to the motors (Arena menu, remembered per browser). */
export interface Feel {
  steer: number;          // steering sensitivity: full stick = this much turn (0.2..1)
  steerExpo: number;      // 0 = linear, 1 = very soft around the centre
  thrExpo: number;
}
const FEEL_DEFAULT: Feel = { steer: 0.75, steerExpo: 0.3, thrExpo: 0 };
export const feel: Record<1 | 2, Feel> = { 1: { ...FEEL_DEFAULT }, 2: { ...FEEL_DEFAULT } };
try {
  const saved = JSON.parse(localStorage.getItem('botsim.feel') ?? 'null');
  for (const p of [1, 2] as const) if (saved?.[p]) Object.assign(feel[p], saved[p]);
} catch { /* no storage (or tests): defaults */ }
export function saveFeel() { try { localStorage.setItem('botsim.feel', JSON.stringify(feel)); } catch { /* ignore */ } }
export const resetFeel = (p: 1 | 2) => Object.assign(feel[p], FEEL_DEFAULT);
/** expo curve: small stick movements do less, full stick still does full */
const curve = (x: number, e: number) => (1 - e) * x + e * x * x * x;

export interface Driver { label: string; controls(bot: Bot, other: Bot | null, v: View, dt: number): Cmd }

export class Human implements Driver {
  label = 'keys';
  weaponOn = false;
  constructor(public player: 1 | 2, public padSlot: number, public useKeys = true) {}

  controls(bot: Bot): Cmd {
    const ks = KEYSETS[this.player];
    const k = (n: keyof typeof ks) => this.useKeys && ks[n].some((c) => keys.has(c));
    if (this.useKeys && ks.weapon.some((c) => takePress(c))) this.weaponOn = !this.weaponOn;
    let thr = +k('fwd') - +k('back');
    let steer = +k('right') - +k('left');
    let half = k('half');
    let held = k('weapon');
    if (this.player === 1 && touch.active) {          // on-screen sticks drive player 1
      if (touch.thr || touch.steer) { thr = touch.thr; steer = touch.steer; }
      for (; touch.weaponTaps > 0; touch.weaponTaps--) this.weaponOn = !this.weaponOn;
      held ||= touch.weaponHeld;
    }
    let analog: number | null = null;
    const pad = gamepads()[this.padSlot];
    this.label = this.player === 1 && touch.active ? 'touch' : this.useKeys ? 'keys' : 'waiting for pad';
    if (pad) {
      this.label = 'pad: ' + pad.id.slice(0, 28) + (pad.mapping === 'standard' ? '' : ' (non-standard mapping!)');
      const dz = (v: number) => (!Number.isFinite(v) || Math.abs(v) < 0.08 ? 0 : Math.max(-1, Math.min(1, v)));
      if (dz(pad.axes[1] ?? 0)) thr = -dz(pad.axes[1]);
      if (dz(pad.axes[2] ?? 0)) steer = dz(pad.axes[2]);
      const rt = pad.buttons[7]?.value ?? 0;      // right trigger
      if (rt > 0.03) analog = Math.min(1, rt);
      half ||= !!pad.buttons[4]?.pressed;         // left bumper
    }
    const f = feel[this.player];
    steer = curve(steer, f.steerExpo) * f.steer;
    thr = curve(thr, f.thrExpo);
    if (half) { thr *= 0.5; steer *= 0.5; }
    let weapon: number;
    if (this.player === 1) setWeaponLit(bot.spinner && this.weaponOn);
    if (bot.spinner) weapon = analog ?? (this.weaponOn ? 1 : 0);
    else weapon = held || (analog !== null && analog > 0.3) ? ARM_HOLD : ARM_RETURN;
    return { thr, steer, weapon };
  }
}

/** Where a robot's weapon does its work, in the robot frame (x right, y forward), from its own geometry. */
interface WeaponPlan {
  strike: [number, number];     // spinners: front of the weapon; lifters: the lip; hammers: where the head lands
  bearing: number;              // direction of the strike point, degrees (0 = straight ahead, + = right)
  standoff: number;             // distance from the robot's centre to the strike point
  halfWidth: number;            // how wide the hitting zone is
  lifts: boolean;               // lifter: get under and carry
}
const plans = new WeakMap<RobotDef, WeaponPlan>();

function rotateAbout(p: Vec3, piv: Vec3, axis: Vec3, deg: number): Vec3 {
  const a = norm(axis), t = (deg * Math.PI) / 180, c = Math.cos(t), s = Math.sin(t);
  const v = sub(p, piv), k = dot(a, v), x = cross(a, v);
  return [0, 1, 2].map((i) => piv[i] + v[i] * c + x[i] * s + a[i] * k * (1 - c)) as Vec3;
}

function weaponPlan(def: RobotDef): WeaponPlan {
  let plan = plans.get(def);
  if (plan) return plan;
  const W = def.weapon, pts = def.parts.filter((p) => p.body === 'weapon' && p.collide).flatMap(partPoints);
  const all = pts.length ? pts : def.parts.filter((p) => p.body === 'weapon').flatMap(partPoints);
  let strike: [number, number] = [0, 0.25], halfWidth = 0.12;
  if (all.length) {
    if (W.type === 'hammer') {
      // where the furthest point of the weapon ends up at the end of the swing
      const end = all.map((p) => rotateAbout(p, W.pivot, W.axis, W.rangeDeg![1]));
      const far = end.reduce((b, p) => (Math.hypot(p[0], p[1]) > Math.hypot(b[0], b[1]) ? p : b));
      strike = [far[0], far[1]];
      halfWidth = 0.1;
    } else {
      // the weapon's front edge (spinners sweep there; a lifter's lip is there at rest)
      let front = -Infinity, lo = Infinity, hi = -Infinity;
      for (const p of all) { front = Math.max(front, p[1]); lo = Math.min(lo, p[0]); hi = Math.max(hi, p[0]); }
      strike = [(lo + hi) / 2, front];
      halfWidth = Math.max(0.08, (hi - lo) / 2);
    }
  }
  const standoff = Math.hypot(strike[0], strike[1]);
  plan = { strike, bearing: (Math.atan2(strike[0], strike[1]) * 180) / Math.PI, standoff, halfWidth, lifts: W.type === 'lifter' };
  plans.set(def, plan);
  return plan;
}

const wrap = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

/** Drive to put the weapon's strike point on the opponent, use the weapon, recover when stuck or flipped. */
export class AI implements Driver {
  label = 'AI';
  t = 0;
  private stuckT = 0; private reverseUntil = -1; private turnDir = 1;
  private sideT = 0; private dropUntil = -1;
  private fireUntil = -1; private cooldownUntil = -1;
  private tipHist: [number, number][] = [];       // (time, tip speed) for spin-up plateau detection
  private lastTip = 0; private backOffUntil = -1;
  private invT = 0; private invStuckT = 0;

  controls(bot: Bot, other: Bot | null, v: View, dt: number): Cmd {
    this.t += dt;
    if (!other) return { thr: 0, steer: 0, weapon: 0 };
    const plan = weaponPlan(bot.def);
    const b = bot.chassis * 9, p = bot.chassis * 3, o = other.chassis * 3;
    const inverted = bot.upsideDown(v.xmat);
    // aim where the opponent will be shortly, not where it is
    const ov = other.rootV, lead = Math.min(0.2, Math.hypot(v.xpos[o] - v.xpos[p], v.xpos[o + 1] - v.xpos[p + 1]) / 8);
    const d = [v.xpos[o] + v.qvel[ov] * lead - v.xpos[p], v.xpos[o + 1] + v.qvel[ov + 1] * lead - v.xpos[p + 1], v.xpos[o + 2] - v.xpos[p + 2]];
    const rel = [0, 1, 2].map((c) => v.xmat[b + c] * d[0] + v.xmat[b + 3 + c] * d[1] + v.xmat[b + 6 + c] * d[2]);
    if (inverted) rel[0] = -rel[0];
    const ang = (Math.atan2(rel[0], rel[1]) * 180) / Math.PI;      // + = opponent to the right
    const dist = Math.hypot(rel[0], rel[1]);
    const yawRate = v.qvel[bot.rootV + 5] * (inverted ? -1 : 1);   // body frame, + = turning left
    const speed = bot.forwardSpeed(v.xmat, v.qvel);
    const oppR = Math.max(0.15, other.D.reach * 0.7);

    // ---- recovery: on its side / standing on end, or inverted with an arm to self-right
    this.sideT = bot.onSide(v.xmat) ? this.sideT + dt : 0;
    if (bot.spinner && this.sideT > 1.5) this.dropUntil = this.t + 2.5;   // gyro holds it on its side: spin down to fall
    if (this.t < this.dropUntil) return { thr: (this.t * 3) % 2 < 1 ? 1 : -1, steer: 0, weapon: 0 };
    if (this.sideT > 0.6) {   // rock it over: throttle back and forth, pulse the arm
      const ph = (this.t * 3) % 2 < 1;
      return { thr: ph ? 1 : -1, steer: ph ? 0.6 : -0.6, weapon: bot.spinner ? 0 : ph ? ARM_HOLD : ARM_RETURN };
    }
    // badly tilted (upside down or propped at an angle) for a while: recover
    const zz = bot.zz(v.xmat);
    this.invT = inverted || zz < 0.55 ? this.invT + dt : 0;
    if (!bot.spinner && this.invT > 0.3) {
      this.note = `RECOVER zz ${zz.toFixed(2)} t ${this.invT.toFixed(1)}`;
      // arm self-right: hold it out; if that doesn't do it, pulse while rocking
      if (this.invT < 1.5) return { thr: 0, steer: 0, weapon: ARM_HOLD };
      const ph = (this.t * 2.5) % 2 < 1;
      return { thr: ph ? 0.8 : -0.8, steer: ph ? 0.5 : -0.5, weapon: ph ? ARM_HOLD : ARM_RETURN };
    }
    this.invStuckT = inverted && Math.abs(speed) < 0.2 ? this.invStuckT + dt : 0;
    if (bot.spinner && inverted && this.invStuckT > 1.5) {
      // can't drive upside down: jolt the weapon (reaction torque) and rock
      const ph = (this.t * 2) % 2 < 1;
      return { thr: ph ? 1 : -1, steer: 0, weapon: ph ? 1 : -1 };
    }

    // ---- where to point: the strike bearing when close, straight at the opponent from far away (a spiral in)
    const reach = plan.standoff + oppR * 0.5;
    const blend = Math.min(1, Math.max(0, (reach * 2.2 - dist) / (reach * 1.2)));
    const want = plan.bearing * blend;
    const err = wrap(ang - want);
    // steer on the error we'll have 80 ms from now (a featherweight can tank-turn ~20 deg per AI frame)
    const lim = bot.kind === 'spinner' && Math.abs(bot.def.weapon.axis[2]) < 0.7 ? 0.5 : 1;   // vertical discs fight fast turns
    const errAhead = err + yawRate * (180 / Math.PI) * 0.08;
    let steer = Math.max(-lim, Math.min(lim, errAhead / 90));
    let thr = Math.abs(err) < 25 ? 1 : Math.abs(err) < 60 ? 0.55 : 0.2;
    let weapon: number;

    if (bot.spinner) {
      // drums and vertical discs upside down: reverse so the teeth still come up into the opponent
      weapon = inverted && Math.abs(bot.def.weapon.axis[2]) < 0.7 ? -1 : 1;
      // up to speed = near no-load, or no longer gaining (heavy weapons plateau below no-load)
      const tip = bot.tipSpeed(v.qvel);
      this.tipHist.push([this.t, tip]);
      while (this.tipHist.length && this.tipHist[0][0] < this.t - 0.6) this.tipHist.shift();
      const gaining = tip - this.tipHist[0][1] > 0.04 * Math.max(tip, 1);
      const ready = tip > 0.8 * bot.D.noLoadTip || (!gaining && tip > 0.35 * bot.D.noLoadTip) || this.t > 6;
      if (tip < this.lastTip * 0.8 && dist < reach + 0.3 && this.t > this.backOffUntil + 0.3) this.backOffUntil = this.t + 0.45;   // big hit: back off, re-spin
      this.lastTip = tip;
      if (this.t < this.backOffUntil) { thr = -1; steer *= 0.3; }
      else if (!ready && dist > reach + 0.8) thr = 0;            // face them and spin up; if they come anyway, fight
    } else {
      weapon = ARM_RETURN;
      // is the opponent in the zone the arm sweeps?
      const sx = rel[0] - plan.strike[0], sy = rel[1] - plan.strike[1];
      const inZone = plan.lifts
        ? rel[1] > 0 && rel[1] < plan.strike[1] + oppR * 0.8 && Math.abs(rel[0] - plan.strike[0]) < plan.halfWidth + oppR * 0.5
        : Math.hypot(sx, sy) < oppR * 0.6 + plan.halfWidth;
      this.zoneNote = `strike ${plan.strike.map((x) => x.toFixed(2))} rel ${rel[0].toFixed(2)},${rel[1].toFixed(2)} zone ${inZone ? 'IN' : 'out'} arm ${bot.armDeg(v.qpos).toFixed(0)}`;
      if (inZone && this.t > this.cooldownUntil && this.t > this.fireUntil) {
        this.fireUntil = this.t + (plan.lifts ? 0.9 : 0.35);
        this.cooldownUntil = this.fireUntil + (plan.lifts ? 0.3 : 0.6);
      }
      if (this.t < this.fireUntil) {
        weapon = ARM_HOLD;
        if (plan.lifts) { thr = 1; steer *= 0.3; }                // carry them
        const pitch = v.xmat[b + 7];                              // robot's forward axis, vertical part
        if (plan.lifts && pitch > 0.45) { this.fireUntil = this.t; weapon = ARM_RETURN; }   // tipping onto our tail: drop it
      } else if (!plan.lifts) {
        // hammers: arrive at the head's reach and stop there instead of ramming past it
        const gap = Math.hypot(rel[0], rel[1]) - (plan.standoff - oppR * 0.3);
        if (gap < 0.6) thr = Math.max(-0.8, Math.min(thr, gap * 2.5));
      }
    }

    // ---- unstick (but a pushing match against the opponent is not "stuck")
    const touching = dist < reach + 0.1;
    if (thr > 0.5 && Math.abs(speed) < 0.15 && !touching) this.stuckT += dt; else this.stuckT = 0;
    if (this.stuckT > 0.8) { this.reverseUntil = this.t + 0.6; this.stuckT = 0; this.turnDir = -this.turnDir; }
    if (this.t < this.reverseUntil) { thr = -0.9; steer = 0.6 * this.turnDir; }
    if (touching && thr > 0.5 && Math.abs(speed) < 0.1) steer += Math.sin(this.t * 6) * 0.3;   // wiggle in a shoving match
    this.note = `zz ${bot.zz(v.xmat).toFixed(2)} ang ${ang.toFixed(0)} want ${want.toFixed(0)} dist ${dist.toFixed(2)} yaw ${yawRate.toFixed(1)}${bot.spinner ? ` tip ${bot.tipSpeed(v.qvel).toFixed(0)}` : ''} ${this.t < this.backOffUntil ? 'BACKOFF' : ''}${this.t < this.reverseUntil ? 'REVERSE' : ''} ${this.zoneNote}`;
    return { thr, steer, weapon };
  }
  note = '';
  zoneNote = '';
}
