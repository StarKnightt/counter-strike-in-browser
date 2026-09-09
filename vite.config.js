import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  server: { port: 5188, strictPort: true, open: false },
  build: { outDir: 'dist', target: 'esnext' },
});
