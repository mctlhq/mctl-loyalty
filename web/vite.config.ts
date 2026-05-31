import { defineConfig } from 'vite';

// Build the single Mini App SPA into the backend's /public/_miniapp subdir.
// The Astro marketing landing owns the /public root (served at `/`), so the
// SPA lives under /_miniapp to keep their asset dirs from colliding.
//
// base '/_miniapp/' makes Vite emit asset URLs under /_miniapp/assets/*.
// The SPA's client router reads location.pathname (/app, /admin, /help,
// /docs) which is independent of base, and its hand-written links use
// absolute paths (<a href="/admin">), so routing is unaffected by the base
// change. emptyOutDir only clears /public/_miniapp — never the Astro output
// at the /public root (which the root build script produces FIRST).
export default defineConfig({
  base: '/_miniapp/',
  build: {
    outDir: '../public/_miniapp',
    emptyOutDir: true,
  },
});
