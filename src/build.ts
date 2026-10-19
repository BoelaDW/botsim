// Robot definition -> MuJoCo XML (MJCF) + the numbers the runtime needs.
import { combine, fullInertia, hullOf, meshProps, primProps, type Props } from './massprops';
import type { MeshData, Part, RobotDef, Vec3 } from './types';

export const ARENA = 7.3;           // m, featherweight box (same as the desktop sim)
export const WALL_H = 2.4;          // m: enclosed like a real arena (robots used to get flung over 0.6 m walls)
export const TIMESTEP = 0.0002;
export const INTEGRATOR = 'implicit';      // implicitfast blew up shell spinners (it treats the gyroscopic terms explicitly)
export const V_CELL = 3.7;

export const motorSpeed = (kv: number, v: number) => kv * v * 2 * Math.PI / 60;   // rad/s no load

// heavy per-part work (hulls, mesh integrals) is cached on the part object
const hullCache = new WeakMap<Part, MeshData>();
const propsCache = new WeakMap<Part, Props>();

export function partHull(p: Part): MeshData {
  let h = hullCache.get(p);
  if (!h) { h = hullOf(p.mesh!.pos); hullCache.set(p, h); }
  return h;
}

export function partProps(p: Part): Props {
  let pr = propsCache.get(p);
  if (!pr) {
    pr = p.mesh ? meshProps(p.mesh, p.mass, partHull(p)) : primProps(p.prim!, p.mass);
    propsCache.set(p, pr);
  }
  return pr;
}

