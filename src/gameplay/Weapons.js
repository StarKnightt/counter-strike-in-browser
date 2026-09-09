import * as THREE from 'three';
import { WEAPONS } from './WeaponDefs.js';
import { RENDER, PLAYER } from '../core/Constants.js';
import { bus, Events } from '../core/EventBus.js';
import { state } from '../core/GameState.js';

const D2R = Math.PI / 180;
const _ray = new THREE.Raycaster(); _ray.far = 400;
const _dir = new THREE.Vector3(), _origin = new THREE.Vector3(), _tmp = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YXZ');
const lerp = THREE.MathUtils.lerp, clamp = THREE.MathUtils.clamp;
const MELEE_HULL = 0.3;      // knife hull-sweep half-width (m): CS2 head_hull ±16u; see _meleeTrace
/** Zero-deviation table used when a def carries no `inacc` (see the `inacc` getter). */
const NO_INACC = Object.freeze({ stand: 0, crouch: 0, move: 0, jumpInitial: 0, jump: 0, fire: 0, spread: 0, recoverStand: 0.3, recoverStandFinal: 0.3, recoverCrouch: 0.3, recoverCrouchFinal: 0.3, transition: [2, 5] });

/**
 * Player weapon logic: inventory, firing, reload, switching, AWP scope, knife. Drives the ViewModel and emits WEAPON_FIRE / HIT.
 *
 * Recoil is modelled the CS2 way:
 *  - `aimPunch` (deg) accumulates the weapon's spray pattern while firing. Bullets leave along eye angles + full aim punch;
 *    the camera shows eye angles + viewTrack (45 %, view_recoil_tracking) of it, so the HUD crosshair stays put and the
 *    bullets visibly climb above it. After the last shot the punch recovers fast (exp 8/s + 18°/s, weapon_recoil_decay2_*),
 *    the pattern index resets after `recoilReset` (weapon_recoil_cooldown 0.55 s).
 *  - Inaccuracy = accuracy penalty (stance / movement / air base + per-shot `fire` penalty, the excess decaying 10x per
 *    recovery time) + fixed `spread`; both are tangent radii of a disk, sampled uniformly in radius like Source (centre-biased).
 *  - ADS (def.ads, AK only, hold RMB): `ads` 0..1 eased blend that Game (FOV), ViewModel (pose), Input (sensitivity),
 *    Player (speed) and the accuracy code read. Not a scope: firing keeps it, reload / switch drop it.
 */
export class Weapons {
  constructor(game) {
    this.game = game; this.player = game.player; this.input = game.input; this.vm = game.vm; this.map = game.map;
    this.shells = game.shells;
    this.inv = {
      ak47: { mag: WEAPONS.ak47.mag, reserve: WEAPONS.ak47.reserve },
      awp: { mag: WEAPONS.awp.mag, reserve: WEAPONS.awp.reserve },
      knife: {},
    };
    this.current = 'ak47'; this.last = 'knife';
    this.state = 'drawing'; this.timer = WEAPONS.ak47.drawTime; this.cooldown = 0;
    this.recoilIdx = 0;          // shots fired in the current spray (pattern index of the next bullet)
    this.sinceShot = 9;
    this.penalty = 0;            // current inaccuracy (tangent units), base + decaying fire penalty
    this.aimPunch = new THREE.Vector2();   // degrees; x = pattern right (+), y = up (+)
    this._viewActive = false;
    this.scope = 0;              // 0 none, 1, 2
    this.rescope = 0;            // AWP: zoom level to return to after the bolt cycle
    this.adsT = 0;               // aim-down-sights (AK, hold RMB): linear 0..1 over def.ads.time
    this.ads = 0;                // eased blend the camera FOV / viewmodel pose / sensitivity / speed / accuracy follow
    this.hittables = [];         // objects with raycast(ray) => {distance, point, normal, entity, part}
    this.fovTarget = RENDER.FOV;
    this.vm.setActive(this.current); this.vm.play('draw', WEAPONS.ak47.drawTime);
    this._muzzleLight = new THREE.PointLight(0xffb060, 0, 6, 2); game.scene.add(this._muzzleLight);
    state.player.weapon = this.current; this.player.weapon = this.current;
  }

