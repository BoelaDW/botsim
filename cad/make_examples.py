# Parametric FreeCAD models of BotSim's example robots.
#
# Every robot is one .FCStd file with a VarSet called "Params": change a value there, recompute
# (Ctrl+R) and the parts follow, because their sizes and positions are expressions on those values.
# Units are mm. Robot frame: X right, Y forward, Z up, the floor at Z = 0 (wheel bottoms).
#
# Make the files (won't overwrite a file you've edited unless FORCE=1):
#   freecad -c "exec(open('cad/make_examples.py').read())" </dev/null
# Then `npm run examples` exports STEP and rebuilds the arena robots (tags and motors: cad/examples.json).
import os
import FreeCAD as App
import Part  # noqa: F401  (registers the Part primitives)
from FreeCAD import Rotation, Vector

HERE = os.path.join(os.getcwd(), 'cad')
OUT = os.path.join(HERE, 'examples')
FORCE = os.environ.get('FORCE') == '1'
ONLY = os.environ.get('ONLY')


class X:
    """A number written as a FreeCAD expression, so arithmetic on parameters stays parametric."""
    def __init__(self, t): self.t = t
    def __add__(a, b): return X(f'({a.t} + {ex(b)})')
    def __radd__(a, b): return X(f'({ex(b)} + {a.t})')
    def __sub__(a, b): return X(f'({a.t} - {ex(b)})')
    def __rsub__(a, b): return X(f'({ex(b)} - {a.t})')
    def __mul__(a, b): return X(f'({a.t} * {ex(b)})')
    def __rmul__(a, b): return X(f'({ex(b)} * {a.t})')
    def __truediv__(a, b): return X(f'({a.t} / {ex(b)})')
    def __neg__(a): return X(f'(-{a.t})')


def ex(v):
    return v.t if isinstance(v, X) else repr(float(v))


class Robot:
    def __init__(self, name, title, params):
        self.name = name
        self.doc = App.newDocument(name)
        self.doc.Label = title
        vs = self.doc.addObject('App::VarSet', 'Params')
        vs.Label = 'Params'
        self.p = {}
        for key, (value, group, doc) in params.items():
            vs.addProperty('App::PropertyFloat', key, group, doc)
            setattr(vs, key, float(value))
            self.p[key] = X(f'Params.{key}')
        self.parts = []

    def __getattr__(self, k):
        if k in self.__dict__.get('p', {}):
            return self.p[k]
        raise AttributeError(k)

    def _place(self, o, base):
        for axis, v in zip('xyz', base):
            o.setExpression(f'.Placement.Base.{axis}', ex(v))

    def box(self, label, x0, y0, z0, x1, y1, z1, keep=True):
        o = self.doc.addObject('Part::Box', 'Box')
        o.Label = label
        o.setExpression('Length', ex(x1 - x0) if isinstance(x1, X) or isinstance(x0, X) else repr(float(x1 - x0)))
        o.setExpression('Width', ex(y1 - y0) if isinstance(y1, X) or isinstance(y0, X) else repr(float(y1 - y0)))
        o.setExpression('Height', ex(z1 - z0) if isinstance(z1, X) or isinstance(z0, X) else repr(float(z1 - z0)))
        self._place(o, (x0, y0, z0))
        if keep: self.parts.append(o)
        return o

    def cyl(self, label, axis, c, r, length, keep=True, tilt=0.0):
        """Cylinder of radius r and length `length` centred on c, along axis 'x', 'y' or 'z'.
        tilt (degrees, fixed): camber for an 'x' cylinder, the end at +X dropping."""
        o = self.doc.addObject('Part::Cylinder', 'Cylinder')
        o.Label = label
        o.setExpression('Radius', ex(r))
        o.setExpression('Height', ex(length))
        import math
        if axis == 'x':
            o.Placement.Rotation = Rotation(Vector(0, 1, 0), 90 + tilt)
            ca, sa = math.cos(math.radians(tilt)), math.sin(math.radians(tilt))
            base = (c[0] - length / 2 * ca, c[1], c[2] + length / 2 * sa)
        elif axis == 'y':
            o.Placement.Rotation = Rotation(Vector(1, 0, 0), -90)
            base = (c[0], c[1] - length / 2, c[2])
        else:
            base = (c[0], c[1], c[2] - length / 2)
        self._place(o, base)
        if keep: self.parts.append(o)
        return o

    def cut(self, label, outer, inner):
        o = self.doc.addObject('Part::Cut', 'Cut')
        o.Label = label
        o.Base, o.Tool = outer, inner
        self.parts.append(o)
        return o

    def tube(self, label, axis, c, r_out, r_in, length):
        return self.cut(label, self.cyl(label + ' outer', axis, c, r_out, length, keep=False),
                        self.cyl(label + ' bore', axis, c, r_in, length + 2, keep=False))

    def wheel(self, label, x, y, r, w, tilt=0.0):
        """Wheel on an axle along X, standing on the floor."""
        return self.cyl(label, 'x', (x, y, r), r, w, tilt=tilt)

    def save(self):
        self.doc.recompute()
        bad = [o.Label for o in self.doc.Objects if hasattr(o, 'Shape') and (o.Shape.isNull() or not o.Shape.isValid())]
        if bad: print('WARNING invalid shapes in', self.name, bad)
        path = os.path.join(OUT, self.name + '.FCStd')
        if os.path.exists(path) and not FORCE:
            print('kept', path, '(exists; FORCE=1 to overwrite)')
        else:
            self.doc.saveAs(path)
            print('wrote', path, len(self.parts), 'parts')
        App.closeDocument(self.name)


