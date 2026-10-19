// Drivers: keyboard + gamepad humans, and the desktop sim's AI.
import { ARM_HOLD, ARM_RETURN, type Bot } from './sim';

export interface Cmd { thr: number; steer: number; weapon: number }
export interface View { qpos: Float64Array; qvel: Float64Array; xpos: Float64Array; xmat: Float64Array }

const keys = new Set<string>();
const pressedOnce = new Set<string>();
addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement)?.closest?.('input, select, textarea')) return;
  if (!keys.has(e.code)) pressedOnce.add(e.code);
  keys.add(e.code);
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
addEventListener('keyup', (e) => keys.delete(e.code));
addEventListener('blur', () => keys.clear());

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
    let steer = (+k('right') - +k('left')) * 0.7;
    let half = k('half');
    const held = k('weapon');
    let analog: number | null = null;
    const pad = gamepads()[this.padSlot];
    this.label = this.useKeys ? 'keys' : 'waiting for pad';
    if (pad) {
      this.label = 'pad: ' + pad.id.slice(0, 28) + (pad.mapping === 'standard' ? '' : ' (non-standard mapping!)');
      const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : v);
      if (dz(pad.axes[1] ?? 0)) thr = -dz(pad.axes[1]);
      if (dz(pad.axes[2] ?? 0)) steer = dz(pad.axes[2]) * 0.8;
      const rt = pad.buttons[7]?.value ?? 0;      // right trigger
      if (rt > 0.03) analog = rt;
      half ||= !!pad.buttons[4]?.pressed;         // left bumper
    }
    if (half) { thr *= 0.5; steer *= 0.5; }
    let weapon: number;
    if (bot.spinner) weapon = analog ?? (this.weaponOn ? 1 : 0);
    else weapon = held || (analog !== null && analog > 0.3) ? ARM_HOLD : ARM_RETURN;
    return { thr, steer, weapon };
  }
}

/** Face the opponent, charge, use the weapon, back off when stuck (port of the desktop AI). */
export class AI implements Driver {
  label = 'AI';
  t = 0; stuckT = 0; reverseUntil = -1; liftUntil = -1; turnDir = 1; sideT = 0; dropUntil = -1;

  controls(bot: Bot, other: Bot | null, v: View, dt: number): Cmd {
    this.t += dt;
    if (!other) return { thr: 0, steer: 0, weapon: 0 };
    const b = bot.chassis * 9, o = other.chassis * 3, p = bot.chassis * 3;
    const d = [v.xpos[o] - v.xpos[p], v.xpos[o + 1] - v.xpos[p + 1], v.xpos[o + 2] - v.xpos[p + 2]];
    // rel = R^T d (robot frame)
    const rel = [0, 1, 2].map((c) => v.xmat[b + c] * d[0] + v.xmat[b + 3 + c] * d[1] + v.xmat[b + 6 + c] * d[2]);
    if (bot.upsideDown(v.xmat)) rel[0] = -rel[0];
    const ang = (Math.atan2(rel[0], rel[1]) * 180) / Math.PI;   // + = opponent to the right
    const dist = Math.hypot(rel[0], rel[1]);
    const lim = bot.def.weapon.type === 'spinner' ? 0.45 : 1.0;  // a spun-up vertical disc fights fast turns
    let steer = Math.max(-lim, Math.min(lim, ang / 35));
    let thr = Math.abs(ang) < 30 ? 1 : 0.3;
    this.sideT = bot.onSide(v.xmat) ? this.sideT + dt : 0;
    let weapon: number;
    if (bot.spinner) {
      weapon = 1;
      if (this.sideT > 1.5) this.dropUntil = this.t + 2.5;   // gyro holding it on its side: spin down to fall over
      if (this.t < this.dropUntil) return { thr: 0, steer: 0, weapon: 0 };
      if (bot.tipSpeed(v.qvel) < 0.6 * bot.D.noLoadTip && dist < 1.0) thr = -0.4;   // back off until up to speed
    } else {
      weapon = ARM_RETURN;
      if (bot.upsideDown(v.xmat)) { weapon = ARM_HOLD; thr = 0; steer = 0; }   // self-right with the arm
      else if (rel[1] > 0 && rel[1] < (bot.kind === 'hammer' ? 0.5 : 0.62) && Math.abs(rel[0]) < 0.32) this.liftUntil = this.t + 0.7;
      if (this.t < this.liftUntil) weapon = ARM_HOLD;
    }
    if (thr > 0.5 && Math.abs(bot.forwardSpeed(v.xmat, v.qvel)) < 0.15) this.stuckT += dt; else this.stuckT = 0;
    if (this.stuckT > 1.0) { this.reverseUntil = this.t + 0.6; this.stuckT = 0; this.turnDir = -this.turnDir; }
    if (this.t < this.reverseUntil) { thr = -0.8; steer = 0.5 * this.turnDir; }
    return { thr, steer, weapon };
  }
}
