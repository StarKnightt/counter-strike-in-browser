import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { bus, Events } from '../core/EventBus.js';
import { state } from '../core/GameState.js';

const BOMB_TIME = 40;          // CS2 default mp_c4timer
const DEFUSE_TIME = 5;         // with kit (CTs on this map carry one)
const PLANT_TIME = 3.2;        // CS2 plant time (the T bots use the same figure in Bot._plant)
const BLAST_RADIUS = 26;       // metres (C4 radius 1750u ≈ 33 m; the site is small so slightly tighter)
const BLAST_DAMAGE = 500;
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3();

/**
 * The C4: planted model + blinking LED/beeps with the CS2 cadence, player defuse (hold E, in range, looking at it),
 * player plant (T side / cheats.bomb(): hold E inside the bombsite zone for 3.2 s), a dropped C4 where its carrier fell,
 * detonation (damage falloff to player + bots, explosion FX, screen flash / shake) and round-relevant events.
 */
export class Bomb {
  constructor(game) {
    this.game = game; this.scene = game.scene;
    this.model = null; this.led = null; this.lcd = null;
    // One light for both the LED blink (while planted) and the blast flash (re-parametrised in explode()), and it stays
    // visible at intensity 0 in between: three bakes the number of *visible* point lights into every lit program, so a
    // light that appears at plant time forced a recompile of the whole scene's shaders (~1.6 s stall on ANGLE/D3D11).
    this.light = new THREE.PointLight(0xff3020, 0, 3, 2); this.scene.add(this.light);
    this.planted = false; this.exploded = false; this.defused = false;
    this.timer = BOMB_TIME; this.beepT = 0; this.ledOn = 0;
    this.defusing = false; this.defuseT = 0;
    this.planting = false; this.plantT = 0;
    this.position = new THREE.Vector3();
    this.flashEl = null;
    bus.on(Events.BOMB_PLANTED, (e) => this.plant(e.pos, e.yaw ?? e.bot?.yaw ?? 0));
  }

  /** Inside the A plant zone (the BOMBSITE marker: horizontal radius, same floor)? Shared by the player's plant and the T bots' plant spot. */
  inPlantZone(pos) {
    const s = this.game.map.markers.bombsite; if (!s) return false;
    return Math.hypot(pos.x - s.pos.x, pos.z - s.pos.z) < s.radius && Math.abs(pos.y - s.pos.y) < 2;
  }

