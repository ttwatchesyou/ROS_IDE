// ═══════════════════════════════════════════════════════════════════
//  CSG Library — Boolean operations for Three.js BufferGeometry
//  Based on ThreeCSG (Chandler Prall) / Evan Wallace CSG algorithm
//  Adapted for Three.js r128+ BufferGeometry (no legacy Geometry)
//  MIT License
// ═══════════════════════════════════════════════════════════════════

(function () {
  'use strict';

  if (typeof THREE === 'undefined') {
    console.error('CSG: THREE not found — load three.js first');
    return;
  }

  // ──────────────────────────────────────────────────────────────
  // Vector, Vertex, Plane, Polygon — CSG core data structures
  // ──────────────────────────────────────────────────────────────

  class CSGVector {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    clone() { return new CSGVector(this.x, this.y, this.z); }
    copy(v) { this.x = v.x; this.y = v.y; this.z = v.z; return this; }
    add(v) { this.x += v.x; this.y += v.y; this.z += v.z; return this; }
    sub(v) { this.x -= v.x; this.y -= v.y; this.z -= v.z; return this; }
    multiplyScalar(s) { this.x *= s; this.y *= s; this.z *= s; return this; }
    dot(v) { return this.x * v.x + this.y * v.y + this.z * v.z; }
    cross(v) {
      const x = this.y * v.z - this.z * v.y;
      const y = this.z * v.x - this.x * v.z;
      const z = this.x * v.y - this.y * v.x;
      this.x = x; this.y = y; this.z = z; return this;
    }
    length() { return Math.sqrt(this.dot(this)); }
    normalize() {
      const l = this.length(); if (l > 0) this.multiplyScalar(1 / l); return this;
    }
    applyMatrix4(m) {
      const x = this.x, y = this.y, z = this.z;
      const e = m.elements;
      this.x = e[0] * x + e[4] * y + e[8] * z + e[12];
      this.y = e[1] * x + e[5] * y + e[9] * z + e[13];
      this.z = e[2] * x + e[6] * y + e[10] * z + e[14];
      return this;
    }
    equals(v, eps = 1e-5) {
      return Math.abs(this.x - v.x) < eps && Math.abs(this.y - v.y) < eps && Math.abs(this.z - v.z) < eps;
    }
  }

  class CSGVertex {
    constructor(pos, normal) {
      this.pos = pos instanceof CSGVector ? pos : new CSGVector(pos.x, pos.y, pos.z);
      this.normal = normal instanceof CSGVector ? normal : new CSGVector(normal.x, normal.y, normal.z);
    }
    clone() { return new CSGVertex(this.pos.clone(), this.normal.clone()); }
    interpolate(other, t) {
      const p = this.pos.clone().add(other.pos.clone().sub(this.pos).multiplyScalar(t));
      const n = this.normal.clone().add(other.normal.clone().sub(this.normal).multiplyScalar(t)).normalize();
      return new CSGVertex(p, n);
    }
  }

  class CSGPlane {
    constructor(normal, w) {
      this.normal = normal instanceof CSGVector ? normal.normalize() : new CSGVector(normal.x, normal.y, normal.z).normalize();
      this.w = w;
    }
    static fromPoints(a, b, c) {
      const n = new CSGVector().subVectors(b, a).cross(new CSGVector().subVectors(c, a)).normalize();
      return new CSGPlane(n, n.dot(a));
    }
    static fromVector4(v4) { return new CSGPlane(new CSGVector(v4.x, v4.y, v4.z), v4.w); }
    clone() { return new CSGPlane(this.normal.clone(), this.w); }
    flip() { this.normal.multiplyScalar(-1); this.w = -this.w; return this; }
    splitPolygon(polygon, coplanarFront, coplanarBack, front, back) {
      const COPLANAR = 0, FRONT = 1, BACK = 2;
      let polygonType = 0;
      const types = [];
      for (const v of polygon.vertices) {
        const d = this.normal.dot(v.pos) - this.w;
        const t = d > 1e-5 ? FRONT : d < -1e-5 ? BACK : COPLANAR;
        polygonType |= t;
        types.push(t);
      }
      switch (polygonType) {
        case COPLANAR: (this.normal.dot(polygon.plane.normal) > 0 ? coplanarFront : coplanarBack).push(polygon); break;
        case FRONT: front.push(polygon); break;
        case BACK: back.push(polygon); break;
        default:
          const f = [], b = [];
          for (let i = 0; i < polygon.vertices.length; i++) {
            const j = (i + 1) % polygon.vertices.length;
            const ti = types[i], tj = types[j];
            const vi = polygon.vertices[i], vj = polygon.vertices[j];
            if (ti !== BACK) f.push(vi);
            if (ti !== FRONT) b.push(ti !== BACK ? vi.clone() : vi);
            if (ti !== FRONT && tj !== BACK) {
              const d1 = this.normal.dot(vi.pos) - this.w;
              const d2 = this.normal.dot(vj.pos) - this.w;
              const t = d1 / (d1 - d2);
              const v = vi.interpolate(vj, t);
              f.push(v); b.push(v.clone());
            }
            if (tj !== BACK && ti !== FRONT) {
              const d1 = this.normal.dot(vi.pos) - this.w;
              const d2 = this.normal.dot(vj.pos) - this.w;
              const t = d1 / (d1 - d2);
              const v = vi.interpolate(vj, t);
              f.push(v.clone()); b.push(v);
            }
          }
          if (f.length >= 3) front.push(new CSGPolygon(f, polygon.shared));
          if (b.length >= 3) back.push(new CSGPolygon(b, polygon.shared));
      }
    }
  }

  class CSGPolygon {
    constructor(vertices, shared) {
      this.vertices = vertices; this.shared = shared;
      this.plane = CSGPlane.fromPoints(vertices[0].pos, vertices[1].pos, vertices[2].pos);
    }
    clone() { return new CSGPolygon(this.vertices.map(v => v.clone()), this.shared); }
    flip() {
      this.vertices.reverse().forEach(v => v.normal.multiplyScalar(-1));
      this.plane.flip(); return this;
    }
  }

  // ──────────────────────────────────────────────────────────────
  // CSG Node (BSP Tree)
  // ──────────────────────────────────────────────────────────────

  class CSGNode {
    constructor(polygons = []) {
      this.plane = null; this.front = null; this.back = null; this.polygons = [];
      if (polygons.length) this.build(polygons);
    }
    build(polygons) {
      if (!polygons.length) return;
      if (!this.plane) this.plane = polygons[0].plane.clone();
      const front = [], back = [];
      for (const p of polygons) this.plane.splitPolygon(p, this.polygons, this.polygons, front, back);
      if (front.length) { if (!this.front) this.front = new CSGNode(); this.front.build(front); }
      if (back.length) { if (!this.back) this.back = new CSGNode(); this.back.build(back); }
    }
    allPolygons() {
      let r = this.polygons.slice();
      if (this.front) r = r.concat(this.front.allPolygons());
      if (this.back) r = r.concat(this.back.allPolygons());
      return r;
    }
    clone() {
      const n = new CSGNode();
      n.plane = this.plane ? this.plane.clone() : null;
      n.polygons = this.polygons.map(p => p.clone());
      if (this.front) n.front = this.front.clone();
      if (this.back) n.back = this.back.clone();
      return n;
    }
    invert() {
      for (const p of this.polygons) p.flip();
      this.plane && this.plane.flip();
      if (this.front) this.front.invert();
      if (this.back) this.back.invert();
      const t = this.front; this.front = this.back; this.back = t;
    }
    clipPolygons(polygons) {
      if (!this.plane) return polygons.slice();
      const front = [], back = [];
      for (const p of polygons) this.plane.splitPolygon(p, front, back, front, back);
      if (this.front) front = this.front.clipPolygons(front);
      if (this.back) back = this.back.clipPolygons(back);
      else back = [];
      return front.concat(back);
    }
    clipTo(node) {
      this.polygons = node.clipPolygons(this.polygons);
      if (this.front) this.front.clipTo(node);
      if (this.back) this.back.clipTo(node);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Main CSG class
  // ──────────────────────────────────────────────────────────────

  class CSG {
    constructor() { this.polygons = []; }
    static fromPolygons(polygons) {
      const c = new CSG(); c.polygons = polygons; return c;
    }
    clone() { const c = new CSG(); c.polygons = this.polygons.map(p => p.clone()); return c; }
    toPolygons() { return this.polygons; }
    union(csg) {
      const a = new CSGNode(this.polygons), b = new CSGNode(csg.polygons);
      a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
      return CSG.fromPolygons(a.allPolygons().concat(b.allPolygons()));
    }
    subtract(csg) {
      const a = new CSGNode(this.polygons), b = new CSGNode(csg.polygons);
      a.invert(); a.clipTo(b); a.invert();
      b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
      return CSG.fromPolygons(a.allPolygons().concat(b.allPolygons()));
    }
    intersect(csg) {
      const a = new CSGNode(this.polygons), b = new CSGNode(csg.polygons);
      a.clipTo(b); b.clipTo(a);
      return CSG.fromPolygons(b.allPolygons());
    }
  }

  // ──────────────────────────────────────────────────────────────
  // Bridge: THREE BufferGeometry ↔ CSG
  // ──────────────────────────────────────────────────────────────

  function csgVectorFromThree(v) { return new CSGVector(v.x, v.y, v.z); }
  function threeVectorFromCSG(v) { return new THREE.Vector3(v.x, v.y, v.z); }

  function csgFromGeometry(geom) {
    if (!geom || !geom.attributes || !geom.attributes.position) return new CSG();
    const pos = geom.attributes.position;
    const norm = geom.attributes.normal;
    const idx = geom.index;
    const count = idx ? idx.count : pos.count;
    if (count % 3 !== 0) return new CSG();
    const polys = [];
    for (let i = 0; i < count; i += 3) {
      const i0 = idx ? idx.getX(i) : i;
      const i1 = idx ? idx.getX(i + 1) : i + 1;
      const i2 = idx ? idx.getX(i + 2) : i + 2;
      const v0 = new CSGVertex(
        new CSGVector(pos.getX(i0), pos.getY(i0), pos.getZ(i0)),
        norm ? new CSGVector(norm.getX(i0), norm.getY(i0), norm.getZ(i0)) : new CSGVector(0, 1, 0)
      );
      const v1 = new CSGVertex(
        new CSGVector(pos.getX(i1), pos.getY(i1), pos.getZ(i1)),
        norm ? new CSGVector(norm.getX(i1), norm.getY(i1), norm.getZ(i1)) : new CSGVector(0, 1, 0)
      );
      const v2 = new CSGVertex(
        new CSGVector(pos.getX(i2), pos.getY(i2), pos.getZ(i2)),
        norm ? new CSGVector(norm.getX(i2), norm.getY(i2), norm.getZ(i2)) : new CSGVector(0, 1, 0)
      );
      polys.push(new CSGPolygon([v0, v1, v2], {}));
    }
    return CSG.fromPolygons(polys);
  }

  function geometryFromCSG(csg, uv = true) {
    const polys = csg.toPolygons();
    if (!polys.length) return new THREE.BufferGeometry();
    const positions = []; const normals = []; const uvs = [];
    for (const p of polys) {
      const vs = p.vertices;
      // Triangulate polygon (fan from v0)
      for (let i = 1; i < vs.length - 1; i++) {
        const a = vs[0], b = vs[i], c = vs[i + 1];
        [a, b, c].forEach(v => {
          positions.push(v.pos.x, v.pos.y, v.pos.z);
          normals.push(v.normal.x, v.normal.y, v.normal.z);
          if (uv) uvs.push(0, 0); // placeholder UV
        });
      }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geom.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    if (uv) geom.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geom.computeBoundingSphere(); geom.computeBoundingBox();
    return geom;
  }

  // Apply matrix to CSG (transform polygons in place)
  function csgTransform(csg, matrix) {
    const m = new THREE.Matrix4().copy(matrix);
    const nrm = new THREE.Matrix3().getNormalMatrix(m);
    for (const p of csg.polygons) {
      for (const v of p.vertices) {
        v.pos.applyMatrix4(m);
        const tn = new CSGVector(v.normal.x, v.normal.y, v.normal.z);
        tn.applyMatrix4(nrm); // wrong - apply normal matrix
        // proper normal transform: use normal matrix
        const tmp = new THREE.Vector3(v.normal.x, v.normal.y, v.normal.z).applyNormalMatrix(nrm);
        v.normal.x = tmp.x; v.normal.y = tmp.y; v.normal.z = tmp.z;
      }
      // recompute plane
      p.plane = CSGPlane.fromPoints(p.vertices[0].pos, p.vertices[1].pos, p.vertices[2].pos);
    }
  }

  // ──────────────────────────────────────────────────────────────
  // High-level Boolean operations on Meshes
  // ──────────────────────────────────────────────────────────────

  function csgSubtractMesh(baseMesh, toolMesh) {
    const baseGeom = baseMesh.geometry.clone();
    baseGeom.applyMatrix4(baseMesh.matrixWorld);
    const toolGeom = toolMesh.geometry.clone();
    toolGeom.applyMatrix4(toolMesh.matrixWorld);
    const A = csgFromGeometry(baseGeom);
    const B = csgFromGeometry(toolGeom);
    const result = A.subtract(B);
    const outGeom = geometryFromCSG(result);
    // Result is in world space; caller will apply inverse matrix if needed
    return outGeom;
  }

  function csgUnionMesh(baseMesh, toolMesh) {
    const baseGeom = baseMesh.geometry.clone(); baseGeom.applyMatrix4(baseMesh.matrixWorld);
    const toolGeom = toolMesh.geometry.clone(); toolGeom.applyMatrix4(toolMesh.matrixWorld);
    const A = csgFromGeometry(baseGeom), B = csgFromGeometry(toolGeom);
    return geometryFromCSG(A.union(B));
  }

  function csgIntersectMesh(baseMesh, toolMesh) {
    const baseGeom = baseMesh.geometry.clone(); baseGeom.applyMatrix4(baseMesh.matrixWorld);
    const toolGeom = toolMesh.geometry.clone(); toolGeom.applyMatrix4(toolMesh.matrixWorld);
    const A = csgFromGeometry(baseGeom), B = csgFromGeometry(toolGeom);
    return geometryFromCSG(A.intersect(B));
  }

  // ──────────────────────────────────────────────────────────────
  // Expose
  // ──────────────────────────────────────────────────────────────

  window.CSG = CSG;
  window.CSGVector = CSGVector;
  window.CSGVertex = CSGVertex;
  window.CSGPlane = CSGPlane;
  window.CSGPolygon = CSGPolygon;
  window.CSGNode = CSGNode;
  window.csgFromGeometry = csgFromGeometry;
  window.geometryFromCSG = geometryFromCSG;
  window.csgTransform = csgTransform;
  window.csgSubtractMesh = csgSubtractMesh;
  window.csgUnionMesh = csgUnionMesh;
  window.csgIntersectMesh = csgIntersectMesh;

})();