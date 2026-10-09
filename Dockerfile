FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc tsconfig.base.json tsconfig.json ./
COPY scripts ./scripts
# Stage 1 packages imported by Stage 2 (the `stage1` submodule; run `git submodule update --init` first)
COPY stage1/tsconfig.base.json ./stage1/tsconfig.base.json
COPY stage1/packages/sdk ./stage1/packages/sdk
COPY stage1/packages/reference ./stage1/packages/reference
COPY stage1/circuits ./stage1/circuits
COPY packages ./packages
RUN pnpm install --frozen-lockfile
CMD ["pnpm", "dev:mock"]
