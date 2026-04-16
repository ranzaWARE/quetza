FROM node:20-alpine

RUN apk add --no-cache python3 make g++ openssl

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data /app/certs

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3000 3443
ENTRYPOINT ["/entrypoint.sh"]