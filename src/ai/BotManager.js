import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { assignDepthMaterials } from '../level/ShadowDepth.js';
import { bus, Events } from '../core/EventBus.js';
import { asset } from '../core/Constants.js';
import { state, nameOf } from '../core/GameState.js';
import { NavGraph } from './NavGraph.js';
import { Bot, RIG } from './Bot.js';
import { makeFlashTexture } from '../gameplay/ViewModel.js';
import { weaponTextureSets } from '../gameplay/WeaponTextures.js';
import { applyCloth } from './Cloth.js';

const NAMES = ['Cliffe', 'Ryan', 'Chet', 'Wolf', 'Vitaliy'];
const VARIANTS = ['mask', 'wrap', 'mask_cap', 'wrap_goggles', 'mask'];
const LINES = {
  spot: ['Enemy spotted.', 'Enemy spotted.', 'Contact!'],
  hit: ['Taking fire, need backup!', "I'm hit!"],
  down: ['Man down.'],
  planting: ['Planting the bomb.'],
  planted: ['Bomb has been planted.'],
  bomb: ["I've got the bomb."],
  defusing: ['Defusing the bomb.'],
};
/**
 * CT holds (T side): a nav node to stand on and the node it watches, i.e. the T entry that spot covers. The first five are
 * the round-start assignments (goose and site_n watch long across the site, ninja the catwalk / stairs, default the pit /
 * elbow, long corner holds long itself); the rest are rotation spots for the two patrolling bots (see Bot._defend).
 */
const CT_HOLDS = [
  { node: 'goose', face: 'barrels' }, { node: 'ninja', face: 'stairs_top' }, { node: 'default', face: 'elbow' },
  { node: 'long_corner', face: 'long_3' }, { node: 'site_n', face: 'long_corner' },
  { node: 'ramp_top', face: 'site_center' }, { node: 'car', face: 'long_2' }, { node: 'site_s', face: 'stairs_bot' }, { node: 'site_sw', face: 'short_plat' },
];
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _ray = new THREE.Ray(), _q = new THREE.Quaternion(), _m4 = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, -1, 0), UP = new THREE.Vector3(0, 1, 0), XAXIS = new THREE.Vector3(1, 0, 0), NEG_Z = new THREE.Vector3(0, 0, -1);
const RIFLE_HALF = 0.03;                                        // half thickness of the AK across its flat side (grip / guard are ±21..25 mm, the bolt handle a touch more)

/**
 * Physique / mannerism / wear knobs for slot i, deterministic (the same bot looks and moves the same every round) and
 * spread across the squad: each attribute samples a golden-ratio sequence in i with its own offset, so neighbours are far
 * apart in every attribute and no two attributes are correlated (the tallest is not also the bulkiest, the dirtiest...).
 * Ranges: height 1.71-1.89 m, shoulders ±7 %, upper-body bulk ±4 %, clip tempo ±8 %, albedo 0.85-1.0.
 */
export function buildFor(i) {
  const u = (salt) => { const x = (i + 1) * 0.6180339887 + salt; return x - Math.floor(x); }, c = (salt) => u(salt) * 2 - 1;
  return {
    height: 1.71 + 0.18 * u(0.00), shoulder: 0.07 * c(0.37), bulk: 1 + 0.04 * c(0.71),
    phase: u(0.29), tempo: 1 + 0.08 * c(0.83), sway: 0.5 + u(0.61),
    readyPitch: 8 * c(0.19), readyDrop: 0.03 * c(0.97), support: 0.03 * c(0.43), blade: 1 + 0.3 * c(0.07), crouchBias: 0.75 + 0.5 * u(0.91),
    dirt: 0.85 + 0.15 * u(0.13), hue: 0.03 * c(0.53),           // materials: albedo multiplier, warm(+)/cool(-) shift
  };
}