  /** New round: full ammo, AK out. */
  resetLoadout() {
    this.inv.ak47 = { mag: WEAPONS.ak47.mag, reserve: WEAPONS.ak47.reserve };
    this.inv.awp = { mag: WEAPONS.awp.mag, reserve: WEAPONS.awp.reserve };
    this.current = 'ak47'; this.last = 'knife'; this.state = 'drawing'; this.timer = WEAPONS.ak47.drawTime; this.scope = 0; this.rescope = 0;
    this.recoilIdx = 0; this.penalty = 0; this.aimPunch.set(0, 0); this.adsT = this.ads = 0;
    this.vm.setActive(this.current); this.vm.play('draw', WEAPONS.ak47.drawTime); this.vm.hidden = false;
    state.player.weapon = this.current; this.player.weapon = this.current;
  }

  /** Current weapon def; falls back to the AK when `current` is momentarily unset (the frame must never throw, see update). */
  get def() { return WEAPONS[this.current] ?? WEAPONS.ak47; }
  get ammo() { return this.inv[this.current] ?? this.inv.ak47; }

  /** Main camera FOV for the current scope level / ADS blend (Game applies it). */
  get fov() {
    if (this.scope) return this.def.zoom[this.scope - 1];
    const a = this.def.ads;
    return a && this.ads > 0 ? lerp(RENDER.FOV, a.fov, this.ads) : RENDER.FOV;
  }
  /** ADS in progress: Game applies `fov` exactly (already eased) so the camera and the viewmodel pose stay in step; the AWP keeps its own snappy blend. */
  get fovSnap() { return !this.scope && this.ads > 0; }
  /** CS2 zoom_sensitivity_ratio 1: sensitivity scales by (zoomed fov / 90) in CS2's FOV units; ADS by its fov ratio the same way. */
  get sensScale() {
    if (this.scope) return this.def.zoomSens?.[this.scope - 1] ?? this.fov / RENDER.FOV;
    const a = this.def.ads;
    return a && this.ads > 0 ? lerp(1, a.fov / RENDER.FOV, this.ads) : 1;
  }
  /** Max-speed multiplier of the current mode: AWP scoped (zoomSpeed) or the ADS blend (ads.speed). */
  get speedMult() {
    const def = this.def;
    if (def.scoped && this.scope) return def.zoomSpeed ?? 1;
    return def.ads ? lerp(1, def.ads.speed, this.ads) : 1;
  }
  /** Share of the aim punch the camera follows (CS2 view_recoil_tracking 0.45); ADS tracks more so the sight visibly kicks. */
  get viewTrack() { const def = this.def, vt = def.viewTrack ?? 0.45; return def.ads ? lerp(vt, def.ads.viewTrack ?? vt, this.ads) : vt; }
  /**
   * Inaccuracy table for the current mode (AWP: scoped values while zoomed). A def without one (a half-edited WeaponDefs.js
   * once froze the game on frame 1 this way) gets the zero table and a single warning instead of an exception.
   */
  get inacc() {
    const def = this.def, t = (def.scoped && this.scope && def.inaccScoped) || def.inacc;
    if (t) return t;
    if (!Weapons._warnedInacc?.has(this.current)) { (Weapons._warnedInacc ||= new Set()).add(this.current); console.warn(`Weapons: def '${this.current}' has no inacc table; using zero inaccuracy`); }
    return NO_INACC;
  }

  /** Quick-switch: the previous weapon holsters instantly, firing is blocked until the new one is drawn. */
  switchTo(id) {
    if (!WEAPONS[id] || id === this.current) return;
    this.last = this.current; this.current = id;
    this.state = 'drawing'; this.timer = WEAPONS[id].drawTime; this.scope = 0; this.rescope = 0; this.adsT = this.ads = 0;
    this.vm.setActive(id); this.vm.play('draw', WEAPONS[id].drawTime);
    this.player.weapon = id; state.player.weapon = id;
    this.recoilIdx = 0; this.penalty = 0;
    bus.emit(Events.WEAPON_SWITCH, { weapon: id });
  }

