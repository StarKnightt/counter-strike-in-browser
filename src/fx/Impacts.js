import * as THREE from 'three';
import { bus, Events } from '../core/EventBus.js';
import { SUN } from '../core/Constants.js';

const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _rq = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _n = new THREE.Vector3();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _side = new THREE.Vector3(), _y = new THREE.Vector3();
const Z = new THREE.Vector3(0, 0, 1), UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const SUN_DIR = new THREE.Vector3(...SUN.DIR).normalize();
const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * Per-surface bullet-hole look: decal edge (m; the stamp randomises it ±20 %), atlas row (0 crater with pale chipped ring,
 * 1 dent with dark rim + scratch), tint (linear-ish). CS2 rifle holes on plaster are ~3-4 cm across: a 1-1.5 cm pit with the
 * pale substrate chipped out around it; the old 10.5 cm read as paintball splats at 1.5 m.
 */
const HOLE = {
  concrete: { size: 0.04, row: 0, tint: [1, 1, 1] },
  sand:     { size: 0.04, row: 0, tint: [0.80, 0.72, 0.58] },
  wood:     { size: 0.035, row: 1, tint: [0.55, 0.42, 0.30] },
  metal:    { size: 0.025, row: 1, tint: [0.72, 0.74, 0.80] },
};

/**
 * Combat feedback in the world: bullet-hole / blood decals (instanced, atlas variants, per-instance tint), impact debris,
 * blood pools under corpses, muzzle smoke and travelling tracers. Listens to HIT / WEAPON_FIRE / BOT_DEATH.
 * All pools exist (and are rendered) from construction, so their programs compile in Game._warmShaders.
 */
export class Impacts {
  constructor(scene, particles, map) {
    this.scene = scene; this.fx = particles; this.map = map;
    this.holes = this._makeDecalPool(makeHoleAtlas(), 4, 3, 256, 5);   // holes never shrink below ~5 px: a 4 cm hole at 10 m is 3 px and mips it to nothing
    this.blood = this._makeDecalPool(makeSplatAtlas(), 2, 2, 128);
    this.pools = this._makeDecalPool(makePoolAtlas(), 2, 1, 24);
    this.growing = [];                       // blood pools still spreading: { pool, i, t, dur, size, pos, quat }
    this.pendingPools = [];                  // corpses waiting to settle before the pool appears
    this.tracers = this._makeTracers(32);
    bus.on(Events.HIT, (e) => this.onHit(e));
    bus.on(Events.WEAPON_FIRE, (e) => {
      if (e.melee) return;
      const end = e.hit ? e.hit.point : _a.copy(e.muzzle).addScaledVector(e.dir, 300);
      this.tracer(e.muzzle, end);
    });
    bus.on(Events.BOT_DEATH, (e) => { if (e.bot) this.pendingPools.push({ bot: e.bot, t: 0.55, headshot: !!e.headshot }); });
  }

  // ------------------------------------------------------------ decal pools