P = lambda v, g, d: (v, g, d)   # noqa: E731


def wide_vert():
    r = Robot('wide_vert', 'Wide vert', {
        'BodyHalfWidth': P(165, 'Body', 'half width of the plates'), 'BodyFront': P(35, 'Body', 'front edge Y'),
        'BodyRear': P(-130, 'Body', 'rear edge Y'), 'BodyHeight': P(90, 'Body', 'top of the lid'),
        'PlateZ': P(12, 'Body', 'underside of the base plate'), 'PodWidth': P(35, 'Body', 'wheel pod width'),
        'PloughLength': P(205, 'Body', 'plough length in front of the body'),
        'DiscRadius': P(110, 'Weapon', ''), 'DiscThickness': P(12, 'Weapon', ''), 'PivotY': P(75, 'Weapon', ''),
        'PivotZ': P(150, 'Weapon', 'disc axle height'), 'ToothLength': P(36, 'Weapon', 'how far the tooth sticks out'),
        'UprightGap': P(12, 'Weapon', 'gap either side of the disc'), 'UprightThickness': P(12, 'Weapon', ''),
        'TrackX': P(185, 'Wheels', 'wheel centre X'), 'RearWheelR': P(42, 'Wheels', ''), 'FrontWheelR': P(38, 'Wheels', ''),
        'WheelWidth': P(26, 'Wheels', ''), 'RearWheelY': P(-95, 'Wheels', ''), 'FrontWheelY': P(-10, 'Wheels', '')})
    W, F, B, H, Z = r.BodyHalfWidth, r.BodyFront, r.BodyRear, r.BodyHeight, r.PlateZ
    r.box('Base plate', -W, B, Z, W, F, Z + 6)
    r.box('Top plate', -W, B, H - 5, W, F, H)
    r.box('Electronics', -W + 45, B + 10, Z + 8, W - 45, F - 15, H - 10)
    r.box('Pod L', -W - r.PodWidth, B - 10, Z, -W, F, H)
    r.box('Pod R', W, B - 10, Z, W + r.PodWidth, F, H)
    g, t = r.UprightGap, r.UprightThickness
    r.box('Weapon upright L', -g - t, -20, Z, -g, r.PivotY + 35, r.PivotZ + 20)
    r.box('Weapon upright R', g, -20, Z, g + t, r.PivotY + 35, r.PivotZ + 20)
    r.box('Plough', -100, F, 4, 100, F + r.PloughLength, 12)
    r.cyl('Disc', 'x', (0, r.PivotY, r.PivotZ), r.DiscRadius, r.DiscThickness)
    d = r.DiscThickness / 2
    r.box('Disc tooth', -d, r.PivotY + r.DiscRadius - 10, r.PivotZ - 10, d, r.PivotY + r.DiscRadius + r.ToothLength - 10, r.PivotZ + 25)
    r.box('Disc counterweight', -d, r.PivotY - r.DiscRadius, r.PivotZ - 20, d, r.PivotY - r.DiscRadius + 30, r.PivotZ + 20)
    r.cyl('Weapon axle', 'x', (0, r.PivotY, r.PivotZ), 8, g * 2 + t * 2)
    for side, s in (('L', -1), ('R', 1)):
        r.wheel(f'Wheel rear {side}', s * r.TrackX, r.RearWheelY, r.RearWheelR, r.WheelWidth)
        r.wheel(f'Wheel front {side}', s * r.TrackX, r.FrontWheelY, r.FrontWheelR, r.WheelWidth)
    r.save()


