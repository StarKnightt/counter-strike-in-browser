// Capture review screenshots of the running dev server from fixed viewpoints.
// usage: node tools/shots.mjs [outdir] [name=x,y,z,yaw,pitch ...]
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] || 'C:/Code/cs2-dust2/_shots';
fs.mkdirSync(out, { recursive: true });
const DEFAULT = {
  ramp_top: [13, 1.6, 13, 0, 0],
  site_to_long: [4, 1.6, -1, 80, 2],
  long_doors: [-52, 1.6, -10, -90, 2],
  short_plat: [-11, 4.1, 8.5, -30, -10],
  goose: [10, 1.6, -6, -140, 4],
  ct_spawn: [6, -1.9, 36, 15, 5],
  car: [-10, 1.6, -9, 95, 0],
  pit: [-13, 1.6, 3, 90, -10],
};
const views = {};
for (const a of process.argv.slice(3)) { const [n, v] = a.split('='); views[n] = v.split(',').map(Number); }
const V = Object.keys(views).length ? views : DEFAULT;

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.goto('http://localhost:5188/', { waitUntil: 'load' });
await page.waitForFunction(() => window.__game && window.__game.map, null, { timeout: 120000 });
await page.waitForTimeout(1500);
if (process.env.EVAL) { console.log('eval:', await page.evaluate(process.env.EVAL)); await page.waitForTimeout(300); }
for (const [name, [x, y, z, yaw, pitch]] of Object.entries(V)) {
  await page.evaluate(([x, y, z, yaw, pitch]) => window.__view(x, y, z, yaw, pitch), [x, y, z, yaw, pitch]);
  await page.waitForTimeout(700);
  const st = await page.evaluate(() => ({ fps: Math.round(window.__game.stats.fps), calls: window.__game.renderer.info.render.calls, tris: window.__game.renderer.info.render.triangles }));
  await page.screenshot({ path: path.join(out, name + '.jpg'), type: 'jpeg', quality: 88 });
  console.log(name, JSON.stringify(st));
}
if (errors.length) console.log('ERRORS:', errors.slice(0, 10));
await browser.close();
