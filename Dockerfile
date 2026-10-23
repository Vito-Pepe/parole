# node:alpine e' multi-arch (amd64 + arm64) — funziona su Raspberry Pi 5 senza modifiche
FROM node:22-alpine

WORKDIR /app
COPY server.js ./
COPY app/ ./app/
COPY player/ ./player/

# Cartella dei dati: appartiene all'utente "node" cosi' il volume Docker e' scrivibile
RUN mkdir -p /data && chown node:node /data

ENV NODE_ENV=production DATA_DIR=/data PORT=3000 PUBLIC_PORT=3001
USER node
VOLUME /data
# 3000 = app privata (LAN e tailnet), 3001 = esercizi condivisi (pubblica)
EXPOSE 3000 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:3000/ || exit 1

CMD ["node", "server.js"]
