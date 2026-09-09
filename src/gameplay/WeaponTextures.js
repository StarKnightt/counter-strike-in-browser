import * as THREE from 'three';

/**
 * Procedural, tiling canvas textures for the first-person weapons (no image assets).
 * Every set returns { map?, normalMap?, roughnessMap?, normalScale? } as THREE.CanvasTextures with RepeatWrapping.
 * Roughness maps follow three's packing: G = roughness (B = metalness where relevant). Steel and the AWP polymer
 * additionally pack a wear-noise mask into R (read by the edge-wear shader in ViewModel.js).
 * The GLBs carry box-projected UVs at a fixed texel density (tools/build_weapons.py), so 1 UV unit is
 * 3.85 cm on the gloves (uv_scale 26), ~7 cm on the sleeves (14) and 12.5 cm on the gun bodies (8).
 * Each generator samples its component fields once into Float32Arrays and composes the maps from those
 * (the whole set builds in well under a second; the three 512² cloth sets stay cheap by sampling their
 * low-frequency noise on a coarse grid and keeping the per-pixel work to analytic weaves + one noise octave).
 */

// ---------------------------------------------------------------- tiling value noise
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 1442695041) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
/** Tiling value noise; `periodY` (default = period) lets a field be stretched along one axis and still tile. */
function vnoise(x, y, period, seed, periodY = period) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const x0 = ((ix % period) + period) % period, x1 = (x0 + 1) % period, y0 = ((iy % periodY) + periodY) % periodY, y1 = (y0 + 1) % periodY;
  const a = hash2(x0, y0, seed), b = hash2(x1, y0, seed), c = hash2(x0, y1, seed), d = hash2(x1, y1, seed);
  const top = a + (b - a) * sx, bot = c + (d - c) * sx;
  return top + (bot - top) * sy;
}
/** Tiling fBm in tile coordinates u,v in [0,1). baseCells must be an integer. */
function fbm(u, v, baseCells, oct, seed, gain = 0.5) {
  let amp = 1, sum = 0, norm = 0, cells = baseCells;
  for (let i = 0; i < oct; i++) { sum += amp * vnoise(u * cells, v * cells, cells, seed + i * 17); norm += amp; amp *= gain; cells *= 2; }
  return sum / norm;
}
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
/** Linear -> sRGB transfer (LUT: the cloth albedos are authored in linear so the hex targets multiply cleanly). */
const SRGB_LUT = new Float32Array(4097);
for (let i = 0; i <= 4096; i++) { const c = i / 4096; SRGB_LUT[i] = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }
const lin2srgb = (c) => SRGB_LUT[c >= 1 ? 4096 : c <= 0 ? 0 : (c * 4096) | 0];
/** Distance to the nearest tile-periodic line at spacing `sp` (in tile units). */
const lineDist = (x, sp) => { const f = x / sp - Math.floor(x / sp); return Math.abs(f - 0.5) * sp; };

// ---------------------------------------------------------------- raster helpers
/** Sample fn(u, v) over a size x size tile into a Float32Array. */
function field(size, fn) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) h[y * size + x] = fn(x / size, y / size);
  return h;
}
/** Low-frequency field: sample fn(u, v) on a coarse low x low grid and upsample it (tile-periodic, smooth bilinear)
 * to size x size. A 64² grid costs 1/64 of a full 512² fbm pass and is plenty for blotches a few mm wide. */
function lowField(size, low, fn) {
  const g = new Float32Array(low * low);
  for (let y = 0; y < low; y++) for (let x = 0; x < low; x++) g[y * low + x] = fn(x / low, y / low);
  const out = new Float32Array(size * size), s = low / size;
  const i0 = new Int32Array(size), i1 = new Int32Array(size), tt = new Float32Array(size);   // per-column sample indices + smooth weight
  for (let x = 0; x < size; x++) { const f = x * s, k = Math.floor(f), t = f - k; i0[x] = k; i1[x] = (k + 1) % low; tt[x] = t * t * (3 - 2 * t); }
  for (let y = 0; y < size; y++) {
    const r0 = i0[y] * low, r1 = i1[y] * low, ty = tt[y], r = y * size;
    for (let x = 0; x < size; x++) {
      const x0 = i0[x], x1 = i1[x], tx = tt[x];
      const a = g[r0 + x0] + (g[r0 + x1] - g[r0 + x0]) * tx, b = g[r1 + x0] + (g[r1 + x1] - g[r1 + x0]) * tx;
      out[r + x] = a + (b - a) * ty;
    }
  }
  return out;
}
/** Separable pattern: fn(colA[x], colB[x], rowA[y], rowB[y]) from 1-D column / row profiles (weaves, grids: a few
 * hundred trig evaluations instead of size² of them). */
