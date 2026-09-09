import * as THREE from 'three';
import { bus, Events } from '../core/EventBus.js';
import { state } from '../core/GameState.js';

/** Routes gameplay events to the Audio engine (what plays, where, how loud). */
const STEP = { concrete: 'step_concrete', sand: 'step_dirt', wood: 'step_stone', metal: 'step_stone', flesh: 'step_dirt' };
const IMPACT = { concrete: 'impact_concrete', sand: 'impact_dirt', wood: 'impact_concrete', metal: 'ricochet', flesh: 'impact_flesh' };
const _rc = new THREE.Raycaster(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), DOWN = new THREE.Vector3(0, -1, 0);
// BotManager LINES text -> voice line id (t_<line>_v<voice>); falls back to the callout kind
const T_LINE = { 'Enemy spotted.': 'spot', 'Contact!': 'contact', 'Taking fire, need backup!': 'takingfire', "I'm hit!": 'hit', 'Man down.': 'down', 'Planting the bomb.': 'planting', "I've got the bomb.": 'gotbomb' };
const T_KIND = { spot: 'spot', hit: 'takingfire', down: 'down', planting: 'planting', bomb: 'gotbomb' };
// CT bots (T side) speak with the CT radio set (single voice, no variants); kinds without a CT file stay silent
const CT_LINE = { spot: 'ct_enemy_spotted', contact: 'ct_enemy_spotted', takingfire: 'ct_need_backup', hit: 'ct_cover_me', defusing: 'ct_defusing' };
// the player's own radio as a T: the T voice set, variant 1 (no T "enemy down" line exists: that one stays silent)
const T_RADIO = { ct_defusing: 't_planting_v1', ct_need_backup: 't_takingfire_v1', ct_cover_me: 't_cover_v1', ct_enemy_spotted: 't_spot_v1', got_bomb: 't_gotbomb_v1' };

