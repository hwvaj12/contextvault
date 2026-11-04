ARG BASE_IMAGE
FROM ${BASE_IMAGE} AS build
WORKDIR /application
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
RUN npm_config_jobs=2 npm rebuild better-sqlite3 --foreground-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev --ignore-scripts --no-audit --no-fund

FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*
WORKDIR /application
COPY --from=build /application/package.json /application/package-lock.json ./
COPY --from=build /application/node_modules ./node_modules
COPY --from=build /application/dist ./dist
USER node
CMD ["node", "dist/index.js"]
