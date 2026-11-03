# iplaces-zenodo: Zenodo deposit service (Fly app iplaces-zenodo).
# The running app was Node 20.20.2 with the code in /app (2026-11-03).
FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./
EXPOSE 8080
CMD ["node", "server.js"]
