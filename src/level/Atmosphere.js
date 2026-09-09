import * as THREE from 'three';
import { bus, Events } from '../core/EventBus.js';
import { SUN } from '../core/Constants.js';

/**
 * Ambient life for the environment, all slow and understated:
 *  - birds: a handful of far-off swifts circling high over the site (one Points draw, 4-frame flap atlas)
 *  - overhead wires: gentle catenary sway (vertex shader on the GLB's MAP_wire mesh; weights from connectivity)
 *  - wind-blown litter: a scrap of paper / plastic tumbling along the ground now and then (one InstancedMesh)
 *  - foot dust: puffs kicked up when the player / bots run on sand (reuses the shared particle pool)
 */
export class Atmosphere {
  constructor(game) {
    this.game = game; this.scene = game.scene; this.map = game.map; this.fx = game.particles; this.camera = game.camera;
    this.time = 0;
    this.wind = new THREE.Vector3(-0.32, 0, 0.18).normalize();   // same direction as the dust motes drift
    this._birds();
    this._wires();
    this._litter();
    this._footDust();
  }

  // ---------------------------------------------------------------- birds
  _birds() {
    const N = 7;
    const pos = new Float32Array(N * 3), seed = new Float32Array(N);
    for (let i = 0; i < N; i++) seed[i] = Math.random() * 100;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
    this.birdCentres = Array.from({ length: N }, (_, i) => ({
      cx: -8 + Math.cos(i * 2.1) * 26, cz: -4 + Math.sin(i * 2.1) * 26, cy: 38 + (i % 3) * 7,
      r: 14 + (i % 4) * 5, w: (0.05 + (i % 3) * 0.012) * (i % 2 ? 1 : -1), ph: seed[i],
    }));
    const tex = makeBirdAtlas();
    this.birdMat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, fog: false,
      uniforms: { uTex: { value: tex }, uTime: { value: 0 }, uScale: { value: 1 }, uFog: { value: new THREE.Color() }, uFogD: { value: SUN.FOG_DENSITY } },
      vertexShader: /* glsl */`
        attribute float seed; uniform float uTime, uScale, uFogD; varying float vFrame, vFog;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          float d = -mv.z;
          gl_PointSize = clamp(1.6 * uScale / d, 3.0, 18.0);        // ~1.6 m wingspan footprint (swift-sized at 40-60 m)
          vFrame = floor(mod(uTime * (7.0 + fract(seed) * 2.0) + seed, 4.0));
          vFog = 1.0 - exp(-uFogD * uFogD * d * d);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */`
        uniform sampler2D uTex; uniform vec3 uFog; varying float vFrame, vFog;
        void main(){
          vec2 uv = vec2((gl_PointCoord.x + vFrame) * 0.25, 1.0 - gl_PointCoord.y);
          float a = texture2D(uTex, uv).a;
          if (a < 0.03) discard;
          gl_FragColor = vec4(mix(vec3(0.07, 0.065, 0.06), uFog, vFog * 0.9), a * 0.9);
        }`,
    });
    this.birds = new THREE.Points(g, this.birdMat);
    this.birds.frustumCulled = false; this.birds.renderOrder = 1;
    this.scene.add(this.birds);
  }

  _updateBirds(dt) {
    const a = this.birds.geometry.attributes.position, t = this.time;
    for (let i = 0; i < this.birdCentres.length; i++) {
      const b = this.birdCentres[i];
      const ang = t * b.w + b.ph, r = b.r * (1 + 0.15 * Math.sin(t * 0.07 + b.ph));
      a.setXYZ(i, b.cx + Math.cos(ang) * r, b.cy + Math.sin(t * 0.11 + b.ph * 2.0) * 2.5, b.cz + Math.sin(ang) * r * 0.8);
    }
    a.needsUpdate = true;
    this.birdMat.uniforms.uTime.value = t;
    this.birdMat.uniforms.uScale.value = this.camera.projectionMatrix.elements[5] * this.game.renderer.domElement.height * 0.5;   // px per metre at 1 m
    if (this.scene.fog) this.birdMat.uniforms.uFog.value.copy(this.scene.fog.color);
  }

  // ---------------------------------------------------------------- wires
  _wires() {
    let wire = null;
    this.map.root.traverse((o) => { if (o.isMesh && /wire|cable/i.test(o.name)) wire = o; });
    if (!wire || !wire.geometry.index) return;
    const geo = wire.geometry, pos = geo.attributes.position, idx = geo.index.array, n = pos.count;
    // connected components over the index buffer -> one catenary span each
    const parent = new Int32Array(n); for (let i = 0; i < n; i++) parent[i] = i;
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < idx.length; i += 3) { const a = find(idx[i]), b = find(idx[i + 1]), c = find(idx[i + 2]); parent[a] = b; parent[find(b)] = c; }
    const comps = new Map();
    for (let i = 0; i < n; i++) { const r = find(i); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(i); }
    const sway = new Float32Array(n), phase = new Float32Array(n);
    const v = new THREE.Vector3(), c = new THREE.Vector3(), axis = new THREE.Vector3();
    let k = 0;
    for (const verts of comps.values()) {
      c.set(0, 0, 0); for (const i of verts) c.add(v.fromBufferAttribute(pos, i)); c.divideScalar(verts.length);
      // span axis = direction to the farthest vertex from the centroid (horizontal)
      let far = 0; axis.set(1, 0, 0);
      for (const i of verts) { v.fromBufferAttribute(pos, i).sub(c); v.y = 0; const l = v.lengthSq(); if (l > far) { far = l; axis.copy(v); } }
      const L = Math.sqrt(far) || 1; axis.normalize();
      const ph = (k++) * 1.37;
      for (const i of verts) {
        const t = THREE.MathUtils.clamp((v.fromBufferAttribute(pos, i).sub(c).dot(axis)) / L, -1, 1);   // -1..1 along the span, 0 mid-span
        sway[i] = L > 1.5 ? Math.cos(t * Math.PI * 0.5) * Math.min(1, L / 8) : 0;                          // anchors stay put, mid-span moves most; short stubs don't
        phase[i] = ph;
      }
    }
    geo.setAttribute('aSway', new THREE.BufferAttribute(sway, 1));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
    const mats = Array.isArray(wire.material) ? wire.material : [wire.material];
    this.wireUniforms = [];
    for (const m of mats) {
      const prev = m.onBeforeCompile;
      m.onBeforeCompile = (shader, renderer) => {
        prev?.(shader, renderer);
        shader.uniforms.uWireT = { value: 0 };
        this.wireUniforms.push(shader.uniforms.uWireT);
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aSway, aPhase; uniform float uWireT;')
          .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  // slow catenary breathing (vertical) + a smaller lateral swing, two incommensurate frequencies so it never loops visibly
  float s = aSway;
  transformed.y += s * (0.045 * sin(uWireT * 0.9 + aPhase) + 0.02 * sin(uWireT * 2.3 + aPhase * 1.7));
  transformed.xz += s * 0.03 * vec2(sin(uWireT * 0.7 + aPhase * 0.6), cos(uWireT * 0.55 + aPhase));
}`);
      };
      const key = m.customProgramCacheKey?.() ?? '';
      m.customProgramCacheKey = () => key + '|wiresway';
      m.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- litter
  _litter() {
    const N = 3;
    this.litter = Array.from({ length: N }, () => ({ active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), t: 0, life: 0, floorY: 0, settle: 0, scale: 1 }));
    const geo = new THREE.PlaneGeometry(0.34, 0.26);
    const mat = new THREE.MeshStandardMaterial({ map: makePaperTexture(), side: THREE.DoubleSide, roughness: 0.9, metalness: 0, alphaTest: 0.4, transparent: true });
    this.litterMesh = new THREE.InstancedMesh(geo, mat, N);
    this.litterMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.litterMesh.castShadow = false; this.litterMesh.receiveShadow = true; this.litterMesh.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < N; i++) this.litterMesh.setMatrixAt(i, zero);
    this.scene.add(this.litterMesh);
    this.nextLitter = 4 + Math.random() * 6;
    this._ray = new THREE.Raycaster(); this._ray.firstHitOnly = true;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3();
  }

  _floorAt(x, z, yFrom) {
    this._ray.set(new THREE.Vector3(x, yFrom, z), new THREE.Vector3(0, -1, 0)); this._ray.far = 12;
    const h = this._ray.intersectObject(this.map.collider, false)[0];
    return h ? h.point.y : null;
  }

  _spawnLitter() {
    const slot = this.litter.find((l) => !l.active); if (!slot) return;
    const cam = this.camera.position;
    // start upwind of the player, 7-16 m away, slightly off the view axis so it drifts through the frame rather than at the eye
    const ang = Math.atan2(-this.wind.z, -this.wind.x) + (Math.random() - 0.5) * 1.6, dist = 7 + Math.random() * 9;
    const x = cam.x + Math.cos(ang) * dist, z = cam.z + Math.sin(ang) * dist;
    const fy = this._floorAt(x, z, cam.y + 2.5); if (fy === null) return;
    slot.active = true; slot.t = 0; slot.life = 14 + Math.random() * 8; slot.settle = 0;
    slot.floorY = fy; slot.pos.set(x, fy + 0.05, z);
    slot.vel.copy(this.wind).multiplyScalar(0.8 + Math.random() * 0.6);
    slot.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    slot.spin.set((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 4, (Math.random() - 0.5) * 6);
    slot.scale = 0.8 + Math.random() * 0.5;
  }

  _updateLitter(dt) {
    this.nextLitter -= dt;
    if (this.nextLitter <= 0) { this._spawnLitter(); this.nextLitter = 9 + Math.random() * 14; }
    const m = this._m, q = this._q, s = this._s, up = 0.0;
    for (let i = 0; i < this.litter.length; i++) {
      const l = this.litter[i];
      if (!l.active) continue;
      l.t += dt;
      // gusts: the scrap skips along, lifts a little, drops, pauses
      const gust = Math.max(0, Math.sin(l.t * 0.9 + i) + 0.35 * Math.sin(l.t * 2.7));
      const speed = 0.35 + 1.4 * gust;
      const tgt = this.wind.clone().multiplyScalar(speed);
      l.vel.lerp(tgt, 1 - Math.exp(-dt * 2.5));
      const hover = l.floorY + 0.04 + 0.35 * gust * gust;
      l.pos.x += l.vel.x * dt; l.pos.z += l.vel.z * dt;
      l.pos.y += (hover - l.pos.y) * (1 - Math.exp(-dt * 3));
      const spinK = 0.2 + gust;
      l.rot.x += l.spin.x * spinK * dt; l.rot.y += l.spin.y * spinK * dt; l.rot.z += l.spin.z * spinK * dt;
      // every ~0.25 s: wall ahead? floor still under us (ledge)?
      if ((l.t % 0.25) < dt) {
        this._ray.set(l.pos.clone().setY(l.floorY + 0.15), l.vel.clone().normalize()); this._ray.far = 0.6;
        if (this._ray.intersectObject(this.map.collider, false).length) { l.settle += 1; l.vel.multiplyScalar(0.1); if (l.settle > 6) l.life = Math.min(l.life, l.t + 1.5); }
        const fy = this._floorAt(l.pos.x, l.pos.z, l.pos.y + 0.5);
        if (fy === null || fy < l.floorY - 1.5) l.life = Math.min(l.life, l.t + 1.0); else l.floorY = fy;
      }
      const fade = Math.min(1, l.t / 1.2, (l.life - l.t) / 1.2);
      if (l.t >= l.life) { l.active = false; m.makeScale(0, 0, 0); }
      else { q.setFromEuler(l.rot); s.setScalar(l.scale * Math.max(0, fade)); m.compose(l.pos, q, s); }
      this.litterMesh.setMatrixAt(i, m);
    }
    this.litterMesh.instanceMatrix.needsUpdate = true;
  }

  // ---------------------------------------------------------------- foot dust
  _footDust() {
    const puff = (pos, strength) => {
      const p = pos.clone(); p.y += 0.04;
      this.fx.burst(p, new THREE.Vector3(0, 1, 0), Math.round(4 * strength), () => ({
        size: 0.10 + Math.random() * 0.08, color: [0.70, 0.60, 0.44], alpha: 0.28 * strength, life: 0.55 + Math.random() * 0.4, drag: 3.5, grow: 0.5, grav: 0.6,
      }), 0.9, [0.25, 0.8]);
    };
    bus.on(Events.PLAYER_FOOTSTEP, (e) => {
      if (e.quiet || e.surface !== 'sand') return;
      if (e.kind === 'land') { puff(e.pos, 1.8); return; }
      if (e.kind === 'step') puff(e.pos, 1);
    });
    bus.on(Events.BOT_FOOTSTEP, (e) => {
      if (e.quiet || !e.pos) return;
      if (e.pos.distanceToSquared(this.camera.position) > 30 * 30) return;
      this._ray.set(e.pos.clone().setY(e.pos.y + 0.3), new THREE.Vector3(0, -1, 0)); this._ray.far = 0.8;
      const h = this.map.raycast(this._ray);
      if (h && h.surface === 'sand') puff(e.pos, 0.8);
    });
  }

  update(dt) {
    this.time += dt;
    this._updateBirds(dt);
    for (const u of this.wireUniforms || []) u.value = this.time;
    this._updateLitter(dt);
  }
}