/** A few points on the part's surface (for bounds, tip radius, floor height). */
export function partPoints(p: Part): Vec3[] {
  if (p.mesh) {
    const h = partHull(p).pos, out: Vec3[] = [];
    for (let i = 0; i < h.length; i += 3) out.push([h[i], h[i + 1], h[i + 2]]);
    return out;
  }
  const q = p.prim!;
  if (q.type === 'box') {
    const out: Vec3[] = [];
    for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1])
      out.push([q.pos[0] + sx * q.size![0], q.pos[1] + sy * q.size![1], q.pos[2] + sz * q.size![2]]);
    return out;
  }
  if (q.type === 'sphere') {
    const r = q.radius!;
    return [[r, 0, 0], [-r, 0, 0], [0, r, 0], [0, -r, 0], [0, 0, r], [0, 0, -r]].map((d) => add(q.pos, d as Vec3));
  }
  const f = q.fromto!, a = norm([f[3] - f[0], f[4] - f[1], f[5] - f[2]]);
  const [u, v] = perpBasis(a), out: Vec3[] = [];
  for (const end of [[f[0], f[1], f[2]], [f[3], f[4], f[5]]] as Vec3[])
    for (let k = 0; k < 24; k++) {
      const t = (k / 24) * 2 * Math.PI, c = Math.cos(t) * q.radius!, s = Math.sin(t) * q.radius!;
      out.push([end[0] + u[0] * c + v[0] * s, end[1] + u[1] * c + v[1] * s, end[2] + u[2] * c + v[2] * s]);
    }
  return out;
}

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k];
export const norm = (a: Vec3): Vec3 => scale(a, 1 / (Math.hypot(...a) || 1));
export const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
export function perpBasis(a: Vec3): [Vec3, Vec3] {
  const t: Vec3 = Math.abs(a[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = norm(cross(a, t));
  return [u, cross(a, u)];
}
const f5 = (x: number) => (Math.abs(x) < 1e-9 ? 0 : x).toFixed(5);
const v3 = (a: Vec3) => a.map(f5).join(' ');

/** Derived numbers for one robot definition. */
export interface Derived {
  bodies: string[];
  origin: Record<string, Vec3>;       // body origins in the robot frame
  wheelSide: ('l' | 'r')[];
  driveRatio: number[];
  driven: Record<'l' | 'r', number>;  // wheel index carrying each side's motor (-1 = none)
  weaponRatio: number;
  tipRadius: number;
  weaponJ: number;                    // weapon inertia about its axis
  topSpeed: number;                   // no-load drive speed, m/s
  noLoadTip: number;                  // spinners: no-load tip speed, m/s
  noLoadArmDps: number;               // arms: no-load speed, deg/s
  weaponDrag: number;                 // spinners: air drag torque = weaponDrag * omega^2
  sizeScale: number;                  // bearing friction relative to a featherweight (small robots have tiny bearings)
  mass: number;
  massBy: Record<string, number>;
  minZ: number;                       // lowest colliding point (robot frame)
  vBatt: number;
}

export function derive(def: RobotDef): Derived {
  const vBatt = def.elec.volts ?? def.elec.cells * V_CELL;
  const origin: Record<string, Vec3> = { chassis: [0, 0, 0], weapon: def.weapon.pivot };
  def.wheels.forEach((w, i) => (origin['wheel' + i] = w.center));
  const bodies = Object.keys(origin);
  const midX = def.wheels.reduce((s, w) => s + w.center[0], 0) / Math.max(1, def.wheels.length);
  const wheelSide = def.wheels.map((w) => (w.center[0] < midX ? 'l' : 'r') as 'l' | 'r');
  const ms = motorSpeed(def.elec.drive.kv, vBatt);
  // the reduction applies to the biggest wheel; other wheels on a side are coupled at the same surface speed
  const maxR = Math.max(0.01, ...def.wheels.map((w) => w.radius));
  const topSpeed = def.elec.drive.ratio ? (ms / def.elec.drive.ratio) * maxR : def.elec.drive.topSpeed ?? 3.5;
  const driveRatio = def.wheels.map((w) => ms / (topSpeed / w.radius));
  const driven = { l: -1, r: -1 };
  def.wheels.forEach((w, i) => {
    const s = wheelSide[i];
    if (driven[s] < 0 || w.radius > def.wheels[driven[s]].radius) driven[s] = i;
  });

  const a = norm(def.weapon.axis), piv = def.weapon.pivot;
  let tipRadius = 0;
  const wparts = def.parts.filter((p) => p.body === 'weapon');
  for (const p of wparts) for (const q of partPoints(p)) {
    const r = sub(q, piv), along = dot(r, a);
    tipRadius = Math.max(tipRadius, Math.hypot(...sub(r, scale(a, along))));
  }
  const wp = combine(wparts.map(partProps));
  const rc = sub(wp.c, piv), rperp = sub(rc, scale(a, dot(rc, a)));
  let ia = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) ia += a[i] * wp.I[i * 3 + j] * a[j];
  const weaponJ = ia + wp.m * dot(rperp, rperp);
  const wms = motorSpeed(def.elec.weapon.kv, vBatt);
  const spin = def.weapon.type === 'spinner' || def.weapon.type === 'drum';
  const weaponRatio = def.elec.weapon.ratio ?? (spin
    ? wms / ((def.elec.weapon.tipSpeed ?? 80) / Math.max(tipRadius, 0.01))
    : wms / ((def.elec.weapon.armDps ?? 600) * Math.PI / 180));
  // air drag grows ~ r^5; 2.5e-6 was tuned on a 157 mm featherweight bar (a fixed value stalls small weapons)
  const weaponDrag = spin ? 2.5e-6 * (Math.max(tipRadius, 0.005) / 0.157) ** 5 : 0;
  const noLoadTip = (wms / weaponRatio) * tipRadius, noLoadArmDps = (wms / weaponRatio) * 180 / Math.PI;

  const massBy: Record<string, number> = {};
  for (const p of def.parts) massBy[p.body] = (massBy[p.body] ?? 0) + p.mass;
  const mass = def.parts.reduce((s, p) => s + p.mass, 0);

  let minZ = Infinity;
  for (const p of def.parts) if (p.collide && !p.body.startsWith('wheel')) for (const q of partPoints(p)) minZ = Math.min(minZ, q[2]);
  for (const w of def.wheels) minZ = Math.min(minZ, w.center[2] - w.radius);
  if (!isFinite(minZ)) minZ = 0;
  return { bodies, origin, wheelSide, driveRatio, driven, weaponRatio, tipRadius, weaponJ, topSpeed, noLoadTip, noLoadArmDps, weaponDrag, sizeScale: Math.min(1, (mass / 13.6) ** (5 / 3)), mass, massBy, minZ, vBatt };
}

function quatZ(deg: number): string {
  const h = (deg * Math.PI) / 360;
  return `${Math.cos(h).toFixed(6)} 0 0 ${Math.sin(h).toFixed(6)}`;
}

/** MJCF pieces for one robot instance. heading: degrees from world +X that its front points. */
export function robotXml(def: RobotDef, D: Derived, prefix: string, xy: [number, number], heading: number) {
  const assets: string[] = [], eq: string[] = [], act: string[] = [], excl: string[] = [];
  const geoms: Record<string, string[]> = {};
  const E = def.elec;
  def.parts.forEach((p, i) => {
    if (!p.collide || p.body.startsWith('wheel')) return;      // wheels collide through their tread cylinder
    const o = D.origin[p.body] ?? [0, 0, 0];
    const fr = `friction="${def.bodyMu} 0.005 0.0001" condim="3"`;
    let g: string;
    if (p.mesh) {
      const h = partHull(p).pos, vs: string[] = [];
      if (h.length < 12) return;                                 // flat / empty part: mass only
      for (let k = 0; k < h.length; k += 3) vs.push(v3([h[k] - o[0], h[k + 1] - o[1], h[k + 2] - o[2]]));
      assets.push(`<mesh name="${prefix}m${i}" vertex="${vs.join('  ')}" maxhullvert="64"/>`);
      g = `<geom name="${prefix}part${i}" type="mesh" mesh="${prefix}m${i}" ${fr}/>`;
    } else {
      const q = p.prim!;
      if (q.type === 'box') g = `<geom name="${prefix}part${i}" type="box" pos="${v3(sub(q.pos, o))}" size="${v3(q.size!)}" ${fr}/>`;
      else if (q.type === 'sphere') g = `<geom name="${prefix}part${i}" type="sphere" pos="${v3(sub(q.pos, o))}" size="${f5(q.radius!)}" ${fr}/>`;
      else {
        const f = q.fromto!;
        g = `<geom name="${prefix}part${i}" type="cylinder" fromto="${v3(sub([f[0], f[1], f[2]], o))} ${v3(sub([f[3], f[4], f[5]], o))}" size="${f5(q.radius!)}" ${fr}/>`;
      }
    }
    (geoms[p.body] ??= []).push(g);
  });

  const inertial = (body: string, fallback: number) => {
    const ps = def.parts.filter((p) => p.body === body).map(partProps);
    let c = combine(ps);
    if (c.m <= 0) c = { m: fallback, c: D.origin[body], I: [1e-5, 0, 0, 0, 1e-5, 0, 0, 0, 1e-5].map((x) => x * fallback) };
    return `<inertial pos="${v3(sub(c.c, D.origin[body]))}" mass="${c.m.toFixed(5)}" fullinertia="${fullInertia(c.I, c.m)}"/>`;
  };

  const wheelBody = (i: number) => {
    const w = def.wheels[i], k = 'wheel' + i;
    const half = scale(w.axis, w.width / 2);
    const n = D.driven[D.wheelSide[i]] === i ? E.drive.motorsPerSide : 0;
    const arm = E.drive.rotorJ * D.driveRatio[i] ** 2 * n;
    return `
      <body name="${prefix}${k}" pos="${v3(w.center)}">
        <joint name="${prefix}${k}" type="hinge" axis="${v3(w.axis)}" damping="${(0.004 * D.sizeScale).toPrecision(3)}" armature="${arm.toFixed(7)}"/>
        ${inertial(k, 0.1)}
        <geom name="${prefix}${k}_tread" type="cylinder" fromto="${v3(scale(half, -1))} ${v3(half)}" size="${f5(w.radius)}"
              condim="4" friction="${def.tyreMu} 0.01 0.0002" solref="0.02 1" solimp="0.9 0.95 0.001"/>
      </body>`;
  };

  const W = def.weapon;
  const wArm = E.weapon.rotorJ * D.weaponRatio ** 2;
  const joint = W.type === 'spinner' || W.type === 'drum'
    ? `<joint name="${prefix}weapon" type="hinge" axis="${v3(norm(W.axis))}" damping="${(0.0003 * D.sizeScale).toPrecision(3)}" armature="${wArm.toFixed(7)}"/>`
    : `<joint name="${prefix}weapon" type="hinge" axis="${v3(norm(W.axis))}" limited="true" damping="${(0.0003 * D.sizeScale).toPrecision(3)}"
              range="${(W.rangeDeg![0] * Math.PI / 180).toFixed(4)} ${(W.rangeDeg![1] * Math.PI / 180).toFixed(4)}"
              armature="${wArm.toFixed(7)}" solreflimit="0.004 1"/>`;
  const spawnZ = -D.minZ + 0.004;
  const body = `
    <body name="${prefix}chassis" pos="${xy[0].toFixed(4)} ${xy[1].toFixed(4)} ${spawnZ.toFixed(4)}" quat="${quatZ(heading - 90)}">
      <freejoint name="${prefix}root"/>
      ${inertial('chassis', 1)}
      ${(geoms.chassis ?? []).join('\n      ')}
      <body name="${prefix}weapon" pos="${v3(W.pivot)}">
        ${joint}
        ${inertial('weapon', 0.05)}
        ${(geoms.weapon ?? []).join('\n        ')}
      </body>${def.wheels.map((_, i) => wheelBody(i)).join('')}
    </body>`;

  for (const s of ['l', 'r'] as const) {
    const d = D.driven[s];
    if (d < 0) continue;
    def.wheels.forEach((_, k) => {
      if (k !== d && D.wheelSide[k] === s)
        eq.push(`<joint joint1="${prefix}wheel${k}" joint2="${prefix}wheel${d}" polycoef="0 ${(D.driveRatio[d] / D.driveRatio[k]).toFixed(6)} 0 0 0" solref="0.002 1"/>`);
    });
    act.push(`<motor name="${prefix}drive_${s}" joint="${prefix}wheel${d}" gear="${D.driveRatio[d].toFixed(6)}" ctrllimited="false"/>`);
  }
  act.push(`<motor name="${prefix}weapon" joint="${prefix}weapon" gear="${D.weaponRatio.toFixed(6)}" ctrllimited="false"/>`);
  // a robot's own weapon never collides with its own wheels (drums between wheels etc.)
  def.wheels.forEach((_, k) => excl.push(`<exclude body1="${prefix}weapon" body2="${prefix}wheel${k}"/>`));
  return { assets, body, eq, act, excl };
}

export interface Entry { def: RobotDef; derived: Derived; prefix: string; xy: [number, number]; heading: number }

export function worldXml(entries: Entry[], dummy: boolean, timestep = TIMESTEP): string {
  const parts = entries.map((e) => robotXml(e.def, e.derived, e.prefix, e.xy, e.heading));
  const h = ARENA / 2;
  const dum = dummy
    ? `<body name="dummy" pos="0 1.2 0.065"><freejoint/><geom name="dummy" type="box" size="0.22 0.22 0.06" mass="13.6" friction="0.5 0.005 0.0001"/></body>`
    : '';
  return `<mujoco model="botsim">
  <compiler angle="radian" inertiafromgeom="auto"/>
  <option timestep="${timestep}" integrator="${(globalThis as { BOTSIM_INTEGRATOR?: string }).BOTSIM_INTEGRATOR ?? INTEGRATOR}" gravity="0 0 -9.81" cone="elliptic" impratio="1">
    <flag multiccd="enable"/>
  </option>
  <size memory="200M"/>
  <asset>
    ${parts.flatMap((p) => p.assets).join('\n    ')}
  </asset>
  <default>
    <geom solref="0.004 1" solimp="0.9 0.95 0.001"/>
  </default>
  <worldbody>
    <geom name="floor" type="plane" size="${h} ${h} 0.1" friction="0.3 0.005 0.0001"/>
    <geom name="wall_n" type="box" pos="0 ${h} ${WALL_H / 2}" size="${h} 0.05 ${WALL_H / 2}"/>
    <geom name="wall_s" type="box" pos="0 ${-h} ${WALL_H / 2}" size="${h} 0.05 ${WALL_H / 2}"/>
    <geom name="wall_e" type="box" pos="${h} 0 ${WALL_H / 2}" size="0.05 ${h} ${WALL_H / 2}"/>
    <geom name="wall_w" type="box" pos="${-h} 0 ${WALL_H / 2}" size="0.05 ${h} ${WALL_H / 2}"/>
    <geom name="roof" type="box" pos="0 0 ${WALL_H + 0.05}" size="${h} ${h} 0.05"/>
    ${parts.map((p) => p.body).join('\n')}
    ${dum}
  </worldbody>
  <contact>
    ${parts.flatMap((p) => p.excl).join('\n    ')}
  </contact>
  <equality>
    ${parts.flatMap((p) => p.eq).join('\n    ')}
  </equality>
  <actuator>
    ${parts.flatMap((p) => p.act).join('\n    ')}
  </actuator>
</mujoco>`;
}
