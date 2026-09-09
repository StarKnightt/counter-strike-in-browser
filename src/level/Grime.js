import * as THREE from 'three';

/**
 * World-space macro grime: breaks up tiled PBR textures with a large-scale (≈20 m) mottling
 * so walls and ground stop reading as "one tile repeated". Injected into MeshStandardMaterial.
 */
let grimeTex = null;

function makeGrimeTexture(size = 512) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#808080'; ctx.fillRect(0, 0, size, size);
  // layered soft blobs at 3 scales -> cheap fbm-like mottling (tileable via wrap-around draws)
  const rnd = mulberry32(1337);
  const layers = [[18, 140, 0.10], [60, 60, 0.08], [220, 22, 0.06]];
  for (const [count, rad, alpha] of layers) {
    for (let i = 0; i < count; i++) {
      const x = rnd() * size, y = rnd() * size, r = rad * (0.6 + rnd() * 0.8);
      const dark = rnd() < 0.55;
      for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size], [size, size], [-size, -size], [size, -size], [-size, size]]) {
        const g = ctx.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
        g.addColorStop(0, `rgba(${dark ? 0 : 255},${dark ? 0 : 255},${dark ? 0 : 255},${alpha})`);
        g.addColorStop(1, 'rgba(128,128,128,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x + ox, y + oy, r, 0, Math.PI * 2); ctx.fill();
      }
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.NoColorSpace;
  return t;
}

/** Floor levels the shaders know about (world y); must match FLOOR_LEVELS_GLSL below. */
const FLOOR_LEVELS = [0.0, -3.5, 2.5, -2.4];
let wallMask = null;                                    // { tex, origin: Vector2, size: Vector2 } — see buildWallProximity
const wallMaskUniforms = new Set();                     // shader uniform sets that need the mask once it exists

/**
 * Wall-proximity mask for the sand drifts: the collider's near-vertical triangles are projected onto XZ and stroked
 * (0.9 m wide, blurred 0.5 m) into one of four channels by the floor level their base sits on (R/G/B/A = FLOOR_LEVELS),
 * so a ground fragment at y≈0 only sees the walls that meet *its* floor, not a parapet on the roof above. 512² over the
 * map's footprint ≈ 0.25 m/texel. Called once by MapLoader after the BVH collider exists; ground materials pick it up.
 */
export function buildWallProximity(geometry) {
  const pos = geometry.attributes.position, idx = geometry.index;
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, pad = 4;
  const origin = new THREE.Vector2(bb.min.x - pad, bb.min.z - pad), size = new THREE.Vector2(bb.max.x - bb.min.x + 2 * pad, bb.max.z - bb.min.z + 2 * pad);
  const S = 512, px = S / Math.max(size.x, size.y);        // texels per metre (square texels; the canvas covers max(size) both ways)
  const layers = FLOOR_LEVELS.map(() => { const c = document.createElement('canvas'); c.width = c.height = S; const x = c.getContext('2d'); x.fillStyle = '#000'; x.fillRect(0, 0, S, S); x.strokeStyle = '#fff'; x.lineWidth = 0.9 * px; x.lineCap = 'round'; return x; });
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), n = new THREE.Vector3(), e1 = new THREE.Vector3(), e2 = new THREE.Vector3();
  const tri = idx ? idx.count / 3 : pos.count / 3;
  const X = (x) => (x - origin.x) * px, Z = (z) => (z - origin.y) * px;
  for (let t = 0; t < tri; t++) {
    const i0 = idx ? idx.getX(t * 3) : t * 3, i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1, i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    n.crossVectors(e1.subVectors(b, a), e2.subVectors(c, a));
    const len = n.length(); if (len < 1e-6 || Math.abs(n.y / len) > 0.3) continue;          // walls only
    const minY = Math.min(a.y, b.y, c.y), maxY = Math.max(a.y, b.y, c.y);
    if (maxY - minY < 0.4) continue;                                                        // curbs / steps are not walls
    let ch = -1; for (let k = 0; k < FLOOR_LEVELS.length; k++) if (Math.abs(minY - FLOOR_LEVELS[k]) < 0.75) ch = k;
    if (ch < 0) continue;
    const x = layers[ch]; x.beginPath(); x.moveTo(X(a.x), Z(a.z)); x.lineTo(X(b.x), Z(b.z)); x.lineTo(X(c.x), Z(c.z)); x.closePath(); x.stroke();
  }
  // soften (0.5 m) and pack the four channels
  const out = document.createElement('canvas'); out.width = out.height = S; const ox = out.getContext('2d', { willReadFrequently: true });
  const data = new Uint8ClampedArray(S * S * 4);
  layers.forEach((x, k) => {
    ox.clearRect(0, 0, S, S); ox.filter = `blur(${(0.5 * px).toFixed(1)}px)`; ox.drawImage(x.canvas, 0, 0); ox.filter = 'none';
    const d = ox.getImageData(0, 0, S, S).data;
    for (let i = 0; i < S * S; i++) data[i * 4 + k] = d[i * 4];
  });
  const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat); tex.needsUpdate = true;
  tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping; tex.colorSpace = THREE.NoColorSpace;
  wallMask = { tex, origin, size: new THREE.Vector2(Math.max(size.x, size.y), Math.max(size.x, size.y)) };
  for (const u of wallMaskUniforms) { u.uWallMask.value = tex; u.uWallMaskRect.value.set(origin.x, origin.y, wallMask.size.x, wallMask.size.y); }
  return wallMask;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/**
 * @param {number} strength  macro mottle strength
 * @param {object} opts  dustTop: sand settling on upward faces (0..1); drips: rain-streak darkening on walls (0..1);
 *                       micro: procedural micro-detail normal blend (0 = off) so 1 m close-ups are not a blurry tile;
 *                       drift: sand drifts on the floor along wall bases (0..1; needs buildWallProximity);
 *                       band: 1 = the stone skirting (its top edge frays into the plaster), 2 = plaster above the skirting (stained
 *                             down to it with a ragged edge) — breaks the razor-straight tan/cream mesh boundary at floor + 0.89 m
 *                       flatten: 0..1 removal of the albedo's own low-frequency patches (see the plaster map_fragment below)
 */
