import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5174,
    // Dev only: the API runs on its own port. In production the API serves this build.
    proxy: { '/api': { target: 'http://localhost:4000', changeOrigin: true } },
  },
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 1200 },
});
