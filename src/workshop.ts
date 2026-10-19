// Workshop: load CAD, orient it, tag parts, set motors, build a robot definition.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { derive, motorSpeed, V_CELL } from './build';
import { busy, done, paint, readFile } from './busy';
import {
  buildDef, defaultElectrics, defaultRange, initPartsAsync, MATERIALS, partMass, placement, rot90, rotMul, WHEEL_TAGS,
  type BuildResult, type ImportPart, type ImportSettings, type RawPart, type Tag,
} from './importer';
import { download, saveBot } from './robotfile';
import { FEATHERWEIGHT_KG, type RobotDef, type Vec3, type WeaponType } from './types';

const TAG_COLOR: Record<string, number> = {
  weapon: 0xe0453a, wheel1: 0x2f7de1, wheel2: 0x2fb5e1, wheel3: 0x6a5ae0, wheel4: 0x37c8a0, wheel5: 0x8fa8ff, wheel6: 0x1f9bb0,
};

const $ = <T extends HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T;

export class Workshop {
  parts: ImportPart[] = [];
  meshes: THREE.Mesh[] = [];
  selected = new Set<number>();
  rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  pivot: Vec3 | null = null;
  colorByTag = true;
  lastResult: BuildResult | null = null;
  fileName = '';

  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 0.005, 50);
  controls: OrbitControls;
  model = new THREE.Group();          // raw CAD -> robot frame
  overlay = new THREE.Group();        // detected wheels / weapon axis (robot frame)
  active = false;

  constructor(private root: HTMLElement, private onTest: (def: RobotDef) => void, private onRemove: (name: string) => void) {
    const canvas = $<HTMLCanvasElement>('#ws-canvas', root);
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.scene.background = new THREE.Color(0x1b1d22);
    this.camera.position.set(0.45, -0.75, 0.5);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0.05);
    this.scene.add(new THREE.HemisphereLight(0xeef2ff, 0x404038, 1.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(1, -2, 3);
    this.scene.add(sun);
    const grid = new THREE.GridHelper(1, 20, 0x666a70, 0x3a3d42);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);
    const arrow = (dir: Vec3, color: number, label: string) => {
      const a = new THREE.ArrowHelper(new THREE.Vector3(...dir), new THREE.Vector3(0, 0, 0.001), 0.35, color, 0.05, 0.03);
      this.scene.add(a);
      const s = textSprite(label, color);
      s.position.set(dir[0] * 0.4, dir[1] * 0.4, 0.02);
      this.scene.add(s);
    };
    arrow([0, 1, 0], 0x4cd964, 'FRONT');
    arrow([1, 0, 0], 0xff5a50, 'RIGHT');
    this.scene.add(this.model, this.overlay);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.pickHandlers(canvas);
    this.wireUi();
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.active) return;
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  resize() {
    const c = this.renderer.domElement, w = c.clientWidth, h = c.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------ loading
  async loadFiles(files: File[]) {
    const status = $('#ws-status', this.root);
    try {
      await this.loadFilesInner(files, status);
    } catch (e) {
      status.textContent = `Could not read the file: ${e instanceof Error ? e.message : e}`;
      console.error(e);
    } finally {
      done();
    }
  }

  private async loadFilesInner(files: File[], status: HTMLElement) {
    const raw: RawPart[] = [];
    const quality = parseFloat($<HTMLSelectElement>('#ws-quality', this.root).value);
    const stlScale = parseFloat($<HTMLSelectElement>('#ws-stl-units', this.root).value);
    for (const f of files) {
      const ext = f.name.split('.').pop()!.toLowerCase();
      const t0 = performance.now();
      status.textContent = `Reading ${f.name}…`;
      if (!['stl', 'step', 'stp', 'iges', 'igs'].includes(ext)) { status.textContent = `Skipped ${f.name}: use STEP, IGES or STL`; continue; }
      const buf = (await readFile(f, 'buffer', `Reading ${f.name}`)) as ArrayBuffer;
      if (ext === 'stl') {
        busy(`Parsing ${f.name}`);
        await paint();
        const geo = new STLLoader().parse(buf);
        const pos = new Float32Array(geo.getAttribute('position').array as ArrayLike<number>);
        for (let i = 0; i < pos.length; i++) pos[i] *= stlScale;
        const idx = new Uint32Array(pos.length / 3).map((_, i) => i);
        raw.push({ name: f.name.replace(/\.stl$/i, ''), color: null, pos, idx });
      } else {
        busy(`Converting ${f.name} with OpenCascade`, undefined, 'big assemblies take 10–60 s');
        raw.push(...(await parseCad(buf, ext, quality)));
      }
      status.textContent = `${f.name}: read in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    }
    if (!raw.length) return;
    this.fileName = files[0].name.replace(/\.[^.]+$/, '');
    $<HTMLInputElement>('#ws-name', this.root).value ||= this.fileName;
    busy('Measuring parts', 0, `${raw.length} parts`);
    const parts = await initPartsAsync(raw, (f) => busy('Measuring parts', f, `${Math.round(f * raw.length)} / ${raw.length} parts`));
    busy('Preparing the 3D view', 1);
    await paint();
    this.setParts(parts);
    status.textContent += ` — ${raw.length} parts. Orient it, then tag parts (click in the view, shift-click to add).`;
  }

  setParts(parts: ImportPart[]) {
    for (const m of this.meshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); }
    this.model.clear();
    this.parts = parts;
    this.selected.clear();
    this.pivot = null;
    this.meshes = parts.map((p, i) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(p.pos, 3));
      g.setIndex(new THREE.BufferAttribute(p.idx, 1));
      g.computeVertexNormals();
      const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ metalness: 0.2, roughness: 0.6, side: THREE.DoubleSide }));
      m.userData.part = i;
      this.model.add(m);
      return m;
    });
    this.applyTransform();
    this.refresh();
    // frame the model
    const size = Math.max(...parts.map((p) => Math.max(...p.size)), 0.2);
    this.camera.position.set(size * 1.3, -size * 2.1, size * 1.4);
    this.controls.target.set(0, 0, size * 0.15);
  }

  applyTransform() {
    const off = placement(this.parts, this.rot);
    const R = this.rot;
    this.model.matrixAutoUpdate = false;
    this.model.matrix.set(R[0], R[1], R[2], off[0], R[3], R[4], R[5], off[1], R[6], R[7], R[8], off[2], 0, 0, 0, 1);
    this.model.matrixWorldNeedsUpdate = true;
    this.overlay.clear();
    this.lastResult = null;
  }

  // ------------------------------------------------------------ view
  refresh() {
    this.parts.forEach((p, i) => {
      const mat = this.meshes[i].material as THREE.MeshStandardMaterial;
      const base = this.colorByTag && TAG_COLOR[p.tag] !== undefined
        ? new THREE.Color(TAG_COLOR[p.tag]) : new THREE.Color(...(p.color ?? MATERIALS[p.material].color));
      mat.color.copy(base);
      mat.transparent = p.tag === 'ignore';
      mat.opacity = p.tag === 'ignore' ? 0.12 : 1;
      mat.emissive.setHex(this.selected.has(i) ? 0x806000 : 0x000000);
      mat.wireframe = false;
    });
    this.renderList();
    this.renderSummary();
  }

  renderList() {
    const list = $('#ws-parts', this.root);
    const filter = $<HTMLInputElement>('#ws-filter', this.root).value.toLowerCase();
    const rows: string[] = [];
    this.parts.forEach((p, i) => {
      if (filter && !p.name.toLowerCase().includes(filter)) return;
      const g = partMass(p) * 1000;
      const custom = p.massKg !== null ? 'weighed' : p.fill < 1 ? `${Math.round(p.fill * 100)}% fill` : '';
      rows.push(`<div class="row${this.selected.has(i) ? ' sel' : ''}" data-i="${i}">
        <span class="tag t-${p.tag}">${tagLabel(p.tag)}</span>
        <span class="nm" title="${esc(p.name)} — ${esc(p.material)}${custom ? ', ' + custom : ''}">${esc(p.name) || '(unnamed)'}</span>
        <span class="g${custom ? ' custom' : ''}" title="${custom || esc(p.material)}">${g < 10 ? g.toFixed(1) : g.toFixed(0)} g</span>
        <span class="c" title="collision shape">${p.collide ? '◼' : '·'}</span></div>`);
    });
    list.innerHTML = rows.join('') || '<div class="empty">No parts loaded</div>';
    $('#ws-selcount', this.root).textContent = `${this.selected.size} selected`;
    this.renderSelInfo();
  }

  /** Mass / material of the current selection, and pre-fill the edit fields with it. */
  renderSelInfo() {
    const sel = [...this.selected].map((i) => this.parts[i]);
    const info = $('#ws-selinfo', this.root);
    if (!sel.length) {
      info.textContent = 'Nothing selected: click parts to edit their material and mass';
      $<HTMLInputElement>('#ws-massg', this.root).placeholder = 'from CAD';
      return;
    }
    const mats = new Set(sel.map((p) => p.material)), fills = new Set(sel.map((p) => p.fill));
    const g = sel.reduce((s, p) => s + partMass(p), 0) * 1000;
    const weighed = sel.filter((p) => p.massKg !== null).length;
    info.textContent = `${sel.length} selected: ${g.toFixed(g < 10 ? 1 : 0)} g, ${mats.size === 1 ? sel[0].material : `${mats.size} materials`}` +
      (fills.size === 1 && sel[0].fill < 1 ? `, ${Math.round(sel[0].fill * 100)}% fill` : '') + (weighed ? `, ${weighed} weighed` : '');
    $<HTMLInputElement>('#ws-fill', this.root).value = fills.size === 1 ? String(Math.round(sel[0].fill * 100)) : '';
    $<HTMLInputElement>('#ws-massg', this.root).placeholder = g.toFixed(0);
  }

  renderSummary() {
    const used = this.parts.filter((p) => p.tag !== 'ignore');
    const mass = used.reduce((s, p) => s + partMass(p), 0);
    const by = (t: string) => used.filter((p) => p.tag === t || (t === 'wheel' && p.tag.startsWith('wheel'))).reduce((s, p) => s + partMass(p), 0);
    const target = parseFloat($<HTMLInputElement>('#ws-target', this.root).value) || FEATHERWEIGHT_KG;
    $('#ws-mass', this.root).innerHTML = `CAD mass <b>${mass.toFixed(2)} kg</b> (chassis ${by('chassis').toFixed(2)}, weapon ${by('weapon').toFixed(2)}, wheels ${by('wheel').toFixed(2)})` +
      (mass > target ? ` <span class="warn">over ${target} kg</span>` : ` — ${(target - mass).toFixed(2)} kg left for unmodelled parts`);
  }

  showOverlay(def: RobotDef) {
    this.overlay.clear();
    const mat = new THREE.MeshBasicMaterial({ color: 0x46d0ff, transparent: true, opacity: 0.35, depthTest: false });
    for (const w of def.wheels) {
      const c = new THREE.Mesh(new THREE.CylinderGeometry(w.radius, w.radius, w.width, 32, 1, true), mat);
      c.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...w.axis));
      c.position.set(...w.center);
      c.renderOrder = 10;
      this.overlay.add(c);
    }
    const W = def.weapon;
    const ax = new THREE.Vector3(...W.axis);
    const arr = new THREE.ArrowHelper(ax, new THREE.Vector3(...W.pivot).addScaledVector(ax, -0.12), 0.24, 0xffd23f, 0.04, 0.025);
    arr.renderOrder = 11;
    (arr.line.material as THREE.Material).depthTest = false;
    (arr.cone.material as THREE.Material).depthTest = false;
    this.overlay.add(arr);
    const piv = new THREE.Mesh(new THREE.SphereGeometry(0.008), new THREE.MeshBasicMaterial({ color: 0xffd23f, depthTest: false }));
    piv.position.set(...W.pivot);
    piv.renderOrder = 12;
    this.overlay.add(piv);
    // overlay coordinates are robot frame; the model is already placed in it
  }

  // ------------------------------------------------------------ picking
  pickHandlers(canvas: HTMLCanvasElement) {
    let down: { x: number; y: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
    canvas.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4 || e.button !== 0) return;
      const r = canvas.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = ray.intersectObjects(this.meshes.filter((m) => this.parts[m.userData.part].tag !== 'ignore' || e.altKey), false)[0];
      const i = hit ? (hit.object.userData.part as number) : -1;
      this.select(i, e.shiftKey || e.ctrlKey || e.metaKey);
      if (i >= 0) $(`#ws-parts .row[data-i="${i}"]`, this.root)?.scrollIntoView({ block: 'nearest' });
    });
  }

  select(i: number, additive: boolean) {
    if (!additive) this.selected.clear();
    if (i >= 0) { if (additive && this.selected.has(i)) this.selected.delete(i); else this.selected.add(i); }
    this.refresh();
  }

  // ------------------------------------------------------------ settings
  settings(): ImportSettings {
    const num = (id: string) => parseFloat($<HTMLInputElement>('#' + id, this.root).value);
    const type = $<HTMLSelectElement>('#ws-wtype', this.root).value as WeaponType;
    const elec = defaultElectrics(type);
    elec.cells = num('ws-cells');
    elec.volts = num('ws-volts') || elec.cells * V_CELL;
    const ratio = (id: string) => {
      const r = parseRatio($<HTMLInputElement>('#' + id, this.root).value);
      if (!(r > 0)) throw new Error(`"${$<HTMLInputElement>('#' + id, this.root).value}" is not a reduction: use a number like 3, 36/12 or 5.2*36/16`);
      return r;
    };
    Object.assign(elec.drive, { kv: num('ws-dkv'), r: num('ws-dr'), iLimit: num('ws-di'), ratio: ratio('ws-dratio'), motorsPerSide: num('ws-dn') });
    Object.assign(elec.weapon, { kv: num('ws-wkv'), r: num('ws-wr'), iLimit: num('ws-wi'), ratio: ratio('ws-wratio') });
    return {
      name: $<HTMLInputElement>('#ws-name', this.root).value.trim() || 'Imported robot',
      rot: this.rot,
      weaponType: type,
      weaponAxis: $<HTMLSelectElement>('#ws-waxis', this.root).value as ImportSettings['weaponAxis'],
      reverse: $<HTMLInputElement>('#ws-wrev', this.root).checked,
      pivot: this.pivot,
      rangeDeg: [num('ws-rmin'), num('ws-rmax')],
      elec,
      targetMass: num('ws-target') || FEATHERWEIGHT_KG,
      ballast: $<HTMLInputElement>('#ws-ballast', this.root).checked,
    };
  }

  /** Fill the motor fields with defaults for a weapon type. */
  weaponDefaults(type: WeaponType) {
    const e = defaultElectrics(type), set = (id: string, v: number) => ($<HTMLInputElement>('#' + id, this.root).value = String(v));
    set('ws-wkv', e.weapon.kv); set('ws-wr', e.weapon.r); set('ws-wi', e.weapon.iLimit); set('ws-wratio', e.weapon.ratio!);
    const spin = type === 'spinner' || type === 'drum';
    const [a, b] = defaultRange(type);
    set('ws-rmin', a); set('ws-rmax', b);
    this.root.querySelectorAll<HTMLElement>('.arm-only').forEach((el) => (el.hidden = spin));
    this.updateCalc();
  }

  /** Live "motor rpm -> output rpm -> speed" lines under the motor fields. */
  updateCalc() {
    const R = this.root, num = (id: string) => parseFloat($<HTMLInputElement>('#' + id, R).value);
    const volts = num('ws-volts');
    const spin = ['spinner', 'drum'].includes($<HTMLSelectElement>('#ws-wtype', R).value);
    const rpm = (radS: number) => Math.round((radS * 60) / (2 * Math.PI)).toLocaleString();
    const D = this.lastResult ? derivedOf(this.lastResult) : null;
    const line = (kvId: string, ratioId: string, out: (w: number) => string) => {
      const ms = motorSpeed(num(kvId), volts), r = parseRatio($<HTMLInputElement>('#' + ratioId, R).value);
      if (!(ms > 0)) return '';
      if (!(r > 0)) return '<span class="warn">reduction: enter a number like 3, 36/12 or 5.2*36/16</span>';
      return `Motor <b>${rpm(ms)}</b> rpm at ${volts.toFixed(1)} V → <b>${rpm(ms / r)}</b> rpm no-load${out(ms / r)}`;
    };
    $('#ws-wcalc', R).innerHTML = line('ws-wkv', 'ws-wratio', (w) =>
      spin ? (D ? `, tip <b>${(w * D.tipRadius).toFixed(0)} m/s</b> at ${(D.tipRadius * 1000).toFixed(0)} mm radius, <b>${(0.5 * D.weaponJ * w * w / 1000).toFixed(1)} kJ</b>`
        : ' (press Check to get tip speed and energy)')
        : ` = <b>${(w * 180 / Math.PI).toFixed(0)}°/s</b>`);
    $('#ws-dcalc', R).innerHTML = line('ws-dkv', 'ws-dratio', (w) =>
      D && D.wheelR ? ` → <b>${(w * D.wheelR).toFixed(1)} m/s</b> (${(w * D.wheelR * 3.6).toFixed(0)} km/h) on Ø${(D.wheelR * 2000).toFixed(0)} mm wheels` : ' (press Check to get the top speed)');
  }

  /** Back to an empty workshop. */
  clear() {
    this.setParts([]);
    this.rot = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    this.applyTransform();
    this.fileName = '';
    $<HTMLInputElement>('#ws-name', this.root).value = '';
    $<HTMLInputElement>('#ws-file', this.root).value = '';
    $('#ws-report', this.root).innerHTML = '';
    $('#ws-status', this.root).textContent = '';
    $('#ws-pivot-state', this.root).textContent = 'pivot: weapon centre of mass';
    this.updateCalc();
  }

  build(): BuildResult | null {
    const out = $('#ws-report', this.root);
    if (!this.parts.length) { out.innerHTML = '<div class="warn">Load a CAD file first.</div>'; return null; }
    try {
      const res = buildDef(this.parts, this.settings());
      this.lastResult = res;
      this.showOverlay(res.def);
      this.updateCalc();
      out.innerHTML = res.warnings.map((w) => `<div class="warn">⚠ ${esc(w)}</div>`).join('') + res.info.map((l) => `<div>${esc(l)}</div>`).join('');
      return res;
    } catch (e) {
      out.innerHTML = `<div class="warn">Build failed: ${esc(e instanceof Error ? e.message : String(e))}</div>`;
      console.error(e);
      return null;
    }
  }

  wireUi() {
    const R = this.root;
    const fileIn = $<HTMLInputElement>('#ws-file', R);
    fileIn.addEventListener('change', () => fileIn.files?.length && this.loadFiles([...fileIn.files]));
    const drop = $('#ws-view', R);
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault(); drop.classList.remove('drag');
      if (e.dataTransfer?.files.length) this.loadFiles([...e.dataTransfer.files]);
    });
    R.querySelectorAll<HTMLButtonElement>('[data-rot]').forEach((b) => b.addEventListener('click', () => {
      const [ax, s] = b.dataset.rot!.split(',');
      this.rot = rotMul(rot90(ax as 'x' | 'y' | 'z', +s), this.rot);
      this.applyTransform();
    }));
    $('#ws-parts', R).addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.row');
      if (row) this.select(+row.dataset.i!, e.shiftKey || e.ctrlKey || e.metaKey);
    });
    $('#ws-filter', R).addEventListener('input', () => this.renderList());
    $('#ws-sel-all', R).addEventListener('click', () => {
      const f = $<HTMLInputElement>('#ws-filter', R).value.toLowerCase();
      this.parts.forEach((p, i) => (!f || p.name.toLowerCase().includes(f)) && this.selected.add(i));
      this.refresh();
    });
    $('#ws-sel-none', R).addEventListener('click', () => { this.selected.clear(); this.refresh(); });
    $('#ws-sel-similar', R).addEventListener('click', () => {
      const stem = (n: string) => n.replace(/[\s_-]*\d+$/, '').replace(/\s*\((left|right|mirror[^)]*)\)\s*$/i, '');
      const stems = new Set([...this.selected].map((i) => stem(this.parts[i].name)));
      this.parts.forEach((p, i) => stems.has(stem(p.name)) && this.selected.add(i));
      this.refresh();
    });
    R.querySelectorAll<HTMLButtonElement>('[data-tag]').forEach((b) => b.addEventListener('click', () => {
      const tag = b.dataset.tag as Tag;
      for (const i of this.selected) this.parts[i].tag = tag;
      this.overlay.clear();
      this.refresh();
    }));
    const matSel = $<HTMLSelectElement>('#ws-material', R);
    const fillMaterials = () => {
      matSel.innerHTML = '<option value="">Set material…</option>' +
        Object.entries(MATERIALS).map(([m, v]) => `<option value="${esc(m)}">${esc(m)} (${(v.density / 1000).toFixed(2)} g/cm³)</option>`).join('') +
        '<option value="+">Custom density…</option>';
    };
    fillMaterials();
    matSel.addEventListener('change', () => {
      let m = matSel.value;
      if (m === '+') {
        const d = parseFloat(prompt('Density in g/cm³ (PLA 1.24, PETG 1.27, TPU 1.21, nylon 1.14, aluminium 2.70):') ?? '');
        const name = d > 0 ? (prompt('Name for this material:', `Custom ${d} g/cm³`) ?? '').trim() : '';
        m = name;
        if (name) { MATERIALS[name] = { density: d * 1000, color: [0.6, 0.55, 0.7] }; fillMaterials(); }
      }
      if (m) for (const i of this.selected) this.parts[i].material = m;
      matSel.value = '';
      this.refresh();
    });
    $('#ws-fill-set', R).addEventListener('click', () => {
      const f = parseFloat($<HTMLInputElement>('#ws-fill', R).value);
      if (!(f > 0 && f <= 100)) return;
      for (const i of this.selected) this.parts[i].fill = f / 100;
      this.refresh();
    });
    $('#ws-mass-set', R).addEventListener('click', () => {
      const g = parseFloat($<HTMLInputElement>('#ws-massg', R).value);
      const sel = [...this.selected].map((i) => this.parts[i]);
      if (!(g >= 0) || !sel.length) return;
      const vol = sel.reduce((s, p) => s + p.vol, 0);      // a total for several parts is split by volume
      for (const p of sel) p.massKg = (g / 1000) * (vol > 0 ? p.vol / vol : 1 / sel.length);
      $<HTMLInputElement>('#ws-massg', R).value = '';
      this.refresh();
    });
    $('#ws-mass-clear', R).addEventListener('click', () => { for (const i of this.selected) this.parts[i].massKg = null; this.refresh(); });
    $('#ws-collide-on', R).addEventListener('click', () => { for (const i of this.selected) this.parts[i].collide = true; this.refresh(); });
    $('#ws-collide-off', R).addEventListener('click', () => { for (const i of this.selected) this.parts[i].collide = false; this.refresh(); });
    $('#ws-pivot', R).addEventListener('click', () => {
      if (!this.selected.size) return;
      const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
      for (const i of this.selected) {
        const p = this.parts[i];
        for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p.center[k] - p.size[k] / 2); hi[k] = Math.max(hi[k], p.center[k] + p.size[k] / 2); }
      }
      this.pivot = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec3;
      $('#ws-pivot-state', R).textContent = 'pivot: centre of selection';
      this.build();
    });
    $('#ws-pivot-clear', R).addEventListener('click', () => { this.pivot = null; $('#ws-pivot-state', R).textContent = 'pivot: weapon centre of mass'; this.build(); });
    $('#ws-colorby', R).addEventListener('change', (e) => { this.colorByTag = (e.target as HTMLInputElement).checked; this.refresh(); });
    $<HTMLSelectElement>('#ws-wtype', R).addEventListener('change', (e) => this.weaponDefaults((e.target as HTMLSelectElement).value as WeaponType));
    $('#ws-target', R).addEventListener('input', () => this.renderSummary());
    $('#ws-cells', R).addEventListener('input', () => {
      const c = parseFloat($<HTMLInputElement>('#ws-cells', R).value);
      if (c > 0) $<HTMLInputElement>('#ws-volts', R).value = (c * V_CELL).toFixed(1);
      this.updateCalc();
    });
    for (const id of ['ws-volts', 'ws-wkv', 'ws-wratio', 'ws-dkv', 'ws-dratio']) $('#' + id, R).addEventListener('input', () => this.updateCalc());
    const buildBusy = async (what: string) => { busy(what); await paint(); try { return this.build(); } finally { done(); } };
    $('#ws-check', R).addEventListener('click', () => buildBusy('Checking the robot'));
    $('#ws-test', R).addEventListener('click', async () => { const r = await buildBusy('Building the robot'); if (r) this.onTest(r.def); });
    $('#ws-save', R).addEventListener('click', async () => {
      const r = await buildBusy('Building the robot file');
      if (r) download(saveBot(r.def), (r.def.name.replace(/[^\w-]+/g, '_') || 'robot') + '.bot');
    });
    $('#ws-remove', R).addEventListener('click', () => {
      if (!this.parts.length) return;
      const name = $<HTMLInputElement>('#ws-name', R).value.trim() || 'Imported robot';
      if (!confirm(`Remove "${name}"? This clears the workshop (tags, materials, settings) and drops it from the arena list. Saved .bot files are not touched.`)) return;
      this.clear();
      this.onRemove(name);
    });
    this.weaponDefaults('spinner');
  }
}

