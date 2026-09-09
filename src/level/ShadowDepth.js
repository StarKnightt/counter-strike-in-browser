import * as THREE from 'three';

/**
 * Per-mesh shadow depth materials.
 *
 * three's WebGLShadowMap renders every caster with ONE shared MeshDepthMaterial and copies map/alphaMap/alphaTest/side onto
 * it per object. Static, skinned (bots) and instanced (litter) casters alternate on that one material, so its program
 * parameters flip every draw and the renderer re-runs getProgram/getParameters/getProgramCacheKey for each caster, every
 * frame (~7 % CPU, ~190 MB/10 s of garbage in a live round). Giving each (source material, skinned?, instanced?) tuple its
 * own depth material keeps the parameters stable, so the program lookup happens once and the shadow pass is pure draw calls.
 * Output is identical: same RGBADepthPacking, same alpha test, same side flip (the renderer still applies those per draw).
 */
const cache = new WeakMap();                                 // source material -> { '' | 's' | 'i' | 'si': MeshDepthMaterial }

export function assignDepthMaterial(mesh) {
  if (!mesh.isMesh || !mesh.castShadow || mesh.customDepthMaterial) return;
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const m0 = mats[0]; if (!m0) return;
  // a multi-material mesh gets one custom material for all its groups: they must agree on what the depth shader samples
  for (const m of mats) if (m.map !== m0.map || m.alphaMap !== m0.alphaMap || (m.alphaTest > 0) !== (m0.alphaTest > 0) || m.side !== m0.side) return;
  const key = (mesh.isSkinnedMesh ? 's' : '') + (mesh.isInstancedMesh ? 'i' : '');
  let v = cache.get(m0); if (!v) cache.set(m0, v = {});
  // `?? null`: materials without a map/alphaMap slot (ShaderMaterial) would otherwise pass undefined (setValues warns)
  mesh.customDepthMaterial = v[key] ||= new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: m0.map ?? null, alphaMap: m0.alphaMap ?? null, alphaTest: m0.alphaTest ?? 0, side: m0.side });
}

export function assignDepthMaterials(root) { root.traverse(assignDepthMaterial); }