/**
 * World-scene copy of a weapon GLB (bot rifles, dropped guns). The GLBs ship flat Principled colours plus a
 * curvature proxy in COLOR_0 that GLTFLoader turns into vertex colours - unhandled that reads as a bright green
 * gun. ViewModel._dress does the first-person version; this is the cheap world-space equivalent: same procedural
 * texture sets (memoised, so the viewmodel's build is reused), no edge-wear shader patch, no envMap overrides.
 */
function dressWorldGun(root) {
  const tex = weaponTextureSets(), done = new Map();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const src = o.material;
    if (!done.has(src)) {
      const m = src.clone(); const n = m.name || '';
      m.vertexColors = false;                    // COLOR_0 is a wear mask, not a tint
      if (/^gun_wood/.test(n)) { m.map = tex.wood.map; m.normalMap = tex.wood.normalMap; m.color.setRGB(1, 1, 1); m.roughness = 0.62; m.metalness = 0; }
      else if (/^gun_bakelite/.test(n)) { m.map = tex.bakelite.map; m.color.setRGB(1, 1, 1); m.roughness = 0.38; m.metalness = 0; }
      else if (/^gun_steel_light/.test(n)) { m.map = tex.steel.map; m.color.setRGB(0.13, 0.13, 0.14); m.roughness = 0.66; m.metalness = 0.85; }
      else if (/^gun_steel/.test(n)) { m.map = tex.steel.map; m.color.setRGB(0.075, 0.08, 0.10); m.roughness = 0.54; m.metalness = 0.85; }
      else if (/^gun_black|^gun_rubber/.test(n)) { m.map = tex.speckle.map; m.color.setRGB(0.030, 0.030, 0.032); m.roughness = 0.62; m.metalness = 0.5; }
      else { m.color.setRGB(0.05, 0.05, 0.055); m.roughness = 0.7; m.metalness = 0.4; }
      m.envMapIntensity = 0.6; m.needsUpdate = true;
      done.set(src, m);
    }
    o.material = done.get(src);
  });
  return root;
}

/**
 * Spawns/updates the bot team and renders bot-side FX (muzzle flash, tracer, impacts, dropped rifles). The bots are the
 * player's opponents: Ts attacking A when the player is CT (state.side 'ct'), CTs holding A -- and defusing after a plant --
 * when the player is T. `team` is the bots' side for the current round.
 */
