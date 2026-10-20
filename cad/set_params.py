# Change Params values in an example robot from the command line (the same as editing the VarSet in FreeCAD):
#   FILE=cad/examples/drum.FCStd PARAMS='{"DrumLength": 260}' freecad -c "exec(open('cad/set_params.py').read())" </dev/null
import json
import os
import FreeCAD as App
doc = App.openDocument(os.path.abspath(os.environ['FILE']))
vs = doc.getObject('Params')
for k, v in json.loads(os.environ['PARAMS']).items():
    old = getattr(vs, k)
    setattr(vs, k, float(v))
    print(f'{k}: {old} -> {v}')
doc.recompute()
doc.save()
App.closeDocument(doc.Name)