function sepField(size, cols, rows, fn) {
  const cA = new Float32Array(size), cB = new Float32Array(size), rA = new Float32Array(size), rB = new Float32Array(size);
  for (let i = 0; i < size; i++) { const [a, b] = cols(i / size); cA[i] = a; cB[i] = b; const [c, d] = rows(i / size); rA[i] = c; rB[i] = d; }
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) { const ra = rA[y], rb = rB[y], r = y * size; for (let x = 0; x < size; x++) out[r + x] = fn(cA[x], cB[x], ra, rb); }
  return out;
}
/** Compose an RGB texture from per-pixel index: fill(i, out). */
function compose(size, fill, { srgb = false, repeat = 1, aniso = 8 } = {}) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(size, size); const d = img.data;
  const out = [0, 0, 0];
  for (let i = 0, n = size * size; i < n; i++) {
    fill(i, out);
    d[i * 4] = 255 * clamp01(out[0]); d[i * 4 + 1] = 255 * clamp01(out[1]); d[i * 4 + 2] = 255 * clamp01(out[2]); d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = aniso;
  return t;
}
/** Tangent-space normal map from a tiling height field. */
function normalFromHeight(h, size, strength, repeat = 1) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const ctx = c.getContext('2d'); const img = ctx.createImageData(size, size); const d = img.data;
  for (let y = 0; y < size; y++) {
    const r = y * size, ru = (y === 0 ? size - 1 : y - 1) * size, rd = (y === size - 1 ? 0 : y + 1) * size;
    for (let x = 0; x < size; x++) {
      const xl = x === 0 ? size - 1 : x - 1, xr = x === size - 1 ? 0 : x + 1;
      // canvas rows run top-down while v runs bottom-up (flipY), so +v slope = +dy here
      const nx = -(h[r + xr] - h[r + xl]) * strength, ny = (h[rd + x] - h[ru + x]) * strength, il = 127.5 / Math.sqrt(nx * nx + ny * ny + 1);
      const i = (r + x) * 4;
      d[i] = 127.5 + nx * il; d[i + 1] = 127.5 + ny * il; d[i + 2] = 127.5 + il; d[i + 3] = 255;   // ImageData clamps + rounds
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); t.anisotropy = 8;
  return t;
}
/** Combine fields: sum_k w_k * f_k[i] (+ bias). */
function mixFields(size, terms, bias = 0) {
  const out = new Float32Array(size * size).fill(bias);
  for (const [w, f] of terms) for (let i = 0; i < out.length; i++) out[i] += w * f[i];   // term-outer: no per-pixel iterator
  return out;
}

// ---------------------------------------------------------------- glove: stretch-nylon knit (back of hand / fingers)
/** 3.85 cm tile (uv_scale 26). Tight micro-knit: 56 wales x 80 courses per tile (0.69 x 0.48 mm loops, ~2.5 px on
 * screen at viewmodel distance, so it resolves as fabric sheen rather than a pattern) with interlocking half-course
 * offsets, warm-grey fibre noise, and a soft low-frequency wear mask (worn nylon: lighter, slightly smoother). Albedo
 * is absolute: charcoal #2a2c2e (the padding now lives in the knuckle-pad geometry, so no quilting here). */
