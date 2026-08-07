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
  /**
   * No manualChunks here on purpose. Naming recharts as a manual chunk did split it out,
   * and then Vite preloaded that chunk from index.html — so every visit downloaded it
   * anyway, which is the thing being fixed. Left to itself, Rollup puts it in the chunk
   * behind the dynamic import, and it arrives only when a chart is rendered.
   */
  build: { outDir: 'dist', sourcemap: false, chunkSizeWarningLimit: 700 },
});
