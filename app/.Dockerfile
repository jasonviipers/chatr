FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
EXPOSE 3000
# the dev server listens on 0.0.0.0:3000 for any host name (see vite.config.ts), nginx sits in front of it
CMD ["bun", "run", "dev"]