def drum():
    r = Robot('drum', 'Drum', {
        'BodyHalfWidth': P(140, 'Body', ''), 'BodyFront': P(100, 'Body', ''), 'BodyRear': P(-150, 'Body', ''),
        'BodyHeight': P(95, 'Body', 'top of the lid'), 'PlateZ': P(12, 'Body', ''), 'RailX': P(185, 'Body', 'inside of the side rails'),
        'RailFront': P(190, 'Body', 'side rails reach this far forward to carry the drum'),
        'DrumRadius': P(50, 'Weapon', ''), 'DrumBore': P(45, 'Weapon', 'inside of the drum tube (wall = radius - bore)'),
        'DrumLength': P(230, 'Weapon', ''), 'PivotY': P(150, 'Weapon', ''),
        'PivotZ': P(80, 'Weapon', 'keep it half the wheel diameter: the robot works both ways up'),
        'ToothReach': P(70, 'Weapon', 'tooth tip radius'),
        'TrackX': P(215, 'Wheels', ''), 'WheelR': P(80, 'Wheels', 'taller than body and drum: invertible'),
        'WheelWidth': P(30, 'Wheels', ''), 'RearWheelY': P(-130, 'Wheels', ''), 'FrontWheelY': P(40, 'Wheels', '')})
    W, F, B, H, Z = r.BodyHalfWidth, r.BodyFront, r.BodyRear, r.BodyHeight, r.PlateZ
    r.box('Base plate', -W, B, Z, W, F, Z + 6)
    r.box('Top plate', -W, B, H - 5, W, F, H)
    r.box('Electronics', -W + 30, B + 10, Z + 8, W - 30, F - 20, H - 10)
    r.box('Side rail L', -r.RailX - 15, B - 10, Z - 2, -r.RailX, r.RailFront, H + 5)
    r.box('Side rail R', r.RailX, B - 10, Z - 2, r.RailX + 15, r.RailFront, H + 5)
    r.box('Rear wall', -r.RailX, B - 20, Z - 2, r.RailX, B, H + 5)
    r.tube('Drum', 'x', (0, r.PivotY, r.PivotZ), r.DrumRadius, r.DrumBore, r.DrumLength)
    r.cyl('Drum axle', 'x', (0, r.PivotY, r.PivotZ), 10, r.RailX * 2)
    L2 = r.DrumLength / 2
    r.box('Drum tooth A', -L2, r.PivotY - 12, r.PivotZ + 40, -L2 + 60, r.PivotY + 12, r.PivotZ + r.ToothReach)
    r.box('Drum tooth B', L2 - 60, r.PivotY - 12, r.PivotZ - r.ToothReach, L2, r.PivotY + 12, r.PivotZ - 40)
    for side, s in (('L', -1), ('R', 1)):
        r.wheel(f'Wheel rear {side}', s * r.TrackX, r.RearWheelY, r.WheelR, r.WheelWidth)
        r.wheel(f'Wheel front {side}', s * r.TrackX, r.FrontWheelY, r.WheelR, r.WheelWidth)
    r.save()


def lifter():
    r = Robot('lifter', 'Lifter', {
        'BodyHalfWidth': P(150, 'Body', ''), 'BodyFront': P(120, 'Body', ''), 'BodyRear': P(-180, 'Body', ''),
        'BodyHeight': P(110, 'Body', 'side rail height'), 'PlateZ': P(12, 'Body', ''),
        'PivotY': P(-110, 'Weapon', 'lid hinge, near the back'), 'PivotZ': P(115, 'Weapon', ''),
        'ForkLength': P(100, 'Weapon', 'forks in front of the posts'), 'ForkZ': P(4, 'Weapon', 'fork underside above the floor'),
        'TrackX': P(170, 'Wheels', ''), 'WheelR': P(50, 'Wheels', ''), 'WheelWidth': P(35, 'Wheels', ''),
        'RearWheelY': P(-120, 'Wheels', ''), 'FrontWheelY': P(40, 'Wheels', '')})
    W, F, B, H, Z = r.BodyHalfWidth, r.BodyFront, r.BodyRear, r.BodyHeight, r.PlateZ
    r.box('Base plate', -W, B, Z, W, F, Z + 6)
    r.box('Electronics', -W + 30, B + 10, Z + 8, W - 30, F - 20, H - 20)
    r.box('Side rail L', -W - 65, B, Z - 2, -W - 50, F + 30, H)
    r.box('Side rail R', W + 50, B, Z - 2, W + 65, F + 30, H)
    r.cyl('Lifter pivot shaft', 'x', (0, r.PivotY, r.PivotZ), 8, W * 2 + 100)
    r.box('Arm L', -W, r.PivotY - 10, r.PivotZ - 10, -W + 20, F + 60, r.PivotZ + 10)
    r.box('Arm R', W - 20, r.PivotY - 10, r.PivotZ - 10, W, F + 60, r.PivotZ + 10)
    r.box('Lid', -W + 20, r.PivotY - 10, r.PivotZ + 3, W - 20, F + 50, r.PivotZ + 9)
    r.box('Fork posts', -W, F + 40, r.ForkZ, W, F + 50, r.PivotZ + 10)
    r.box('Forks', -W, F + 50, r.ForkZ, W, F + 50 + r.ForkLength, r.ForkZ + 10)
    for side, s in (('L', -1), ('R', 1)):
        r.wheel(f'Wheel rear {side}', s * r.TrackX, r.RearWheelY, r.WheelR, r.WheelWidth)
        r.wheel(f'Wheel front {side}', s * r.TrackX, r.FrontWheelY, r.WheelR, r.WheelWidth)
    r.save()


