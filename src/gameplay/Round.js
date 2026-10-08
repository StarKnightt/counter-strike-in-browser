import { bus, Events } from '../core/EventBus.js';
import { state, resetRound } from '../core/GameState.js';
import { Cheats } from './Cheats.js';
import { BRAND } from '../brand.js';

const ROUND_TIME = 115;       // 1:55
const FREEZE_TIME = 3;        // short freeze so the player can orient (bots are staggered anyway)
const END_HOLD = 7;           // seconds the result stays before the next round starts (mp_round_restart_delay)

/**
 * Round flow (one CS2 round): freeze -> live -> (planted) -> over.
 * CT side (state.side 'ct', bots are Ts): T eliminated (CT) · time out (CT) · defused (CT) · player dead (T) · target bombed (T).
 *   After a plant, killing every T does NOT end the round (the bomb still has to be defused).
 * T side (state.side 't', the player carries the C4, bots are CTs): CTs eliminated (T) · target bombed (T) · defused (CT) ·
 *   time out without a plant (CT) · player dead before the plant (CT). A dead planter still wins if the C4 detonates (CS rule),
 *   and killing every CT after the plant ends the round at once (nobody is left to defuse).
 *
 * SIDE SELECTION — no menus. `?side=t` / `?side=ct` pins the side for the session. Otherwise the sides alternate every round,
 * starting from localStorage['cs2.side'] (written by cheats.side()) or CT. `cheats.side('t'|'ct')` applies at the next round start.
 *
 * EXPLORE MODE — open the game with `?explore=1` (or just `?explore`) to walk the map alone:
 *   no bots spawn, no freeze time, the round timer is frozen at 1:55 and the round never ends,
 *   and the player has infinite HP. Console helpers live on `window.__game.cheats`:
 *     cheats.noclip()     toggle fly-through-walls (WASD/mouse, Space up, Ctrl down, Shift fast)
 *     cheats.tp(x, y, z)  teleport (feet position, Three.js world units; y optional)
 *     cheats.bots(on)     re-enable (true) / remove (false) the T team
 *     cheats.god          infinite HP flag (on in explore mode; usable on its own)
 *     cheats.sens(v)      mouse sensitivity as a CS2 number (persisted; same as ?sens=)
 */
export class Round {
  constructor(game) {
    this.game = game;
    this.endT = 0;
    this.cheats = game.cheats = new Cheats(game, this);
    // side: URL pin > stored start side > CT; `nextSide` is what the next start() applies (alternation / cheats.side)
    const urlSide = Round.parseSide(new URLSearchParams(location.search).get('side'));
    this.pinnedSide = urlSide;
    let stored = null; try { stored = Round.parseSide(localStorage.getItem(Round.SIDE_KEY)); } catch { /* storage blocked */ }
    this.nextSide = urlSide || stored || 'ct';
    bus.on(Events.PLAYER_DEATH, (e) => {
      if (this.cheats.god) { state.player.alive = true; state.player.hp = 100; return; }
      const k = game.bots?.bots.find((b) => b === e.attacker || b.name === e.attackerName);
      game.player.deathLook = k ? k.position : (e.weapon === 'c4' ? game.bomb?.position : null);
      if (state.side === 't') {
        // the planter's death drops the C4 where he fell (T bots -- cheats.bomb() in CT mode -- fetch it; alone as T the round is over)
        if (state.player.hasBomb) game.bomb.drop(game.player.position);
        if (state.phase !== 'planted') this._end('CT', BRAND.tEliminated);   // planted: the round runs on to detonation / defuse
        return;
      }
      if (state.player.hasBomb) { game.bomb.drop(game.player.position); }
      this._end('T', BRAND.ctEliminated);
    });
    bus.on(Events.BOMB_DEFUSED, () => this._end('CT', 'Bomb defused'));
    bus.on(Events.BOMB_EXPLODED, () => this._end('T', 'Target bombed'));
    this.botKills = {};
    bus.on(Events.PLAYER_DAMAGE, (e) => { if (e.attackerName && e.weapon !== 'c4') this.lastAttacker = e.attackerName; });
  }

  start() {
    resetRound();
    state.side = this.nextSide;
    this.game.bomb.reset();
    state.roundTime = ROUND_TIME; state.freezeTime = FREEZE_TIME; state.phase = 'freeze';
    if (this.cheats.explore) { state.freezeTime = 0; state.phase = 'live'; }   // no freeze lock on movement
    this.endT = 0;
    bus.emit(Events.ROUND_START, {});
  }

  /** Full restart: player, bots, bomb, dropped rifles. */
  restart() {
    const g = this.game;
    state.round++; this.lastAttacker = null;
    // next side: pinned by URL, else the one cheats.side() asked for, else swap (CS half-time in miniature: one round each)
    this.nextSide = this.pinnedSide || this.forcedSide || (state.side === 'ct' ? 't' : 'ct'); this.forcedSide = null;
    this.start();
    this.spawnPlayer();
    g.weapons.resetLoadout?.();
    g.bots.spawnTeam();
  }

  /** 'ct' | 't' | null from user input (URL / storage / console). */
  static parseSide(v) { v = String(v ?? '').trim().toLowerCase(); return v === 't' || v === 'ct' ? v : null; }

