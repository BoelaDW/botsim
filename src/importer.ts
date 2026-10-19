// CAD parts + the builder's choices -> RobotDef. No DOM here so it can be tested headless.
import { add, derive, dot, norm, scale, sub } from './build';
import { combine, meshVolumeProps, principal, type Props } from './massprops';
import type { Electrics, Part, RobotDef, Vec3, WeaponType, Wheel } from './types';

export interface RawPart { name: string; color: Vec3 | null; pos: Float32Array; idx: Uint32Array }

export const WHEEL_TAGS = ['wheel1', 'wheel2', 'wheel3', 'wheel4', 'wheel5', 'wheel6'] as const;
export type Tag = 'chassis' | 'weapon' | (typeof WHEEL_TAGS)[number] | 'ignore';

export const MATERIALS: Record<string, { density: number; color: Vec3 }> = {
  'Aluminium': { density: 2700, color: [0.75, 0.77, 0.8] },
  'Steel': { density: 7850, color: [0.6, 0.62, 0.66] },
  'Titanium': { density: 4430, color: [0.55, 0.56, 0.6] },
  'UHMW / HDPE': { density: 940, color: [0.92, 0.92, 0.9] },
  'TPU / urethane': { density: 1200, color: [0.12, 0.12, 0.12] },
  'PLA / PETG / nylon': { density: 1250, color: [0.95, 0.5, 0.15] },
  'ABS / ASA': { density: 1050, color: [0.85, 0.85, 0.82] },
  'Nylon-CF / PA12': { density: 1100, color: [0.2, 0.2, 0.22] },
  'Polycarbonate': { density: 1200, color: [0.7, 0.8, 0.9] },
  'Carbon fibre': { density: 1600, color: [0.15, 0.15, 0.17] },
  'Copper': { density: 8960, color: [0.8, 0.5, 0.3] },
  'Electronics / battery': { density: 1900, color: [0.2, 0.45, 0.25] },
};

export function guessMaterial(name: string): string {
  const n = name.toLowerCase();
  const has = (...w: string[]) => w.some((x) => n.includes(x));
  if (has('copper', 'coil')) return 'Copper';
  if (has('screw', 'bolt', 'nut', 'washer', 'bearing', 'shaft', 'axle', 'pin', 'steel', 'hardox', 'ar500', 'stator', 'rotor', 'spinner', 'disc', 'blade', 'tooth')) return 'Steel';
  if (has('tpu', 'urethane', 'tread', 'tyre', 'tire', 'rubber', 'belt')) return 'TPU / urethane';
  if (has('uhmw', 'hdpe')) return 'UHMW / HDPE';
  if (has('printed', 'pla', 'petg', 'nylon')) return 'PLA / PETG / nylon';
  if (has('titanium', 'ti-6al', ' ti ')) return 'Titanium';
  if (has('polycarb')) return 'Polycarbonate';
  if (has('carbon')) return 'Carbon fibre';
  if (has('esc', 'battery', 'lipo', 'receiver', 'switch', 'brain', 'pcb', 'placeholder', 'distribution')) return 'Electronics / battery';
  return 'Aluminium';
}

export interface ImportPart extends RawPart {
  tag: Tag;
  material: string;
  fill: number;              // 0..1: solid fraction (3D-printed parts are mostly air)
  massKg: number | null;     // measured mass; overrides material x volume x fill
  collide: boolean;
  vol: number;               // m^3 (hull volume if the mesh isn't closed)
  size: Vec3;                // bounding box (raw frame)
  center: Vec3;              // bounding box centre (raw frame)
}

function bbox(pos: Float32Array): { lo: Vec3; hi: Vec3 } {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) {
    lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]);
  }
  return { lo, hi };
}

export const partMass = (p: ImportPart) => p.massKg ?? MATERIALS[p.material].density * p.vol * p.fill;

function firstPass(r: RawPart) {
  const { lo, hi } = bbox(r.pos);
  const size = sub(hi, lo);
  let vol = meshVolumeProps(r.pos, r.idx).vol;
  const boxVol = size[0] * size[1] * size[2];
  if (!(vol > 0) || vol > 1.05 * boxVol) vol = 0.5 * boxVol;   // open mesh: rough guess (refined at build)
  const material = guessMaterial(r.name);
  return { ...r, tag: 'chassis' as Tag, material, fill: 1, massKg: null, collide: false, vol, size, center: scale(add(lo, hi), 0.5), lo, hi };
}

/** First pass over freshly loaded parts: volume, bounds, default material and collision. */
export function initParts(raw: RawPart[]): ImportPart[] {
  return finishParts(raw.map(firstPass));
}