export function makeGloveFabric(size = 512) {
  const W = 56, C = 80;
  // wale = column ridge; the loops of neighbouring wales interlock half a course apart (parity flips in the trough between wales)
  const knit = sepField(size,
    (u) => [0.5 + 0.5 * Math.cos(u * Math.PI * 2 * W), Math.floor(u * W + 0.5) & 1],
    (v) => [0.5 + 0.5 * Math.cos(v * Math.PI * 2 * C), 0.5 - 0.5 * Math.cos(v * Math.PI * 2 * C)],
    (wale, odd, even, shifted) => wale * (0.55 + 0.45 * (odd ? shifted : even)));
  // fibre grain (±0.24, one pass): ~0.9 mm fibre clumps (the texture that survives mip filtering on screen) + 0.3 x 1.4 mm
  // filament streaks running along the wales
  const fuzz = lowField(size, 256, (u, v) => 0.22 * (vnoise(u * 44, v * 44, 44, 19) - 0.5) + 0.26 * (vnoise(u * 112, v * 28, 112, 15, 28) - 0.5));
  const wear = lowField(size, 64, (u, v) => sstep(0.46, 0.80, fbm(u, v, 3, 3, 17, 0.55)));     // ~1 cm soft patches
  const h = mixFields(size, [[0.55, knit], [1.0, fuzz], [-0.06, wear]]);
  const map = compose(size, (i, o) => {
    const k = knit[i] - 0.5, f = fuzz[i], w = wear[i];
    const l = (1 + 0.16 * k + f) * (1 + 0.28 * w);                                              // loop tops catch light; worn spots lighten
    // #2a2c2e (linear 0.0232 / 0.0252 / 0.0273); the fibre noise is warm grey, the wear pulls toward neutral grey
    o[0] = lin2srgb((0.0232 + 0.0035 * w) * l * (1 + 0.12 * f)); o[1] = lin2srgb((0.0252 + 0.0030 * w) * l); o[2] = lin2srgb((0.0273 + 0.0015 * w) * l * (1 - 0.10 * f));
  }, { srgb: true });
  const roughnessMap = compose(size, (i, o) => { o[0] = 0; o[1] = 0.80 + 0.07 * (knit[i] - 0.5) + 0.15 * fuzz[i] - 0.06 * wear[i]; o[2] = 0; });   // ~0.73..0.87, knit-scale variation
  return { map, normalMap: normalFromHeight(h, size, 4.0), roughnessMap, normalScale: 0.35 };
}

// ---------------------------------------------------------------- glove: synthetic-leather (Amara) palm
/** 3.85 cm tile. Smoother grey-brown #3a3634 synthetic leather: fine ~1 mm pebble grain (rounded cells), a hint of
 * micro grain, and soft darker sweat / wear patches (smoother where the surface has polished). 256² (0.15 mm/px, well
 * past the screen's ~0.27 mm/px at viewmodel distance): the palm is mostly hidden, so this is where the build budget
 * is saved. */
export function makeGloveLeather(size = 256) {
  const cells = lowField(size, 256, (u, v) => 0.6 * vnoise(u * 40, v * 40, 40, 21) + 0.4 * vnoise(u * 80, v * 80, 80, 23));
  const pebble = cells.map((c) => sstep(0.32, 0.68, c));                                       // rounded raised grains
  const micro = lowField(size, 256, (u, v) => vnoise(u * 112, v * 112, 112, 25));
  const dark = lowField(size, 64, (u, v) => sstep(0.50, 0.80, fbm(u, v, 3, 3, 27, 0.55)));     // sweat / wear patches
  const h = mixFields(size, [[0.7, pebble], [0.2, micro], [-0.1, dark]]);
  const map = compose(size, (i, o) => {
    const p = pebble[i] - 0.5, m = micro[i] - 0.5, d = dark[i];
    const l = (1 + 0.12 * p + 0.08 * m) * (1 - 0.28 * d);
    o[0] = lin2srgb(0.0481 * l); o[1] = lin2srgb(0.0369 * l); o[2] = lin2srgb(0.0343 * l);      // #3a3634 linear
  }, { srgb: true });
  const roughnessMap = compose(size, (i, o) => { o[0] = 0; o[1] = 0.55 + 0.06 * (pebble[i] - 0.5) + 0.03 * (micro[i] - 0.5) - 0.08 * dark[i]; o[2] = 0; });
  return { map, normalMap: normalFromHeight(h, size, 3.0), roughnessMap, normalScale: 0.5 };
}

// ---------------------------------------------------------------- sleeve: rip-stop
/** ~7 cm tile (uv_scale 14). CT olive-grey #4b4f47 rip-stop: a barely-there reinforcing thread grid every ~6 mm over
 * a fine 0.55 mm plain weave, woven-fibre noise and a slow mottle. Folds are left to the sleeve geometry. */
