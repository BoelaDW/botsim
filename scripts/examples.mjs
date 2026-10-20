// Rebuild the arena's example robots from the parametric FreeCAD models:
//   1. export cad/examples/*.FCStd to STEP (only the ones changed since their STEP), with FreeCAD
//   2. import each STEP with its rules (cad/examples.json) and save public/builtin/<name>.bot
// FULL=1 also drives each robot and fights it against the others (slower).
// FreeCAD: set FREECAD=/path/to/freecad if it isn't on your PATH as `freecad` / `FreeCAD`.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

const candidates = [process.env.FREECAD, 'freecad', 'FreeCAD', 'freecadcmd', `${homedir()}/.local/opt/freecad/freecad`,
  '/Applications/FreeCAD.app/Contents/MacOS/FreeCAD', 'C:\\Program Files\\FreeCAD 1.0\\bin\\freecad.exe'].filter(Boolean);
const changed = readdirSync('cad/examples').filter((f) => f.endsWith('.FCStd'))
  .filter((f) => { const step = `cad/examples/${f.slice(0, -6)}.step`; return !existsSync(step) || statSync(step).mtimeMs < statSync(`cad/examples/${f}`).mtimeMs; });
if (changed.length) {
  // (`--version` opens the GUI on some builds: run a one-line script instead)
  const fc = candidates.find((c) => spawnSync(c, ['-c', "print('fc-ok')"], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 120000, encoding: 'utf8' }).stdout?.includes('fc-ok'));
  if (!fc) { console.error(`FreeCAD not found (tried ${candidates.join(', ')}). Set FREECAD=/path/to/freecad.`); process.exit(1); }
  console.log(`exporting ${changed.join(', ')} with ${fc}`);
  execFileSync(fc, ['-c', "exec(open('cad/export_step.py').read())"], {
    stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, FILES: changed.map((f) => `${process.cwd()}/cad/examples/${f}`).join(process.platform === 'win32' ? ';' : ':') },
  });
} else console.log('STEP files are up to date with the FreeCAD models');
execFileSync('npx', ['rolldown', 'tests/stress.ts', '--format', 'esm', '--platform', 'node', '--external', '@mujoco/mujoco', '--file', 'tests/.out/stress.mjs'], { stdio: 'ignore' });
execFileSync('node', ['tests/.out/stress.mjs', 'cad/examples.json', ...(process.argv[2] ? [process.argv[2]] : [])],
  { stdio: 'inherit', env: { ...process.env, SAVE: 'public/builtin', ...(process.env.FULL ? {} : { QUICK: '1' }) } });
