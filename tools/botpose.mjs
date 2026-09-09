// Deterministic bot pose review: idle / run / aim / crouch-aim / death, from fixed cameras.
import { chromium } from 'playwright';
const tag = process.argv[2] || 'p';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5188/');
await page.waitForFunction(() => window.__game && window.__game.bots, null, { timeout: 90000 });
await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  const g = window.__game; g.botsInFly = false;   // freeze AI; we pose by hand
  for (const b of g.bots.bots) { b.position.set(-58, 0, -10); b.group.position.copy(b.position); }
  window.__pose = (idx, x, z, yaw, o) => {
    const b = g.bots.bots[idx]; b.position.set(x, 0, z); b.group.position.copy(b.position); b.yaw = yaw; b.aimYaw = yaw + (o.rel || 0); b.aimPitch = o.pitch || 0;
    b.group.rotation.set(0, yaw, 0); b.realSpeed = o.speed || 0; b.walkT = o.walkT ?? 0; b.aimWant = o.aim || 0; b.crouchWant = o.crouch || 0;
    b.moveBlend = o.speed ? 1 : 0; b.aimBlend = o.aim || 0; b.crouch = o.crouch || 0; b._animate(0.0001);
  };
});
if (process.env.EVAL) console.log('eval:', await page.evaluate(process.env.EVAL));
const view = (x, y, z, yaw, pitch) => page.evaluate(([x, y, z, yaw, pitch]) => window.__view(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
const shot = async (n) => { await page.waitForTimeout(250); if (process.env.EVAL) await page.evaluate(process.env.EVAL); await page.waitForTimeout(100); await page.screenshot({ path: `_shots/bot/${tag}_${n}.jpg`, quality: 88 }); };
const pose = (idx, x, z, yaw, o) => page.evaluate(([idx, x, z, yaw, o]) => window.__pose(idx, x, z, yaw, o), [idx, x, z, yaw, o]);
// stage on Long (open ground): bot at (-40,0,-10) facing +x (yaw -90deg); cameras: front-3/4, side, front
const B = [-40, -10], YAW = -Math.PI / 2;
const camF34 = () => view(-36.8, 1.45, -8.2, 61, -6);
const camSide = () => view(-40, 1.3, -13.6, 180, -4);
const camFront = () => view(-36.6, 1.4, -10, 90, -5);

// 1) idle low-ready, three bots side by side with different heads
await pose(0, -40, -10, YAW, {}); await pose(1, -40, -8.6, YAW, {}); await pose(2, -40, -11.4, YAW, {}); await pose(3, -40, -7.2, YAW, {});
await view(-35.5, 1.5, -9.3, 95, -6); await shot('lineup');
await camF34(); await shot('idle_f34');
await pose(1, -58, -8.6, YAW, {}); await pose(2, -58, -11.4, YAW, {}); await pose(3, -58, -7.2, YAW, {});
// 2) run frames
await pose(0, -40, -10, YAW, { speed: 4.1, walkT: 0.9 }); await camSide(); await shot('run_side_a');
await pose(0, -40, -10, YAW, { speed: 4.1, walkT: 2.5 }); await shot('run_side_b');
await camF34(); await shot('run_f34');
// 3) aim standing (bladed: body yaw off by -0.3, aim toward camera)
await pose(0, -40, -10, YAW - 0.3, { aim: 1, rel: 0.3, pitch: -0.05 }); await camFront(); await shot('aim_front');
await camSide(); await shot('aim_side');
// 4) crouch aim
await pose(0, -40, -10, YAW - 0.3, { aim: 1, rel: 0.3, crouch: 1 }); await camF34(); await shot('crouch_f34');
await camSide(); await shot('crouch_side');
// 5) death sequence (kill it: bullets from +x side)
await page.evaluate(() => { const g = window.__game; g.botsInFly = true; const b = g.bots.bots[0]; b.stateT = 0; b.realSpeed = 0; b.aimWant = 1; b.die({ x: -1, y: 0, z: 0 }, 'player', 'ak47', false); for (const o of g.bots.bots.slice(1)) o.stateT = -999; });
await camF34();
await page.waitForTimeout(130); await page.screenshot({ path: `_shots/bot/${tag}_death_0.jpg`, quality: 88 });
await page.waitForTimeout(200); await page.screenshot({ path: `_shots/bot/${tag}_death_1.jpg`, quality: 88 });
await page.waitForTimeout(300); await page.screenshot({ path: `_shots/bot/${tag}_death_2.jpg`, quality: 88 });
await page.waitForTimeout(1200); await page.screenshot({ path: `_shots/bot/${tag}_death_3.jpg`, quality: 88 });
await view(-38, 2.4, -7.5, 39, -30); await page.waitForTimeout(250); await page.screenshot({ path: `_shots/bot/${tag}_death_top.jpg`, quality: 88 });
console.log('errors', errors.slice(0, 6));
await browser.close();
