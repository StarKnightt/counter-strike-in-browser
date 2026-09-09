import * as THREE from 'three';

/**
 * Renders flat white side-view silhouettes of the actual weapon meshes (CS2 killfeed / ammo glyph style)
 * into data URLs at load. Hands, arms and sleeves are excluded so only the gun reads.
 */
export function renderWeaponIcons(renderer, sources, { w = 128, h = 56 } = {}) {
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  const rt = new THREE.WebGLRenderTarget(w, h, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true });
  const white = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false });
  const px = new Uint8Array(w * h * 4);
  const out = {};
  const prevTarget = renderer.getRenderTarget(), prevClear = renderer.getClearAlpha(), prevCol = new THREE.Color(); renderer.getClearColor(prevCol);
  for (const [id, src] of Object.entries(sources)) {
    if (!src) continue;
    const clone = src.clone(true);
    const kill = [];
    clone.traverse((o) => {
      // body parts only: 'hand(?!le)' keeps the knife 'handle*' primitives and the AWP 'bolt_handle' (plain /hand/ threw the
      // whole knife away, so it had no glyph and the HUD / killfeed fell back to text)
      if (/hand(?!le)|arm|sleeve|finger|glove/i.test(o.name)) kill.push(o);
      else if (o.isMesh) { o.material = white; o.frustumCulled = false; o.visible = true; }
      if (!o.isMesh) o.visible = true;
    });
    for (const o of kill) o.parent?.remove(o);
    clone.position.set(0, 0, 0); clone.rotation.set(0, 0, 0); clone.scale.setScalar(1);
    clone.updateMatrixWorld(true);
    let box = new THREE.Box3().setFromObject(clone);
    if (box.isEmpty()) continue;
    let size = box.getSize(new THREE.Vector3());
    // guns are modelled barrel-along-Z; the knife blade runs +Y (edge -Z). Lay a tall model down (+Y -> -Z, edge -> down)
    // so every glyph is a horizontal side view like CS2's.
    if (size.y > size.z * 1.5) { clone.rotation.x = -Math.PI / 2; clone.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(clone); size = box.getSize(new THREE.Vector3()); }
    const c = box.getCenter(new THREE.Vector3());
    // side view: barrel along Z, camera on +X looking -X
    const len = size.z, tall = size.y;
    const aspect = w / h, half = Math.max(len / 2, tall / 2 * aspect) * 1.06;
    cam.left = -half; cam.right = half; cam.top = half / aspect; cam.bottom = -half / aspect; cam.updateProjectionMatrix();
    cam.position.set(c.x + 10, c.y, c.z); cam.lookAt(c); cam.up.set(0, 1, 0);
    scene.add(clone);
    renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, cam);
    renderer.readRenderTargetPixels(rt, 0, 0, w, h, px);
    scene.remove(clone);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const s = ((h - 1 - y) * w + x) * 4, d = (y * w + x) * 4;      // flip Y (GL origin is bottom-left)
      const a = px[s + 3];
      img.data[d] = 240; img.data[d + 1] = 240; img.data[d + 2] = 240; img.data[d + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    // muzzle should point left in the killfeed like CS2: the vm barrel points -Z which the +X camera renders to the left already
    out[id] = cv.toDataURL('image/png');
  }
  renderer.setRenderTarget(prevTarget); renderer.setClearColor(prevCol, prevClear);
  rt.dispose(); white.dispose();
  return out;
}