/** "3", "36/12", "3:1", "5.2*36/16", "4 x 2.5" -> reduction (motor turns per output turn); NaN if invalid. */
export function parseRatio(s: string): number {
  const terms = s.trim().replace(/[x×]/gi, '*').split('*');
  let r = 1;
  for (const t of terms) {
    const m = t.trim().match(/^(\d*\.?\d+)\s*(?:[:/]\s*(\d*\.?\d+))?$/);
    if (!m) return NaN;
    r *= parseFloat(m[1]) / (m[2] ? parseFloat(m[2]) : 1);
  }
  return r;
}

const derivedOf = (r: BuildResult) => {
  const d = r.def, D = derive(d);
  return { tipRadius: D.tipRadius, weaponJ: D.weaponJ, wheelR: Math.max(0, ...d.wheels.map((w) => w.radius)) };
};

function tagLabel(t: Tag): string {
  return t === 'chassis' ? 'chassis' : t === 'weapon' ? 'weapon' : t === 'ignore' ? 'ignore' : 'wheel ' + t.slice(5);
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

let worker: Worker | null = null;
function parseCad(buf: ArrayBuffer, ext: string, deflection: number): Promise<RawPart[]> {
  worker ??= new Worker(new URL('occt/step-worker.js', document.baseURI));
  return new Promise((resolve, reject) => {
    worker!.onmessage = (e) => (e.data.ok ? resolve(e.data.parts as RawPart[]) : reject(new Error(e.data.error)));
    worker!.onerror = (e) => reject(new Error(e.message || 'STEP worker failed'));
    worker!.postMessage({ buf, ext, deflection }, [buf]);
  });
}

function textSprite(text: string, color: number): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.font = 'bold 36px system-ui, sans-serif';
  g.fillStyle = '#' + color.toString(16).padStart(6, '0');
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 32);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(0.16, 0.04, 1);
  return s;
}

export { WHEEL_TAGS };
