import { bus, Events } from '../core/EventBus.js';
import { state, nameOf } from '../core/GameState.js';
import { Radar } from './Radar.js';
import { Crosshair } from './Crosshair.js';
import { renderWeaponIcons } from './WeaponIcons.js';

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const ALERT_T = 4;
const OBJ_T = 4;      // seconds into the live round the objective line stays up (then it fades)
const SLOTS = 5;
/** Roster ticks: one per team slot; alive solid, dead dim ('x'), unused slot faint ('e'). */
const ticks = (alive) => { let s = ''; for (let i = 0; i < SLOTS; i++) s += `<i class="${i >= alive.length ? 'e' : alive[i] ? '' : 'x'}"></i>`; return s; };

/**
 * DOM HUD in the CS2 layout: radar (TL), score + round timer + alive ticks (TC), killfeed (TR), HP/armor (BL),
 * ammo + weapon glyph (BR), crosshair, damage wedges, bomb glyph/defuse, death-cam panel, win panel, flash.
 * Weapon glyphs are white silhouettes rendered from the real meshes at load (see WeaponIcons.js).
 */
export class HUD {
  constructor(game) {
    this.game = game;
    const root = document.getElementById('hud');
    root.innerHTML = `
      <canvas id="radar" width="420" height="420"></canvas>
      <div id="top">
        <div class="team ct"><span class="n" id="ctScore">0</span><span class="ticks" id="ctTicks"></span></div>
        <div id="clock"><span id="timer">1:55</span><img id="c4icon" class="hidden" alt=""></div>
        <div class="team t"><span class="ticks" id="tTicks"></span><span class="n" id="tScore">0</span></div>
      </div>
      <div id="alert" class="hidden"></div>
      <div id="killfeed"></div>
      <canvas id="crosshair" width="2" height="2"></canvas>
      <div id="dmg"><div class="wedge"></div><div class="wedge"></div><div class="wedge"></div></div>
      <div id="hitflash"></div>
      <div id="lowhp"></div>
      <div id="vitals">
        <div class="stat hp"><span class="ico">+</span><span id="hp">100</span></div>
        <div class="stat ar"><span class="ico shield"></span><span id="armor">100</span></div>
      </div>
      <div id="ammo"><img id="c4carry" class="hidden" alt="" title="C4"><div class="row" id="ammorow"><span id="mag">30</span><span class="sep">/</span><span id="reserve">90</span></div><img id="wicon" alt=""></div>
      <div id="bombhint" class="hidden"><span class="site">BOMBSITE <b>A</b></span><span class="act">HOLD <kbd>E</kbd> TO <span id="bombverb">DEFUSE</span></span></div>
      <div id="defuse" class="hidden"><div class="lbl"><span id="defuseLbl">DEFUSING</span> <span id="defuseT"></span></div><div class="bar"><div id="defuseFill"></div></div></div>
      <div id="objective" class="hidden"></div>
      <div id="flash"></div>
      <div id="deathpanel" class="hidden"><span class="lbl">KILLED BY</span><span class="name" id="dpName"></span><img id="dpIcon" alt=""><span class="hp" id="dpHp"></span></div>
      <div id="endcard" class="hidden"><div class="who" id="endWho"></div><div class="why" id="endWhy"></div><div class="mvp" id="endMvp"></div></div>`;
    const ids = ['top', 'radar', 'ctScore', 'ctTicks', 'tTicks', 'tScore', 'timer', 'c4icon', 'alert', 'killfeed', 'crosshair', 'dmg', 'hitflash', 'lowhp',
      'vitals', 'hp', 'armor', 'ammo', 'c4carry', 'ammorow', 'mag', 'reserve', 'wicon', 'bombhint', 'bombverb', 'defuse', 'defuseLbl', 'defuseT', 'defuseFill', 'objective', 'flash',
      'deathpanel', 'dpName', 'dpHp', 'dpIcon', 'endcard', 'endWho', 'endWhy', 'endMvp'];
    this.el = Object.fromEntries(ids.map((id) => [id, document.getElementById(id)]));
    this.wedges = [...this.el.dmg.children].map((el) => ({ el, a: 0, ang: 0 }));
    this.radar = new Radar(game, this.el.radar);
    this.crosshair = new Crosshair(this.el.crosshair, game);   // Valorant-code crosshair (see Crosshair.js); shown / hidden below via _vis('xh')
    this.flashA = 0; this.flashCol = '255,255,255'; this.hitA = 0;
    this.feed = []; this.last = {};
    this.alertT = 0; this.endPending = null; this.liveT = 0;

    // weapon glyphs from the real meshes
    const vm = game.vm, src = { ak47: vm.weapons.ak47?.group, awp: vm.weapons.awp?.group, knife: vm.weapons.knife?.group, c4: game.bomb?.model };
    try { this.icons = renderWeaponIcons(game.renderer, src); } catch (e) { console.warn('weapon icons', e); this.icons = {}; }
    if (this.icons.c4) { this.el.c4icon.src = this.icons.c4; this.el.c4carry.src = this.icons.c4; }

    bus.on(Events.BOMB_EXPLODED, (e) => { if (this.noFlash) return; this.flashA = 0.35 + 0.65 * e.k; this.flashCol = e.k > 0.6 ? '255,236,200' : '255,200,140'; });
    bus.on(Events.BOMB_PLANTED, () => this._alert('The bomb has been planted.'));
    bus.on(Events.BOMB_DEFUSED, () => this._alert('The bomb has been defused.'));
    bus.on(Events.ROUND_END, (e) => { this.endPending = { e, t: e.playerAlive ? 0.6 : 1.9 }; });
    bus.on(Events.ROUND_START, () => this._reset());
    // killer/victim may arrive as labels ('player', 'C4'), bot names or (from test harnesses) whole Bot/Player objects.
    // Team colours follow state.side: the player's kills are in his team's colour, the bots in the other's.
    bus.on(Events.KILL, (e) => {
      const mine = e.killer === 'player' || e.killer === game.player, k = mine ? state.playerName : nameOf(e.killer);
      this._kill(k, mine ? this.own : this.enemy, nameOf(e.victim), this.enemy, e.weapon, e.headshot, mine);
    });
    bus.on(Events.PLAYER_DEATH, (e) => {
      const c4 = e.weapon === 'c4';
      const an = e.attackerName || (e.attacker ? nameOf(e.attacker) : '');
      this._kill(c4 ? '' : an, this.enemy, state.playerName, this.own, e.weapon, e.headshot, true);
      const k = game.bots?.bots.find((b) => b === e.attacker || b.name === an);
      this.el.dpName.textContent = c4 ? 'The bomb' : (an || (this.enemy === 'ct' ? 'Counter-Terrorist' : 'Terrorist'));
      this.el.dpName.className = 'name ' + this.enemy;
      this.el.dpHp.textContent = c4 ? '' : `${Math.max(1, Math.ceil(k?.hp ?? 100))} HP`;
      if (this.icons[e.weapon]) { this.el.dpIcon.src = this.icons[e.weapon]; this.el.dpIcon.style.display = ''; } else this.el.dpIcon.style.display = 'none';
      this.deathPanelT = 0.35;    // appears once the death cam has settled a little
    });
    bus.on(Events.PLAYER_DAMAGE, (e) => this._damage(e));
  }

