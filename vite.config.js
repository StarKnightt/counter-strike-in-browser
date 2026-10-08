import { defineConfig } from 'vite';

// GitHub Pages serves the site under https://starknightt.github.io/counter-strike-in-browser/, so the Pages build
// needs `base` set to that sub-path: `npm run build:pages` (= `vite build --base /counter-strike-in-browser/`) or
// GHPAGES=1 / BASE_PATH=/prefix/ in the environment. Local dev / plain `vite build` keep '/'.
const base = process.env.BASE_PATH || (process.env.GHPAGES ? '/counter-strike-in-browser/' : '/');

// `--mode wavedash`: the Wavedash release ships under original names (see src/brand.js).
const wavedashHtml = {
  name: 'wavedash-html',
  transformIndexHtml: (html, ctx) =>
    ctx.server || process.env.VITE_WAVEDASH !== '1'
      ? html
      : html
          .replace(/<title>[^<]*<\/title>/, '<title>Site Hold</title>')
          .replace(/<span class="map">[\s\S]*?Defend A<\/span>/, '<span class="map">Dune Yard <span>A site</span> · Defender · Hold A</span>'),
};

export default defineConfig(({ mode }) => {
  if (mode === 'wavedash') process.env.VITE_WAVEDASH = '1';
  return {
  plugins: [wavedashHtml],
  root: '.',
  base,
  publicDir: 'public',
  server: { port: 5188, strictPort: true, open: false },
  build: { outDir: 'dist', target: 'esnext' },
  };
});
