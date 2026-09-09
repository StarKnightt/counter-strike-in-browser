import * as THREE from 'three';
import { PLAYER } from '../core/Constants.js';
import { bus, Events } from '../core/EventBus.js';
import { state } from '../core/GameState.js';

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _box = new THREE.Box3(), _seg = new THREE.Line3();
const _tp = new THREE.Vector3(), _cp = new THREE.Vector3(), _start0 = new THREE.Vector3(), _delta = new THREE.Vector3();
const _wish = new THREE.Vector3();                            // per-frame wish direction (scratch: no allocation in update)
const _ray = new THREE.Raycaster(); _ray.far = 3;
const U = 0.01905;   // metres per Source unit
// CS2 movement (sv_accelerate 5.5, sv_friction 5.2, sv_stopspeed 80, sv_airaccelerate 12 with the 30 u/s air wish cap, 0.25 s duck).
// Kept here rather than in core/Constants.PLAYER (GROUND_ACCEL / GROUND_FRICTION / AIR_ACCEL there are superseded by these).
const MOVE = { ACCEL: 5.5, FRICTION: 5.2, STOP_SPEED: 80 * U, AIR_ACCEL: 12, AIR_WISH: 30 * U, DUCK_TIME: 0.25, TAG_RECOVER: 1.0 };

/**
 * First-person player: capsule swept against the map BVH, Quake/CS-style ground movement,
 * crouch, walk, jump, stairs, footsteps. Feet position is `this.position`.
 */
export class Player {
  constructor(camera, map, input) {
    this.camera = camera; this.map = map; this.input = input;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.height = PLAYER.HEIGHT; this.eye = PLAYER.EYE_HEIGHT;
    this.grounded = false; this.wasGrounded = false;
    this.crouching = false; this.walking = false;
    this.strideAcc = 0;
    this.landDip = 0;           // camera dip after landing
    this._fallSpeed = 0;
    this.bobT = 0;
    this.weapon = 'ak47';
    this.surface = 'concrete';
    this.enabled = false;
    this.noclip = false;                    // cheats.noclip(): free fly, no gravity / collision
    this.viewPunch = new THREE.Vector2();   // flinch when hit (Combat pushes it), decays here
    this.recoilView = new THREE.Vector2();  // camera share of the weapon aim punch (Weapons writes it every frame; yaw, pitch in rad)
    this.lastMouse = new THREE.Vector2();   // this frame's raw mouse delta (viewmodel sway)
    this.tag = 1;                           // tagging: max-speed multiplier after being shot (Combat sets it, recovers here)
    this.speedScale = 1;                    // weapon max-speed multiplier (AWP scoped = 0.5)
    this.duck = 0;                          // 0 standing .. 1 fully crouched (0.25 s ramp)
  }

  spawn(pos, yawDeg = 0) {
    this.position.copy(pos); this.velocity.set(0, 0, 0);
    this.yaw = THREE.MathUtils.degToRad(yawDeg); this.pitch = 0;
    this.grounded = true; this.deadT = 0; this.deathRoll = 0; this.deathLook = null; this.eye = PLAYER.EYE_HEIGHT; this.height = PLAYER.HEIGHT; this.shake = 0;
    this.updateCamera();
  }

  get maxSpeed() {
    let s = PLAYER.SPEED[this.weapon] ?? PLAYER.SPEED.ak47;
    if (this.crouching) s *= PLAYER.CROUCH_MULT; else if (this.walking) s *= PLAYER.WALK_MULT;
    return s * this.speedScale * this.tag;
  }
  get hSpeed() { return Math.hypot(this.velocity.x, this.velocity.z); }
  /** 0..1 fraction of max run speed (weapons use this for movement inaccuracy). */
  get speedFrac() { return Math.min(1, this.hSpeed / (PLAYER.SPEED[this.weapon] ?? 4.1)); }