def hammer():
    r = Robot('hammer', 'Hammer', {
        'BodyHalfWidth': P(150, 'Body', ''), 'BodyLength': P(290, 'Body', ''), 'BodyHeight': P(110, 'Body', ''),
        'PlateZ': P(12, 'Body', ''), 'WedgeLength': P(60, 'Body', 'flat scoop in front'),
        'PivotZ': P(150, 'Weapon', 'hammer pivot height (pivot is at the robot centre)'),
        'ArmLength': P(360, 'Weapon', 'pivot to the head'), 'HeadWidth': P(100, 'Weapon', ''), 'HeadSize': P(60, 'Weapon', ''),
        'TrackX': P(170, 'Wheels', ''), 'WheelR': P(50, 'Wheels', ''), 'WheelWidth': P(35, 'Wheels', ''), 'WheelbaseY': P(80, 'Wheels', 'wheel centre Y (+/-)')})
    W, L, H, Z = r.BodyHalfWidth, r.BodyLength, r.BodyHeight, r.PlateZ
    r.box('Base plate', -W, -L / 2, Z, W, L / 2, Z + 6)
    r.box('Electronics', -W + 30, -L / 2 + 10, Z + 8, W - 30, L / 2 - 10, H - 10)
    r.box('Side rail L', -W - 65, -L / 2 - 10, Z - 2, -W - 50, L / 2 + 10, H)
    r.box('Side rail R', W + 50, -L / 2 - 10, Z - 2, W + 65, L / 2 + 10, H)
    r.box('Front wedge', -W - 50, L / 2, 4, W + 50, L / 2 + r.WedgeLength, 20)
    r.box('Pivot towers', -40, -20, H - 10, 40, 20, r.PivotZ)
    r.cyl('Hammer pivot shaft', 'x', (0, 0, r.PivotZ), 8, 100)
    r.box('Hammer arm', -12, -r.ArmLength, r.PivotZ - 10, 12, 0, r.PivotZ + 10)
    hw, hs = r.HeadWidth / 2, r.HeadSize
    r.box('Hammer head', -hw, -r.ArmLength - 40, r.PivotZ - hs / 2 - 5, hw, -r.ArmLength - 40 + hs, r.PivotZ + hs / 2 - 5)
    for side, s in (('L', -1), ('R', 1)):
        r.wheel(f'Wheel rear {side}', s * r.TrackX, -r.WheelbaseY, r.WheelR, r.WheelWidth)
        r.wheel(f'Wheel front {side}', s * r.TrackX, r.WheelbaseY, r.WheelR, r.WheelWidth)
    r.save()


def shell_shock():
    r = Robot('shell_shock', 'Shell Shock', {
        'ShellRadius': P(210, 'Weapon', 'outside of the shell'), 'ShellWall': P(15, 'Weapon', ''),
        'ShellHeight': P(60, 'Weapon', ''), 'ShellZ': P(12, 'Weapon', 'gap under the shell'), 'ToothLength': P(14, 'Weapon', ''),
        'PlateRadius': P(150, 'Body', ''), 'TrackX': P(115, 'Wheels', 'keep inside the shell'), 'WheelR': P(42, 'Wheels', 'reach above the lid: invertible'),
        'WheelY': P(75, 'Wheels', 'four wheels at +/- this: they scrub sideways if the chassis tries to spin with the shell'),
        'WheelWidth': P(20, 'Wheels', '')})
    R, Zs, Hs = r.ShellRadius, r.ShellZ, r.ShellHeight
    r.cyl('Chassis plate', 'z', (0, 0, 11), r.PlateRadius, 6)
    r.tube('Shell', 'z', (0, 0, Zs + Hs / 2), R, R - r.ShellWall, Hs)
    r.cyl('Shell lid', 'z', (0, 0, Zs + Hs + 2), R, 4)
    for name, s in (('Shell tooth A', 1), ('Shell tooth B', -1)):
        x0, x1 = (R - 5, R + r.ToothLength) if s > 0 else (-R - r.ToothLength, -R + 5)
        r.box(name, x0, -10, Zs + 3, x1, 10, Zs + Hs - 2)
    r.cyl('Bearing hub', 'z', (0, 0, 14 + 25), 30, 50)
    r.box('Battery', -60, -40, 14, 60, -10, 50)
    r.box('Electronics', -50, 20, 14, 50, 50, 40)
    r.box('Skid front', -20, 120, 3, 20, 140, 8)
    r.box('Skid rear', -20, -140, 3, 20, -120, 8)
    for side, s in (('L', -1), ('R', 1)):
        r.wheel(f'Wheel front {side}', s * r.TrackX, r.WheelY, r.WheelR, r.WheelWidth)
        r.wheel(f'Wheel rear {side}', s * r.TrackX, -r.WheelY, r.WheelR, r.WheelWidth)
    r.save()