export class Sfx {
  constructor(game, audio) {
    this.game = game; this.a = audio;
    this.hurtCd = 0; this.whizCd = 0;
    this._annQ = []; this._annBusy = false;
    this._calloutBusyUntil = 0; this._calloutCd = {}; this._radioCd = {}; this._saidBackup = false;
    const a = audio;

    // ---- announcer (ui bus, queued so lines never overlap; ducks the in-world buses while it speaks)
    bus.on(Events.ROUND_START, () => { this._annQ.length = 0; this._saidBackup = false; this._radioCd = {}; });
    bus.on(Events.ROUND_END, (e) => {
      // after the win stinger; a bombed site gets a beat for the blast, a dead player a beat for the death sounds
      const delay = e.reason === 'Target bombed' ? 1.7 : e.playerAlive ? 0.7 : 1.1;
      // ROUND_END is emitted from inside the BOMB_DEFUSED dispatch (Round ends the round first); defer one tick so "defused" queues ahead of "win"
      queueMicrotask(() => this._announce(e.winner === 'CT' ? 'ann_ct_win' : 'ann_t_win', delay));
    });
    bus.on(Events.BOMB_PLANTED, () => this._announce('ann_bomb_planted', 0.55));
    bus.on(Events.BOMB_DEFUSED, () => this._announce('ann_bomb_defused', 0.45));

    // ---- the player's own radio (non-positional, quieter than the announcer; _radio swaps in the T lines on T side)
    bus.on(Events.BOMB_DEFUSE_START, (e) => { if (!e.bot) this._radio('ct_defusing', 8); });          // a bot's defuse is its own callout
    bus.on(Events.BOMB_PLANT_START, (e) => { if (e.player) this._radio('ct_defusing', 8); });          // -> "Planting the bomb." (T_RADIO)
    bus.on(Events.KILL, (e) => { if (e.killer === 'player' && state.phase !== 'over' && Math.random() < 0.6) this._radio('ct_enemy_down', 9, 0.75); });
    bus.on(Events.PLAYER_DAMAGE, (e) => {
      if (e.weapon === 'c4' || this._saidBackup || e.hp <= 0 || e.hp >= 35) return;
      this._saidBackup = true; this._radio('ct_need_backup', 0, 0.7);
    });
    // a T walks into clear view after being unseen for a while (Spotter): "enemy spotted", or "cover me" if we are caught
    // reloading / hurt. Flavour, not a warning system: low odds, long cooldowns, live phase only, never over the announcer
    bus.on(Events.PLAYER_SPOT, () => {
      if (state.phase !== 'live' || !state.player.alive) return;
      const exposed = state.player.reloading || state.player.hp < 50;
      if (exposed && this._radioReady('ct_cover_me') && Math.random() < 0.25) { this._radio('ct_cover_me', 20, 0.25, 0.5); return; }
      if (this._radioReady('ct_enemy_spotted') && Math.random() < 0.4) this._radio('ct_enemy_spotted', 12, 0.2, 0.5);
    });

    // ---- terrorist callouts: positional from the bot's head, occluded like any world sound, one voice per bot
    bus.on(Events.BOT_CALLOUT, (e) => {
      if (e.kind === 'planted') return;                          // the announcer covers the plant; no double line
      this._botLine(e.bot, e.pos, T_LINE[e.text] || T_KIND[e.kind] || e.kind, e.kind === 'planting' || e.kind === 'bomb' || e.kind === 'defusing');
    });

    bus.on(Events.WEAPON_FIRE, (e) => {
      if (e.shooter !== 'player') return;
      if (e.weapon === 'ak47') {
        a.play('ak47_fire', { vol: 0.95, rateJitter: 0.025 });
        a.play('brass', { pos: this._brassPos(), vol: 0.3, delay: 0.55 + Math.random() * 0.25, rateJitter: 0.08, occlude: false });
      } else if (e.weapon === 'awp') {
        a.play('awp_fire', { vol: 1.0, rateJitter: 0.015 });
        a.play('awp_bolt', { vol: 0.55, delay: 0.62, rate: 1.05 });
        a.play('brass', { pos: this._brassPos(), vol: 0.35, delay: 1.35, rate: 0.85, occlude: false });
      } else if (e.weapon === 'knife') {
        a.play('knife_swing', { vol: 0.5, rate: e.kind === 'primary' ? 1.15 : 0.9, rateJitter: 0.05 });
      }
    });

    bus.on(Events.HIT, (e) => {
      const h = e.hit; if (!h) return;
      if (e.melee) {
        if (h.surface === 'flesh') a.play('knife_flesh', { pos: h.point, vol: 0.9 }); else a.play('knife_wall', { pos: h.point, vol: 0.7, rateJitter: 0.05 });
        return;
      }
      if (h.surface === 'flesh') {
        // hit feedback stays understated: the dink is a quiet 2D cue, the body hit is the positional sound
        if (h.part === 'head') { a.play('headshot', { vol: 0.55 }); a.play('impact_flesh', { pos: h.point, vol: 0.5 }); }
        else a.play('impact_flesh', { pos: h.point, vol: 0.75, rateJitter: 0.06 });
        return;
      }
      const id = IMPACT[h.surface] || 'impact_concrete';
      a.play(id, { pos: h.point, vol: id === 'ricochet' ? 0.55 : 0.75, rateJitter: 0.08, rate: h.surface === 'wood' ? 0.85 : 1 });
    });

    bus.on(Events.WEAPON_RELOAD, (e) => {
      // stages follow the ViewModel reload curve: mag release at 16-36 % (sound 0.17), new mag seats 50-72 % (0.60), charge at 78-86 % (0.83)
      // -> for the 2.43 s AK: 0.41 s / 1.46 s / 2.02 s
      const d = e.duration || 2.4;
      if (e.weapon === 'ak47') { a.play('ak47_reload_1', { vol: 0.7, delay: d * 0.17, rateJitter: 0.02 }); a.play('ak47_reload_2', { vol: 0.75, delay: d * 0.60, rateJitter: 0.02 }); a.play('ak47_reload_3', { vol: 0.8, delay: d * 0.83, rateJitter: 0.02 }); }
      else if (e.weapon === 'awp') { a.play('ak47_reload_1', { vol: 0.6, delay: d * 0.17, rate: 0.9 }); a.play('ak47_reload_2', { vol: 0.6, delay: d * 0.55, rate: 0.9 }); a.play('awp_bolt', { vol: 0.6, delay: d * 0.78 }); }
    });
    bus.on(Events.WEAPON_SWITCH, () => { a.noise(0.16, { vol: 0.16, freq: 900, q: 0.7, sweep: 2.2 }); a.noise(0.05, { vol: 0.12, freq: 3200, q: 2, delay: 0.14 }); });

    bus.on(Events.PLAYER_FOOTSTEP, (e) => {
      const id = this._stepId(e.surface);
      if (e.kind === 'land') { a.play(id, { vol: 0.9, rate: 0.92 }); a.play(id, { vol: 0.5, delay: 0.08, rate: 1.05 }); return; }
      if (e.kind === 'jump') { a.play(id, { vol: 0.45, rate: 1.1 }); return; }
      a.play(id, { vol: e.quiet ? 0.12 : 0.55, rateJitter: 0.05, rate: e.surface === 'wood' ? 0.8 : 1 });
    });
    bus.on(Events.BOT_FOOTSTEP, (e) => {
      a.play(this._stepId(this._surfaceAt(e.pos)), { pos: _v.copy(e.pos).setY(e.pos.y + 0.1), vol: e.quiet ? 0.3 : 0.75, rateJitter: 0.05, ref: 3, max: 45 });
    });

    // bot gunfire: the real shot up close, a distant report far away; passing rounds crack past the ear
    bus.on(Events.SOUND, (e) => {
      if (e.name === 'ak47_fire_distant') {
        const d = this.game.player.position.distanceTo(e.pos);
        if (d < 32) a.play('ak47_fire', { pos: e.pos, vol: 0.85, ref: 4.5, rolloff: 1.0, rateJitter: 0.02 });
        else a.play('ak47_distant', { pos: e.pos, vol: 0.9, ref: 25, max: 250, absorb: 40, rateJitter: 0.04 });
        return;
      }
      switch (e.id) {
        case 'zoom': a.tone(2400, 0.03, { vol: 0.08, type: 'sine' }); a.noise(0.04, { vol: 0.1, freq: 4000, q: 3 }); break;
        case 'dryfire': a.noise(0.03, { vol: 0.25, freq: 2500, q: 4 }); break;
        case 'c4_plant': for (let i = 0; i < 5; i++) a.play('c4_key', { pos: e.pos, vol: 0.5, delay: 0.25 + i * 0.22, ref: 3 }); break;
        case 'c4_beep': a.tone(1560, 0.065, { vol: 0.5, type: 'square', pos: e.pos, decay: 0.02 }); break;
        case 'c4_defuse_start': a.noise(0.5, { vol: 0.12, freq: 2200, q: 1.2, sweep: 0.6 }); a.tone(880, 0.08, { vol: 0.12, type: 'sine', delay: 0.15 }); a.tone(880, 0.08, { vol: 0.12, type: 'sine', delay: 0.5 }); break;
        case 'c4_disarmed': a.tone(1200, 0.12, { vol: 0.35, type: 'square', pos: e.pos }); a.tone(800, 0.25, { vol: 0.35, type: 'square', pos: e.pos, delay: 0.14 }); break;
        case 'c4_explode': {
          const dist = e.dist ?? 50, near = dist < 14;
          a.play('c4_explode', near ? { vol: 1.0 } : { pos: e.pos, vol: 1.0, ref: 12, max: 400, absorb: 30, rolloff: 0.8 });
          if (!near) a.play('c4_explode', { vol: 0.35, lowpass: 400, rate: 0.9 });   // low-end thump always reaches the player
          // pressure wave: a 55->28 Hz sub under everything, then the ears close up (world buses low-passed) and open again
          a.tone(55, 0.7, { vol: near ? 0.8 : 0.45, type: 'sine', attack: 0.004, decay: 0.55, bus: 'sfx' });
          if (dist < 45) a.muffle(near ? 2.6 : 1.4, near ? 420 : 1200);
          break;
        }
        case 'round_live': {
          a.tone(660, 0.09, { vol: 0.14, type: 'sine' }); a.tone(990, 0.14, { vol: 0.14, type: 'sine', delay: 0.1 });
          const ts = this.game.bots?.team === 't' ? (this.game.bots?.alive || []) : [];   // a T shouts "go go go" as the team moves out (only audible if they spawn near)
          if (ts.length) { const b = ts[Math.floor(Math.random() * ts.length)]; this._botLine(b, b.position, 'gogogo', false, 0.6); }
          // T side: the player's own "I've got the bomb." as the round goes live -- the objective, in his ear (T voice only; no CT file)
          if (state.side === 't' && state.player.hasBomb) this._radio('got_bomb', 60, 0.8, 0.6);
          break;
        }
        case 'ct_win': this._stinger([392, 523, 659, 784], 'sine'); break;
        case 't_win': this._stinger([392, 311, 261, 196], 'triangle'); break;
      }
    });

    bus.on(Events.BOT_SHOOT, (e) => {
      if (e.wallHit) a.play('impact_concrete', { pos: e.wallHit.point, vol: 0.55, rateJitter: 0.08 });
      if (!e.hitPlayer && this.whizCd <= 0 && state.player.alive) {
        // closest approach of the bullet line to the player's head
        const head = this.game.camera.position, ab = _v.copy(e.end ?? e.hitPoint).sub(e.muzzle), t = THREE.MathUtils.clamp(_v2.copy(head).sub(e.muzzle).dot(ab) / ab.lengthSq(), 0, 1);
        const d = _v2.copy(e.muzzle).addScaledVector(ab, t).distanceTo(head);
        if (d < 1.8) { a.play('whiz', { vol: 0.55 + (1.8 - d) * 0.25, rateJitter: 0.1, delay: 0.02 }); this.whizCd = 0.12; }
      }
    });

    bus.on(Events.BOT_DEATH, (e) => {
      const p = e.bot.position;
      if (Math.random() < 0.85) a.play('death', { pos: _v.copy(p).setY(p.y + 1.4), vol: 0.8, bus: 'voice', ref: 4, max: 60 });
      a.play('bodyfall', { pos: p, vol: 0.8, delay: 0.5 + Math.random() * 0.2, ref: 3, max: 50 });
    });
    bus.on(Events.PLAYER_DAMAGE, (e) => {
      if (e.weapon === 'c4' || this.hurtCd > 0) return;
      if (Math.random() < 0.7) { a.play('hurt', { vol: 0.35, rateJitter: 0.08, lowpass: 5000 }); this.hurtCd = 0.5; }
    });
    bus.on(Events.PLAYER_DEATH, () => { a.play('death', { vol: 0.6, lowpass: 3000 }); a.play('bodyfall', { vol: 0.6, delay: 0.55 }); });
    bus.on(Events.BOMB_PLANTED, (e) => { a.tone(1400, 0.08, { vol: 0.3, pos: e.pos }); a.tone(1400, 0.08, { vol: 0.3, pos: e.pos, delay: 0.12 }); a.tone(1900, 0.16, { vol: 0.3, pos: e.pos, delay: 0.26 }); });
    bus.on(Events.ROUND_START, () => { a.startAmbient(); this.farT = 8 + Math.random() * 10; });
    this.farT = 12;
  }