  /**
   * Instanced quad decals reading one tile of a cols x rows atlas (per-instance `aTile`) with a per-instance tint
   * (instanceColor). Depth-tested, no depth write, polygon offset against the surface; the stamp also lifts them 4 mm.
   * `minPx` > 0: a decal is scaled up (about its centre) so its edge never covers fewer screen pixels than that, and as it
   * approaches the limit its alpha is boosted / colour darkened — small holes seen from 10 m otherwise mip-average to
   * nothing, while CS2 keeps them as readable dark specks. Blood (0) keeps its physical size.
   */
  _makeDecalPool(tex, cols, rows, n, minPx = 0) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const tile = new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aTile', tile);
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const uni = { uMinPx: { value: minPx }, uPxK: { value: 0.0016 } };   // uPxK: world metres per screen pixel at 1 m depth (update() refreshes it)
    mat.userData.uniforms = uni;
    mat.onBeforeCompile = (s) => {
      s.uniforms.uTiles = { value: new THREE.Vector2(cols, rows) }; s.uniforms.uMinPx = uni.uMinPx; s.uniforms.uPxK = uni.uPxK;
      s.vertexShader = s.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aTile;\nuniform vec2 uTiles; uniform float uMinPx, uPxK; varying float vFar;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\n{ float tc = mod(aTile, uTiles.x); float tr = floor(aTile / uTiles.x); vMapUv = (uv + vec2(tc, tr)) / uTiles; }')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        vFar = 0.0;
        #ifdef USE_INSTANCING
        if (uMinPx > 0.0) {
          float sz = length(instanceMatrix[0].xyz);                                            // decal edge (m)
          float depth = max(0.05, -(modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).z);
          float px = sz / (depth * uPxK);                                                       // edge in screen pixels
          transformed.xy *= max(1.0, uMinPx / max(px, 1e-3));                                  // never below uMinPx
          vFar = clamp((uMinPx * 2.0 - px) / (uMinPx * 2.0), 0.0, 1.0);                        // 0 when >= 2x the limit .. 1 at/below it
        }
        #endif`);
      s.fragmentShader = s.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vFar;')
        .replace('#include <map_fragment>', '#include <map_fragment>\n{ diffuseColor.a = min(1.0, diffuseColor.a * (1.0 + 2.5 * vFar)); diffuseColor.rgb *= 1.0 - 0.45 * vFar; }');
    };
    mat.customProgramCacheKey = () => 'decalAtlas';
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.renderOrder = 2;
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3).fill(1), 3).setUsage(THREE.DynamicDrawUsage);
    _m.makeScale(0, 0, 0); for (let i = 0; i < n; i++) mesh.setMatrixAt(i, _m);
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
    return { mesh, n, tile, tiles: cols * rows, cols, cursor: 0 };
  }

  /** Place decal `i` of a pool: quad in the surface plane at `point`, rolled by `rot` about the normal. */
  _place(pool, i, point, normal, scale, rot, tileIdx, tint) {
    _p.copy(point).addScaledVector(normal, 0.004);
    _q.setFromUnitVectors(Z, normal);
    _rq.setFromAxisAngle(Z, rot); _q.multiply(_rq);
    _s.setScalar(scale);
    _m.compose(_p, _q, _s);
    pool.mesh.setMatrixAt(i, _m); pool.mesh.instanceMatrix.needsUpdate = true;
    pool.tile.setX(i, tileIdx); pool.tile.needsUpdate = true;
    if (tint) { pool.mesh.instanceColor.setXYZ(i, tint[0], tint[1], tint[2]); pool.mesh.instanceColor.needsUpdate = true; }
  }

  _stamp(pool, point, normal, scale, rot = Math.random() * Math.PI * 2, tileIdx = Math.floor(Math.random() * pool.tiles), tint = [1, 1, 1]) {
    const i = pool.cursor; pool.cursor = (pool.cursor + 1) % pool.n;
    this._place(pool, i, point, normal, scale, rot, tileIdx, tint);
    return i;
  }

  /** Roll (about the normal) that turns the decal's +Y (the chipped, lit rim) toward the sun's direction in the surface plane. */
  _sunRoll(normal) {
    _y.copy(SUN_DIR).addScaledVector(normal, -SUN_DIR.dot(normal));
    if (_y.lengthSq() < 1e-4 || normal.dot(SUN_DIR) < -0.05) return Math.random() * Math.PI * 2;   // grazing or in shadow: any roll
    _y.normalize();
    _q.setFromUnitVectors(Z, normal); _b.set(0, 1, 0).applyQuaternion(_q);                  // where +Y lands before the roll
    const ang = Math.atan2(_c.crossVectors(_b, _y).dot(normal), _b.dot(_y));
    return ang + rnd(-0.45, 0.45);
  }

  /** Roll that turns a blood decal's +Y to world up in the surface plane (so its drips run down the wall); any roll on floors/ceilings. */
  _downRoll(normal) {
    _y.copy(UP).addScaledVector(normal, -UP.dot(normal));
    if (_y.lengthSq() < 0.05) return Math.random() * Math.PI * 2;
    _y.normalize();
    _q.setFromUnitVectors(Z, normal); _b.set(0, 1, 0).applyQuaternion(_q);
    return Math.atan2(_c.crossVectors(_b, _y).dot(normal), _b.dot(_y)) + rnd(-0.25, 0.25);
  }

  // ------------------------------------------------------------ hits

  onHit(e) {
    const h = e.hit; if (!h) return;
    if (h.entity) { this.bloodHit(h, e.dir, e); return; }
    if (e.melee) { this.surfaceHit(h, e.dir, 0.5); return; }
    this.surfaceHit(h, e.dir, 1);
  }

  /** Bullet hole + debris on a map surface. `h.surface`: concrete (plaster) | sand | wood | metal. */
  surfaceHit(h, dir, scale) {
    const n = _n.copy(h.normal).normalize(); if (n.dot(dir) > 0) n.negate();
    const s = h.surface || 'concrete', look = HOLE[s] || HOLE.concrete;
    const variant = Math.floor(Math.random() * 4), lum = rnd(0.92, 1.08);   // ±8 % per-hole luminance so a spray isn't 20 identical stamps
    this._stamp(this.holes, h.point, n, look.size * rnd(0.8, 1.2) * scale, this._sunRoll(n), look.row * 4 + variant, [look.tint[0] * lum, look.tint[1] * lum, look.tint[2] * lum]);   // plaster 3.2-4.8 cm
    // reflected direction for debris
    const refl = dir.clone().reflect(n).multiplyScalar(0.6).add(n).normalize();
    if (s === 'metal') {
      this.fx.burst(h.point, refl, 12, () => ({ size: 0.02 + Math.random() * 0.015, color: [1.0, 0.78, 0.35], life: 0.2 + Math.random() * 0.35, grav: 12, drag: 1.5 }), 0.55, [3, 10]);
      this.fx.burst(h.point, n, 3, { size: 0.10, color: [0.45, 0.45, 0.45], alpha: 0.45, life: 0.55, drag: 3, grow: 0.3 }, 0.5, [0.5, 1.5]);
    } else if (s === 'wood') {
      this.fx.burst(h.point, refl, 9, () => ({ size: 0.025 + Math.random() * 0.03, color: [0.42, 0.28, 0.14], life: 0.6 + Math.random() * 0.5, grav: 9, drag: 1 }), 0.7, [1.5, 4.5]);
      this.fx.burst(h.point, n, 5, { size: 0.10, color: [0.55, 0.45, 0.3], alpha: 0.5, life: 0.7, drag: 3, grow: 0.35 }, 0.6, [0.6, 1.8]);
    } else {
      // concrete / plaster / sand: dust puff + a few chips
      const dust = s === 'sand' ? [0.74, 0.64, 0.48] : [0.70, 0.66, 0.58];
      this.fx.burst(h.point, n, Math.round(10 * scale), () => ({ size: 0.08 + Math.random() * 0.1, color: dust, alpha: 0.6, life: 0.6 + Math.random() * 0.6, drag: 3.5, grow: 0.5, grav: 0.5 }), 0.7, [0.8, 2.8]);
      this.fx.burst(h.point, refl, Math.round(6 * scale), () => ({ size: 0.02, color: [0.55, 0.52, 0.46], life: 0.5 + Math.random() * 0.4, grav: 12, drag: 1 }), 0.6, [2, 6]);
    }
  }

  /** Bot hit: spray along the shot, splat on the surface behind (bigger and doubled for headshots), a drip on the floor. */
  bloodHit(h, dir, e) {
    const p = h.point, head = h.part === 'head';
    this.fx.burst(p, dir, head ? 20 : 14, () => ({ size: 0.03 + Math.random() * 0.05, color: [0.45 + Math.random() * 0.2, 0.02, 0.02], alpha: 0.9, life: 0.35 + Math.random() * 0.4, grav: 10, drag: 2 }), 0.55, [1.5, 5]);
    this.fx.burst(p, dir, 6, () => ({ size: 0.12, color: [0.4, 0.03, 0.03], alpha: 0.55, life: 0.45, drag: 4, grow: 0.5 }), 0.4, [0.5, 1.5]);
    // splat on the surface behind: any hit within 3.5 m; headshots throw 1-2 large splats within 2 m
    const ray = new THREE.Raycaster(p, dir, 0.05, head ? 2.0 : 3.5);
    const bh = this.map.raycast(ray);
    if (bh) {
      const n = bh.face?.normal.clone().transformDirection(bh.object.matrixWorld) ?? new THREE.Vector3(0, 1, 0);
      if (n.dot(dir) > 0) n.negate();
      if (head) {
        const k = Math.random() < 0.6 ? 2 : 1;
        for (let i = 0; i < k; i++) {
          _side.crossVectors(n, UP); if (_side.lengthSq() < 1e-6) _side.set(1, 0, 0); else _side.normalize();   // floor/ceiling hit: any in-plane axis
          const off = i === 0 ? bh.point : bh.point.clone().addScaledVector(_side, rnd(-0.3, 0.3)).addScaledVector(Math.abs(n.y) > 0.9 ? _c.set(0, 0, 1) : UP, rnd(-0.25, 0.2));
          this._stamp(this.blood, off, n, rnd(0.45, 0.7), this._downRoll(n));
        }
      } else this._stamp(this.blood, bh.point, n, rnd(0.25, 0.5), this._downRoll(n));
    }
    // floor drip below
    const down = new THREE.Raycaster(p, DOWN, 0.05, 2.5);
    const fh = this.map.raycast(down);
    if (fh && Math.random() < 0.7) this._stamp(this.blood, fh.point.clone().add(new THREE.Vector3(rnd(-0.15, 0.15), 0, rnd(-0.15, 0.15))), UP, rnd(0.15, 0.3));
  }

  /** Blood pool under a settled corpse: appears small and spreads to 0.6-0.9 m over ~1.5 s (dark centre, see makePoolAtlas). */
  _spawnPool(bot, headshot) {
    // pelvis (or the group when the rig has no Hips) is where the torso ended up after the fall
    const hips = bot.bones?.Hips || bot.bones?.Spine || bot.group;
    hips.getWorldPosition(_a);
    const ray = new THREE.Raycaster(_b.set(_a.x, _a.y + 0.5, _a.z), DOWN, 0, 2.5);
    const fh = this.map.raycast(ray);
    if (!fh) return;
    const n = fh.face?.normal.clone().transformDirection(fh.object.matrixWorld) ?? UP.clone(); if (n.y < 0) n.negate();
    const size = rnd(0.7, 1.0) * (headshot ? 1.1 : 1);   // decal edge; the pool blob fills ~85 % of it (0.6-0.85 m)
    const pool = this.pools, i = pool.cursor; pool.cursor = (pool.cursor + 1) % pool.n;
    const entry = { pool, i, t: 0, dur: 1.5, size, pos: fh.point.clone(), normal: n, rot: Math.random() * Math.PI * 2, tile: Math.floor(Math.random() * pool.tiles) };
    this._place(pool, i, entry.pos, n, 0.05, entry.rot, entry.tile, [1, 1, 1]);
    this.growing.push(entry);
    // a second, smaller pool at the head end for headshots
    if (headshot && bot.bones?.Head) {
      bot.bones.Head.getWorldPosition(_a);
      const r2 = new THREE.Raycaster(_b.set(_a.x, _a.y + 0.5, _a.z), DOWN, 0, 2.5), h2 = this.map.raycast(r2);
      if (h2 && h2.point.distanceTo(entry.pos) > 0.25) {
        const j = pool.cursor; pool.cursor = (pool.cursor + 1) % pool.n;
        const e2 = { pool, i: j, t: -0.3, dur: 1.3, size: rnd(0.35, 0.5), pos: h2.point.clone(), normal: n, rot: Math.random() * Math.PI * 2, tile: Math.floor(Math.random() * pool.tiles) };
        this._place(pool, j, e2.pos, n, 0.0, e2.rot, e2.tile, [1, 1, 1]);
        this.growing.push(e2);
      }
    }
  }

  // ------------------------------------------------------------ explosion

  /** C4 detonation: flash core, fireball, rising smoke column, ground dust ring, debris, scorch mark. */
  explosion(pos) {
    const up = new THREE.Vector3(0, 1, 0), fx = this.fx;
    const p = pos.clone().add(new THREE.Vector3(0, 0.3, 0));
    // Particles draw in emission order (no depth sort): smoke + dust first so the fireball/flash draw on top.
    // (colours are linear; keep smoke dark or it reads as cream after the sRGB/ACES output)
    fx.burst(p, up, 190, () => {
      const g = 0.05 + Math.random() * 0.09;
      return { size: 0.5 + Math.random() * 0.6, color: [g + 0.02, g, g - 0.01], alpha: 0.9, life: 4 + Math.random() * 5, drag: 1.9, grow: 1.4, grav: -0.3 };
    }, 0.5, [1.5, 5.5]);
    for (let i = 0; i < 70; i++) {
      const a = Math.random() * Math.PI * 2, d = new THREE.Vector3(Math.cos(a), 0.05 + Math.random() * 0.1, Math.sin(a));
      fx.emit(pos.clone().add(new THREE.Vector3(0, 0.2, 0)), d.multiplyScalar(10 + Math.random() * 10),
        { size: 0.5 + Math.random() * 0.4, color: [0.42, 0.34, 0.22], alpha: 0.5, life: 1.2 + Math.random() * 1.0, drag: 2.8, grow: 1.2, grav: 0.4 });
    }
    const pf = pos.clone().add(new THREE.Vector3(0, 0.9, 0));
    fx.burst(pf, up, 130, () => {
      const hot = Math.random() < 0.65;
      return { size: 0.8 + Math.random() * 1.0, color: hot ? [1, 0.7, 0.2] : [1, 0.38, 0.06], alpha: 0.95, life: 0.35 + Math.random() * 0.45, drag: 3.4, grow: 4.0, grav: -3 };
    }, 1.0, [4, 13]);
    fx.burst(p, up, 8, () => ({ size: 1.2 + Math.random() * 1.0, color: [1, 0.9, 0.7], alpha: 1, life: 0.09 + Math.random() * 0.05, drag: 4, grow: 9 }), 0.8, [2, 5]);
    fx.burst(p, up, 90, () => (Math.random() < 0.5
      ? { size: 0.05 + Math.random() * 0.08, color: [0.22, 0.19, 0.16], life: 1 + Math.random() * 1.6, grav: 12, drag: 0.4 }
      : { size: 0.04 + Math.random() * 0.04, color: [1, 0.72, 0.3], life: 0.6 + Math.random() * 1.0, grav: 11, drag: 0.6 }), 0.9, [9, 26]);
    // scorch mark (soft dark blob tiles of the hole atlas, row 2)
    this._stamp(this.holes, pos, up, 4.5, Math.random() * 6, 8, [1, 1, 1]); this._stamp(this.holes, pos, up, 3.2, Math.random() * 6, 9, [1, 1, 1]);
  }

  // ------------------------------------------------------------ tracers + muzzle smoke

  /**
   * Tapered camera-facing ribbons (one indexed quad each, additive). The head flies from the muzzle to the impact in
   * ~40 ms with a streak trailing it; width is a constant ~2.5 px at the head (scaled by view depth), 0 at the tail.
   */
  _makeTracers(n) {
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(n * 4 * 3), col = new Float32Array(n * 4 * 4), uv = new Float32Array(n * 4 * 2);
    const idx = new Uint16Array(n * 6);
    for (let i = 0; i < n; i++) {
      const v = i * 4; idx.set([v, v + 1, v + 2, v + 2, v + 1, v + 3], i * 6);
      uv.set([-1, 0, 1, 0, -1, 1, 1, 1], i * 8);    // (across -1..1, along 0 tail .. 1 head)
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 4).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aUv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    const mat = new THREE.ShaderMaterial({
      vertexShader: /* glsl */`
        attribute vec4 aColor; attribute vec2 aUv; varying vec4 vColor; varying vec2 vUv;
        void main() { vColor = aColor; vUv = aUv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        varying vec4 vColor; varying vec2 vUv;
        void main() {
          float u = abs(vUv.x); float core = 1.0 - u * u;              // soft across the width, bright centre line
          float a = vColor.a * core * core;
          if (a < 0.004) discard;
          gl_FragColor = vec4(mix(vColor.rgb, vec3(1.0, 0.98, 0.9), core * core * 0.5) * a, a);
        }`,
      transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide,
      // additive on colour only: the HDR target's alpha is the sky mask for the sun shafts (Sky.js / PostFX), so the
      // streak must leave alpha alone (plain AdditiveBlending pushes it above 1 -> a dark streak in the shafts pass)
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
    const mesh = new THREE.Mesh(geo, mat); mesh.frustumCulled = false; mesh.renderOrder = 6;
    // keep the floating quads out of any override-material pass (the GTAO normal/depth pre-pass would otherwise bake
    // them as occluders: a dark AO band along the streak). onBeforeRender runs before the draw reads the range.
    mesh.onBeforeRender = (r, scene) => { if (scene.overrideMaterial) geo.setDrawRange(0, 0); };
    mesh.onAfterRender = (r, scene) => { if (scene.overrideMaterial) geo.setDrawRange(0, Infinity); };
    this.scene.add(mesh);
    const items = Array.from({ length: n }, () => ({ alive: false, a: new THREE.Vector3(), d: new THREE.Vector3(), L: 0, start: 0, head: 0, tail: 0, speed: 0, streak: 0 }));
    return { mesh, pos, col, n, items, cursor: 0, camera: null };
  }

  /** Fire a tracer from muzzle `a` to impact `b` (world), plus the muzzle smoke puff. Shared by the player and the bots. */
  tracer(a, b, smoke = true) {
    const t = this.tracers, it = t.items[t.cursor]; t.cursor = (t.cursor + 1) % t.n;
    it.d.copy(b).sub(a); const L = it.d.length(); if (L < 1.5) return;
    it.d.divideScalar(L);
    if (smoke) this.muzzleSmoke(a, it.d);
    it.a.copy(a); it.L = L; it.alive = true;
    // start just ahead of the muzzle: in first person the path is almost end-on, so only its first metres have any screen
    // length - the streak has to leave from the gun to be seen at all (it fades in over the first 0.3 m, see update)
    it.head = it.tail = it.start = Math.min(0.25, L * 0.1);
    it.speed = THREE.MathUtils.clamp(L / 0.04, 250, 900);
    it.streak = THREE.MathUtils.clamp(L * 0.3, 1.2, 4.0);
  }

  /** 2-3 thin smoke wisps at the muzzle, drifting forward and up for ~0.6 s. */
  muzzleSmoke(pos, dir) {
    const fx = this.fx, v = new THREE.Vector3(), p = new THREE.Vector3();
    for (let i = 0; i < 3; i++) {
      p.copy(pos).addScaledVector(dir, 0.05 + i * 0.05);
      v.copy(dir).multiplyScalar(rnd(1.2, 2.2)).addScaledVector(UP, rnd(0.4, 0.9)).add(_c.set(rnd(-0.4, 0.4), rnd(-0.2, 0.2), rnd(-0.4, 0.4)));
      fx.emit(p, v, { size: 0.05 + i * 0.015, color: [0.34, 0.32, 0.30], alpha: 0.4, life: rnd(0.45, 0.65), drag: 3.2, grow: 0.45, grav: -0.9 });
    }
  }

  /** Per-frame: tracer flight, blood-pool growth, corpses waiting for their pool. `camera` is needed for the billboarding. */
  update(dt, camera) {
    const t = this.tracers, P = t.pos, C = t.col;
    const cam = camera || (this._cam ||= this.scene.getObjectByProperty('isPerspectiveCamera', true));   // Game parents the main camera to the scene
    const camPos = cam ? cam.getWorldPosition(_c) : _c.set(0, 0, 0);
    const pxK = cam ? 2.5 * 2 * Math.tan(cam.fov * 0.5 * Math.PI / 180) / Math.max(1, innerHeight) : 0.0045;   // world width per metre of depth for ~2.5 px
    this.holes.mesh.material.userData.uniforms.uPxK.value = pxK / 2.5;                                          // per pixel, for the minimum hole size
    let dirty = false;
    for (let i = 0; i < t.n; i++) {
      const it = t.items[i]; if (!it.alive) continue;
      dirty = true;
      it.head = Math.min(it.L, it.head + it.speed * dt);
      it.tail = Math.max(it.tail, it.head - it.streak);
      if (it.head >= it.L) it.tail += it.speed * dt;          // head arrived: the streak runs into the wall
      if (it.tail >= it.L - 1e-3) { it.alive = false; P.fill(0, i * 12, i * 12 + 12); continue; }
      _a.copy(it.a).addScaledVector(it.d, it.tail); _b.copy(it.a).addScaledVector(it.d, it.head);
      _side.copy(_b).sub(camPos).cross(it.d).normalize();
      const wh = 0.5 * pxK * _b.distanceTo(camPos), wt = 0.5 * pxK * _a.distanceTo(camPos) * 0.35;   // half-widths
      // fade in over the first 0.3 m (no full-bright pop at the muzzle) and out as the streak runs into the surface
      const fade = Math.min(1, (it.head - it.start) / 0.3) * (it.head >= it.L ? Math.max(0, 1 - (it.tail - (it.L - it.streak)) / it.streak) : 1);
      const ah = 0.75 * fade;
      const o = i * 12;
      P[o] = _a.x - _side.x * wt; P[o + 1] = _a.y - _side.y * wt; P[o + 2] = _a.z - _side.z * wt;
      P[o + 3] = _a.x + _side.x * wt; P[o + 4] = _a.y + _side.y * wt; P[o + 5] = _a.z + _side.z * wt;
      P[o + 6] = _b.x - _side.x * wh; P[o + 7] = _b.y - _side.y * wh; P[o + 8] = _b.z - _side.z * wh;
      P[o + 9] = _b.x + _side.x * wh; P[o + 10] = _b.y + _side.y * wh; P[o + 11] = _b.z + _side.z * wh;
      const c = i * 16;
      for (let k = 0; k < 4; k++) { C[c + k * 4] = 1.0; C[c + k * 4 + 1] = 0.86; C[c + k * 4 + 2] = 0.55; C[c + k * 4 + 3] = k < 2 ? 0 : ah; }
    }
    if (dirty) { t.mesh.geometry.attributes.position.needsUpdate = true; t.mesh.geometry.attributes.aColor.needsUpdate = true; }

    // blood pools: ease-out spread
    for (let i = this.growing.length - 1; i >= 0; i--) {
      const g = this.growing[i]; g.t += dt;
      if (g.t < 0) continue;
      const k = Math.min(1, g.t / g.dur), e = 1 - Math.pow(1 - k, 2.2);
      this._place(g.pool, g.i, g.pos, g.normal, g.size * (0.08 + 0.92 * e), g.rot, g.tile, [1, 1, 1]);
      if (k >= 1) this.growing.splice(i, 1);
    }
    for (let i = this.pendingPools.length - 1; i >= 0; i--) {
      const q = this.pendingPools[i]; q.t -= dt;
      if (q.t <= 0) { this.pendingPools.splice(i, 1); this._spawnPool(q.bot, q.headshot); }
    }
  }
}

// ------------------------------------------------------------ textures

function atlas(cols, rows, cell, draw) {
  const c = document.createElement('canvas'); c.width = cols * cell; c.height = rows * cell;
  const x = c.getContext('2d');
  for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) {
    x.save(); x.beginPath(); x.rect(col * cell, (rows - 1 - r) * cell, cell, cell); x.clip();
    draw(x, col * cell, (rows - 1 - r) * cell, cell, r * cols + col, r);   // row r is drawn from the bottom: flipY textures put v=0 at the canvas bottom
    x.restore();
  }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

/** Jagged closed path around (cx, cy): radius r with ±k noise. */
function blob(x, cx, cy, r, k = 0.3, n = 16) {
  x.beginPath();
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 6.2832, rr = r * (1 + (Math.random() - 0.5) * 2 * k);
    const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr;
    i ? x.lineTo(px, py) : x.moveTo(px, py);
  }
  x.closePath();
}

