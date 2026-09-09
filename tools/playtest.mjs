// Headless controller test: drives the player with synthetic key events and reports positions.
import { chromium } from 'playwright';

const URL = process.env.URL || 'http://localhost:5188/';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await page.goto(URL);
await page.waitForFunction(() => window.__game && window.__game.map, null, { timeout: 60000 });
await page.evaluate(() => {
  document.getElementById('overlay')?.classList.add('hidden');
  const g = window.__game; g.mode = 'play';
  // bypass pointer lock for headless testing
  Object.defineProperty(g.input, 'locked', { get: () => true });
  window.__steps = []; g.player.__dbg = true;
  import('/src/core/EventBus.js').then(({ bus, Events }) => bus.on(Events.PLAYER_FOOTSTEP, (e) => window.__steps.push(e.kind + ':' + e.surface)));
});
const P = () => page.evaluate(() => { const p = window.__game.player; return { x: +p.position.x.toFixed(2), y: +p.position.y.toFixed(2), z: +p.position.z.toFixed(2), g: p.grounded, v: +p.hSpeed.toFixed(2), h: +p.height.toFixed(2), eye: +p.eye.toFixed(2) }; });
const key = async (code, down) => page.evaluate(([c, d]) => window.dispatchEvent(new KeyboardEvent(d ? 'keydown' : 'keyup', { code: c })), [code, down]);
const hold = async (codes, ms) => { for (const c of codes) await key(c, true); await page.waitForTimeout(ms); for (const c of codes) await key(c, false); };
const look = async (yawDeg, pitchDeg = 0) => page.evaluate(([y, p]) => { const pl = window.__game.player; pl.yaw = y * Math.PI / 180; pl.pitch = p * Math.PI / 180; }, [yawDeg, pitchDeg]);
const tp = async (x, y, z, yaw = 0) => page.evaluate(([x, y, z, yaw]) => { const pl = window.__game.player; pl.position.set(x, y, z); pl.velocity.set(0, 0, 0); pl.yaw = yaw * Math.PI / 180; }, [x, y, z, yaw]);

console.log('spawn', await P());
await hold(['KeyW'], 1500); console.log('after W 1.5s', await P());
await page.waitForTimeout(400); console.log('stopped', await P());
// run at a wall: CT spawn east wall at x=16
await look(-90); await hold(['KeyW'], 3000); console.log('into east wall (x should stop ~15.6)', await P());
// jump
await tp(6, -3.5, 36, 0); await page.evaluate(() => window.__game.player.grounded = true); await page.waitForTimeout(200);
await key('Space', true); await page.waitForTimeout(50); await key('Space', false);
let maxY = -99; for (let i = 0; i < 20; i++) { await page.waitForTimeout(50); const p = await P(); maxY = Math.max(maxY, p.y); }
console.log('jump apex dy=', (maxY + 3.5).toFixed(2), 'landed', await P());
// crouch
await hold(['ControlLeft'], 600); console.log('crouch held 0.6s (h/eye should be ~1.25/1.08)', await P());
await page.waitForTimeout(500); console.log('uncrouched', await P());
// stairs: A ramp is at x -8..-4, z 6..11 (Blender y -11..-6), from y=-1.0 up to 2.5; approach from the west at y=-0.5
await tp(-2, 0.05, 8.5, 90); await hold(['KeyW'], 3500); console.log('climbed stairs west (y should be 2.5, x < -8)', await P());
await tp(-10, 2.55, 8.5, -90); await hold(['KeyW'], 3000); console.log('descended stairs east (y 0, x > -4)', await P());
await tp(-11, 0.05, 0, 0); await hold(['KeyW'], 1500); console.log('elbow step (y should be 0.3, z < -2)', await P());
await tp(13, -3.4, 27, 0); await hold(['KeyW'], 5000); console.log('up the ramp (y should be 0, z < 12)', await P());
// ramp (Blender long ramp?) walk site slab -> long: from site (0,0,-5) heading west along x
await tp(0, 0, -5, 90); await hold(['KeyW'], 2500); console.log('walked west across site', await P());
console.log('footsteps', await page.evaluate(() => window.__steps.slice(0, 12)));
const fps = await page.evaluate(() => window.__game.stats?.fps);
console.log('fps', fps);
await page.screenshot({ path: '_shots/playtest.jpg', quality: 85 });
await browser.close();
