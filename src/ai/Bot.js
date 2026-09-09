import * as THREE from 'three';
import { bus, Events } from '../core/EventBus.js';
import { state } from '../core/GameState.js';
import { WEAPONS, falloff } from '../gameplay/WeaponDefs.js';
import { PLAYER } from '../core/Constants.js';
import { difficulty } from './Difficulty.js';

const UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _v3 = new THREE.Vector3(), _eye = new THREE.Vector3(), _ray = new THREE.Ray(), _q = new THREE.Quaternion(), _q2 = new THREE.Quaternion();
const D = Math.PI / 180;
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const lerpAngle = (a, b, k) => a + wrap(b - a) * k;
const expK = (dt, tau) => 1 - Math.exp(-dt / tau);
export const PROFILES = {
  rusher:   { reaction: [0.26, 0.40], aimErr0: 1.5, cone: 1.7, burst: [3, 5], peekChance: 0.15, jiggles: [1, 2], hold: [0, 0.4], speedMul: 1.0, walkNear: false, retreatHp: 25 },
  standard: { reaction: [0.32, 0.50], aimErr0: 1.3, cone: 1.5, burst: [2, 4], peekChance: 0.6, jiggles: [2, 3], hold: [0.3, 1.0], speedMul: 1.0, walkNear: true, retreatHp: 40 },
  lurker:   { reaction: [0.30, 0.45], aimErr0: 1.1, cone: 1.3, burst: [2, 4], peekChance: 0.9, jiggles: [2, 3], hold: [2.0, 4.0], speedMul: 0.9, walkNear: true, retreatHp: 50 },
};

// ---------------------------------------------------------------- skinned-rig binding
/**
 * Rig contract (Mixamo skeleton; names matched case-insensitively after stripping 'mixamorig', ':', '_', '.', '-', ' '):
 * Hips, Spine, Spine1, Spine2, Neck, Head, HeadTop_End, {Left,Right}{Shoulder,Arm,ForeArm,Hand,UpLeg,Leg,Foot,ToeBase}.
 * Model: origin at the feet, +Y up, faces -Z (Blender +Y-forward export; set faceZ = +1 for a raw Mixamo FBX->glTF that faces +Z).
 * Height is normalised to RIG.height from the bind-pose bounds. Clips are picked by name (first matching pattern wins);
 * missing clips fall back to procedural bone posing layered on top of the mixer (crouch, aim, death).
 * Exposed as window.__rig for live tuning from the console.
 */
export const RIG = {
  height: 1.83, eye: 0.935, faceZ: -1,          // eye: fraction of standing height (anthropometric ~0.936)
  eyeAboveHead: 0.1475,                         // eye height above the Head joint at RIG.height (m); the eye follows the posed skull, not a ratio
  clips: {
    idle: [/rifle.*idle|idle.*rifle|aim.*idle/i, /idle|stand|breath/i],
    walk: [/rifle.*walk|walk.*rifle/i, /walk/i],
    run: [/rifle.*run|run.*rifle/i, /run|jog|sprint/i],
    crouchIdle: [/crouch.*(idle|aim)|kneel/i, /^crouch(ing)?$/i],
    crouchWalk: [/crouch.*walk|sneak/i],
    aim: [/aim(?!.*idle)/i], fire: [/fir(e|ing)|shoot/i], death: [/death|die|dying/i],
  },
  speedWalk: 1.55, speedRun: 4.3,                              // m/s the walk/run clips were authored at -> action.timeScale = speed / this
  crouchDrop: 0.36, crouchLegs: [62, -105, 43],                // fallback crouch: pelvis drop (m), thigh / knee / foot fold (deg)
  // rifle in the right hand: hand-bone space, metres / degrees. Mixamo hand frame: +Y wrist->knuckles, +Z pinky->index (thumb side),
  // -X palm. Rifle model (ak47.glb): origin at the pistol grip, barrel along -Z, +Y up -> barrel along the fingers, sights toward the thumb.
  // The right wrist sits at the back-right of the pistol grip (bakelite: x +-18, y -132..-30, z 17..114 in rifle space) so the
  // palm lies on its right face and the knuckles reach its front-right edge; rifle.pos is the same offset expressed in the hand.
  rifle: { pos: [-0.038, 0.115, 0.08], rot: [90, 0, 0] },
  // rifle-local: stock butt, right wrist, support-hand anchor. Measured off the AK mesh, the magazine occupies z -0.10..-0.20
  // and the lower handguard runs z -0.19..-0.34 (x +-24, y -43..+5, the gas tube above it). -0.26 is as far forward as the
  // arm goes: the wrist stops travelling past z = -0.28 whatever the target, and only reaches that because of the bladed
  // stance below (squared up, the left shoulder sits 0.55 m from it against a 0.52 m arm, the IK clamps short and the
  // hand floats behind the weapon). handguard = the point on the guard's underside the support palm presses against.
  buttLocal: [0, -0.03, 0.34], gripLocal: [0.038, -0.08, 0.115], handguard: [-0.006, -0.043, -0.262],
  // Support hand when NOT shouldered: slides back to the rear edge of the guard, at the magazine well (the guard runs
  // z -0.19..-0.34). 0.60 m from the butt the arm is at full stretch, which is what made the carries read as "arms
  // hanging off the gun"; 0.53 m leaves the elbow bent. Blended toward `handguard` with aimBlend.
  handguardCarry: -0.19,
  // Rifle holds, all offsets [right, up, forward] (m) in the aim-yaw frame.
  // aim (shouldered): butt off the right shoulder joint, barrel on the aim direction + [pitch, yaw, cant] (deg).
  // low (standing low-ready) / run (two-handed carry while moving; walking blends 3/4 of the way): the butt hangs off the
  // right shoulder joint and the barrel points at `guard`, a point hung off the LEFT shoulder joint -- i.e. the support hand's
  // reach is designed directly (0.43-0.47 m against a 0.55 m arm), the rifle's angle follows from the two anchors: about
  // 45 deg across / 35 deg down at low-ready, 60-65 deg across / 20 deg down at a run (butt tucked by the right ribs,
  // muzzle down-forward-left, receiver clear of the chest). Both anchors ride the torso, so the rifle bobs with the stride.
  hold: {
    aim: { butt: [-0.03, -0.035, 0.04], rot: [0, 0, -6] },
    low: { butt: [-0.02, -0.05, -0.02], guard: [0.0, -0.40, 0.30], cant: 4 },
    run: { butt: [0.07, -0.09, 0.08], guard: [0.0, -0.28, 0.25], cant: 9 },
  },
  // idle sway (scaled by build.sway): torso pitch / roll (deg) and hip weight-shift (m) with their periods (s)
  sway: { pitch: 1.2, roll: 1.0, hips: 0.012, tPitch: 4.6, tRoll: 6.8, tHips: 5.3 },
  // Support hand, all in rifle space (X = right of the weapon, Y = up, Z = towards the stock). Classic under-grip: the palm
  // faces up (rolled a little toward the weapon's right) and presses on the underside of the guard, the wrist hangs
  // below-left of it, the knuckle line runs to the right and slightly forward, so the fingers curl up around the far
  // (right) side and the thumb lies along the near (left) side pointing at the muzzle. leftWrist is the wrist offset from
  // `handguard`: half a hand back along the knuckle line and a glove's thickness below the palm's contact point.
  leftWrist: [-0.047, -0.004, 0.013], leftPalm: [0.15, 0.99, 0], leftFingers: [0.99, -0.15, -0.15],
  // The Mixamo clips are unarmed, so their fingers are flat. Curl them procedurally into a rifle grip: flexion per
  // phalanx (deg) about the measured knuckle axis; the thumb first swings about the palm normal (spread: + = away from
  // the fingers) and then flexes about its own opposition axis. `index` overrides `fingers` for the index finger.
  // right: fingers wrap the pistol grip, the index lies straighter onto the trigger, the thumb hooks the grip's left face.
  // left (support): a deep proximal curl takes the fingers up the guard's far side, the thumb spreads forward along the near side.
  // (Values were fitted against the AK mesh with the finger joints printed in rifle space; this rig's rest hand is
  // already half-curled, so the distal numbers look small or negative -- they are corrections, not the final angles.)
  grip: {
    right: { fingers: [70, 10, 40], index: [40, 5, 5], ring: [70, -15, 20], pinky: [66, 20], thumb: [58, -85, -20] },
    left: { fingers: [96, 15, 10], middle: [92, -5, 10], ring: [78, -30, -20], pinky: [72, -25], thumb: [0, 15, 10], thumbSpread: 90 },
  },
  blade: -18,                                                   // torso yaw off the aim line when shouldered (deg); the head turns back
  rightPole: [0.7, -1, -0.3], leftPole: [-0.6, -1, -0.2],       // elbow bias directions in the bot frame [right, up, forward]
  aimYawSplit: [0.25, 0.30, 0.25, 0.20], aimPitchSplit: [0.15, 0.3, 0.3, 0.25],   // Spine, Spine1, Spine2, Head
};
if (typeof window !== 'undefined') window.__rig = RIG;
/**
 * Per-bot physique / mannerism knobs (BotManager.buildFor derives them deterministically from the slot index; these are the
 * neutral values). Everything here is applied procedurally on top of the shared rig and clips -- no per-bot geometry.
 */
export const NEUTRAL_BUILD = {
  height: 1.83,        // standing height (m) -- uniform model scale, hitboxes / eye follow the bones
  shoulder: 0,         // clavicle reach, fraction of the rest reach (+ = broader)
  bulk: 1,             // uniform scale of the Spine subtree (upper body), ±4 %
  phase: 0,            // clip start phase [0,1)
  tempo: 1,            // clip speed multiplier
  sway: 1,             // idle sway amplitude multiplier
  readyPitch: 0,       // low-ready muzzle pitch offset (deg)
  readyDrop: 0,        // low-ready butt height offset (m, + = higher)
  support: 0,          // support hand along the guard when carrying (m, + = further forward)
  blade: 1,            // bladed-stance multiplier
  crouchBias: 1,       // engage-range crouch preference multiplier
};
const BONES = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'HeadTop_End', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase'];
const normName = (s) => s.toLowerCase().replace(/mixamorig/g, '').replace(/[^a-z0-9]/g, '');
function findBones(root) {
  const want = Object.fromEntries(BONES.map((b) => [normName(b), b])), map = {};
  root.traverse((o) => { if (!o.isBone) return; const k = want[normName(o.name)]; if (k && !map[k]) map[k] = o; });
  return map;
}
const FINGERS = ['Index', 'Middle', 'Ring', 'Pinky'], FINGER_KEYS = FINGERS.map((f) => f.toLowerCase());
/**
 * Per hand: the finger chains, the axis to curl them about, and the hand's own (fingers, palm) frame.
 *
 * All measured in the hand bone's own frame from the loaded REST pose, so nothing here depends on an axis convention
 * the exporter happened to pick (this rig's inverse-bind matrices disagree with its node hierarchy by 90 deg on the
 * wrists, so the bind pose is not usable for this). It is also self-checking in two places: the finger direction is
 * the metacarpals, hand -> middle knuckle, which is a rest translation and so survives the MakeHuman base hand being
 * modelled half-curled; and the flexion axis picks its own sign by testing which way actually closes the hand.
 * Call before the mixer has run.
 */
