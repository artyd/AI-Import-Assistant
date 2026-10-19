# Flat repo layout: backend at the root, frontend in `frontend/`

The backend's `src/`, `package.json`, `Dockerfile` and `docker-compose.yml` sit at the repo root, with no `backend/` folder. This was a user requirement, and the Docker build context is `.`. The Next.js app is a separate package in `frontend/` with its own lockfile and Dockerfile. `logist-mcp/` is a separate Python service.
