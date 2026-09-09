import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshBVH, StaticGeometryGenerator, acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh';
import { ASSETS } from '../core/Constants.js';
import { applyGrime, buildWallProximity } from './Grime.js';

THREE.Mesh.prototype.raycast = acceleratedRaycast;
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;

/**
 * Loads the Blender-authored map, builds a merged BVH collider, and extracts
 * gameplay markers (spawns, nav nodes, cover/peek spots, bombsite zone) from the
 * empties exported in the GLB.
 */
export class MapLoader {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.root = null;
    this.collider = null;   // invisible merged mesh with .geometry.boundsTree
    this.meshes = [];       // visible map meshes (for raycasts: surface type)
    this.background = [];   // skyline/hills/wires: rendered, never collided
    this.markers = { spawnCT: null, spawnT: [], nav: {}, cover: {}, bombsite: null, decals: [] };
  }

  async load(onProgress) {
    const loader = new GLTFLoader();
    const gltf = await new Promise((res, rej) => loader.load(ASSETS.MAP, res, (e) => onProgress?.(e.loaded / (e.total || 1)), rej));
    const root = gltf.scene;
    this.root = root;

    const maxAniso = this.renderer.capabilities.getMaxAnisotropy();
    root.traverse((o) => {
      if (o.isMesh) {
        const bg = !!o.userData.nocollide;
        o.castShadow = !bg;
        o.receiveShadow = true;
        o.userData.surface = o.userData.surface || 'concrete';
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) this._tuneMaterial(m, maxAniso);
        if (bg) this.background.push(o); else this.meshes.push(o);
      } else if (!o.isMesh && o.name) {
        this._marker(o);
      }
    });

    // Merged static collider + BVH (character capsule + bullet raycasts)
    const gen = new StaticGeometryGenerator(this.meshes);
    gen.attributes = ['position'];
    const merged = gen.generate();
    merged.boundsTree = new MeshBVH(merged, { targetLeafSize: 8 });
    buildWallProximity(merged);                          // sand-drift mask for the floor materials (Grime.js)
    this.collider = new THREE.Mesh(merged, new THREE.MeshBasicMaterial({ wireframe: true, color: 0x00ff88, transparent: true, opacity: 0.15 }));
    this.collider.visible = false;
    this.collider.name = 'MAP_COLLIDER';

    // Per-mesh BVH for accelerated raycasts against visible meshes (hit surface type / decals)
    for (const m of this.meshes) m.geometry.computeBoundsTree({ targetLeafSize: 8 });

    this.scene.add(root, this.collider);
    return this;
  }

  _tuneMaterial(m, maxAniso) {
    if (!m) return;
    m.envMapIntensity = 0.6;
    if (Array.isArray(m.userData?.tint)) m.color.setRGB(...m.userData.tint);
    // Dust2 floors are sun-baked, not grey concrete: nudge the asphalt/cobble/pavement albedo toward a grey-tan. Was (1.12, 1.02, 0.84),
    // which with the warm sun made the plaza read orange (sunlit ground chroma 0.48; CS2 frames sit near 0.03-0.1)
    if (/ground_road|ground_cobble|ground_pave/.test(m.name)) m.color.multiply(new THREE.Color(1.0, 1.0, 1.0));
    else if (/ground_sand|ground_dry/.test(m.name)) m.color.multiply(new THREE.Color(1.01, 1.0, 0.98));
    // plaster/stone: a hair cooler than the scanned albedo (which is warm beige to begin with), so lit walls sit near CS2's grey-cream
    else if (/wall_|bg_plaster|stone_base|trim_/.test(m.name)) m.color.multiply(new THREE.Color(0.985, 1.0, 1.02));
    for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap']) {
      if (m[k]) { m[k].anisotropy = maxAniso; m[k].minFilter = THREE.LinearMipmapLinearFilter; m[k].generateMipmaps = true; m[k].needsUpdate = true; }   // full aniso + trilinear: grazing floors stay sharp
    }
    // sun-baked sand/asphalt has a faint sheen toward the low sun (roughness 1.0 kills it); roughnessMap still modulates
    if (/ground_/.test(m.name)) m.roughness = 0.78;
    // Keep normal detail restrained: at 1.15 the plaster read as speckled gravel up close (critic pass #3)
    if (m.normalMap) { const ns = /wall|plaster|paint|bg_/.test(m.name) ? 0.5 : /ground|road|cobble|pave|hills/.test(m.name) ? 0.8 : 0.7; m.normalScale.set(ns, ns); }
    // Poly Haven metals ship metallic=0 maps; give barrels/sheet a metallic response
    if (/barrel|iron/.test(m.name)) { m.metalness = 0.55; m.roughness = Math.min(m.roughness, 0.9); }
    if (/glass/.test(m.name)) { m.roughness = 0.2; m.metalness = 0.4; m.envMapIntensity = 1.2; }
    if (m.map && !/sign|glass|car|shutter/.test(m.name)) {
      const wall = /wall|plaster|paint|trim|stone/.test(m.name), ground = /ground_|hills/.test(m.name), floor = /ground_/.test(m.name);
      // ground: no top-dust tint (it IS sand) and no drips, but sand drifts along the wall bases; walls/plaster + ground get the
      // micro-detail normal for 1 m close-ups. band: the stone skirting / plaster boundary gets a ragged, shared edge (Grime.js)
      applyGrime(m, wall ? 0.26 : floor ? 0.30 : 0.22, {   // walls 0.32 -> 0.26: with the plaster albedo flattened (Grime.js) the macro mottle carried too much of the tone
        dustTop: ground ? 0 : 1, drips: wall ? 1 : 0.4, micro: ground ? 0.12 : wall ? 0.07 : 0,   // walls low: grazing sun turns any normal grain into gravel
        drift: floor ? 1 : 0, band: /stone_base/.test(m.name) ? 1 : /wall_plaster|wall_worn/.test(m.name) ? 2 : 0,
        flatten: /wall_worn/.test(m.name) ? 0.8 : 0,   // worn_plaster_wall albedo: its baked peel patches read as camouflage on a 3 m tile
      });
    }
    m.needsUpdate = true;
  }

  _marker(o) {
    const p = new THREE.Vector3(); o.getWorldPosition(p);
    const n = o.name;
    if (n === 'SPAWN_CT') this.markers.spawnCT = p;
    else if (n.startsWith('SPAWN_T')) this.markers.spawnT.push(p);
    else if (n.startsWith('NAV_')) this.markers.nav[n.slice(4)] = p;
    else if (n.startsWith('COVER_')) {
      const q = new THREE.Quaternion(); o.getWorldQuaternion(q);
      const dir = new THREE.Vector3(1, 0, 0).applyQuaternion(q); dir.y = 0; dir.normalize();
      this.markers.cover[n.slice(6)] = { pos: p, dir };
    } else if (n.startsWith('DECAL_')) {
      const q = new THREE.Quaternion(); o.getWorldQuaternion(q);
      const normal = new THREE.Vector3(1, 0, 0).applyQuaternion(q); normal.y = 0; normal.normalize();
      const u = o.userData;
      this.markers.decals.push({ kind: u.kind, pos: p, normal, w: u.w ?? 1, h: u.h ?? 1, cell: u.cell ?? 0, alpha: u.alpha ?? 1 });
    } else if (n.startsWith('BOMBSITE')) {
      const s = new THREE.Vector3(); o.getWorldScale(s);
      this.markers.bombsite = { pos: p, radius: Math.max(s.x, s.z) };
    }
  }

  /** Raycast against the visible map meshes; returns closest hit with surface type. */
  raycast(raycaster) {
    const hits = raycaster.intersectObjects(this.meshes, false);
    if (!hits.length) return null;
    const h = hits[0];
    h.surface = h.object.userData.surface || 'concrete';
    return h;
  }
}
