import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RENDER, SUN, PLAYER } from '../core/Constants.js';
import { WEAPONS } from './WeaponDefs.js';
import { weaponTextureSets } from './WeaponTextures.js';
import { makeFlashTextures } from '../fx/MuzzleFlash.js';
import { bus, Events } from '../core/EventBus.js';

const ss = (a, b, x) => { const t = THREE.MathUtils.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const _q = new THREE.Quaternion(), _v = new THREE.Vector3(), _e = new THREE.Euler();
const _qp = new THREE.Quaternion(), _ep = new THREE.Euler(0, 0, 0, 'YXZ');
const D2R = Math.PI / 180, lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;
const SWAY_MAX = 1.5 * D2R;       // mouse-lag sway: the gun trails the view by up to 1.5°, ~80 ms behind
const SWAY_TAU = 0.08;
const SWAY_GAIN = 0.006;          // rad of sway per rad/s of view angular velocity (a 2.5 rad/s aim = 0.9°)
const DEFAULT_KICK = { back: 0.03, up: 2.5, roll: 0.6, yaw: 0.4, omega: 46, zeta: 0.8 };
/** One exact step of an under-damped spring (x, v) with cs = e^-ζωt cos ωd t, sn = e^-ζωt sin(ωd t) / ωd, zw = ζω, w2 = ω². */
function springStep(K, xk, vk, cs, sn, zw, w2) {
  const x = K[xk], v = K[vk];
  K[xk] = x * cs + (v + zw * x) * sn;
  K[vk] = v * cs - (w2 * x + zw * v) * sn;
}

/**
 * Edge wear for the steel / phosphate parts. The GLBs carry a curvature proxy in COLOR_0.r (sharpest convex edge
 * angle at the vertex, baked in tools/build_weapons.py). Blend to bare metal along edges, broken up by the wear-noise
 * mask packed into the steel / polymer roughness map's R channel; worn material is smoother (wearRough, bare metal
 * 0.28) than the finish around it. Also used for the AWP polymer (wearColor = scuffed bare dark polymer).
 */
function addEdgeWear(m, wearColor, amount, wearRough = 0.28) {
  m.customProgramCacheKey = () => `wear`;
  m.onBeforeCompile = (s) => {
    s.uniforms.uWearColor = { value: new THREE.Color(...wearColor) };
    s.uniforms.uWearAmt = { value: amount };
    s.uniforms.uWearRough = { value: wearRough };
    s.vertexShader = s.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec4 color;\nvarying float vWear;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWear = color.r;');
    s.fragmentShader = s.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWear;\nuniform vec3 uWearColor;\nuniform float uWearAmt;\nuniform float uWearRough;')
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        #ifdef USE_ROUGHNESSMAP
          float wearN = texture2D( roughnessMap, vRoughnessMapUv ).r;
        #else
          float wearN = 0.5;
        #endif
        float wear = smoothstep( 0.50, 0.95, vWear * uWearAmt * ( 0.25 + 1.5 * wearN ) );
        diffuseColor.rgb = mix( diffuseColor.rgb, uWearColor, wear );
        roughnessFactor = mix( roughnessFactor, uWearRough, wear );`);
  };
}

function applySet(m, set, { color, roughness = 1, metalness, normalScale } = {}) {
  if (set.map) m.map = set.map;
  if (set.normalMap) { m.normalMap = set.normalMap; const ns = normalScale ?? set.normalScale ?? 1; m.normalScale.set(ns, ns); }
  if (set.roughnessMap) m.roughnessMap = set.roughnessMap;
  if (color) m.color.setRGB(...color);
  m.roughness = roughness;
  if (metalness !== undefined) m.metalness = metalness;
  m.needsUpdate = true;
}

/**
 * First-person weapon renderer. Camera-space scene rendered in a second pass over the world
 * (depth cleared) so the gun never clips into walls. All animation is procedural.
 */
export class ViewModel {
  constructor(renderer, mainScene, mainCamera) {
    this.renderer = renderer; this.mainScene = mainScene; this.mainCamera = mainCamera;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(RENDER.VM_FOV, innerWidth / innerHeight, 0.01, 6);
    this.sun = new THREE.DirectionalLight(SUN.COLOR, SUN.INTENSITY * 0.5);
    this.hemi = new THREE.HemisphereLight(SUN.SKY_COLOR, SUN.GROUND_COLOR, SUN.HEMI_INTENSITY * 1.3);   // the hands face away from the sun most of the time: more fill than the world so the glove detail reads
    this.scene.add(this.sun, this.hemi);
    this.scene.environmentIntensity = SUN.ENV_INTENSITY * 1.3;   // diffuse sky fill on cloth/wood/polymer; metals use their own envMap (see _dress)
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.weapons = {}; this.active = null;
    this.sunDir = new THREE.Vector3(...SUN.DIR).normalize();

    // animation state
    this.kick = { z: 0, vz: 0, rx: 0, vrx: 0, ry: 0, vry: 0, rz: 0, vrz: 0 };   // fire-kick springs (def.kick.omega / zeta)
    this.sway = new THREE.Vector2();   // mouse-lag sway (rad): x = yaw, y = pitch
    this.bobT = 0;                     // stride phase: a footstep lands at every multiple of PI (re-synced from PLAYER_FOOTSTEP)
    this.lower = 0; this.idleT = 0;
    this.anim = null;          // { type, t, dur }
    this.hidden = false;
    bus.on(Events.PLAYER_FOOTSTEP, (e) => { if (e.kind === 'step') this.bobT = Math.round(this.bobT / Math.PI) * Math.PI; });

    // muzzle flash sprite (camera-space): one of several chunky variants per shot, random roll/scale, ~2 frames with a fast fade
    this.flashTextures = makeFlashTextures(4);
    for (const t of this.flashTextures) renderer.initTexture(t);   // uploaded now, not on the first shot (same program for all: only the map changes)
    this.flash = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTextures[0], color: 0xffe0b0, transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false }));
    this.flash.visible = false; this.flash.scale.setScalar(0.14);
    this.scene.add(this.flash);
    this.flashT = 0; this.flashT0 = 0.04; this.flashPeak = 0;
    // 1-2 frame warm light at the muzzle so the flash lights the handguard / hands. Lives in the viewmodel scene permanently
    // at intensity 0 (three bakes the light count into the programs; see Bomb.js) and only its intensity changes.
    this.flashLight = new THREE.PointLight(0xffb060, 0, 2.5, 2);
    this.scene.add(this.flashLight);
    addEventListener('resize', () => { this.camera.aspect = innerWidth / innerHeight; this.camera.updateProjectionMatrix(); });
  }

  /**
   * Material dressing. The GLBs carry flat Principled colours and box-projected UVs; everything that makes the
   * weapons read as leather/fabric/wood/steel is procedural (WeaponTextures.js) and applied here by material name:
   *   glove (knuckle fabric) / glove_palm (leather) / sleeve (rip-stop) / gun_wood / gun_bakelite /
   *   gun_steel (blued) / gun_steel_light (phosphate dust cover + mag) / gun_black (anodised / parkerized small parts) /
   *   awp_green (speckled polymer) / gun_rubber / scope_glass (lens discs) / knife_blade / knife_edge / knife_handle / brass.
   * Metals get the world PMREM assigned directly (material.envMap) so their reflection strength is independent of the
   * low scene.environmentIntensity used for the diffuse fill (three ignores material.envMapIntensity otherwise).
   * Steel colours are the sRGB targets from the art review: blued #1b1d22, worn bare metal #8a8d90 (roughness 0.28).
   */
  _dress(m, tex) {
    if (this._dressed.has(m)) return; this._dressed.add(m);
    m.vertexColors = false;                     // COLOR_0 is the wear mask, not a tint (GLTFLoader turns this on)
    const n = m.name;
    const BARE = [0.256, 0.268, 0.282];         // #8a8d90 linear
    if (/^glove_palm/.test(n)) applySet(m, tex.leather, { color: [1, 1, 1] });      // cloth albedos are absolute in the maps (#3a3634 Amara palm,
    else if (/^glove/.test(n)) applySet(m, tex.fabric, { color: [1, 1, 1] });       // #2a2c2e nylon knit, #4b4f47 rip-stop): no tint multiplier
    else if (/^sleeve/.test(n)) applySet(m, tex.ripstop, { color: [1, 1, 1] });
    else if (/^gun_wood/.test(n)) applySet(m, tex.wood, { color: [1, 1, 1] });
    else if (/^gun_bakelite/.test(n)) applySet(m, tex.bakelite, { color: [1, 1, 1], roughness: 0.30 });
    else if (/^gun_steel_light/.test(n)) { applySet(m, tex.steel, { color: [0.024, 0.027, 0.031], roughness: 0.50, metalness: 0.9 }); addEdgeWear(m, [0.16, 0.17, 0.18], 0.42); this._envMats.push([m, 0.9]); }   // stamped dust cover / mag: a shade greyer; its wide rounded bevels are all "edge", so only faint scuffs
    else if (/^gun_steel/.test(n)) { applySet(m, tex.steel, { color: [0.011, 0.0123, 0.016], roughness: 0.45, metalness: 0.9 }); addEdgeWear(m, BARE, 1.0); this._envMats.push([m, 0.9]); }             // blued receiver / barrel: dark, highlight line on the bevels
    else if (/^gun_black/.test(n)) { applySet(m, tex.steel, { color: [0.0056, 0.0060, 0.0070], roughness: 0.48, metalness: 0.85 }); addEdgeWear(m, [0.19, 0.19, 0.20], 0.7); this._envMats.push([m, 0.8]); }   // anodised / parkerized small parts, scope + barrel: slight sheen
    else if (/^awp_green/.test(n)) { applySet(m, tex.polymer, { color: [0.105, 0.135, 0.075], roughness: 0.75, metalness: 0, normalScale: 0.3 }); addEdgeWear(m, [0.030, 0.036, 0.024], 0.55, 0.42); }    // cast polymer; isolated scuffs on the bevels to smoother, darker bare polymer (not metal)
    else if (/^gun_rubber/.test(n)) applySet(m, tex.speckle, { color: [0.012, 0.012, 0.012], roughness: 0.85, metalness: 0, normalScale: 0.6 });
    else if (/^scope_glass/.test(n)) {          // coated lens: tinted glass map + emissive specular highlight decal, strong sky reflection
      m.map = tex.lens.map; m.emissiveMap = tex.lens.emissiveMap; m.emissive.setRGB(1, 1, 1); m.emissiveIntensity = 1.1;
      m.color.setRGB(1, 1, 1); m.roughness = 0.05; m.metalness = 0.9; m.transparent = false; m.opacity = 1; this._envMats.push([m, 2.6]);
    }
    else if (/^knife_blade/.test(n)) { applySet(m, tex.steel, { color: [0.36, 0.37, 0.38], roughness: 0.25, metalness: 1 }); this._envMats.push([m, 0.75]); }   // satin flats + fuller
    else if (/^knife_edge/.test(n)) { m.color.setRGB(0.78, 0.79, 0.81); m.roughness = 0.08; m.metalness = 1; this._envMats.push([m, 1.6]); }                     // polished chamfer strip
    else if (/^knife_handle/.test(n)) applySet(m, tex.speckle, { color: [0.030, 0.030, 0.033], roughness: 0.70, metalness: 0, normalScale: 0.7 });               // G10 / rubber
    else if (/^brass/.test(n)) this._envMats.push([m, 1.4]);
    m.needsUpdate = true;
  }

  async load() {
    const loader = new GLTFLoader();
    const tex = weaponTextureSets();
    this._dressed = new Set(); this._envMats = [];
    await Promise.all(Object.entries(WEAPONS).map(async ([id, def]) => {
      const g = await loader.loadAsync(def.model);
      const grp = new THREE.Group(); grp.name = id;
      grp.add(g.scene);
      const nodes = {};
      g.scene.traverse((o) => {
        nodes[o.name] = o;
        if (o.isMesh) {
          o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false;
          this._dress(o.material, tex);
        }
      });
      grp.scale.setScalar(def.view.scale);
      grp.visible = false;
      this.root.add(grp);
      // The rebuilt AK GLB exports HandL and Mag as groups sitting at the gun origin with their mesh vertices in gun space
      // (the AWP's Mag kept a real pivot). The reload rotates both (_applyAnim: hand tilt, mag tumble); about the origin that
      // swings the whole part through a ~20 cm arc -- the hand detached from the forearm, the dropped mag left the frame.
      // Re-pivot such nodes onto their own centre: same world placement, the rotation becomes a local tilt. Done before the
      // *Home poses are captured so the animation offsets stay relative to the new pivot.
      for (const name of ['HandL', 'Mag']) {
        const node = nodes[name];
        if (!node || node.position.lengthSq() > 1e-10 || !node.children.length) continue;
        const bb = new THREE.Box3();
        for (const c of node.children) { if (!c.isMesh) continue; c.updateMatrix(); if (!c.geometry.boundingBox) c.geometry.computeBoundingBox(); bb.union(new THREE.Box3().copy(c.geometry.boundingBox).applyMatrix4(c.matrix)); }
        if (bb.isEmpty()) continue;
        const ctr = bb.getCenter(new THREE.Vector3()); node.position.copy(ctr); for (const c of node.children) c.position.sub(ctr);
      }
      this.weapons[id] = { def, group: grp, nodes, mag: nodes.Mag, handL: nodes.HandL, armL: nodes.ArmL, muzzle: nodes.Muzzle, eject: nodes.Eject, magHome: nodes.Mag?.position.clone(), handLHome: nodes.HandL?.position.clone(), handLRotHome: nodes.HandL?.rotation.clone(), armLHome: nodes.ArmL?.position.clone() };
    }));
    return this;
  }

  setActive(id) {
    for (const w of Object.values(this.weapons)) w.group.visible = false;
    this.active = this.weapons[id] || null;
    if (this.active) { this.active.group.visible = true; this._resetParts(this.active); }
  }

  _resetParts(w) {
    if (w.mag) { w.mag.position.copy(w.magHome); w.mag.rotation.set(0, 0, 0); w.mag.visible = true; }
    if (w.handL) { w.handL.position.copy(w.handLHome); w.handL.rotation.copy(w.handLRotHome); }
    if (w.armL) w.armL.position.copy(w.armLHome);
  }

  /** Start a timed animation: 'draw' | 'reload' | 'bolt' | 'slash' | 'stab' */
  play(type, dur) { this.anim = { type, t: 0, dur }; if (this.active && type === 'reload') this._resetParts(this.active); }

  /**
   * Recoil kick from a shot: a velocity impulse into the pose springs, sized so a critically damped return peaks at
   * def.kick.back (m, along the barrel) / up (deg) / random roll ±roll / yaw ±yaw one 1/omega later (peak of v·t·e^-ωt = v/(eω)).
   */
  fire(def) {
    const k = def.kick ?? DEFAULT_KICK, s = Math.E * (k.omega ?? DEFAULT_KICK.omega), K = this.kick;
    K.vz += k.back * s;                       // +Z local = rearward along the barrel (into the shoulder)
    K.vrx += (k.up ?? 0) * D2R * s;
    K.vrz += (k.roll ?? 0) * D2R * s * (Math.random() < 0.5 ? -1 : 1) * (0.6 + 0.4 * Math.random());
    K.vry += (k.yaw ?? 0) * D2R * s * (Math.random() * 2 - 1);
    this.flashT = this.flashT0; this.flash.visible = true;
    this.flash.material.map = this.flashTextures[Math.floor(Math.random() * this.flashTextures.length)];
    this.flash.material.rotation = Math.random() * Math.PI * 2;
    this.flash.material.opacity = 1;
    this.flash.scale.setScalar(0.19 * (0.85 + Math.random() * 0.4));
    this.flashPeak = 2.0 + Math.random() * 0.5; this.flashLight.intensity = this.flashPeak;
  }

  /** World-space position of a named node on the active weapon (Muzzle / Eject). */
  worldPos(name, out = new THREE.Vector3()) {
    const n = this.active?.nodes[name]; if (!n) return out.copy(this.mainCamera.position);
    n.getWorldPosition(out);                 // vm-scene space == camera space (VM_FOV)
    // The viewmodel is drawn with its own (narrower) FOV, so a naive camera->world mapping puts the muzzle
    // at the wrong screen position in the main scene (tracers appear to leave the player's body).
    // Keep the *screen* position: project with the VM camera, then re-place at the same view depth with the main camera's FOV.
    const depth = -out.z;
    out.project(this.camera);
    const mc = this.mainCamera, tanY = Math.tan(mc.fov * 0.5 * Math.PI / 180);
    out.set(out.x * tanY * mc.aspect * depth, out.y * tanY * depth, -depth);
    return mc.localToWorld(out);
  }

  /**
   * Per-frame pose. ctx: { player, mouseDX, mouseDY (px this frame), scoped, ads (0..1 eased blend, AK), punch (aim punch,
   * deg, Vector2), punchTrack (share of it the camera follows), holster }. Everything composes onto the hip <-> ADS pose:
   * fire-kick springs, mouse-lag sway, stride bob (in phase with the footsteps), landing dip, idle breathing, the timed
   * animations, and finally the gun's share of the aim punch as a rotation about the eye so the barrel / sight points where
   * the bullets go. No allocation: scratch objects are module-level.
   */
  update(dt, ctx) {
    const w = this.active; if (!w) return;
    const { player, mouseDX, mouseDY, scoped } = ctx;
    const ads = ctx.ads ?? 0, adsDef = w.def.ads;
    const def = w.def; const view = def.view;
    const motion = 1 - 0.7 * ads;             // bob / sway / breathing at 30 % while aiming down the sights

    // VM camera FOV narrows with the ADS blend (projection only: no material / program change)
    const vmFov = adsDef && ads > 0 ? lerp(RENDER.VM_FOV, adsDef.vmFov ?? RENDER.VM_FOV, ads) : RENDER.VM_FOV;
    if (this.camera.fov !== vmFov) { this.camera.fov = vmFov; this.camera.updateProjectionMatrix(); }

    // lighting follows the world sun in camera space; env map rotated the same way
    _q.copy(this.mainCamera.quaternion).invert();
    this.sun.position.copy(this.sunDir).applyQuaternion(_q).multiplyScalar(5);
    const env = this.mainScene.environment;
    this.scene.environment = env;
    _e.setFromQuaternion(_q); this.scene.environmentRotation.copy(_e);
    // metals reflect the sky directly (own envMap + intensity); same rotation so the reflection stays world-locked
    for (const [m, k] of this._envMats) { if (m.envMap !== env) { m.envMap = env; m.envMapIntensity = k; m.needsUpdate = true; } m.envMapRotation.copy(_e); }

    // --- fire-kick springs x'' = -ω²x - 2ζωx', advanced with the exact damped-oscillator solution: at ω 46 / ζ 0.8 a 60 Hz
    // Euler step (2ζω·dt = 1.2) flips the velocity on the first frame, so the gun would kick the wrong way.
    const K = this.kick, kd = def.kick ?? DEFAULT_KICK, om = kd.omega ?? DEFAULT_KICK.omega, zeta = Math.min(kd.zeta ?? DEFAULT_KICK.zeta, 0.995);
    if (dt > 0) {
      const wd = om * Math.sqrt(1 - zeta * zeta), zw = zeta * om, e = Math.exp(-zw * dt), cs = e * Math.cos(wd * dt), sn = e * Math.sin(wd * dt) / wd, w2 = om * om;
      springStep(K, 'z', 'vz', cs, sn, zw, w2); springStep(K, 'rx', 'vrx', cs, sn, zw, w2); springStep(K, 'ry', 'vry', cs, sn, zw, w2); springStep(K, 'rz', 'vrz', cs, sn, zw, w2);
    }

    // --- mouse-lag sway: the gun trails the view (rotates opposite to this frame's look delta), clamped, ~80 ms behind.
    // View deltas this frame: yaw -= dx * sens, pitch -= dy * sens => angular velocity in rad/s (frame-rate independent).
    if (dt > 0) {
      const sens = player.input?.sensitivity ?? 0, inv = 1 / dt;
      const tx = clamp(mouseDX * sens * inv * SWAY_GAIN, -SWAY_MAX, SWAY_MAX) * motion;    // mouse right (dx > 0): the view yaws right, the gun trails => yaws left (+rotation.y)
      const ty = clamp(mouseDY * sens * inv * SWAY_GAIN, -SWAY_MAX, SWAY_MAX) * motion;    // mouse down (dy > 0): the view pitches down, the gun trails => muzzle up (+rotation.x)
      const k = 1 - Math.exp(-dt / SWAY_TAU);
      this.sway.x += (tx - this.sway.x) * k; this.sway.y += (ty - this.sway.y) * k;
    }

    // --- stride bob (figure-8): phase advances with distance travelled at the footstep stride, so every multiple of PI is
    // a foot plant (the PLAYER_FOOTSTEP handler snaps it there): y dips once per step, x swings side to side once per pair.
    const sf = player.grounded ? player.speedFrac : 0;
    if (sf > 0.05) this.bobT += dt * player.hSpeed / (PLAYER.STRIDE * (player.crouching ? 0.75 : 1)) * Math.PI;
    const bobA = 0.009 * sf * (player.crouching ? 0.6 : 1) * motion;
    const bobX = Math.sin(this.bobT) * bobA, bobY = -(0.5 + 0.5 * Math.cos(2 * this.bobT)) * bobA * 0.8;
    // landing dip and airborne float
    const air = player.grounded ? 0 : 1;
    this.lower += ((air ? 0.02 : 0) + player.landDip * 0.6 - this.lower) * (1 - Math.exp(-dt * 12));
    // idle breathing: slow, tiny lift + pitch, a touch of roll (almost none in ADS: the sight must stay within 1 px of centre)
    this.idleT += dt;
    const br = 1 - 0.85 * ads;
    const brY = 0.0015 * Math.sin(this.idleT * 1.3) * br, brRX = 0.0025 * Math.sin(this.idleT * 1.3 + 0.6) * br, brRZ = 0.0015 * Math.sin(this.idleT * 0.9) * br;

    // --- pose: hip <-> ADS blend, then the motion layers on top
    const g = w.group, a = adsDef && ads > 0 ? adsDef : null, lo = this.lower * (1 - 0.5 * ads);
    const px = a ? lerp(view.pos[0], a.pos[0], ads) : view.pos[0], py = a ? lerp(view.pos[1], a.pos[1], ads) : view.pos[1], pz = a ? lerp(view.pos[2], a.pos[2], ads) : view.pos[2];
    const rx = a ? lerp(view.rot[0], a.rot[0], ads) : view.rot[0], ry = a ? lerp(view.rot[1], a.rot[1], ads) : view.rot[1], rz = a ? lerp(view.rot[2], a.rot[2], ads) : view.rot[2];
    g.position.set(px + bobX - this.sway.x * 0.25, py + bobY - lo + brY + this.sway.y * 0.15, pz);
    g.rotation.set(rx + K.rx + brRX + this.sway.y - bobY * 3, ry + K.ry + this.sway.x, rz + K.rz + brRZ + this.sway.x * 0.5 + bobX * 1.5);
    if (K.z !== 0) g.position.add(_v.set(0, 0, K.z).applyQuaternion(g.quaternion));   // kick recoils rearward along the (posed) barrel axis (+Z local), not the camera axis
    // defusing / round over: weapon dropped out of the way (down-right, muzzle down)
    this.holster = (this.holster ?? 0) + ((ctx.holster ? 1 : 0) - (this.holster ?? 0)) * (1 - Math.exp(-dt * 9));
    if (this.holster > 0.001) { const h = this.holster; g.position.y -= 0.30 * h; g.position.x += 0.10 * h; g.position.z += 0.06 * h; g.rotation.x -= 0.75 * h; g.rotation.z += 0.35 * h; }

    // --- timed animations
    if (this.anim) {
      const an = this.anim; an.t += dt; const t = Math.min(an.t / an.dur, 1);
      this._applyAnim(w, an.type, t, g);
      if (an.t >= an.dur) { this.anim = null; this._resetParts(w); }
    }

    // --- the gun's share of the aim punch: bullets leave along eye angles + the full punch, the camera follows punchTrack of
    // it, so relative to the camera the gun (and in ADS the sight line) points (1 - punchTrack) * punch off-axis. Applied as a
    // rotation about the eye (camera origin) so the sight stays on the bullet direction; angles are scaled by the tan ratio of
    // the two FOVs because this scene is drawn with its own camera.
    const punch = ctx.punch;
    if (punch && punch.lengthSq() > 1e-8) {
      const share = (1 - (ctx.punchTrack ?? 0.45)) * Math.tan(this.camera.fov * 0.5 * D2R) / Math.tan(this.mainCamera.fov * 0.5 * D2R);   // same pixel offset in both views: f_vm tan φ = f_main tan θ
      _ep.set(punch.y * D2R * share, -punch.x * D2R * share, 0); _qp.setFromEuler(_ep);
      g.position.applyQuaternion(_qp); g.quaternion.premultiply(_qp);
    }

    g.visible = !this.hidden && !scoped;

    // --- muzzle flash (+ its light) follows the muzzle; fades out fast over flashT0
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (w.muzzle) { w.muzzle.getWorldPosition(this.flash.position); this.flashLight.position.copy(this.flash.position); }
      this.flash.visible = this.flashT > 0 && g.visible;
      const k = THREE.MathUtils.clamp(this.flashT / (this.flashT0 * 0.5), 0, 1);   // full on the shot frame, ~40 % the next, gone after
      this.flash.material.opacity = 0.3 + 0.7 * k;
      this.flashLight.intensity = this.flash.visible ? this.flashPeak * k : 0;
    } else { this.flash.visible = false; this.flashLight.intensity = 0; }
  }

  _applyAnim(w, type, t, g) {
    const D = THREE.MathUtils.degToRad;
    if (type === 'draw') {
      const e = 1 - Math.pow(1 - t, 3);
      g.position.y -= 0.32 * (1 - e); g.position.z += 0.05 * (1 - e);
      g.rotation.x -= D(45) * (1 - e); g.rotation.z += D(20) * (1 - e);
    } else if (type === 'reload') {
      // tilt in, mag out (drops with left hand), new mag up, charge, tilt back
      const tilt = ss(0, 0.14, t) * (1 - ss(0.86, 1, t));
      g.rotation.z += D(22) * tilt; g.rotation.x += D(9) * tilt; g.position.x += 0.03 * tilt; g.position.y -= 0.035 * tilt;
      const out = ss(0.16, 0.36, t), back = ss(0.5, 0.72, t);
      const magDrop = out * (1 - back);
      if (w.mag) {
        w.mag.position.copy(w.magHome); w.mag.position.y -= 0.28 * magDrop; w.mag.position.z += 0.04 * magDrop;
        w.mag.rotation.set(-0.6 * magDrop, 0, 0.25 * magDrop);
        w.mag.visible = !(t > 0.36 && t < 0.5);   // old mag gone, new mag appears from below
      }
      if (w.handL) {
        w.handL.position.copy(w.handLHome);
        const hf = ss(0.08, 0.18, t) * (1 - ss(0.72, 0.84, t));
        w.handL.position.y -= 0.26 * magDrop + 0.02 * hf; w.handL.position.z += -0.16 * hf + 0.03 * magDrop;
        w.handL.rotation.copy(w.handLRotHome); w.handL.rotation.x += -0.6 * hf;
        if (w.armL) { w.armL.position.copy(w.armLHome).add(w.handL.position).sub(w.handLHome); }   // forearm travels with the hand (no stump left at the handguard)
      }
      const charge = ss(0.78, 0.86, t) * (1 - ss(0.86, 0.96, t));
      g.rotation.x -= D(6) * charge; g.position.z -= 0.02 * charge;
    } else if (type === 'bolt') {
      // AWP bolt cycle: gun drops/tilts right, bolt back and forward
      const a = ss(0.1, 0.3, t) * (1 - ss(0.7, 0.95, t));
      g.rotation.z += D(14) * a; g.rotation.x += D(6) * a; g.position.y -= 0.04 * a; g.position.x += 0.02 * a;
      const bolt = w.nodes.bolt_knob;   // may be joined; harmless if missing
      if (bolt) bolt.position.z = 0.06 * (ss(0.3, 0.45, t) * (1 - ss(0.55, 0.7, t)));
    } else if (type === 'slash') {
      const s = Math.sin(t * Math.PI);
      g.rotation.z += D(-70) * ss(0.05, 0.45, t) * (1 - ss(0.55, 1, t)) + D(25) * (1 - ss(0, 0.25, t)) * (t < 0.25 ? 1 : 0);
      g.rotation.y += D(35) * s; g.position.x -= 0.14 * ss(0.1, 0.45, t) * (1 - ss(0.5, 1, t)); g.position.z -= 0.08 * s;
    } else if (type === 'stab') {
      const pull = ss(0, 0.35, t) * (1 - ss(0.35, 0.55, t)), push = ss(0.35, 0.55, t) * (1 - ss(0.6, 1, t));
      g.position.z += 0.10 * pull - 0.22 * push; g.rotation.x += D(20) * pull - D(10) * push; g.rotation.z += D(-30) * push;
    }
  }

  render() {
    this.renderer.clearDepth();
    this.renderer.render(this.scene, this.camera);
  }
}

/** One muzzle-flash texture (bots' sprites, BotManager). The variants live in fx/MuzzleFlash.js. */
export function makeFlashTexture() { return makeFlashTextures(1)[0]; }
