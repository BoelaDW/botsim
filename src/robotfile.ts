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
  let u8 = new Uint8Array(data);
  if (u8[0] === 0x1f && u8[1] === 0x8b) u8 = new Uint8Array(await pipe(u8, new DecompressionStream('gzip')));
  let def;
  if (new TextDecoder().decode(u8.subarray(0, 8)) === MAGIC) {
    const len = new DataView(u8.buffer, u8.byteOffset).getUint32(8, true);
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
  if (def?.format !== 'botsim-robot') throw new Error('Not a robot file');
  if (def.version !== 1) throw new Error(`Robot file version ${def.version} is newer than this sim`);
  return def as RobotDef;
}

export function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
