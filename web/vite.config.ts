import { defineConfig } from 'vite';

// Build the single SPA into the backend's /public dir, which Express serves and
// falls back to index.html for both /app and /admin client routes.
export default defineConfig({
  base: '/',
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
});