function findGrip(root) {
  const idx = {}; root.traverse((o) => { if (o.isBone) idx[normName(o.name)] = o; });
  root.updateMatrixWorld(true);
  const out = {};
  for (const side of ['Left', 'Right']) {
    const hand = idx[normName(side + 'Hand')]; if (!hand) continue;
    const inv = new THREE.Matrix4().copy(hand.matrixWorld).invert();
    const at = (n) => {
      const b = idx[normName(side + n)];
      return b ? new THREE.Vector3().setFromMatrixPosition(b.matrixWorld).applyMatrix4(inv) : null;
    };
    const m1 = at('HandMiddle1'), m3 = at('HandMiddle3') || at('HandMiddle2');
    const i1 = at('HandIndex1'), p1 = at('HandPinky1');
    const t1 = at('HandThumb1'), t3 = at('HandThumb3') || at('HandThumb2');
    if (!m1 || !i1 || !p1) continue;
    const fdir = m1.clone().normalize(), curl = i1.clone().sub(p1).normalize();   // the wrist is the origin here
    if (m3) {                                                          // +90 deg about the flexion axis must close the hand
      const near = (sg) => m3.clone().sub(m1).applyAxisAngle(curl, sg * Math.PI / 2).add(m1).length();
      if (near(1) > near(-1)) curl.negate();
    }
    const palmOut = new THREE.Vector3().crossVectors(curl, fdir).normalize();   // = where a curling fingertip travels
    const thumb = t1 && t3 ? new THREE.Vector3().crossVectors(t3.clone().sub(t1).normalize(), palmOut).normalize() : curl.clone();
    const chain = (pre, n) => { const c = []; for (let j = 1; j <= n; j++) { const b = idx[normName(side + pre + j)]; if (b) c.push(b); } return c; };
    const gm = new THREE.Matrix4().makeBasis(fdir, palmOut, new THREE.Vector3().crossVectors(fdir, palmOut));
    out[side] = {
      hand, curl, palmOut, thumbAxis: thumb,
      qGrip: new THREE.Quaternion().setFromRotationMatrix(gm).invert(),
      chains: FINGERS.map((f) => chain('Hand' + f, 3)).filter((c) => c.length),
      thumb: chain('HandThumb', 3),
    };
  }
  return out;
}
// per-part hit capsules between bone pairs: [from, to (null = end bone: axis from the joint through its skin's centroid),
// part, skin bones whose dominated vertices the capsule is fitted to ('*' = whole subtree, e.g. fingers/toes), nominal
// radius (m, 1.83 m bot), max fitted radius]. Damage multipliers per part live in Combat.js.
const HITBOXES = [
  ['Head', null, 'head', ['Head*'], 0.105, 0.115], ['Neck', 'Head', 'head', ['Neck'], 0.07, 0.09],
  ['Spine1', 'Neck', 'chest', ['Spine1', 'Spine2'], 0.17, 0.21], ['LeftShoulder', 'LeftArm', 'chest', ['LeftShoulder'], 0.08, 0.12], ['RightShoulder', 'RightArm', 'chest', ['RightShoulder'], 0.08, 0.12],
  ['Hips', 'Spine1', 'stomach', ['Hips', 'Spine'], 0.165, 0.21],
  ['LeftArm', 'LeftForeArm', 'arm', ['LeftArm'], 0.065, 0.10], ['LeftForeArm', 'LeftHand', 'arm', ['LeftForeArm'], 0.055, 0.09], ['LeftHand', null, 'arm', ['LeftHand*'], 0.05, 0.085],
  ['RightArm', 'RightForeArm', 'arm', ['RightArm'], 0.065, 0.10], ['RightForeArm', 'RightHand', 'arm', ['RightForeArm'], 0.055, 0.09], ['RightHand', null, 'arm', ['RightHand*'], 0.05, 0.085],
  ['LeftUpLeg', 'LeftLeg', 'leg', ['LeftUpLeg'], 0.095, 0.125], ['LeftLeg', 'LeftFoot', 'leg', ['LeftLeg'], 0.075, 0.10], ['LeftFoot', 'LeftToeBase', 'leg', ['LeftFoot', 'LeftToeBase*'], 0.06, 0.09],
  ['RightUpLeg', 'RightLeg', 'leg', ['RightUpLeg'], 0.095, 0.125], ['RightLeg', 'RightFoot', 'leg', ['RightLeg'], 0.075, 0.10], ['RightFoot', 'RightToeBase', 'leg', ['RightFoot', 'RightToeBase*'], 0.06, 0.09],
];
const _p1 = new THREE.Vector3(), _p2 = new THREE.Vector3(), _p3 = new THREE.Vector3(), _p4 = new THREE.Vector3(), _p5 = new THREE.Vector3(), _e = new THREE.Euler(), _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _ax = new THREE.Vector3(), _bb = new THREE.Box3(), _m4 = new THREE.Matrix4(), _qr = new THREE.Quaternion(), _qc = new THREE.Quaternion(), _ZAXIS = new THREE.Vector3(0, 0, 1);
const _h1 = new THREE.Vector3(), _h2 = new THREE.Vector3(), _h3 = new THREE.Vector3(), _h4 = new THREE.Vector3(), _h5 = new THREE.Vector3(), _h6 = new THREE.Vector3(), _h7 = new THREE.Vector3(), _h8 = new THREE.Vector3(), _h9 = new THREE.Vector3();
const _pe = new THREE.Vector3(), _pc = new THREE.Vector3(), _pt = new THREE.Vector3(), _et = new THREE.Vector3(), _g1 = new THREE.Vector3(), _g2 = new THREE.Vector3(), _g3 = new THREE.Vector3();
const LOS_DT = 0.05;                                                   // perception raycast period per bot (20 Hz)
const PROBE_FAR = 1.5, GROUND_FAR = 3.0;                              // bounded movement rays (m): the thresholds below never look further

/**
 * Procedural bone edits refresh only the bone itself (updateWorldMatrix(false, false)); world reads (getWorldPosition /
 * getWorldQuaternion) walk the parent chain, so a later read below an edited ancestor is still exact. One subtree pass at the
 * end of _animate makes every matrixWorld current. Before, every edit re-walked the whole subtree (fingers, rifle...) ~15x per bot per frame.
 */
/** Rotate a bone about a WORLD axis through its origin (premultiplied in parent space). */
function rotW(bone, axis, ang) {
  if (!bone || Math.abs(ang) < 1e-5) return;
  bone.parent.getWorldQuaternion(_qa).invert(); _ax.copy(axis).applyQuaternion(_qa).normalize();
  bone.quaternion.premultiply(_qb.setFromAxisAngle(_ax, ang)); bone.updateWorldMatrix(false, false);
}
/** Point bone->child at a world position (minimal rotation). */
function aimBone(bone, child, target) {
  bone.getWorldPosition(_p1); child.getWorldPosition(_p2);
  _p2.sub(_p1); _p3.copy(target).sub(_p1); if (_p2.lengthSq() < 1e-8 || _p3.lengthSq() < 1e-8) return;
  bone.parent.getWorldQuaternion(_qa).invert(); _p2.applyQuaternion(_qa).normalize(); _p3.applyQuaternion(_qa).normalize();
  bone.quaternion.premultiply(_qb.setFromUnitVectors(_p2, _p3)); bone.updateWorldMatrix(false, false);
}
/** 2-bone IK in world space: upper/lower/end bones, target T, pole = elbow bias direction (world). */
const _k1 = new THREE.Vector3(), _k2 = new THREE.Vector3(), _k3 = new THREE.Vector3(), _k4 = new THREE.Vector3(), _k5 = new THREE.Vector3();
function ik2(upper, lower, end, T, pole) {
  upper.getWorldPosition(_k1); lower.getWorldPosition(_k2); end.getWorldPosition(_k3);
  const l1 = _k1.distanceTo(_k2), l2 = _k2.distanceTo(_k3);
  const d = _k4.copy(T).sub(_k1); let L = d.length(); L = Math.min(L, (l1 + l2) * 0.985); d.normalize();
  const cosA = THREE.MathUtils.clamp((l1 * l1 + L * L - l2 * l2) / (2 * l1 * L), -1, 1), a = Math.acos(cosA);
  const p = _k5.copy(pole).addScaledVector(d, -pole.dot(d)); if (p.lengthSq() < 1e-6) p.set(0, -1, 0).addScaledVector(d, d.y); p.normalize();
  const E = _k2.copy(d).multiplyScalar(Math.cos(a)).addScaledVector(p, Math.sin(a)).multiplyScalar(l1).add(_k1);   // elbow
  aimBone(upper, lower, E);
  const H = _k5.copy(_k1).addScaledVector(d, L); aimBone(lower, end, H);
}

/**
 * Bot: waypoint navigation, jiggle-peeks at corners, stop-to-shoot engagements with a converging aim model, cover/retreat,
 * procedural animation, per-part hitboxes and a procedural death (fall + dropped weapon).
 * team 't' (player is CT): advance on A, bomb plant, post-plant hold.
 * team 'ct' (player is T): hold a spot around A facing a T entry (advance -> defend on its route's end, the patrollers rotate
 * between holds), engage on sight / sound with the same combat code, and after the plant converge on the C4: one defuses
 * (10 s, no kit, interrupted by damage or a contact), the others cover him. A CT never enters 'plant'.
 */
