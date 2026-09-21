# ---------- Build ----------
FROM oven/bun:1 AS builder

WORKDIR /app

COPY package.json bun.lock ./

RUN bun install --frozen-lockfile

COPY . .

RUN bun run check
RUN bun test

# ---------- Runtime ----------
FROM oven/bun:1-slim

WORKDIR /app

ENV NODE_ENV=production

COPY package.json bun.lock ./

RUN bun install --production --frozen-lockfile

COPY src ./src

USER bun

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD bun -e "const r = await fetch('http://localhost:' + (process.env.PORT ?? 3000) + '/health'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "start"]
