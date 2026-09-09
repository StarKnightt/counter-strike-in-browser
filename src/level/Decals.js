import * as THREE from 'three';

/**
 * Static wall decals authored in Blender as DECAL_* empties (local +X = wall normal, userData: kind/w/h/cell/alpha).
 * Three 2x2 sheets: grime + graffiti are white-background multiply decals; posters are alpha-keyed from white.
 */
const SHEET = {
  streak: 'grime', splash: 'grime', pocks: 'grime', stain: 'grime',
  poster: 'posters', sign: 'posters', posters: 'posters', sign2: 'posters',
  tag: 'graffiti', stencil: 'graffiti', script: 'graffiti', marks: 'graffiti',
};

async function loadImage(url) {
  const img = new Image(); img.src = url; await img.decode(); return img;
}

/** White -> transparent keying for the poster sheet (posters are opaque; keep cream tones). */
function keyWhite(img) {
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d'); ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height), p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const mn = Math.min(p[i], p[i + 1], p[i + 2]);
    const a = THREE.MathUtils.clamp((250 - mn) / 14, 0, 1);       // 250+ white -> 0, <=236 -> opaque
    p[i + 3] = Math.round(255 * a);
  }
  ctx.putImageData(d, 0, 0);
  return c;
}

export class Decals {
  constructor(scene) { this.scene = scene; this.group = new THREE.Group(); this.group.name = 'DECALS'; scene.add(this.group); }

  async load(markers) {
    if (!markers?.length) return this;
    const [grime, graffiti, postersImg] = await Promise.all(['grime', 'graffiti', 'posters'].map((n) => loadImage(`/textures/decals/${n}.png`)));
    const tex = (src) => { const t = new THREE.CanvasTexture(src); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; return t; };
    const grimeC = document.createElement('canvas'); grimeC.width = grime.width; grimeC.height = grime.height; grimeC.getContext('2d').drawImage(grime, 0, 0);
    const T = { grime: tex(grimeC), graffiti: tex(keyWhite(graffiti)), posters: tex(keyWhite(postersImg)) };
    // material per (sheet, alpha bucket): multiply sheets fade toward white with alpha, posters use real alpha
    const mats = new Map();
    const matFor = (sheet, alpha) => {
      const key = `${sheet}:${alpha.toFixed(2)}`;
      if (mats.has(key)) return mats.get(key);
      let m;
      if (sheet !== 'grime') {
        // pigment (paper / paint): lit like the wall, real alpha from white keying
        m = new THREE.MeshStandardMaterial({ map: T[sheet], transparent: true, opacity: alpha, roughness: 0.85, metalness: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, alphaTest: 0.02 });
      } else {
        m = new THREE.MeshBasicMaterial({ map: T[sheet], blending: THREE.MultiplyBlending, premultipliedAlpha: true, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, toneMapped: false });
        // fade multiply toward white: color = mix(1, tex, alpha)  -> tex*alpha + (1-alpha)
        m.onBeforeCompile = (s) => {
          s.uniforms.uAlpha = { value: alpha };
          s.fragmentShader = s.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uAlpha;')
            .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb = mix(vec3(1.0), diffuseColor.rgb, uAlpha);');
        };
        m.customProgramCacheKey = () => 'mul' + alpha.toFixed(2);
      }
      mats.set(key, m); return m;
    };
    const geo = new THREE.PlaneGeometry(1, 1);
    for (const d of markers) {
      const sheet = SHEET[d.kind]; if (!sheet) continue;
      const g = geo.clone();
      const uv = g.attributes.uv; const cx = (d.cell % 2) * 0.5, cy = d.cell < 2 ? 0.5 : 0.0;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, cx + uv.getX(i) * 0.5, cy + uv.getY(i) * 0.5);
      const alpha = Math.min(1, (d.alpha ?? 1) * (d.kind === 'streak' ? 1.35 : 1));
      const mesh = new THREE.Mesh(g, matFor(sheet, alpha));
      mesh.position.copy(d.pos);
      mesh.lookAt(d.pos.clone().add(d.normal));       // plane +Z faces along the normal
      mesh.scale.set(d.w, d.h, 1);
      mesh.renderOrder = sheet === 'posters' ? 2 : 1;
      mesh.receiveShadow = true; mesh.castShadow = false; mesh.matrixAutoUpdate = false; mesh.updateMatrix();
      this.group.add(mesh);
    }
    return this;
  }
}
