FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json stage1.map.json ./
COPY scripts ./scripts
COPY deployment ./deployment
RUN node scripts/unpack-stage1-runtime.mjs
COPY packages ./packages
RUN pnpm install --frozen-lockfile
ENV NODE_ENV=production
USER node
CMD ["node", "--import", "tsx", "packages/server/src/hosted.ts"]
