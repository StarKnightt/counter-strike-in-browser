// Headless impact/decal/blood review shots.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5188/');
await page.waitForFunction(() => window.__game && window.__game.weapons, null, { timeout: 90000 });
await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  const g = window.__game; g.mode = 'play';
  Object.defineProperty(g.input, 'locked', { get: () => true });
  window.__hits = [];
  import('/src/core/EventBus.js').then(({ bus, Events }) => bus.on(Events.HIT, (e) => window.__hits.push({ s: e.hit.surface, part: e.hit.part, d: +e.hit.distance.toFixed(1) })));
  // dummy target entity: a capsule-ish sphere 6 m ahead at the plant zone
  const V3 = g.camera.position.constructor;
  const Sphere = g.map.collider.geometry.constructor; // placeholder to grab THREE via prototypes is awkward; use the shells mesh classes instead
  const M = g.shells.mesh; // InstancedMesh -> constructor chain gives Mesh
  const geo = new (M.geometry.constructor.prototype.constructor.__proto__.constructor)(); // BufferGeometry
  // simpler: clone a shell geometry and scale it up to a "body"
  const body = new (Object.getPrototypeOf(Object.getPrototypeOf(M)).constructor)(M.geometry.clone(), M.material.clone());
  body.material.color.setHex(0x8899aa); body.scale.set(45, 45, 45); // shell cylinder ~0.009 x 0.028 -> 0.4 x 1.3
  body.position.set(5, 0.65, -8); body.rotation.x = Math.PI / 2;
  g.scene.add(body); body.updateMatrixWorld(true);
  const dummy = { alive: true, hp: 100, armor: 100, helmet: true, name: 'dummy', forward: () => new V3(0, 0, -1), takeDamage(i) { this.hp -= i.amount; window.__dmg = (window.__dmg || []).concat([i.amount + ':' + i.part]); if (this.hp <= 0) this.alive = false; } };
  g.weapons.hittables.push({ raycast(ray) { const h = ray.intersectObject(body, false)[0]; if (!h) return null; return { distance: h.distance, point: h.point.clone(), normal: h.face.normal.clone().transformDirection(body.matrixWorld), entity: dummy, part: h.point.y > 1.1 ? 'head' : 'chest', surface: 'flesh' }; } });
  window.__dummy = dummy;
});
const tp = (x, y, z, yaw, pitch = 0) => page.evaluate(([x, y, z, yaw, pitch]) => { const p = window.__game.player; p.position.set(x, y, z); p.velocity.set(0, 0, 0); p.yaw = yaw * Math.PI / 180; p.pitch = pitch * Math.PI / 180; p.grounded = true; }, [x, y, z, yaw, pitch]);
const mouse = (btn, down) => page.evaluate(([b, d]) => { const el = document.getElementById('game'); el.dispatchEvent(new MouseEvent(d ? 'mousedown' : 'mouseup', { button: b, bubbles: true })); if (!d) window.dispatchEvent(new MouseEvent('mouseup', { button: b })); }, [btn, down]);
const shot = (n) => page.screenshot({ path: `_shots/h_${n}.jpg`, quality: 88 });

// 1) spray a wall (plaster) from 4 m
await tp(0, 0, 6, 0, 0); await page.waitForTimeout(1300);   // facing north toward the A sign wall? north wall at z=-14, 20 m away. Use the crate stack instead:
await tp(-3.5, 0, 3, -45, 0); await page.waitForTimeout(300); // look NE toward default crates (x 0..2.6, z -3..-4.3)
await mouse(0, true); await page.waitForTimeout(900); await mouse(0, false); await page.waitForTimeout(150); await shot('crates_spray');
// 2) ground dust: look down at the slab
await tp(0, 0, 0, 0, -35); await page.waitForTimeout(400); await mouse(0, true); await page.waitForTimeout(500); await mouse(0, false); await page.waitForTimeout(120); await shot('ground_dust');
// 3) barrels (metal) at long corner? barrels at goose: (11.5, 8) etc. Look from site.
await tp(6, 0, 2, -55, 0); await page.waitForTimeout(400); await mouse(0, true); await page.waitForTimeout(600); await mouse(0, false); await page.waitForTimeout(100); await shot('barrels_sparks');
// 4) dummy body: blood
await tp(5, 0, -4, 0, -14); await page.waitForTimeout(400); await mouse(0, true); await page.waitForTimeout(700); await mouse(0, false); await page.waitForTimeout(80); await shot('blood');
await page.waitForTimeout(1500); await shot('blood_after');
console.log(await page.evaluate(() => ({ hits: window.__hits.length, surfaces: [...new Set(window.__hits.map(h => h.s))], dmg: window.__dmg, dummyHp: window.__dummy.hp, fps: Math.round(window.__game.stats.fps) })));
console.log('errors', errors.slice(0, 5));
await browser.close();
