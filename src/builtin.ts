// Built-in featherweights made of boxes and cylinders: one per weapon type.
// All specs are guesses in the same spirit as the desktop sim's procedural robots.
import type { Electrics, Part, RobotDef, Vec3, Wheel, WeaponDef } from './types';

const STEEL: Vec3 = [0.72, 0.74, 0.78], DARK: Vec3 = [0.12, 0.12, 0.13], TYRE: Vec3 = [0.08, 0.08, 0.08];

function box(name: string, body: string, lo: Vec3, hi: Vec3, mass: number, color: Vec3, collide = true): Part {
  return {
    name, body, color, collide, mass,
    prim: { type: 'box', pos: [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec3, size: [0, 1, 2].map((k) => Math.abs(hi[k] - lo[k]) / 2) as Vec3 },
  };
}

function cylX(name: string, body: string, c: Vec3, r: number, len: number, mass: number, color: Vec3, collide = true): Part {
  return { name, body, color, collide, mass, prim: { type: 'cylinder', radius: r, pos: c, fromto: [c[0] - len / 2, c[1], c[2], c[0] + len / 2, c[1], c[2]] } };
}

function wheels(list: [number, number, number, number][], mass: number): { parts: Part[]; wheels: Wheel[] } {
  // [x, y, radius, width]; centre height = radius so the robot stands on z = 0
  const parts: Part[] = [], ws: Wheel[] = [];
  list.forEach(([x, y, r, w], i) => {
    ws.push({ center: [x, y, r], axis: [1, 0, 0], radius: r, width: w });
    parts.push(cylX(`Wheel ${i + 1}`, 'wheel' + i, [x, y, r], r, w, mass, TYRE, false));
  });
  return { parts, wheels: ws };
}

const drive = (topSpeed: number, motorsPerSide = 1): Electrics['drive'] =>
  ({ kv: 1000, r: 0.05, iLimit: 40, rotorJ: 2e-5, topSpeed, motorsPerSide });

function robot(name: string, parts: Part[], W: { parts: Part[]; wheels: Wheel[] }, weapon: WeaponDef, elec: Electrics): RobotDef {
  return { format: 'botsim-robot', version: 1, name, parts: [...parts, ...W.parts], wheels: W.wheels, weapon, elec, tyreMu: 1.0, bodyMu: 0.4 };
}

function vert(): RobotDef {
  const PINK: Vec3 = [0.93, 0.25, 0.6];
  const W = wheels([[-0.185, -0.095, 0.042, 0.026], [-0.185, -0.01, 0.038, 0.026], [0.185, -0.095, 0.042, 0.026], [0.185, -0.01, 0.038, 0.026]], 0.15);
  const piv: Vec3 = [0, 0.075, 0.15];
  const parts = [
    box('Base plate', 'chassis', [-0.165, -0.13, 0.012], [0.165, 0.035, 0.018], 1.4, DARK),
    box('Top plate', 'chassis', [-0.165, -0.13, 0.085], [0.165, 0.035, 0.09], 0.9, PINK),
    box('Electronics', 'chassis', [-0.12, -0.12, 0.02], [0.12, 0.02, 0.08], 3.0, DARK),
    box('Pod L', 'chassis', [-0.2, -0.14, 0.012], [-0.165, 0.035, 0.09], 0.7, DARK),
    box('Pod R', 'chassis', [0.165, -0.14, 0.012], [0.2, 0.035, 0.09], 0.7, DARK),
    box('Weapon plate L', 'chassis', [-0.024, -0.02, 0.012], [-0.012, 0.11, 0.17], 0.45, PINK),
    box('Weapon plate R', 'chassis', [0.012, -0.02, 0.012], [0.024, 0.11, 0.17], 0.45, PINK),
    box('Plough', 'chassis', [-0.1, 0.035, 0.004], [0.1, 0.24, 0.012], 0.6, PINK),
    cylX('Disc', 'weapon', piv, 0.11, 0.012, 3.5, STEEL),
    box('Tooth', 'weapon', [-0.006, 0.075 + 0.1, 0.15 - 0.01], [0.006, 0.075 + 0.136, 0.15 + 0.025], 0.25, STEEL),
    box('Counterweight', 'weapon', [-0.006, 0.075 - 0.11, 0.15 - 0.02], [0.006, 0.075 - 0.08, 0.15 + 0.02], 0.25, STEEL),
  ];
  return robot('Wide vert', parts, W, { type: 'spinner', pivot: piv, axis: [1, 0, 0] },
    { cells: 6, rBatt: 0.012, drive: drive(4.2, 1), weapon: { kv: 600, r: 0.025, iLimit: 130, rotorJ: 6e-5, tipSpeed: 85 } });
}

function drum(): RobotDef {
  const BLUE: Vec3 = [0.2, 0.45, 0.9];
  // wheels taller than the body and the drum: it drives on upside down
  const W = wheels([[-0.215, -0.13, 0.08, 0.03], [-0.215, 0.04, 0.08, 0.03], [0.215, -0.13, 0.08, 0.03], [0.215, 0.04, 0.08, 0.03]], 0.18);
  const piv: Vec3 = [0, 0.15, 0.08];      // centred between the wheel tops and bottoms: works both ways up
  const parts = [
    box('Base plate', 'chassis', [-0.15, -0.18, 0.012], [0.15, 0.1, 0.018], 1.5, DARK),
    box('Top plate', 'chassis', [-0.15, -0.18, 0.09], [0.15, 0.1, 0.095], 0.9, BLUE),
    box('Electronics', 'chassis', [-0.12, -0.17, 0.02], [0.12, 0.08, 0.085], 3.2, DARK),
    box('Side rail L', 'chassis', [-0.2, -0.19, 0.01], [-0.185, 0.2, 0.1], 0.8, BLUE),
    box('Side rail R', 'chassis', [0.185, -0.19, 0.01], [0.2, 0.2, 0.1], 0.8, BLUE),
    box('Rear wall', 'chassis', [-0.185, -0.2, 0.01], [0.185, -0.18, 0.1], 0.6, DARK),
    cylX('Drum', 'weapon', piv, 0.05, 0.3, 3.4, STEEL),
    box('Tooth A', 'weapon', [-0.13, 0.15 - 0.012, 0.08 + 0.04], [-0.07, 0.15 + 0.012, 0.08 + 0.07], 0.2, STEEL),
    box('Tooth B', 'weapon', [0.07, 0.15 - 0.012, 0.08 - 0.07], [0.13, 0.15 + 0.012, 0.08 - 0.04], 0.2, STEEL),
  ];
  return robot('Drum', parts, W, { type: 'drum', pivot: piv, axis: [1, 0, 0] },
    { cells: 6, rBatt: 0.012, drive: drive(4.5, 1), weapon: { kv: 1000, r: 0.02, iLimit: 50, rotorJ: 4e-5, tipSpeed: 52 } });
}

function lifter(): RobotDef {
  const ORANGE: Vec3 = [0.95, 0.55, 0.12];
  const W = wheels([[-0.17, -0.12, 0.05, 0.035], [-0.17, 0.04, 0.05, 0.035], [0.17, -0.12, 0.05, 0.035], [0.17, 0.04, 0.05, 0.035]], 0.18);
  const piv: Vec3 = [0, -0.11, 0.115];
  const parts = [
    box('Base plate', 'chassis', [-0.15, -0.2, 0.012], [0.15, 0.12, 0.018], 1.6, DARK),
    box('Electronics', 'chassis', [-0.12, -0.19, 0.02], [0.12, 0.1, 0.09], 4.2, DARK),
    box('Side rail L', 'chassis', [-0.215, -0.2, 0.01], [-0.2, 0.15, 0.11], 1.0, ORANGE),
    box('Side rail R', 'chassis', [0.2, -0.2, 0.01], [0.215, 0.15, 0.11], 1.0, ORANGE),
    box('Arm L', 'weapon', [-0.15, -0.12, 0.105], [-0.13, 0.18, 0.125], 0.6, ORANGE),
    box('Arm R', 'weapon', [0.13, -0.12, 0.105], [0.15, 0.18, 0.125], 0.6, ORANGE),
    box('Lid', 'weapon', [-0.13, -0.12, 0.118], [0.13, 0.17, 0.124], 0.8, ORANGE),
    box('Forks', 'weapon', [-0.15, 0.17, 0.004], [0.15, 0.27, 0.014], 0.9, STEEL),
    box('Fork posts', 'weapon', [-0.15, 0.16, 0.004], [0.15, 0.185, 0.125], 0.6, STEEL),
  ];
  // 150 deg of travel: enough to push itself back over when it lands upside down
  return robot('Lifter', parts, W, { type: 'lifter', pivot: piv, axis: [1, 0, 0], rangeDeg: [0, 150] },
    { cells: 6, rBatt: 0.012, drive: drive(4.2, 1), weapon: { kv: 1000, r: 0.05, iLimit: 80, rotorJ: 2e-5, armDps: 400 } });
}

function hammer(): RobotDef {
  const GREEN: Vec3 = [0.3, 0.75, 0.3];
  const W = wheels([[-0.17, -0.08, 0.05, 0.035], [-0.17, 0.08, 0.05, 0.035], [0.17, -0.08, 0.05, 0.035], [0.17, 0.08, 0.05, 0.035]], 0.18);
  const piv: Vec3 = [0, 0, 0.15];
  const parts = [
    box('Base plate', 'chassis', [-0.15, -0.16, 0.012], [0.15, 0.16, 0.018], 1.5, DARK),
    box('Electronics', 'chassis', [-0.12, -0.15, 0.02], [0.12, 0.15, 0.1], 4.5, DARK),
    box('Side rail L', 'chassis', [-0.215, -0.17, 0.01], [-0.2, 0.17, 0.11], 0.9, GREEN),
    box('Side rail R', 'chassis', [0.2, -0.17, 0.01], [0.215, 0.17, 0.11], 0.9, GREEN),
    box('Front wedge', 'chassis', [-0.2, 0.16, 0.004], [0.2, 0.22, 0.02], 0.7, GREEN),
    box('Pivot towers', 'chassis', [-0.04, -0.02, 0.1], [0.04, 0.02, 0.15], 0.6, DARK),
    box('Hammer arm', 'weapon', [-0.012, -0.36, 0.14], [0.012, 0.0, 0.16], 0.6, STEEL),
    box('Hammer head', 'weapon', [-0.05, -0.4, 0.125], [0.05, -0.34, 0.185], 1.3, STEEL),
  ];
  // axis -X: + travel swings the head up from the back and over onto the front
  // 200 deg: the head carries on into the floor (or the opponent) instead of slamming into a stop in mid air,
  // and 1100 deg/s is about as fast as this chassis can swing it without flipping itself over
  return robot('Hammer', parts, W, { type: 'hammer', pivot: piv, axis: [-1, 0, 0], rangeDeg: [0, 200] },
    { cells: 6, rBatt: 0.012, drive: drive(4.2, 1), weapon: { kv: 500, r: 0.03, iLimit: 90, rotorJ: 6e-5, armDps: 1100 } });
}

export const BUILTINS: RobotDef[] = [vert(), drum(), lifter(), hammer()];
