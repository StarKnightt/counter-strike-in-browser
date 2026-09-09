/**
 * Valorant crosshair-code crosshair, drawn on a small DPR-aware canvas centred on the screen (`#crosshair` in the HUD).
 *
 * Code format (Valorant "Import Profile Code"), e.g. `0;s;1;P;h;0;m;1;0t;1;0l;4;0v;4;0o;1;0a;1;0f;0;1t;3;1o;2;1a;1;1m;0;1f;0`:
 *   leading `0` = version, `s;1` = show spectated crosshair (ignored), then sections `P` (primary), `A` (ADS; falls back to
 *   P when absent) and `S` (sniper; ignored: the AWP has its own scope). Section keys: `c` colour index, `u;RRGGBBAA` custom
 *   colour (used with `b;1` or `c;8`), `h` outlines, `t`/`o` outline thickness / opacity, `d` centre dot, `z`/`a` dot
 *   thickness / opacity, `f` fade with firing error, `m` override firing-error offset with crosshair offset. Line keys are
 *   prefixed `0` (inner) / `1` (outer): `Xb` show, `Xt` thickness, `Xl` length, `Xv` vertical length (only with `Xg;1`),
 *   `Xo` offset, `Xa` opacity, `Xm` movement error, `Xf` firing error, `Xs` firing-error multiplier, `Xe` movement multiplier.
 *   Unspecified keys take the Valorant defaults (see SECTION_DEFAULTS).
 * Units: 1 Valorant unit = 2 px at 1080p; everything scales with the viewport height and is rounded to whole device pixels.
 *
 * Start-up code: `?xhair=<code>` (also written to storage) > localStorage['cs2.xhair'] > DEFAULT_CODE; `__game.cheats.xhair(code)`
 * sets + persists one at runtime. HUD.update() hides / shows the canvas (AWP scope, death, defusing, round over).
 */
export const DEFAULT_CODE = '0;s;1;P;h;0;m;1;0t;1;0l;4;0v;4;0o;1;0a;1;0f;0;1t;3;1o;2;1a;1;1m;0;1f;0';
export const STORAGE_KEY = 'cs2.xhair';
const PX_PER_UNIT_1080 = 2;
/** Valorant palette (index 8 = custom `u`). */
const COLORS = ['#ffffff', '#00ff00', '#7fff00', '#dfff00', '#ffff00', '#00ffff', '#ff00ff', '#ff0000'];
const MOVE_ERR_UNITS = 5;      // extra offset at full run speed (per multiplier)
const FIRE_ERR_UNITS = 6;      // extra offset at a fully built-up spray penalty (per multiplier)
const FIRE_ERR_NORM = 0.04;    // tangent-unit inaccuracy excess that counts as "full" firing error

const lineDefaults = (inner) => ({ show: 1, t: 2, l: inner ? 6 : 2, v: null, g: 0, o: inner ? 3 : 10, a: inner ? 0.8 : 0.35, m: inner ? 0 : 1, f: 1, s: 1, e: 1 });
const SECTION_DEFAULTS = () => ({ c: 0, u: null, b: 0, h: 1, t: 1, o: 0.5, d: 0, z: 2, a: 1, f: 1, m: 0, inner: lineDefaults(true), outer: lineDefaults(false) });
const LINE_KEYS = new Set(['b', 't', 'l', 'v', 'g', 'o', 'a', 'm', 'f', 's', 'e']);
const SECTION_KEYS = new Set(['c', 'b', 'h', 't', 'o', 'd', 'z', 'a', 'f', 'm']);

