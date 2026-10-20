// Robot definition: what the Workshop produces and the Arena loads (a ".bot" file).
// Units: metres, kg. Robot frame: +Y = front, +Z = up, X = right; z = 0 is the floor.

export type Vec3 = [number, number, number];

export type WeaponType = 'spinner' | 'drum' | 'lifter' | 'hammer';

export interface Prim {
  type: 'box' | 'cylinder' | 'sphere';
  pos: Vec3;                 // box / sphere centre
  size?: Vec3;               // box half sizes
  fromto?: [number, number, number, number, number, number]; // cylinder ends
  radius?: number;           // cylinder / sphere
}

export interface MeshData {
  pos: Float32Array;         // xyz triplets, robot frame
  idx: Uint32Array;          // triangles
}

export interface Part {
  name: string;
  body: string;              // 'chassis' | 'weapon' | 'wheel0', 'wheel1', ...
  color: Vec3;
  collide: boolean;
  mass: number;              // kg
  mesh?: MeshData;
  prim?: Prim;
}

export interface Wheel {
  center: Vec3;
  axis: Vec3;                // unit, points to +X
  radius: number;
  width: number;
}

export interface WeaponDef {
  type: WeaponType;
  pivot: Vec3;
  axis: Vec3;                // + spin / + arm travel is right-handed about this
  rangeDeg?: [number, number];   // lifter / hammer travel
}

export interface MotorSpec {
  kv: number;
  r: number;                 // ohm
  iLimit: number;            // A (ESC limit)
  rotorJ: number;            // kg m^2
}

export interface Electrics {
  cells: number;             // LiPo S count
  volts?: number;            // battery voltage; default cells x 3.7
  driveVolts?: number;       // separate drive battery (unset = the drive runs off the main battery)
  rBatt: number;             // ohm
  // ratio = gear / pulley reduction (motor turns per wheel or weapon turn). Older files give a
  // no-load speed instead (topSpeed m/s, tipSpeed m/s, armDps deg/s) and the ratio is worked out from it.
  drive: MotorSpec & { motorsPerSide: number; ratio?: number; topSpeed?: number };
  weapon: MotorSpec & { ratio?: number; tipSpeed?: number; armDps?: number };
}

export interface RobotDef {
  format: 'botsim-robot';
  version: 1;
  name: string;
  author?: string;
  description?: string;
  parts: Part[];
  wheels: Wheel[];
  weapon: WeaponDef;
  elec: Electrics;
  tyreMu: number;
  bodyMu: number;
}

export const FEATHERWEIGHT_KG = 13.6;
