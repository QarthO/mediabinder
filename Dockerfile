# syntax=docker/dockerfile:1

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
# Keep dependency resolution independent from source so ordinary changes reuse
# the install layers.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

FROM base AS dependencies
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile

FROM base AS production-dependencies
# tsx stays a runtime dependency: scripts/start.ts, migrate.ts and
# drive-worker.ts run as TypeScript through `node --import tsx`.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
  pnpm install --frozen-lockfile --prod --ignore-scripts

# `pnpm dev` in compose.dev.yaml bind-mounts src, public, scripts and migrations over this.
FROM dependencies AS development
COPY . .
EXPOSE 3100
CMD ["sh", "-c", "pnpm db:migrate && pnpm dev"]

FROM dependencies AS build
COPY . .
# Coolify passes SOURCE_COMMIT as a build argument. `/api/health` reports it.
ARG SOURCE_COMMIT
RUN pnpm build

FROM node:${NODE_VERSION}-alpine AS production
ARG SOURCE_COMMIT
LABEL org.opencontainers.image.source="https://github.com/QarthO/mediabinder" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
WORKDIR /app
COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json tsconfig.json ./
COPY --chown=node:node scripts ./scripts
# The runtime scripts import these directories through tsx, which resolves the "@/" alias from tsconfig.json.
COPY --chown=node:node src/lib ./src/lib
COPY --chown=node:node src/effect ./src/effect
COPY --chown=node:node migrations ./migrations
EXPOSE 3100
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3100') + '/api/health', { signal: AbortSignal.timeout(4000) }).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]
CMD ["node", "--import", "tsx", "scripts/start.ts"]
