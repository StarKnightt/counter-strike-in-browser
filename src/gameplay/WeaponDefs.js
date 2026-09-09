/**
 * CS2 weapon stats. Units: metres, seconds, degrees. 1u = 1.905 cm.
 * Accuracy / timing numbers are the game's own (game/csgo/pak01_dir/scripts/weapons.vdata, weapon_ak47 / weapon_awp):
 * inaccuracy values are tangents of the maximum bullet deviation (a unit-disk radius; the bullet lands uniformly-in-radius
 * inside it, so the *typical* miss is about half the max), e.g. AK stand 0.00641 => atan => 0.37° max, ~0.18° typical.
 */
import { asset } from '../core/Constants.js';

// AK-47 spray pattern: cumulative aim-punch offset in degrees for shot i (x right+, y up+). Shot 1 flies true.
// Shape: the first 3 rounds stay near-straight (shot 3 lands 0.7° / ~25 cm at 20 m above shot 1), then a steep climb
// (~0.55-0.65°/shot for shots 4-7) to 4.0° at shot 10 (~1.4 m at 20 m, CS2's ~3.5-4.5°), then the classic left drift
// (shots 10-14), right hook (15-20), left again (21-26) and back right. Peak rise ~4.5°, ~1.9° wide. The old table (7.5° at
// shot 10, 8.4° peak) was ~1.8x too steep: tapped / burst rounds vanished above the target.
function akPattern() {
  const dy = [0, 0.30, 0.40, 0.55, 0.65, 0.65, 0.55, 0.40, 0.28, 0.22, 0.07, 0.06, 0.05, 0.04, 0.03, 0.03, 0.03, 0.02, 0.02, 0.02, 0.02, 0.02, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01];
  const dx = [0, 0.03, -0.03, 0.03, 0.00, -0.03, 0.03, -0.03, -0.06, -0.11, -0.25, -0.28, -0.25, -0.19, -0.11, 0.14, 0.30, 0.39, 0.39, 0.33, 0.25, 0.11, -0.06, -0.22, -0.28, -0.25, -0.17, 0.06, 0.19, 0.22];
  const out = []; let x = 0, y = 0;
  for (let i = 0; i < 30; i++) { x += dx[i]; y += dy[i]; out.push([x, y]); }
  return out;
}

