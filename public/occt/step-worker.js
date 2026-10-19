// Classic worker: parse STEP / IGES off the main thread with occt-import-js (OpenCascade compiled to WASM).
importScripts('occt-import-js.js');
const occtReady = occtimportjs();

onmessage = async (e) => {
  const { buf, ext, deflection } = e.data;
  try {
    const occt = await occtReady;
    // millimetres, scaled to metres below: occt-import-js 0.0.23 mis-scales some nested sub-assemblies
    // (e.g. vendor parts drawn in inches) by ~50x when asked for metres; millimetre output is right.
    const params = { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: deflection, angularDeflection: 0.5 };
    const data = new Uint8Array(buf);
    const r = ext === 'iges' || ext === 'igs' ? occt.ReadIgesFile(data, params) : occt.ReadStepFile(data, params);
    if (!r.success) throw new Error('OpenCascade could not read this file');
    // name each mesh after the node that holds it (falls back to the mesh's own name)
    const nodeName = new Map();
    const walk = (n) => { for (const i of n.meshes) nodeName.set(i, n.name); n.children.forEach(walk); };
    walk(r.root);
    const parts = [], transfer = [];
    r.meshes.forEach((m, i) => {
      const pos = new Float32Array(m.attributes.position.array);
      for (let k = 0; k < pos.length; k++) pos[k] *= 0.001;
      const idx = new Uint32Array(m.index.array);
      let color = m.color;
      if (!color && m.brep_faces?.length) color = m.brep_faces.find((f) => f.color)?.color;
      parts.push({ name: m.name || nodeName.get(i) || 'Part ' + (i + 1), color: color || null, pos, idx });
      transfer.push(pos.buffer, idx.buffer);
    });
    postMessage({ ok: true, parts }, transfer);
  } catch (err) {
    postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