/**
 * Bullet-hole atlas (4 x 3 tiles of 128 px; a tile is the whole ~4 cm decal):
 *   row 0  crater: small dark-grey pit (~30 % of the radius), pale chipped-plaster ring around it (lighter than the wall:
 *          the exposed substrate, brighter on the +Y / sun side), 2-4 short cracks, a very faint tight dust smudge   (plaster / sand)
 *   row 1  dent:   small dark core, dark torn rim, one bright scratch, faint soot                                    (wood / metal)
 *   row 2  scorch: soft dark blob (C4)
 * Up close the pale chip reads more than the hole; the hole itself is grey, not ink-black.
 */
function makeHoleAtlas() {
  return atlas(4, 3, 128, (x, ox, oy, s, idx, row) => {
    const cx = ox + s / 2, cy = oy + s / 2;
    if (row === 2) {
      const g = x.createRadialGradient(cx, cy, 0, cx, cy, s / 2);
      g.addColorStop(0, 'rgba(0,0,0,0.95)'); g.addColorStop(0.35, 'rgba(0,0,0,0.85)'); g.addColorStop(0.6, 'rgba(40,35,30,0.35)'); g.addColorStop(1, 'rgba(60,55,50,0)');
      x.fillStyle = g; x.fillRect(ox, oy, s, s);
      x.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 6; i++) { const a = Math.random() * 6.28, r = s * 0.34; x.beginPath(); x.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, s * 0.09, 0, 6.28); x.fill(); }
      x.globalCompositeOperation = 'source-over';
      return;
    }
    const dent = row === 1;
    const R = s * 0.5, rc = dent ? R * 0.26 : R * 0.30;   // pit radius: ~1.2 cm on a 4 cm plaster decal
    // dust smudge: very faint and tight (it must not smear neighbouring holes into one blob); soot on metal/wood
    const halo = x.createRadialGradient(cx, cy, rc * 1.2, cx, cy, R * 0.9);
    if (dent) { halo.addColorStop(0, 'rgba(25,22,20,0.22)'); halo.addColorStop(0.5, 'rgba(25,22,20,0.08)'); halo.addColorStop(1, 'rgba(25,22,20,0)'); }
    else { halo.addColorStop(0, 'rgba(90,80,70,0.12)'); halo.addColorStop(0.5, 'rgba(110,100,90,0.05)'); halo.addColorStop(1, 'rgba(120,110,100,0)'); }
    x.fillStyle = halo; x.beginPath(); x.arc(cx, cy, R * 0.9, 0, 6.2832); x.fill();
    if (!dent) {
      // chipped ring: sparse, uneven flakes of exposed substrate around the pit. The chip is the same plaster minus its dust,
      // so it is only slightly lighter than the wall: a mid-light neutral at low alpha (it is alpha-blended over the wall, so
      // in sun it lifts the surface a little and in shadow it stays inside the shadow's range - never a white ring).
      const nf = 6 + Math.floor(Math.random() * 4), a0 = rnd(0, 6.2832);
      for (let i = 0; i < nf; i++) {
        const a = a0 + (i / nf) * 6.2832 + rnd(-0.35, 0.35), sun = 0.5 + 0.5 * -Math.sin(a);   // canvas -y (top) faces the sun after _sunRoll
        const r = rc * rnd(0.95, 1.5), fr = rc * rnd(0.3, 0.7) * (0.7 + 0.4 * sun);
        const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r, al = (0.18 + 0.14 * sun) * rnd(0.8, 1.0);
        const g = x.createRadialGradient(px, py, 0, px, py, fr);
        g.addColorStop(0, `rgba(200,190,175,${al.toFixed(2)})`); g.addColorStop(0.55, `rgba(200,190,175,${(al * 0.65).toFixed(2)})`); g.addColorStop(1, 'rgba(200,190,175,0)');
        x.fillStyle = g; x.beginPath(); x.arc(px, py, fr, 0, 6.2832); x.fill();
      }
      // a few detached specks further out
      for (let i = 0; i < 2 + Math.floor(Math.random() * 3); i++) {
        const a = rnd(0, 6.2832), r = rc * rnd(1.7, 2.6), fr = rc * rnd(0.1, 0.22);
        x.fillStyle = `rgba(200,190,175,${rnd(0.16, 0.28).toFixed(2)})`; x.beginPath(); x.arc(cx + Math.cos(a) * r, cy + Math.sin(a) * r, fr, 0, 6.2832); x.fill();
      }
      // broken lip right at the pit edge: a slightly lighter arc on the sun side, a slightly darker one in its shadow
      x.lineCap = 'round';
      x.strokeStyle = 'rgba(200,190,175,0.28)'; x.lineWidth = rc * 0.22;
      x.beginPath(); x.arc(cx, cy, rc * 1.15, -1.5708 - 1.2 + rnd(-0.3, 0.3), -1.5708 + 1.0 + rnd(-0.3, 0.3)); x.stroke();
      x.strokeStyle = 'rgba(40,34,30,0.30)'; x.lineWidth = rc * 0.16;
      x.beginPath(); x.arc(cx, cy, rc * 1.12, 1.5708 - 1.0, 1.5708 + 1.0); x.stroke();
    } else {
      blob(x, cx, cy, rc * 1.4, 0.18, 14); x.fillStyle = 'rgba(20,20,22,0.35)'; x.fill();
      x.strokeStyle = 'rgba(15,15,17,0.4)'; x.lineWidth = rc * 0.3; x.stroke();
    }
    // 2-4 short cracks out of the pit
    x.strokeStyle = dent ? 'rgba(12,10,8,0.7)' : 'rgba(45,38,32,0.6)'; x.lineCap = 'round';
    const nc = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < nc; i++) {
      let a = rnd(0, 6.2832), r = rc * 0.8; const len = rc * rnd(0.8, 1.6);
      x.lineWidth = rnd(1, 1.6); x.beginPath(); x.moveTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      for (let k = 0; k < 3; k++) { r += len / 3; a += rnd(-0.35, 0.35); x.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
      x.stroke();
    }
    // pit: jagged, dark grey (#2a2622-ish at ~0.6-0.8, not a black dot), a touch deeper at the centre
    blob(x, cx, cy, rc, dent ? 0.22 : 0.28, 14);
    const core = x.createRadialGradient(cx, cy, 0, cx, cy, rc * 1.1);
    core.addColorStop(0, 'rgba(30,27,24,0.8)'); core.addColorStop(0.6, 'rgba(42,38,34,0.72)'); core.addColorStop(1, 'rgba(52,47,42,0.6)');
    x.fillStyle = core; x.fill();
    // metal/wood dent: one bright scratch across the lip (a bare-metal / fresh-fibre gash)
    if (dent) {
      const a = rnd(0, 6.2832), l = s * rnd(0.16, 0.26);
      x.strokeStyle = 'rgba(245,245,250,0.9)'; x.lineWidth = rnd(1.5, 2.5);
      x.beginPath(); x.moveTo(cx + Math.cos(a) * rc * 0.4, cy + Math.sin(a) * rc * 0.4); x.lineTo(cx + Math.cos(a) * (rc * 0.4 + l), cy + Math.sin(a) * (rc * 0.4 + l)); x.stroke();
      x.strokeStyle = 'rgba(255,255,255,0.55)'; x.lineWidth = 1;
      x.beginPath(); x.arc(cx, cy, rc * 1.0, a - 0.9, a + 0.6); x.stroke();
    }
  });
}