  async load() {
    const g = await new GLTFLoader().loadAsync('/models/c4.glb');
    this.model = g.scene; this.model.visible = false;
    this.model.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = true;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        m.envMapIntensity = 0.5;
        if (m.name === 'c4_led') { this.led = m; m.emissiveIntensity = 0; m.toneMapped = false; }
        if (m.name === 'c4_lcd') { this.lcd = m; m.emissiveIntensity = 0.9; }
      }
    });
    this.scene.add(this.model);
    return this;
  }

  reset() {
    this.planted = false; this.exploded = false; this.defused = false; this.timer = BOMB_TIME; this.beepT = 0;
    this.defusing = false; this.defuseT = 0; this.planting = false; this.plantT = 0; this.dropped = false; this.botDefuseT = 0;
    if (this.model) this.model.visible = false;
    this._ledLight();
    state.player.defusing = false; state.player.defuseProgress = 0; state.player.planting = false; state.player.plantProgress = 0;
  }

  /** The carrier died: the C4 lies where he fell (visible, on the radar). Nothing picks it up in this build; see Round. */
  drop(pos) {
    if (this.planted) return;
    state.player.hasBomb = false; this.dropped = true;
    this.position.copy(pos);
    const floor = this.game.map.collider.geometry.boundsTree.raycastFirst(new THREE.Ray(_v2.copy(pos).setY(pos.y + 1), new THREE.Vector3(0, -1, 0)), THREE.DoubleSide);
    if (floor) this.position.y = floor.point.y + 0.002;
    if (this.model) { this.model.position.copy(this.position); this.model.rotation.set(0, Math.random() * Math.PI * 2, 0); this.model.visible = true; }
    state.bomb.state = 'dropped'; state.bomb.carrier = null; state.bomb.position = this.position.clone();
  }

  /** LED parameters: small warm-red glow just above the C4 (off until it blinks). */
  _ledLight() { this.light.color.setHex(0xff3020); this.light.distance = 3; this.light.decay = 2; this.light.intensity = 0; }

  plant(pos, yaw) {
    if (this.planted || state.phase === 'over') return;
    this.planted = true; this.timer = BOMB_TIME; this.beepT = 0;
    // sit on the floor, nudged forward of the planter, random-ish yaw
    this.position.copy(pos);
    const f = _v.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    this.position.addScaledVector(f, 0.45);
    const floor = this.game.map.collider.geometry.boundsTree.raycastFirst(new THREE.Ray(_v2.copy(this.position).setY(this.position.y + 1), new THREE.Vector3(0, -1, 0)), THREE.DoubleSide);
    if (floor) this.position.y = floor.point.y + 0.002;
    if (this.model) { this.model.position.copy(this.position); this.model.rotation.set(0, yaw + (Math.random() - 0.5) * 0.8, 0); this.model.visible = true; }
    this._ledLight(); this.light.position.copy(this.position).add(new THREE.Vector3(0, 0.25, 0));
    state.bomb.state = 'planted'; state.bomb.position = this.position.clone(); state.bombTime = BOMB_TIME;
    state.phase = 'planted';
    bus.emit(Events.SOUND, { id: 'c4_plant', pos: this.position.clone() });
  }

  /** CS2 beep cadence: interval shrinks from ~1 s to ~0.1 s over the timer; LED blinks with the beep. */
  update(dt) {
    if (this.exploded) { this.light.intensity *= Math.exp(-dt * 6); if (this.light.intensity < 0.05) this.light.intensity = 0; }
    if (!this.planted) this._updatePlant(dt);
    if (!this.planted || this.exploded || this.defused) return;
    this.timer -= dt; state.bombTime = Math.max(0, this.timer);
    const frac = 1 - this.timer / BOMB_TIME;
    const interval = Math.max(0.1, 1.0 - 0.95 * frac * frac);
    this.beepT -= dt;
    if (this.beepT <= 0) { this.beepT = interval; this.ledOn = 0.09; bus.emit(Events.SOUND, { id: 'c4_beep', pos: this.position.clone(), rate: 1 / interval }); }
    this.ledOn -= dt;
    const on = this.ledOn > 0;
    if (this.led) this.led.emissiveIntensity = on ? 6 : 0.15;
    this.light.intensity = on ? 1.6 : 0;
    this._updateDefuse(dt);
    if (this.timer <= 0) this.explode();
  }

  /**
   * The player plants: carrying the C4, alive, round live, standing inside the zone, hold E for 3.2 s (release = cancel,
   * progress resets like CS2). The weapon holsters and movement freezes through state.player.planting (same paths as the
   * defuse). Completion goes through BOMB_PLANTED so the announcer, HUD alert, radar and this.plant() all fire as for a bot.
   */
  _updatePlant(dt) {
    const g = this.game, p = g.player, inp = g.input;
    const can = state.player.hasBomb && state.player.alive && inp.enabled && state.phase === 'live' && this.inPlantZone(p.position);
    state.bomb.canPlant = can;
    const want = can && inp.down('KeyE');
    if (want && !this.planting) { this.planting = true; this.plantT = 0; bus.emit(Events.BOMB_PLANT_START, { player: true, pos: p.position.clone() }); bus.emit(Events.SOUND, { id: 'c4_plant', pos: p.position.clone() }); }
    else if (!want && this.planting) { this.planting = false; this.plantT = 0; }
    if (this.planting) {
      this.plantT += dt;
      if (this.plantT >= PLANT_TIME) {
        this.planting = false; state.player.hasBomb = false;
        bus.emit(Events.BOMB_PLANTED, { player: true, pos: p.position.clone(), yaw: p.yaw });
      }
    }
    state.player.planting = this.planting; state.player.plantProgress = this.planting ? this.plantT / PLANT_TIME : 0; state.player.plantTime = PLANT_TIME;
    state.bomb.plantProgress = this.planting ? this.plantT / PLANT_TIME : state.bomb.plantProgress;
  }

  /**
   * A CT bot defuses (no kit: 10 s). Called per frame by Bot._defuse while it stands at the C4; `bot` is recorded as the
   * defuser for the MVP line. Interrupted by the bot itself (it re-enters the fight) -- it simply stops calling this.
   */
  botDefuse(bot, dt) {
    if (!this.planted || this.defused || this.exploded) return false;
    if (state.bomb.defuser !== bot.name) { state.bomb.defuser = bot.name; this.botDefuseT = 0; bus.emit(Events.BOMB_DEFUSE_START, { bot, kit: false }); bus.emit(Events.SOUND, { id: 'c4_defuse_start', pos: this.position.clone() }); }
    this.botDefuseT += dt;
    if (this.botDefuseT >= Bomb.BOT_DEFUSE_TIME) { this.defuse(); return true; }
    return false;
  }
  /** The bot let go (took damage, saw the player): progress resets, as in CS2. */
  botDefuseStop(bot) { if (state.bomb.defuser === bot.name) { state.bomb.defuser = null; this.botDefuseT = 0; bus.emit(Events.BOMB_DEFUSE_STOP, { bot }); } }
  get botDefuseProgress() { return state.bomb.defuser ? (this.botDefuseT || 0) / Bomb.BOT_DEFUSE_TIME : 0; }

  _updateDefuse(dt) {
    const g = this.game, p = g.player, inp = g.input;
    let can = false;
    if (state.player.alive && inp.enabled && state.side !== 't') {   // a T does not defuse his own bomb
      const eye = p.getEye(_v), to = _v2.copy(this.position).sub(eye); to.y += 0.06;
      const hdist = Math.hypot(to.x, to.z); to.normalize();
      const look = g.camera.getWorldDirection(new THREE.Vector3());
      can = hdist < 1.7 && look.dot(to) > 0.45 && Math.abs(p.position.y - this.position.y) < 1.3;
    }
    state.bomb.canDefuse = can;
    const want = can && inp.down('KeyE');
    if (want && !this.defusing) { this.defusing = true; this.defuseT = 0; bus.emit(Events.BOMB_DEFUSE_START, { kit: true }); bus.emit(Events.SOUND, { id: 'c4_defuse_start', pos: this.position.clone() }); }
    else if (!want && this.defusing) { this.defusing = false; this.defuseT = 0; bus.emit(Events.BOMB_DEFUSE_STOP, {}); }
    if (this.defusing) {
      this.defuseT += dt;
      if (this.defuseT >= DEFUSE_TIME) this.defuse();
    }
    state.player.defusing = this.defusing; state.player.defuseProgress = this.defusing ? this.defuseT / DEFUSE_TIME : 0; state.player.defuseTime = DEFUSE_TIME;
  }

  defuse() {
    this.defused = true; this.defusing = false; state.player.defusing = false;
    if (this.led) this.led.emissiveIntensity = 0; if (this.lcd) this.lcd.emissiveIntensity = 0;
    this.light.intensity = 0;
    state.bomb.state = 'defused';
    bus.emit(Events.SOUND, { id: 'c4_disarmed', pos: this.position.clone() });
    bus.emit(Events.BOMB_DEFUSED, { pos: this.position.clone() });
  }

  explode() {
    this.exploded = true; this.defusing = false; state.player.defusing = false;
    state.bomb.state = 'exploded';
    if (this.model) this.model.visible = false;
    const pos = this.position.clone();
    // the LED light becomes the blast flash: warm, wide, decays in update()
    this.light.color.setHex(0xffb060); this.light.distance = 60; this.light.decay = 1.2;
    this.light.position.copy(pos).add(new THREE.Vector3(0, 2.5, 0)); this.light.intensity = 900;
    this.game.impacts.explosion(pos);
    // round result first ("Target bombed"), then the blast damage (a player killed by it must not read as "CTs eliminated")
    const pdist = this.game.player.position.distanceTo(pos), pk = THREE.MathUtils.clamp(1 - pdist / 60, 0.15, 1);
    bus.emit(Events.SOUND, { id: 'c4_explode', pos, dist: pdist });
    bus.emit(Events.BOMB_EXPLODED, { pos, dist: pdist, k: pk });
    // damage: player (no LOS check; C4 goes through walls in CS) + bots
    const dmgAt = (p) => { const d = Math.max(0, p.distanceTo(pos) - 0.6); return d >= BLAST_RADIUS ? 0 : BLAST_DAMAGE * Math.pow(1 - d / BLAST_RADIUS, 1.6); };
    const pd = dmgAt(this.game.player.position);
    if (pd > 0) this.game.combat.damagePlayer({ amount: pd, dir: this.game.player.position.clone().sub(pos).normalize(), attacker: 'C4', weapon: 'c4', part: 'chest', armorPen: 1 });
    for (const b of this.game.bots.bots) {
      if (!b.alive) continue;
      const d = dmgAt(b.position);
      if (d > 0) b.takeDamage({ amount: d, part: 'chest', dir: b.position.clone().sub(pos).normalize(), point: b.position.clone().setY(b.position.y + 1), shooter: 'C4', weapon: 'c4', headshot: false });
    }
    // player-side shake scaled by distance (the HUD flash listens to BOMB_EXPLODED)
    this.game.player.shake = Math.max(this.game.player.shake || 0, 0.06 * pk);
  }
}
Bomb.BOT_DEFUSE_TIME = 10;     // CT bots carry no kit: 10 s at the C4 (the player, with a kit, takes DEFUSE_TIME)
Bomb.PLANT_TIME = PLANT_TIME;
