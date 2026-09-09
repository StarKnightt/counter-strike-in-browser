import * as THREE from 'three';
import { bus, Events } from '../core/EventBus.js';
import { state } from '../core/GameState.js';

const PERIOD = 0.2;          // s between checks
const RANGE = 45;            // m
const RESPOT_AFTER = 4;      // s a bot must have been out of sight before it counts as spotted again
const CHEST = 1.3;           // m above the bot's feet

const _frustum = new THREE.Frustum(), _pv = new THREE.Matrix4(), _ray = new THREE.Ray(), _chest = new THREE.Vector3();

/**
 * Player-side perception: every 0.2 s, each alive T within 45 m and inside the view frustum gets one ray from the camera to
 * its chest through the map collider. A clear line to a bot that has not been visible for the last 4 s emits
 * PLAYER_SPOT { bot, distance, count } (count = bots visible this tick). Sfx turns that into the CT radio lines.
 * Runs only while the round is live/planted and the player is alive; nothing here touches the bots.
 */
export class Spotter {
  constructor(game) {
    this.game = game;
    this.t = 0;
    this.lastSeen = new Map();   // bot -> game time it was last in clear view
    bus.on(Events.ROUND_START, () => this.lastSeen.clear());
  }

  update(dt) {
    this.t += dt;
    if (this.t < PERIOD) return;
    this.t = 0;
    const g = this.game, bots = g.bots?.bots;
    if (!bots?.length || !state.player.alive || (state.phase !== 'live' && state.phase !== 'planted')) return;
    const cam = g.camera, bvh = g.map.collider.geometry.boundsTree, now = g.time;
    _frustum.setFromProjectionMatrix(_pv.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse));
    const eye = cam.position, visible = [];
    for (const b of bots) {
      if (!b.alive) continue;
      _chest.copy(b.position); _chest.y += CHEST;
      const d = _chest.distanceTo(eye);
      if (d > RANGE || d < 0.5 || !_frustum.containsPoint(_chest)) continue;
      _ray.origin.copy(eye); _ray.direction.copy(_chest).sub(eye).normalize();
      const hit = bvh.raycastFirst(_ray, THREE.DoubleSide, 0, d);
      if (hit && hit.distance < d - 0.4) continue;                       // wall / crate in the way
      visible.push([b, d]);
    }
    for (const [b, d] of visible) {
      const last = this.lastSeen.get(b);
      this.lastSeen.set(b, now);
      if (last === undefined || now - last > RESPOT_AFTER) bus.emit(Events.PLAYER_SPOT, { bot: b, distance: d, count: visible.length });
    }
  }
}
