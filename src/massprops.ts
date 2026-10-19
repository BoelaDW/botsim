// Mass properties: closed triangle meshes (exact polyhedral integrals), primitives,
// combining parts into a body, principal axes, convex hulls.
import { Vector3 } from 'three';
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js';
import type { MeshData, Prim, Vec3 } from './types';

export interface Props {
  m: number;
  c: Vec3;            // centre of mass
  I: number[];        // 3x3 inertia tensor about c, row-major
}

/** Volume, centroid and unit-density inertia (about the centroid) of a closed mesh.
 *  Eberly, "Polyhedral Mass Properties (Revisited)". Inward-facing meshes come out positive too. */
export function meshVolumeProps(pos: ArrayLike<number>, idx: ArrayLike<number>): { vol: number; c: Vec3; I: number[] } {
  const s = new Float64Array(10);
  const sub = (w0: number, w1: number, w2: number) => {
    const t0 = w0 + w1, f1 = t0 + w2, t1 = w0 * w0, t2 = t1 + w1 * t0;
    const f2 = t2 + w2 * f1, f3 = w0 * t1 + w1 * t2 + w2 * f2;
    return [f1, f2, f3, f2 + w0 * (f1 + w0), f2 + w1 * (f1 + w1), f2 + w2 * (f1 + w2)];
  };
  for (let t = 0; t < idx.length; t += 3) {
    const i0 = idx[t] * 3, i1 = idx[t + 1] * 3, i2 = idx[t + 2] * 3;
    const x0 = pos[i0], y0 = pos[i0 + 1], z0 = pos[i0 + 2];
    const x1 = pos[i1], y1 = pos[i1 + 1], z1 = pos[i1 + 2];
    const x2 = pos[i2], y2 = pos[i2 + 1], z2 = pos[i2 + 2];
    const a1 = x1 - x0, b1 = y1 - y0, c1 = z1 - z0, a2 = x2 - x0, b2 = y2 - y0, c2 = z2 - z0;
    const d0 = b1 * c2 - b2 * c1, d1 = a2 * c1 - a1 * c2, d2 = a1 * b2 - a2 * b1;
    const [f1x, f2x, f3x, g0x, g1x, g2x] = sub(x0, x1, x2);
    const [, f2y, f3y, g0y, g1y, g2y] = sub(y0, y1, y2);
    const [, f2z, f3z, g0z, g1z, g2z] = sub(z0, z1, z2);
    s[0] += d0 * f1x;
    s[1] += d0 * f2x; s[2] += d1 * f2y; s[3] += d2 * f2z;
    s[4] += d0 * f3x; s[5] += d1 * f3y; s[6] += d2 * f3z;
    s[7] += d0 * (y0 * g0x + y1 * g1x + y2 * g2x);
    s[8] += d1 * (z0 * g0y + z1 * g1y + z2 * g2y);
    s[9] += d2 * (x0 * g0z + x1 * g1z + x2 * g2z);
  }
  const mult = [1 / 6, 1 / 24, 1 / 24, 1 / 24, 1 / 60, 1 / 60, 1 / 60, 1 / 120, 1 / 120, 1 / 120];
  for (let i = 0; i < 10; i++) s[i] *= mult[i];
  if (s[0] < 0) for (let i = 0; i < 10; i++) s[i] = -s[i];
  const vol = s[0];
  if (!(vol > 0)) return { vol: 0, c: [0, 0, 0], I: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const cx = s[1] / vol, cy = s[2] / vol, cz = s[3] / vol;
  const xx = s[5] + s[6] - vol * (cy * cy + cz * cz);
  const yy = s[4] + s[6] - vol * (cz * cz + cx * cx);
  const zz = s[4] + s[5] - vol * (cx * cx + cy * cy);
  const xy = -(s[7] - vol * cx * cy), yz = -(s[8] - vol * cy * cz), xz = -(s[9] - vol * cz * cx);
  return { vol, c: [cx, cy, cz], I: [xx, xy, xz, xy, yy, yz, xz, yz, zz] };
}

/** Convex hull of a point set: vertices + triangles. */
/** Convex hull as a triangle mesh. Flat, line-like or empty input (sheet-metal surfaces, sketches)
 *  has no solid hull: that returns an empty mesh, and such parts get mass but no collision shape. */
export function hullOf(pos: ArrayLike<number>): MeshData {
  const empty = { pos: new Float32Array(0), idx: new Uint32Array(0) };
  const pts: Vector3[] = [];
  for (let i = 0; i < pos.length; i += 3) pts.push(new Vector3(pos[i], pos[i + 1], pos[i + 2]));
  if (pts.length < 4) return empty;
  let hull: ConvexHull;
  try { hull = new ConvexHull().setFromPoints(pts); } catch { return empty; }
  const vmap = new Map<Vector3, number>();
  const vs: number[] = [], ix: number[] = [];
  const id = (p: Vector3) => {
    let k = vmap.get(p);
    if (k === undefined) { k = vs.length / 3; vmap.set(p, k); vs.push(p.x, p.y, p.z); }
    return k;
  };
  for (const f of hull.faces) {
    let e = f.edge;
    const ring: number[] = [];
    do { ring.push(id(e.head().point)); e = e.next; } while (e !== f.edge);
    for (let i = 1; i + 1 < ring.length; i++) ix.push(ring[0], ring[i], ring[i + 1]);
  }
  const out = { pos: new Float32Array(vs), idx: new Uint32Array(ix) };
  // thinner than ~0.01 mm everywhere: treat as flat
  const ext = [0, 1, 2].map((k) => { let lo = Infinity, hi = -Infinity; for (let i = k; i < vs.length; i += 3) { lo = Math.min(lo, vs[i]); hi = Math.max(hi, vs[i]); } return hi - lo; });
  if (vs.length < 12 || !(meshVolumeProps(out.pos, out.idx).vol > 1e-5 * Math.max(...ext) ** 2)) return empty;
  return out;
}

/** Mass properties of a mesh part with a known mass. Falls back to the convex hull when the
 *  mesh isn't closed (volume missing or bigger than its own hull). */
export function meshProps(mesh: MeshData, mass: number, hull?: MeshData): Props & { vol: number; usedHull: boolean } {
  let v = meshVolumeProps(mesh.pos, mesh.idx);
  let usedHull = false;
  const hm = hull ?? hullOf(mesh.pos);
  const h = meshVolumeProps(hm.pos, hm.idx);
  if (!(v.vol > 0.005 * h.vol && v.vol < 1.02 * h.vol)) { v = h; usedHull = true; }
  if (!(v.vol > 0) || !v.c.every(Number.isFinite)) {          // flat or empty: a point mass at its vertices' centre
    const c: Vec3 = [0, 0, 0], n = mesh.pos.length / 3;
    for (let i = 0; i < mesh.pos.length; i += 3) for (let k = 0; k < 3; k++) c[k] += mesh.pos[i + k] / n;
    return { m: n ? mass : 0, c, I: [0, 0, 0, 0, 0, 0, 0, 0, 0], vol: 0, usedHull: true };
  }
  const k = mass / v.vol;
  return { m: mass, c: v.c, I: v.I.map((x) => x * k), vol: v.vol, usedHull };
}

export function primVolume(p: Prim): number {
  if (p.type === 'box') return 8 * p.size![0] * p.size![1] * p.size![2];
  if (p.type === 'sphere') return (4 / 3) * Math.PI * p.radius! ** 3;
  const f = p.fromto!;
  return Math.PI * p.radius! ** 2 * Math.hypot(f[3] - f[0], f[4] - f[1], f[5] - f[2]);
}

export function primProps(p: Prim, m: number): Props {
  if (p.type === 'box') {
    const [a, b, c] = p.size!.map((x) => 2 * x);
    return { m, c: [...p.pos] as Vec3, I: [m * (b * b + c * c) / 12, 0, 0, 0, m * (a * a + c * c) / 12, 0, 0, 0, m * (a * a + b * b) / 12] };
  }
  if (p.type === 'sphere') {
    const i = 0.4 * m * p.radius! ** 2;
    return { m, c: [...p.pos] as Vec3, I: [i, 0, 0, 0, i, 0, 0, 0, i] };
  }
  const f = p.fromto!, r = p.radius!;
  const d: Vec3 = [f[3] - f[0], f[4] - f[1], f[5] - f[2]];
  const h = Math.hypot(...d);
  const a = d.map((x) => x / h);
  const ia = 0.5 * m * r * r, ip = m * (3 * r * r + h * h) / 12;
  const I: number[] = [];
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) I.push((i === j ? ip : 0) + (ia - ip) * a[i] * a[j]);
  return { m, c: [(f[0] + f[3]) / 2, (f[1] + f[4]) / 2, (f[2] + f[5]) / 2], I };
}

