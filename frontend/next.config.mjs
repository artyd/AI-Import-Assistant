import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const isDev = process.env.NODE_ENV !== "production";

// Content-Security-Policy. 'unsafe-inline' scripts are required by Next's inline
// bootstrap and the pre-hydration theme script in app/layout.tsx; 'unsafe-eval'
// only in dev (React Refresh). External hosts actually used by the app:
//   • Google Fonts (layout.tsx): fonts.googleapis.com CSS + fonts.gstatic.com files
//   • Leaflet map tiles (MapCanvas): server.arcgisonline.com → img-src https:
//   • Place geocoding (MapCanvas): nominatim.openstreetmap.org → connect-src
//   • PDF preview (FilePreviewModal): <object data="blob:…"> → object-src blob:
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https://fonts.gstatic.com",
  `connect-src 'self' https://nominatim.openstreetmap.org${isDev ? " ws: wss:" : ""}`,
  "object-src 'self' blob:",
  "frame-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Emit a self-contained server (.next/standalone/server.js) so the Docker
  // image stays tiny and runs with `node server.js`. See frontend/Dockerfile.
  output: "standalone",
  // Pin the file-tracing root to THIS directory. Without it, Next may walk up
  // and pick the backend repo root (it also has a lockfile), nesting the
  // standalone output under .next/standalone/frontend/ and breaking the
  // Dockerfile's `node server.js`.
  outputFileTracingRoot: __dirname,
  reactStrictMode: true,
  poweredByHeader: false,
  // Security headers on every route (S9).
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // The frontend and backend share one origin (the host's system Caddy routes
  // /api/* to the backend), so the browser calls the API with relative paths.
  // No rewrites/proxy are needed here — Caddy does the routing in production.
  // For local `next dev` without Caddy, set DEV_API_PROXY to the backend origin.
  async rewrites() {
    const devApi = process.env.DEV_API_PROXY;
    if (!devApi) return [];
    return [{ source: "/api/:path*", destination: `${devApi}/api/:path*` }];
  },
};

export default nextConfig;
