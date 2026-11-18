import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: { outDir: 'dist/web', emptyOutDir: true, target: 'es2022' },
  server: { port: 4173, strictPort: true },
});
