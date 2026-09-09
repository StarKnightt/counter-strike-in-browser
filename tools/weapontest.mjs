// Headless weapon/viewmodel review shots.
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
  window.__fires = []; window.__hits = [];
  import('/src/core/EventBus.js').then(({ bus, Events }) => { bus.on(Events.WEAPON_FIRE, (e) => window.__fires.push(e)); bus.on(Events.HIT, (e) => window.__hits.push({ d: +e.hit.distance.toFixed(1), s: e.hit.surface })); });
});
const tp = (x, y, z, yaw, pitch = 0) => page.evaluate(([x, y, z, yaw, pitch]) => { const p = window.__game.player; p.position.set(x, y, z); p.velocity.set(0, 0, 0); p.yaw = yaw * Math.PI / 180; p.pitch = pitch * Math.PI / 180; p.grounded = true; }, [x, y, z, yaw, pitch]);
const key = (code) => page.evaluate((c) => { window.dispatchEvent(new KeyboardEvent('keydown', { code: c })); setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { code: c })), 40); }, code);
const mouse = (btn, down) => page.evaluate(([b, d]) => { const el = document.getElementById('game'); el.dispatchEvent(new MouseEvent(d ? 'mousedown' : 'mouseup', { button: b, bubbles: true })); if (!d) window.dispatchEvent(new MouseEvent('mouseup', { button: b })); }, [btn, down]);
const shot = (n) => page.screenshot({ path: `_shots/w_${n}.jpg`, quality: 88 });

await tp(13, 0.0, 12, 20, 2);          // ramp top looking at site
await page.waitForTimeout(1300); await shot('ak_idle');
// AK spray 10 shots, screenshot mid burst
await mouse(0, true); await page.waitForTimeout(330); await shot('ak_burst'); await page.waitForTimeout(700); await mouse(0, false);
await page.waitForTimeout(300);
const punch = await page.evaluate(() => ({ idx: window.__game.weapons.recoilIdx, fires: window.__fires.length, hits: window.__hits.slice(0, 12) }));
console.log('AK burst', punch.idx, punch.fires, 'hits', punch.hits.length, punch.hits.slice(0,3));
// reload mid-anim
await key('KeyR'); await page.waitForTimeout(700); await shot('ak_reload'); await page.waitForTimeout(2000);
// AWP
await key('Digit2'); await page.waitForTimeout(1400); await shot('awp_idle');
await mouse(2, true); await mouse(2, false); await page.waitForTimeout(400); await shot('awp_scoped');
await mouse(0, true); await mouse(0, false); await page.waitForTimeout(120); await shot('awp_fire'); await page.waitForTimeout(1300);
// knife
await key('Digit3'); await page.waitForTimeout(700); await shot('knife_idle');
await mouse(0, true); await mouse(0, false); await page.waitForTimeout(150); await shot('knife_slash');
const st = await page.evaluate(() => ({ fps: Math.round(window.__game.stats.fps), calls: window.__game.renderer.info.render.calls, ammo: window.__game.weapons.inv }));
console.log(st); console.log('errors', errors.slice(0, 5));
await browser.close();
