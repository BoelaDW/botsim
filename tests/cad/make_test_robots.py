# Synthetic test robots as named STEP assemblies (mm), for npm run stress -- tests/synth.json.
# Run headless:  OUT=testfiles/synth freecad -c "exec(open('tests/cad/make_test_robots.py').read())" </dev/null
import FreeCAD as App, Part, Import, Mesh, os, math
from FreeCAD import Vector as V
OUT = os.environ['OUT']
def cyl(r, h, base, axis): return Part.makeCylinder(r, h, base, axis)
def box(x0, y0, z0, x1, y1, z1): return Part.makeBox(x1 - x0, y1 - y0, z1 - z0, V(x0, y0, z0))
def wheelX(x, y, z, r, w): return cyl(r, w, V(x - w / 2, y, z), V(1, 0, 0))
def save(name, parts, stl=None):
    doc = App.newDocument(name)
    objs = []
    for label, shape in parts:
        o = doc.addObject('Part::Feature', 'P'); o.Shape = shape; o.Label = label; objs.append(o)
    doc.recompute()
    Import.export(objs, f'{OUT}/{name}.step')
    if stl == 'single':
        Mesh.export(objs, f'{OUT}/{name}_single.stl')
    elif stl == 'parts':
        os.makedirs(f'{OUT}/{name}_stl', exist_ok=True)
        for o in objs:
            m = Mesh.Mesh(o.Shape.tessellate(0.2))
            m.transform(App.Matrix(1 / 25.4, 0, 0, 0, 0, 1 / 25.4, 0, 0, 0, 0, 1 / 25.4, 0, 0, 0, 0, 1))   # inches
            m.write(f'{OUT}/{name}_stl/{o.Label.replace(" ", "_")}.stl')
    print('wrote', name, len(objs))
    App.closeDocument(name)

# 1. shell spinner: ring shell around everything, two wheels inside
shell = cyl(210, 60, V(0, 0, 12), V(0, 0, 1)).cut(cyl(195, 60, V(0, 0, 12), V(0, 0, 1)))
shell = shell.fuse(cyl(210, 4, V(0, 0, 68), V(0, 0, 1)))                    # lid
teeth = [box(205, -10, 15, 222, 10, 70).rotate(V(0, 0, 0), V(0, 0, 1), a) for a in (0, 180)]
save('shell_spinner', [
    ('Chassis plate', cyl(150, 6, V(0, 0, 8), V(0, 0, 1))),
    ('Shell', shell), ('Shell tooth A', teeth[0]), ('Shell tooth B', teeth[1]),
    ('Bearing hub', cyl(30, 50, V(0, 0, 14), V(0, 0, 1))),
    ('Wheel left', wheelX(-90, 0, 30, 30, 20)), ('Wheel right', wheelX(90, 0, 30, 30, 20)),
    ('Battery', box(-60, -100, 14, 60, -50, 50)), ('Electronics', box(-50, 50, 14, 50, 100, 40)),
    ('Skid front', box(-20, 120, 0.5, 20, 140, 8)), ('Skid rear', box(-20, -140, 0.5, 20, -120, 8)),
])

# 2. eggbeater drum on forks, 2WD
beater = box(-60, -55, 55, 60, -45, 75).fuse(box(-60, 45, 55, 60, 55, 75))  # placeholder, replaced below
hoops = None
for a in (0, 90):
    hoop = box(-60, -55, -5, 60, 55, 5).cut(box(-50, -45, -6, 50, 45, 6)).rotate(V(0, 0, 0), V(1, 0, 0), a)
    hoops = hoop if hoops is None else hoops.fuse(hoop)
