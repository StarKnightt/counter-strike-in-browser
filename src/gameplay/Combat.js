import { bus, Events } from '../core/EventBus.js';
import { state } from '../core/GameState.js';
import { WEAPONS, falloff, applyArmor } from './WeaponDefs.js';

export const PART_MULT = { head: 4.0, chest: 1.0, stomach: 1.25, arm: 1.0, leg: 0.75 };

/**
 * Damage resolution. Any hittable entity implements:
 *   { alive, hp, armor, helmet, forward(), takeDamage({amount, part, dir, point, shooter, weapon, headshot}) }
 * The player is handled here directly (state.player) — bots call combat.damagePlayer().
 */
export class Combat {
  constructor(game) {
    this.game = game;
    bus.on(Events.HIT, (e) => this.onHit(e));
  }

  onHit(e) {
    const h = e.hit; if (!h?.entity || !h.entity.alive) return;
    const ent = h.entity, part = h.part || 'chest';
    let amount;
    if (e.melee) {
      const spec = e.def[e.kind];
      const back = ent.forward ? ent.forward().dot(e.dir) > 0.5 : false;
      amount = back && spec.backstab ? spec.backstab : spec.damage;
    } else {
      let raw = e.def.damage * (PART_MULT[part] ?? 1) * falloff(e.def, h.distance);
      const armored = ent.armor > 0 && part !== 'leg' && (part !== 'head' || ent.helmet);
      if (armored) { const r = applyArmor(raw, e.def.armorPen, ent.armor); amount = r.hp; ent.armor = Math.max(0, ent.armor - r.armorLoss); }
      else amount = Math.round(raw);
    }
    ent.takeDamage({ amount, part, dir: e.dir, point: h.point, shooter: e.shooter, weapon: e.weapon, headshot: part === 'head' });
  }

  /** Damage to the local player (from bots). */
  damagePlayer({ amount, dir, attacker, weapon, part = 'chest', armorPen = 0.775 }) {
    const p = state.player; if (!p.alive) return;
    let dmg = amount;
    const armored = p.armor > 0 && part !== 'leg';   // the player always has a helmet
    if (armored) { const r = applyArmor(amount, armorPen, p.armor); dmg = r.hp; p.armor = Math.max(0, p.armor - r.armorLoss); }
    p.hp = Math.max(0, p.hp - dmg);
    // `attacker` may be a Bot (object) or a label ('C4'); HUD/round text always want the display name
    const attackerName = typeof attacker === 'string' ? attacker : (attacker?.name ?? 'Terrorist');
    bus.emit(Events.PLAYER_DAMAGE, { amount: dmg, dir, attacker, attackerName, weapon, part, hp: p.hp });
    const pl = this.game.player;
    // tagging (CS2 m_flFlinchVelocityModifier): a hit caps run speed at 40 % (big hit) / 55 % of max for the weapon that hit
    // us and cuts the current velocity with it; Player recovers the multiplier over ~0.5 s
    const tag = WEAPONS[weapon]?.tag ?? [0.4, 0.55];
    const mod = amount > 20 ? tag[0] : tag[1];
    if (mod < pl.tag) { pl.tag = mod; pl.velocity.x *= mod; pl.velocity.z *= mod; }
    // flinch: CS2 has almost no aim punch when armored; a small kick when the shot got through
    const k = armored ? 0.25 : 1;
    pl.viewPunch.y += (0.008 + Math.random() * 0.006) * k; pl.viewPunch.x += (Math.random() - 0.5) * 0.012 * k;
    if (p.hp <= 0) { p.alive = false; bus.emit(Events.PLAYER_DEATH, { attacker, attackerName, weapon, headshot: part === 'head' }); }
  }
}