/** Same as initParts, but yields to the browser now and then so a progress bar can move. */
export async function initPartsAsync(raw: RawPart[], progress: (done: number) => void): Promise<ImportPart[]> {
  const out: ReturnType<typeof firstPass>[] = [];
  let t = performance.now();
  for (const r of raw) {
    out.push(firstPass(r));
    if (performance.now() - t > 40) { progress(out.length / raw.length); await new Promise((ok) => setTimeout(ok)); t = performance.now(); }
  }
  return finishParts(out);
}

function finishParts(parts: ReturnType<typeof firstPass>[]): ImportPart[] {
  // collision shapes only for the outside of the robot: parts reaching within 10 mm of the overall
  // bounding box (armour, plates, rails, forks). Internals (motors, screws, ESCs) carry mass only.
  const LO: Vec3 = [Infinity, Infinity, Infinity], HI: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let k = 0; k < 3; k++) { LO[k] = Math.min(LO[k], p.lo[k]); HI[k] = Math.max(HI[k], p.hi[k]); }
  return parts.map(({ lo, hi, ...p }) => {
    const outer = [0, 1, 2].some((k) => lo[k] - LO[k] < 0.01 || HI[k] - hi[k] < 0.01);
    return { ...p, collide: outer && Math.max(...p.size) >= 0.02 && Math.min(...p.size) >= 0.002 };
  });
}

export interface ImportSettings {
  name: string;
  rot: number[];             // 3x3 row-major, raw -> robot orientation (multiples of 90 deg)
  weaponType: WeaponType;
  weaponAxis: 'auto' | 'x' | 'y' | 'z';
  reverse: boolean;
  pivot: Vec3 | null;        // raw frame; null = weapon centre of mass
  rangeDeg: [number, number];
  elec: Electrics;
  targetMass: number;
  ballast: boolean;
}

export function defaultElectrics(t: WeaponType): Electrics {
  const drive = { kv: 1000, r: 0.05, iLimit: 30, rotorJ: 2e-5, ratio: 30, motorsPerSide: 1 };
  const weapon = {
    spinner: { kv: 500, r: 0.015, iLimit: 120, rotorJ: 6e-5, ratio: 2 },
    drum: { kv: 1000, r: 0.02, iLimit: 60, rotorJ: 4e-5, ratio: 3 },
    lifter: { kv: 1000, r: 0.05, iLimit: 60, rotorJ: 2e-5, ratio: 400 },
    hammer: { kv: 500, r: 0.03, iLimit: 90, rotorJ: 6e-5, ratio: 40 },
  }[t];
  return { cells: 6, volts: 6 * 3.7, rBatt: 0.012, drive, weapon };
}

export const defaultRange = (t: WeaponType): [number, number] => (t === 'hammer' ? [0, 175] : [0, 100]);

export const rotApply = (R: number[], v: Vec3): Vec3 =>
  [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];

export function rotMul(A: number[], B: number[]): number[] {
  const C: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) C.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]);
  return C;
}

/** 90 degree turn about a world axis. */
export function rot90(axis: 'x' | 'y' | 'z', sign = 1): number[] {
  const s = sign;
  return axis === 'x' ? [1, 0, 0, 0, 0, -s, 0, s, 0] : axis === 'y' ? [0, 0, s, 0, 1, 0, -s, 0, 0] : [0, -s, 0, s, 0, 0, 0, 0, 1];
}

/** Mesh transformed into the robot frame. */
function place(p: RawPart, R: number[], off: Vec3): Float32Array {
  const out = new Float32Array(p.pos.length);
  for (let i = 0; i < p.pos.length; i += 3) {
    const v = rotApply(R, [p.pos[i], p.pos[i + 1], p.pos[i + 2]]);
    out[i] = v[0] + off[0]; out[i + 1] = v[1] + off[1]; out[i + 2] = v[2] + off[2];
  }
  return out;
}

/** Placement offset: robot centred on X/Y, lowest point on z = 0. */
export function placement(parts: ImportPart[], R: number[]): Vec3 {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) {
    if (p.tag === 'ignore') continue;
    for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
      const v = rotApply(R, add(p.center, [sx * p.size[0], sy * p.size[1], sz * p.size[2]]));
      for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], v[k]); hi[k] = Math.max(hi[k], v[k]); }
    }
  }
  if (!isFinite(lo[0])) return [0, 0, 0];
  return [-(lo[0] + hi[0]) / 2, -(lo[1] + hi[1]) / 2, -lo[2]];
}

