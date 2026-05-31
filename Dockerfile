# ---- build backend (TS -> dist) ----
# Build ONLY the backend here. The root `build` script orchestrates
# landing+web+api together for local dev; in Docker each stage builds its own
# part in isolation, so this stage uses build:api (landing/ and web/ are not
# copied into this stage, so a full `npm run build` would fail on `cd landing`).
FROM node:22.11-alpine3.20 AS build-api
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build:api

# ---- build marketing landing (Astro -> /app/public) ----
# Astro's outDir is ../public, so this stage writes /app/public (the landing
# root: index.html, /privacy, /terms, assets under /_astro).
FROM node:22.11-alpine3.20 AS build-landing
WORKDIR /app/landing
COPY landing/package*.json ./
RUN npm ci
COPY landing/ ./
RUN npm run build

# ---- build frontend SPA (Vite -> /app/public/_miniapp) ----
# vite outDir is ../public/_miniapp, resolved relative to the project root
# (/app/web), so this stage writes the SPA to /app/public/_miniapp (one level
# up from /app/web), with assets under /_miniapp/assets.
FROM node:22.11-alpine3.20 AS build-web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---- runtime ----
FROM node:22.11-alpine3.20
RUN apk add --no-cache tini
ENV NODE_ENV=production
ENV PORT=8080
WORKDIR /app

# Production deps only (express + pg).
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build-api /app/dist ./dist
# Landing first (owns /public root), then the SPA into the _miniapp subdir.
# Neither COPY overwrites the other: landing writes to ./public/* (no _miniapp),
# the SPA writes only to ./public/_miniapp.
COPY --from=build-landing /app/public ./public
COPY --from=build-web /app/public/_miniapp ./public/_miniapp

RUN addgroup -S app && adduser -S -G app -h /home/app app && chown -R app:app /app
USER app

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server.js"]