/** Parse a profile code into `{ P, A }` sections (A === P when the code has no ADS section). Unknown keys are ignored. */
export function parseCrosshairCode(code) {
  const tok = String(code ?? '').trim().split(';').map((s) => s.trim());
  const sections = {};
  let cur = null, i = 0;
  if (/^\d+$/.test(tok[0] ?? '')) i = 1;                          // version
  while (i < tok.length) {
    const k = tok[i];
    if (k === 'P' || k === 'A' || k === 'S') { cur = sections[k] ||= SECTION_DEFAULTS(); i++; continue; }
    const raw = tok[i + 1]; i += 2;
    if (!cur || raw === undefined) continue;                      // profile-level `s;1` and anything before a section
    if (k === 'u') { if (/^[0-9a-f]{6,8}$/i.test(raw)) cur.u = raw; continue; }
    const v = parseFloat(raw); if (!Number.isFinite(v)) continue;
    if ((k[0] === '0' || k[0] === '1') && k.length === 2 && LINE_KEYS.has(k[1])) {
      const line = k[0] === '0' ? cur.inner : cur.outer, f = k[1];
      line[f === 'b' ? 'show' : f] = f === 'l' || f === 'v' || f === 't' || f === 'o' ? Math.max(0, v) : v;
    } else if (SECTION_KEYS.has(k)) cur[k] = v;
  }
  const P = sections.P ?? SECTION_DEFAULTS();
  return { P, A: sections.A ?? P };
}

/** CSS colour string of a section (custom `u` wins with `b;1` or `c;8`). */
function sectionColor(sec) {
  if (sec.u && (sec.b === 1 || sec.c === 8)) {
    const h = sec.u, a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return { rgb: `#${h.slice(0, 6)}`, a };
  }
  return { rgb: COLORS[Math.max(0, Math.min(7, Math.round(sec.c))) ] ?? COLORS[0], a: 1 };
}

export class Crosshair {
  /** @param {HTMLCanvasElement} canvas the `#crosshair` canvas @param {object} game for the error inputs (player speed, weapon inaccuracy) */
  constructor(canvas, game) {
    this.canvas = canvas; this.game = game;
    this.ctx = canvas.getContext('2d');
    this._key = ''; this._size = 0;
    this.set(Crosshair.initialCode(), false);
  }

  /** Start-up code: URL `?xhair=` (also written to storage) > localStorage > DEFAULT_CODE. */
  static initialCode(search = location.search) {
    const url = new URLSearchParams(search).get('xhair');
    if (url) { try { localStorage.setItem(STORAGE_KEY, url); } catch { /* storage blocked */ } return url; }
    try { const s = localStorage.getItem(STORAGE_KEY); if (s) return s; } catch { /* ignore */ }
    return DEFAULT_CODE;
  }

  /** Apply a profile code; `store` persists it to localStorage. Returns the parsed profile. */
  set(code, store = true) {
    this.code = String(code ?? '').trim() || DEFAULT_CODE;
    this.profile = parseCrosshairCode(this.code);
    if (store) { try { localStorage.setItem(STORAGE_KEY, this.code); } catch { /* session only */ } }
    this._key = '';                                               // force a redraw
    return this.profile;
  }

  /** Movement (0..1) and firing (0..1) error inputs, read cheaply from the live player / weapons; both 0 when unavailable. */
  _errors() {
    const g = this.game, p = g?.player, wp = g?.weapons;
    let move = 0, fire = 0;
    if (p && typeof p.speedFrac === 'number') move = Math.max(0, Math.min(1, p.speedFrac));
    if (wp && typeof wp.penalty === 'number') {
      let base = 0; try { base = wp._baseInaccuracy?.() ?? 0; } catch { base = 0; }
      fire = Math.max(0, Math.min(1, (wp.penalty - base) / FIRE_ERR_NORM));
    }
    return { move, fire, ads: wp?.ads > 0.5 };
  }

  /** Per-frame: redraws only when the profile, viewport scale or error inputs changed. */
  update() {
    const { move, fire, ads } = this._errors();
    const sec = ads ? this.profile.A : this.profile.P;
    const dpr = window.devicePixelRatio || 1;
    const unit = PX_PER_UNIT_1080 * (window.innerHeight / 1080) * dpr;   // device px per Valorant unit
    const mq = Math.round(move * 32) / 32, fq = Math.round(fire * 32) / 32;  // quantised so a static crosshair never redraws
    const key = `${sec === this.profile.A ? 'A' : 'P'}|${this.code}|${unit.toFixed(4)}|${dpr}|${mq}|${fq}`;
    if (key === this._key) return;
    this._key = key;
    this._draw(sec, unit, dpr, mq, fq);
  }

