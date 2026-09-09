// System 7 HUD review shots -> _shots/hud
import { chromium } from 'playwright';
import fs from 'node:fs';
fs.mkdirSync('_shots/hud', { recursive: true });
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const shot = async (n) => { console.log(n, await page.evaluate(() => window.__state && `${window.__state.phase} planted=${window.__game.bomb.planted} alive=${window.__state.player.alive}`)); return page.screenshot({ path: `_shots/hud/${n}.jpg`, quality: 88 }); };

await page.goto('http://localhost:5188/');
await page.waitForFunction(() => window.__game && window.__game.bots && window.__game.round, null, { timeout: 90000 });
await page.evaluate(async () => {
  const g = window.__game; document.getElementById('overlay')?.classList.add('hidden');
  g.mode = 'play'; Object.defineProperty(g.input, 'locked', { get: () => true }); g.round.noAutoRestart = true;
  window.__state = g.state;
});
await page.waitForTimeout(300); await shot('freeze');
{
  const t0 = Date.now();
  await page.waitForFunction(() => window.__game.hud.radar.baked, null, { timeout: 30000 });   // the height scan is sliced across idle time after the first frame
  console.log('bake ready +', Date.now() - t0, 'ms');
  const url = await page.evaluate(() => window.__game.hud.radar.bake.toDataURL('image/png'));
  fs.writeFileSync('_shots/hud/radar_bake.png', Buffer.from(url.split(',')[1], 'base64'));
}
await page.evaluate(() => {
  const g = window.__game; g.round.skipFreeze();
  // player on the site steps looking at the plaza; bots parked except two walking in
  const p = g.player; p.position.set(3, 0, 7); p.velocity.set(0, 0, 0); p.yaw = 75 * Math.PI / 180; p.pitch = 0;
  for (const b of g.bots.bots) { b.position.set(-40, 0, -10); b.stateT = -999; b._shoot = () => {}; }
  const b0 = g.bots.bots[0]; b0.stateT = 0; b0.position.set(-6, 0, 2); b0.yaw = b0.aimYaw = -Math.PI / 2; b0.route = ['site_s']; b0.pathIdx = 0; b0._enter('advance');
  const b3 = g.bots.bots[3]; b3.stateT = 0; b3.position.set(-9, 0, -4); b3.yaw = b3.aimYaw = -Math.PI / 2; b3.route = ['site_center']; b3.pathIdx = 0; b3._enter('advance');
});
await page.waitForTimeout(1500);
// events: a kill, a callout, damage from the right
await page.evaluate(() => {
  const g = window.__game, s = window.__state;
  const b = g.bots.bots[2]; b.position.set(-8, 0, 0); b.die(g.player.getForward(), 'player', 'ak47', true);
  g.combat.damagePlayer({ amount: 27, dir: g.player.getRight().negate(), attacker: 'Wolf', weapon: 'ak47', part: 'chest' });
  s.roundTime = 71;
});
await page.waitForTimeout(250); await shot('play');
await page.waitForTimeout(1200); await shot('play_2');
// AWP scoped
await page.evaluate(() => { const g = window.__game; g.weapons.switchTo('awp'); });
await page.waitForTimeout(1200);
await page.evaluate(() => { const g = window.__game; g.weapons.scope = 1; });
await page.waitForTimeout(400); await shot('scoped');
await page.evaluate(() => { const g = window.__game; g.weapons.scope = 0; g.weapons.switchTo('ak47'); });
// planted state
await page.evaluate(() => { const g = window.__game, s = window.__state; g.bus.emit(g.Events.BOMB_PLANTED, { bot: g.bots.bots[0], pos: g.bots.plantSpot.clone() }); });
await page.waitForTimeout(900); await shot('planted');
// death
await page.evaluate(() => { const g = window.__game; g.combat.damagePlayer({ amount: 500, dir: g.player.getForward().negate(), attacker: 'Cliffe', weapon: 'ak47', part: 'head' }); });
await page.waitForTimeout(200); await shot('death_0');
await page.waitForTimeout(700); await shot('death_1');
await page.waitForTimeout(1300); await shot('death_2');
await page.waitForTimeout(2500); await shot('end');
// icons sheet for review
await page.evaluate(() => { const g = window.__game; const d = document.createElement('div'); d.id = 'iconsheet'; d.style.cssText = 'position:fixed;left:300px;top:300px;background:#333;padding:10px;display:flex;gap:20px;z-index:99'; for (const [k, v] of Object.entries(g.hud.icons)) { const i = document.createElement('img'); i.src = v; i.style.height = '56px'; d.appendChild(i); } document.body.appendChild(d); });
await page.waitForTimeout(100); await page.screenshot({ path: '_shots/hud/icons.jpg', quality: 90, clip: { x: 290, y: 290, width: 700, height: 100 } });
console.log('state', await page.evaluate(() => ({ phase: window.__state.phase, winner: window.__state.winner, why: window.__state.winReason, feed: window.__state.killfeed.length })));
console.log('errors', errors);
await browser.close();
