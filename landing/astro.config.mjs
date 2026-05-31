import { defineConfig } from 'astro/config';

// Static marketing landing for rewards.mctl.ai.
// Builds into the backend's /public dir so Express serves it at `/`,
// `/privacy`, `/terms`. Astro empties this dir on build, so the root
// `npm run build` runs the landing FIRST, then the Vite SPA writes into
// the `public/_miniapp` SUBDIR (which the SPA's own emptyOutDir scopes to).
// Astro's hashed assets live under `_astro/`, the SPA's under
// `_miniapp/assets/` — non-colliding by design.
export default defineConfig({
  output: 'static',
  site: 'https://rewards.mctl.ai',
  outDir: '../public',
  build: {
    assets: '_astro',
  },
});