  /** Occasional far-off life (a dog, a crow) 50-80 m out in a random direction, low and air-absorbed. */
  _farEvent() {
    const p = this.game.player.position, th = Math.random() * Math.PI * 2, r = 50 + Math.random() * 30;
    const pos = _v2.set(p.x + Math.cos(th) * r, p.y + 6 + Math.random() * 8, p.z + Math.sin(th) * r);
    this.a.play(Math.random() < 0.55 ? 'far_dog' : 'far_crow', { pos, vol: 0.5, bus: 'amb', ref: 4, max: 140, rolloff: 1.0, rateJitter: 0.04, occlude: false });
  }

  _stepId(surface) {
    if (surface === 'sand') return Math.random() < 0.5 ? 'step_dirt' : 'step_gravel';   // Dust's sand is gritty: two 4-variant sets, 8 textures
    return STEP[surface] || 'step_concrete';
  }

  // ------------------------------------------------------------ voice
  _announce(id, delay = 0) {
    if (!this.a.has(id)) return;
    this._annQ.push({ id, delay });
    if (!this._annBusy) this._annNext();
  }
  _annNext() {
    const n = this._annQ.shift();
    if (!n) { this._annBusy = false; return; }
    this._annBusy = true;
    const h = this.a.play(n.id, { bus: 'ui', vol: 0.95, delay: n.delay, onEnd: () => setTimeout(() => this._annNext(), 220) });
    if (!h) { this._annBusy = false; this._annQ.length = 0; return; }   // no context yet / muted: nothing to queue behind
    this.a.duck(4, h.dur + 0.25, n.delay);
    // a radio line still speaking when the announcer comes in (e.g. "need backup" from the hit that killed us, then
    // "terrorists win" 0.5 s later) is faded out under it: the announcer always has the floor
    const radio = this._radioH, cut = this._radioBusyUntil ?? -99;
    if (radio && this.game.time + n.delay < cut) { setTimeout(() => radio.stop(0.1), Math.max(0, n.delay - 0.3) * 1000); this._radioBusyUntil = this.game.time + n.delay; }
  }