  _draw(sec, unit, dpr, move, fire) {
    const U = (v) => Math.max(0, Math.round(v * unit));                // units -> whole device px
    const col = sectionColor(sec);
    const outline = sec.h === 1 ? Math.max(1, U(sec.t)) : 0;
    const lines = [];
    let extent = 0;
    for (const [ln, isInner] of [[sec.inner, true], [sec.outer, false]]) {
      if (ln.show !== 1) continue;
      const t = U(ln.t), len = U(ln.l), vlen = ln.g === 1 && ln.v !== null ? U(ln.v) : len;
      if (t === 0 || (len === 0 && vlen === 0)) continue;
      let err = 0;
      if (ln.m === 1) err += move * MOVE_ERR_UNITS * (ln.e ?? 1);
      if (ln.f === 1 && sec.m !== 1) err += fire * FIRE_ERR_UNITS * (ln.s ?? 1);
      const off = U(ln.o + err);
      const alpha = Math.max(0, Math.min(1, ln.a)) * col.a * (sec.f === 1 && ln.f === 1 ? 1 - 0.6 * fire : 1);
      lines.push({ t, len, vlen, off, alpha, isInner });
      extent = Math.max(extent, off + Math.max(len, vlen), Math.ceil(t / 2));
    }
    const dot = sec.d === 1 ? U(sec.z) : 0;
    extent = Math.max(extent, dot) + outline + 2;
    // backing store: even device-px size centred on the screen; CSS size follows the DPR so 1 canvas px = 1 device px
    const size = Math.min(2 * extent + 2, Math.floor(window.innerHeight * dpr)) & ~1;
    if (size !== this._size) {
      this._size = size; this.canvas.width = size; this.canvas.height = size;
      const css = size / dpr; this.canvas.style.width = `${css}px`; this.canvas.style.height = `${css}px`; this.canvas.style.margin = `${-css / 2}px 0 0 ${-css / 2}px`;
    }
    const ctx = this.ctx, c = size / 2;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, size, size);
    // rects: [x, y, w, h] in device px, centred so odd thicknesses sit as symmetrically as whole pixels allow
    const rects = [];
    for (const l of lines) {
      const h0 = c - Math.floor(l.t / 2);
      if (l.len > 0) { rects.push({ r: [c - l.off - l.len, h0, l.len, l.t], a: l.alpha }); rects.push({ r: [c + l.off, h0, l.len, l.t], a: l.alpha }); }
      if (l.vlen > 0) { rects.push({ r: [h0, c - l.off - l.vlen, l.t, l.vlen], a: l.alpha }); rects.push({ r: [h0, c + l.off, l.t, l.vlen], a: l.alpha }); }
    }
    const dotRect = dot > 0 ? [c - Math.floor(dot / 2), c - Math.floor(dot / 2), dot, dot] : null;
    // 1. outlines under everything (expanded rects, then the line interiors cleared so the outline is a true border)
    if (outline > 0) {
      ctx.fillStyle = `rgba(0,0,0,${Math.max(0, Math.min(1, sec.o))})`;
      for (const { r } of rects) ctx.fillRect(r[0] - outline, r[1] - outline, r[2] + 2 * outline, r[3] + 2 * outline);
      if (dotRect) ctx.fillRect(dotRect[0] - outline, dotRect[1] - outline, dotRect[2] + 2 * outline, dotRect[3] + 2 * outline);
      for (const { r } of rects) ctx.clearRect(...r);
      if (dotRect) ctx.clearRect(...dotRect);
    }
    // 2. coloured lines, 3. dot on top
    for (const { r, a } of rects) { ctx.globalAlpha = a; ctx.fillStyle = col.rgb; ctx.fillRect(...r); }
    if (dotRect) { ctx.globalAlpha = Math.max(0, Math.min(1, sec.a)) * col.a; ctx.fillStyle = col.rgb; ctx.fillRect(...dotRect); }
    ctx.globalAlpha = 1;
  }
}