hoops.translate(V(0, 230, 60))
save('eggbeater', [
    ('Base', box(-150, -150, 10, 150, 150, 16)), ('Lid', box(-150, -150, 90, 150, 150, 94)),
    ('Side L', box(-160, -150, 10, -150, 150, 94)), ('Side R', box(150, -150, 10, 160, 150, 94)),
    ('Fork L', box(-100, 150, 10, -80, 260, 100)), ('Fork R', box(80, 150, 10, 100, 260, 100)),
    ('Beater', hoops), ('Beater shaft', cyl(8, 160, V(-80, 230, 60), V(1, 0, 0))),
    ('Drive wheel L', wheelX(-185, -60, 45, 45, 30)), ('Drive wheel R', wheelX(185, -60, 45, 45, 30)),
    ('Caster skid', box(-30, -150, 0, 30, -120, 10)),
    ('Battery', box(-100, -120, 16, 100, -60, 60)), ('Weapon motor', cyl(25, 60, V(-30, 100, 40), V(1, 0, 0))),
])

# 3. 6WD drop-centre with front flipper (lifter)
parts6 = [('Base', box(-160, -200, 12, 160, 200, 18)), ('Lid', box(-160, -200, 95, 160, 200, 99)),
          ('Side L', box(-170, -200, 12, -160, 200, 99)), ('Side R', box(160, -200, 12, 170, 200, 99)),
          ('Flipper plate', box(-140, 200, 2, 140, 330, 8)), ('Flipper arm L', box(-140, 120, 8, -125, 330, 40)),
          ('Flipper arm R', box(125, 120, 8, 140, 330, 40)), ('Flipper hinge', cyl(8, 300, V(-150, 205, 30), V(1, 0, 0))),
          ('Battery', box(-120, -150, 18, 120, -90, 70)), ('Gearmotor', box(-40, 60, 18, 40, 120, 80))]
for side, x in (('L', -195), ('R', 195)):
    for name, y, dz in (('front', 140, 0), ('middle', 0, -3), ('rear', -140, 0)):
        parts6.append((f'Wheel {name} {side}', wheelX(x, y, 40 + dz, 40, 25)))
save('sixwheel_flipper', parts6)

# 4. sideways hammer: arm swings over the left side (hinge along Y)
save('side_hammer', [
    ('Base', box(-140, -180, 10, 140, 180, 16)), ('Lid', box(-140, -180, 100, 140, 180, 104)),
    ('Side L', box(-150, -180, 10, -140, 180, 104)), ('Side R', box(140, -180, 10, 150, 180, 104)),
    ('Hammer arm', box(-5, -15, 120, 280, 15, 135)), ('Hammer head', box(260, -30, 100, 300, 30, 160)),
    ('Hammer hinge', cyl(10, 80, V(0, -40, 128), V(0, 1, 0))), ('Hinge tower', box(-20, -40, 104, 20, 40, 140)),
    ('Wheel L1', wheelX(-180, 100, 40, 40, 25)), ('Wheel L2', wheelX(-180, -100, 40, 40, 25)),
    ('Wheel R1', wheelX(180, 100, 40, 40, 25)), ('Wheel R2', wheelX(180, -100, 40, 40, 25)),
    ('Battery', box(-100, -120, 16, 100, -60, 60)),
], stl='parts')

# 5. cambered wheels (10 deg) vertical spinner, plus the same robot exported Y-up and as one STL
def camber(x, y, z, r, w, s):
    c = wheelX(x, y, z, r, w); c.rotate(V(x, y, z), V(0, 1, 0), 10 * s); return c
vbot = [('Base', box(-120, -150, 12, 120, 150, 18)), ('Lid', box(-120, -150, 90, 120, 150, 94)),
        ('Disc', cyl(120, 12, V(-6, 190, 130), V(1, 0, 0))), ('Disc tooth', box(-6, 300, 140, 6, 330, 160)),
        ('Weapon upright L', box(-30, 100, 18, -15, 230, 140)), ('Weapon upright R', box(15, 100, 18, 30, 230, 140)),
        ('Wheel L', camber(-150, -60, 45, 45, 25, 1)), ('Wheel R', camber(150, -60, 45, 45, 25, -1)),
        ('Skid', box(-40, 100, 0, 40, 150, 12))]
save('camber_vert', vbot, stl='single')
yup = []
for label, sh in vbot:
    s = sh.copy(); s.rotate(V(0, 0, 0), V(1, 0, 0), -90); yup.append((label, s))
save('camber_vert_yup', yup)