def eggbeater():
    r = Robot('eggbeater', 'Eggbeater', {
        'BodyHalfWidth': P(150, 'Body', ''), 'BodyHalfLength': P(150, 'Body', ''), 'BodyHeight': P(94, 'Body', ''),
        'ForkLength': P(120, 'Body', 'forks reach past the body'),
        'BeaterWidth': P(120, 'Weapon', 'along the axle'), 'BeaterRadius': P(70, 'Weapon', 'hoop half height = tip radius'),
        'HoopBar': P(16, 'Weapon', 'hoop bar thickness'), 'PivotY': P(235, 'Weapon', ''), 'PivotZ': P(75, 'Weapon', ''),
        'TrackX': P(185, 'Wheels', ''), 'WheelR': P(45, 'Wheels', ''), 'WheelWidth': P(30, 'Wheels', ''), 'WheelY': P(-60, 'Wheels', '')})
    W, L, H = r.BodyHalfWidth, r.BodyHalfLength, r.BodyHeight
    r.box('Base', -W, -L, 10, W, L, 16)
    r.box('Lid', -W, -L, H - 4, W, L, H)
    r.box('Side L', -W - 10, -L, 10, -W, L, H)
    r.box('Side R', W, -L, 10, W + 10, L, H)
    r.box('Fork L', -100, L, 3, -80, L + r.ForkLength, 115)
    r.box('Fork R', 80, L, 3, 100, L + r.ForkLength, 115)
    bw, br, t, y, z = r.BeaterWidth / 2, r.BeaterRadius, r.HoopBar, r.PivotY, r.PivotZ
    # two rectangular hoops at right angles, sharing the axle (X)
    r.cut('Beater hoop A', r.box('hoop A outer', -bw, y - br, z - t / 2, bw, y + br, z + t / 2, keep=False),
          r.box('hoop A inside', -bw + 12, y - br + t, z - t / 2 - 1, bw - 12, y + br - t, z + t / 2 + 1, keep=False))
    r.cut('Beater hoop B', r.box('hoop B outer', -bw, y - t / 2, z - br, bw, y + t / 2, z + br, keep=False),
          r.box('hoop B inside', -bw + 12, y - t / 2 - 1, z - br + t, bw - 12, y + t / 2 + 1, z + br - t, keep=False))
    r.cyl('Beater shaft', 'x', (0, y, z), 10, 160)
    r.box('Caster skid', -30, -L, 0, 30, -L + 30, 10)
    r.box('Battery', -100, -L + 30, 16, 100, -L + 90, 60)
    r.cyl('Weapon motor', 'x', (0, 100, 40), 25, 60)
    r.wheel('Drive wheel L', -r.TrackX, r.WheelY, r.WheelR, r.WheelWidth)
    r.wheel('Drive wheel R', r.TrackX, r.WheelY, r.WheelR, r.WheelWidth)
    r.save()


def six_pack():
    r = Robot('six_pack', 'Six Pack', {
        'BodyHalfWidth': P(160, 'Body', ''), 'BodyHalfLength': P(200, 'Body', ''), 'BodyHeight': P(99, 'Body', ''),
        'FlipperLength': P(130, 'Weapon', 'plate in front of the body'), 'FlipperHalfWidth': P(140, 'Weapon', ''),
        'HingeZ': P(30, 'Weapon', ''), 'TrackX': P(195, 'Wheels', ''), 'WheelR': P(52, 'Wheels', 'taller than the lid: invertible'),
        'WheelWidth': P(25, 'Wheels', ''), 'WheelSpacing': P(140, 'Wheels', 'front-to-middle and middle-to-rear'),
        'MiddleDrop': P(3, 'Wheels', 'drop centre: middle wheels this much lower')})
    W, L, H = r.BodyHalfWidth, r.BodyHalfLength, r.BodyHeight
    r.box('Base', -W, -L, 12, W, L, 18)
    r.box('Lid', -W, -L, H - 4, W, L, H)
    r.box('Side L', -W - 10, -L, 12, -W, L, H)
    r.box('Side R', W, -L, 12, W + 10, L, H)
    fw = r.FlipperHalfWidth
    r.box('Flipper plate', -fw, L, 2, fw, L + r.FlipperLength, 8)
    r.box('Flipper arm L', -fw, L - 80, 8, -fw + 15, L + r.FlipperLength, 40)
    r.box('Flipper arm R', fw - 15, L - 80, 8, fw, L + r.FlipperLength, 40)
    r.cyl('Flipper hinge', 'x', (0, L + 5, r.HingeZ), 8, W * 2 - 20)
    r.box('Battery', -120, -150, 18, 120, -90, 70)
    r.box('Gearmotor', -40, 60, 18, 40, 120, 80)
    for side, s in (('L', -1), ('R', 1)):
        for name, y, drop in (('front', r.WheelSpacing, 0), ('middle', 0, r.MiddleDrop), ('rear', -r.WheelSpacing, 0)):
            r.cyl(f'Wheel {name} {side}', 'x', (s * r.TrackX, y, r.WheelR - drop), r.WheelR, r.WheelWidth)
    r.save()


