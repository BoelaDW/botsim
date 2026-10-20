// .bot files. Current format: gzip( "BOTSIM2\n" | u32 json length | JSON | pad to 4 | mesh data ).
// Mesh vertices are stored as int32 deltas at 0.01 mm resolution and triangle indices as int32 deltas,
// which gzip squeezes ~12x better than raw floats. Older files (plain JSON, base64 arrays) still load.
import type { RobotDef } from './types';

const MAGIC = 'BOTSIM2\n';
const Q = 1e5;                     // quantisation: 1 unit = 0.01 mm

function unb64(s: string): ArrayBuffer {
  const bin = atob(s), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

async function pipe(data: BlobPart, stream: CompressionStream | DecompressionStream): Promise<ArrayBuffer> {
  return new Response(new Blob([data]).stream().pipeThrough(stream)).arrayBuffer();
}

export async function saveBot(def: RobotDef): Promise<Blob> {
  const chunks: Int32Array[] = [];
  let offset = 0;
  const put = (a: Int32Array) => { chunks.push(a); const o = offset; offset += a.length; return [o, a.length]; };
  const json = JSON.stringify(def, (_k, v) => {
    if (v instanceof Float32Array) {
      const d = new Int32Array(v.length);
      for (let i = 0, prev = [0, 0, 0]; i < v.length; i++) { const q = Math.round(v[i] * Q); d[i] = q - prev[i % 3]; prev[i % 3] = q; }
      return { q: put(d) };
    }
    if (v instanceof Uint32Array) {
      const d = new Int32Array(v.length);
      for (let i = 0; i < v.length; i++) d[i] = v[i] - (i ? v[i - 1] : 0);
      return { d: put(d) };
    }
    return v;
  });
  const head = new TextEncoder().encode(json);
  const pre = 8 + 4 + head.length, pad = (4 - (pre % 4)) % 4;
  const out = new Uint8Array(pre + pad + offset * 4);
  out.set(new TextEncoder().encode(MAGIC), 0);
  new DataView(out.buffer).setUint32(8, head.length, true);
  out.set(head, 12);
  let p = pre + pad;
  for (const c of chunks) { out.set(new Uint8Array(c.buffer), p); p += c.byteLength; }
  return new Blob([await pipe(out, new CompressionStream('gzip'))], { type: 'application/octet-stream' });
}

export async function loadBot(data: ArrayBuffer): Promise<RobotDef> {
  let def;
  try { def = await parseBot(data); }
  catch (e) {
    if (e instanceof SyntaxError) throw new Error("This isn't a BotSim robot file (or it's damaged)");
    throw new Error('This robot file is damaged or incomplete: it could not be unpacked');
  }
  if (def?.format !== 'botsim-robot') throw new Error("This isn't a BotSim robot file");
  if (def.version !== 1) throw new Error(`This robot file is version ${def.version}: it needs a newer version of BotSim`);
  validateDef(def);
  return def as RobotDef;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function parseBot(data: ArrayBuffer): Promise<any> {
  let u8 = new Uint8Array(data);
  if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = new Uint8Array(await pipe(u8, new DecompressionStream('gzip')));
  let def;
  if (new TextDecoder().decode(u8.subarray(0, 8)) === MAGIC) {
    const len = new DataView(u8.buffer, u8.byteOffset).getUint32(8, true);
    if (12 + len > u8.length) throw new SyntaxError('header runs past the end');
    const pre = 12 + len, start = pre + ((4 - (pre % 4)) % 4);
    const blob = new Int32Array(u8.buffer.slice(u8.byteOffset + start, u8.byteOffset + u8.length));
    def = JSON.parse(new TextDecoder().decode(u8.subarray(12, pre)), (_k, v) => {
      if (v && typeof v === 'object' && Array.isArray(v.q)) {
        const [o, n] = v.q, out = new Float32Array(n);
        for (let i = 0, acc = [0, 0, 0]; i < n; i++) { acc[i % 3] += blob[o + i]; out[i] = acc[i % 3] / Q; }
        return out;
      }
      if (v && typeof v === 'object' && Array.isArray(v.d)) {
        const [o, n] = v.d, out = new Uint32Array(n);
        for (let i = 0, acc = 0; i < n; i++) { acc += blob[o + i]; out[i] = acc; }
        return out;
      }
      return v;
    });
  } else {
    def = JSON.parse(new TextDecoder().decode(u8), (_k, v) =>   // format 1: JSON with base64 arrays
      v && typeof v === 'object' && 'f32' in v ? new Float32Array(unb64(v.f32))
        : v && typeof v === 'object' && 'u32' in v ? new Uint32Array(unb64(v.u32)) : v);
  }
  return def;
}

/** Throws a readable error if a robot definition can't be simulated (bad numbers, broken meshes...). */
export function validateDef(def: RobotDef) {
  const fail = (what: string) => { throw new Error(`Robot "${String(def?.name).slice(0, 60)}": ${what}`); };
  const num = (v: unknown, what: string, min = -Infinity, max = Infinity) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      const got = v === undefined ? 'missing' : typeof v === 'number' && Number.isNaN(v) ? 'not a number' : typeof v === 'number' ? String(+v.toPrecision(4)) : JSON.stringify(v);
      fail(`${what} is ${got} (it must be ${min > -Infinity && max < Infinity ? `between ${min} and ${max}` : min > -Infinity ? `at least ${min}` : `at most ${max}`})`);
    }
    return v as number;
  };
  const vec = (v: unknown, what: string, lim = 5) => {
    if (!Array.isArray(v) || v.length !== 3) fail(`${what} is not an x, y, z triple`);
    (v as number[]).forEach((x, k) => num(x, `${what}[${k}]`, -lim, lim));
    return v as number[];
  };
  if (!def || typeof def !== 'object') throw new Error('Not a robot file');
  if (typeof def.name !== 'string' || !def.name.trim()) throw new Error('This robot has no name');
  if (!Array.isArray(def.parts) || !def.parts.length) fail('has no parts');
  if (!Array.isArray(def.wheels)) fail('has no wheel list');
  if (def.parts.length > 20000) fail(`has ${def.parts.length} parts (limit 20000)`);
  const bodies = new Set(['chassis', 'weapon', ...def.wheels.map((_, i) => 'wheel' + i)]);
  let mass = 0, verts = 0;
  def.parts.forEach((p, i) => {
    const what = `part ${i + 1} ("${String(p?.name).slice(0, 40)}")`;
    if (!bodies.has(p?.body)) fail(`${what} belongs to unknown body "${p?.body}"`);
    mass += num(p.mass, `${what} mass`, 0, 200);
    if (!Array.isArray(p.color) || p.color.length !== 3) fail(`${what} has no colour`);
    if (p.mesh) {
      const { pos, idx } = p.mesh;
      if (!(pos instanceof Float32Array) || !(idx instanceof Uint32Array)) fail(`${what} mesh data is damaged`);
      if (pos.length % 3 || idx.length % 3) fail(`${what} mesh has a partial vertex or triangle`);
      const n = pos.length / 3;
      verts += n;
      for (let k = 0; k < pos.length; k++) if (!(Math.abs(pos[k]) <= 5)) fail(`${what} has a vertex at ${pos[k]} m (bad number or wrong units)`);
      for (let k = 0; k < idx.length; k++) if (idx[k] >= n) fail(`${what} has a triangle pointing at vertex ${idx[k]} of ${n}`);
    } else if (p.prim) {
      const q = p.prim;
      if (!['box', 'sphere', 'cylinder'].includes(q.type)) fail(`${what} has unknown shape "${q.type}"`);
      vec(q.pos, `${what} position`);
      if (q.type === 'box') vec(q.size, `${what} size`).forEach((x, k) => num(x, `${what} size[${k}]`, 1e-5));
      else num(q.radius, `${what} radius`, 1e-5, 5);
      if (q.type === 'cylinder') { if (!Array.isArray(q.fromto) || q.fromto.length !== 6) fail(`${what} cylinder has no ends`); q.fromto!.forEach((x, k) => num(x, `${what} end[${k}]`, -5, 5)); }
    } else fail(`${what} has no shape`);
  });
  if (verts > 5e6) fail(`has ${verts} vertices (limit 5 million)`);
  num(mass, 'total mass', 0.01, 500);
  def.wheels.forEach((w, i) => {
    vec(w.center, `wheel ${i + 1} centre`);
    const a = vec(w.axis, `wheel ${i + 1} axis`, 1.001);
    if (Math.hypot(...a) < 0.5) fail(`wheel ${i + 1} axis has no direction`);
    num(w.radius, `wheel ${i + 1} radius`, 0.001, 1);
    num(w.width, `wheel ${i + 1} width`, 0.0005, 1);
  });
  const W = def.weapon;
  if (!W || !['spinner', 'drum', 'lifter', 'hammer'].includes(W.type)) fail(`weapon type "${W?.type}" is unknown`);
  vec(W.pivot, 'weapon pivot');
  if (Math.hypot(...vec(W.axis, 'weapon axis', 1e3)) < 1e-6) fail('weapon axis has no direction');
  if (W.type === 'lifter' || W.type === 'hammer') {
    if (!Array.isArray(W.rangeDeg)) fail('arm weapon has no range');
    const [lo, hi] = W.rangeDeg!;
    num(lo, 'arm range start', -720, 720); num(hi, 'arm range end', -720, 720);
    if (hi <= lo) fail(`arm range ${lo}..${hi}° is empty: the end must be bigger than the start`);
  }
  const E = def.elec;
  if (!E || !E.drive || !E.weapon) fail('has no motor settings');
  num(E.cells, 'battery cells', 1, 50);
  if (E.volts !== undefined) num(E.volts, 'battery voltage', 0.5, 200);
  if (E.driveVolts !== undefined) num(E.driveVolts, 'drive battery voltage', 0.5, 200);
  num(E.rBatt, 'battery resistance', 0, 10);
  for (const [k, m] of [['drive', E.drive], ['weapon', E.weapon]] as const) {
    num(m.kv, `${k} motor kV`, 1, 1e6);
    num(m.r, `${k} motor resistance`, 1e-5, 1000);
    num(m.iLimit, `${k} ESC current limit`, 0.01, 10000);
    num(m.rotorJ, `${k} rotor inertia`, 0, 1);
    if (m.ratio !== undefined) num(m.ratio, `${k} reduction`, 0.01, 1e5);
  }
  num(E.drive.motorsPerSide, 'motors per side', 1, 10);
  if (E.drive.ratio === undefined) num(E.drive.topSpeed, 'drive top speed', 0.01, 100);
  if (E.weapon.ratio === undefined) {
    if (W.type === 'spinner' || W.type === 'drum') num(E.weapon.tipSpeed, 'weapon tip speed', 0.01, 1000);
    else num(E.weapon.armDps, 'arm speed', 0.01, 1e5);
  }
  num(def.tyreMu, 'tyre grip', 0, 5); num(def.bodyMu, 'body friction', 0, 5);
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
