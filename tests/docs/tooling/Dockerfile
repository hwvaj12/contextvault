ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /opt/contextvault-docs
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund && npm audit --omit=dev --audit-level=high --json && npm cache clean --force
COPY runner.cjs /runtime/runner.cjs
USER node
ENTRYPOINT ["node", "/runtime/runner.cjs"]
