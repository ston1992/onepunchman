# Build from the repo root:  docker build -f apps/server/Dockerfile -t twinly-server .
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY packages/shared ./packages/shared
COPY apps/server/package.json ./apps/server/
RUN npm ci --omit=dev -w @twinly/server --include-workspace-root=false
COPY apps/server ./apps/server
WORKDIR /app/apps/server
# SQLite lives on a mounted volume so it survives redeploys.
ENV DATABASE_PATH=/data/twinly.db PORT=8787
VOLUME /data
EXPOSE 8787
USER node
CMD ["node", "--import", "tsx", "src/index.ts"]
