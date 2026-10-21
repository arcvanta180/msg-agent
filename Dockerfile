FROM node:22-alpine
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9.10.0 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
CMD ["node", "dist/apps/api/src/main.js"]
