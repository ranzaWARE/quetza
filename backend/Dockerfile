FROM node:20-alpine AS base
RUN apk add --no-cache python3 make g++ openssl
WORKDIR /app
COPY package*.json ./

FROM base AS development
RUN npm install
RUN mkdir -p /app/data /app/certs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000 3443
ENTRYPOINT ["/entrypoint.sh"]

FROM base AS production
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data /app/certs
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000 3443
ENTRYPOINT ["/entrypoint.sh"]