  update(dt) {
    const inp = this.input, p = this.player;
    if (!WEAPONS[this.current]) { this.current = 'ak47'; state.player.weapon = p.weapon = 'ak47'; this.vm.setActive('ak47'); }   // never let a bad id take the frame down
    const def = this.def;
    if (!state.player.alive) { this.vm.hidden = true; return; }
    this.vm.hidden = false;

    // weapon selection
    if (inp.justPressed('Digit1')) this.switchTo('ak47');
    if (inp.justPressed('Digit2')) this.switchTo('awp');
    if (inp.justPressed('Digit3')) this.switchTo('knife');
    if (inp.justPressed('KeyQ')) this.switchTo(this.last);
    if (inp.wheel) { const order = ['ak47', 'awp', 'knife']; const i = order.indexOf(this.current); this.switchTo(order[(i + (inp.wheel > 0 ? 1 : 2)) % 3]); }

    // timers
    this.cooldown -= dt; this.sinceShot += dt;
    if (this.state !== 'idle') {
      this.timer -= dt;
      if (this.timer <= 0) {
        const was = this.state; this.state = 'idle';
        if (was === 'reloading') { const a = this.ammo; const need = def.mag - a.mag; const take = Math.min(need, a.reserve); a.mag += take; a.reserve -= take; }
        if (was === 'bolting' && def.scoped) {
          // bolt cycled: empty mag reloads, otherwise the AWP returns to the zoom level it fired from
          if (this.ammo.mag === 0 && this.ammo.reserve > 0) this._reload();
          else if (this.rescope) { this.scope = this.rescope; bus.emit(Events.SOUND, { id: 'zoom', pos: null }); }
          this.rescope = 0;
        }
      }
    }

    // --- recoil: pattern index resets after a pause; aim punch holds while spraying, then recovers fast
    if (this.sinceShot > (def.recoilReset ?? 0.55)) this.recoilIdx = 0;
    const punchActive = this.aimPunch.lengthSq() > 1e-8;
    if (punchActive && this.sinceShot > (def.punchHold ?? 0.15)) {
      // exponential + linear tail (per-def `punchDecay`, default exp 6/s + 10°/s: an AWP shot is back on the crosshair
      // ~0.4 s after firing; the AK's slower 5/s + 2°/s puts a 3-4 round burst back in ~0.41-0.47 s, CS2 tap timing)
      const decay = def.punchDecay;
      this.aimPunch.multiplyScalar(Math.exp(-dt * (decay?.exp ?? 6)));
      const len = this.aimPunch.length(), nl = Math.max(0, len - (decay?.lin ?? 10) * dt);
      this.aimPunch.multiplyScalar(len > 1e-6 ? nl / len : 0);
    }

    // --- accuracy penalty: jumps up to the stance/movement base instantly, decays back toward it over the recovery time.
    // CS2 (UpdateAccuracyPenalty): decay factor ln(10)/recoveryTime, i.e. the excess drops 10x per recovery time, not e-fold
    if (!def.melee) {
      const base = this._baseInaccuracy();
      this.penalty = this.penalty <= base ? base : base + (this.penalty - base) * Math.exp(-dt * Math.LN10 / this._recoveryTime());
    }

    // actions (none while defusing / planting or after the round)
    if (this.state === 'idle' && !state.player.defusing && !state.player.planting && state.phase !== 'over') {
      if (def.melee) {
        if (inp.mouseJustPressed(0)) this._melee('primary');
        else if (inp.mouseJustPressed(2)) this._melee('secondary');
      } else {
        const a = this.ammo;
        if (inp.justPressed('KeyR') && a.mag < def.mag && a.reserve > 0) this._reload();
        else if (def.scoped && inp.mouseJustPressed(2)) { this.scope = (this.scope + 1) % 3; bus.emit(Events.SOUND, { id: 'zoom', pos: null }); }
        const wantFire = def.auto ? inp.mouse(0) : inp.mouseJustPressed(0);
        if (wantFire && this.cooldown <= 0) {
          if (a.mag > 0) this._fire();
          else if (inp.mouseJustPressed(0)) { bus.emit(Events.SOUND, { id: 'dryfire' }); if (a.reserve > 0) this._reload(); }
        }
      }
    }

    // muzzle light decay
    this._muzzleLight.intensity *= Math.exp(-dt * 40);

    // --- ADS (AK): held RMB while the weapon is usable; reloading / drawing drop it (it comes back if RMB is still held
    // afterwards), firing and jumping keep it. Linear time -> smoothstep, so both directions ease over def.ads.time.
    if (def.ads && !def.melee) {
      const want = inp.mouse(2) && this.state === 'idle' && !state.player.defusing && !state.player.planting && state.phase !== 'over';
      this.adsT = clamp(this.adsT + (want ? dt : -dt) / (def.ads.time ?? 0.18), 0, 1);
      const t = this.adsT; this.ads = t * t * (3 - 2 * t);
    } else if (this.adsT) this.adsT = this.ads = 0;

    // scope / ADS: FOV target (Game blends the camera), scoped AWP walks at half speed, ADS at ads.speed
    this.fovTarget = this.fov;
    p.speedScale = this.speedMult;
    state.player.scoped = this.scope;
    state.player.ads = this.ads;
    state.player.ammo = def.melee ? null : { mag: this.ammo.mag, reserve: this.ammo.reserve };
    state.player.reloading = this.state === 'reloading';

    // view kick: the camera follows viewTrack of the aim punch. Re-pose the camera now (Player already posed it this
    // frame) so a shot fired this frame kicks the view immediately rather than one frame late.
    const active = this.aimPunch.lengthSq() > 1e-8;
    if (active || this._viewActive) {
      const vt = this.viewTrack;
      p.recoilView?.set(-this.aimPunch.x * D2R * vt, this.aimPunch.y * D2R * vt);
      p.updateCamera();
    }
    this._viewActive = active;
  }

