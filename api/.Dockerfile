# Bun installs the packages (fast, reproducible from bun.lock); the app itself runs on Node 26.
FROM node:26-alpine AS base
COPY --from=oven/bun:1-alpine /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM base AS build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN bun run build

FROM node:26-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/build ./build
COPY drizzle ./drizzle
# the SQLite file lives here: mount a volume on it
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8080
# the container sits behind nginx, which terminates TLS
ENV TLS=off
CMD ["node", "build/server.js"]