/** Shape-only props of a group of placed meshes (unit density, for axes and centres). */
function groupProps(meshes: { pos: Float32Array; idx: Uint32Array; mass: number }[]): Props {
  return combine(meshes.map(({ pos, idx, mass }) => {
    const v = meshVolumeProps(pos, idx);
    const k = v.vol > 0 ? mass / v.vol : 0;
    return { m: mass, c: v.c, I: v.I.map((x) => x * k) };
  }).filter((p) => p.m > 0 && isFinite(p.c[0])));
}

/** Principal axis closest to a direction. */
function axisNear(I: number[], dir: Vec3): Vec3 {
  const { axes } = principal(I);
  let best = axes[0];
  for (const a of axes) if (Math.abs(dot(a, dir)) > Math.abs(dot(best, dir))) best = a;
  return dot(best, dir) < 0 ? scale(best, -1) : best;
}

function axisLargest(I: number[]): Vec3 {
  const { moments, axes } = principal(I);
  const i = moments.indexOf(Math.max(...moments));
  const a = axes[i];
  return a[2] < -0.5 || (Math.abs(a[2]) < 0.5 && a[0] < 0) ? scale(a, -1) : a;
}

/** Snap an axis to X / Y / Z when it's within a few degrees (CAD exports are rarely off-axis on purpose). */
function snap(a: Vec3): Vec3 {
  for (let k = 0; k < 3; k++) if (Math.abs(a[k]) > 0.995) { const s: Vec3 = [0, 0, 0]; s[k] = Math.sign(a[k]); return s; }
  return norm(a);
}

export interface BuildResult { def: RobotDef; warnings: string[]; info: string[] }

