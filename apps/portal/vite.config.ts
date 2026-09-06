import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The partner & customer portal — a separate, deliberately small bundle. External users
 * download only this; the internal app's JavaScript (its screens, field names, routes)
 * never reaches them. Built under /portal-app/ so its assets cannot collide with the
 * internal app's when the API serves both from one container, by hostname.
 */
export default defineConfig(({ command }) => ({
  // Only the built assets live under /portal-app/ (the API serves index.html at the
  // portal host's root). In dev Vite would apply the base to the page too, so it is
  // build-only; routes are the same, /sign-in and friends, in both.
  base: command === 'build' ? '/portal-app/' : '/',
  plugins: [react(), tailwindcss()],
  server: {
    port: 5175,
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false },
}));