def sidewinder():
    r = Robot('sidewinder', 'Sidewinder', {
        'BodyHalfWidth': P(140, 'Body', ''), 'BodyHalfLength': P(180, 'Body', ''), 'BodyHeight': P(104, 'Body', ''),
        'ScoopLength': P(60, 'Body', 'flat scoop in front'),
        'ArmLength': P(280, 'Weapon', 'hinge to head, lying out to the right at rest'), 'HingeZ': P(128, 'Weapon', ''),
        'HeadSize': P(60, 'Weapon', ''), 'TrackX': P(180, 'Wheels', ''), 'WheelR': P(40, 'Wheels', ''),
        'WheelWidth': P(25, 'Wheels', ''), 'WheelbaseY': P(100, 'Wheels', 'wheel centre Y (+/-)')})
    W, L, H, a, hz = r.BodyHalfWidth, r.BodyHalfLength, r.BodyHeight, r.ArmLength, r.HingeZ
    r.box('Base', -W, -L, 10, W, L, 16)
    r.box('Lid', -W, -L, H - 4, W, L, H)
    r.box('Side L', -W - 10, -L, 10, -W, L, H)
    r.box('Side R', W, -L, 10, W + 10, L, H)
    r.box('Front scoop', -W - 10, L, 3, W + 10, L + r.ScoopLength, 12)
    r.box('Hinge tower', -20, -40, H, 20, 40, hz + 12)
    r.cyl('Hammer hinge', 'y', (0, 0, hz), 10, 80)
    r.box('Hammer arm', -5, -15, hz - 8, a, 15, hz + 7)
    hs = r.HeadSize
    r.box('Hammer head', a - 20, -hs / 2, hz - hs / 2 - 2, a + 20, hs / 2, hz + hs / 2 - 2)
    r.box('Battery', -100, -120, 16, 100, -60, 60)
    for side, s in (('L', -1), ('R', 1)):
        r.wheel(f'Wheel {side}1', s * r.TrackX, r.WheelbaseY, r.WheelR, r.WheelWidth)
        r.wheel(f'Wheel {side}2', s * r.TrackX, -r.WheelbaseY, r.WheelR, r.WheelWidth)
    r.save()


def tilt():
    # 4 cambered wheels (Tilt's thing) with the front pair right under the disc's weight,
    # and the disc high enough that nosing down doesn't put it into the floor
    r = Robot('tilt', 'Tilt', {
        'BodyHalfWidth': P(120, 'Body', ''), 'BodyFront': P(150, 'Body', ''), 'BodyRear': P(-150, 'Body', ''),
        'BodyHeight': P(94, 'Body', ''), 'DiscRadius': P(125, 'Weapon', ''), 'DiscThickness': P(14, 'Weapon', ''),
        'PivotY': P(200, 'Weapon', ''), 'PivotZ': P(170, 'Weapon', 'disc axle height (radius + floor clearance)'),
        'ToothLength': P(30, 'Weapon', ''), 'ForkLength': P(110, 'Body', 'forks either side of the disc: stop the spin-up torque tipping the nose down'),
        'ForkGap': P(3, 'Body', 'fork underside above the floor'),
        'TrackX': P(155, 'Wheels', ''), 'WheelR': P(48, 'Wheels', ''),
        'WheelWidth': P(25, 'Wheels', ''), 'FrontWheelY': P(140, 'Wheels', 'front wheels under the disc weight'), 'RearWheelY': P(-60, 'Wheels', '')})
    W, F, B, H = r.BodyHalfWidth, r.BodyFront, r.BodyRear, r.BodyHeight
    r.box('Base', -W, B, 12, W, F, 18)
    r.box('Lid', -W, B, H - 4, W, F, H)
    r.box('Electronics', -W + 20, B + 20, 18, W - 20, F - 60, H - 10)
    d = r.DiscThickness / 2
    r.box('Weapon upright L', -d - 32, 100, 18, -d - 12, r.PivotY + 40, r.PivotZ + 20)
    r.box('Weapon upright R', d + 12, 100, 18, d + 32, r.PivotY + 40, r.PivotZ + 20)
    r.cyl('Disc', 'x', (0, r.PivotY, r.PivotZ), r.DiscRadius, r.DiscThickness)
    r.box('Disc tooth', -d, r.PivotY + r.DiscRadius - 15, r.PivotZ + 5, d, r.PivotY + r.DiscRadius + r.ToothLength - 15, r.PivotZ + 30)
    r.cyl('Disc axle', 'x', (0, r.PivotY, r.PivotZ), 10, d * 2 + 64)
    r.box('Skid', -40, F - 50, 6, 40, F, 14)
    for side, s in (('L', -1), ('R', 1)):
        x0, x1 = (d + 34, d + 60) if s > 0 else (-d - 60, -d - 34)
        r.box(f'Fork {side}', x0, F, r.ForkGap, x1, F + r.ForkLength, r.ForkGap + 10)
    for side, s, c in (('L', -1, 10), ('R', 1, -10)):
        r.wheel(f'Wheel front {side}', s * r.TrackX, r.FrontWheelY, r.WheelR, r.WheelWidth, tilt=c)
        r.wheel(f'Wheel rear {side}', s * r.TrackX, r.RearWheelY, r.WheelR, r.WheelWidth, tilt=c)
    r.save()


