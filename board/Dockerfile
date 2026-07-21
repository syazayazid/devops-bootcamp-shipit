# --- build the client ---
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.js ./
COPY client ./client
# client/ship-mesh.js imports ../src/ships.js — the client shares it with the server
COPY src ./src
RUN npm run build                       # → /app/dist

# --- runtime ---
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev                   # only ws
COPY src ./src
COPY --from=build /app/dist ./dist
EXPOSE 3000
ENV PORT=3000
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:3000/ >/dev/null 2>&1 || exit 1
CMD ["node", "src/index.js"]
