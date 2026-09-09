import * as THREE from 'three';

/** Debug free-fly camera (used for map review screenshots; not part of gameplay). */
export class FlyCamera {
  constructor(camera, dom) {
    this.camera = camera; this.dom = dom;
    this.yaw = 0; this.pitch = 0; this.speed = 8;
    this.keys = {};
    this.enabled = false;
    addEventListener('keydown', e => this.keys[e.code] = true);
    addEventListener('keyup', e => this.keys[e.code] = false);
    dom.addEventListener('mousemove', e => {
      if (!this.enabled || document.pointerLockElement !== dom) return;
      this.yaw -= e.movementX * 0.0022; this.pitch -= e.movementY * 0.0022;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -1.5, 1.5);
    });
  }
  setView(x, y, z, yawDeg, pitchDeg) {
    this.camera.position.set(x, y, z);
    this.yaw = THREE.MathUtils.degToRad(yawDeg); this.pitch = THREE.MathUtils.degToRad(pitchDeg);
    this.apply();
  }
  apply() { this.camera.rotation.set(0, 0, 0); this.camera.rotateY(this.yaw); this.camera.rotateX(this.pitch); }
  update(dt) {
    if (!this.enabled) return;
    const f = new THREE.Vector3(0, 0, -1).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const r = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
    const v = new THREE.Vector3();
    if (this.keys.KeyW) v.add(f); if (this.keys.KeyS) v.sub(f);
    if (this.keys.KeyD) v.add(r); if (this.keys.KeyA) v.sub(r);
    if (this.keys.Space) v.y += 1; if (this.keys.ControlLeft) v.y -= 1;
    const sp = this.speed * (this.keys.ShiftLeft ? 3 : 1);
    this.camera.position.addScaledVector(v, sp * dt);
    this.apply();
  }
}