def frog_block():
    # a blocky FROG V3: 474 x 172 sandwich of 6 mm base / 5 mm top plates between 16 mm aluminium rails
    # (55 mm box), wheels outboard (Ø100 rear, Ø75 front), a 315 mm bar spinning under the front, hinged
    # UHMW forks on the floor, aluminium front armour and TPU rear armour. Frame from FROG V3: the floor
    # is 37.5 mm under the base plate and the weapon shaft is the Y origin.
    r = Robot('frog_block', 'Frog-ish Block', {
        'PlateHalfWidth': P(221, 'Body', 'inside of the rails'), 'PlateFront': P(55, 'Body', ''), 'PlateRear': P(-117, 'Body', ''),
        'BoxHeight': P(55, 'Body', 'rail height'), 'GroundClearance': P(37.5, 'Body', 'floor to the base plate'),
        'RailThickness': P(16, 'Body', ''), 'FrontArmour': P(12, 'Body', ''), 'RearArmour': P(26, 'Body', 'TPU'),
        'BarLength': P(315, 'Weapon', ''), 'BarWidth': P(50, 'Weapon', ''), 'BarThickness': P(12, 'Weapon', ''),
        'BarZ': P(10, 'Weapon', 'bar underside above the floor'),
        'RearWheelR': P(50, 'Wheels', ''), 'RearWheelY': P(-139.8, 'Wheels', ''), 'RearWheelX': P(255, 'Wheels', ''), 'RearWheelWidth': P(35, 'Wheels', ''),
        'FrontWheelR': P(37.5, 'Wheels', ''), 'FrontWheelY': P(11.9, 'Wheels', ''), 'FrontWheelX': P(248, 'Wheels', ''), 'FrontWheelWidth': P(22, 'Wheels', ''),
        'ForkLength': P(85, 'Body', 'hinged forks resting on the floor')})
    W, F, B, Hb, g, t = r.PlateHalfWidth, r.PlateFront, r.PlateRear, r.BoxHeight, r.GroundClearance, r.RailThickness
    r.box('Base plate', -W, B, g, W, F, g + 6)
    r.box('Top plate', -W - t, B, g + Hb, W + t, F, g + Hb + 5)
    r.box('Side rail L', -W - t, B, g, -W, F, g + Hb)
    r.box('Side rail R', W, B, g, W + t, F, g + Hb)
    r.box('Front armour', -W, F - r.FrontArmour, g + 6, W, F, g + Hb)
    r.box('Rear armour TPU', -W - t, B - r.RearArmour, g, W + t, B, g + Hb)
    bl, bw = r.BarLength / 2, r.BarWidth / 2
    r.box('Spinner bar', -bl, -bw, r.BarZ, bl, bw, r.BarZ + r.BarThickness)
    r.cyl('Weapon shaft', 'z', (0, 0, (r.BarZ + g + 6) / 2), 15, g + 6 - r.BarZ)
    r.box('Bearing block', -50, -40, g + 6, 50, 40, g + 37)
    r.cyl('Weapon motor 4092', 'z', (85, -60, g + 28), 25, 42)
    r.cyl('Drive motor L', 'x', (-150, -60, g + 27.5), 23, 70)
    r.cyl('Drive motor R', 'x', (150, -60, g + 27.5), 23, 70)
    r.box('Battery front', -200, -20, g + 6, -60, 30, g + 45)
    r.box('Battery rear', -200, -105, g + 6, -60, -55, g + 45)
    r.box('Frog Brain', 60, 0, g + 6, 140, 40, g + 25)
    for side, s in (('L', -1), ('R', 1)):
        r.box(f'Fork hinged UHMW {side}', s * 150 - 8, F, 0, s * 150 + 8, F + r.ForkLength, 16)
        r.wheel(f'Rear wheel {side}', s * r.RearWheelX, r.RearWheelY, r.RearWheelR, r.RearWheelWidth)
        r.wheel(f'Front wheel {side}', s * r.FrontWheelX, r.FrontWheelY, r.FrontWheelR, r.FrontWheelWidth)
    r.save()


