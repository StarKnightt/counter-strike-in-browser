import * as THREE from 'three';

/**
 * Muzzle-flash sprite textures: a hot white core, short asymmetric orange petals, a few sparks and a faint smoke ring.
 * Several variants are generated (the shooter picks one per shot + a random roll) so a spray never repeats one shape.
 * Drawn for additive blending: transparent background, the alpha carries the shape.
 */
export function makeFlashTextures(n = 4, s = 128) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = document.createElement('canvas'); c.width = c.height = s;
    drawFlash(c.getContext('2d'), s, i);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
    out.push(t);
  }
  return out;
}

const rnd = (a, b) => a + Math.random() * (b - a);

function drawFlash(x, s, variant) {
  const cx = s / 2, cy = s / 2;
  x.clearRect(0, 0, s, s);
  // faint smoke ring (grey, low alpha): the puff that hangs around the flash for the one frame it exists
  x.globalCompositeOperation = 'source-over';
  const ring = x.createRadialGradient(cx, cy, s * 0.28, cx, cy, s * 0.48);
  ring.addColorStop(0, 'rgba(120,110,100,0)'); ring.addColorStop(0.55, 'rgba(120,110,100,0.16)'); ring.addColorStop(1, 'rgba(120,110,100,0)');
  x.fillStyle = ring; x.beginPath(); x.arc(cx, cy, s * 0.48, 0, 6.2832); x.fill();

  // petals: short, chunky, asymmetric (biased to one side so the roll gives a different silhouette every shot)
  x.globalCompositeOperation = 'lighter';
  const bias = rnd(0, 6.2832), np = 3 + (variant % 2) + (Math.random() < 0.5 ? 1 : 0);
  for (let i = 0; i < np; i++) {
    const a = bias + (i / np) * 6.2832 + rnd(-0.5, 0.5);
    const len = s * rnd(0.22, 0.38) * (Math.cos(a - bias) > 0 ? 1.15 : 0.8), wid = s * rnd(0.14, 0.26);
    x.save(); x.translate(cx, cy); x.rotate(a);
    const g = x.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, 'rgba(255,205,130,0.9)'); g.addColorStop(0.5, 'rgba(255,150,55,0.7)'); g.addColorStop(1, 'rgba(255,90,20,0)');
    x.fillStyle = g; x.beginPath(); x.ellipse(len * 0.5, 0, len * 0.5, wid * 0.5, 0, 0, 6.2832); x.fill();
    x.restore();
  }
  // soft warm glow around everything
  const glow = x.createRadialGradient(cx, cy, s * 0.05, cx, cy, s * 0.34);
  glow.addColorStop(0, 'rgba(255,190,110,0.55)'); glow.addColorStop(1, 'rgba(255,140,60,0)');
  x.fillStyle = glow; x.beginPath(); x.arc(cx, cy, s * 0.34, 0, 6.2832); x.fill();
  // irregular hot core: layered blobs, white centre
  for (let i = 0; i < 6; i++) {
    const r = s * rnd(0.09, 0.17), ox = rnd(-1, 1) * s * 0.06, oy = rnd(-1, 1) * s * 0.06;
    const g = x.createRadialGradient(cx + ox, cy + oy, 0, cx + ox, cy + oy, r);
    g.addColorStop(0, 'rgba(255,252,240,0.95)'); g.addColorStop(0.5, 'rgba(255,225,160,0.7)'); g.addColorStop(1, 'rgba(255,170,80,0)');
    x.fillStyle = g; x.beginPath(); x.arc(cx + ox, cy + oy, r, 0, 6.2832); x.fill();
  }
  // a few sparks: short streaks leaving the core
  x.strokeStyle = 'rgba(255,230,170,0.6)'; x.lineWidth = 1.2;
  for (let i = 0; i < 4; i++) {
    const a = rnd(0, 6.2832), r0 = s * rnd(0.14, 0.22), r1 = r0 + s * rnd(0.06, 0.16);
    x.beginPath(); x.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); x.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); x.stroke();
  }
  x.globalCompositeOperation = 'source-over';
}
