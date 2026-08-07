# Multi-stage build for the Next.js frontend.
#
# This assumes an SSR-capable Next.js app built with `output: 'standalone'`
# (add `output: 'standalone'` to next.config.* — it makes Next emit a tiny
# self-contained server under .next/standalone). The container runs
# `node server.js` on port 3000; docker-compose publishes it on 127.0.0.1:8007
# and the host's system Caddy proxies the public domain to it.
#
# If the frontend is instead a pure static export (`output: 'export'`), this
# runner stage won't apply — swap it for a static file server serving `out/`
# (e.g. `FROM caddy:2` / `caddy file-server`). See DEPLOYMENT.md.
#
# The app talks to the backend via RELATIVE paths (same origin), so no backend
# URL / NEXT_PUBLIC_API_URL is needed at build time.

# ---- deps: install dependencies (npm; swap for pnpm/yarn if the app uses them) ----
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# ---- builder: compile the Next.js app ----
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- runner: minimal production image ----
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
 && adduser --system --uid 1001 nextjs

# Standalone output: .next/standalone holds server.js + the minimal node_modules
# subset; static assets and public/ must be copied alongside it.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