  _reset() {
    for (const k of ['endcard', 'deathpanel', 'alert']) this.el[k].classList.add('hidden');
    this.flashA = 0; this.hitA = 0; this.feed.length = 0; this.el.killfeed.innerHTML = '';
    for (const w of this.wedges) { w.a = 0; w.el.style.opacity = '0'; }
    this.last = {}; this.endPending = null; this.deathPanelT = null; this.alertT = 0; this.liveT = 0;
    this.el.objective.classList.add('hidden');
  }

  _alert(text) { this.el.alert.textContent = text; this.el.alert.classList.remove('hidden'); this.alertT = ALERT_T; }
  /** The player's team / the bots' team as HUD class names ('ct' | 't'). */
  get own() { return state.side === 't' ? 't' : 'ct'; }
  get enemy() { return state.side === 't' ? 'ct' : 't'; }

  _kill(killer, kTeam, victim, vTeam, weapon, hs, mine) {
    killer = killer ? nameOf(killer) : ''; victim = nameOf(victim);
    const row = document.createElement('div');
    row.className = 'kf' + (mine ? ' mine' : '');
    const icon = this.icons[weapon] ? `<img class="w" src="${this.icons[weapon]}" alt="">` : `<span class="wtxt">${esc(weapon || '')}</span>`;
    row.innerHTML = `${killer ? `<span class="${kTeam}">${esc(killer)}</span>` : ''}${icon}${hs ? '<span class="hs" title="headshot"></span>' : ''}<span class="${vTeam}">${esc(victim)}</span>`;
    this.el.killfeed.appendChild(row);
    this.feed.push({ row, t: 0 });
    while (this.feed.length > 6) { const o = this.feed.shift(); o.row.remove(); }
  }

