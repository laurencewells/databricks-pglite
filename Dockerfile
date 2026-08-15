FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --no-audit --no-fund

FROM dependencies AS build

COPY tsconfig.json vitest.config.ts ./
COPY server ./server
COPY client ./client
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DATABRICKS_APP_PORT=8000 \
    PGLITE_DATA_DIR=/tmp/pglite/data \
    SNAPSHOT_MODE=filesystem \
    SNAPSHOT_DIRECTORY=/snapshots \
    ALLOW_LOCAL_IDENTITY=true

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund \
    && npm cache clean --force
COPY --from=build /app/build ./build
COPY --from=build /app/client/dist ./client/dist

EXPOSE 8000
CMD ["npm", "start"]
