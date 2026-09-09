import * as THREE from 'three';

/** Pooled brass casings ejected into the world with simple gravity + floor bounce. */
export class Shells {
  constructor(scene, max = 48) {
    this.scene = scene; this.max = max;
    const geo = new THREE.CylinderGeometry(0.0045, 0.0045, 0.028, 8);
    geo.rotateX(Math.PI / 2);
    const mat = new THREE.MeshStandardMaterial({ color: 0xd4a84a, metalness: 1.0, roughness: 0.35 });
    this.mesh = new THREE.InstancedMesh(geo, mat, max);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false; this.mesh.castShadow = false;
    scene.add(this.mesh);
    this.items = Array.from({ length: max }, () => ({ alive: false, p: new THREE.Vector3(), v: new THREE.Vector3(), r: new THREE.Euler(), rv: new THREE.Vector3(), life: 0, floor: 0 }));
    this.next = 0;
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._s = new THREE.Vector3(1, 1, 1);
    this.onBounce = null;
  }

  eject(pos, camQuat, floorY, big = false) {
    const it = this.items[this.next]; this.next = (this.next + 1) % this.max;
    it.alive = true; it.life = 5; it.floor = floorY; it.bounced = false;
    it.p.copy(pos);
    // right + up + slightly back, in camera space
    it.v.set(2.2 + Math.random() * 1.2, 1.6 + Math.random() * 0.8, 0.6 + Math.random() * 0.6).applyQuaternion(camQuat);
    it.rv.set((Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * 30);
    it.r.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    it.scale = big ? 1.6 : 1;
  }

  update(dt) {
    for (let i = 0; i < this.max; i++) {
      const it = this.items[i];
      if (!it.alive) { this._m.makeScale(0, 0, 0); this.mesh.setMatrixAt(i, this._m); continue; }
      it.life -= dt; if (it.life <= 0) { it.alive = false; continue; }
      it.v.y -= 15.24 * dt; it.p.addScaledVector(it.v, dt);
      it.r.x += it.rv.x * dt; it.r.y += it.rv.y * dt; it.r.z += it.rv.z * dt;
      if (it.p.y < it.floor + 0.01) {
        it.p.y = it.floor + 0.01;
        if (Math.abs(it.v.y) > 0.6) {
          it.v.y = -it.v.y * 0.35; it.v.x *= 0.6; it.v.z *= 0.6; it.rv.multiplyScalar(0.5);
          if (!it.bounced) { it.bounced = true; this.onBounce?.(it.p); }
        } else { it.v.set(0, 0, 0); it.rv.set(0, 0, 0); it.r.x = Math.PI / 2 + (it.r.x % 0.2); }
      }
      this._q.setFromEuler(it.r);
      this._s.setScalar(it.scale * (it.life < 1 ? it.life : 1));
      this._m.compose(it.p, this._q, this._s);
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}