  _reload() {
    const def = this.def;
    this.state = 'reloading'; this.timer = def.reloadTime; this.scope = 0; this.rescope = 0;
    this.vm.play('reload', def.reloadTime);
    bus.emit(Events.WEAPON_RELOAD, { weapon: this.current, duration: def.reloadTime });
  }

  /** Is the player fully ducked (CS applies crouch accuracy only once the duck completes)? */
  _ducked() { const p = this.player; return p.crouching && (p.duck ?? 1) > 0.95; }

  /**
   * Stance / movement / air inaccuracy (tangent units), CS2 GetInaccuracy():
   * air: jumpInitial + jump * vertical-speed fraction (most accurate at the apex); ground: stand or crouch;
   * movement: remap(speed, 34 %..95 % of max) * move — walking linear, running on a ^0.25 curve (inaccurate almost at once).
   */
  _baseInaccuracy() {
    const p = this.player, inacc = this.inacc, def = this.def;
    let base;
    if (!p.grounded) base = inacc.jumpInitial + inacc.jump * clamp(Math.abs(p.velocity.y) / PLAYER.JUMP_SPEED, 0, 1);
    else base = (this._ducked() ? inacc.crouch : inacc.stand) * (def.ads ? lerp(1, def.ads.inacc ?? 1, this.ads) : 1);   // ADS bonus (AK x0.6)
    const maxS = def.speed * this.speedMult;
    let ms = clamp((p.hSpeed - 0.34 * maxS) / (0.95 * maxS - 0.34 * maxS), 0, 1);
    if (ms > 0) { if (!p.walking) ms = Math.pow(ms, 0.25); base += inacc.move * ms; }
    return base;
  }

  /** Penalty recovery time constant: initial -> final over spray bullets transition[0]..[1]; crouching recovers faster. */
  _recoveryTime() {
    const inacc = this.inacc, [a, b] = inacc.transition ?? [2, 5];
    const t = clamp((this.recoilIdx - a) / Math.max(1, b - a), 0, 1);
    return this._ducked() ? lerp(inacc.recoverCrouch, inacc.recoverCrouchFinal, t) : lerp(inacc.recoverStand, inacc.recoverStandFinal, t);
  }