/** 4-frame flap atlas (256x64): a small dark swift silhouette, wings from raised to lowered. */
function makeBirdAtlas() {
  const w = 256, h = 64, c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.clearRect(0, 0, w, h);
  x.fillStyle = '#000'; x.strokeStyle = '#000'; x.lineCap = 'round';
  for (let f = 0; f < 4; f++) {
    const ox = f * 64 + 32, oy = 34;
    const lift = [-14, -6, 4, 12][f];                     // wingtip height per frame
    x.lineWidth = 6.5;
    x.beginPath(); x.moveTo(ox - 27, oy + lift); x.quadraticCurveTo(ox - 10, oy - 2 - lift * 0.3, ox, oy); x.quadraticCurveTo(ox + 10, oy - 2 - lift * 0.3, ox + 27, oy + lift); x.stroke();
    x.beginPath(); x.ellipse(ox, oy + 1, 7, 4.5, 0, 0, Math.PI * 2); x.fill();   // body
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearMipmapLinearFilter; t.generateMipmaps = true;
  return t;
}

/** A crumpled scrap of newsprint / packing paper: warm off-white, faint print lines, torn alpha edge. */
function makePaperTexture() {
  const s = 128, c = document.createElement('canvas'); c.width = s; c.height = s;
  const x = c.getContext('2d');
  x.fillStyle = '#c8bca3'; x.fillRect(0, 0, s, s);          // sun-yellowed newsprint, not bright white (must not pop against the sand)
  const g = x.createLinearGradient(0, 0, s, s); g.addColorStop(0, 'rgba(255,255,255,0.18)'); g.addColorStop(0.5, 'rgba(0,0,0,0.0)'); g.addColorStop(1, 'rgba(60,45,25,0.22)');
  x.fillStyle = g; x.fillRect(0, 0, s, s);
  x.strokeStyle = 'rgba(70,60,50,0.35)'; x.lineWidth = 1;
  for (let i = 0; i < 9; i++) { const y = 18 + i * 11; x.beginPath(); x.moveTo(14, y); x.lineTo(14 + 40 + Math.random() * 60, y); x.stroke(); }
  x.fillStyle = 'rgba(90,70,50,0.35)';
  for (let i = 0; i < 30; i++) x.fillRect(Math.random() * s, Math.random() * s, 1 + Math.random() * 2, 1);
  // torn edge: knock out ragged corners
  x.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 14; i++) { const a = Math.random() * Math.PI * 2, r = 8 + Math.random() * 10; x.beginPath(); x.arc(s / 2 + Math.cos(a) * s * 0.55, s / 2 + Math.sin(a) * s * 0.55, r, 0, Math.PI * 2); x.fill(); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
  return t;
}
