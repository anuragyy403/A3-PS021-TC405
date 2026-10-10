import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Dev wiring (docs/API_DESIGN.md §12): the browser talks to one origin and the
 * Vite dev server forwards /api and /health to the backend, so the backend
 * needs no CORS.  Target: VITE_BACKEND_URL (default http://localhost:3001).
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backend = env.VITE_BACKEND_URL || 'http://localhost:3001';

  return {
    plugins: [react()],
    server: {
      proxy: {
        '/api': { target: backend, changeOrigin: true },
        '/health': { target: backend, changeOrigin: true },
      },
    },
  };
});