export function makeRipstop(size = 512) {
  const gl = (t) => { const d = lineDist(t, 1 / 12); return Math.exp(-(d * d) / (0.0035 * 0.0035)); };       // 0.5 mm reinforcing thread, gaussian profile
  // weave structure (height units, ±0.1): faint grid (exp(-min(d)²) = max of the two 1-D profiles) + 0.55 mm plain weave
  const weave = sepField(size, (u) => [gl(u), Math.sin(u * Math.PI * 2 * 128)], (v) => [gl(v), Math.sin(v * Math.PI * 2 * 128)],
    (gu, su, gv, sv) => 0.12 * Math.max(gu, gv) + 0.08 * su * sv);
  const fibre = lowField(size, 256, (u, v) => vnoise(u * 128, v * 128, 128, 51));
  const mottle = lowField(size, 64, (u, v) => fbm(u, v, 4, 3, 53));
  const h = mixFields(size, [[1.0, weave], [0.14, fibre], [0.10, mottle]]);
  const map = compose(size, (i, o) => {
    const l = 1 + 0.20 * (mottle[i] - 0.5) + 0.12 * (fibre[i] - 0.5) + 0.6 * weave[i];         // raised threads (grid, barely) a shade lighter
    o[0] = lin2srgb(0.0712 * l); o[1] = lin2srgb(0.0775 * l); o[2] = lin2srgb(0.0653 * l);      // #4b4f47 linear, pulled 20 % toward grey (the warm sun adds saturation back)
  }, { srgb: true });
  const roughnessMap = compose(size, (i, o) => { o[0] = 0; o[1] = 0.90 + 0.25 * weave[i] + 0.02 * (fibre[i] - 0.5); o[2] = 0; });   // ~0.88..0.93
  return { map, normalMap: normalFromHeight(h, size, 2.5), roughnessMap, normalScale: 0.5 };
}

// ---------------------------------------------------------------- AK laminate
/** Long grain streaks + plywood banding. Repeat 1.5 over planar UVs (1 UV = 33 cm) -> ~22 cm tile along the barrel. */
export function makeWood(size = 512) {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const streaks = []; for (let i = 0; i < 80; i++) streaks.push({ y: rnd(), w: (0.5 + rnd() * 1.6) / size, a: 0.18 + rnd() * 0.45, f: 1 + Math.floor(rnd() * 3), ph: rnd() * 6.28 });
  const grain = field(size, (u, v) => {
    let g = 0;
    for (const s of streaks) { const yy = s.y + Math.sin(u * Math.PI * 2 * s.f + s.ph) * 0.006; let dy = v - yy; dy -= Math.round(dy); if (Math.abs(dy) > s.w * 4) continue; g += s.a * Math.exp(-(dy * dy) / (s.w * s.w * 2.5)); }
    return Math.min(1, g);
  });
  const band = field(size, (u, v) => 0.5 + 0.5 * Math.sin(v * Math.PI * 2 * 5 + Math.sin(u * Math.PI * 2) * 1.2));   // plywood layers (integer periods -> tiles)
  const fine = field(size, (u, v) => fbm(u, v * 8, 4, 3, 61));                                                        // stretched micro-grain along u
  const map = compose(size, (i, o) => {
    const t = clamp01(0.58 + band[i] * 0.20 - grain[i] * 0.48 + (fine[i] - 0.5) * 0.20);   // 0 = darkest streak, 1 = lightest layer
    // real AK laminate: dark red-brown streaks to red-brown layers (sRGB ~ (40,23,14) .. (132,81,48), typical mid ~#684026; hue
    // ~23° instead of the previous 30° orange-tan (48,28,17) .. (128,93,59)), pulled 8 % toward grey: the warm sun + ACES add saturation on top
    const r = 0.16 + 0.37 * t, g = 0.09 + 0.225 * t, b = 0.05 + 0.125 * t, l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    o[0] = r * 0.92 + l * 0.08; o[1] = g * 0.92 + l * 0.08; o[2] = b * 0.92 + l * 0.08;
  }, { srgb: true, repeat: 1.5 });
  const h = mixFields(size, [[-0.6, grain], [0.1, band], [0.3, fine]], -0.15);
  const roughnessMap = compose(size, (i, o) => { o[0] = 0; o[1] = 0.44 + 0.14 * grain[i] + 0.06 * (fine[i] - 0.5); o[2] = 0; }, { repeat: 1.5 });
  return { map, normalMap: normalFromHeight(h, size, 2.2, 1.5), roughnessMap, normalScale: 0.6 };
}