  getForward(out = new THREE.Vector3()) { return out.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)); }
  getRight(out = new THREE.Vector3()) { return out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)); }
  getEye(out = new THREE.Vector3()) { return out.copy(this.position).add(_v.set(0, this.eye - this.landDip, 0)); }

  update(dt) {
    if (!state.player.alive) { this._deathCam(dt); return; }
    this.deadT = 0; this.deathRoll = 0;
    if (!this.enabled) return;
    const inp = this.input;

    // --- look
    const { dx, dy } = inp.consumeMouse();
    this.lastMouse.set(dx, dy);
    this.yaw -= dx * inp.sensitivity;
    this.pitch -= dy * inp.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.55, 1.55);
    // flinch view punch decays back (Combat pushes it); tagging wears off
    this.viewPunch.multiplyScalar(Math.exp(-dt * 9));
    this.tag = Math.min(1, this.tag + dt * MOVE.TAG_RECOVER);
    if (this.noclip) { this._fly(dt); return; }

    // --- stance: CS2 ducks in 0.25 s (linear ramp, eased eye). Keys live in Input.BINDS (Shift = crouch, Ctrl = walk).
    this.crouching = inp.action('crouch');
    this.walking = inp.action('walk') && !this.crouching;
    this.duck = THREE.MathUtils.clamp(this.duck + (this.crouching ? dt : -dt) / MOVE.DUCK_TIME, 0, 1);
    const de = this.duck * this.duck * (3 - 2 * this.duck);
    this.height = PLAYER.HEIGHT + (PLAYER.CROUCH_HEIGHT - PLAYER.HEIGHT) * this.duck;
    this.eye = PLAYER.EYE_HEIGHT + (PLAYER.CROUCH_EYE - PLAYER.EYE_HEIGHT) * de;
    state.player.crouching = this.crouching; state.player.walking = this.walking;

    // --- wish direction (yaw frame)
    const f = this.getForward(_v), r = this.getRight(_v2);
    const wish = _wish.set(0, 0, 0);
    if (inp.down('KeyW')) wish.add(f); if (inp.down('KeyS')) wish.sub(f);
    if (inp.down('KeyD')) wish.add(r); if (inp.down('KeyA')) wish.sub(r);
    if (state.player.defusing || state.player.planting || state.phase === 'over') wish.set(0, 0, 0);   // frozen while defusing / planting / after the round
    const hasWish = wish.lengthSq() > 0; if (hasWish) wish.normalize();
    const wishSpeed = this.maxSpeed;

    // --- ground / air movement (Source accelerate + friction with stopspeed; that's the CS feel)
    if (this.grounded) {
      const sp = this.hSpeed;
      if (sp > 0.01) {
        // releasing the keys: below sv_stopspeed the friction acts as if at stopspeed, so the last bit of speed dies off
        // linearly (crisp stops). Not while steering — a 73 u/s crouch-walk could never overcome the 80 u/s stop friction.
        const control = hasWish ? sp : Math.max(sp, MOVE.STOP_SPEED);
        const drop = control * MOVE.FRICTION * dt;
        const ns = Math.max(sp - drop, 0) / sp;
        this.velocity.x *= ns; this.velocity.z *= ns;
      } else { this.velocity.x = 0; this.velocity.z = 0; }
      if (hasWish) this._accelerate(wish, wishSpeed, MOVE.ACCEL, dt);
      if (inp.justPressed('Space') && !state.player.defusing && !state.player.planting && state.phase !== 'over') {
        this.velocity.y = PLAYER.JUMP_SPEED;
        this.grounded = false;
        bus.emit(Events.PLAYER_FOOTSTEP, { surface: this.surface, kind: 'jump', pos: this.position.clone() });
      }
    } else {
      if (hasWish) this._accelerate(wish, Math.min(wishSpeed, MOVE.AIR_WISH), MOVE.AIR_ACCEL, dt); // air strafing: sv_airaccelerate 12, 30 u/s wish cap
    }
    // gravity always (split around the integration so the jump arc is frame-rate independent); on the ground the
    // collider cancels it (keeps the capsule pressed to the floor)
    this.velocity.y -= PLAYER.GRAVITY * dt * 0.5;

    // --- integrate + collide (substeps keep stairs/corners stable)
    const steps = 3; const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.position.addScaledVector(this.velocity, sdt);
      this._collide(sdt);
    }
    this.velocity.y -= PLAYER.GRAVITY * dt * 0.5;
    if (this.position.y < -30) { this.position.y = 5; this.velocity.set(0, 0, 0); } // fell out of world safety

    // --- landing dip + footsteps
    if (this.grounded && !this.wasGrounded) {
      this.landDip = Math.min(0.14, 0.03 + Math.abs(this._fallSpeed) * 0.012);
      bus.emit(Events.PLAYER_FOOTSTEP, { surface: this.surface, kind: 'land', pos: this.position.clone() });
    }
    this._fallSpeed = this.velocity.y;
    this.landDip *= Math.exp(-dt * 10);
    this.wasGrounded = this.grounded;

    if (this.grounded && this.hSpeed > 0.8) {
      this.strideAcc += this.hSpeed * dt;
      const stride = PLAYER.STRIDE * (this.crouching ? 0.75 : 1);
      if (this.strideAcc >= stride) {
        this.strideAcc = 0;
        this._probeSurface();
        bus.emit(Events.PLAYER_FOOTSTEP, { surface: this.surface, kind: 'step', quiet: this.walking || this.crouching, pos: this.position.clone() });
      }
      this.bobT += dt * (this.hSpeed / 4.1) * 9.5;
    } else { this.strideAcc = Math.min(this.strideAcc, PLAYER.STRIDE * 0.6); }

    this.updateCamera();
  }

  /**
   * Dead: CS2 death cam. Hold the last view ~0.3 s, then ease out over 1 s to a spot 0.8 m up / 1.5 m back
   * (pulled in if it would clip a wall), turning to face the killer, then hold. No roll, no floor drop.
   */
  _deathCam(dt) {
    if (!this.deadT) {
      this.deadT = 0;
      this.deathFrom = { yaw: this.yaw, pitch: this.pitch, eye: this.eye, pos: this.position.clone() };
      // pull-back point along the reverse view direction, clipped against the map
      const back = new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
      const head = this.position.clone().setY(this.position.y + this.eye);
      const target = head.clone().addScaledVector(back, 1.5); target.y += 0.8;
      const dir = target.clone().sub(head), len = dir.length(); dir.normalize();
      const hit = this.map.collider.geometry.boundsTree.raycastFirst(new THREE.Ray(head, dir), THREE.DoubleSide);
      if (hit && hit.distance < len + 0.25) target.copy(head).addScaledVector(dir, Math.max(0.2, hit.distance - 0.25));
      this.deathTo = target;
      // face the killer if we know where they are, else keep looking ahead and slightly down
      let yaw = this.yaw, pitch = -0.2;
      if (this.deathLook) {
        const d = this.deathLook.clone().setY(this.deathLook.y + 1.2).sub(target);
        yaw = Math.atan2(-d.x, -d.z); pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
        let dy = yaw - this.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy)); yaw = this.yaw + dy;   // shortest turn
      }
      this.deathYaw = yaw; this.deathPitch = THREE.MathUtils.clamp(pitch, -25 * Math.PI / 180, 0.35);
    }
    this.deadT += dt;
    const k = THREE.MathUtils.clamp((this.deadT - 0.3) / 1.0, 0, 1), e = 1 - Math.pow(1 - k, 3);   // ease-out cubic
    const f = this.deathFrom;
    this.yaw = f.yaw + (this.deathYaw - f.yaw) * e;
    this.pitch = f.pitch + (this.deathPitch - f.pitch) * e;
    const head = f.pos.clone().setY(f.pos.y + f.eye).lerp(this.deathTo, e);
    this.velocity.set(0, 0, 0); this.deathRoll = 0;
    this.camera.position.copy(head);
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }

  /**
   * Noclip (cheat): fly along the view direction, no gravity, no collision. Space/Ctrl = up/down, Shift = 3x
   * (Input.BINDS flyUp/flyDown/flyFast). The stance block above is skipped in noclip, so Shift never crouches here.
   */
  _fly(dt) {
    const inp = this.input, cp = Math.cos(this.pitch);
    const f = _v.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp), r = this.getRight(_v2);
    const wish = _wish.set(0, 0, 0);
    if (inp.down('KeyW')) wish.add(f); if (inp.down('KeyS')) wish.sub(f);
    if (inp.down('KeyD')) wish.add(r); if (inp.down('KeyA')) wish.sub(r);
    if (inp.action('flyUp')) wish.y += 1; if (inp.action('flyDown')) wish.y -= 1;
    if (wish.lengthSq() > 0) wish.normalize();
    const speed = 8 * (inp.action('flyFast') ? 3 : 1);
    this.velocity.copy(wish).multiplyScalar(speed);
    this.position.addScaledVector(this.velocity, dt);
    this.grounded = true; this.crouching = false; this.walking = false; this.landDip = 0;
    this.duck = 0; this.height = PLAYER.HEIGHT; this.eye = PLAYER.EYE_HEIGHT;   // stance reset: a half-finished duck must not freeze the eye height
    this.updateCamera();
  }

  _accelerate(wish, wishSpeed, accel, dt) {
    const cur = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    const a = Math.min(accel * dt * wishSpeed, add);
    this.velocity.x += wish.x * a; this.velocity.z += wish.z * a;
  }

  /** Push the capsule out of the merged map collider (three-mesh-bvh shapecast). */
  _collide(dt) {
    const collider = this.map.collider;
    const R = PLAYER.RADIUS;
    _seg.start.copy(this.position).addScaledVector(UP, R);
    _seg.end.copy(this.position).addScaledVector(UP, this.height - R);
    _box.makeEmpty(); _box.expandByPoint(_seg.start); _box.expandByPoint(_seg.end);
    _box.min.addScalar(-R); _box.max.addScalar(R);

    _start0.copy(_seg.start);
    collider.geometry.boundsTree.shapecast({
      intersectsBounds: (box) => box.intersectsBox(_box),
      intersectsTriangle: (tri) => {
        const dist = tri.closestPointToSegment(_seg, _tp, _cp);
        if (dist < R) {
          const depth = R - dist;
          const dir = _cp.sub(_tp).normalize();
          _seg.start.addScaledVector(dir, depth);
          _seg.end.addScaledVector(dir, depth);
        }
      },
    });

    const delta = _delta.subVectors(_seg.start, _start0);
    // grounded if we were pushed up more than a fraction of what gravity moved us this step
    this.grounded = this.velocity.y <= 0.1 && delta.y > Math.abs(dt * this.velocity.y * 0.25);
    const len = delta.length();
    if (len > 1e-6) {
      const off = Math.max(0, len - 1e-5);
      delta.multiplyScalar(off / len);
      this.position.add(delta);
      if (this.grounded) {
        // kill downward velocity, keep horizontal sliding
        if (this.velocity.y < 0) this.velocity.y = 0;
      } else {
        // slide: remove velocity into the surface
        const n = delta.normalize();
        this.velocity.addScaledVector(n, -n.dot(this.velocity));
      }
    }
  }

  _probeSurface() {
    _ray.set(_v.copy(this.position).addScaledVector(UP, 0.4), new THREE.Vector3(0, -1, 0));
    const h = this.map.raycast(_ray);
    if (h) this.surface = h.surface;
  }

  updateCamera() {
    const eye = this.getEye(this.camera.position);
    // subtle CS-like bob (tiny; most feel comes from weapon sway in system 3)
    const bob = this.grounded && this.hSpeed > 0.8 ? Math.sin(this.bobT) * 0.008 * (this.hSpeed / 4.1) : 0;
    eye.y += bob;
    // explosion shake: decaying random jitter (set by Bomb)
    this.shake = (this.shake || 0) * 0.93;
    const sh = this.shake > 0.0005 ? this.shake : 0;
    this.camera.rotation.set(0, 0, 0, 'YXZ');
    this.camera.rotation.y = this.yaw + this.viewPunch.x + this.recoilView.x + (Math.random() - 0.5) * sh;
    this.camera.rotation.x = this.pitch + this.viewPunch.y + this.recoilView.y + (Math.random() - 0.5) * sh;
    this.camera.rotation.z = Math.sin(this.bobT * 0.5) * 0.0025 * (this.grounded && this.hSpeed > 0.8 ? 1 : 0) + (Math.random() - 0.5) * sh * 0.6 + (this.deathRoll || 0);
  }
}
