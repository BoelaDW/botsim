// Three.js view of the arena: robot bodies follow MuJoCo's body poses each frame.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ARENA, WALL_H } from './build';
import type { Sim } from './sim';
import type { Part, RobotDef } from './types';

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);       // MuJoCo is Z-up
const SHARED = new THREE.MeshBasicMaterial();   // placeholder while building merged geometry

export function partObject(p: Part, mat?: THREE.Material): THREE.Mesh {
  const material = mat ?? new THREE.MeshStandardMaterial({ color: new THREE.Color(...p.color), metalness: 0.35, roughness: 0.55 });
  let geo: THREE.BufferGeometry;
  if (p.mesh) {
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p.mesh.pos, 3));
    geo.setIndex(new THREE.BufferAttribute(p.mesh.idx, 1));
    geo.computeVertexNormals();
  } else {
    const q = p.prim!;
    if (q.type === 'box') {
      geo = new THREE.BoxGeometry(q.size![0] * 2, q.size![1] * 2, q.size![2] * 2);
      geo.translate(...q.pos);
    } else if (q.type === 'sphere') {
      geo = new THREE.SphereGeometry(q.radius!, 24, 16);
      geo.translate(...q.pos);
    } else {
      const f = q.fromto!;
      const a = new THREE.Vector3(f[0], f[1], f[2]), b = new THREE.Vector3(f[3], f[4], f[5]);
      geo = new THREE.CylinderGeometry(q.radius!, q.radius!, a.distanceTo(b), 32);   // along +Y
      const dir = b.clone().sub(a).normalize();
      geo.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir));
      geo.translate(...a.clone().add(b).multiplyScalar(0.5).toArray());
    }
  }
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

export class ArenaView {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  groups: { group: THREE.Group; body: number }[] = [];
  robotRoot = new THREE.Group();
  dummy: THREE.Mesh | null = null;
  follow = 0;               // 0 = free orbit, 1 = follow P1, 2 = follow P2

  constructor(public canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(0x14161a);
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.02, 100);
    this.camera.position.set(0, -4.6, 3.4);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.target.set(0, 0, 0);
    this.controls.maxPolarAngle = Math.PI * 0.49;

    this.scene.add(new THREE.HemisphereLight(0xdde4ff, 0x30302a, 1.1));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(2, -3, 8);
    sun.castShadow = true;
    sun.shadow.mapSize.set(4096, 4096);
    const s = ARENA / 2 + 0.5;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 20 });
    sun.shadow.bias = -0.0005;
    this.scene.add(sun);

    const h = ARENA / 2;
    const floorTex = checker();
    floorTex.repeat.set(8, 8);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(ARENA, ARENA), new THREE.MeshStandardMaterial({ map: floorTex, roughness: 0.9 }));
    floor.receiveShadow = true;
    this.scene.add(floor);
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x9aa0ad, transparent: true, opacity: 0.22, depthWrite: false });
    for (const [x, y, sx, sy] of [[0, h, ARENA, 0.1], [0, -h, ARENA, 0.1], [h, 0, 0.1, ARENA], [-h, 0, 0.1, ARENA]]) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, 0.6), wallMat);
      w.position.set(x, y, 0.3);
      this.scene.add(w);
    }
    // the polycarbonate enclosure above the kick plates: just its edges, so the camera can see in
    const box = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(ARENA, ARENA, WALL_H)),
      new THREE.LineBasicMaterial({ color: 0x9aa0ad, transparent: true, opacity: 0.35 }));
    box.position.z = WALL_H / 2;
    this.scene.add(box);
    this.scene.add(this.robotRoot);
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Remove all robot meshes. */
  clear() {
    for (const g of this.groups) g.group.traverse((o) => { if (o instanceof THREE.Mesh) { o.geometry.dispose(); (o.material as THREE.Material).dispose(); } });
    this.robotRoot.clear();
    this.groups = [];
  }

  /** Rebuild robot meshes for a new scene. */
  load(sim: Sim, defs: RobotDef[]) {
    this.clear();
    sim.bots.forEach((bot, i) => {
      const def = defs[i];
      for (const [name, body] of Object.entries(bot.bodyIds)) {
        const group = new THREE.Group();
        const o = bot.D.origin[name];
        // one mesh per colour per body: thousands of separate parts would be thousands of draw calls
        const byColor = new Map<string, THREE.BufferGeometry[]>();
        for (const p of def.parts) if (p.body === name) {
          const g = partObject(p, SHARED).geometry;
          (g.index ? g : g.setIndex([...Array(g.getAttribute('position').count).keys()]));
          for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
          const key = p.color.map((c) => c.toFixed(3)).join(',');
          byColor.set(key, [...(byColor.get(key) ?? []), g]);
        }
        for (const [key, geos] of byColor) {
          const merged = mergeGeometries(geos, false) ?? geos[0];
          if (merged !== geos[0] || geos.length > 1) geos.forEach((g) => g !== merged && g.dispose());
          const m = new THREE.Mesh(merged, new THREE.MeshStandardMaterial({ color: new THREE.Color(...key.split(',').map(Number) as [number, number, number]), metalness: 0.35, roughness: 0.55 }));
          m.castShadow = m.receiveShadow = true;
          m.position.set(-o[0], -o[1], -o[2]);
          group.add(m);
        }
        this.robotRoot.add(group);
        this.groups.push({ group, body });
      }
    });
    const di = sim.mj.mj_name2id(sim.m, sim.mj.mjtObj.mjOBJ_BODY.value, 'dummy');
    if (di >= 0) {
      const g = new THREE.Group();
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.44, 0.12), new THREE.MeshStandardMaterial({ color: 0xb3732a }));
      m.castShadow = m.receiveShadow = true;
      g.add(m);
      this.robotRoot.add(g);
      this.groups.push({ group: g, body: di });
    }
  }

  draw(sim: Sim | null) {
    if (sim) {
      const xpos = sim.d.xpos, xquat = sim.d.xquat;
      for (const { group, body } of this.groups) {
        group.position.set(xpos[body * 3], xpos[body * 3 + 1], xpos[body * 3 + 2]);
        group.quaternion.set(xquat[body * 4 + 1], xquat[body * 4 + 2], xquat[body * 4 + 3], xquat[body * 4]);
      }
      const bot = sim.bots[this.follow - 1];
      if (bot) {
        const b = bot.chassis * 3;
        const t = new THREE.Vector3(xpos[b], xpos[b + 1], xpos[b + 2]);
        const delta = t.clone().sub(this.controls.target);
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}

function checker(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#54565b'; g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#46484d'; g.fillRect(0, 0, 128, 128); g.fillRect(128, 128, 128, 128);
  g.strokeStyle = '#80803a'; g.lineWidth = 2; g.strokeRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
