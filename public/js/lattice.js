// Hero concept A — "The lattice seal".
// A 3D lattice of points, each nudged by a small error term (the LWE picture behind ML-KEM).
// Points inside the S settle onto the exact grid and light up: the seal. A scan plane sweeps
// through every few seconds; the noise flickers, the seal does not.
import * as THREE from "/vendor/three.js";

const S_PATH = "M44.6 16.6c-3.4-3-7.7-4.4-12.6-4.4-7.9 0-13.6 4.3-13.6 10.6 0 6.6 5 8.9 11.6 10.4l3.3.8c3.7.9 5.1 1.8 5.1 3.6 0 2.1-2.2 3.4-5.6 3.4-3.9 0-7-1.5-9.4-4.3l-6.4 6.2c3.5 4 9 6 15.6 6 8.6 0 14.6-4.4 14.6-11.3 0-6.3-4.3-9.1-11.6-10.7l-3.5-.8c-3.4-.8-4.8-1.6-4.8-3.3 0-1.8 1.8-3 4.7-3 3 0 5.6 1.1 7.9 3.2l4.7-6.4Z";

function sMask(res = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = res;
  const g = c.getContext("2d");
  g.fillStyle = "#000"; g.fillRect(0, 0, res, res);
  g.save();
  // path box ≈ x 15..49, y 12..52 → fill the canvas with a little margin
  const k = res / 44;
  g.translate(res / 2 - 32 * k, res / 2 - 32 * k);
  g.scale(k, k);
  g.fillStyle = "#fff";
  g.fill(new Path2D(S_PATH));
  g.restore();
  const d = g.getImageData(0, 0, res, res).data;
  return (u, v) => { // u,v in 0..1, v down
    const x = Math.floor(u * (res - 1)), y = Math.floor(v * (res - 1));
    if (x < 0 || y < 0 || x >= res || y >= res) return 0;
    return d[(y * res + x) * 4] / 255;
  };
}

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const col = (v) => new THREE.Color(v || "#ffffff");