export class Bot {
  constructor(mgr, { name, model, profile, spawn, route, build, team = 't' }) {
    this.mgr = mgr; this.game = mgr.game; this.map = mgr.game.map; this.nav = mgr.nav;
    this.team = team;
    this.name = name; this.profile = PROFILES[profile]; this.profileName = profile;
    this.hp = 100; this.armor = 100; this.helmet = Math.random() < 0.6; this.alive = true;
    this.build = { ...NEUTRAL_BUILD, ...(build || {}) };
    // ---- skinned model: group (yaw, position) > model (height-normalised, faces -Z) > armature + meshes
    this.group = new THREE.Group(); this.group.name = 'bot_' + name;
    this.model = model; this.group.add(model);
    this.parts = {}; this.meshes = []; this.bones = findBones(model);
    model.traverse((o) => { if (o.isMesh) { this.meshes.push(o); o.frustumCulled = false; } });
    this.grip = findGrip(model);
    // physique: the clips carry position/scale tracks for every bone, so the build is re-applied after each mixer update;
    // it also has to be in place now, before the rifle's hand-space scale and the height normalisation are measured.
    model.updateMatrixWorld(true);
    this._units = this.bones.Hips ? 1 / this.bones.Hips.parent.getWorldScale(_v).x : 100;   // armature units per metre (this rig: cm)
    this._shoulderRest = this.bones.LeftShoulder ? Math.abs(this.bones.LeftShoulder.position.x) + (this.bones.LeftArm ? this.bones.LeftArm.position.length() : 0) : 0;   // Spine2 -> Arm joint lateral reach
    this._applyBuild();
    model.updateMatrixWorld(true);
    const box = new THREE.Box3();
    const bodyMeshes = this.meshes.filter((m) => m.isSkinnedMesh);
    // skinned exports keep their vertices in bind space, so geometry.boundingBox is meaningless there:
    // SkinnedMesh.computeBoundingBox() skins the rest pose and gives the real silhouette.
    for (const m of bodyMeshes.length ? bodyMeshes : this.meshes) {
      if (m.isSkinnedMesh && m.computeBoundingBox) { m.computeBoundingBox(); box.union(_bb.copy(m.boundingBox).applyMatrix4(m.matrixWorld)); continue; }
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      box.union(_bb.copy(m.geometry.boundingBox).applyMatrix4(m.matrixWorld));
    }
    const s0 = model.scale.y, h = (box.max.y - box.min.y) / s0;
    if (h > 0.1) model.scale.multiplyScalar(RIG.height / h);
    model.position.y = -box.min.y * model.scale.y / s0;
    this.standH = s0 * RIG.height;                                // per-bot: the manager scales each model a few % either way
    this.eyeY = (RIG.eye ?? 0.935) * this.standH;
    if (RIG.faceZ > 0) model.rotation.y = Math.PI;
    const feet = () => this.position.y;
    model.updateMatrixWorld(true);
    model.traverse((o) => { if (o.isMesh) { const cs = o.getWorldScale(_v).x; o.onBeforeRender = () => { const sh = o.material.userData.shader; if (sh) { sh.uniforms.uFeetY.value = feet(); sh.uniforms.uClothScale.value = cs; } }; } });
    this.hitboxes = [];                                           // fitted to the posed skin below, once the model is sized (_fitHitboxes)
    // ---- rifle rides in the right hand (world-scale corrected); Muzzle empty gives the shot origin
    const rifle = mgr.rifle ? mgr.rifle.clone(true) : null, hand = this.bones.RightHand;
    if (rifle && hand) {
      hand.add(rifle); this.group.updateMatrixWorld(true);
      const k = 1 / hand.getWorldScale(_v).x;
      rifle.scale.setScalar(k); rifle.position.fromArray(RIG.rifle.pos).multiplyScalar(k); rifle.rotation.set(RIG.rifle.rot[0] * D, RIG.rifle.rot[1] * D, RIG.rifle.rot[2] * D);
      rifle.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this.parts.Rifle = rifle; this.parts.Muzzle = rifle.getObjectByName('Muzzle') || rifle;
    }
    // ---- clips -> actions (first matching pattern per role)
    this.mixer = new THREE.AnimationMixer(model);
    const clips = model.userData.clips || []; this.actions = {}; this.cur = null; this.curRole = null;
    for (const [role, pats] of Object.entries(RIG.clips)) {
      const c = pats.map((p) => clips.find((c) => p.test(c.name))).find(Boolean); if (!c) continue;
      const a = this.mixer.clipAction(c); if (role === 'death' || role === 'fire') { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
      this.actions[role] = a;
    }
    this.hasCrouchClip = !!(this.actions.crouchIdle || this.actions.crouchWalk);
    // the mixer only writes a bone when its blended value changes, so the procedural layer is undone by hand before every update
    const posed = Object.values(this.bones);
    for (const g of Object.values(this.grip)) posed.push(...g.thumb, ...g.chains.flat());   // the grip curl is procedural too
    this._snap = posed.map((b) => ({ b, p: b.position.clone(), q: b.quaternion.clone(), on: false }));

    this.position = spawn.clone(); this.yaw = 0; this.aimYaw = 0; this.aimPitch = 0;
    this.velocity = new THREE.Vector3(); this.speed = 0; this.moveBlend = 0;
    this.state = 'advance'; this.stateT = 0;
    this.route = route; this.pathIdx = 0;
    this.awareT = 0; this.reaction = this.rollReaction(); this.holdFireT = 0;
    this.seesPlayer = false; this._seen = false; this.losT = Math.random() * LOS_DT; this.lastSeen = null; this.lastSeenT = 99; this.heardT = 99; this.contactT = 99;
    this.probeFrame = 0; this.dL = 99; this.dR = 99;
    this.ammo = 30; this.burstLeft = 0; this.burstShot = 0; this.fireCd = 0; this.burstPause = 0; this.reloadT = 0; this.recoil = 0; this.sinceShot = 9;
    this.aimErr = new THREE.Vector2(); this.fightPhase = 'stop'; this.fightT = 0; this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.crouch = 0; this.crouchWant = 0; this.aimBlend = 0; this.walkT = Math.random() * Math.PI * 2; this.animT = this.build.phase * 20; this.stuckT = 0;
    this.cover = null; this.peek = null; this.visited = new Set(); this.holdAct = null; this.holdNext = rnd(2, 5);
    this.hasBomb = false; this.plantT = 0;
    this.deathT = -1; this.deathAxis = new THREE.Vector3(1, 0, 0); this.deathDir = new THREE.Vector3(0, 0, 1);
    this.group.position.copy(this.position);
    this.game.scene.add(this.group);
    this._animate(0);
    this._fitStanding(model);
    this.restY = model.position.y;
    // eye off the posed Head joint (+ the skull above it, scaled with height): follows the height and the upper-body bulk exactly
    if (this.bones.Head) this.eyeY = this.bones.Head.getWorldPosition(_v).y - this.group.position.y + RIG.eyeAboveHead * this.standH / RIG.height;
    this._fitHitboxes();
  }

  /**
   * Hit capsules fitted to the drawn skin. This rig's skin is not centred on its bones (the sleeves sit 8-10 cm outboard
   * of the arm bones, the vest is wider than the spine, the shoes longer than the foot bones), so bone-centred capsules
   * with anatomical radii left ~20 % of the visible silhouette unhittable. Each capsule is fitted once per bot, in the
   * posed standing pose after height normalisation, to the vertices whose dominant skin weight is one of its bones: the
   * axis is shifted onto the skin's centroid, the ends extended to its projected extent and the radius set to the
   * 85th-percentile perpendicular distance, capped per part (the head cap keeps the loose head-wrap out of the 4x hitbox).
   * Endpoints are stored in the local space of their bone, so at runtime they follow the posed, build-scaled bone
   * matrices exactly as the skin does; the radii inherit height/bulk because they are measured on the scaled mesh.
   * Cost: one CPU skinning pass over the body mesh at spawn.
   */
  _fitHitboxes() {
    const B = this.bones; this.hitboxes = [];
    const hs = this.standH / RIG.height;
    const meshes = this.meshes.filter((m) => m.isSkinnedMesh && m.geometry.attributes.skinIndex && m.geometry.attributes.skinWeight);
    this.group.updateMatrixWorld(true);
    // posed world-space vertices grouped by dominant bone (boneMatrices are otherwise only refreshed by the renderer)
    const byBone = new Map();
    for (const m of meshes) {
      m.skeleton.update();
      const bones = m.skeleton.bones, si = m.geometry.attributes.skinIndex, sw = m.geometry.attributes.skinWeight, n = m.geometry.attributes.position.count;
      for (let k = 0; k < n; k++) {
        let dom = -1, best = 0;
        for (let j = 0; j < 4; j++) { const w = sw.getComponent(k, j); if (w > best) { best = w; dom = si.getComponent(k, j); } }
        const bone = bones[dom]; if (!bone) continue;
        let arr = byBone.get(bone); if (!arr) byBone.set(bone, arr = []);
        arr.push(m.getVertexPosition(k, new THREE.Vector3()).applyMatrix4(m.matrixWorld));
      }
    }
    const collect = (spec, out) => {
      const sub = spec.endsWith('*'), bone = B[sub ? spec.slice(0, -1) : spec]; if (!bone) return;
      if (sub) bone.traverse((o) => { const a = byBone.get(o); if (a) out.push(...a); });
      else { const a = byBone.get(bone); if (a) out.push(...a); }
    };
    for (const [a, b, part, skin, r0, rMax] of HITBOXES) {
      const from = B[a], to = b ? B[b] : null; if (!from || (b && !to)) continue;
      const pts = []; for (const s of skin) collect(s, pts);
      const A0 = from.getWorldPosition(new THREE.Vector3()); let B0;
      if (to) B0 = to.getWorldPosition(new THREE.Vector3());
      else {
        // end bone (head, hands): no child joint to aim at -- point the axis from the joint through the skin's centroid,
        // falling back to the parent->joint direction (the extents below stretch it to the skin)
        const dir = new THREE.Vector3(); for (const v of pts) dir.add(v); if (pts.length) dir.divideScalar(pts.length).sub(A0);
        if (dir.length() < 0.02) dir.copy(A0).sub(from.parent.getWorldPosition(_v));
        B0 = dir.normalize().multiplyScalar(0.05 * hs).add(A0);
      }
      const n = B0.clone().sub(A0), L = n.length(); if (L < 1e-4) continue; n.divideScalar(L);
      const hb = { from, to: to || from, la: new THREE.Vector3(), lb: new THREE.Vector3(), r: r0 * hs, part, a: new THREE.Vector3(), b: new THREE.Vector3() };
      const A1 = A0.clone(), B1 = B0.clone();
      if (pts.length >= 12) {
        const us = [], qs = [], c = new THREE.Vector3();
        for (const v of pts) { const d = v.clone().sub(A0), u = d.dot(n); d.addScaledVector(n, -u); us.push(u); qs.push(d); c.add(d); }
        c.divideScalar(pts.length);
        const ds = qs.map((q) => q.distanceTo(c)).sort((x, y) => x - y); us.sort((x, y) => x - y);
        hb.r = THREE.MathUtils.clamp(ds[Math.floor(ds.length * 0.85)], 0.6 * r0 * hs, rMax * hs);
        const uMin = us[Math.floor(us.length * 0.03)], uMax = us[Math.floor(us.length * 0.96)];
        A1.add(c).addScaledVector(n, Math.min(0, uMin + hb.r)); B1.copy(A0).add(c).addScaledVector(n, Math.max(L, uMax - hb.r));
      }
      hb.la.copy(A1).applyMatrix4(_m4.copy(from.matrixWorld).invert());
      hb.lb.copy(B1).applyMatrix4(_m4.copy(hb.to.matrixWorld).invert());
      this.hitboxes.push(hb);
    }
  }

  /**
   * Physique on top of the shared rig: upper-body bulk (uniform Spine-subtree scale, so nothing shears and the rifle's
   * hand-space scale correction absorbs it) and clavicle reach (the Shoulder joints slide along their parent's X). Height is
   * the model's uniform scale (set by the manager, normalised in the constructor). Called after every mixer update.
   */
  _applyBuild() {
    const B = this.bones, b = this.build;
    if (B.Spine && b.bulk !== 1) B.Spine.scale.setScalar(b.bulk);
    if (b.shoulder && this._shoulderRest) {
      const d = this._shoulderRest * b.shoulder;                        // Spine2 space: +X = the bot's left
      if (B.LeftShoulder) B.LeftShoulder.position.x += d;
      if (B.RightShoulder) B.RightShoulder.position.x -= d;
    }
  }

  /**
   * Re-normalise on the POSED silhouette. The bind pose is a T-pose with locked knees and a level head; the idle clip
   * stands ~8 cm shorter, so sizing off the bind bounds leaves a 1.70 m bot where a 1.83 m one was asked for, floats
   * the feet, and puts the eye (a fixed fraction of standing height) up level with the crown.
   */
  _fitStanding(model) {
    for (let i = 0; i < 5; i++) this._animate(0.1);                  // the idle fades in over a few frames; measure it settled
    this.group.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const m of this.meshes) if (m.isSkinnedMesh && m.computeBoundingBox) { m.computeBoundingBox(); box.union(_bb.copy(m.boundingBox).applyMatrix4(m.matrixWorld)); }
    if (box.isEmpty()) return;
    box.applyMatrix4(_m4.copy(this.group.matrixWorld).invert());     // -> group space, where the feet must sit at 0
    const ph = box.max.y - box.min.y; if (ph < 0.1) return;
    const k = this.standH / ph;
    model.scale.multiplyScalar(k);
    model.position.y = (model.position.y - box.min.y) * k;
    this.group.updateMatrixWorld(true);
  }

