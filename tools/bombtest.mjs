// System 6 test: plant -> beep -> explode (T win), plant -> defuse (CT win), end card. Screenshots in _shots/bomb.
import { chromium } from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('_shots/bomb', { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = (n) => page.screenshot({ path: `_shots/bomb/${n}.jpg`, quality: 88 });
const st = () => page.evaluate(() => { const s = window.__game.round && window.__state ? window.__state : null; return s; });

async function boot() {
  await page.goto('http://localhost:5188/');
  await page.waitForFunction(() => window.__game && window.__game.bots && window.__game.round, null, { timeout: 90000 });
  await page.evaluate(async () => {
    const g = window.__game; document.getElementById('overlay')?.classList.add('hidden');
    g.mode = 'play'; Object.defineProperty(g.input, 'locked', { get: () => true });
    window.__state = g.state; g.round.noAutoRestart = true;
    g.round.skipFreeze();
  });
  await page.waitForTimeout(200);
}

/** Park everyone but the carrier, put the carrier 3 m from the plant spot, player far away. */
async function forcePlant() {
  await page.evaluate(() => {
    const g = window.__game, s = window.__state;
    for (const b of g.bots.bots) { b.position.set(-40, 0, -10); b.stateT = -999; }
    const c = g.bots.bots.find((b) => b.hasBomb);
    const spot = g.bots.plantSpot;
    c.stateT = 0; c.position.set(spot.x + 2.5, spot.y, spot.z + 1.5); c.route = ['default']; c.pathIdx = 0; c._enter('advance');
    const p = g.player; p.position.copy(g.map.markers.spawnCT); p.velocity.set(0, 0, 0); p.yaw = Math.PI; p.pitch = 0;
    console.log('phase', s.phase, 'carrier', c.name);
  });
  await page.waitForFunction(() => window.__state.bomb.state === 'planted', null, { timeout: 20000 });
  // park the planter too so nobody shoots the player during the bomb checks
  await page.evaluate(() => { for (const b of window.__game.bots.bots) { b.position.set(-40, 0, -10); b.stateT = -999; b.aimWant = 0; } });
}

// ---------- A: plant, beep, explode
await boot();
await forcePlant();
console.log('planted at', await page.evaluate(() => window.__state.bomb.position));
// C4 close-up
await page.evaluate(() => { const g = window.__game, b = g.bomb.position; window.__view(b.x + 1.2, b.y + 0.9, b.z + 1.4, 40, -33); g.botsInFly = true; });
await page.waitForTimeout(400); await shot('c4_closeup');
// player POV standing near the site looking at the bomb (HUD planted indicator)
await page.evaluate(() => { const g = window.__game, b = g.bomb.position; window.__play(); const p = g.player; p.position.set(b.x + 4, b.y, b.z + 3); p.velocity.set(0, 0, 0); p.yaw = Math.atan2(-(b.x - p.position.x), -(b.z - p.position.z)); p.pitch = -0.25; });
await page.waitForTimeout(600); await shot('planted_pov');
// explosion: set the timer low and capture a wide view of the site
await page.evaluate(() => {
  const g = window.__game, b = g.bomb.position;
  const cx = 3, cz = 11, yaw = Math.atan2(-(b.x - cx), -(b.z - cz)) * 180 / Math.PI;
  window.__view(cx, b.y + 2.2, cz, yaw, -6); g.botsInFly = true; g.hud.noFlash = true;
  const p = g.player; p.position.copy(g.map.markers.spawnCT); g.bomb.timer = 0.6;
});
await page.waitForFunction(() => window.__state.bomb.state === 'exploded', null, { timeout: 5000 });
await page.waitForTimeout(90); await shot('explode_0');
await page.waitForTimeout(350); await shot('explode_1');
await page.waitForTimeout(1200); await shot('explode_2');
await page.waitForTimeout(2500); await shot('explode_3');
console.log('A result:', await page.evaluate(() => ({ phase: window.__state.phase, winner: window.__state.winner, why: window.__state.winReason, hp: window.__state.player.hp })));
await page.evaluate(() => { window.__play(); const g = window.__game, b = g.bomb.position, p = g.player; p.position.set(b.x + 6, b.y, b.z + 4); p.yaw = Math.atan2(-(b.x - p.position.x), -(b.z - p.position.z)); p.pitch = -0.2; });
await page.waitForTimeout(3500); await shot('endcard_T');

// ---------- B: plant, defuse
await boot();
await forcePlant();
await page.evaluate(() => {
  const g = window.__game, b = g.bomb.position, p = g.player;
  p.position.set(b.x + 1.1, b.y, b.z + 0.6); p.velocity.set(0, 0, 0);
  p.yaw = Math.atan2(-(b.x - p.position.x), -(b.z - p.position.z)); p.pitch = -0.75;
});
await page.waitForTimeout(300);
console.log('canDefuse', await page.evaluate(() => window.__state.bomb.canDefuse));
await shot('defuse_hint');
await page.keyboard.down('KeyE');
await page.waitForTimeout(2200); await shot('defusing');
console.log('progress', await page.evaluate(() => window.__state.player.defuseProgress.toFixed(2)));
await page.waitForFunction(() => window.__state.phase === 'over', null, { timeout: 8000 });
await page.keyboard.up('KeyE');
console.log('B result:', await page.evaluate(() => ({ winner: window.__state.winner, why: window.__state.winReason })));
await page.waitForTimeout(3500); await shot('endcard_CT');
// restart
await page.mouse.click(800, 450);
await page.waitForTimeout(300);
console.log('after restart:', await page.evaluate(() => ({ phase: window.__state.phase, bomb: window.__state.bomb.state, carrier: window.__state.bomb.carrier, alive: window.__game.bots.alive.length, c4vis: window.__game.bomb.model.visible })));
console.log('errors', errors);
await browser.close();
