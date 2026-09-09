// Headless bot AI review: watch the T push from fixed cameras (watch), close-ups (closeup), or a duel (fight).
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5188/');
await page.waitForFunction(() => window.__game && window.__game.bots, null, { timeout: 90000 });
await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  const g = window.__game; g.botsInFly = true;
  window.__ev = [];
  for (const k of ['BOT_CALLOUT', 'BOT_SHOOT', 'BOT_DEATH', 'PLAYER_DAMAGE', 'BOMB_PLANT_START', 'BOMB_PLANTED', 'KILL'])
    g.bus.on(g.Events[k], (e) => window.__ev.push({ k, t: +g.time.toFixed(1), name: e.bot?.name || e.name || e.victim, txt: e.text, hit: e.hitPlayer, amt: e.amount, part: e.part }));
});
const view = (x, y, z, yaw, pitch) => page.evaluate(([x, y, z, yaw, pitch]) => window.__view(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
const shot = (n) => page.screenshot({ path: `_shots/b_${n}.jpg`, quality: 88 });
const bots = () => page.evaluate(() => window.__game.bots.bots.map((b) => `${b.name}:${b.state}:${b.hp}@${b.position.toArray().map((v) => v.toFixed(0)).join(',')}`).join('  '));
const summary = async () => {
  const ev = await page.evaluate(() => window.__ev);
  const c = {}; for (const e of ev) c[e.k] = (c[e.k] || 0) + 1;
  console.log('events', JSON.stringify(c), 'hits on player', ev.filter((e) => e.k === 'BOT_SHOOT' && e.hit).length);
  console.log(ev.filter((e) => e.k !== 'BOT_SHOOT').slice(0, 30).map((e) => `${e.t}s ${e.k} ${e.name || ''} ${e.txt || ''} ${e.amt ?? ''} ${e.part || ''}`).join('\n'));
};

const mode = process.argv[2] || 'watch';
if (mode === 'watch') {
  await view(-20, 1.8, -12, 90, 0);           // at car looking down long toward T
  await page.waitForTimeout(2500); await shot('long_push_1'); console.log(await bots());
  await page.waitForTimeout(3500); await shot('long_push_2'); console.log(await bots());
  await view(6, 3.5, 6, 60, -12);             // above site looking toward long corner / barrels
  await page.waitForTimeout(4000); await shot('site_arrive'); console.log(await bots());
  await view(13, 1.8, 13, 0, -2);             // ramp top view of site
  await page.waitForTimeout(5000); await shot('site_plant'); console.log(await bots());
  await view(-9, 2.2, -13, -135, -8);         // barrels looking across site
  await page.waitForTimeout(6000); await shot('site_hold'); console.log(await bots());
} else if (mode === 'closeup') {
  const follow = async (name, dist, ang, h, n) => {
    await page.evaluate(([name, dist, ang, h]) => { const b = window.__game.bots.bots.find((x) => x.name === name); const a = b.yaw + ang * Math.PI / 180; const x = b.position.x - Math.sin(a) * dist, z = b.position.z - Math.cos(a) * dist; const yaw = Math.atan2(-(b.position.x - x), -(b.position.z - z)) * 180 / Math.PI; window.__view(x, b.position.y + h, z, yaw, -Math.atan2(h - 1.0, dist) * 180 / Math.PI); }, [name, dist, ang, h]);
    await page.waitForTimeout(150); await shot(n);
  };
  await page.waitForTimeout(3000);
  await follow('Cliffe', 3.5, 20, 1.6, 'close_front');
  await follow('Ryan', 4, 150, 1.5, 'close_back');
  await page.waitForTimeout(4000);
  await follow('Chet', 4, -60, 1.4, 'close_side');
  await page.waitForTimeout(6000);
  for (let i = 0; i < 3; i++) { console.log(await bots()); await page.waitForTimeout(2000); }
  await follow('Ryan', 4, 30, 1.6, 'close_ryan_late');
  await follow('Chet', 4, 30, 1.6, 'close_chet_late');
} else if (mode === 'death') {
  // close-range: bot teleported 6 m in front of the player; watch engage pose, then the kill
  await page.evaluate(() => { const g = window.__game; g.mode = 'play'; Object.defineProperty(g.input, 'locked', { get: () => true }); });
  await page.evaluate(() => {
    const g = window.__game, p = g.player; p.position.set(3, 0, 7); p.velocity.set(0, 0, 0); p.yaw = 90 * Math.PI / 180; p.pitch = 0;
    for (const b of g.bots.bots) { b.position.set(-40, 0, -10); b.stateT = -999; }     // park the others far away
    const b = g.bots.bots[1]; b.stateT = 0; b.position.set(-3.5, 0, 7.2); b.yaw = b.aimYaw = -Math.PI / 2; b.route = ['site_s']; b.pathIdx = 0; b._enter('advance');
    window.__b = b;
  });
  await page.waitForTimeout(900); await shot('death_engage');
  await page.waitForTimeout(700); await shot('death_engage2');
  console.log('bot', await page.evaluate(() => `${window.__b.state} crouch=${window.__b.crouch.toFixed(2)} hp=${window.__b.hp}`));
  console.log('player', await page.evaluate(async () => JSON.stringify((await import('/src/core/GameState.js')).state.player)));
  await page.evaluate(() => { const g = window.__game, b = window.__b; b.die(new (b.position.constructor)(-1, 0, 0), 'player', 'ak47', false); });
  await page.waitForTimeout(150); await shot('death_1');
  await page.waitForTimeout(250); await shot('death_2');
  await page.waitForTimeout(500); await shot('death_3');
  await page.waitForTimeout(1500); await shot('death_4');
} else {
  // duel: player holds ramp top looking at site; bots arrive and engage; player returns fire
  await page.evaluate(() => { const g = window.__game; g.mode = 'play'; Object.defineProperty(g.input, 'locked', { get: () => true }); });
  // player holds site_s facing the long corner; every bot route passes through his view
  await page.evaluate(() => { const p = window.__game.player; p.position.set(3, 0, 7); p.velocity.set(0, 0, 0); p.yaw = 75 * Math.PI / 180; p.pitch = 0; });
  const aimAtNearest = () => page.evaluate(() => {
    const g = window.__game, p = g.player; const alive = g.bots.bots.filter((x) => x.alive && x.seesPlayer); if (!alive.length) return null;
    const b = alive.sort((a, c) => a.position.distanceTo(p.position) - c.position.distanceTo(p.position))[0];
    const e = p.getEye(p.position.clone()); const t = b.position.clone(); t.y += 1.35; const dx = t.x - e.x, dy = t.y - e.y, dz = t.z - e.z;
    p.yaw = Math.atan2(-dx, -dz); p.pitch = Math.atan2(dy, Math.hypot(dx, dz)); return b.name;
  });
  const fire = (ms) => page.evaluate((ms) => { const el = document.getElementById('game'); el.dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true })); setTimeout(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 0 })), ms); }, ms);
  let shotsTaken = 0, killed = false;
  for (let i = 0; i < 16; i++) {
    await page.waitForTimeout(1500);
    const b = await bots(); console.log(`t+${((i + 1) * 1.5).toFixed(1)}s`, b);
    const target = await aimAtNearest();
    if (target) {
      if (shotsTaken === 0) await shot('fight_contact');
      await fire(260); shotsTaken++;                                 // ~3-round tap
      await page.waitForTimeout(120); if (shotsTaken === 2) await shot('fight_tap');
      console.log('  aimed at', target, 'ammo', await page.evaluate(() => `${window.__game.weapons.ammo.mag} state=${window.__game.weapons.state} down=${[...window.__game.input.mouseDown]}`));
      const dead = await page.evaluate(() => window.__game.bots.bots.filter((x) => !x.alive).map((x) => x.name));
      if (dead.length && !killed) { killed = true; await page.waitForTimeout(350); await shot('fight_kill'); await page.waitForTimeout(900); await shot('fight_corpse'); }
    }
  }
  await shot('fight_end');
  console.log('player', await page.evaluate(async () => JSON.stringify((await import('/src/core/GameState.js')).state.player)));
  console.log('bomb', await page.evaluate(async () => JSON.stringify((await import('/src/core/GameState.js')).state.bomb)));
}
await summary();
console.log('fps', await page.evaluate(() => Math.round(window.__game.stats.fps)), 'errors', errors.slice(0, 6));
await browser.close();