// ---------------------------------------------------------------- bakelite grip
/** Dark plum-brown phenolic (sRGB ~#5a3226 base) with the classic marbled swirl. Roughness stays a constant 0.3 (glossy plastic). */
export function makeBakelite(size = 256) {
  const map = compose(size, (i, o) => {
    const u = (i % size) / size, v = Math.floor(i / size) / size;
    const n = fbm(u, v * 3, 3, 4, 71);                                  // stretched swirl
    const s = Math.pow(0.5 + 0.5 * Math.sin(n * 18 + v * 6), 3);         // thin light veins
    const t = 0.35 + 0.35 * n + 0.3 * s;
    // #50 2d 21 (dark swirl) .. #6b 3d 2e (veins); the previous ramp (#53 1e 0d .. #85 36 17) read as bright red in the sun
    o[0] = 0.26 + 0.16 * t; o[1] = 0.14 + 0.10 * t; o[2] = 0.105 + 0.075 * t;
  }, { srgb: true, repeat: 2 });
  return { map };
}

// ---------------------------------------------------------------- steel: blued finish, directional scratches, wear mask
/** Thin directional scratch field: `along` = fraction of lines running along u (the barrel axis on the box-projected
 * side faces), the rest across; angular jitter `jit` radians. */
function scratchField(size, n, seed, along = 0.85, jit = 0.18, lenMin = 0.05, lenMax = 0.30) {
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const a = (rnd() < along ? 0 : Math.PI * 0.5) + (rnd() - 0.5) * 2 * jit;
    lines.push({ x: rnd(), y: rnd(), ca: Math.cos(a), sa: Math.sin(a), l: lenMin + rnd() * (lenMax - lenMin), w: (0.4 + rnd() * 0.5) / size, k: 0.4 + rnd() * 0.6 });
  }
  return field(size, (u, v) => {
    let s = 0;
    for (const L of lines) {
      let dx = u - L.x, dy = v - L.y; dx -= Math.round(dx); dy -= Math.round(dy);
      if (Math.abs(dx) > L.l * 0.5 && Math.abs(dy) > L.l * 0.5) continue;
      const along = dx * L.ca + dy * L.sa; if (Math.abs(along) > L.l * 0.5) continue;
      const perp = -dx * L.sa + dy * L.ca; if (Math.abs(perp) > L.w * 3) continue;
      s = Math.max(s, L.k * Math.exp(-(perp * perp) / (L.w * L.w * 2)) * (0.6 + 0.4 * Math.cos(along / L.l * Math.PI)));
    }
    return clamp01(s);
  });
}

/** 12.5 cm tile. Dark blued steel: map = neutral grey with low-frequency tonal variation (±4 %, no marbling) and faint
 * lighter micro-scratches; roughnessMap G = 0.72..1.0 multiplier (material roughness 0.45 -> 0.32..0.45; scratches are
 * the smooth/bright lines), R = wear-noise mask (breaks the COLOR_0 edge wear into patches, read in ViewModel's shader),
 * B = 1 (metalness). Normal map: shallow scratch grooves + a very fine grain, no swirl. */
export function makeSteel(size = 256) {
  const scratch = scratchField(size, 140, 99);
  const tone = field(size, (u, v) => fbm(u, v, 3, 3, 71, 0.5));                                 // slow tonal drift
  const grain = field(size, (u, v) => fbm(u, v, 128, 1, 91));                                  // fine matte grain
  const wearNoise = field(size, (u, v) => clamp01((fbm(u, v, 10, 3, 81, 0.6) - 0.25) * 1.8));  // patchy: ~1.2 cm blotches, soft edges
  const map = compose(size, (i, o) => { const l = 0.96 + 0.08 * tone[i] + 0.05 * scratch[i] + 0.02 * (grain[i] - 0.5); o[0] = o[1] = o[2] = l; }, { srgb: true });
  const roughnessMap = compose(size, (i, o) => { o[0] = wearNoise[i]; o[1] = 0.96 + 0.08 * (tone[i] - 0.5) + 0.04 * (grain[i] - 0.5) - 0.28 * scratch[i]; o[2] = 1; });
  const h = mixFields(size, [[-0.30, scratch], [0.04, grain]], -0.02);
  return { map, roughnessMap, normalMap: normalFromHeight(h, size, 1.6), normalScale: 0.35 };
}

// ---------------------------------------------------------------- polymer speckle (rubber, knife handle)
/** 12.5 cm tile: fine speckled cast-polymer normal + subtle mottle map (multiplies the material colour). */
export function makeSpeckle(size = 256) {
  const h = field(size, (u, v) => fbm(u, v, 64, 2, 101, 0.6) * 0.45 + fbm(u, v, 128, 1, 103) * 0.55);
  const map = compose(size, (i, o) => { const u = (i % size) / size, v = Math.floor(i / size) / size; const n = 0.88 + 0.24 * fbm(u, v, 6, 3, 111); o[0] = o[1] = o[2] = n; });
  return { normalMap: normalFromHeight(h, size, 2.2), map, normalScale: 0.4 };
}

