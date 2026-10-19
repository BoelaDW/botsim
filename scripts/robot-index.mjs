// Builds public/robots/index.json (the gallery list) from the .bot files next to it.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const dir = 'public/robots';
const header = (buf) => {
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  if (buf.subarray(0, 8).toString() === 'BOTSIM2\n') return JSON.parse(buf.subarray(12, 12 + buf.readUInt32LE(8)).toString());
  return JSON.parse(buf.toString());                     // old plain-JSON format
};
const added = (file) => {
  try { return execFileSync('git', ['log', '--diff-filter=A', '--format=%cI', '--', file], { encoding: 'utf8' }).trim().split('\n').pop() || null; }
  catch { return null; }
};
const list = [];
for (const f of readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.bot')).sort()) {
  const path = `${dir}/${f}`;
  try {
    const d = header(readFileSync(path));
    list.push({
      file: f, name: d.name, author: d.author ?? '', description: d.description ?? '',
      weapon: d.weapon?.type, mass: +d.parts.reduce((s, p) => s + p.mass, 0).toFixed(2),
      volts: +(d.elec.volts ?? d.elec.cells * 3.7).toFixed(1), parts: d.parts.length,
      bytes: statSync(path).size, added: added(path) ?? statSync(path).mtime.toISOString(),
    });
  } catch (e) {
    console.warn(`robot-index: skipped ${f}: ${e.message}`);
  }
}
list.sort((a, b) => (b.added ?? '').localeCompare(a.added ?? ''));
writeFileSync(`${dir}/index.json`, JSON.stringify(list, null, 1));
console.log(`robot-index: ${list.length} robot(s)`);
