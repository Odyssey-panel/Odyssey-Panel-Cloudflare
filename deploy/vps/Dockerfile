# Odyssey Panel — self-hosted build (VPS / Docker, no Cloudflare)
# Build:  docker build -f deploy/vps/Dockerfile -t odyssey-panel .
# Run:    see deploy/vps/docker-compose.yml
FROM node:22-alpine AS builder
WORKDIR /app
RUN apk add --no-cache libc6-compat
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
ENV NEXT_CF_DEV_SYNC=0
RUN npx prisma generate && npx next build --webpack

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Inline scheduler (quota resets) — this is a long-running Node host now
ENV ODYSSEY_INLINE_JOBS=1
ENV DATABASE_URL=file:/data/odyssey.db
RUN apk add --no-cache libc6-compat
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY deploy/vps/entrypoint.sh ./entrypoint.sh
RUN chmod +x ./entrypoint.sh
VOLUME /data
EXPOSE 3000
ENTRYPOINT ["./entrypoint.sh"]
