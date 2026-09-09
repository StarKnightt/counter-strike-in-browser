import * as THREE from 'three';
import { state } from '../core/GameState.js';

const DOWN = new THREE.Vector3(0, -1, 0);
const _ray = new THREE.Ray(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3();
const BETWEEN_MS = 6;   // bake budget per timer slice between frames
const IN_FRAME_MS = 3;  // bake budget inside a frame while the bake is pending (freeze time; the radar is a placeholder anyway)

/**
 * CS2-style rotating radar. The map backdrop is baked once (scan(), sliced across idle time after the first frame) from a
 * top-down height scan of the collider: cells near a walkable (nav) height are light, everything else dark, shaded a little by elevation.
 * Overlays: player arrow, spotted enemies (LOS, recent gunfire, or very close), planted C4, bombsite letter.
 */
export class Radar {
  constructor(game, canvas) {
    this.game = game; this.map = game.map;
    this.canvas = canvas; this.ctx = canvas.getContext('2d');
    this.size = canvas.width;
    this.metersVisible = 78;                    // world metres across the radar (A site + long + short all fit)
    this.center = game.map.markers.bombsite?.pos.clone() ?? new THREE.Vector3();
    this.extent = 70;                            // baked half-size (m) around the site (T spawn sits 64 m out: 62 left it off the map)
    this.res = 664;                              // backdrop resolution (~0.21 m / px: 1:1 with the 2x canvas at 78 m visible)
    this.spot = new Map();                       // bot -> seconds since last spotted
    this.tick = 0;
    // plain dark backdrop until the height scan has finished (Game starts it after the first frame; ~1 s of raycasts,
    // sliced so it never stalls a frame — see scan())
    this.bake = document.createElement('canvas'); this.bake.width = this.bake.height = this.res;
    const bc = this.bake.getContext('2d'); bc.fillStyle = 'rgb(12,14,17)'; bc.fillRect(0, 0, this.res, this.res);
    this.baked = false;
    this._h = null; this._row = 0;               // scan progress (height field, next row)
  }

  /**
   * Height-scan the collider, then build the backdrop. Resolves when the bake is in place.
   * The work is a synchronous stepper (_step) fed from two places so it finishes in ~1.5 s whatever the frame load:
   * a timer loop between frames (idle callbacks alone starve under a continuous 60 fps rAF loop — the first bake could
   * take 4-10+ s) and a small budget inside every radar update() while the bake is pending.
   */
  async scan() {
    if (this._scan) return this._scan;
    return this._scan = (async () => {
      const yieldToFrame = () => new Promise((res) => setTimeout(res, 0));
      while (!this.baked) { this._step(BETWEEN_MS); if (!this.baked) await yieldToFrame(); }
    })();
  }

  /** Raycast rows of the height field for at most `budget` ms; composes the bake when the last row is done. */
  _step(budget) {
    if (this.baked) return;
    const N = this.res, ext = this.extent, c = this.center, bvh = this.map.collider.geometry.boundsTree;
    const h = this._h || (this._h = new Float32Array(N * N).fill(NaN));
    const t0 = performance.now();
    if (this._t0 === undefined) this._t0 = t0;
    let j = this._row;
    for (; j < N && performance.now() - t0 < budget; j++) for (let i = 0; i < N; i++) {
      const x = c.x - ext + (i + 0.5) / N * 2 * ext, z = c.z - ext + (j + 0.5) / N * 2 * ext;
      _ray.origin.set(x, c.y + 40, z); _ray.direction.copy(DOWN);
      const r = bvh.raycastFirst(_ray, THREE.DoubleSide);
      if (r) h[j * N + i] = r.point.y;
    }
    this._row = j;
    if (j >= N) { this.bake = this._compose(h); this.baked = true; this._h = null; this.scanMs = Math.round(performance.now() - this._t0); }   // wall time, for the perf scripts
  }

  /** Walkability fill + shading + outline from the height field (a few ms). */
  _compose(h) {
    const N = this.res, ext = this.extent, c = this.center;
    const navY = Object.values(this.map.markers.nav).map((p) => ({ x: p.x, z: p.z, y: p.y }));
    // walkable = flood fill over the height field from the nav nodes, stepping only where the floor
    // changes by less than a stair riser. Walls, crates and roofs stop the fill, so the outline is exact.
    const walk = new Uint8Array(N * N); const q = [];
    const px = 2 * ext / N;
    for (const n of navY) {
      const i = Math.floor((n.x - (c.x - ext)) / px), j = Math.floor((n.z - (c.z - ext)) / px);
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const k = j * N + i; if (Number.isNaN(h[k]) || Math.abs(h[k] - n.y) > 1.2 || walk[k]) continue;
      walk[k] = 1; q.push(k);
    }
    const STEP = 0.42;
    while (q.length) {
      const k = q.pop(), i = k % N, j = (k - i) / N, y = h[k];
      const nb = [i > 0 ? k - 1 : -1, i < N - 1 ? k + 1 : -1, j > 0 ? k - N : -1, j < N - 1 ? k + N : -1];
      for (const m of nb) { if (m < 0 || walk[m] || Number.isNaN(h[m])) continue; if (Math.abs(h[m] - y) < STEP) { walk[m] = 1; q.push(m); } }
    }
    const img = this.ctx.createImageData(N, N);
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = j * N + i, y = h[k]; let r = 12, g = 14, b = 17, a = 255;
      if (!Number.isNaN(y)) {
        if (walk[k]) { const sh = 0.74 + THREE.MathUtils.clamp((y - c.y) / 10, -0.14, 0.18); r = 168 * sh; g = 172 * sh; b = 178 * sh; }
        else if (y > c.y + 2.2) { r = 44; g = 46; b = 52; }      // walls / roofs
        else { r = 28; g = 30; b = 35; }                          // low unwalkable (crates, edges)
      }
      const o = k * 4; img.data[o] = r; img.data[o + 1] = g; img.data[o + 2] = b; img.data[o + 3] = a;
    }
    // outline walkable areas (1px edge) for the CS2 line-art read
    const d = img.data, out = new Uint8ClampedArray(d);
    const isWalk = (i, j) => { if (i < 0 || j < 0 || i >= N || j >= N) return false; return d[(j * N + i) * 4] > 100; };
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      if (!isWalk(i, j)) continue;
      if (!isWalk(i - 1, j) || !isWalk(i + 1, j) || !isWalk(i, j - 1) || !isWalk(i, j + 1)) { const o = (j * N + i) * 4; out[o] = 228; out[o + 1] = 230; out[o + 2] = 234; }
    }
    const bake = document.createElement('canvas'); bake.width = bake.height = N;
    bake.getContext('2d').putImageData(new ImageData(out, N, N), 0, 0);
    return bake;
  }

  /** world -> radar pixel (before rotation) */
  _toPx(x, z, px, pz, s) { return [(x - px) * s, (z - pz) * s]; }

  update(dt) {
    // canvas is drawn at 2x its CSS size for crisp edges; all px constants below are in CSS px
    const g = this.game, p = g.player, ctx = this.ctx, S = this.size / 2, half = S / 2;
    if (!this.baked && this._scan) this._step(IN_FRAME_MS);   // guaranteed progress even when timers/idle callbacks are starved
    // spotting (every 3rd frame): LOS from eye to chest, or fired in the last 1.5 s, or within 5 m
    if ((this.tick++ % 3) === 0) {
      const eye = p.getEye(_v);
      for (const b of g.bots.bots) {
        let seen = false;
        if (b.alive) {
          const d = b.position.distanceTo(p.position);
          if (d < 5 || (b.sinceShot ?? 9) < 1.5) seen = true;
          else if (d < 60) {
            const chest = _v2.copy(b.position); chest.y += 1.3;
            const dir = chest.sub(eye); const L = dir.length(); dir.normalize();
            const f = g.camera.getWorldDirection(new THREE.Vector3());
            if (f.dot(dir) > 0.35) { _ray.origin.copy(eye); _ray.direction.copy(dir); const r = g.map.collider.geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide); seen = !r || r.distance > L - 0.4; }
          }
        }
        const cur = this.spot.get(b) ?? 99;
        this.spot.set(b, seen ? 0 : cur + dt * 3);
      }
    } else for (const [b, t] of this.spot) this.spot.set(b, t + dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, S * 2, S * 2); ctx.scale(2, 2);
    ctx.save();
    // square mask (CS2)
    ctx.beginPath(); ctx.rect(0, 0, S, S); ctx.clip();
    ctx.fillStyle = 'rgba(10,10,10,0.7)'; ctx.fillRect(0, 0, S, S);
    const s = S / this.metersVisible;                       // px per metre
    const yaw = p.yaw;
    // Rotate the world so the player faces up. The backdrop is a true top-down view (world +X right, +Z down, so yaw 0 = -Z
    // = up). Player forward is (-sin yaw, -cos yaw) on that plane and canvas rotate(a) maps it to (sin(a-yaw), -cos(a-yaw)),
    // so a = +yaw brings it to (0,-1). rotate(-yaw) mirrored the heading about the up axis (2·yaw off: 180° when looking
    // along ±X, e.g. down the long corridors), which read as "the arrow points the opposite way".
    ctx.translate(half, half); ctx.rotate(yaw);
    // backdrop: bake covers [center-ext, center+ext]
    const bs = (2 * this.extent) * s;
    ctx.drawImage(this.bake, (this.center.x - this.extent - p.position.x) * s, (this.center.z - this.extent - p.position.z) * s, bs, bs);
    // plant zone (the BOMBSITE marker's radius): dashed outline, T-yellow while the player carries the C4 (his target)
    const site = this.map.markers.bombsite, carry = state.side === 't' && state.player.hasBomb;
    if (site) {
      const [bx, bz] = this._toPx(site.pos.x, site.pos.z, p.position.x, p.position.z, s);
      ctx.beginPath(); ctx.arc(bx, bz, site.radius * s, 0, Math.PI * 2);
      ctx.fillStyle = carry ? 'rgba(233,184,76,0.16)' : 'rgba(255,255,255,0.06)'; ctx.fill();
      ctx.setLineDash([3, 3]); ctx.strokeStyle = carry ? 'rgba(233,184,76,0.9)' : 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1.2; ctx.stroke(); ctx.setLineDash([]);
    }
    // planted bomb (blinking) / dropped C4 (steady)
    if ((state.bomb.state === 'planted' || state.bomb.state === 'dropped') && state.bomb.position) {
      const bp = state.bomb.position, [bx, bz] = this._toPx(bp.x, bp.z, p.position.x, p.position.z, s);
      const blink = state.bomb.state === 'dropped' || (state.bombTime % 1) < 0.5;
      ctx.fillStyle = blink ? '#ff3b2a' : '#8a1d14'; ctx.beginPath(); ctx.arc(bx, bz, 4.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.8)'; ctx.lineWidth = 1; ctx.stroke();
    }
    // enemies: solid while spotted, fading ghost for ~2.5 s, dead = grey X
    for (const b of g.bots.bots) {
      const t = this.spot.get(b) ?? 99;
      const [bx, bz] = this._toPx(b.position.x, b.position.z, p.position.x, p.position.z, s);
      if (Math.hypot(bx, bz) > half * 1.35) continue;
      if (!b.alive) {
        if (b.deathT > 6 || t > 4) continue;
        ctx.strokeStyle = 'rgba(200,200,200,0.5)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(bx - 3.5, bz - 3.5); ctx.lineTo(bx + 3.5, bz + 3.5); ctx.moveTo(bx + 3.5, bz - 3.5); ctx.lineTo(bx - 3.5, bz + 3.5); ctx.stroke();
        continue;
      }
      if (t > 5) continue;
      ctx.save(); ctx.translate(bx, bz);
      if (t < 0.6) {
        // live contact: red dot with heading tick
        ctx.fillStyle = '#d53a3a'; ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(0, 0, 4.4, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
        // bot forward (-sin yaw, -cos yaw) on the map = canvas rotate(-yaw) applied to the up-pointing tick (the old +PI
        // compensated for the mirrored map rotation above)
        ctx.rotate(-b.yaw); ctx.fillStyle = '#f0f0f0'; ctx.beginPath(); ctx.moveTo(0, -8.5); ctx.lineTo(-3, -4.5); ctx.lineTo(3, -4.5); ctx.closePath(); ctx.fill();
      } else {
        // lost sight: grey "?" at the last known spot, fading out
        const a = 1 - (t - 0.6) / 4.4;
        ctx.rotate(-yaw);   // undo the map rotation: upright text
        ctx.fillStyle = `rgba(150,150,150,${(a * 0.9).toFixed(2)})`; ctx.font = '700 12px "Barlow Semi Condensed", Bahnschrift, Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('?', 0, 0.5);
      }
      ctx.restore();
    }
    ctx.restore();
    // bombsite letter, upright in screen space; off the visible area (T spawn is 64 m out) it clamps to the radar edge so the
    // carrier always sees which way A is
    if (site) {
      const [bx, bz] = this._toPx(site.pos.x, site.pos.z, p.position.x, p.position.z, s), c = Math.cos(yaw), sn = Math.sin(yaw);
      let sx = bx * c - bz * sn, sz = bx * sn + bz * c;   // same rotate(+yaw) as the map above, in screen space
      const lim = half - 11, off = Math.abs(sx) > lim || Math.abs(sz) > lim;
      if (off) { const k = lim / Math.max(Math.abs(sx), Math.abs(sz)); sx *= k; sz *= k; }
      ctx.save(); ctx.translate(half + sx, half + sz);
      if (off) { ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.beginPath(); ctx.arc(0, 0, 9, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = carry ? 'rgba(233,184,76,0.95)' : 'rgba(255,255,255,0.6)';
      ctx.font = `700 ${off ? 13 : 17}px "Barlow Semi Condensed", Bahnschrift, Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('A', 0, 0.5);
      ctx.restore();
    }
    // player arrow (always up)
    ctx.save(); ctx.translate(half, half);
    // translucent 90° view cone
    const cone = ctx.createRadialGradient(0, 0, 4, 0, 0, half * 0.9);
    cone.addColorStop(0, 'rgba(255,255,255,0.22)'); cone.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = cone; ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, half * 0.9, -Math.PI / 2 - Math.PI / 4, -Math.PI / 2 + Math.PI / 4); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f0f0f0'; ctx.strokeStyle = 'rgba(0,0,0,0.75)'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(-5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(5.5, 6); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    // frame: 1 px flat edge
    ctx.strokeStyle = 'rgba(255,255,255,0.1)'; ctx.lineWidth = 1; ctx.strokeRect(0.5, 0.5, S - 1, S - 1);
  }
}
