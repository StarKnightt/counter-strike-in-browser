/**
 * Adaptive render scale (device pixel ratio) with hysteresis.
 *
 * Independent of devicePixelRatio: the scale is supersampling headroom, not display density (a 1080p desktop at DPR 1
 * used to be pinned at 1.0 with the GPU frame at ~5 of 16.6 ms). Levels MIN..MAX in 0.25 steps, starting at `start`.
 * Every 2 s the average GPU frame time is checked:
 *   > 13 ms  -> one level down
 *   <  9 ms for 3 s -> one level up
 * with at most one change per 5 s. `?scale=1|1.25|1.5` pins the ratio (no adaptation).
 *
 * GPU time comes from EXT_disjoint_timer_query_webgl2 when the browser exposes it (Chromium desktop); the fallback is
 * the rAF interval, which on a vsynced 60 Hz display can only detect *missed* refreshes (avg > 1.3x the refresh
 * period) and never sees headroom, so in fallback mode the scale only ever steps down.
 */
export class RenderScale {
  constructor(renderer, { min = 1, max = 1.5, start = 1.25, override = null, onChange } = {}) {
    this.renderer = renderer; this.min = min; this.max = Math.max(min, max);
    this.levels = []; for (let v = this.min; v < this.max - 1e-6; v += 0.25) this.levels.push(+v.toFixed(2)); this.levels.push(this.max);
    this.override = override; this.onChange = onChange;
    this.current = override ?? Math.min(this.max, Math.max(this.min, start));
    this.avgMs = 0; this.source = 'raf';
    this._win = { sum: 0, n: 0, t: 0, minD: Infinity }; this._goodT = 0; this._lastChange = -Infinity; this._time = 0;
    // GPU timer queries (one per frame, results read back a few frames later)
    const gl = renderer.getContext();
    this.gl = gl; this.ext = gl.getExtension?.('EXT_disjoint_timer_query_webgl2') || null;
    this._pending = []; this._free = []; this._active = null;
    if (this.ext) this.source = 'gpu';
    this._apply(this.current, true);
  }

  /** Call at the very start of the frame (before any GL work). */
  begin() {
    if (!this.ext || this._active || this.override !== null) return;
    const gl = this.gl, q = this._free.pop() || gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q); this._active = q;
  }

  /** Call after the last draw of the frame; `dt` is the rAF delta in seconds. */
  end(dt) {
    if (this.override !== null) return;
    const gl = this.gl, ext = this.ext;
    let sample = null;
    if (ext) {
      if (this._active) { gl.endQuery(ext.TIME_ELAPSED_EXT); this._pending.push(this._active); this._active = null; }
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { this._free.push(...this._pending); this._pending.length = 0; }
      // harvest finished queries in order; several may complete in one frame after a stall
      while (this._pending.length && gl.getQueryParameter(this._pending[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = this._pending.shift(); sample = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6; this._free.push(q);
        this._push(sample, dt);
      }
      // Chromium reports query completion lazily (~100-150 ms, i.e. 30+ frames uncapped): keep a deep queue, recycle only when clearly lost
      if (this._pending.length > 240) this._free.push(this._pending.shift());
    } else this._push(dt * 1000, dt);
    this._time += dt;
    const w = this._win;
    if (w.t >= 2 && w.n > 0) {
      const avg = w.sum / w.n; this.avgMs = avg;
      // fallback (rAF) only counts as slow when frames are actually missing refreshes (avg well above the refresh period)
      const slow = ext ? avg > 13 : (avg > 13 && avg > w.minD * 1.3);
      const fast = avg < 9;
      if (slow) { this._goodT = 0; if (this.current > this.min) this._set(this._step(-1)); }
      else if (fast) { this._goodT += w.t; if (this._goodT >= 3 && this.current < this.max) this._set(this._step(+1)); }
      else this._goodT = 0;
      w.sum = 0; w.n = 0; w.t = 0; w.minD = Infinity;
    }
  }

  _push(ms, dt) {
    if (this._time < 1.5) return;                          // warm-up: the first frames carry compile/upload stalls, not steady-state cost
    const w = this._win; w.sum += ms; w.n++; w.t += dt; if (dt * 1000 < w.minD) w.minD = dt * 1000;
  }

  /** Neighbouring level (dir = ±1) of the current scale, clamped to the level list. */
  _step(dir) {
    let i = 0; for (let k = 0; k < this.levels.length; k++) if (Math.abs(this.levels[k] - this.current) < Math.abs(this.levels[i] - this.current)) i = k;
    return this.levels[Math.min(this.levels.length - 1, Math.max(0, i + dir))];
  }

  _set(v) {
    if (this._time - this._lastChange < 5 || v === this.current) return;
    this._lastChange = this._time; this._goodT = 0;
    this._apply(v);
  }

  _apply(v, initial = false) {
    this.current = v;
    this.renderer.setPixelRatio(v);
    if (!initial) this.onChange?.(v);
  }

  /** `?scale=1.25` style override parsed from the URL (null when absent/invalid). */
  static fromUrl(search = location.search) {
    const s = new URLSearchParams(search).get('scale'); if (s === null) return null;
    const v = parseFloat(s); return Number.isFinite(v) ? Math.min(2, Math.max(0.5, v)) : null;
  }
}
