// occt-import-js is a classic (non-module) Emscripten build: serve it as-is from public/ for the STEP worker.
import { copyFileSync, mkdirSync } from 'node:fs';
const src = 'node_modules/occt-import-js/dist/';
mkdirSync('public/occt', { recursive: true });
for (const f of ['occt-import-js.js', 'occt-import-js.wasm']) copyFileSync(src + f, 'public/occt/' + f);
