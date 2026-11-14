// Renders the soft "tube" glyphs that sit inside the diamond tiles (?k=miner → S, ?k=node → cube).
import * as THREE from "/vendor/three.js";
import { kit } from "/js/smark.js";
const q = new URLSearchParams(location.search);
const k = q.get("k") || "miner";
const r = new THREE.WebGLRenderer({ canvas: document.getElementById("c"), antialias: true, alpha: true, preserveDrawingBuffer: true });
r.setPixelRatio(1);
r.setSize(1024, 1024, false);
r.toneMapping = THREE.ACESFilmicToneMapping;
r.toneMappingExposure = 1.05;
const K = kit(THREE);
const scene = new THREE.Scene();
const tint = k === "miner" ? [0x76b900, 0xc5f03c] : [0x1fd1a5, 0x9be23a];
scene.environment = K.bake(r, 0x0b1008, [
  [0xffffff, 6, 12, 3, [0, 9, 3]], [tint[0], 5, 3, 12, [-9, 0, 2]], [tint[1], 4, 2.4, 10, [9, -1, 3]],
  [0xffffff, 2.5, 1.5, 8, [-5, 4, 8]], [0x0b1008, 1, 14, 3, [0, -9, 2]], [tint[0], 1.5, 12, 12, [0, 0, -10]],
], 0.05);
const mat = new THREE.MeshPhysicalMaterial({
  color: k === "miner" ? 0xf6ffe6 : 0xe2fbf2, metalness: 0.15, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.06,
  sheen: 1, sheenColor: new THREE.Color(tint[1]), sheenRoughness: 0.4, iridescence: 0.35, iridescenceIOR: 1.4, envMapIntensity: 1.4,
});
const g = new THREE.Group();
const tube = (curve, rad) => new THREE.Mesh(new THREE.TubeGeometry(curve, 240, rad, 48, false), mat);
const ball = (p, rad) => { const m = new THREE.Mesh(new THREE.SphereGeometry(rad, 48, 32), mat); m.position.copy(p); return m; };
if (k === "miner") {
  // the S spine as one soft tube, round-capped
  const pts = [[0.95, 0.95], [0.55, 1.28], [-0.15, 1.3], [-0.78, 0.98], [-0.86, 0.38], [-0.38, 0.06], [0.38, -0.1], [0.86, -0.42], [0.8, -1.0], [0.18, -1.32], [-0.5, -1.28], [-0.95, -0.92]]
    .map(([x, y]) => new THREE.Vector3(x, y, 0));
  const c = new THREE.CatmullRomCurve3(pts, false, "centripetal");
  const rad = 0.23;
  g.add(tube(c, rad), ball(pts[0], rad), ball(pts[pts.length - 1], rad));
  g.rotation.set(0.12, -0.42, 0.06);
  g.scale.setScalar(1.55);
} else {
  const v = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) v.push(new THREE.Vector3(x, y, z));
  const rad = 0.12;
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    if (v[i].distanceTo(v[j]) === 2) g.add(tube(new THREE.LineCurve3(v[i], v[j]), rad));
  }
  v.forEach((p) => g.add(ball(p, rad)));
  g.rotation.set(0.5, -0.72, 0);
  g.scale.setScalar(1.28);
}
scene.add(g);
const cam = new THREE.PerspectiveCamera(24, 1, 0.1, 100);
cam.position.set(0, 0, 13);
r.render(scene, cam);
window.done = true;
