'use strict';

// Editor-only glow. Geometry is borrowed from the selected meshes, never saved
// or included in picking, and is not disposed when selection changes.
const EditorSelection = (() => {
  function create(THREE, scene) {
    const group = new THREE.Group();
    group.name = 'editor-selection-halo'; scene.add(group);
    let target = null, outline = null, meshes = [];
    const materials = [.42, .12].map((opacity, index) => new THREE.ShaderMaterial({
      uniforms: {glowColor: {value: new THREE.Color(0x43dfff)}, opacity: {value: opacity}, width: {value: index ? .0065 : .0025}},
      vertexShader: `uniform float width;
        void main() {
          vec4 p = modelViewMatrix * vec4(position, 1.0);
          p.xyz += normalize(normalMatrix * normal) * width * max(0.4, -p.z);
          gl_Position = projectionMatrix * p;
        }`,
      fragmentShader: 'uniform vec3 glowColor; uniform float opacity; void main() { gl_FragColor = vec4(glowColor, opacity); }',
      side: THREE.BackSide, transparent: true, depthWrite: false, depthTest: true,
      blending: THREE.AdditiveBlending,
    }));
    function clear() {
      group.clear(); group.visible = false; meshes = []; target = null;
      if (outline) { outline.geometry.dispose(); outline.material.dispose(); outline = null; }
    }
    function set(next) {
      if (next === target) return;
      clear(); if (!next) return;
      target = next;
      target.traverse(source => {
        if (!source.isMesh || !source.geometry?.attributes?.normal) return;
        for (const material of materials) {
          const glow = new THREE.Mesh(source.geometry, material);
          glow.matrixAutoUpdate = false; glow.raycast = () => {}; glow.renderOrder = 8;
          group.add(glow); meshes.push({source, glow});
        }
      });
      outline = new THREE.BoxHelper(target, 0x43dfff);
      outline.material.transparent = true; outline.material.opacity = .85;
      outline.material.depthTest = false; outline.material.depthWrite = false;
      outline.raycast = () => {}; outline.renderOrder = 9; group.add(outline);
      update();
    }
    function update() {
      if (!target) return;
      target.updateWorldMatrix(true, true);
      let visible = true;
      for (let node = target; node; node = node.parent) if (!node.visible) visible = false;
      group.visible = visible;
      for (const {source, glow} of meshes) {
        glow.matrix.copy(source.matrixWorld); glow.visible = true;
        for (let node = source; node; node = node.parent) if (!node.visible) { glow.visible = false; break; }
      }
      outline.update();
    }
    return {set, clear, update, dispose() { clear(); materials.forEach(m => m.dispose()); scene.remove(group); }};
  }
  return {create};
})();