  /**
   * GPU/animation resources that are per bot instance (everything else -- geometry, textures, materials -- is shared with
   * the template or the manager's per-slot material set). The skeleton's bone matrix DataTexture is created by the renderer
   * on first draw and is never freed with the scene graph: without this, every spawnTeam() leaked one texture per bot.
   */
  dispose() {
    for (const m of this.meshes) if (m.isSkinnedMesh) m.skeleton.dispose();
    if (this.mixer) { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model); }
  }

  // ------------------------------------------------------------ helpers
  get eye() { return _eye.set(this.position.x, this.position.y + this.eyeY - this.crouch * 0.42, this.position.z); }
  forward(out = new THREE.Vector3()) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  right(out = new THREE.Vector3()) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }
  get def() { return WEAPONS.ak47; }
  _enter(s) {
    if (this.state === 'defuse' && s !== 'defuse') this.game.bomb.botDefuseStop(this);   // let go of the C4 (progress resets)
    if (s === 'defuse') {                                                                    // nav route to the C4, then straight in (see _defuse)
      const bp = this.game.bomb.position, here = this.nav.nearest(this.position), there = this.nav.nearest(bp);
      this.route = this.nav.path(here, there) || [there]; this.pathIdx = 0; this.peek = null;
    }
    this.state = s; this.stateT = 0;
  }
  /** Nothing to do: a T with the bomb plants, a CT with a planted bomb defuses, everyone else holds. */
  _idleState() {
    if (this.team === 'ct') {
      if (state.bomb.state === 'planted' && !this.fled) return 'defuse';
      if (this.hold && !this.fled) this.cover = this.hold;              // back to the assigned hold after a peek / fight / patrol leg
      return 'defend';
    }
    return this.hasBomb && state.bomb.state === 'carried' ? 'plant' : 'defend';
  }
  _los(from, to) {
    const dir = _v.copy(to).sub(from); const L = dir.length(); dir.normalize(); _ray.set(from, dir);
    const h = this.map.collider.geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide, 0, L);   // bounded: nothing past the target matters
    return !h || h.distance > L - 0.2;
  }

  /** Hit test for player bullets: nearest part hit. */
  raycast(raycaster) {
    if (!this.alive) return null;
    if (raycaster.ray.distanceSqToPoint(_v.copy(this.position).addScaledVector(UP, 0.9)) > 1.3 * 1.3) return null;
    // skin-fitted bone capsules (endpoints in bone space; world matrices are those of the last rendered frame = what was drawn)
    const o = raycaster.ray.origin, d = raycaster.ray.direction; let best = null;
    for (const hb of this.hitboxes) {
      hb.a.copy(hb.la).applyMatrix4(hb.from.matrixWorld);
      hb.b.copy(hb.lb).applyMatrix4(hb.to.matrixWorld);
      const t = rayCapsule(o, d, hb.a, hb.b, hb.r);
      if (t !== null && t <= raycaster.far && (!best || t < best.t)) best = { t, hb };
    }
    if (!best) return null;
    const point = o.clone().addScaledVector(d, best.t);
    const ab = _v2.copy(best.hb.b).sub(best.hb.a), u = THREE.MathUtils.clamp(_v3.copy(point).sub(best.hb.a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
    const normal = point.clone().sub(_v3.copy(best.hb.a).addScaledVector(ab, u)).normalize();
    return { distance: best.t, point, normal, entity: this, part: best.hb.part, surface: 'flesh' };
  }

  /**
   * Melee hull test (Weapons._meleeTrace; CS2 KnifeAttack sweeps a 32u hull when its line trace misses): raycast() with every
   * capsule inflated by `radius`, and a segment that starts inside a capsule hits it at distance 0 (the player standing in
   * the bot -- rayCapsule() rejects an inside origin). `point` / `normal` are on the real capsule so blood lands on the body.
   */
  sweep(origin, dir, far, radius) {
    if (!this.alive) return null;
    const c = _v.copy(this.position).addScaledVector(UP, 0.9).sub(origin), along = Math.max(0, c.dot(dir)), reach = 1.3 + radius;
    if (c.addScaledVector(dir, -along).lengthSq() > reach * reach) return null;
    let best = null;
    for (const hb of this.hitboxes) {
      hb.a.copy(hb.la).applyMatrix4(hb.from.matrixWorld);
      hb.b.copy(hb.lb).applyMatrix4(hb.to.matrixWorld);
      const R = hb.r + radius, ab = _v2.copy(hb.b).sub(hb.a);
      const u = THREE.MathUtils.clamp(_v3.copy(origin).sub(hb.a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
      const t = _v3.copy(hb.a).addScaledVector(ab, u).distanceToSquared(origin) <= R * R ? 0 : rayCapsule(origin, dir, hb.a, hb.b, R);
      if (t !== null && t <= far && (!best || t < best.t)) best = { t, hb };
    }
    if (!best) return null;
    const onRay = _v.copy(origin).addScaledVector(dir, best.t);
    const ab = _v2.copy(best.hb.b).sub(best.hb.a), u = THREE.MathUtils.clamp(_v3.copy(onRay).sub(best.hb.a).dot(ab) / Math.max(1e-6, ab.lengthSq()), 0, 1);
    const axis = _v3.copy(best.hb.a).addScaledVector(ab, u);
    const normal = onRay.sub(axis); if (normal.lengthSq() < 1e-8) normal.copy(dir).negate(); normal.normalize();
    return { distance: best.t, point: axis.clone().addScaledVector(normal, best.hb.r), normal: normal.clone(), entity: this, part: best.hb.part, surface: 'flesh' };
  }

  /** Reaction time before the first shot, from the profile range scaled/overridden by the difficulty table. */
  rollReaction() {
    const df = difficulty();
    return df.reaction ? rnd(...df.reaction) : rnd(...this.profile.reaction) * df.reactionMul;
  }

  takeDamage({ amount, part, dir, shooter, weapon, headshot }) {
    if (!this.alive) return;
    this.hp -= amount;
    this.awareT = this.reaction;
    this.flinch = 1; this.hurtT = 0;
    // easy bots lose the target when hit: the hand error jumps and the flinch slows tracking (see _engage)
    const kick = difficulty().flinchKick * D;
    if (kick > 0) { const a = Math.random() * Math.PI * 2; this.aimErr.x += Math.cos(a) * kick; this.aimErr.y += Math.sin(a) * kick * 0.6; }
    if (this.state === 'plant') { this.plantT = 0; state.bomb.plantProgress = 0; }
    if (!this.seesPlayer) { this.lastSeen = this.game.player.position.clone(); this.lastSeenT = 0; }
    if (this.state !== 'engage') this._enter('engage');
    this.mgr.callout(this, 'hit');
    if (this.hp <= 0) this.die(dir, shooter, weapon, headshot);
  }

  die(dir, killer = 'player', weapon = 'ak47', headshot = false) {
    if (this.state === 'defuse') this.game.bomb.botDefuseStop(this);
    this.alive = false; this.hp = 0; this.state = 'dead'; this.deathT = 0; this.speed = 0;
    const d = dir ? _v.copy(dir).setY(0).normalize() : this.forward(_v).negate();
    // 70% fall with the shot (back/side), 30% crumple forward
    const spin = rnd(-35, 35) * D; d.applyAxisAngle(UP, spin);
    if (Math.random() < 0.3) d.negate();
    this.deathDir.copy(d);
    this.deathAxis.set(-d.z, 0, d.x).normalize();
    this.deathPose = this.deathDir.dot(this.forward(_v2)) < 0 ? (Math.random() < 0.6 ? 'back' : 'side') : 'face';
    // death clip if the rig has one; otherwise a procedural fall (see _updateDeath). Head/arm flop randomisation for the fallback.
    const sgn = Math.random() < 0.5 ? 1 : -1;
    this.deathHead = [rnd(-15, 15) * D, rnd(20, 45) * D * sgn, rnd(30, 50) * D * -sgn]; this.deathSgn = sgn;
    if (this.actions.death) this._play('death', 0.12);
    this.mgr.onBotDeath(this, killer, weapon, headshot);
  }

  // ------------------------------------------------------------ perception
  _perceive(dt) {
    const pl = this.game.player, pstate = state.player;
    this.lastSeenT += dt; this.heardT += dt; this.contactT += dt;
    this.losT += dt;
    if (pstate.alive) {
      const eye = _pe.copy(this.eye);
      const chest = _pc.copy(pl.position).addScaledVector(UP, 0.9);
      const dist = eye.distanceTo(chest);
      if (dist >= 70) this._seen = false;
      else if (this.losT >= LOS_DT) {
        // the two LOS raycasts run at 20 Hz per bot, phase-staggered across the squad (1-2 bots per frame at 60 fps)
        this.losT %= LOS_DT;
        const toP = _v.copy(chest).sub(eye).setY(0).normalize();
        const facing = this.forward(_v2).dot(toP);
        const fovOk = facing > Math.cos(75 * D) || dist < 4 || this.lastSeenT < 1.5;
        this._seen = fovOk && (this._los(eye, pl.getEye(_pt)) || this._los(eye, chest));
      }
    } else this._seen = false;
    this.seesPlayer = this._seen;
    if (this.seesPlayer) {
      this.awareT += dt; (this.lastSeen ||= new THREE.Vector3()).copy(pl.position); this.lastSeenT = 0;
      // a CT on the C4 keeps defusing while the T only watches from range; he fights first if pressured (close / shot at)
      if (this.awareT >= this.reaction && this.state !== 'engage' && !(this.state === 'defuse' && !this.pressured())) {
        this.contactT = 0;
        const df = difficulty();
        // initial aim error: ~1.2 m at 30 m in a random direction, converges in the engage loop
        const a = Math.random() * Math.PI * 2, e = this.profile.aimErr0 * D * 1.9 * df.aimErr0Mul;
        this.aimErr.set(Math.cos(a) * e, Math.sin(a) * e);
        this.fightPhase = 'stop'; this.fightT = rnd(0.7, 1.2);
        // over-peek: some contacts the bot stands in the open a beat longer before the first shot
        this.holdFireT = Math.random() < df.overPeek ? df.overPeekT : 0;
        this.reaction = this.rollReaction();                // re-roll per contact so a difficulty switch mid-round applies
        this._enter('engage');
        this.mgr.callout(this, 'spot');
      }
    } else this.awareT = Math.max(0, this.awareT - dt * 0.5);
  }

  /** CT under real pressure: the T is close and visible, or this bot was hit in the last 2 s (the defuse yields to the fight) */
  pressured() {
    if ((this.hurtT ?? 99) < 2) return true;
    return this.seesPlayer && this.position.distanceTo(this.game.player.position) < 18;
  }

  hearShot(pos) {
    if (!this.alive || this.state === 'engage') return;
    const d = this.position.distanceTo(pos); if (d > 45) return;
    this.heardT = 0;
    if (!this.lastSeen || this.lastSeenT > 3) { this.lastSeen = pos.clone(); this.lastSeenT = 2.9; }
    if (this.state === 'advance' && Math.random() < 0.35) this._enter('hunt');
    // a CT holding a spot goes to look as well (the Ts keep their post-plant hold); a defuser stays on the C4
    else if (this.team === 'ct' && this.state === 'defend' && Math.random() < 0.35) this._enter('hunt');
  }

  // ------------------------------------------------------------ think
  update(dt) {
    if (!this.alive) { this._updateDeath(dt); return; }
    this.stateT += dt; this.fireCd -= dt; this.animT += dt; this.sinceShot += dt; this.hurtT = (this.hurtT ?? 99) + dt;
    if (this.sinceShot > 0.15) this.recoil = Math.max(0, this.recoil - dt * 3);
    this._perceive(dt);
    this.crouchWant = 0; this.aimWant = 0;
    switch (this.state) {
      case 'advance': this._advance(dt); break;
      case 'peek': this._peek(dt); break;
      case 'engage': this._engage(dt); break;
      case 'retreat': this._retreat(dt); break;
      case 'hunt': this._hunt(dt); break;
      case 'plant': if (this.team === 'ct') { this._enter('defend'); break; } this._plant(dt); break;   // guard: a CT never plants
      case 'defend': this._defend(dt); break;
      case 'defuse': this._defuse(dt); break;
    }
    if (this.reloadT > 0) { this.reloadT -= dt; if (this.reloadT <= 0) this.ammo = 30; }
    this._move(dt);
    this._animate(dt);
  }

  /** walk (quiet) when an enemy is/was near, after gunfire, or when creeping onto the site */
  _wantWalk(nearSite) {
    const P = this.profile;
    if (this.profileName === 'rusher' || this.hasBomb) return false;
    if (this.lastSeen && this.lastSeenT < 20 && this.position.distanceTo(this.lastSeen) < 15) return true;
    if (this.heardT < 6) return true;
    return P.walkNear && nearSite;
  }

  _advance(dt) {
    const P = this.profile;
    if (this.pathIdx >= this.route.length) { this._enter(this._idleState()); return; }
    const node = this.route[this.pathIdx]; const tp = this.nav.pos(node);
    const walk = this._wantWalk(this.pathIdx >= this.route.length - 2);
    this._steerTo(tp, walk ? 0.6 : P.speedMul);
    this.aimWant = walk ? 0.7 : 0;
    if (this.position.distanceTo(tp) < 1.2) {
      this.pathIdx++;
      const covers = this.nav.coverAt[node];
      if (covers && !this.visited.has(node) && Math.random() < P.peekChance) {
        this.visited.add(node);
        this.cover = pick(covers);
        this.peek = { n: Math.floor(rnd(...P.jiggles) + 0.999), phase: 'approach', t: 0, out: false };
        this._enter('peek');
      }
    }
  }

  /** corner work: get to cover, 2-3 quick jiggle-peeks (0.25 s exposure), then hold briefly (lurkers) and commit */
  _peek(dt) {
    const c = this.cover, pk = this.peek; if (!c || !pk) { this._enter('advance'); return; }
    const side = _v2.set(-c.dir.z, 0, c.dir.x);
    this.aimYaw = lerpAngle(this.aimYaw, Math.atan2(-c.dir.x, -c.dir.z), expK(dt, 0.12)); this.aimPitch *= 0.9;
    this.aimWant = 1;
    pk.t -= dt;
    if (pk.phase === 'approach') {
      this._steerTo(c.pos, 0.6);
      if (this.position.distanceTo(c.pos) < 0.5) { pk.phase = 'wait'; pk.t = rnd(0.3, 0.6); }
    } else if (pk.phase === 'wait') {
      this.speed = 0;
      if (pk.t <= 0) {
        if (pk.n > 0) { const df = difficulty(); pk.phase = 'out'; pk.t = 0.25 + (Math.random() < df.overPeek ? df.overPeekT : 0); pk.n--; }   // easy: sometimes over-peeks
        else { pk.phase = 'hold'; pk.t = rnd(...this.profile.hold); }
      }
    } else if (pk.phase === 'out') {
      this._steerTo(_v3.copy(c.pos).addScaledVector(side, 0.55), 1.0);
      if (pk.t <= 0) { pk.phase = 'back'; pk.t = 0.3; }
    } else if (pk.phase === 'back') {
      this._steerTo(c.pos, 1.0);
      if (pk.t <= 0 || this.position.distanceTo(c.pos) < 0.2) { pk.phase = 'wait'; pk.t = rnd(0.3, 0.6); }
    } else if (pk.phase === 'hold') {
      this.speed = 0; this.crouchWant = this.profileName === 'lurker' ? 1 : 0;
      if (pk.t <= 0) { this.peek = null; this._enter('advance'); }
    }
    this.yaw = lerpAngle(this.yaw, this.aimYaw - 0.25, expK(dt, 0.15));
  }

  _engage(dt) {
    const pl = this.game.player, P = this.profile;
    if (!state.player.alive) { this._enter(this.hasBomb && state.bomb.state === 'carried' ? 'advance' : this.team === 'ct' ? this._idleState() : 'defend'); return; }
    this.aimWant = 1;
    const target = _et.copy(pl.position).addScaledVector(UP, (pl.crouching ? 0.75 : 1.1));
    const toT = _v.copy(target).sub(this.eye); const dist = toT.length();
    const df = difficulty();
    // aim error decays (τ 0.35 s on normal) toward a small hand wander; the bot aims where it *thinks* the target is
    const k = expK(dt, df.errTau);
    this.aimErr.multiplyScalar(1 - k);
    const wob = 0.3 * D;
    const wantYaw = Math.atan2(-toT.x, -toT.z) + this.aimErr.x + Math.sin(this.animT * 2.3) * wob;
    const wantPitch = Math.asin(THREE.MathUtils.clamp(toT.y / dist, -1, 1)) + this.aimErr.y + Math.cos(this.animT * 1.7) * wob;
    // turn onto the target: τ 0.13 s on normal; easy is slower and slower still while a flinch wears off
    const ka = expK(dt, df.aimTau * (1 + (this.flinch || 0) * df.flinchSlow));
    if (this.seesPlayer) { this.aimYaw = lerpAngle(this.aimYaw, wantYaw, ka); this.aimPitch += (wantPitch - this.aimPitch) * ka; }
    if (this.holdFireT > 0) this.holdFireT -= dt;
    // bladed stance: hips ~17° off the aim
    this.yaw = lerpAngle(this.yaw, this.aimYaw - 0.3, expK(dt, 0.12));

    // CT with the C4 ticking: a T merely watching from range (> 18 m, not shooting him) is not worth the clock -- go defuse
    if (this.team === 'ct' && state.bomb.state === 'planted' && !this.fled && this.stateT > 1.5 && !this.pressured()) { this._enter('defuse'); return; }
    // low hp / empty mag -> cover
    if ((this.hp < P.retreatHp || (this.ammo <= 0 && this.reloadT <= 0)) && this.stateT > 0.6) {
      const c = this._nearestCoverFrom(pl.position); if (c) { this.cover = c; if (this.ammo <= 0) this.reloadT = 2.4; this._enter('retreat'); return; }
    }
    // stop-shoot-move: short strafes between stationary bursts; rushers close distance
    this.fightT -= dt;
    if (this.fightT <= 0) {
      if (this.fightPhase === 'stop') { this.fightPhase = 'move'; this.fightT = rnd(0.3, 0.45); this.strafeDir = -this.strafeDir; }
      else { this.fightPhase = 'stop'; this.fightT = rnd(0.7, 1.3); }
    }
    if (this.fightPhase === 'move' && dist > 3) {
      const right = _v2.set(Math.cos(this.aimYaw), 0, -Math.sin(this.aimYaw)).multiplyScalar(this.strafeDir);
      if (this.profileName === 'rusher' && dist > 10) right.addScaledVector(_v3.set(-Math.sin(this.aimYaw), 0, -Math.cos(this.aimYaw)), 1.2);
      this._steerDir(right.normalize(), 0.85);
    } else this.speed = 0;
    this.crouchWant = (dist < 14 * this.build.crouchBias && this.profileName !== 'rusher' && this.fightPhase === 'stop' && this.stateT > 0.8) ? 1 : 0;   // per-bot: some drop at 10 m, some at 18 m

    // shooting: only when stationary (or crouched), in bursts, once the aim has converged
    const stationary = this.speed < 0.6 || this.crouch > 0.7;
    if (this.seesPlayer && this.reloadT <= 0 && stationary && !(this.holdFireT > 0)) {
      if (this.ammo <= 0) { this.reloadT = 2.4; bus.emit(Events.BOT_RELOAD, { bot: this }); }
      else if (this.burstLeft > 0) {
        if (this.fireCd <= 0) { this._shoot(target, dist); this.burstLeft--; this.fireCd = 0.1; if (this.burstLeft === 0) this.burstPause = rnd(...df.burstPause); }
      } else {
        this.burstPause -= dt;
        const aimErr = Math.hypot(this.aimErr.x, this.aimErr.y);
        if (this.burstPause <= 0 && aimErr < 0.9 * D) {
          this.burstLeft = dist < 10 ? Math.floor(rnd(...df.burstClose)) : Math.floor(rnd(...(df.burst || P.burst))); this.burstShot = 0;
          // fresh hand error at the start of each burst (grows with range): bots re-acquire rather than track perfectly
          const a = Math.random() * Math.PI * 2, e = rnd(0.35, 0.9) * D * (0.5 + dist / 22) * df.burstErrMul;
          this.aimErr.x += Math.cos(a) * e; this.aimErr.y += Math.sin(a) * e * 0.6;
        }
      }
    } else if (!this.seesPlayer) {
      this.burstLeft = 0;
      if (this.lastSeenT > 2.5) this._enter('hunt');
    }
  }

  _retreat(dt) {
    const c = this.cover; if (!c) { this._enter('engage'); return; }
    this.aimWant = 1;
    this._steerTo(c.pos, 1.0);
    const dist = this.position.distanceTo(c.pos);
    if (dist < 0.6) {
      this.speed = 0; this.crouchWant = 1;
      this.aimYaw = lerpAngle(this.aimYaw, Math.atan2(-c.dir.x, -c.dir.z), expK(dt, 0.2)); this.yaw = lerpAngle(this.yaw, this.aimYaw - 0.25, expK(dt, 0.2));
      if (this.stateT > 1.0 && this.reloadT <= 0) { this.peek = { n: 1, phase: 'wait', t: 0.3 }; this._enter('peek'); }
    }
    if (this.seesPlayer && this.stateT > 0.5 && this.reloadT <= 0 && this.hp > 15 && dist > 2) this._enter('engage');
  }

  _hunt(dt) {
    if (this.team === 'ct' && state.bomb.state === 'planted' && !this.fled) { this._enter('defuse'); return; }   // the C4 outranks a hunch
    if (!this.lastSeen) { this._enter('advance'); return; }
    this.aimWant = 1;
    this._steerTo(this.lastSeen, 0.6);
    const to = _v.copy(this.lastSeen).sub(this.position); this.aimYaw = lerpAngle(this.aimYaw, Math.atan2(-to.x, -to.z), expK(dt, 0.2)); this.aimPitch *= 0.9;
    this.yaw = lerpAngle(this.yaw, this.aimYaw - 0.2, expK(dt, 0.15));
    if (this.position.distanceTo(this.lastSeen) < 2.5 || this.stateT > 6) {
      this.lastSeen = null;
      const i = this.route.indexOf(this.nav.nearest(this.position));
      if (i >= 0) this.pathIdx = Math.min(this.route.length - 1, i + 1);
      this._enter('advance');
    }
  }

  _plant(dt) {
    const spot = this.mgr.plantSpot;
    if (this.position.distanceTo(spot) > 1.0) { this._steerTo(spot, 0.8); return; }
    this.speed = 0; this.crouchWant = 1; this.aimWant = 0;
    if (this.plantT === 0) { this.mgr.callout(this, 'planting'); bus.emit(Events.BOMB_PLANT_START, { bot: this, pos: spot.clone() }); }
    this.plantT += dt; state.bomb.plantProgress = this.plantT / 3.2;
    if (this.plantT >= 3.2) { this.hasBomb = false; this.planted = true; bus.emit(Events.BOMB_PLANTED, { bot: this, pos: spot.clone() }); this.mgr.callout(this, 'planted'); this._enter('defend'); }
  }

  /**
   * CT, bomb planted: converge on the C4. The first one there (or the one already on it) defuses -- stands at the C4,
   * crouched, weapon down, 10 s -- while the others take a covering spot 2.5 m off it facing where the T was last seen.
   * Any contact / hit leaves the state through _enter (perception -> engage), which resets the defuse.
   */
  _defuse(dt) {
    const bomb = this.game.bomb;
    if (!bomb.planted || bomb.defused || bomb.exploded || this.fled) { this._enter('defend'); return; }
    const bp = bomb.position, other = this.mgr.bots.find((b) => b !== this && b.alive && b.name === state.bomb.defuser);
    if (other) {
      // cover the defuser: a spot between him and the last known T position (or off to the side), rifle up
      this.aimWant = 1;
      const away = _v.copy(this.lastSeen || this.position).sub(bp).setY(0); if (away.lengthSq() < 0.01) away.set(1, 0, 0); away.normalize();
      const spot = _v2.copy(bp).addScaledVector(away, 2.5);
      if (this.position.distanceTo(spot) > 0.7) this._steerTo(spot, 0.7); else { this.speed = 0; this.crouchWant = 1; }
      const toT = this.lastSeen ? _v3.copy(this.lastSeen).sub(this.position) : away;
      this.aimYaw = lerpAngle(this.aimYaw, Math.atan2(-toT.x, -toT.z), expK(dt, 0.25)); this.aimPitch *= 0.95;
      this.yaw = lerpAngle(this.yaw, this.aimYaw - 0.3, expK(dt, 0.25));
      return;
    }
    const d = Math.hypot(bp.x - this.position.x, bp.z - this.position.z);
    if (d > 1.0) {
      if (this.pathIdx < this.route.length) {
        const tp = this.nav.pos(this.route[this.pathIdx]);
        if (this.position.distanceTo(tp) < 1.2 || tp.distanceTo(bp) > this.position.distanceTo(bp) + 1.5) this.pathIdx++; else this._steerTo(tp, 1.0);
      } else this._steerTo(bp, 0.8);
      this.aimWant = 0.6;
      return;
    }
    this.speed = 0; this.crouchWant = 1; this.aimWant = 0;
    const to = _v.copy(bp).sub(this.position);
    this.aimYaw = lerpAngle(this.aimYaw, Math.atan2(-to.x, -to.z), expK(dt, 0.2)); this.aimPitch += (-0.6 - this.aimPitch) * expK(dt, 0.3);
    this.yaw = lerpAngle(this.yaw, this.aimYaw, expK(dt, 0.2));
    if (state.bomb.defuser !== this.name) this.mgr.callout(this, 'defusing');
    bomb.botDefuse(this, dt);
  }

  /** hold a cover point facing a retake route; sit still, with an occasional shoulder-peek / crouch / glance */
  _defend(dt) {
    if (this.team === 'ct' && state.bomb.state === 'planted' && !this.fled) { this._enter('defuse'); return; }
    if (!this.cover) { this.cover = this.mgr.pickDefendCover(this); if (!this.cover) return; }
    // CT patroller: every 8-14 s on post, walk the nav to another free hold and settle there
    if (this.patrol && !this.holdAct) {
      this.patrolT -= dt;
      if (this.patrolT <= 0) {
        this.patrolT = rnd(8, 14);
        const h = this.mgr.pickHold(this);
        if (h) { this.cover = this.hold = h; this.route = this.nav.path(this.nav.nearest(this.position), h.node) || [h.node]; this.pathIdx = 0; this._enter('advance'); return; }
      }
    }
    const c = this.cover; this.aimWant = 1;
    const baseYaw = Math.atan2(-c.dir.x, -c.dir.z);
    if (!this.holdAct && this.position.distanceTo(c.pos) > 0.6) { this._steerTo(c.pos, 0.6); this.aimYaw = lerpAngle(this.aimYaw, baseYaw, expK(dt, 0.3)); return; }
    this.speed = 0; this.aimPitch *= 0.95;
    this.holdNext -= dt;
    if (!this.holdAct && this.holdNext <= 0) {
      const kind = pick(['peek', 'crouch', 'glance', 'crouch']);
      this.holdAct = { kind, t: kind === 'peek' ? 0.35 : kind === 'crouch' ? rnd(1, 3) : 0.8, side: Math.random() < 0.5 ? -1 : 1 };
      this.holdNext = rnd(3, 8);
    }
    let yawT = baseYaw;
    if (this.holdAct) {
      const a = this.holdAct; a.t -= dt;
      if (a.kind === 'peek') { this._steerTo(_v3.copy(c.pos).addScaledVector(_v2.set(-c.dir.z, 0, c.dir.x), 0.4 * a.side), 0.6); }
      else if (a.kind === 'crouch') this.crouchWant = 1;
      else yawT = baseYaw + 15 * D * a.side;
      if (a.t <= 0) { this.holdAct = null; }
    } else if (this.position.distanceTo(c.pos) > 0.15) this._steerTo(c.pos, 0.5);
    this.crouchWant = this.crouchWant || (this.holdAct?.kind === 'crouch' ? 1 : 0);
    this.aimYaw = lerpAngle(this.aimYaw, yawT, expK(dt, 0.25));
    this.yaw = lerpAngle(this.yaw, this.aimYaw - 0.3, expK(dt, 0.25));
  }

  _nearestCoverFrom(threat) {
    let best = null, bd = Infinity;
    for (const [name, c] of Object.entries(this.nav.cover)) {
      const d = c.pos.distanceTo(this.position); if (d > 14) continue;
      const toT = _v.copy(threat).sub(c.pos).setY(0).normalize(); const facing = c.dir.dot(toT);
      const score = d - facing * 4;
      if (score < bd) { bd = score; best = { name, ...c }; }
    }
    return best;
  }

  // ------------------------------------------------------------ shooting
  _shoot(target, dist) {
    this.ammo--; this.sinceShot = 0;
    const muzzle = new THREE.Vector3(); (this.parts.Muzzle || this.parts.Rifle).getWorldPosition(muzzle);
    // shoot along the current aim
    const cp = Math.cos(this.aimPitch);
    const dir = _v.set(-Math.sin(this.aimYaw) * cp, Math.sin(this.aimPitch), -Math.cos(this.aimYaw) * cp);
    _v2.copy(this.eye).addScaledVector(dir, dist).sub(muzzle).normalize(); dir.copy(_v2);
    // accuracy cone: base + recoil growth (+ movement, gated by the caller)
    // long-range penalty: bots (like CS2's) are noticeably worse past ~20 m, so a CT holding a long angle isn't shredded instantly
    const df = difficulty();
    const base = (this.crouch > 0.7 ? 0.8 : this.profile.cone) + (this.speed > 0.6 ? 7 : 0) + this.mgr.difficultyNoise + Math.max(0, dist - 20) * 0.045;
    const cone = (base + this.recoil) * D * df.coneMul;
    this.recoil = Math.min(5, this.recoil + 0.55);
    const r = Math.sqrt(Math.random()) * cone, th = Math.random() * Math.PI * 2;
    const right = _v3.set(-dir.z, 0, dir.x).normalize(), up = new THREE.Vector3().crossVectors(right, dir);
    dir.addScaledVector(right, Math.cos(th) * r).addScaledVector(up, Math.sin(th) * r).normalize();
    // recoil also kicks the aim up/right a touch (bot compensates over time)
    this.aimPitch += 0.25 * D; this.aimYaw += (Math.random() - 0.4) * 0.2 * D;
    _ray.set(muzzle, dir);
    const wh = this.map.collider.geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide);
    const wallD = wh ? wh.distance : 400;
    const pl = this.game.player; let hitPlayer = null;
    if (state.player.alive) {
      const a = pl.position.clone().addScaledVector(UP, PLAYER.RADIUS), b = pl.position.clone().addScaledVector(UP, pl.height - PLAYER.RADIUS);
      const t = rayCapsule(muzzle, dir, a, b, PLAYER.RADIUS);
      if (t !== null && t < wallD) hitPlayer = muzzle.clone().addScaledVector(dir, t);
    }
    const end = hitPlayer || (wh ? wh.point.clone() : muzzle.clone().addScaledVector(dir, 400));
    bus.emit(Events.BOT_SHOOT, { bot: this, muzzle: muzzle.clone(), dir: dir.clone(), end, hitPlayer: !!hitPlayer, hitPoint: end, wallHit: !hitPlayer && wh ? { point: wh.point.clone(), normal: wh.face.normal.clone() } : null });
    if (hitPlayer) {
      // hit location: head only realistically on the first, most accurate shot of a burst
      const pHead = (this.burstShot === 0 ? (this.crouch > 0.7 ? 0.20 : 0.12) : 0.03) * (dist > 25 ? 0.5 : 1) * df.headMul;
      const roll = Math.random();
      const part = roll < pHead ? 'head' : roll < pHead + 0.15 ? 'leg' : roll < pHead + 0.4 ? 'stomach' : 'chest';
      const mult = part === 'head' ? 4 : part === 'leg' ? 0.75 : part === 'stomach' ? 1.25 : 1;
      const dmg = Math.round(this.def.damage * mult * falloff(this.def, dist));
      this.game.combat.damagePlayer({ amount: dmg, dir: dir.clone(), attacker: this, weapon: 'ak47', part, armorPen: this.def.armorPen });
    }
    this.burstShot++;
  }

  // ------------------------------------------------------------ movement
  _steerTo(target, speedMul) {
    const d = _v2.copy(target).sub(this.position); d.y = 0;
    const L = d.length(); if (L < 0.05) { this.speed = 0; return; }
    d.normalize();
    this._steerDir(d, speedMul);
    const facing = ['advance', 'plant', 'defuse'].includes(this.state);
    if (facing) { this.aimYaw = lerpAngle(this.aimYaw, Math.atan2(-d.x, -d.z), 0.2); this.aimPitch *= 0.9; this.yaw = lerpAngle(this.yaw, this.aimYaw, 0.15); }
  }

  _steerDir(dir, speedMul) {
    const maxS = this.def.speed * speedMul * (this.crouch > 0.5 ? 0.45 : 1);
    this.velocity.x = dir.x * maxS; this.velocity.z = dir.z * maxS; this.speed = maxS;
  }

  _move(dt) {
    if (this.speed <= 0) this.velocity.set(0, 0, 0);
    for (const o of this.mgr.bots) {
      if (o === this || !o.alive) continue;
      const d = _v.copy(this.position).sub(o.position); d.y = 0; const L = d.length();
      if (L < 1.2 && L > 0.001) this.velocity.addScaledVector(d.normalize(), (1.2 - L) * 3);
    }
    const pd = _v.copy(this.position).sub(this.game.player.position); pd.y = 0;
    if (pd.length() < 0.9) this.velocity.addScaledVector(pd.normalize(), 2);
    if (this.velocity.lengthSq() > 0.01) {
      const spd = this.velocity.length(), dir = _v2.copy(this.velocity).normalize();
      const probe = (ang, h) => {
        const c = Math.cos(ang), s = Math.sin(ang);
        _v3.set(dir.x * c - dir.z * s, 0, dir.x * s + dir.z * c);
        _ray.set(_v.copy(this.position).addScaledVector(UP, h), _v3);
        const r = this.map.collider.geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide, 0, PROBE_FAR);
        return r ? r.distance : 99;
      };
      // forward: knee + chest height every frame; sides: one height, left/right on alternate frames (the other side keeps its last reading).
      // A bot that is only being shoved (speed 0) just checks ahead so the push cannot put it into a wall.
      const dF = Math.min(probe(0, 0.5), probe(0, 1.2));
      if (this.speed > 0) { if ((this.probeFrame++ & 1) === 0) this.dL = probe(0.7, 0.85); else this.dR = probe(-0.7, 0.85); }
      const dL = this.dL, dR = this.dR;
      if (dF < 0.9) {
        const side = dL > dR ? 1 : -1; const ang = side * (dF < 0.45 ? 1.3 : 0.8);
        const c = Math.cos(ang), s = Math.sin(ang);
        this.velocity.set(dir.x * c - dir.z * s, 0, dir.x * s + dir.z * c).multiplyScalar(spd);
        this.stuckT += dt;
      } else if (dL < 0.5 || dR < 0.5) {
        const side = dL < dR ? -1 : 1; const ang = side * 0.35;
        const c = Math.cos(ang), s = Math.sin(ang);
        this.velocity.set(dir.x * c - dir.z * s, 0, dir.x * s + dir.z * c).multiplyScalar(spd);
      } else this.stuckT = 0;
      if (this.stuckT > 2.5) { this.stuckT = 0; const n = this.nav.pos(this.nav.nearest(this.position)); this.position.lerp(n, 0.5); }
    }
    this.position.addScaledVector(this.velocity, dt);
    this.realSpeed = this.velocity.length();
    _ray.set(_v.copy(this.position).addScaledVector(UP, 1.2), DOWN);
    const g = this.map.collider.geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide, 0, GROUND_FAR);
    if (g) { const gy = g.point.y; this.position.y += (gy - this.position.y) * Math.min(1, dt * 14); }
    this.group.position.copy(this.position);
    this.group.rotation.set(0, this.yaw, 0);
    this.velocity.set(0, 0, 0);
  }

  // ------------------------------------------------------------ animation (clips + procedural layer)
  /** Cross-fade to a clip role; locomotion clips keep their phase across walk<->run. */
  _play(role, fade = 0.2) {
    const a = this.actions[role] || this.actions.idle; if (!a || a === this.cur) return;
    const loco = /walk|run/i;
    if (this.cur && loco.test(this.curRole) && loco.test(role)) a.time = (this.cur.time / this.cur.getClip().duration) * a.getClip().duration;
    else { a.reset(); a.time = this.build.phase * a.getClip().duration; }   // per-bot phase: the squad never strides / breathes in step
    a.setEffectiveTimeScale(this.build.tempo).setEffectiveWeight(1).fadeIn(fade).play();
    if (this.cur) this.cur.fadeOut(fade);
    this.cur = a; this.curRole = role;
  }

  _restoreMixed() { for (const s of this._snap) if (s.on) { s.b.position.copy(s.p); s.b.quaternion.copy(s.q); } }
  _saveMixed() { for (const s of this._snap) { s.p.copy(s.b.position); s.q.copy(s.b.quaternion); s.on = true; } }

  /**
   * Close one hand around the weapon. Local-space only: each phalanx is turned about the flexion axis carried down
   * from the hand, so this costs one quaternion per bone and never touches a world matrix (the subtree pass at the
   * end of _animate picks it up). Without it the unarmed clips leave both hands flat and the bot reads as a mitten.
   */
  _gripPose(side, k, P = RIG.grip[side.toLowerCase()]) {
    const g = this.grip[side]; if (!g || !P || k < 0.01) return;
    for (let c = 0; c < g.chains.length; c++) {
      const chain = g.chains[c], F = P[FINGER_KEYS[c]] || P.fingers;   // per-finger override (index / middle / ring / pinky)
      _g1.copy(g.curl);
      for (let j = 0; j < chain.length; j++) {
        const b = chain[j];
        b.quaternion.premultiply(_qa.setFromAxisAngle(_g1, (F[j] ?? F[F.length - 1]) * D * k));
        _g1.applyQuaternion(_qb.copy(b.quaternion).invert());          // same axis, now in the child's parent frame
      }
    }
    // thumb: spread (abduction about the palm normal, at the base only) then flexion about the opposition axis, which
    // swings with the spread; both axes start in the hand frame and are carried down the chain like the finger axis.
    const T = P.thumb, spread = (P.thumbSpread || 0) * D * k;
    _g1.copy(g.thumbAxis);
    if (spread) _g1.applyQuaternion(_qc.setFromAxisAngle(g.palmOut, spread));
    for (let j = 0; j < g.thumb.length; j++) {
      const b = g.thumb[j];
      if (j === 0 && spread) b.quaternion.premultiply(_qc);
      b.quaternion.premultiply(_qa.setFromAxisAngle(_g1, (T[j] ?? T[T.length - 1]) * D * k));
      _g1.applyQuaternion(_qb.copy(b.quaternion).invert());
    }
  }

  /** Fallback crouch (rig without crouch clips): pelvis drop + thigh/knee/foot fold about the bot's right axis. */
  _crouchPose(k) {
    const B = this.bones; if (k < 0.002 || !B.Hips) return;
    const right = this.right(_v3), [th, kn, ft] = RIG.crouchLegs;
    B.Hips.getWorldPosition(_p1); _p1.y -= RIG.crouchDrop * k * this.standH / RIG.height;   // the fold angles are fixed, so the drop scales with the legs or a tall bot's feet lift off
    B.Hips.position.copy(B.Hips.parent.worldToLocal(_p1)); B.Hips.updateWorldMatrix(false, false);
    for (const s of ['Left', 'Right']) { rotW(B[s + 'UpLeg'], right, th * D * k); rotW(B[s + 'Leg'], right, kn * D * k); rotW(B[s + 'Foot'], right, ft * D * k); }
  }

  /**
   * Rifle hold: the rifle's world pose is designed in the aim frame (butt anchored to the right shoulder joint, barrel on the
   * aim direction, low-ready / shouldered / sprint blends), then the right arm is IK'd to the grip, the right hand is oriented
   * so the rifle (a child of the hand) lands exactly there, and the left hand is IK'd onto the handguard.
   */
  _armPose(ab, run) {
    const B = this.bones, R = this.parts.Rifle; if (!R || !B.RightArm || !B.RightForeArm || !B.RightHand) return;
    const H = RIG.hold, bd = this.build, cr = 1 - ab;
    const cy = Math.cos(this.aimYaw), sy = Math.sin(this.aimYaw);
    const fwd = _h1.set(-sy, 0, -cy), right = _h2.set(cy, 0, -sy);
    const place = (out, from, a, b, k, dy = 0) => out.copy(from).addScaledVector(right, a[0] + (b[0] - a[0]) * k).addScaledVector(UP, a[1] + (b[1] - a[1]) * k + dy).addScaledVector(fwd, a[2] + (b[2] - a[2]) * k);
    B.RightArm.getWorldPosition(_h7);
    // ---- carry (low-ready <-> run carry by `run`): two anchors. The butt hangs off the right shoulder joint and the barrel
    // points at a `guard` point hung off the LEFT shoulder joint, so the support hand's reach is set by construction --
    // whatever the shoulder width, and however much the run clip twists the shoulders (which is what stretched the left
    // arm straight before: a fixed barrel angle off one shoulder is 10+ cm too far from the other one half the stride).
    if (B.LeftArm) B.LeftArm.getWorldPosition(_g2); else _g2.copy(_h7).addScaledVector(right, -0.38 * this.standH / RIG.height);
    const butt = place(_h8, _h7, H.low.butt, H.run.butt, run, bd.readyDrop * (1 - run));
    const guard = place(_g3, _g2, H.low.guard, H.run.guard, run);
    const b = _h3.copy(guard).sub(butt).normalize();
    if (bd.readyPitch) b.applyAxisAngle(_h4.crossVectors(b, UP).normalize(), -bd.readyPitch * D * (1 - run));   // per-bot: steeper / flatter low-ready
    let cant = (H.low.cant + (H.run.cant - H.low.cant) * run) * D;
    // ---- shouldered (aim) with `ab`: barrel on the aim direction off the right shoulder, as before
    if (ab > 0.001) {
      const pitch = H.aim.rot[0] * D + this.aimPitch + this.recoil * 0.02, yawOff = H.aim.rot[1] * D;
      const ba = _h5.copy(fwd).applyAxisAngle(UP, yawOff).multiplyScalar(Math.cos(pitch)); ba.y += Math.sin(pitch);
      b.multiplyScalar(cr).addScaledVector(ba, ab).normalize();
      butt.multiplyScalar(cr).add(place(_h6, _h7, H.aim.butt, H.aim.butt, 0).multiplyScalar(ab));
      cant = cant * cr + H.aim.rot[2] * D * ab;
    }
    // rifle world rotation: Z = -barrel, X = barrel x up, Y = Z x X, then cant about the barrel
    const X = _h4.crossVectors(b, UP).normalize(), Z = _h5.copy(b).negate(), Y = _h6.crossVectors(Z, X);
    _m4.makeBasis(X, Y, Z); const qr = _qr.setFromRotationMatrix(_m4).multiply(_qc.setFromAxisAngle(_ZAXIS, cant));
    // butt anchor -> rifle origin -> right wrist target
    const origin = butt.sub(_h3.fromArray(RIG.buttLocal).applyQuaternion(qr));
    const wrist = _h7.fromArray(RIG.gripLocal).applyQuaternion(qr).add(origin);
    const rp = RIG.rightPole, pole = _h9.copy(right).multiplyScalar(rp[0]).addScaledVector(UP, rp[1]).addScaledVector(fwd, rp[2]);
    ik2(B.RightArm, B.RightForeArm, B.RightHand, wrist, pole);
    // hand orientation = rifle frame * inverse(rifle-in-hand); the rifle (child) then sits exactly on the designed pose
    const rr = RIG.rifle.rot; _qc.setFromEuler(_e.set(rr[0] * D, rr[1] * D, rr[2] * D)).invert();
    B.RightHand.parent.getWorldQuaternion(_qa).invert();
    B.RightHand.quaternion.copy(_qa.multiply(_qb.copy(qr).multiply(_qc)));
    B.RightHand.updateWorldMatrix(false, false);
    // left hand onto the handguard
    const G = this.grip.Left;
    if (B.LeftArm && B.LeftForeArm && B.LeftHand && G) {
      R.updateWorldMatrix(true, false);
      // support hand: rear of the guard when carrying (bent elbow), out to `handguard` as the weapon is shouldered
      // (shouldered: a shorter bot's shorter arm grips a little further back -- the rifle is the same size for everyone)
      const hg = _h3.fromArray(RIG.handguard); hg.z = THREE.MathUtils.lerp(RIG.handguardCarry - bd.support, hg.z + Math.max(0, RIG.height - this.standH) * 0.5, ab);
      const T = hg.applyMatrix4(R.matrixWorld).add(_g1.fromArray(RIG.leftWrist).applyQuaternion(qr));
      const lp = RIG.leftPole, lpole = _h9.copy(right).multiplyScalar(lp[0]).addScaledVector(UP, lp[1]).addScaledVector(fwd, lp[2]);
      ik2(B.LeftArm, B.LeftForeArm, B.LeftHand, T, lpole);
      // ...and orient it. Without this the support hand keeps the clip's rotation (which just follows the forearm),
      // so up close the fingers close on nothing. Built from the hand's measured (fingers, palm) frame, so the palm
      // ends up against the handguard whichever way the exporter oriented the wrist bone.
      const pw = _g2.fromArray(RIG.leftPalm).applyQuaternion(qr).normalize();
      const fw = _g3.fromArray(RIG.leftFingers).applyQuaternion(qr);
      fw.addScaledVector(pw, -pw.dot(fw)).normalize();                 // orthogonalise against the palm normal
      _m4.makeBasis(fw, pw, _g1.crossVectors(fw, pw));
      B.LeftHand.parent.getWorldQuaternion(_qa).invert();
      B.LeftHand.quaternion.copy(_qa.multiply(_qb.setFromRotationMatrix(_m4).multiply(G.qGrip)));
      B.LeftHand.updateWorldMatrix(false, false);
    }
  }

  _animate(dt) {
    if (!this.mixer) return;
    const spd = this.realSpeed ?? this.speed;
    this.moveBlend += ((spd > 0.2 ? 1 : 0) - this.moveBlend) * expK(dt, 0.12);
    this.crouch += (this.crouchWant - this.crouch) * expK(dt, this.crouchWant ? 0.2 : 0.25);
    this.aimBlend += ((this.aimWant ?? 0) - this.aimBlend) * expK(dt, 0.15);
    this.flinch = Math.max(0, (this.flinch || 0) - dt * 6);
    const cr = this.crouch, ab = this.aimBlend, mb = this.moveBlend, idle = (1 - mb) * (1 - ab), A = this.actions;
    // ---- idle head scan (never in sync across the squad)
    this.scanT = (this.scanT ?? rnd(1, 3)) - dt;
    if (this.scanT <= 0) { this.scanTarget = idle > 0.5 ? rnd(-25, 25) * D : 0; this.scanT = rnd(2, 5); }
    this.scanYaw = (this.scanYaw ?? 0) + (((idle > 0.5 ? this.scanTarget ?? 0 : 0)) - (this.scanYaw ?? 0)) * expK(dt, 0.35);
    // ---- state -> clip
    const moving = spd > 0.25; let role;
    if (cr > 0.5 && this.hasCrouchClip) role = moving ? (A.crouchWalk ? 'crouchWalk' : 'crouchIdle') : (A.crouchIdle ? 'crouchIdle' : 'crouchWalk');
    else if (moving) role = spd > 2.6 && A.run ? 'run' : (A.walk ? 'walk' : 'run');
    else role = ab > 0.5 && A.aim ? 'aim' : 'idle';
    this._play(role);
    if (this.cur) {
      const nominal = this.curRole === 'run' ? RIG.speedRun : this.curRole === 'walk' ? RIG.speedWalk : this.curRole === 'crouchWalk' ? RIG.speedWalk * 0.75 : 0;
      this.cur.timeScale = (nominal ? THREE.MathUtils.clamp(spd / nominal, 0.5, 1.7) : 1) * this.build.tempo;
    }
    this._restoreMixed(); this.mixer.update(dt); this._saveMixed();
    this._applyBuild();
    // ---- procedural layer: crouch fallback, torso/head onto the aim, rifle hold
    this.group.updateMatrixWorld(true);
    const B = this.bones, right = this.right(_v3), fwd = this.forward(_v2);
    this._crouchPose(this.hasCrouchClip ? 0 : cr);
    // idle sway: slow breathing pitch, a roll, and a hip weight-shift, with per-bot amplitude and phase (animT starts at build.phase * 20)
    const S = RIG.sway, sw = this.build.sway * idle * (1 - cr), t = this.animT;
    if (sw > 0.01 && B.Hips) {
      const hx = Math.sin(t * 2 * Math.PI / S.tHips) * S.hips * sw * this._units;   // armature space: +X = the bot's left
      B.Hips.position.x += hx; B.Hips.updateWorldMatrix(false, false);
    }
    const swPitch = Math.sin(t * 2 * Math.PI / S.tPitch) * S.pitch * D * sw, swRoll = Math.sin(t * 2 * Math.PI / S.tRoll + 1.3) * S.roll * D * sw;
    const yawRel = THREE.MathUtils.clamp(wrap(this.aimYaw - this.yaw), -0.7, 0.7) + (this.hasCrouchClip ? 0 : 0);
    const pitch = this.aimPitch * ab, lean = -(this.hasCrouchClip ? 0 : cr) * 16 * D - mb * 5 * D + this.flinch * 0.15;
    const ys = RIG.aimYawSplit, ps = RIG.aimPitchSplit;
    // Bladed stance: the torso turns off the aim line so the left shoulder leads, the head turns back onto it, and
    // it opens up further as the weapon comes up. Cosmetic (it is the CS2 silhouette) but also load-bearing --
    // squared up, the left shoulder is ~9 cm further from the handguard than the arm is long, so the support-hand
    // IK clamps short and leaves the arm straight with the hand hanging off the weapon.
    const blade = RIG.blade * D * (0.55 + 0.45 * ab) * this.build.blade, sy3 = ys[0] + ys[1] + ys[2];
    rotW(B.Spine, UP, (yawRel + blade) * ys[0]); rotW(B.Spine, right, lean * 0.5 + pitch * ps[0] + swPitch * 0.5); rotW(B.Spine, fwd, swRoll * 0.5);
    rotW(B.Spine1, UP, (yawRel + blade) * ys[1]); rotW(B.Spine1, right, lean * 0.5 + pitch * ps[1] + swPitch * 0.5); rotW(B.Spine1, fwd, swRoll * 0.5);
    rotW(B.Spine2, UP, (yawRel + blade) * ys[2]); rotW(B.Spine2, right, pitch * ps[2]);
    rotW(B.Head, UP, yawRel * ys[3] - blade * sy3 + this.scanYaw); rotW(B.Head, right, pitch * ps[3] - swPitch * 0.6);
    // rifle carry while moving: full two-handed carry at a run, most of it at a walk (the low-ready is a standing hold)
    if (!A.aim) this._armPose(ab, mb * (1 - ab) * (spd > 2.6 ? 1 : 0.75));
    if (this.parts.Rifle) { this._gripPose('Right', 1); this._gripPose('Left', 1); }
    this.group.updateWorldMatrix(false, true);              // one subtree pass: hitboxes / muzzle / rifle read current matrices
  }

  _updateDeath(dt) {
    if (this.deathT < 0) return;
    this.deathT += dt;
    const t = this.deathT, R = this.parts.Rifle, B = this.bones;
    // weapon leaves the hand at 0.1 s
    if (t > 0.1 && R && R.parent !== this.game.scene) this.mgr.dropWeapon(this);
    this._restoreMixed();
    if (this.actions.death) { this.mixer.update(dt); this._saveMixed(); this._applyBuild(); this.group.updateMatrixWorld(true); return; }   // clip-driven death
    // procedural fall: 0-0.18 s collapse (knees buckle, clip freezes) -> 0.12-0.55 s the body pivots about the feet -> lies still
    const col = THREE.MathUtils.smoothstep(t, 0, 0.18);
    const f = THREE.MathUtils.clamp((t - 0.12) / 0.43, 0, 1), fall = f * f, settle = THREE.MathUtils.clamp((t - 0.5) / 0.35, 0, 1);
    const forwardFall = this.deathPose === 'face';
    this.mixer.update(dt * (1 - col)); this._saveMixed(); this._applyBuild();
    this.group.updateMatrixWorld(true);
    this._crouchPose(0.8 * col * (1 - fall));
    const right = this.right(_v3);
    rotW(B.Spine1, right, -(20 * D) * col * (1 - fall) + (forwardFall ? 12 : -20) * D * Math.sin(f * Math.PI));
    // arms go limp: shoulders drop forward-down, then flop to the ground pose
    if (B.RightArm && B.LeftArm) { rotW(B.RightArm, right, -(35 * D) * col); rotW(B.LeftArm, right, -(35 * D) * col); rotW(B.RightArm, UP, this.deathSgn * 50 * D * settle); rotW(B.LeftArm, UP, -this.deathSgn * 30 * D * settle); }
    const H = this.deathHead; rotW(B.Head, right, 0.3 * col * (1 - fall) * (forwardFall ? -1 : 1) + H[0] * settle); rotW(B.Head, UP, H[1] * fall);
    // whole body pivots about the feet (deathAxis is world-space -> group space); lifted by half a torso so nothing sinks in
    const ang = -fall * Math.PI / 2 * (forwardFall ? -1 : 1);
    _q2.setFromAxisAngle(UP, -this.yaw);
    const axisLocal = _v2.copy(this.deathAxis).applyQuaternion(_q2);
    this.model.quaternion.setFromAxisAngle(axisLocal, ang);
    if (RIG.faceZ > 0) this.model.quaternion.multiply(_q.setFromAxisAngle(UP, Math.PI));
    if (this.deathPose === 'side') this.model.quaternion.multiply(_q.setFromAxisAngle(UP, 0.7 * settle));
    this.model.position.y = this.restY + (forwardFall ? 0.20 : 0.15) * fall;
    this.group.position.copy(this.position).addScaledVector(this.deathDir, fall * 0.35);
    this.group.updateWorldMatrix(false, true);
    // The body pivots about the feet and slides 0.35 m, so the torso ends up over ground the feet never sampled (a step,
    // a crate edge, a slope): keep the pelvis at least half a torso above whatever is under it. One bounded ray per frame
    // while the body is still moving; the pose is frozen after that.
    if (t < 3 && B.Hips) {
      B.Hips.getWorldPosition(_p1);
      _ray.set(_v2.set(_p1.x, _p1.y + 1, _p1.z), DOWN);
      const g = this.map.collider.geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide, 0, 2.5);
      if (g) {
        const minY = g.point.y + (forwardFall ? 0.15 : 0.13) * fall;
        if (_p1.y < minY) { this.group.position.y += minY - _p1.y; this.group.updateWorldMatrix(false, true); }
      }
    }
  }
}

/** Ray vs capsule (segment a-b, radius r). Returns t along ray or null. */
function rayCapsule(o, d, a, b, r) {
  const ab = b.clone().sub(a), ao = o.clone().sub(a);
  const abd = ab.dot(d), abao = ab.dot(ao), ab2 = ab.lengthSq();
  const m = abd / ab2, n = abao / ab2;
  const q = d.clone().sub(ab.clone().multiplyScalar(m)), p = ao.clone().sub(ab.clone().multiplyScalar(n));
  const A = q.lengthSq(), B = 2 * q.dot(p), C = p.lengthSq() - r * r;
  if (A < 1e-8) return null;
  let disc = B * B - 4 * A * C; if (disc < 0) return null;
  let t = (-B - Math.sqrt(disc)) / (2 * A);
  const y = n + t * m;
  if (t < 0) return null;
  if (y >= 0 && y <= 1) return t;
  const center = y < 0 ? a : b;
  const oc = o.clone().sub(center); const b2 = 2 * oc.dot(d), c2 = oc.lengthSq() - r * r;
  disc = b2 * b2 - 4 * c2; if (disc < 0) return null;
  t = (-b2 - Math.sqrt(disc)) / 2; return t >= 0 ? t : null;
}
