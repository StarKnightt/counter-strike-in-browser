import * as THREE from 'three';
import { asset } from '../core/Constants.js';

/**
 * Web Audio engine: buffer bank (CC0 one-shots in /audio, see public/audio/CREDITS.txt; voice lines in /audio/voice
 * rendered by tools/make_voice.py), buses, 3D panning with distance low-pass (air absorption) and single-ray occlusion
 * against the map collider, plus a few synthesized UI/bomb tones. The in-world buses pass through an "ears" stage
 * (duck() for the announcer, muffle() for the C4 blast); everything routes through one compressor so gunfire never clips.
 */
const BANK = {
  ak47_fire: 1, awp_fire: 1, awp_bolt: 2, knife_swing: 1, knife_wall: 1, knife_flesh: 3, ak47_distant: ['a', 'b'],
  ak47_reload_1: 1, ak47_reload_2: 1, ak47_reload_3: 1,          // mag out / mag in / charge: distinct ids so the stages never shuffle
  impact_concrete: 6, impact_dirt: 1, impact_flesh: 3, headshot: 1, whiz: 1, ricochet: 2, brass: 5,
  step_concrete: 6, step_stone: 4, step_dirt: 4, step_gravel: 4, bodyfall: 1, hurt: 1, death: 4,
  c4_key: 3, c4_explode: 1, amb_wind: 1, amb_wind2: 1, amb_city: 1, far_dog: 2, far_crow: 2,
};
/**
 * Voice lines (public/audio/voice, generated offline by tools/make_voice.py from Windows TTS + a radio DSP chain):
 * ann_* announcer (ui bus, non-positional) · ct_* the player's own radio · t_<line>_v1..3 terrorist callouts in three
 * voices (positional; Sfx keys the voice off the bot so each bot keeps its own).
 */
const VOICE = {
  ann_ct_win: 1, ann_t_win: 1, ann_bomb_planted: 1, ann_bomb_defused: 1,
  ct_enemy_down: 1, ct_enemy_spotted: 1, ct_need_backup: 1, ct_defusing: 1, ct_cover_me: 1,
  ...Object.fromEntries(['spot', 'contact', 'takingfire', 'hit', 'down', 'planting', 'gotbomb', 'gogogo', 'cover'].flatMap((l) => [1, 2, 3].map((v) => [`t_${l}_v${v}`, 1]))),
};
const files = (id, v) => (v === 1 ? [`${id}`] : Array.isArray(v) ? v.map((s) => `${id}_${s}`) : Array.from({ length: v }, (_, i) => `${id}_${i + 1}`));

const _ray = new THREE.Ray(), _v = new THREE.Vector3();

export class Audio {
  constructor(game) {
    this.game = game;
    // The AudioContext is only created on the first user gesture (Chrome's autoplay policy logs a warning otherwise).
    // Until then play/tone/noise are no-ops and startAmbient() is queued; the sound bank decodes through an OfflineAudioContext.
    this.ctx = null;
    this.buffers = new Map(); this.variantIdx = {};
    this.voices = 0; this.maxVoices = 40;
    this.muted = false;
    const unlock = () => { if (!this.ctx) this._createContext(); if (this.ctx.state !== 'running') this.ctx.resume(); };
    addEventListener('pointerdown', unlock); addEventListener('keydown', unlock);
    this.ambient = null; this._ambientPending = false;
  }

  _createContext() {
    const AC = window.AudioContext || window.webkitAudioContext;
    const c = this.ctx = new AC({ latencyHint: 'interactive' });
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -10; this.comp.knee.value = 12; this.comp.ratio.value = 4; this.comp.attack.value = 0.002; this.comp.release.value = 0.12;
    this.master = c.createGain(); this.master.gain.value = this.muted ? 0 : 0.9;
    this.master.connect(this.comp); this.comp.connect(c.destination);
    // The in-world buses (sfx/world/amb/voice) share one "ears" stage: a gain the announcer ducks and a low-pass the C4 blast
    // sweeps for the muffled-hearing moment. The ui bus (announcer, HUD blips) bypasses it so it stays clear.
    this.ears = c.createGain(); this.ears.gain.value = 1;
    this.earsLP = c.createBiquadFilter(); this.earsLP.type = 'lowpass'; this.earsLP.frequency.value = 20000; this.earsLP.Q.value = 0.4;
    this.ears.connect(this.earsLP); this.earsLP.connect(this.master);
    this.bus = {};
    for (const [k, g] of Object.entries({ sfx: 1.0, world: 1.0, amb: 0.55, ui: 0.8, voice: 0.9 })) { const n = c.createGain(); n.gain.value = g; n.connect(k === 'ui' ? this.master : this.ears); this.bus[k] = n; }
    this._duckUntil = 0;
    if (c.listener.forwardX) this._hasParams = true;
    if (this._ambientPending) { this._ambientPending = false; this.startAmbient(); }
  }

