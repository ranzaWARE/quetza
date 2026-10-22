FROM node:20-alpine AS base
RUN apk add --no-cache python3 make g++ openssl
WORKDIR /app
COPY package*.json ./

FROM base AS development
RUN npm install
RUN mkdir -p /app/data /app/certs /app/backups
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000 3443
ENTRYPOINT ["/entrypoint.sh"]

FROM base AS production
# npm ci: installa esattamente le versioni di package-lock.json
RUN npm ci --omit=dev && npm cache clean --force
COPY . .
RUN mkdir -p /app/data /app/certs /app/backups
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000 3443
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz >/dev/null || exit 1
ENTRYPOINT ["/entrypoint.sh"]
