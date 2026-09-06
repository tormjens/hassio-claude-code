import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// `base: './'` makes every asset URL relative, which is what lets the app run
// under the Home Assistant ingress prefix (/api/hassio_ingress/<token>/).
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8099',
      '/ws': { target: 'ws://localhost:8099', ws: true },
    },
  },
});