export function mountLattice(canvas, { variant = "seal" } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: "high-performance" });
  renderer.setClearColor(0x000000, 0);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  camera.position.set(0, 0, 14);
  const group = new THREE.Group();
  scene.add(group);

  const small = innerWidth < 700;
  const mask = sMask();
  let NX, NY, NZ, sp;
  if (variant === "seal") { NX = small ? 30 : 58; NY = small ? 46 : 38; NZ = small ? 5 : 7; sp = small ? 0.2 : 0.21; }
  else { NX = small ? 44 : 110; NY = 1; NZ = small ? 40 : 46; sp = 0.2; }
  const count = NX * NY * NZ;
  const pos = new Float32Array(count * 3), noise = new Float32Array(count * 3), inS = new Float32Array(count), phase = new Float32Array(count);
  // S occupies a square region centred at (sx, 0) with half-size sh
  const sh = (NY - 1) * sp * (small ? 0.27 : 0.34);
  let i = 0;
  for (let ix = 0; ix < NX; ix++) for (let iy = 0; iy < NY; iy++) for (let iz = 0; iz < NZ; iz++) {
    const x = (ix - (NX - 1) / 2) * sp, z = (iz - (NZ - 1) / 2) * sp;
    const y = variant === "seal" ? (iy - (NY - 1) / 2) * sp : 0;
    pos.set([x, y, z], i * 3);
    let r = [Math.random() * 2 - 1, Math.random() * 2 - 1, Math.random() * 2 - 1];
    const l = Math.hypot(...r) || 1;
    const m = 0.5 + Math.random() * 0.5;
    noise.set([r[0] / l * m, r[1] / l * m, r[2] / l * m], i * 3);
    phase[i] = Math.random() * Math.PI * 2;
    if (variant === "seal") {
      const u = (x - 0) / (2 * sh) + 0.5, v = 0.5 - y / (2 * sh);
      inS[i] = Math.abs(z) <= sp * 1.6 && mask(u, v) > 0.5 ? 1 : 0;
    }
    i++;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aNoise", new THREE.BufferAttribute(noise, 3));
  geo.setAttribute("aS", new THREE.BufferAttribute(inS, 1));
  geo.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));

  const uni = {
    uTime: { value: 0 }, uAmp: { value: variant === "seal" ? 0.085 : 0.05 }, uSeal: { value: 0 }, uScan: { value: -99 },
    uSize: { value: small ? 34 : 38 }, uPix: { value: 1 }, uWave: { value: variant === "wave" ? 1 : 0 },
    cDim: { value: col() }, cHi: { value: col() }, cAc: { value: col() },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms: uni, transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    vertexShader: `
      attribute vec3 aNoise; attribute float aS; attribute float aPhase;
      uniform float uTime, uAmp, uSeal, uScan, uSize, uPix, uWave;
      varying float vS; varying float vScan; varying float vFade;
      void main() {
        float wob = 0.55 + 0.45 * sin(uTime * 0.9 + aPhase);
        float sealed = aS * uSeal;
        vec3 p = position + aNoise * uAmp * wob * (1.0 - sealed);
        if (uWave > 0.5) {
          p.y += sin(position.x * 0.9 + uTime * 0.6) * 0.32 + cos(position.z * 1.1 - uTime * 0.45) * 0.22;
        }
        p.z += sealed * 0.05 * sin(uTime * 1.4 + position.y * 2.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        vScan = smoothstep(0.42, 0.0, abs(position.x - uScan));
        vS = sealed;
        vFade = clamp((-mv.z - 9.0) / 12.0, 0.0, 1.0);
        gl_PointSize = uSize * uPix * (0.75 + sealed * 0.75) / -mv.z;
      }`,
    fragmentShader: `
      uniform vec3 cDim, cHi, cAc;
      varying float vS; varying float vScan; varying float vFade;
      void main() {
        vec2 q = abs(gl_PointCoord - 0.5);
        if (max(q.x, q.y) > 0.36) discard;
        vec3 c = mix(cDim, cHi, vS);
        float flick = vScan * (1.0 - vS);
        c = mix(c, cAc, flick * 0.95 + vS * vScan * 0.25);
        float a = mix(0.42, 1.0, vS) + flick * 0.6;
        a *= 1.0 - vFade * 0.7;
        gl_FragColor = vec4(c, a);
      }`,
  });
  const points = new THREE.Points(geo, mat);
  group.add(points);

  function palette() {
    uni.cDim.value = col(css("--dim2"));
    uni.cHi.value = col(css("--hi"));
    uni.cAc.value = col(css("--ac"));
  }
  palette();
  window.addEventListener("selen:palette", palette);

  // layout: S to the right on wide screens, centred higher on phones
  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    const dpr = Math.min(devicePixelRatio || 1, 2);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    canvas.style.width = "100%"; canvas.style.height = "100%";
    camera.aspect = w / h;
    if (variant === "seal") {
      const D = 14;
      camera.position.set(0, 0, D);
      camera.lookAt(0, 0, 0);
      const upp = (2 * D * Math.tan((camera.fov / 2) * Math.PI / 180)) / h; // world units per css pixel
      const wide = w / h > 1.05;
      let cx, cy, hp;
      if (wide) { cx = w * 0.72; cy = h * 0.47; hp = h * 0.64; }
      else {
        const meta = document.querySelector(".hero-meta"), copy = document.querySelector(".hero-copy");
        const top = meta ? meta.getBoundingClientRect().bottom - r.top : 60;
        const bottom = copy ? copy.getBoundingClientRect().top - r.top : h * 0.5;
        cy = (top + bottom) / 2; hp = Math.min((bottom - top) * 0.9, w * 0.78); cx = w / 2;
        if (hp < 150) { hp = Math.min(w * 0.7, h * 0.4); cy = top + hp / 2 + 10; }
      }
      const scale = (hp * upp) / (2 * sh);
      group.scale.setScalar(scale);
      group.position.set((cx - w / 2) * upp, (h / 2 - cy) * upp, 0);
      const spacingPx = (sp * scale) / upp;
      uni.uPix.value = dpr * 2.5 * (spacingPx / 25);
    } else {
      camera.position.set(0, 4.2, 12);
      camera.lookAt(0, -0.6, 0);
      uni.uPix.value = dpr * (h / 900) * 2.4;
    }
    camera.updateProjectionMatrix();
  }
  resize();
  new ResizeObserver(resize).observe(canvas);

  let mx = 0, my = 0, tx = 0, ty = 0;
  addEventListener("pointermove", (e) => { tx = e.clientX / innerWidth - 0.5; ty = e.clientY / innerHeight - 0.5; }, { passive: true });
  let visible = true;
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) loop(); }, { threshold: 0 }).observe(canvas);

  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const t0 = performance.now();
  let raf = 0, running = false;
  function frame(now) {
    const t = (now - t0) / 1000;
    uni.uTime.value = t;
    if (variant === "seal") {
      uni.uSeal.value = reduce ? 1 : Math.min(1, Math.max(0, (t - 0.25) / 1.6)) ** 2 * (3 - 2 * Math.min(1, Math.max(0, (t - 0.25) / 1.6)));
      const per = 6.5, ph = (t % per) / per;
      const half = (NX - 1) * sp / 2 + 0.6;
      uni.uScan.value = t > 2 && ph < 0.55 ? -half + (ph / 0.55) * half * 2 : -99;
      const r = canvas.getBoundingClientRect();
      const prog = Math.min(1, Math.max(0, -r.top / Math.max(1, r.height)));
      uni.uAmp.value = 0.085 + prog * 0.5;
      group.rotation.x = my * 0.22 + prog * 0.25;
    } else {
      group.rotation.x = my * 0.08;
    }
    mx += (tx - mx) * 0.05; my += (ty - my) * 0.05;
    group.rotation.y = mx * (variant === "seal" ? 0.45 : 0.2) + (variant === "seal" ? Math.sin(t * 0.18) * 0.08 : t * 0.02);
    renderer.render(scene, camera);
  }
  function loop() {
    if (running) return;
    running = true;
    const step = (now) => {
      if (!visible) { running = false; return; }
      frame(now);
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }
  loop();
  return { dispose() { cancelAnimationFrame(raf); renderer.dispose(); } };
}
