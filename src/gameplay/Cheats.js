import * as THREE from 'three';
import { PLAYER } from '../core/Constants.js';
import { state } from '../core/GameState.js';
import { difficultyName, setDifficulty } from '../ai/Difficulty.js';

/**
 * Explore / cheat helpers, exposed as `window.__game.cheats` (see the header comment in Round.js).
 *
 *   ?explore=1 (or ?explore)  — walk the map alone: no bots, round never ends, timer frozen, god mode.
 *   cheats.noclip()           — toggle fly-through-walls (WASD + mouse, Space/Ctrl up/down, Shift = fast; unlike normal
 *                               play, where Shift = crouch and Ctrl = walk — see Input.BINDS — noclip skips the stance code)
 *   cheats.tp(x, y, z)        — teleport the player's feet to Three.js world coords (y optional)
 *   cheats.bots(on = true)    — spawn / remove the T team (in explore mode the round still never ends)
 *   cheats.god = true|false   — infinite HP on its own (explore mode turns it on)
 *   cheats.sens(v)            — mouse sensitivity as a CS2 number (2.0 default); persisted in localStorage['cs2.sens'], same as ?sens=
 *   cheats.xhair(code)        — Valorant crosshair profile code; persisted in localStorage['cs2.xhair'], same as ?xhair=
 *   cheats.difficulty(name)   — bot gunfight difficulty 'easy' | 'normal' | 'hard' (default easy; see ai/Difficulty.js);
 *                               persisted in localStorage['cs2.botdiff'], same as ?bots=; no argument = read it
 *   cheats.side('t'|'ct')     — play that side from the NEXT round (persisted in localStorage['cs2.side'] as the start side;
 *                               the rounds keep alternating after it unless ?side= pins one); no argument = read the current side
 *   cheats.bomb()             — hand the player the C4 right now, on either side (taken off the T carrier if a bot has it)
 */
export class Cheats {
  constructor(game, round) {
    this.game = game; this.round = round;
    const q = new URLSearchParams(location.search);
    const v = q.get('explore');
    this.explore = q.has('explore') && v !== '0' && v !== 'false';
    this.god = this.explore;
    if (this.explore) game.bots.enabled = false;
  }

  /** Per-frame upkeep (called by Round.update). */
  update() {
    if (!this.god) return;
    const p = state.player;
    p.hp = PLAYER.MAX_HP; p.armor = 100;
    if (!p.alive) { p.alive = true; this.game.player.deadT = 0; }
  }

  noclip() {
    const p = this.game.player;
    p.noclip = !p.noclip;
    if (!p.noclip) p.velocity.set(0, 0, 0);
    console.log(`noclip ${p.noclip ? 'ON' : 'OFF'}`);
    return p.noclip;
  }

  tp(x, y, z) {
    const p = this.game.player;
    if (z === undefined) { z = y; y = p.position.y; }        // tp(x, z) keeps the current height
    p.position.set(x, y, z); p.velocity.set(0, 0, 0); p.grounded = false;
    p.updateCamera();
    return p.position.clone();
  }

  bots(on = true) {
    const b = this.game.bots;
    b.enabled = !!on;
    b.spawnTeam();                                          // honours `enabled`: spawns the team, or just clears it
    return state.bots.length;
  }

  /** Set (and remember) the CS2 sensitivity; no argument = read it. The AWP scope scaling in Game/Weapons applies on top. */
  sens(v) {
    const inp = this.game.input;
    if (v !== undefined) { inp.setSensitivity(v, true); console.log(`sensitivity ${inp.cs2Sensitivity} (saved)`); }
    return inp.cs2Sensitivity;
  }

  /** Set (and remember) the Valorant crosshair code (see ui/Crosshair.js); no argument = read the current one. */
  xhair(code) {
    const xh = this.game.hud?.crosshair;
    if (!xh) return null;
    if (code !== undefined) { xh.set(code, true); console.log(`crosshair ${xh.code} (saved)`); }
    return xh.code;
  }

  /** Set (and remember) the bot difficulty preset; applies to live bots at their next contact. No argument = read it. */
  difficulty(name) {
    if (name !== undefined) { setDifficulty(name, true); console.log(`bot difficulty ${difficultyName()} (saved)`); }
    return difficultyName();
  }

  /** Side for the next round ('t' | 'ct'); remembered as the start side. No argument = the side being played now. */
  side(v) {
    if (v !== undefined) {
      const s = this.round.constructor.parseSide(v);
      if (!s) { console.warn(`side: 't' or 'ct'`); return state.side; }
      this.round.forcedSide = s;
      try { localStorage.setItem(this.round.constructor.SIDE_KEY, s); } catch { /* storage blocked: session only */ }
      console.log(`side ${s.toUpperCase()} from the next round (now ${state.side.toUpperCase()}; saved)`);
    }
    return state.side;
  }

  /** Give the player the C4 (any side). A bot carrying it loses it; a dropped one is picked up. Nothing once it is planted. */
  bomb() {
    const b = this.game.bomb;
    if (b.planted) { console.warn('bomb: already planted'); return false; }
    for (const bot of this.game.bots.bots) bot.hasBomb = false;
    if (b.dropped) { b.dropped = false; if (b.model) b.model.visible = false; }
    state.player.hasBomb = true; state.bomb.state = 'carried'; state.bomb.carrier = 'player'; state.bomb.position = null;
    console.log('you have the C4: hold E inside the A zone to plant');
    return true;
  }

  /** Convenience: where am I? */
  get pos() { return this.game.player.position.clone(); }
  get yaw() { return THREE.MathUtils.radToDeg(this.game.player.yaw); }
}
