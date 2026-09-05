FROM node:24-alpine AS base
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.25.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
FROM base AS development
EXPOSE 3100
CMD ["sh", "-c", "pnpm db:migrate && pnpm dev"]
FROM base AS build
RUN pnpm build
FROM base AS production
ENV NODE_ENV=production
COPY --from=build /app/dist ./dist
EXPOSE 3100
USER node
CMD ["sh", "-c", "node --import tsx scripts/migrate.ts && node scripts/serve.mjs"]