export function buildDef(parts: ImportPart[], S: ImportSettings): BuildResult {
  const warnings: string[] = [], info: string[] = [];
  const R = S.rot;
  const off = placement(parts, R);
  const used = parts.filter((p) => p.tag !== 'ignore');
  const placed = used.map((p) => ({ p, pos: place(p, R, off), mass: partMass(p) }));

  // wheels: one per wheel tag in use, axis = principal axis nearest left-right
  const wheels: Wheel[] = [];
  const wheelBody = new Map<string, string>();
  for (const tag of WHEEL_TAGS) {
    const g = placed.filter((x) => x.p.tag === tag);
    if (!g.length) continue;
    const pr = groupProps(g.map((x) => ({ pos: x.pos, idx: x.p.idx, mass: x.mass })));
    const axis = snap(axisNear(pr.I, [1, 0, 0]));
    let r = 0;
    const pts: { along: number; rad: number }[] = [];
    for (const x of g) for (let i = 0; i < x.pos.length; i += 3) {
      const d = sub([x.pos[i], x.pos[i + 1], x.pos[i + 2]], pr.c), along = dot(d, axis);
      const rad = Math.hypot(...sub(d, scale(axis, along)));
      pts.push({ along, rad }); r = Math.max(r, rad);
    }
    let a0 = Infinity, a1 = -Infinity;          // tread = the outer 15% of the radius
    for (const q of pts) if (q.rad > 0.85 * r) { a0 = Math.min(a0, q.along); a1 = Math.max(a1, q.along); }
    const center = add(pr.c, scale(axis, (a0 + a1) / 2));
    wheelBody.set(tag, 'wheel' + wheels.length);
    wheels.push({ center, axis, radius: r, width: Math.max(0.005, a1 - a0) });
    info.push(`${tag}: Ø${(2 * r * 1000).toFixed(0)} mm × ${((a1 - a0) * 1000).toFixed(0)} mm at (${center.map((v) => (v * 1000).toFixed(0)).join(', ')}) mm, ${center[0] < 0 ? 'left' : 'right'}`);
  }
  if (!wheels.length) warnings.push('No wheels tagged: the robot will not be able to drive.');
  const sides = new Set(wheels.map((w) => (w.center[0] < 0 ? 'l' : 'r')));
  if (wheels.length && sides.size < 2) warnings.push('All wheels are on one side: check the orientation (front should point to +Y, the green arrow).');

  // weapon
  const wg = placed.filter((x) => x.p.tag === 'weapon');
  if (!wg.length) warnings.push('No weapon parts tagged.');
  const wp = groupProps(wg.map((x) => ({ pos: x.pos, idx: x.p.idx, mass: x.mass })));
  const spin = S.weaponType === 'spinner' || S.weaponType === 'drum';
  let axis: Vec3;
  if (S.weaponAxis !== 'auto') axis = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }[S.weaponAxis] as Vec3;
  else if (!wg.length) axis = [1, 0, 0];
  else if (S.weaponType === 'spinner') axis = snap(axisLargest(wp.I));
  else if (S.weaponType === 'drum') axis = snap(axisNear(wp.I, [1, 0, 0]));
  else axis = [1, 0, 0];
  if (S.reverse) axis = scale(axis, -1);
  let pivot: Vec3;
  if (S.pivot) pivot = add(rotApply(R, S.pivot), off);
  else {
    pivot = wg.length ? wp.c : [0, 0, 0];
    if (!spin) warnings.push('Arm weapon with no pivot set: using the arm\'s centre of mass. Select the hinge/axle parts and press "Pivot = selection".');
  }
  info.push(`Weapon axis (${axis.map((v) => v.toFixed(2)).join(', ')}), pivot (${pivot.map((v) => (v * 1000).toFixed(0)).join(', ')}) mm`);

  // parts
  const out: Part[] = placed.map(({ p, pos, mass }) => ({
    name: p.name,
    body: p.tag === 'chassis' ? 'chassis' : p.tag === 'weapon' ? 'weapon' : wheelBody.get(p.tag)!,
    color: p.color ?? MATERIALS[p.material].color,
    collide: p.collide || (p.tag === 'weapon' && Math.max(...p.size) >= 0.02),   // weapons always hit
    mass,
    mesh: { pos, idx: p.idx },
  }));
  let total = out.reduce((s, p) => s + p.mass, 0);
  if (S.ballast && total < S.targetMass) {
    const ch = combine(out.filter((p) => p.body === 'chassis').map((p) => ({ m: p.mass, c: centroid(p.mesh!.pos), I: [0, 0, 0, 0, 0, 0, 0, 0, 0] })));
    const extra = S.targetMass - total;
    out.push({ name: 'Ballast (unmodelled mass)', body: 'chassis', color: [0.3, 0.3, 0.3], collide: false, mass: extra,
      prim: { type: 'box', pos: ch.c, size: [0.04, 0.04, 0.01] } });
    info.push(`Added ${extra.toFixed(2)} kg ballast at the chassis centre of mass`);
    total = S.targetMass;
  }
  if (total > S.targetMass + 1e-6) warnings.push(`Overweight: ${total.toFixed(2)} kg (limit ${S.targetMass} kg).`);

  const def: RobotDef = {
    format: 'botsim-robot', version: 1, name: S.name || 'Imported robot',
    parts: out, wheels,
    weapon: { type: S.weaponType, pivot, axis, rangeDeg: spin ? undefined : S.rangeDeg },
    elec: S.elec, tyreMu: 1.0, bodyMu: 0.4,
  };
  const D = derive(def);
  info.push(`Mass ${D.mass.toFixed(2)} kg (chassis ${(D.massBy.chassis ?? 0).toFixed(2)}, weapon ${(D.massBy.weapon ?? 0).toFixed(2)})`);
  const wRpm = (D.noLoadArmDps / 6).toFixed(0);
  if (spin) info.push(`Weapon no-load: ${wRpm} rpm, tip ${D.noLoadTip.toFixed(0)} m/s at ${(D.tipRadius * 1000).toFixed(0)} mm radius, ` +
    `${(0.5 * D.weaponJ * (D.noLoadArmDps * Math.PI / 180) ** 2 / 1000).toFixed(1)} kJ (inertia ${D.weaponJ.toExponential(2)} kg m²)`);
  else info.push(`Arm no-load: ${D.noLoadArmDps.toFixed(0)} deg/s (${wRpm} rpm), full travel in ${((S.rangeDeg[1] - S.rangeDeg[0]) / D.noLoadArmDps * 1000).toFixed(0)} ms unloaded`);
  info.push(`Drive no-load: ${D.topSpeed.toFixed(1)} m/s (${(D.topSpeed * 3.6).toFixed(0)} km/h) on Ø${(2000 * Math.max(...wheels.map((w) => w.radius), 0)).toFixed(0)} mm wheels`);
  if (spin && D.noLoadTip > 200) warnings.push(`Weapon tip speed ${D.noLoadTip.toFixed(0)} m/s is unusually high: check the kV and reduction.`);
  if (D.topSpeed > 12) warnings.push(`Drive speed ${D.topSpeed.toFixed(1)} m/s is unusually high: check the drive kV and reduction.`);
  const colliding = out.filter((p) => p.collide && !p.body.startsWith('wheel')).length;
  info.push(`${colliding} collision shapes (convex hulls), ${out.length} parts`);
  if (colliding > 120) warnings.push(`${colliding} collision shapes is a lot: untick "collide" on small internal parts to speed things up.`);
  return { def, warnings, info };
}

function centroid(pos: Float32Array): Vec3 {
  const c: Vec3 = [0, 0, 0];
  const n = pos.length / 3;
  for (let i = 0; i < pos.length; i += 3) { c[0] += pos[i]; c[1] += pos[i + 1]; c[2] += pos[i + 2]; }
  return scale(c, 1 / Math.max(n, 1));
}