  /**
   * Team spawn, facing down the route toward the bombsite so the player is oriented immediately. T side: one of the T spawn
   * markers (the ones the T bots use), the one furthest from any bot so nobody spawns inside anybody.
   */
  spawnPlayer() {
    const g = this.game, site = g.map.markers.bombsite?.pos, nav = g.bots?.nav;
    let s = g.map.markers.spawnCT;
    if (state.side === 't') {
      const ts = g.map.markers.spawnT || [], bots = g.bots?.bots || [];
      const clear = (p) => Math.min(Infinity, ...bots.filter((b) => b.alive).map((b) => b.position.distanceTo(p)));
      s = ts.reduce((best, p) => (!best || clear(p) > clear(best) ? p : best), null) || s;
    }
    let target = site;
    // look down the route toward the site (first node that is a few metres away), not through the wall
    if (nav && s) {
      const from = nav.nearest(s), to = nav.nearest(site), route = nav.path(from, to) || [];
      for (const n of route) { const q = nav.pos(n); if (q && Math.hypot(q.x - s.x, q.z - s.z) > 3) { target = q; break; } }
    }
    let yaw = 0;
    if (s && target) yaw = Math.atan2(-(target.x - s.x), -(target.z - s.z)) * 180 / Math.PI;
    g.player.spawn(s, yaw);
  }

  update(dt) {
    const g = this.game;
    this.cheats.update();
    if (this.cheats.explore) {
      // explore: stay 'live' forever, clock + bomb frozen, nothing can end the round
      if (state.phase !== 'planted') state.phase = 'live';
      state.roundTime = ROUND_TIME;
      return;
    }
    if (state.phase === 'freeze') {
      // the freeze clock only runs once the player is in (pointer locked) so the round doesn't start on the menu
      if (g.input.locked || this.go) state.freezeTime -= dt;
      if (state.freezeTime <= 0) { state.phase = 'live'; bus.emit(Events.SOUND, { id: 'round_live' }); }
      return;
    }
    if (state.phase === 'over') {
      this.endT += dt; state.endT = this.endT;
      if (this.endT >= END_HOLD && !this.noAutoRestart) this.restart();   // mp_round_restart_delay
      return;
    }
    const botsDead = state.bots.length && g.bots.alive.length === 0;
    if (state.phase === 'live') {
      state.roundTime = Math.max(0, state.roundTime - dt);
      if (state.roundTime <= 0) { this._end('CT', 'Time ran out'); return; }
      if (botsDead) { this._end(state.side === 't' ? 'T' : 'CT', state.side === 't' ? BRAND.ctEliminated : BRAND.tEliminated); return; }
    }
    // 'planted': the bomb owns the clock; only the bomb events (or the player's death) can end it -- except on T side, where
    // the last CT dying leaves nobody to defuse: the round ends at once (CS rule)
    if (state.phase === 'planted' && state.side === 't' && botsDead) this._end('T', BRAND.ctEliminated);
  }

  _end(winner, reason) {
    if (state.phase === 'over' || this.cheats.explore) return;
    state.phase = 'over'; state.winner = winner; state.winReason = reason;
    this.endT = 0;
    state.score[winner === 'CT' ? 'ct' : 't']++;
    state.mvp = this._mvp(winner, reason);
    // stop the bots fighting; the player can still look around
    if (this.game.bomb.defusing) this.game.bomb.defusing = false;
    if (this.game.bomb.planting) this.game.bomb.planting = false;
    state.player.defusing = false; state.player.planting = false;
    bus.emit(Events.SOUND, { id: winner === 'CT' ? 'ct_win' : 't_win' });
    bus.emit(Events.ROUND_END, { winner, reason, kills: state.kills, playerAlive: state.player.alive });
  }

  /** CS2-style MVP line: the player for a CT win, otherwise the planter / the bot that killed the player. */
  _mvp(winner, reason) {
    const g = this.game, k = state.kills;
    if (state.side === 't') {
      // T side: the player is the T team; the CT bots defuse / hold / kill
      if (winner === 'T') {
        const txt = reason === 'Target bombed' ? 'for planting the bomb' : `for eliminating ${k} enem${k === 1 ? 'y' : 'ies'}`;
        return { name: state.playerName, team: 't', text: txt };
      }
      if (reason === 'Bomb defused') return { name: state.bomb.defuser || g.bots.alive[0]?.name || BRAND.ct, team: 'ct', text: 'for defusing the bomb' };
      if (reason === 'Time ran out') return { name: g.bots.alive[0]?.name || BRAND.ct, team: 'ct', text: 'for holding the site' };
      return { name: this.lastAttacker || g.bots.alive[0]?.name || BRAND.ct, team: 'ct', text: 'for eliminating 1 enemy' };
    }
    if (winner === 'CT') {
      const txt = reason === 'Bomb defused' ? 'for defusing the bomb' : `for eliminating ${k} enem${k === 1 ? 'y' : 'ies'}`;
      return { name: state.playerName, team: 'ct', text: txt };
    }
    if (reason === 'Target bombed') { const p = g.bots.bots.find((b) => b.planted) || g.bots.bots.find((b) => !b.hasBomb); return { name: p?.name || BRAND.t, team: 't', text: 'for planting the bomb' }; }
    const killer = this.lastAttacker || g.bots.alive[0]?.name || BRAND.t;
    return { name: killer, team: 't', text: 'for eliminating 1 enemy' };
  }

  /** Skip the freeze (debug/test scripts). */
  skipFreeze() { if (state.phase === 'freeze') { state.freezeTime = 0; this.go = true; } }

  get canRestart() { return state.phase === 'over' && this.endT > 2.5; }
}
Round.SIDE_KEY = 'cs2.side';