  _damage(e) {
    this.hitA = 1;
    if (e.weapon === 'c4') { for (const w of this.wedges) { w.a = 1; w.ang = 0; } this.wedges[1].ang = 120; this.wedges[2].ang = 240; return; }
    const d = e.dir; if (!d) return;
    // screen angle of the attacker: 0 = ahead, clockwise. e.dir is bullet travel, so the attacker is behind it.
    const p = this.game.player;
    const ax = -d.x, az = -d.z;
    const f = ax * -Math.sin(p.yaw) + az * -Math.cos(p.yaw), r = ax * Math.cos(p.yaw) + az * -Math.sin(p.yaw);
    const ang = Math.atan2(r, f) * 180 / Math.PI;
    // reuse a wedge that is close in angle, else the faintest one
    let w = this.wedges.find((x) => x.a > 0 && Math.abs(((x.ang - ang + 540) % 360) - 180) < 25);
    if (!w) w = this.wedges.reduce((m, x) => (x.a < m.a ? x : m), this.wedges[0]);
    w.ang = ang; w.a = 1;
  }

  _showEnd(e) {
    const ct = e.winner === 'CT';
    this.el.endWho.textContent = ct ? 'COUNTER-TERRORISTS WIN' : 'TERRORISTS WIN';
    this.el.endWho.className = 'who ' + (ct ? 'ct' : 't');
    this.el.endWhy.textContent = e.reason;
    const m = state.mvp;
    this.el.endMvp.innerHTML = m ? `<span class="star">★</span><span class="${m.team}">${esc(nameOf(m.name))}</span><span class="sep">—</span>MVP ${esc(m.text)}` : '';
    this.el.endcard.classList.remove('hidden');
  }

  _set(key, el, text) { if (this.last[key] !== text) { this.last[key] = text; el.textContent = text; } }
  _vis(key, el, show) { if (this.last[key] !== show) { this.last[key] = show; el.classList.toggle('hidden', !show); } }

