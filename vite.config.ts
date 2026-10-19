import { defineConfig } from 'vite';

export default defineConfig({
  base: './',                                   // works from any folder / GitHub Pages
  optimizeDeps: { exclude: ['@mujoco/mujoco'] }, // keep its .wasm next to the JS
  server: { host: true },                       // reachable from other PCs on the LAN
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
});