/** Sum parts into one rigid body (inertia about the combined centre of mass). */
export function combine(ps: Props[]): Props {
  const M = ps.reduce((s, p) => s + p.m, 0);
  if (M <= 0) return { m: 0, c: [0, 0, 0], I: [0, 0, 0, 0, 0, 0, 0, 0, 0] };
  const c: Vec3 = [0, 1, 2].map((k) => ps.reduce((s, p) => s + p.m * p.c[k], 0) / M) as Vec3;
  const I = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const p of ps) {
    const d = [p.c[0] - c[0], p.c[1] - c[1], p.c[2] - c[2]];
    const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
      I[i * 3 + j] += p.I[i * 3 + j] + p.m * ((i === j ? dd : 0) - d[i] * d[j]);
  }
  return { m: M, c, I };
}

/** Eigen-decomposition of a symmetric 3x3 (Jacobi). Returns moments and unit axes (columns). */
export function principal(I: number[]): { moments: Vec3; axes: Vec3[] } {
  const a = [[I[0], I[1], I[2]], [I[3], I[4], I[5]], [I[6], I[7], I[8]]];
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-18) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-30) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) {          // a = J^T a J
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = c * vkp - s * vkq; v[k][q] = s * vkp + c * vkq;
      }
    }
  }
  return { moments: [a[0][0], a[1][1], a[2][2]], axes: [0, 1, 2].map((j) => [v[0][j], v[1][j], v[2][j]] as Vec3) };
}

/** MuJoCo fullinertia string "ixx iyy izz ixy ixz iyz", nudged so it always compiles. */
export function fullInertia(I: number[], m: number): string {
  const floor = Math.max(1e-7, m * 1e-6);
  const d = [Math.max(I[0], floor), Math.max(I[4], floor), Math.max(I[8], floor)];
  // MuJoCo checks the triangle inequality on principal moments: pad the diagonal a little
  const pad = 1e-6 * (d[0] + d[1] + d[2]);
  return [d[0] + pad, d[1] + pad, d[2] + pad, I[1], I[2], I[5]].map((x) => x.toPrecision(7)).join(' ');
}
