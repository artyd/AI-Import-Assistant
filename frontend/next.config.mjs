import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

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