def thorn():
    # 4WD with a drum on the front axle between the front wheels, about half the width; rear track narrower
    r = Robot('thorn', 'Thorn', {
        'Width': P(400, 'Body', 'across the front wheels'), 'BodyHalfWidth': P(130, 'Body', ''),
        'BodyRear': P(-235, 'Body', ''), 'BodyFront': P(-55, 'Body', 'body stops behind the drum'), 'BodyHeight': P(85, 'Body', ''),
        'DrumRadius': P(40, 'Weapon', ''), 'DrumBore': P(28, 'Weapon', ''), 'DrumHalfLength': P(100, 'Weapon', ''),
        'ToothHeight': P(8, 'Weapon', 'how far teeth stand off the drum'),
        'FrontWheelR': P(50, 'Wheels', 'the drum rides on this axle'), 'FrontWheelWidth': P(30, 'Wheels', ''),
        'RearWheelR': P(45, 'Wheels', ''), 'RearWheelWidth': P(28, 'Wheels', ''), 'RearTrackX': P(160, 'Wheels', ''), 'RearWheelY': P(-190, 'Wheels', '')})
    W, B, F, H, a = r.BodyHalfWidth, r.BodyRear, r.BodyFront, r.BodyHeight, r.FrontWheelR
    r.box('Base plate', -W - 10, B, 12, W + 10, F + 5, 16)
    r.box('Body UHMW', -W, B, 16, W, F, H - 4)
    r.box('Top plate', -W, B, H - 4, W, F, H)
    for side, s in (('L', -1), ('R', 1)):
        for i, (a0, a1) in enumerate(((r.DrumHalfLength + 5, r.DrumHalfLength + 15), (r.Width / 2 - r.FrontWheelWidth - 15, r.Width / 2 - r.FrontWheelWidth - 5))):
            x0, x1 = (a0, a1) if s > 0 else (-a1, -a0)
            r.box(f'Axle plate {side}{i}', x0, F - 15, 14, x1, 24, 80)
        r.box(f'Drive motor {side}', s * 40 if s > 0 else -120, -180, 22, 120 if s > 0 else -40, -130, 62)
    r.box('Battery', -100, -120, 18, 100, -65, 60)
    r.box('ESCs', -60, -225, 18, 60, -195, 50)
    r.cyl('Weapon motor', 'x', (0, -100, 50), 26, 40)
    r.cyl('Front axle', 'x', (0, 0, a), 8, r.Width - r.FrontWheelWidth * 2)
    r.tube('Drum', 'x', (0, 0, a), r.DrumRadius, r.DrumBore, r.DrumHalfLength * 2)
    top = a + r.DrumRadius - 6
    for name, x, y0, y1, z0, z1 in (('Drum tooth top', -55, -10, 10, top, top + r.ToothHeight + 6),
                                    ('Drum tooth bottom', -55, -10, 10, a - r.DrumRadius - r.ToothHeight, a - r.DrumRadius + 6),
                                    ('Drum tooth front', 55, r.DrumRadius - 6, r.DrumRadius + r.ToothHeight, a - 10, a + 10),
                                    ('Drum tooth back', 55, -r.DrumRadius - r.ToothHeight, -r.DrumRadius + 6, a - 10, a + 10)):
        r.box(name, x - 18, y0, z0, x + 18, y1, z1)
    xf = r.Width / 2 - r.FrontWheelWidth / 2
    for side, s in (('L', -1), ('R', 1)):
        r.wheel(f'Wheel front {side}', s * xf, 0, a, r.FrontWheelWidth)
        r.wheel(f'Wheel rear {side}', s * r.RearTrackX, r.RearWheelY, r.RearWheelR, r.RearWheelWidth)
    r.save()


os.makedirs(OUT, exist_ok=True)
for fn in (wide_vert, drum, lifter, hammer, shell_shock, eggbeater, six_pack, sidewinder, tilt, frog_block, thorn):
    if not ONLY or ONLY in fn.__name__:
        fn()
