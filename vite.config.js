import { defineConfig } from 'vite';

// GitHub Pages serves the site under https://starknightt.github.io/counter-strike-in-browser/, so the Pages build
// needs `base` set to that sub-path: `npm run build:pages` (= `vite build --base /counter-strike-in-browser/`) or
// GHPAGES=1 / BASE_PATH=/prefix/ in the environment. Local dev / plain `vite build` keep '/'.
const base = process.env.BASE_PATH || (process.env.GHPAGES ? '/counter-strike-in-browser/' : '/');

export default defineConfig({
  root: '.',
  base,
  publicDir: 'public',
  server: { port: 5188, strictPort: true, open: false },
  build: { outDir: 'dist', target: 'esnext' },
});