// ---------------------------------------------------------------- AWP polymer chassis
/** 12.5 cm tile. Cast glass-filled polymer: two-tone speckle albedo (±6 % lightness, ~1.3 mm cells) over a slow ±3 %
 * mottle, matching speckle normal (normalScale 0.3 in the material), roughness multiplier 0.93..1.0 (bumps slightly
 * smoother) with the wear-noise mask in R so the COLOR_0 edge wear reads as scuffed bare polymer on the bevels. */
export function makePolymer(size = 256) {
  const cells = field(size, (u, v) => fbm(u, v, 96, 1, 121));
  const speck = cells.map((c) => sstep(0.46, 0.54, c));                                        // hard two-tone
  const fine = field(size, (u, v) => fbm(u, v, 192, 1, 123));
  const mottle = field(size, (u, v) => fbm(u, v, 5, 3, 125));
  const wearNoise = field(size, (u, v) => clamp01((fbm(u, v, 9, 3, 127, 0.6) - 0.25) * 1.8));
  const map = compose(size, (i, o) => { const l = 0.94 + 0.12 * speck[i] + 0.06 * (mottle[i] - 0.5) + 0.02 * (fine[i] - 0.5); o[0] = o[1] = o[2] = l; }, { srgb: true });
  const roughnessMap = compose(size, (i, o) => { o[0] = wearNoise[i]; o[1] = 1.0 - 0.07 * speck[i] - 0.03 * fine[i]; o[2] = 0; });
  const h = mixFields(size, [[0.7, cells], [0.3, fine]]);
  return { map, roughnessMap, normalMap: normalFromHeight(h, size, 2.6), normalScale: 0.3 };
}

// ---------------------------------------------------------------- scope lens
/** One tile per lens disc (0..1 UVs from tools/build_weapons.py lens_uv). map: deep blue-green coated glass, lighter
 * toward the rim, with a thin bright bezel ring; emissiveMap: a bright elliptical specular highlight (upper-left) and a
 * small secondary glint, so the lens reads as glass from any angle. */
export function makeLens(size = 128) {
  const map = compose(size, (i, o) => {
    const u = (i % size) / size - 0.5, v = Math.floor(i / size) / size - 0.5, r = Math.hypot(u, v) * 2;
    const t = sstep(0.0, 1.0, r), rim = sstep(0.86, 0.94, r) * (1 - sstep(0.97, 1.0, r));
    o[0] = 0.02 + 0.10 * t + 0.45 * rim; o[1] = 0.05 + 0.15 * t + 0.45 * rim; o[2] = 0.09 + 0.20 * t + 0.42 * rim;
  }, { srgb: true, aniso: 4 });
  const emissiveMap = compose(size, (i, o) => {
    const u = (i % size) / size, v = Math.floor(i / size) / size;
    const g = (cx, cy, ax, ay, ang) => { const c = Math.cos(ang), s = Math.sin(ang), dx = u - cx, dy = v - cy, x = (dx * c + dy * s) / ax, y = (-dx * s + dy * c) / ay; return Math.exp(-(x * x + y * y) * 2.2); };
    const hi = g(0.36, 0.66, 0.17, 0.085, -0.6) + 0.45 * g(0.63, 0.36, 0.06, 0.035, -0.6);
    const ring = 0.12 * Math.exp(-((Math.hypot(u - 0.5, v - 0.5) * 2 - 0.62) ** 2) / 0.004);      // faint inner reflection ring
    const e = clamp01(hi + ring);
    o[0] = e * 0.95; o[1] = e; o[2] = e;
  }, { srgb: true, aniso: 4 });
  map.wrapS = map.wrapT = emissiveMap.wrapS = emissiveMap.wrapT = THREE.ClampToEdgeWrapping;
  return { map, emissiveMap };
}

/** Lazily built, shared across weapons. `ms` = build time (all sets). */
let _sets = null;
export function weaponTextureSets() {
  if (_sets) return _sets;
  const t0 = performance.now();
  _sets = { fabric: makeGloveFabric(), leather: makeGloveLeather(), ripstop: makeRipstop(), wood: makeWood(), bakelite: makeBakelite(), steel: makeSteel(), speckle: makeSpeckle(), polymer: makePolymer(), lens: makeLens() };
  _sets.ms = performance.now() - t0;
  return _sets;
}