  async load(onProgress) {
    const list = Object.entries(BANK).flatMap(([id, v]) => files(id, v).map((f) => [id, f]))
      .concat(Object.entries(VOICE).flatMap(([id, v]) => files(id, v).map((f) => [id, `voice/${f}`])));
    let done = 0;
    await Promise.all(list.map(async ([id, f]) => {
      try {
        const res = await fetch(asset(`audio/${f}.ogg`));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const dec = this.ctx || (this._decoder ??= new OfflineAudioContext(1, 1, 48000));
        const buf = await dec.decodeAudioData(await res.arrayBuffer());
        if (!this.buffers.has(id)) this.buffers.set(id, []);
        this.buffers.get(id).push(buf);
      } catch (e) { console.warn('audio: failed', f, e); }
      done++; onProgress?.(done / list.length);
    }));
    return this;
  }

  /** Move the listener to the camera every frame. */
  updateListener(camera) {
    if (!this.ctx) return;
    const L = this.ctx.listener, p = camera.position;
    const f = _v.set(0, 0, -1).applyQuaternion(camera.quaternion);
    if (this._hasParams) {
      const t = this.ctx.currentTime;
      L.positionX.setTargetAtTime(p.x, t, 0.01); L.positionY.setTargetAtTime(p.y, t, 0.01); L.positionZ.setTargetAtTime(p.z, t, 0.01);
      L.forwardX.setTargetAtTime(f.x, t, 0.01); L.forwardY.setTargetAtTime(f.y, t, 0.01); L.forwardZ.setTargetAtTime(f.z, t, 0.01);
      L.upX.setTargetAtTime(0, t, 0.01); L.upY.setTargetAtTime(1, t, 0.01); L.upZ.setTargetAtTime(0, t, 0.01);
    } else { L.setPosition(p.x, p.y, p.z); L.setOrientation(f.x, f.y, f.z, 0, 1, 0); }
    this.listenerPos = p;
  }

  _pick(id) {
    const arr = this.buffers.get(id); if (!arr || !arr.length) return null;
    if (arr.length === 1) return arr[0];
    // never repeat the previous variant
    let i = Math.floor(Math.random() * arr.length); if (i === this.variantIdx[id]) i = (i + 1) % arr.length;
    this.variantIdx[id] = i; return arr[i];
  }

  /** Does the bank hold this id? */
  has(id) { return !!this.buffers.get(id)?.length; }