  _fire() {
    const def = this.def, a = this.ammo, cam = this.game.camera, p = this.player, inacc = this.inacc;
    a.mag--; this.cooldown = 60 / def.rpm; this.sinceShot = 0;

    // --- direction: eye angles + full aim punch, plus the random inaccuracy + spread disks (tangent space, Source-style)
    const pat = def.pattern, n = pat.length, idx = Math.min(this.recoilIdx, n - 1);
    const r0 = Math.random() * this.penalty, t0 = Math.random() * Math.PI * 2, r1 = Math.random() * (inacc.spread ?? 0), t1 = Math.random() * Math.PI * 2;
    const ox = r0 * Math.cos(t0) + r1 * Math.cos(t1), oy = r0 * Math.sin(t0) + r1 * Math.sin(t1);
    _e.set(p.pitch + this.aimPunch.y * D2R, p.yaw - this.aimPunch.x * D2R, 0); _q.setFromEuler(_e);
    _dir.set(ox, oy, -1).normalize().applyQuaternion(_q);
    cam.getWorldPosition(_origin);

    // --- recoil: kick the aim punch by the next pattern step (the following bullet flies at pattern[idx+1]); penalty grows
    const cur = pat[idx], nxt = idx + 1 < n ? pat[idx + 1] : pat[n - 1], prv = idx + 1 < n ? cur : pat[n - 2];
    this.aimPunch.x += nxt[0] - prv[0]; this.aimPunch.y += nxt[1] - prv[1];
    this.recoilIdx = idx + 1;
    this.penalty += inacc.fire ?? 0;

    // --- hitscan
    const hit = this.raycast(_origin, _dir, 400);

    // --- FX
    this.vm.fire(def);
    const mz = this.vm.worldPos('Muzzle', _tmp);
    this._muzzleLight.position.copy(mz).addScaledVector(_dir, 0.12); this._muzzleLight.intensity = 30;   // world-side flash light: the nearby wall / floor for a frame (the handguard is lit by ViewModel.flashLight)
    if (this.shells) { const ej = this.vm.worldPos('Eject'); this.shells.eject(ej, cam.quaternion, p.position.y, def === WEAPONS.awp); }

    bus.emit(Events.WEAPON_FIRE, { weapon: this.current, def, origin: _origin.clone(), dir: _dir.clone(), muzzle: mz.clone(), hit, shooter: 'player' });
    if (hit) bus.emit(Events.HIT, { weapon: this.current, def, hit, shooter: 'player', origin: _origin.clone(), dir: _dir.clone() });

    if (def.scoped) { this.rescope = this.scope; this.scope = 0; this.state = 'bolting'; this.timer = def.boltTime; this.vm.play('bolt', def.boltTime); }
    if (a.mag === 0 && a.reserve > 0 && this.state === 'idle') setTimeout(() => { if (this.ammo.mag === 0 && this.state === 'idle') this._reload(); }, 250);
  }

  _melee(kind) {
    const def = this.def, spec = def[kind], cam = this.game.camera;
    this.state = 'swinging'; this.timer = spec.time; this.cooldown = spec.time;
    this.vm.play(kind === 'primary' ? 'slash' : 'stab', spec.time);
    cam.getWorldPosition(_origin); cam.getWorldDirection(_dir);
    const hit = this._meleeTrace(_origin, _dir, spec.range + 0.35);
    const origin = _origin.clone(), dir = _dir.clone();   // snapshot now: the shared temps may be rewritten before the delayed HIT
    bus.emit(Events.WEAPON_FIRE, { weapon: 'knife', def, kind, origin, dir, hit, shooter: 'player', melee: true });
    if (hit) setTimeout(() => bus.emit(Events.HIT, { weapon: 'knife', def, kind, hit, shooter: 'player', origin, dir, melee: true }), kind === 'primary' ? 80 : 350);
  }

  /**
   * Knife hit test, CS2 KnifeAttack style: a line trace first; when it reaches no body, a hull sweep (CS2 head_hull, 16u =
   * 0.3 m half-width) along the same line, so a body a little off the crosshair -- or one the player is standing in, where a
   * ray from inside the capsule finds nothing -- still takes the hit. A pure eye ray missed most swings at knife range: the
   * bot strafes / shoves itself off the player and the torso is only ±11° wide at 1 m. The world still blocks: a body only
   * counts when nothing solid is closer along the line.
   */
  _meleeTrace(origin, dir, far) {
    const line = this.raycast(origin, dir, far);
    if (line?.entity) return line;
    let best = null;
    for (const h of this.hittables) {
      const r = h.sweep?.(origin, dir, far, MELEE_HULL);
      if (r && (!best || r.distance < best.distance)) best = r;
    }
    return best && (!line || best.distance <= line.distance) ? best : line;
  }

  /** Nearest hit among map + registered hittables. */
  raycast(origin, dir, far) {
    _ray.set(origin, dir); _ray.far = far;
    let best = this.map.raycast(_ray);
    if (best) best = { distance: best.distance, point: best.point.clone(), normal: best.face?.normal.clone().transformDirection(best.object.matrixWorld) ?? new THREE.Vector3(0, 1, 0), surface: best.surface, entity: null, part: null };
    for (const h of this.hittables) {
      const r = h.raycast(_ray);
      if (r && (!best || r.distance < best.distance)) best = r;
    }
    return best;
  }
}