export function applyGrime(material, strength = 0.28, { dustTop = 1, drips = 1, micro = 0, drift = 0, band = 0, flatten = 0 } = {}) {
  if (!material || !material.isMeshStandardMaterial || material.userData.grime) return;
  material.userData.grime = true;
  grimeTex ||= makeGrimeTexture();
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uGrime = { value: grimeTex };
    shader.uniforms.uGrimeStrength = { value: strength };
    shader.uniforms.uGrimeOpts = { value: new THREE.Vector3(dustTop, drips, micro) };
    shader.uniforms.uGrimeOpts2 = { value: new THREE.Vector3(drift, band, flatten) };
    shader.uniforms.uWallMask = { value: wallMask?.tex ?? null };
    shader.uniforms.uWallMaskRect = { value: wallMask ? new THREE.Vector4(wallMask.origin.x, wallMask.origin.y, wallMask.size.x, wallMask.size.y) : new THREE.Vector4(0, 0, 1, 1) };
    if (drift > 0) wallMaskUniforms.add(shader.uniforms);
    material.userData.grimeUniforms = shader.uniforms;   // live tuning / perf A-B from the console
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrimeP; varying vec3 vGrimeN;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGrimeP = (modelMatrix * vec4(position,1.0)).xyz;\nvGrimeN = normalize(mat3(modelMatrix) * normal);');
    // floors: anti-repeat albedo. A second copy of the map, rotated 90° and offset, is blended in over soft ~8 m world-space
    // islands, so the cobble motif never lines up with itself across the plaza (the normal/roughness maps keep the base tiling:
    // at normalScale 0.8 the mismatch is invisible, the tile grid is not). One extra texture fetch.
    const mapFragment = drift > 0 ? /* glsl */`
#ifdef USE_MAP
{
  mat2 rotB = mat2(0.28, 0.96, -0.96, 0.28);
  float wB = smoothstep(0.44, 0.56, texture2D(uGrime, rotB * vGrimeP.xz * 0.055 + 0.57).r);
  vec4 sampledDiffuseColor = mix(texture2D(map, vMapUv), texture2D(map, vec2(-vMapUv.y, vMapUv.x) + vec2(0.37, 0.71)), wB);
  diffuseColor *= sampledDiffuseColor;
}
#endif` : flatten > 0 ? /* glsl */`
#ifdef USE_MAP
{
  // plaster: the worn-plaster albedo (Poly Haven worn_plaster_wall, even after grade_textures.py's 0.62 blend toward the smooth
  // plaster) still carries its 0.5-1 m peeled-paint patches, which on a 3 m tile read as camouflage blotches (every other layer —
  // mottle, drips, normal, roughness, AO, shadow, decals, env — was toggled off and they stayed). Flatten the albedo's low frequencies
  // in-shader: divide by its own ~2 cm blur (mip 4) normalised by the whole-tile mean (top mip), keeping the grain. Mip 6 (~10 cm)
  // left the patch outlines as rings (sharp edge in the texture, soft edge in the blur); mip 4 dissolves the edges too. Partial
  // flattening leaves faint tonal islands so the wall is not a flat card. Two extra fetches, tiny mips, cache-resident.
  vec4 sampledDiffuseColor = texture2D(map, vMapUv);
  vec3 lo = textureLod(map, vMapUv, 4.0).rgb, mean = textureLod(map, vMapUv, 12.0).rgb;
  sampledDiffuseColor.rgb *= mix(vec3(1.0), mean / max(lo, vec3(1e-3)), uGrimeOpts2.z);
  diffuseColor *= sampledDiffuseColor;
}
#endif` : '#include <map_fragment>';
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uGrime, uWallMask; uniform float uGrimeStrength; uniform vec3 uGrimeOpts; uniform vec3 uGrimeOpts2; uniform vec4 uWallMaskRect; varying vec3 vGrimeP; varying vec3 vGrimeN;\nfloat gGrimeMottle = 0.5;')
      .replace('#include <map_fragment>', `${mapFragment}
{
  float ny = vGrimeN.y; float up = abs(ny);
  // three octaves (20 m / 7.7 m / 4 m), the smaller ones rotated so the tiling never lines up into stripes
  vec2 pH = vGrimeP.xz; vec2 pV = vec2(vGrimeP.x + vGrimeP.z, vGrimeP.y * 1.6);
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8); mat2 rot2 = mat2(0.28, 0.96, -0.96, 0.28);
  float gH = texture2D(uGrime, pH * 0.05).r * 0.45 + texture2D(uGrime, rot * pH * 0.13 + 0.37).r * 0.30 + texture2D(uGrime, rot2 * pH * 0.25 + 0.71).r * 0.25;
  float gV = texture2D(uGrime, pV * 0.055).r * 0.45 + texture2D(uGrime, rot * pV * 0.11 + 0.61).r * 0.30 + texture2D(uGrime, rot2 * pV * 0.23 + 0.13).r * 0.25;
  float g = mix(gV, gH, step(0.5, up));
  gGrimeMottle = g;
  // walls: darken the lowest ~1.2 m above any floor level we use (0, -3.5, 2.5, -2.4) -> splash/dust skirt
  float skirt = 0.0; float bleach = 0.0; float drip = 0.0; float fray = 0.0;
  if (up < 0.5) {
    float y = vGrimeP.y;
    float d = min(min(abs(y - 0.0), abs(y + 3.5)), min(abs(y - 2.5), abs(y + 2.4)));
    // splash/dust skirt (0..1.3 m) with a mottled edge so it is not a clean horizontal line
    skirt = (1.0 - smoothstep(0.0, 1.3 + 0.8 * (g - 0.5), d)) * 0.16;
    // sun-bleached upper storeys: slightly lighter + less saturated 4 m up
    bleach = smoothstep(2.5, 6.0, y) * 0.08;
    // rain streaks: narrow vertical runs (grime texture stretched 40:1) that only exist in some patches (macro mottle),
    // strongest well above the local floor where water sheds off parapets / sills, fading out toward the ground
    float floorY = y >= 2.5 ? 2.5 : y >= 0.0 ? 0.0 : y >= -2.4 ? -2.4 : -3.5;
    float h = y - floorY;
    float s = texture2D(uGrime, vec2((vGrimeP.x + vGrimeP.z) * 0.9 + vGrimeN.x * 0.3, y * 0.022)).r;
    float runs = smoothstep(0.56, 0.72, s);
    float zone = smoothstep(0.50, 0.62, texture2D(uGrime, vec2(vGrimeP.x + vGrimeP.z, y) * 0.07 + 0.23).r);
    drip = runs * zone * smoothstep(1.2, 3.2, h) * 0.13 * uGrimeOpts.y;
    // stone skirting / plaster boundary (floor + 0.89 m): both sides read the same world-space noise, so the ragged edge is one shape.
    // e = irregular edge height (±14 cm) from a 1.5 m noise + faint 25 cm detail; r = short vertical runs below it
    if (uGrimeOpts2.y > 0.5) {
      float top = 0.89;
      // (the grime texture is low-contrast, 128 ± ~25: the ×1.4 / ×0.3 factors turn that into ±14 cm / ±3 cm)
      float e = (texture2D(uGrime, vec2((vGrimeP.x + vGrimeP.z) * 0.33, 0.5 + floorY * 0.1)).r - 0.5) * 1.4
              + (texture2D(uGrime, vec2((vGrimeP.x + vGrimeP.z) * 2.1, 0.2 + floorY * 0.1)).r - 0.5) * 0.3;
      float r = smoothstep(0.52, 0.62, texture2D(uGrime, vec2((vGrimeP.x + vGrimeP.z) * 1.7 + 0.4, y * 0.05)).r);
      if (uGrimeOpts2.y < 1.5) fray = smoothstep(top + e - 0.26 - 0.3 * r, top + e - 0.02, h);           // skirting: top edge fades into plaster tone
      else fray = -(1.0 - smoothstep(top + e, top + e + 0.10 + 0.4 * r, h)) * step(top - 0.3, h);         // plaster: stained down to the skirting
    }
  }
  diffuseColor.rgb *= mix(1.0, 0.72 + 0.56 * g, uGrimeStrength * 2.0) * (1.0 - skirt) * (1.0 - drip);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.33))) * 1.08 + 0.02, bleach);
  if (fray > 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.33))) * 1.3 + 0.05, fray * 0.6);    // toward pale plaster
  else if (fray < 0.0) diffuseColor.rgb *= 1.0 + fray * 0.30;                                                                     // dust stain (toward the stone tone)
  // settled dust: upward-facing surfaces (crate tops, ledges, sills, parapets) pick up a thin warm sand film
  float dust = smoothstep(0.70, 0.95, ny) * (0.30 + 0.45 * g) * uGrimeOpts.x;
  vec3 sand = vec3(0.62, 0.53, 0.40);
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb, sand, 0.55), dust * 0.6);
  // sand drifts along wall bases (floors only): wall-proximity mask (channel = this floor level) gated by a ~3 m world noise
  // for an irregular, broken edge; lightens toward pale sand and flattens the cobble contrast underneath
  if (uGrimeOpts2.x > 0.0 && ny > 0.7) {
    // warmth mottle (~6 m): some patches a touch warmer/darker, others greyer/paler — a tile repeat is far harder to spot when
    // the hue drifts too, and this is exactly how a trodden plaza wears (dust in the low spots, polished stone on the paths)
    float gw = texture2D(uGrime, rot * vGrimeP.xz * 0.16 + 0.83).r - 0.5;
    diffuseColor.rgb *= mix(vec3(1.0), vec3(1.05, 1.0, 0.92), gw * 4.0) * (1.0 - gw * 0.6);
    vec2 muv = (vGrimeP.xz - uWallMaskRect.xy) / uWallMaskRect.zw;
    vec4 m4 = texture2D(uWallMask, muv);
    float y = vGrimeP.y;
    float m = y >= 1.25 ? m4.b : y >= -1.2 ? m4.r : y >= -2.95 ? m4.a : m4.g;
    float n = texture2D(uGrime, rot2 * vGrimeP.xz * 0.31 + 0.19).r * 0.7 + texture2D(uGrime, vGrimeP.xz * 0.9 + 0.43).r * 0.3;
    float drift = smoothstep(0.28, 0.72, m * (0.55 + 1.1 * (n - 0.5)) + 0.25 * m) * uGrimeOpts2.x;
    vec3 pale = vec3(0.62, 0.57, 0.48);
    diffuseColor.rgb = mix(diffuseColor.rgb, mix(diffuseColor.rgb * 0.5 + 0.5 * dot(diffuseColor.rgb, vec3(0.33)), pale, 0.6), drift * 0.75);
  }
}`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
if (uGrimeOpts.z > 0.0) {
  // procedural micro-detail normal: cheap bump from the grime texture at ~6 cycles/m, blended lightly. Mipmapping fades it with distance.
  vec2 mp = (abs(vGrimeN.y) > 0.5 ? vGrimeP.xz : vec2(vGrimeP.x + vGrimeP.z, vGrimeP.y)) * 6.0;
  float h0 = texture2D(uGrime, mp).r, hx = texture2D(uGrime, mp + vec2(0.012, 0.0)).r, hy = texture2D(uGrime, mp + vec2(0.0, 0.012)).r;
  vec3 T = abs(vGrimeN.y) > 0.5 ? vec3(1.0, 0.0, 0.0) : normalize(cross(vec3(0.0, 1.0, 0.0), vGrimeN));
  vec3 B = abs(vGrimeN.y) > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  vec3 wp = (T * (h0 - hx) + B * (h0 - hy)) * 14.0 * uGrimeOpts.z;
  normal = normalize(normal + mat3(viewMatrix) * wp);
}`);
  };
  material.customProgramCacheKey = () => `grime${dustTop}${drips}${micro}${drift}${band}${flatten > 0 ? 'f' : ''}`;
  material.needsUpdate = true;
}