  /**
   * play(id, { pos, vol, rate, bus, loop, delay, lowpass, ref, max, occlude, onEnd })
   * pos = world position for 3D (omit for 2D/first-person). Returns { stop(), gain, dur } or null.
   */
  play(id, o = {}) {
    if (this.muted || !this.ctx || this.voices >= this.maxVoices) return null;
    const buf = this._pick(id); if (!buf) return null;
    const c = this.ctx, t = c.currentTime + (o.delay || 0);
    const src = c.createBufferSource(); src.buffer = buf; src.loop = !!o.loop;
    src.playbackRate.value = (o.rate ?? 1) * (o.rateJitter ? 1 + (Math.random() - 0.5) * 2 * o.rateJitter : 1);
    const dur = buf.duration / src.playbackRate.value;
    const gain = c.createGain(); gain.gain.value = o.vol ?? 1;
    let node = src, filterFreq = o.lowpass ?? 0;
    let out = this.bus[o.bus || (o.pos ? 'world' : 'sfx')];
    if (o.pos) {
      const dist = this.listenerPos ? o.pos.distanceTo(this.listenerPos) : 10;
      if (dist > (o.max ?? 90)) return null;
      // air absorption + occlusion (one ray to the listener through the map collider)
      let lp = 20000 - dist * (o.absorb ?? 180);
      if (o.occlude !== false && this.listenerPos && dist > 2) {
        const dir = _v.copy(this.listenerPos).sub(o.pos); const L = dir.length(); dir.normalize();
        _ray.origin.copy(o.pos); _ray.direction.copy(dir);
        const hit = this.game.map.collider.geometry.boundsTree.raycastFirst(_ray, THREE.DoubleSide);
        if (hit && hit.distance < L - 0.3) { lp = Math.min(lp, 900); gain.gain.value *= 0.45; }
      }
      filterFreq = Math.min(filterFreq || 20000, lp);
      const pan = c.createPanner();
      pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse';
      pan.refDistance = o.ref ?? 2.5; pan.maxDistance = o.max ?? 90; pan.rolloffFactor = o.rolloff ?? 1.15;
      if (pan.positionX) { pan.positionX.value = o.pos.x; pan.positionY.value = o.pos.y; pan.positionZ.value = o.pos.z; } else pan.setPosition(o.pos.x, o.pos.y, o.pos.z);
      gain.connect(pan); pan.connect(out); out = null;
    }
    if (filterFreq && filterFreq < 19000) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = Math.max(300, filterFreq); f.Q.value = 0.5; node.connect(f); node = f; }
    node.connect(gain); if (out) gain.connect(out);
    src.start(t);
    this.voices++;
    src.onended = () => { this.voices--; try { src.disconnect(); gain.disconnect(); } catch (_) {} o.onEnd?.(); };
    return { src, gain, dur, stop: (fade = 0.05) => { const now = c.currentTime; gain.gain.setTargetAtTime(0, now, fade / 3); try { src.stop(now + fade + 0.05); } catch (_) {} } };
  }

  /** Pull the in-world buses down by `db` for `dur` seconds (announcer sidechain). Overlapping ducks extend, never stack. */
  duck(db = 4, dur = 1.5, delay = 0) {
    if (!this.ctx) return;
    const g = this.ears.gain, t = this.ctx.currentTime + delay, end = t + dur;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(Math.pow(10, -db / 20), t, 0.04);
    this._duckUntil = Math.max(this._duckUntil, end);
    g.setTargetAtTime(1, this._duckUntil, 0.25);
  }

  /** Blast deafness: in-world buses drop to `freq` Hz and sweep back to open over `dur` seconds. */
  muffle(dur = 2.2, freq = 500) {
    if (!this.ctx) return;
    const f = this.earsLP.frequency, t = this.ctx.currentTime;
    f.cancelScheduledValues(t); f.setValueAtTime(freq, t); f.exponentialRampToValueAtTime(20000, t + dur);
    this.duck(3, dur * 0.7);
  }

  // ------------------------------------------------------------ synthesized tones
  /** Short sine/square blip: C4 beeps, UI, radio. */
  tone(freq, dur, { vol = 0.25, type = 'square', pos = null, attack = 0.002, decay = 0.05, bus = 'ui', delay = 0 } = {}) {
    if (this.muted || !this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay;
    const osc = c.createOscillator(); osc.type = type; osc.frequency.value = freq;
    const g = c.createGain(); g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + attack); g.gain.setValueAtTime(vol, t + dur - decay); g.gain.linearRampToValueAtTime(0, t + dur);
    // remove the raw square harshness
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq * 3.2;
    osc.connect(f); f.connect(g);
    if (pos) { const pan = c.createPanner(); pan.panningModel = 'equalpower'; pan.distanceModel = 'inverse'; pan.refDistance = 2.5; pan.rolloffFactor = 1.1; if (pan.positionX) { pan.positionX.value = pos.x; pan.positionY.value = pos.y; pan.positionZ.value = pos.z; } g.connect(pan); pan.connect(this.bus.world); }
    else g.connect(this.bus[bus]);
    osc.start(t); osc.stop(t + dur + 0.02);
  }

  /** Filtered noise burst: cloth/draw swish, radio static, clicks. */
  noise(dur, { vol = 0.2, freq = 1200, q = 0.8, type = 'bandpass', bus = 'sfx', delay = 0, sweep = 1 } = {}) {
    if (this.muted || !this.ctx) return;
    const c = this.ctx, t = c.currentTime + delay;
    const n = Math.floor(dur * c.sampleRate), buf = c.createBuffer(1, n, c.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = c.createBufferSource(); src.buffer = buf;
    const f = c.createBiquadFilter(); f.type = type; f.frequency.setValueAtTime(freq, t); if (sweep !== 1) f.frequency.exponentialRampToValueAtTime(freq * sweep, t + dur); f.Q.value = q;
    const g = c.createGain(); g.gain.value = vol;
    src.connect(f); f.connect(g); g.connect(this.bus[bus]);
    src.start(t);
  }

  /**
   * Ambience: three seamless loops with unrelated periods (38.5 / 28.5 / 23.5 s) - wind, a second filtered wind, a very low
   * distant-town drone - each with its own slow gain LFO, so the bed never audibly repeats. Random far-off one-shots come from Sfx.
   */
  startAmbient() {
    if (this.ambient) return;
    if (!this.ctx) { this._ambientPending = true; return; }   // starts as soon as the first gesture creates the context
    const c = this.ctx, layers = [];
    for (const [id, vol, lfoHz, depth] of [['amb_wind', 1.0, 0.07, 0.22], ['amb_wind2', 0.28, 0.043, 0.4], ['amb_city', 0.12, 0.021, 0.3]]) {
      const h = this.play(id, { loop: true, bus: 'amb', vol: 0.0 });
      if (!h) continue;
      h.gain.gain.setTargetAtTime(vol, c.currentTime, 1.5 + layers.length);
      const lfo = c.createOscillator(); lfo.type = 'sine'; lfo.frequency.value = lfoHz;
      const lg = c.createGain(); lg.gain.value = vol * depth; lfo.connect(lg); lg.connect(h.gain.gain); lfo.start();
      h.lfo = lfo; layers.push(h);
    }
    if (layers.length) this.ambient = layers[0], this.ambientLayers = layers;
  }

  setMuted(m) { this.muted = m; if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.9, this.ctx.currentTime, 0.05); }
}