  update(dt) {
    const p = state.player, phase = state.phase, planted = phase === 'planted', over = phase === 'over';
    const g = this.game;
    // --- top: score digits, timer / bomb glyph, alive ticks
    this._set('cs', this.el.ctScore, String(state.score.ct)); this._set('ts', this.el.tScore, String(state.score.t));
    this._vis('c4', this.el.c4icon, planted);
    this._vis('timer', this.el.timer, !planted);
    if (!planted) this._set('t', this.el.timer, fmt(phase === 'freeze' ? Math.max(0, Math.ceil(state.freezeTime)) : state.roundTime));
    else {
      const frac = 1 - state.bombTime / 40, period = 1.0 - 0.8 * frac * frac;
      this.el.c4icon.classList.toggle('on', (state.bombTime % period) < period * 0.5);
    }
    this.el.timer.classList.toggle('low', !planted && state.roundTime < 10 && phase === 'live' && (state.roundTime % 1) < 0.6);
    // 5 roster ticks per side like CS2 (alive = solid, dead = dim, empty slot = faint); markup is rebuilt only when the alive bitmask changes.
    // The player's team sits on the left (CS2 shows your own team first): T side mirrors the strip.
    const tside = state.side === 't';
    if (this.last.tside !== tside) { this.last.tside = tside; this.el.top.classList.toggle('tside', tside); this.last.ticks = this.last.ctick = undefined; }
    const botTicks = tside ? this.el.ctTicks : this.el.tTicks, meTicks = tside ? this.el.tTicks : this.el.ctTicks;
    let tk = state.bots.length; for (const b of state.bots) tk = tk * 2 + (b.alive ? 1 : 0);
    if (this.last.ticks !== tk) { this.last.ticks = tk; botTicks.innerHTML = ticks(state.bots.map((b) => b.alive)); }
    if (this.last.ctick !== p.alive) { this.last.ctick = p.alive; meTicks.innerHTML = ticks([p.alive]); }
    // --- alert line
    if (this.alertT > 0) { this.alertT -= dt; this.el.alert.style.opacity = Math.min(1, this.alertT / 0.5).toFixed(2); if (this.alertT <= 0) this.el.alert.classList.add('hidden'); }
    // --- player block (hidden when dead)
    this._vis('vit', this.el.vitals, p.alive); this._vis('ammo', this.el.ammo, p.alive);
    const hp = Math.max(0, Math.ceil(p.hp)), ar = Math.max(0, Math.ceil(p.armor));
    this._set('hp', this.el.hp, String(hp)); this._set('ar', this.el.armor, String(ar));
    if (this.last.lowCls !== (hp <= 20)) { this.last.lowCls = hp <= 20; this.el.vitals.classList.toggle('low', hp <= 20); }
    const lowA = p.alive && hp <= 20 ? (0.35 + 0.25 * (1 - hp / 20)).toFixed(2) : '0';
    if (this.last.lowhp !== lowA) { this.last.lowhp = lowA; this.el.lowhp.style.opacity = lowA; }
    // --- ammo + glyph
    // Melee (knife) publishes no ammo (null / no mag field): the whole mag/reserve row hides, CS2 style; the glyph stays.
    // NB: target the .row by id -- #ammo's first child is the C4 glyph, so firstElementChild toggled the wrong element.
    const a = p.ammo, hasAmmo = !!a && Number.isFinite(a.mag) && Number.isFinite(a.reserve);
    this._vis('ammoRow', this.el.ammorow, hasAmmo);
    if (hasAmmo) { this._set('mag', this.el.mag, String(a.mag)); this._set('res', this.el.reserve, String(a.reserve)); this.el.mag.classList.toggle('low', a.mag <= 5); }
    if (this.last.wicon !== p.weapon) { this.last.wicon = p.weapon; const src = this.icons[p.weapon]; if (src) { this.el.wicon.src = src; this.el.wicon.style.display = ''; } else this.el.wicon.style.display = 'none'; }
    this._vis('c4c', this.el.c4carry, !!p.hasBomb && !!this.icons.c4);   // carrying the C4: its glyph beside the ammo
    // --- crosshair: hidden when scoped / aiming down the sights (past 30 % of the blend), dead, holstered, or round over
    this._vis('xh', this.el.crosshair, !(p.scoped || (p.ads ?? 0) > 0.3 || !p.alive || p.defusing || p.planting || over));
    // --- damage wedges + hit flash
    for (const w of this.wedges) if (w.a > 0) { w.a = Math.max(0, w.a - dt / 0.6); w.el.style.opacity = w.a.toFixed(2); w.el.style.setProperty('--a', `${w.ang.toFixed(1)}deg`); }
    if (this.hitA > 0) { this.hitA = Math.max(0, this.hitA - dt / 0.15); this.el.hitflash.style.opacity = this.hitA.toFixed(2); }
    // --- bomb: "hold E to defuse" at a planted C4 (CT) / "hold E to plant" inside the zone with the C4 (T); one shared progress bar
    const canPlant = !planted && !!state.bomb.canPlant && !!p.hasBomb;
    this._vis('hint', this.el.bombhint, ((planted && state.bomb.canDefuse && !p.defusing) || (canPlant && !p.planting)) && p.alive);
    this._set('verb', this.el.bombverb, canPlant ? 'PLANT' : 'DEFUSE');
    const busy = p.defusing || p.planting;
    this._vis('defuse', this.el.defuse, busy);
    if (busy) {
      const prog = p.planting ? p.plantProgress : p.defuseProgress, total = p.planting ? (p.plantTime || 3.2) : (p.defuseTime || 5);
      this._set('dlbl', this.el.defuseLbl, p.planting ? 'PLANTING' : 'DEFUSING');
      this.el.defuseFill.style.width = `${(prog * 100).toFixed(1)}%`;
      this.el.defuseT.textContent = `${Math.max(0, total * (1 - prog)).toFixed(1)}s`;
    }
    // --- objective line (bottom centre): the side's job for the freeze + the first OBJ_T s of the round (fades out), and
    // again for the C4 carrier once he is within ~12 m of A but not yet inside the plant zone (the zone hint takes over there)
    if (phase === 'live') this.liveT += dt; else if (phase === 'freeze') this.liveT = 0;
    let obj = null, objA = 0;
    if (p.alive && !over && !planted && !busy) {
      const start = phase === 'freeze' || this.liveT < OBJ_T, site = g.map.markers.bombsite;
      if (tside && p.hasBomb) {
        const near = !!site && Math.hypot(g.player.position.x - site.pos.x, g.player.position.z - site.pos.z) < site.radius + 12;
        if (start || (near && !canPlant)) { obj = 'PLANT THE BOMB AT <b>A</b>'; objA = near ? 1 : phase === 'freeze' ? 1 : Math.min(1, (OBJ_T - this.liveT) / 0.6); }
      } else if (!tside && start) { obj = 'DEFEND BOMBSITE <b>A</b>'; objA = phase === 'freeze' ? 1 : Math.min(1, (OBJ_T - this.liveT) / 0.6); }
    }
    this._vis('obj', this.el.objective, objA > 0);
    if (objA > 0) {
      if (this.last.objTxt !== obj) { this.last.objTxt = obj; this.el.objective.innerHTML = obj; }
      const a = objA.toFixed(2); if (this.last.objA !== a) { this.last.objA = a; this.el.objective.style.opacity = a; }
    }
    // --- flash
    if (this.flashA > 0) {
      this.flashA = Math.max(0, this.flashA - dt * (this.flashA > 0.5 ? 0.9 : 0.45));
      this.el.flash.style.background = `rgba(${this.flashCol},${this.flashA.toFixed(3)})`;
    } else if (this.el.flash.style.background) this.el.flash.style.background = '';
    // --- killfeed lifetime: 7 s, 0.5 s fade
    for (let i = this.feed.length - 1; i >= 0; i--) { const f = this.feed[i]; f.t += dt; if (f.t > 7.5) { f.row.remove(); this.feed.splice(i, 1); } else if (f.t > 7) f.row.style.opacity = ((7.5 - f.t) / 0.5).toFixed(2); }
    // --- death panel (after the death cam settles) and win panel (delayed so the death cam is readable)
    if (this.deathPanelT !== null && this.deathPanelT !== undefined) { this.deathPanelT -= dt; if (this.deathPanelT <= 0) { this.el.deathpanel.classList.remove('hidden'); this.deathPanelT = null; } }
    if (this.endPending) { this.endPending.t -= dt; if (this.endPending.t <= 0) { this._showEnd(this.endPending.e); this.endPending = null; } }
    // --- crosshair pixels (redraws only when the profile / scale / error inputs change) + radar
    this.crosshair.update();
    this.radar.update(dt);
  }
}
