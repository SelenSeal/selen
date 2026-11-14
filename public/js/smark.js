// The SELEN mark in 3D (logo A: a chrome S with a dotted lattice face) plus the studios it reflects
// and the liquid-metal surface. Shared by the landing page and the local logo renderer (/_render/).
export const S_PATH = "M44.6 16.6c-3.4-3-7.7-4.4-12.6-4.4-7.9 0-13.6 4.3-13.6 10.6 0 6.6 5 8.9 11.6 10.4l3.3.8c3.7.9 5.1 1.8 5.1 3.6 0 2.1-2.2 3.4-5.6 3.4-3.9 0-7-1.5-9.4-4.3l-6.4 6.2c3.5 4 9 6 15.6 6 8.6 0 14.6-4.4 14.6-11.3 0-6.3-4.3-9.1-11.6-10.7l-3.5-.8c-3.4-.8-4.8-1.6-4.8-3.3 0-1.8 1.8-3 4.7-3 3 0 5.6 1.1 7.9 3.2l4.7-6.4Z";

export function kit(THREE) {
  const { SVGLoader, toCreasedNormals } = THREE;

  function bake(renderer, bg, cards, sigma = 0.035) {
    const s = new THREE.Scene();
    s.background = new THREE.Color(bg);
    for (const [c, k, w, h, p] of cards) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(k), side: THREE.DoubleSide }));
      m.position.set(...p);
      m.lookAt(0, 0, 0);
      s.add(m);
    }
    const pm = new THREE.PMREMGenerator(renderer), t = pm.fromScene(s, sigma).texture;
    pm.dispose();
    return t;
  }
  // soft studio of glowing cards: what the S reflects
  const studio = (r, bg = 0x030502) => bake(r, bg, [
    [0xffffff, 10, 10, 2.8, [0, 9, 2]], [0xffffff, 3.5, 1.6, 10, [-7.5, 0, 7]], [0x76b900, 7, 2.6, 12, [-9, 1, -1]],
    [0xc5f03c, 6, 2.2, 9, [9, -2, 2]], [0x1fd1a5, 4.5, 12, 1.5, [0, -9, 3]], [0xffffff, 4, 1.3, 7, [7, 5, -5]],
    [0x4f8a00, 3, 14, 2, [0, 3, -10]], [0x8cc63f, 0.9, 7, 7, [0, 0, 11]],
  ]);
  // dark room with thin light strips: what the liquid metal reflects
  const stripStudio = (r) => bake(r, 0x000000, [
    [0x1b2218, 1, 30, 18, [0, 0, 12]], [0xffffff, 9, 30, 0.5, [0, 8.5, 2]], [0xffffff, 4, 30, 0.25, [0, 6, 6]],
    [0x76b900, 7, 30, 0.8, [0, -8, 2]], [0xc5f03c, 3, 30, 0.3, [0, -5.5, 6]], [0xffffff, 5, 0.4, 18, [-10, 0, 3]],
    [0x76b900, 4, 0.6, 18, [10, 0, 3]],
  ], 0.004);
  // horizon room for a liquid floor: a glowing band far behind, thin streaks, a dim front fill
  const horizon = (r) => bake(r, 0x000000, [
    [0x76b900, 3, 80, 1.2, [0, 0.5, -16]], [0xffffff, 4, 80, 0.2, [0, 1.3, -16]],
    [0xffffff, 2.2, 0.25, 10, [-9, 2, -12]], [0xffffff, 2.2, 0.25, 10, [9, 2, -12]], [0x76b900, 2.4, 0.35, 10, [-4, 2, -14]], [0x1fd1a5, 2, 0.35, 10, [5, 2, -14]],
    [0x0e120c, 1, 40, 20, [0, 4, 14]], [0xffffff, 3, 40, 0.3, [0, 10, 0]],
  ], 0.006);

  // the dotted lattice of logo A, as a bump map on the faces
  function dots() {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const g = c.getContext("2d");
    g.fillStyle = "#fff"; g.fillRect(0, 0, 64, 64);
    const r = g.createRadialGradient(32, 32, 0, 32, 32, 15);
    r.addColorStop(0, "#000"); r.addColorStop(0.7, "#333"); r.addColorStop(1, "#fff");
    g.fillStyle = r; g.fillRect(17, 17, 30, 30);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(1.12, 1.12);
    t.anisotropy = 8;
    return t;
  }
  let bump, geo;
  const chrome = (face) => new THREE.MeshPhysicalMaterial({
    color: face ? 0xdde3d6 : 0xeef2ea, metalness: 1, roughness: face ? 0.26 : 0.1,
    clearcoat: 1, clearcoatRoughness: face ? 0.18 : 0.05, iridescence: 0.18, iridescenceIOR: 1.5, iridescenceThicknessRange: [180, 520],
    envMapIntensity: 1.35, ...(face ? { bumpMap: (bump ||= dots()), bumpScale: 1.4 } : {}),
  });
  function sGeometry() {
    if (geo) return geo;
    const data = new SVGLoader().parse(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g transform="scale(1,-1)"><path d="${S_PATH}"/></g></svg>`);
    const shapes = data.paths.flatMap((p) => SVGLoader.createShapes(p));
    geo = new THREE.ExtrudeGeometry(shapes, { depth: 7, bevelEnabled: true, bevelThickness: 1.7, bevelSize: 1.15, bevelSegments: 10, curveSegments: 48 });
    geo.center();
    toCreasedNormals(geo, Math.PI / 4);
    return geo;
  }
  function mark() {
    const m = new THREE.Mesh(sGeometry(), [chrome(true), chrome(false)]);
    m.scale.setScalar(0.105);
    const g = new THREE.Group();
    g.add(m);
    return g;
  }

  // liquid metal: a height field moved in the vertex shader, normals re-derived per pixel
  const WAVE_GLSL = `
uniform float uTime; uniform vec2 uC; uniform float uAmp; uniform float uK; uniform mat3 uRot; varying vec2 vWP;
float wH(vec2 p) {
  vec2 d = p - uC; float r = length(d);
  float ring = 0.26 * sin(uK * r - 2.1 * uTime) / (1.0 + 0.16 * r);
  float swell = 0.11 * sin(0.42 * p.x + 0.3 * p.y + 0.55 * uTime) + 0.06 * sin(0.9 * p.y - 0.7 * p.x - 0.4 * uTime);
  return uAmp * (ring * smoothstep(0.0, 1.6, r) + swell);
}
vec3 wN(vec2 p) {
  float e = 0.015, h0 = wH(p);
  return normalize(vec3(-(wH(p + vec2(e, 0.0)) - h0) / e, -(wH(p + vec2(0.0, e)) - h0) / e, 1.0));
}`;
  function liquid(renderer, { w = 34, h = 17, segX = 300, segY = 150, k = 2.7, env } = {}) {
    const u = { uTime: { value: 0 }, uC: { value: new THREE.Vector2(0, 0.25) }, uAmp: { value: 1 }, uK: { value: k }, uRot: { value: new THREE.Matrix3() } };
    const mat = new THREE.MeshPhysicalMaterial({ color: 0xd4dccd, metalness: 1, roughness: 0.07, clearcoat: 1, clearcoatRoughness: 0.04, envMap: env || stripStudio(renderer), envMapIntensity: 1.25 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace("#include <common>", "#include <common>" + WAVE_GLSL)
        .replace("#include <beginnormal_vertex>", "vec3 objectNormal = wN(position.xy);")
        .replace("#include <begin_vertex>", "vec3 transformed = vec3(position.xy, position.z + wH(position.xy)); vWP = position.xy;");
      sh.fragmentShader = sh.fragmentShader
        .replace("#include <common>", "#include <common>" + WAVE_GLSL)
        .replace("#include <normal_fragment_begin>", "#include <normal_fragment_begin>\nnormal = normalize(mat3(viewMatrix) * uRot * wN(vWP)); nonPerturbedNormal = normal;");
    };
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h, segX, segY), mat);
    // call after placing the mesh: the fragment stage needs its rotation to rebuild normals
    const sync = () => { mesh.updateMatrixWorld(true); u.uRot.value.setFromMatrix4(mesh.matrixWorld); };
    sync();
    return { mesh, mat, u, sync };
  }

  // bright mint room with dark panels: what the S and the glass reflect in the light lifecycle section
  const lightStudio = (r) => bake(r, 0xdfe8d2, [
    [0xffffff, 3.2, 14, 3, [0, 9, 2]], [0x0a0d08, 1, 3.2, 14, [-9, 0, 1]], [0x0a0d08, 1, 2.6, 14, [8.5, 0, -2]],
    [0x76b900, 3, 2.2, 10, [-6, 1, 7]], [0xc5f03c, 2.4, 1.6, 9, [7, -1, 6]], [0x1fd1a5, 1.6, 12, 1.2, [0, -8, 4]],
    [0x0a0d08, 1, 18, 3, [0, 2, -11]], [0xffffff, 2, 1.2, 8, [3, 4, 9]],
  ], 0.02);
  return { bake, studio, stripStudio, lightStudio, horizon, mark, liquid, chrome };
}