export const WEAPONS = {
  ak47: {
    name: 'AK-47', slot: 1, model: asset('models/ak47.glb'),
    mag: 30, reserve: 90, rpm: 600, damage: 36, armorPen: 0.775, headshotMult: 4.0, rangeMod: 0.98, penetration: 2,
    reloadTime: 2.43, drawTime: 1.0, auto: true,
    // CS2 vdata (tangent units). recover*: accuracy-penalty time constants, blending from the initial to the final value over
    // spray bullets 2..5 (short bursts stay tight, long sprays bloom); crouching recovers faster.
    inacc: { stand: 0.00641, crouch: 0.00481, move: 0.17506, jumpInitial: 0.10094, jump: 0.14076, fire: 0.0078, spread: 0.0006,
      recoverStand: 0.368, recoverStandFinal: 0.506, recoverCrouch: 0.305, recoverCrouchFinal: 0.42, transition: [2, 5] },
    // viewTrack 0.55 (CS2 view_recoil_tracking is 0.45): the camera shows a little over half of the punch so the visible kick
    // is closer to where the bullets go; the crosshair stays static. punchDecay (Weapons.update): exp 5/s + linear 2°/s after
    // punchHold, so a 3-4 round burst is back on the crosshair in ~0.41-0.47 s (CS2 tap timing), a full spray in ~0.6 s.
    pattern: akPattern(), recoilReset: 0.55, punchHold: 0.15, viewTrack: 0.55, punchDecay: { exp: 5, lin: 2 },
    // Viewmodel fire kick (ViewModel.fire): per-shot impulse back along the barrel (m) / muzzle up / random roll + yaw (deg),
    // returned by a spring of natural frequency omega (rad/s) and damping ratio zeta: ~100 ms settle, so at 600 rpm the
    // kicks chain into a visible buck without the gun ever leaving the frame.
    kick: { back: 0.025, up: 2.2, roll: 0.6, yaw: 0.4, omega: 46, zeta: 0.8 },   // peaks ~2.9 cm / 2.5° 23 ms after the shot, settled by ~90 ms
    // Hip pose, CS2 default viewmodel-like: low and right, barrel almost parallel to the view (the 66° viewmodel FOV would
    // otherwise pull the muzzle onto the crosshair), receiver level (roll 1.7°), mag hanging down. Muzzle ~61 % x / 59 % y.
    view: { pos: [0.29, -0.14, -0.36], rot: [0.02, 0.02, 0.03], scale: 1.0 },
    // Aim-down-sights (hold RMB; not a CS2 feature, a modern-FPS style zoom). pos/rot put the eye line through the front-post
    // tip (model 0, 0.050, -0.633) and a point 2.8 mm above the rear-sight leaf top (0, 0.0648, -0.18), so the post shows
    // ~10 px above the leaf with the tip on the screen centre: pitch atan(0.0148/0.453) = 0.03266 rad, y = -(0.0648 cos +
    // 0.18 sin) = -0.07064; z puts the rear sight 0.30 m ahead of the eye (nothing crosses the near plane inside the
    // frustum: the stock passes 6 cm under the eye line). fov = main camera (74 -> 62, 1.4x); vmFov narrows the viewmodel
    // camera so the sight picture reads at 1080p; sensitivity scales by fov / 74.
    ads: { fov: 62, vmFov: 54, pos: [0, -0.07064, -0.12], rot: [0.03266, 0, 0], time: 0.18, speed: 0.75, inacc: 0.6, viewTrack: 0.65 },
    speed: 4.10, tag: [0.4, 0.55], killIcon: 'ak47',
  },
  awp: {
    name: 'AWP', slot: 1, model: asset('models/awp.glb'),
    mag: 10, reserve: 30, rpm: 41.24, damage: 115, armorPen: 0.975, headshotMult: 4.0, rangeMod: 0.99, penetration: 2,
    reloadTime: 3.7, drawTime: 1.25, auto: false, boltTime: 1.2, scoped: true,
    // Scope FOVs: CS2 "40 / 10" are 4:3-horizontal figures like its "fov 90" (= RENDER.FOV 74 vertical); converted the same way:
    // 2*atan(tan(fov/2)*3/4) => 30.5° / 7.5° vertical (2.75x / 11.4x magnification). zoomSens = zoom_sensitivity_ratio 1 (fov/90).
    zoom: [30.5, 7.5], zoomSens: [40 / 90, 10 / 90], zoomSpeed: 0.5,          // scoped run speed 100u vs 200u
    inacc: { stand: 0.0808, crouch: 0.0606, move: 0.17648, jumpInitial: 0.17286, jump: 0.13383, fire: 0.05385, spread: 0.0002,
      recoverStand: 0.345, recoverStandFinal: 0.345, recoverCrouch: 0.247, recoverCrouchFinal: 0.247, transition: [2, 5] },
    inaccScoped: { stand: 0.002, crouch: 0.0015, move: 0.17648, jumpInitial: 0.17286, jump: 0.13383, fire: 0.05385, spread: 0.0002,
      recoverStand: 0.345, recoverStandFinal: 0.345, recoverCrouch: 0.247, recoverCrouchFinal: 0.247, transition: [2, 5] },
    pattern: [[0, 0], [0.3, 3.0], [-0.3, 3.0], [0.3, 3.0], [-0.3, 3.0]], recoilReset: 0.55, punchHold: 0.20, viewTrack: 0.45,
    kick: { back: 0.048, up: 2.6, roll: 1.2, yaw: 0.6, omega: 30, zeta: 0.75 },   // heavier, slower return than the AK (peaks ~5.7 cm / 3.1°); the bolt-cycle anim plays on top
    view: { pos: [0.26, -0.165, -0.42], rot: [0.03, 0.10, 0.03], scale: 1.0 },   // low-right, level, barrel angled gently in (long gun): muzzle ~54 % x / 55 % y, scope eyepiece at the right edge, grip hand bottom-right
    speed: 3.81, tag: [0.35, 0.4], killIcon: 'awp',
  },
  knife: {
    name: 'Knife', slot: 3, model: asset('models/knife.glb'),
    melee: true, drawTime: 1.0,
    // CS2: light slash 40 (90 from behind), heavy stab 65 (180 from behind), reach 48u
    primary: { time: 0.4, damage: 40, backstab: 90, range: 0.91 }, secondary: { time: 1.0, damage: 65, backstab: 180, range: 0.91 },
    // melee has no bullet deviation, but every def carries the full block Weapons.js reads (the accuracy code never runs for
    // the knife; zeros keep it well-defined if it ever does, e.g. a frame between a switch and the def check)
    inacc: { stand: 0, crouch: 0, move: 0, jumpInitial: 0, jump: 0, fire: 0, spread: 0,
      recoverStand: 0.3, recoverStandFinal: 0.3, recoverCrouch: 0.3, recoverCrouchFinal: 0.3, transition: [2, 5] },
    pattern: [[0, 0]], recoilReset: 0.55, punchHold: 0.15, viewTrack: 0,
    // hammer grip lower-right, blade up-left with the tip near screen centre-right (rot must match KNIFE_ROT in tools/build_weapons.py)
    view: { pos: [0.20, -0.14, -0.35], rot: [1.112, 0.582, 0.999], scale: 1.0 },
    speed: 4.76, tag: [0.3, 0.3], killIcon: 'knife',
  },
};

/** CS2 damage falloff: damage * rangeMod^(dist_m / 9.525m [500u]) */
export function falloff(def, dist) { return Math.pow(def.rangeMod ?? 1, dist / 9.525); }

/** CS2 armor formula. Returns {hp, armor} damage split. */
export function applyArmor(rawDmg, armorPen, armor) {
  if (armor <= 0) return { hp: rawDmg, armorLoss: 0 };
  const hp = rawDmg * armorPen;
  const armorLoss = Math.min(armor, (rawDmg - hp) * 0.5);
  return { hp: Math.round(hp), armorLoss: Math.round(armorLoss) };
}