export class BotManager {
  constructor(game) {
    this.game = game; this.map = game.map;
    this.nav = new NavGraph(this.map.markers);
    this.bots = []; this.templates = {}; this._mats = new Map();
    this.team = 't';
    this.shadowDirty = true; this._shadowPending = true;
    this.enabled = true;                              // false (explore mode / cheats.bots(false)): spawnTeam() spawns nobody
    this.difficultyNoise = 0.3;                       // extra aim cone (deg); lowered as the player does well
    this.plantSpot = this.nav.pos('default') ? this.nav.pos('default').clone() : this.map.markers.bombsite.pos.clone();
    this.footAcc = []; this.dropped = [];
    this.teamRadioT = -99; this.botRadioT = {};
    this.flashes = []; const tex = makeFlashTexture();
    for (let i = 0; i < 6; i++) {
      // additive on colour only (same setup as the tracer material in fx/Impacts.js): the HDR target's alpha is the sky mask
      // for the sun shafts (Sky.js / PostFX), so the flash must leave alpha alone (plain AdditiveBlending pushes it above 1
      // -> a dark halo around the sprite when the sun is on screen)
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffd9a0, transparent: true, depthWrite: false,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
        blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor }));
      // Keep the sprite out of any override-material pass. GTAO's normal pre-pass hides Points/Lines but not Sprites, and
      // draws everything else with a MeshNormalMaterial: the sprite's quad (no billboarding, no normals in the sprite
      // geometry) then lands in the normal/depth G-buffer as a solid world-XY square at the muzzle -> the AO for those
      // pixels is garbage and the flash shows up as an opaque black rectangle (edge-on it is invisible, which is why it
      // only appears from some angles). Same trick as the tracer ribbon in fx/Impacts.js: zero the draw range for that pass.
      s.onBeforeRender = (r, scene, cam, geo) => { if (scene.overrideMaterial) geo.setDrawRange(0, 0); };
      s.onAfterRender = (r, scene, cam, geo) => { if (scene.overrideMaterial) geo.setDrawRange(0, Infinity); };
      s.visible = false; s.scale.setScalar(0.35); game.scene.add(s); this.flashes.push({ s, t: 0 });
    }
    // Two-frame warm kick on the shooter (hands, guard, face) and the ground under the muzzle. Was intensity 25 / 7 m with
    // decay 2: at 0.5 m that is 100 units of irradiance against a 5.6 sun -> the face and hands tone-mapped to a flat
    // orange blob and lit a 7 m pool. 3 / 5 m: ~12 on the hands, ~5 on the face, a tint rather than a light source.
    this.flashLight = new THREE.PointLight(0xffb060, 0, 5, 2); game.scene.add(this.flashLight);
    bus.on(Events.BOT_SHOOT, (e) => this._shotFx(e));
    bus.on(Events.WEAPON_FIRE, (e) => { if (!e.melee) for (const b of this.bots) b.hearShot(e.origin); });
    // T side: the plant pulls every CT that is not in a fight onto the C4 (one defuses, the others cover him -- Bot._defuse)
    bus.on(Events.BOMB_PLANTED, () => { if (this.team !== 'ct') return; for (const b of this.bots) if (b.alive && !['engage', 'retreat', 'dead'].includes(b.state)) b._enter('defuse'); });
  }

  async load() {
    const loader = new GLTFLoader();
    for (const v of new Set(VARIANTS)) {
      const g = await loader.loadAsync(asset(`models/bot_${v}.glb`));
      g.scene.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      g.scene.userData.clips = g.animations;                                       // skinned rig: clips travel with the template
      this.templates[v] = g.scene;
    }
    const ak = await loader.loadAsync(asset('models/ak47.glb'));                        // bot rifle = first-person AK without the hands/arms
    for (const n of ['HandR', 'ArmR', 'HandL', 'ArmL']) ak.scene.getObjectByName(n)?.removeFromParent();
    dressWorldGun(ak.scene);
    this.rifle = ak.scene;
    // every material set the game can ever use, built once here (T and CT kit for each slot): a side switch between rounds
    // then swaps materials that already exist, and the CT recolour is a uniform on the same program (Cloth.js), so nothing
    // compiles mid-round whichever side the first round -- the one Game._warmShaders sees -- happens to be
    for (let i = 0; i < NAMES.length; i++) for (const ct of [false, true]) this._matSet(VARIANTS[i], i, buildFor(i), ct);
    return this;
  }

  /**
   * Clone with per-bot materials (wear / tint variation) + cloth shader. The material set is keyed by (variant, slot) and
   * built once: a slot gets the same variant and build every round, so re-cloning the materials per spawn only churned
   * materials, shadow depth materials and program references for nothing. (The uFeetY / cloth uniforms are written per
   * draw in onBeforeRender, so the set is safe to share across rounds; it is still per slot, not per squad, because the
   * renderer only re-uploads a material's uniforms when the material changes between consecutive draws.)
   *
   * The current GLBs are one skinned mesh with one baked-texture material (`bot_cloth*`: skin, rig, pants and boots in
   * one atlas), so the variation is whole-body: an albedo multiplier (a dirtier, darker kit) and a slight warm/cool
   * shift, plus more dust on the dirtier bots. The vest/pants/pouch branches below keep working if a future export
   * splits the materials again. Rolled sleeves would need a split material or new geometry -- not done here.
   */
  _clone(v, i, build, ct = false) {
    const g = SkeletonUtils.clone(this.templates[v]); g.userData.clips = this.templates[v].userData.clips;
    const cache = this._matSet(v, i, build, ct);
    g.traverse((o) => { if (o.isMesh) o.material = cache.get(o.material) || o.material; });
    g.scale.setScalar(build.height / RIG.height);                            // Bot normalises the bind height to RIG.height * this
    return g;
  }

  /** The (variant, slot, side) material set: template material -> per-slot clone. Built on first request, kept for good. */
  _matSet(v, i, build, ct) {
    const key = `${v}:${i}:${ct ? 'ct' : 't'}`;
    let cache = this._mats.get(key); if (cache) return cache;
    this._mats.set(key, cache = new Map());
    const seed = (i + 0.5) / 5, tint = 1 + (seed - 0.5) * 0.12, dirt = build.dirt ?? 1, hue = build.hue ?? 0;
    this.templates[v].traverse((o) => {
      if (!o.isMesh) return;
      const src = o.material;
      if (cache.has(src)) return;
      const m = src.clone(); m.envMapIntensity = 0.35; m.userData = {};
      const n = m.name || '';
      if (/vest|pouch|pants/.test(n)) m.color.multiplyScalar(tint);
      if (/pants/.test(n) && seed > 0.5) m.color.setHex(0x4a4c40).convertSRGBToLinear();   // Sabre-style grey-olive on half the squad
      if (!/gun/.test(n)) {
        m.color.multiplyScalar(dirt); m.color.r *= 1 + hue; m.color.b *= 1 - hue;          // per-bot wear: darker kit, warm/cool dye lot
        const wear = (1 - dirt) / 0.15;                                                        // 0 (clean) .. 1 (dirtiest)
        applyCloth(m, { weave: /skin/.test(n) ? 0.03 : 0.10, dust: (/boot/.test(n) ? 0.35 : /pants/.test(n) ? 0.22 : 0.12) * (1 + 0.8 * wear), ct: ct ? 1 : 0 });
      }
      cache.set(src, m);
    });
    return cache;
  }

  /** Spawn the opposing team for state.side: the T squad (player CT) or the CT squad (player T, who gets the C4). */
  spawnTeam() {
    this.clear();
    this.team = state.side === 't' ? 'ct' : 't';
    if (this.team === 'ct') { state.player.hasBomb = true; state.bomb.carrier = 'player'; state.bomb.state = 'carried'; }
    if (!this.enabled) { state.bots = []; if (this.team === 't') state.bomb.carrier = null; return; }
    if (this.team === 'ct') { this._spawnCTs(); return; }
    const spawns = this.map.markers.spawnT;
    const plan = [
      { spawn: spawns[0], from: 'long_t', profile: 'rusher' },
      { spawn: spawns[1], from: 'long_t', profile: 'standard' },
      { spawn: spawns[2], from: 'long_t', profile: 'lurker' },
      { spawn: spawns[3], from: 'short_t', profile: 'standard' },
      { spawn: spawns[4], from: 'short_t', profile: 'rusher' },
    ];
    const targets = ['default', 'site_center', 'site_n', 'site_s', 'goose'];
    plan.forEach((p, i) => {
      const route = this.nav.path(p.from, targets[i]) || [p.from];
      const build = buildFor(i);
      const bot = new Bot(this, { name: NAMES[i], model: this._clone(VARIANTS[i], i, build), profile: p.profile, spawn: p.spawn.clone(), route, build });
      const nx = this.nav.pos(route[1] || route[0]);
      bot.yaw = bot.aimYaw = Math.atan2(-(nx.x - p.spawn.x), -(nx.z - p.spawn.z));
      this.bots.push(bot);
      this.game.weapons.hittables.push(bot);
      assignDepthMaterials(bot.group);                                   // fresh per-bot materials each round -> fresh depth materials
    });
    const carrier = this.bots[1]; carrier.hasBomb = true; state.bomb.carrier = carrier.name; state.bomb.state = 'carried';
    // staggered starts: stands in for the longer real T-spawn approach, so CTs get ~10 s to set up and Ts arrive in waves
    [-4.0, -6.5, -10.0, -8.0, -6.0].forEach((t, i) => { this.bots[i].stateT = t; });
    state.bots = this.bots.map((b) => ({ id: b.name, name: b.name, alive: true, hp: 100 }));
  }

  /**
   * T side: five CTs spread along the CT spawn approach (ct_spawn -> ramp_bot, a walkable line), each routed to a hold around
   * A (CT_HOLDS[0..4]) which it defends facing its T entry; the last two rotate between spots. Same rig, CT material set.
   */
  _spawnCTs() {
    const a = this.nav.pos('ct_spawn') || this.map.markers.spawnCT, b = this.nav.pos('ramp_bot') || a;
    const profiles = ['standard', 'lurker', 'standard', 'rusher', 'lurker'];
    for (let i = 0; i < NAMES.length; i++) {
      const hold = this.holdFor(CT_HOLDS[i]);
      const spawn = a.clone().lerp(b, 0.05 + 0.13 * i);
      const route = this.nav.path('ct_spawn', hold.node) || ['ct_spawn', hold.node];
      const build = buildFor(i);
      const bot = new Bot(this, { name: NAMES[i], model: this._clone(VARIANTS[i], i, build, true), profile: profiles[i], spawn, route, build, team: 'ct' });
      bot.cover = bot.hold = hold; bot.patrol = i >= 3; bot.patrolT = rnd(8, 14);
      const nx = this.nav.pos(route[1] || route[0]);
      bot.yaw = bot.aimYaw = Math.atan2(-(nx.x - spawn.x), -(nx.z - spawn.z));
      bot.stateT = -0.5 * i;                                                  // out of spawn in a loose file, no long stagger: they are defending
      this.bots.push(bot);
      this.game.weapons.hittables.push(bot);
      assignDepthMaterials(bot.group);
    }
    state.bots = this.bots.map((b) => ({ id: b.name, name: b.name, alive: true, hp: 100 }));
  }

  /** A CT hold as a cover record ({name, node, pos, dir}) so Bot._defend can hold it like any COVER_ marker. */
  holdFor(h) {
    const pos = this.nav.pos(h.node), face = this.nav.pos(h.face) || this.map.markers.bombsite.pos;
    const dir = face.clone().sub(pos).setY(0).normalize();
    return { name: 'hold_' + h.node, node: h.node, pos, dir };
  }

  /** A CT hold nobody else is on (rotation for the patrolling bots and the fallback when a bot has no cover). */
  pickHold(bot) {
    const taken = new Set(this.bots.filter((b) => b !== bot && b.alive && (b.hold || b.cover)).map((b) => (b.hold || b.cover).name));
    const cands = CT_HOLDS.filter((h) => !taken.has('hold_' + h.node) && this.nav.pos(h.node) && (!bot.hold || bot.hold.name !== 'hold_' + h.node));
    return cands.length ? this.holdFor(pick(cands)) : null;
  }

  clear() {
    this._shadowPending = true;                                            // casters left the scene
    for (const b of this.bots) { this.game.scene.remove(b.group); b.dispose(); const i = this.game.weapons.hittables.indexOf(b); if (i >= 0) this.game.weapons.hittables.splice(i, 1); }
    for (const d of this.dropped) this.game.scene.remove(d.obj);
    this.bots.length = 0; this.dropped.length = 0;
  }

  get alive() { return this.bots.filter((b) => b.alive); }

  update(dt) {
    const live = state.phase === 'live' || state.phase === 'planted';
    // shadow-map refresh gate (Game._shadowDirty): a live bot animates every frame; a dead one is still until ~0.9 s after the
    // fall (procedural) or the death clip ends, 3 s covers both; a dropped rifle is a caster while it falls
    let dirty = this._shadowPending; this._shadowPending = false;
    for (const b of this.bots) if (b.alive || b.deathT < 3) { dirty = true; break; }
    for (const d of this.dropped) if (!d.rest) { dirty = true; break; }
    this.shadowDirty = dirty;
    for (const b of this.bots) {
      if (b.alive && (!live || b.stateT < 0)) {
        // freeze time / round over: stand (or keep the pose), no AI. Staggered starts only tick once live.
        if (live) b.stateT += dt;
        b.animT += dt; b.speed = 0; b.realSpeed = 0; if (state.phase === 'over') b.aimWant = 0;
        b._animate(dt); continue;
      }
      b.update(dt);
    }
    // bomb about to go off: everyone still near the site legs it back the way they came (CS2 bots do this at ~10 s).
    // A CT whose defuse will still finish in time stays on the C4.
    if (state.phase === 'planted' && state.bombTime < 9) for (const b of this.bots) {
      if (!b.alive || b.fled) continue;
      if (b.team === 'ct' && b.state === 'defuse' && state.bomb.defuser === b.name && this.game.bomb.botDefuseProgress > 0 && (1 - this.game.bomb.botDefuseProgress) * this.game.bomb.constructor.BOT_DEFUSE_TIME < state.bombTime - 0.3) continue;
      b.fled = true;
      if (b.position.distanceTo(this.map.markers.bombsite.pos) > 20) continue;
      const here = this.nav.nearest(b.position);
      let goal = here;
      if (b.team === 'ct') goal = this.nav.pos('ramp_bot') ? 'ramp_bot' : here;
      else if (this.nav.pos('long_t') && this.nav.pos('short_t')) goal = this.nav.pos('long_t').distanceTo(b.position) < this.nav.pos('short_t').distanceTo(b.position) ? 'long_t' : 'short_t';
      b.route = this.nav.path(here, goal) || [here]; b.pathIdx = 0; b.cover = null; b.crouchWant = 0; b._enter('advance');
    }
    for (let i = 0; i < this.bots.length; i++) {
      const b = this.bots[i]; if (!b.alive || b.speed < 0.3) continue;
      this.footAcc[i] = (this.footAcc[i] || 0) + b.speed * dt;
      if (this.footAcc[i] > 0.82) { this.footAcc[i] = 0; bus.emit(Events.BOT_FOOTSTEP, { bot: b, pos: b.position.clone(), quiet: b.speed < 2.6 }); }
    }
    for (const f of this.flashes) { if (f.t > 0) { f.t -= dt; if (f.t <= 0) f.s.visible = false; } }
    if (this.flashLight.intensity > 0) this.flashLight.intensity = Math.max(0, this.flashLight.intensity - dt * 75);   // 3 -> 0 in ~40 ms (2-3 frames)
    this._updateDropped(dt);
    for (let i = 0; i < this.bots.length; i++) { const s = state.bots[i]; if (s) { s.alive = this.bots[i].alive; s.hp = this.bots[i].hp; } }
  }

  // ------------------------------------------------------------ dropped weapons
  /**
   * The rifle leaves the dead bot's hand as a free body: linear velocity under gravity, a world-space angular velocity
   * integrated on the quaternion (so it tumbles about whatever axis it was spinning on, not Euler-by-Euler), a bounded
   * ground ray against the map BVH, up to two damped bounces, then a short blend into lying flat on its side on the
   * surface it landed on (Bot.js's rifle frame: barrel -Z, sights +Y, so 'flat' is the local X axis along the ground
   * normal; which side is picked from the roll it arrived with). It never rests before it is flat, so a rifle can't be
   * left standing on its muzzle or stock.
   */
  dropWeapon(bot) {
    const r = bot.parts.Rifle; if (!r) return;
    this.game.scene.attach(r);
    // rifle falls out of the right hand: ~0.4-0.7 m of travel, not thrown across the room
    const v = bot.deathDir.clone().multiplyScalar(rnd(0.4, 0.8)).add(bot.right(new THREE.Vector3()).multiplyScalar(0.3)); v.y = 0.6;
    // initial spin (rad/s, world): mostly end-over-end about the horizontal axis across the fall, a little roll about the barrel
    const w = new THREE.Vector3(-bot.deathDir.z, 0, bot.deathDir.x).multiplyScalar(rnd(4, 8) * (Math.random() < 0.5 ? 1 : -1));
    w.addScaledVector(bot.deathDir, rnd(-3, 3)); w.y = rnd(-2, 2);
    this.dropped.push({ obj: r, v, w, t: 0, rest: false, bounces: 0, settle: null });
  }

  /** Dropped rifles only (Game calls this in fly mode, where the AI is frozen: a weapon mid-fall still has to land). */
  updateDropped(dt) { this._updateDropped(dt); for (const d of this.dropped) if (!d.rest) { this.shadowDirty = true; break; } }

  _updateDropped(dt) {
    const bvh = this.map.collider.geometry.boundsTree;
    for (const d of this.dropped) {
      if (d.rest) continue;
      const o = d.obj;
      if (d.settle) {                                                    // landed: ease the last few degrees onto the ground, then freeze
        d.settle.t += dt; const k = Math.min(1, d.settle.t / 0.16);
        o.quaternion.slerp(d.settle.q, 1 - Math.exp(-dt / 0.05));
        o.position.y += (d.settle.y - o.position.y) * Math.min(1, dt * 18);
        if (k >= 1) { o.quaternion.copy(d.settle.q); o.position.y = d.settle.y; d.rest = true; }
        continue;
      }
      d.t += dt; d.v.y -= 9.8 * dt;
      o.position.addScaledVector(d.v, dt);
      const ang = d.w.length() * dt;
      if (ang > 1e-6) o.quaternion.premultiply(_q.setFromAxisAngle(_v.copy(d.w).normalize(), ang));
      // ground under the rifle (bounded: floors within ~1.5 m below). Nothing there (off the map) -> keep falling, cull far below.
      _ray.set(_v.copy(o.position).setY(o.position.y + 1), DOWN);
      const g = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, 2.5);
      if (!g) { if (o.position.y < -60) { this.game.scene.remove(o); d.rest = true; } continue; }
      const floor = g.point.y;
      if (o.position.y <= floor + RIFLE_HALF) {
        o.position.y = floor + RIFLE_HALF;
        if (d.v.y < -1.2 && d.bounces < 2) {                              // damped bounce: keeps ~30 % of the vertical speed, skids, spins less
          d.v.y = -d.v.y * 0.3; d.v.x *= 0.55; d.v.z *= 0.55; d.bounces++;
          d.w.multiplyScalar(0.5).addScaledVector(_v.set(rnd(-1, 1), 0, rnd(-1, 1)), 2);
          continue;
        }
        // lie flat on the landing surface, on the side it is already rolling toward, keeping the yaw it arrived with (+ a nudge)
        const n = _v.copy(g.face.normal); if (n.y < 0) n.negate(); if (n.y < 0.5) n.copy(UP);   // a wall/edge hit: treat as level ground
        const xw = _v2.copy(XAXIS).applyQuaternion(o.quaternion);
        const side = xw.dot(n) >= 0 ? 1 : -1;
        const X = _v2.copy(n).multiplyScalar(side);
        const Z = _v3.copy(NEG_Z).applyQuaternion(o.quaternion).negate();  // local +Z (towards the stock) in world
        Z.addScaledVector(X, -Z.dot(X)); if (Z.lengthSq() < 1e-4) Z.set(1, 0, 0).addScaledVector(X, -X.x);
        Z.normalize().applyAxisAngle(X, rnd(-0.2, 0.2));
        const Y = new THREE.Vector3().crossVectors(Z, X);
        _m4.makeBasis(X, Y, Z);
        d.v.set(0, 0, 0); d.w.set(0, 0, 0);
        d.settle = { q: new THREE.Quaternion().setFromRotationMatrix(_m4), y: floor + RIFLE_HALF, t: 0 };
      }
    }
  }

  // ------------------------------------------------------------ team events
  onBotDeath(bot, killer, weapon, headshot) {
    // `killer` is a label ('player', 'C4'), a bot name, or -- from a test harness -- the Player / a Bot object. Events
    // and the killfeed always carry the string form ('player' for the local player), so consumers can compare/print it.
    killer = killer === this.game.player || killer === 'player' || killer == null ? 'player' : nameOf(killer);
    bus.emit(Events.BOT_DEATH, { bot, killer, weapon, headshot });
    if (killer === 'player') { state.kills++; this.difficultyNoise = Math.max(0, this.difficultyNoise - 0.08); }
    state.killfeed.push({ killer: killer === 'player' ? 'You' : killer, victim: bot.name, weapon, headshot, t: performance.now() });
    bus.emit(Events.KILL, { killer, victim: bot.name, weapon, headshot });
    const alive = this.alive;
    if (alive.length && Math.random() < 0.5) this.callout(pick(alive), 'down');
    if (bot.hasBomb && state.bomb.state === 'carried') {
      bot.hasBomb = false;
      state.bomb.position = bot.position.clone();
      let best = null, bd = Infinity;
      for (const b of alive) { const d = b.position.distanceToSquared(bot.position); if (d < bd) { bd = d; best = b; } }
      if (best) {
        const dropNode = this.nav.nearest(bot.position);
        const p1 = this.nav.path(this.nav.nearest(best.position), dropNode) || [dropNode];
        const p2 = this.nav.path(dropNode, 'default') || [];
        best.route = p1.concat(p2.slice(1)); best.pathIdx = 0; best.hasBomb = true; best.cover = null; best._enter('advance');
        state.bomb.carrier = best.name;
        this.callout(best, 'bomb');
      } else state.bomb.carrier = null;
    }
  }

  /** Post-plant/hold: cover points near the site, unused by other bots, nearest first (some randomness). CTs use their holds. */
  pickDefendCover(bot) {
    if (bot.team === 'ct' && !bot.fled) return this.pickHold(bot);
    const taken = new Set(this.bots.filter((b) => b !== bot && b.alive && b.cover).map((b) => b.cover.name));
    const site = this.map.markers.bombsite.pos;
    const cands = Object.entries(this.nav.cover).map(([name, c]) => ({ name, ...c })).filter((c) => (bot.fled ? c.pos.distanceTo(site) > 26 : c.pos.distanceTo(site) < 22) && !taken.has(c.name));
    if (!cands.length) return null;
    cands.sort((a, b) => a.pos.distanceTo(bot.position) - b.pos.distanceTo(bot.position));
    return cands[Math.floor(Math.random() * Math.min(3, cands.length))];
  }

  /** Radio with team (6 s) and per-bot (15 s) cooldowns; bomb lines always go through. */
  callout(bot, kind) {
    const now = this.game.time;
    const urgent = kind === 'planted' || kind === 'planting' || kind === 'bomb';
    if (!urgent) {
      if (now - this.teamRadioT < 6) return;
      if (now - (this.botRadioT[bot.name] ?? -99) < 15) return;
    }
    this.teamRadioT = now; this.botRadioT[bot.name] = now;
    const text = pick(LINES[kind] || [kind]);
    bus.emit(Events.BOT_CALLOUT, { bot, name: bot.name, text, kind, pos: bot.position.clone() });
  }

  _shotFx(e) {
    const f = this.flashes.find((x) => x.t <= 0) || this.flashes[0];
    f.s.position.copy(e.muzzle).addScaledVector(e.dir, 0.08); f.s.visible = true; f.t = 0.05;
    f.s.material.rotation = Math.random() * Math.PI * 2; f.s.scale.setScalar(0.28 + Math.random() * 0.15);
    this.flashLight.position.copy(e.muzzle).addScaledVector(e.dir, 0.15); this.flashLight.intensity = 3;   // a little ahead of the muzzle: the hands are not inside the hot core
    this.game.impacts.tracer(e.muzzle, e.end);
    if (e.wallHit) this.game.impacts.surfaceHit({ point: e.wallHit.point, normal: e.wallHit.normal, surface: 'concrete' }, e.dir, 1);
    bus.emit(Events.SOUND, { name: 'ak47_fire_distant', pos: e.muzzle.clone(), bot: e.bot });
  }
}

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
