# Shared image for both the API server and the indexing worker.
# docker-compose runs the same image with different commands.

FROM node:20-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build

FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Headless LibreOffice (Writer only) converts legacy binary .doc → .docx at ingest.
# Chromium prints the management report / supplier instruction HTML → PDF
# (puppeteer-core, CHROMIUM_PATH); fonts-dejavu covers Cyrillic if the web font can't load.
ENV CHROMIUM_PATH=/usr/bin/chromium PUPPETEER_SKIP_DOWNLOAD=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends libreoffice-writer-nogui chromium fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Storage volume is mounted at runtime (see docker-compose).
EXPOSE 8080
CMD ["node", "dist/server.js"]
