# Partizip — Produktions-/Staging-Image (P0-4)
# Build-Kontext: Repo-Root (db/migrations wird für den tools-Stage gebraucht).
#   docker build -t partizip-app --target runner .
#   docker build -t partizip-tools --target tools .   # Migrationen/Seed/Skripte

# ── Builder ──────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo/app
COPY app/package.json app/package-lock.json ./
RUN npm ci
COPY app/ ./
COPY db/ /repo/db/
# Next braucht die Variable beim Build, nutzt sie aber nicht (kein DB-Zugriff im Build)
ENV DATABASE_URL=postgres://build:build@localhost:5432/build
RUN npm run build

# ── Tools: volle node_modules + Skripte (Migrationen, Seed, ris:import, …) ───
FROM node:22-alpine AS tools
WORKDIR /repo/app
COPY --from=builder /repo/app /repo/app
COPY --from=builder /repo/db /repo/db
CMD ["npm", "run", "db:migrate"]

# ── Runner: schlankes Standalone-Image ───────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=builder /repo/app/.next/standalone ./
COPY --from=builder /repo/app/.next/static ./.next/static
COPY --from=builder /repo/app/public ./public
USER app
EXPOSE 3000
ENV HOSTNAME=0.0.0.0 PORT=3000
CMD ["node", "server.js"]
