export const ASSETS = {
  MAP: '/models/dust2_a.webp.glb',
};

export const RENDER = {
  // adaptive render scale (RenderScale), independent of devicePixelRatio (a 1080p desktop at DPR 1 sat pinned at 1.0 with a 5 ms GPU frame):
  // starts at START, steps down one level when the GPU frame > 13 ms, up one when < 9 ms for 3 s. ?scale=1.5 pins it.
  // Headless 1080p GPU frame: 6.2 ms @1.0, 7.2 @1.25, 9.0 @1.4, 10.3-16.8 @1.5 (bimodal) => capped at 1.4
  MAX_PIXEL_RATIO: 1.4,
  START_PIXEL_RATIO: 1.25,
  MIN_PIXEL_RATIO: 1.0,
  SHADOW_MAP: 4096,
  SHADOW_EXTENT: 50, // half-size of the ortho shadow frustum (m); follows the player, texel-snapped (Sky.follow). 100 m / 4096 = 2.4 cm texels; the ground footprint along the sun azimuth is /sin(elev) => long doors from site still covered
  SHADOW_DEPTH_RANGE: 220, // shadow camera far - near (Sky.js: 40..260 m); ShadowFilter scales its receiver-plane slope clamp by EXTENT/RANGE
  SHADOW_RADIUS: 1.8, // PCF kernel (texels): 1.4 left crate/stair shadow edges stair-stepped at 1080p; 1.8 softens without acne (normalBias unchanged)
  FOV: 74,     // vertical. CS2 "fov 90" is 4:3-horizontal => 106° horizontal / 73.7° vertical at 16:9
  VM_FOV: 66,  // viewmodel camera FOV (vertical). Wider than CS2's viewmodel_fov 68 (4:3-horizontal => 54° vertical) so both hands + the mag stay in frame; ViewModel.worldPos re-projects the muzzle for the main FOV
  EXPOSURE: 1.06,
};

export const SUN = {
  // direction the light comes FROM (unit-ish). Late-afternoon sun from the ESE (+X, +Z): ~39° elevation,
  // so the east wall and the site crates throw long shadows raking NW across the plant zone.
  DIR: [0.78, 0.80, 0.62],
  COLOR: 0xffe6c8,          // warm afternoon sun (~4800 K). Was 0xffdcb0 (chroma 0.31): it pushed every lit surface orange — sunlit ground measured chroma 0.48 vs 0.03 in CS2 frames
  INTENSITY: 5.6,           // lit plaster lands at ~linear 1.5-2.5 => 235-245 sRGB under ACES, not clipped
  SKY_COLOR: 0x8aa6cf,      // cool blue-grey sky bounce: shadows read blue against the warm sun
  GROUND_COLOR: 0x807868,   // neutral-tan bounce (was warm 0x8c7657): shadows go neutral-cool, not orange; low so shadow floors keep their texture
  HEMI_INTENSITY: 0.50,     // sun:fill ~8:1 (sun 5.6) => hard contrast; before: 3.3 vs 0.5 => everything mid-tone
  ENV_INTENSITY: 0.40,
  FOG_COLOR: 0xe4d6bc,      // legacy/unused: the fog colour is derived from the sky dome's horizon (Sky.fogColor), cooled slightly so far hills read as a pale silhouette
  FOG_DENSITY: 0.0105,      // FogExp2: 9 % at 30 m, 34 % at 60 m, 67 % at 100 m, 92 % at 150 m => far rooftops lift toward the haze (aerial perspective). Was 0.0062 with a fog colour ≈ the plaster albedo: invisible
  FOG_DESAT: 0.5,           // grade: extra depth-driven desaturation reached at ~150 m (PostFX), on top of the fog's own colour pull; the sky is excluded

};

// 1 CS unit = 1.905 cm. Values below are CS2's converted to metres.
export const PLAYER = {
  EYE_HEIGHT: 1.62,        // 64u stand eye ≈ 1.22? CS2 eye 64u=1.22m is low for 1.8m capsule; we use a taller, more natural 1.62
  CROUCH_EYE: 1.08,
  RADIUS: 0.33,
  HEIGHT: 1.8,
  CROUCH_HEIGHT: 1.25,
  SPEED: { knife: 4.76, ak47: 4.10, awp: 3.81 },   // 250u / 215u / 200u per second
  WALK_MULT: 0.52,
  CROUCH_MULT: 0.34,
  GROUND_ACCEL: 10.0,      // Quake-style accelerate (per second, scaled by wishspeed)
  GROUND_FRICTION: 6.5,
  AIR_ACCEL: 1.2,
  JUMP_SPEED: 5.75,        // ≈ 57u jump height
  GRAVITY: 15.24,          // 800 u/s²
  STRIDE: 2.2,             // metres between footsteps at run speed
  MAX_HP: 100,
};
