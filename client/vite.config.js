import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // GitHub Pages serves project sites under /<repo>/ — the deploy workflow sets VITE_BASE=/credit-tracker/
  base: process.env.VITE_BASE || '/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.VITE_PROXY_TARGET || 'http://localhost:8787',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