  /** Can this radio line play now (own cooldown over, announcer silent, no other radio line still speaking)? */
  _radioReady(id) {
    const now = this.game.time;
    return now >= (this._radioCd[id] ?? -99) && !this._annBusy && now >= (this._radioBusyUntil ?? -99);
  }

  /** Player radio line with its own cooldown; never talks over the announcer or another radio line. */
  _radio(id, cd = 6, delay = 0, vol = 0.6) {
    if (state.side === 't') { id = T_RADIO[id]; if (!id || !this.a.has(id)) return; }   // a T player speaks with the T voice
    if (!this._radioReady(id)) return;
    const now = this.game.time;
    this._radioCd[id] = now + cd;
    const h = this.a.play(id, { bus: 'ui', vol, delay });
    if (!h) return;
    this._radioH = h; this._radioBusyUntil = now + delay + h.dur;
    this.a.duck(2.5, h.dur + 0.2, delay);
  }

  /** A terrorist speaks from `pos`: voice variant fixed per bot, 3 s per-bot cooldown, urgent lines wait for the current one instead of dropping. */
  _botLine(bot, pos, line, urgent = false, vol = 0.9) {
    if (!line || !bot) return;
    const bots = this.game.bots?.bots || [], idx = bots.indexOf(bot);
    const id = bot.team === 'ct' ? CT_LINE[line] : `t_${line}_v${idx >= 0 ? (idx % 3) + 1 : 1 + Math.floor(Math.random() * 3)}`;
    if (!id || !this.a.has(id)) return;
    const now = this.game.time, key = bot.name || idx;
    if (now < (this._calloutCd[key] ?? -99)) return;
    let delay = 0;
    if (now < this._calloutBusyUntil) { if (!urgent) return; delay = this._calloutBusyUntil - now + 0.15; }
    const h = this.a.play(id, { pos: _v.copy(pos).setY(pos.y + 1.55), vol, bus: 'voice', ref: 4, max: 70, delay, rateJitter: 0.015 });
    if (!h) return;
    this._calloutCd[key] = now + delay + 3;
    this._calloutBusyUntil = now + delay + h.dur;
  }

  _stinger(notes, type) {
    notes.forEach((f, i) => { this.a.tone(f, 0.28, { vol: 0.16, type, delay: i * 0.13, attack: 0.01, decay: 0.15 }); this.a.tone(f / 2, 0.5, { vol: 0.08, type: 'sine', delay: i * 0.13, attack: 0.02, decay: 0.3 }); });
  }

  _brassPos() { const p = this.game.player; return p.getRight(_v).multiplyScalar(0.7).add(p.position).setY(p.position.y + 0.05); }

  _surfaceAt(pos) {
    _rc.set(_v2.copy(pos).setY(pos.y + 0.6), DOWN); _rc.far = 2.5;
    const h = this.game.map.raycast(_rc);
    return h ? h.surface : 'concrete';
  }

  update(dt) {
    this.hurtCd -= dt; this.whizCd -= dt; this.a.updateListener(this.game.camera);
    if (this.a.ambient && (this.farT -= dt) <= 0) { this.farT = 12 + Math.random() * 23; this._farEvent(); }
  }
}