/**
 * Blood splats (2 x 2 variants), the CS2 read: a dark, semi-transparent blob (#4a0a0a..#5c1010, alpha ~0.85 in the core
 * fading to soft edges so the wall texture shows through), fine directional spatter, and 1-3 thin drips hanging down
 * (canvas +y = decal -Y = down once _place rolls the decal; the headshot stamps use a random roll, so "down" is only a
 * texture-space convention that keeps the drips coherent with the blob they hang from).
 */
function makeSplatAtlas() {
  return atlas(2, 2, 128, (x, ox, oy, s) => {
    const cx = ox + s / 2, cy = oy + s / 2;
    const dir = rnd(0, 6.2832);        // spatter streaks away in one direction
    // main blob: 3-4 overlapping drops, each a dark core with a wide soft falloff (the overlap builds the ~0.85 centre)
    const cores = [];
    for (let i = 0; i < 4; i++) {
      const r = s * rnd(0.15, 0.24), a = rnd(0, 6.2832), d = rnd(0, s * 0.07);
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d; cores.push([px, py, r]);
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(74,10,10,0.62)'); g.addColorStop(0.45, 'rgba(84,14,14,0.50)'); g.addColorStop(0.8, 'rgba(92,16,16,0.22)'); g.addColorStop(1, 'rgba(92,16,16,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 6.2832); x.fill();
    }
    // fine spatter fanning out (small, mostly translucent)
    for (let i = 0; i < 30; i++) {
      const r = s * rnd(0.012, 0.05), a = dir + rnd(-0.9, 0.9), d = rnd(0.12, 0.44) * s;
      const px = cx + Math.cos(a) * d, py = cy + Math.sin(a) * d;
      const g = x.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, 'rgba(80,12,12,0.8)'); g.addColorStop(0.6, 'rgba(88,15,15,0.55)'); g.addColorStop(1, 'rgba(92,16,16,0)');
      x.fillStyle = g; x.beginPath(); x.arc(px, py, r, 0, 6.2832); x.fill();
    }
    // 1-3 thin drips running down from the lower half of the blob: tapering line, a slightly heavier bead at the end
    const nd = 1 + Math.floor(Math.random() * 3);
    x.lineCap = 'round';
    for (let i = 0; i < nd; i++) {
      const [bx, by, br] = cores[Math.floor(Math.random() * cores.length)];
      const px = bx + rnd(-0.6, 0.6) * br, y0 = by + br * rnd(0.3, 0.7), len = s * rnd(0.14, 0.34), w = rnd(1.4, 2.6);
      const x1 = px + rnd(-2, 2), y1 = y0 + len;
      const g = x.createLinearGradient(px, y0, x1, y1);
      g.addColorStop(0, 'rgba(78,12,12,0.85)'); g.addColorStop(0.7, 'rgba(84,14,14,0.75)'); g.addColorStop(1, 'rgba(84,14,14,0.45)');
      x.strokeStyle = g; x.lineWidth = w; x.beginPath(); x.moveTo(px, y0); x.quadraticCurveTo(px + (x1 - px) * 0.4, y0 + len * 0.6, x1, y1); x.stroke();
      x.lineWidth = w * 0.55; x.beginPath(); x.moveTo(px + (x1 - px) * 0.5, y0 + len * 0.5); x.lineTo(x1, y1); x.stroke();   // thinner lower half
      x.fillStyle = 'rgba(80,12,12,0.85)'; x.beginPath(); x.arc(x1, y1, w * 0.9, 0, 6.2832); x.fill();                        // bead
    }
  });
}

/** Blood pools (2 variants): jagged outline, very dark centre (deep, glossy read), slightly redder thin edge. */
function makePoolAtlas() {
  return atlas(2, 1, 128, (x, ox, oy, s) => {
    const cx = ox + s / 2, cy = oy + s / 2;
    blob(x, cx, cy, s * 0.42, 0.16, 22);
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, s * 0.5);
    g.addColorStop(0, 'rgba(22,1,2,0.98)'); g.addColorStop(0.55, 'rgba(48,3,5,0.95)'); g.addColorStop(0.85, 'rgba(78,6,8,0.9)'); g.addColorStop(1, 'rgba(90,8,10,0.75)');
    x.fillStyle = g; x.fill();
    // a few separate drops around the edge
    for (let i = 0; i < 8; i++) {
      const a = rnd(0, 6.2832), d = s * rnd(0.4, 0.47), r = s * rnd(0.015, 0.035);
      x.fillStyle = 'rgba(70,5,7,0.9)'; x.beginPath(); x.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, r, 0, 6.2832); x.fill();
    }
  });
}
