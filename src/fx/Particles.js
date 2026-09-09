import * as THREE from 'three';

const VERT = /* glsl */`
attribute float aSize; attribute vec4 aColor; attribute float aLife;
varying vec4 vColor; varying float vLife;
void main() {
  vColor = aColor; vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (700.0 / -mv.z);
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */`
varying vec4 vColor; varying float vLife;
void main() {
  vec2 c = gl_PointCoord - 0.5; float d = length(c);
  float a = smoothstep(0.5, 0.15, d) * vColor.a * vLife;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor.rgb, a);
}`;

/** CPU-simulated point particles (dust, sparks, blood, smoke). One draw call. */
export class Particles {
  constructor(scene, max = 1200) {
    this.max = max; this.n = 0;
    this.pos = new Float32Array(max * 3); this.vel = new Float32Array(max * 3);
    this.size = new Float32Array(max); this.col = new Float32Array(max * 4);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.grav = new Float32Array(max); this.drag = new Float32Array(max); this.grow = new Float32Array(max);
    this.alive = new Uint8Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
    this.lifeAttr = new Float32Array(max);
    g.setAttribute('aLife', new THREE.BufferAttribute(this.lifeAttr, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, blending: THREE.NormalBlending });
    this.points = new THREE.Points(g, this.mat); this.points.frustumCulled = false; this.points.renderOrder = 5;
    scene.add(this.points);
    this.cursor = 0;
  }

  /** Spawn one particle. */
  emit(p, v, { size = 0.1, color = [1, 1, 1], alpha = 1, life = 1, grav = 0, drag = 0, grow = 0 } = {}) {
    let i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.alive[i] = 1;
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z;
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z;
    this.size[i] = size; this.col[i * 4] = color[0]; this.col[i * 4 + 1] = color[1]; this.col[i * 4 + 2] = color[2]; this.col[i * 4 + 3] = alpha;
    this.life[i] = life; this.maxLife[i] = life; this.grav[i] = grav; this.drag[i] = drag; this.grow[i] = grow;
  }

  /** Burst helper: n particles in a cone around dir (or hemisphere around normal). */
  burst(p, dir, n, opts, spread = 0.6, speed = [1, 3]) {
    const d = new THREE.Vector3(), v = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      d.set((Math.random() - 0.5) * 2 * spread, (Math.random() - 0.5) * 2 * spread, (Math.random() - 0.5) * 2 * spread).add(dir).normalize();
      v.copy(d).multiplyScalar(speed[0] + Math.random() * (speed[1] - speed[0]));
      const o = typeof opts === 'function' ? opts(i) : opts;
      this.emit(p, v, o);
    }
  }

  update(dt) {
    const P = this.pos, V = this.vel;
    for (let i = 0; i < this.max; i++) {
      if (!this.alive[i]) { this.lifeAttr[i] = 0; continue; }
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.alive[i] = 0; this.lifeAttr[i] = 0; continue; }
      const k = Math.exp(-this.drag[i] * dt);
      V[i * 3] *= k; V[i * 3 + 1] = V[i * 3 + 1] * k - this.grav[i] * dt; V[i * 3 + 2] *= k;
      P[i * 3] += V[i * 3] * dt; P[i * 3 + 1] += V[i * 3 + 1] * dt; P[i * 3 + 2] += V[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      const t = this.life[i] / this.maxLife[i];
      this.lifeAttr[i] = t < 0.5 ? t * 2 : 1;
    }
    for (const a of ['position', 'aSize', 'aColor', 'aLife']) this.geo.attributes[a].needsUpdate = true;
  }
}
