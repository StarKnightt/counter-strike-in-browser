// Frame-rate probe at 1080p: measures fps at several viewpoints with post FX on and off.
import { chromium } from 'playwright';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--disable-gpu-vsync'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto('http://localhost:5188/');
await page.waitForFunction(() => window.__game && window.__game.bots, null, { timeout: 90000 });
await page.evaluate(() => { document.getElementById('overlay')?.classList.add('hidden'); window.__game.botsInFly = true; });
const views = { site: [4, 1.6, -1, 80, 2], long: [-52, 1.6, -10, -90, 2], goose: [10, 1.6, -6, -140, 4], ct: [6, -1.9, 36, 15, 5] };
for (const post of [true, false]) {
  await page.evaluate((p) => { window.__game.post.enabled = p; }, post);
  const out = [];
  for (const [n, v] of Object.entries(views)) {
    await page.evaluate((v) => window.__view(...v), v);
    await page.waitForTimeout(1500);
    const fps = await page.evaluate(() => new Promise((res) => { let n = 0; const t0 = performance.now(); const tick = () => { n++; if (performance.now() - t0 > 1500) res(Math.round(n * 1000 / (performance.now() - t0))); else requestAnimationFrame(tick); }; requestAnimationFrame(tick); }));
    out.push(`${n}:${fps}`);
  }
  console.log(post ? 'post ON ' : 'post OFF', out.join('  '), 'pixelRatio', await page.evaluate(() => window.__game.renderer.getPixelRatio()));
}
await browser.close();
