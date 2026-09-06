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
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3100
COPY --from=build /app/dist ./dist
EXPOSE 3100
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "scripts/start.ts"]
