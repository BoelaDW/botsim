# Export each example robot (cad/examples/*.FCStd, or the files in FILES) to a STEP file next to it.
#   freecad -c "exec(open('cad/export_step.py').read())" </dev/null
import glob
import os
import FreeCAD as App
import Import

files = os.environ.get('FILES', '').split(os.pathsep) if os.environ.get('FILES') else sorted(glob.glob(os.path.join(os.getcwd(), 'cad', 'examples', '*.FCStd')))
for path in files:
    doc = App.openDocument(path)
    doc.recompute()
    # top-level solids only: skip the VarSet and anything used inside another feature (a Cut's pieces)
    parts = [o for o in doc.Objects if hasattr(o, 'Shape') and o.TypeId != 'App::VarSet' and not o.InList and not o.Shape.isNull() and o.Shape.Solids]
    out = path[:-6] + '.step'
    Import.export(parts, out)
    print('exported', os.path.basename(out), len(parts), 'parts')
    App.closeDocument(doc.Name)
