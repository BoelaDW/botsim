// .bot files: a RobotDef as JSON, mesh arrays stored as base64.
import type { RobotDef } from './types';

function b64(a: Float32Array | Uint32Array): string {
  const u8 = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s: string): ArrayBuffer {
  const bin = atob(s), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8.buffer;
}

export function saveBot(def: RobotDef): Blob {
  const json = JSON.stringify(def, (_k, v) =>
    v instanceof Float32Array ? { f32: b64(v) } : v instanceof Uint32Array ? { u32: b64(v) } : v);
  return new Blob([json], { type: 'application/json' });
}

export function loadBot(text: string): RobotDef {
  const def = JSON.parse(text, (_k, v) =>
    v && typeof v === 'object' && 'f32' in v ? new Float32Array(unb64(v.f32))
      : v && typeof v === 'object' && 'u32' in v ? new Uint32Array(unb64(v.u32)) : v);
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
