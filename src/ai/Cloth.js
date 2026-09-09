import * as THREE from 'three';

/**
 * Cheap fabric/wear treatment for the flat-coloured bot materials: object-space weave noise,
 * darker seams in crevices (via normal), dust on the lower body, and slight per-material grain.
 *
 * `ct` (0..1): CT kit recolour. The bot atlases are baked T kits (one `bot_cloth` material per rig: skin, shirt, carrier,
 * trousers, boots in one texture), so the CT look is a runtime remap in the shader: every non-skin pixel keeps its
 * luminance (weave, dirt, panel lines, AO all survive) and takes a blue-grey chroma -- near-black gear reads as dark navy
 * (carrier, helmet, gloves), the olive / khaki cloth as grey-blue, the light tan as pale grey-khaki. Skin is kept by
 * hue: in linear light a skin tone has G/R ~0.43 against ~0.63+ for the warmest fabric, so pixels below that ratio (and
 * not near black) are left alone. It is a UNIFORM, not a define: T and CT materials compile to the same program, so the
 * CT set costs no shader compile (see BotManager._matSet / Game._warmShaders).
 */
export function applyCloth(material, { weave = 0.10, dust = 0.35, ct = 0 } = {}) {
  if (!material || !material.isMeshStandardMaterial || material.userData.cloth) return;
  material.userData.cloth = true;
  if (material.map) { weave = 0; dust *= 0.7; }              // real PBR textures already carry the weave; keep only the dust
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWeave = { value: weave };
    shader.uniforms.uDust = { value: dust };
    shader.uniforms.uCT = { value: ct };
    shader.uniforms.uFeetY = { value: 0 };
    shader.uniforms.uClothScale = { value: 1 };                // object units -> metres (skinned rigs are often authored in cm)
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uFeetY; varying vec3 vClothP; varying float vClothH;')
      // after skinning, so `transformed` is the posed vertex: the bind-pose `position` of a skinned export
      // sits in a near-degenerate space and would report every vertex as boot height.
      .replace('#include <skinning_vertex>', '#include <skinning_vertex>\nvClothP = transformed;\nvClothH = (modelMatrix * vec4(transformed,1.0)).y - uFeetY;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uWeave; uniform float uDust; uniform float uCT; varying vec3 vClothP; varying float vClothH;
float chash(vec3 p){ p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float cnoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(mix(chash(i), chash(i+vec3(1,0,0)), f.x), mix(chash(i+vec3(0,1,0)), chash(i+vec3(1,1,0)), f.x), f.y),
             mix(mix(chash(i+vec3(0,0,1)), chash(i+vec3(1,0,1)), f.x), mix(chash(i+vec3(0,1,1)), chash(i+vec3(1,1,1)), f.x), f.y), f.z); }`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  // CT recolour (uCT 0 on the T kits): luminance-preserving blue-grey remap of everything that is not skin
  vec3 cb = diffuseColor.rgb;
  float clum = dot(cb, vec3(0.2126, 0.7152, 0.0722));
  float skin = smoothstep(0.62, 0.50, cb.g / max(cb.r, 1e-4)) * smoothstep(0.02, 0.05, cb.r);
  vec3 ctc = clum * mix(vec3(1.05, 1.18, 1.55), vec3(0.96, 1.01, 1.10), smoothstep(0.015, 0.14, clum));
  ctc = max(ctc, vec3(0.006, 0.0075, 0.012));                                   // black nylon -> dark navy, not a hole
  diffuseColor.rgb = mix(cb, ctc, uCT * (1.0 - skin));
  float w = cnoise(vClothP * 180.0) * 0.5 + cnoise(vClothP * 47.0) * 0.5;      // weave + wrinkles
  float m = cnoise(vClothP * 6.0);                                              // large mottling
  float k = clamp(uWeave * 10.0, 0.0, 1.0);                                     // textured materials (uWeave 0) skip weave + mottling
  diffuseColor.rgb *= 1.0 - uWeave + uWeave * 2.0 * w;
  diffuseColor.rgb *= 1.0 + k * (0.2 * m - 0.1);
  // dust: fades in below ~0.9 m above the feet, strongest at the boots
  float d = (1.0 - smoothstep(0.0, 1.0, vClothH / 0.9)) * uDust * (0.6 + 0.4 * m);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.25, 0.17), d * 0.55);
}`);
  };
  material.needsUpdate = true;
}
