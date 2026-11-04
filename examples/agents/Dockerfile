ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
WORKDIR /opt/contextvault-client
COPY contextvault-sdk-*.tgz contextvault-cli-*.tgz ./
RUN printf '{"name":"contextvault-agent-client","private":true}' > package.json \
 && npm install --offline --ignore-scripts --no-audit --no-fund ./contextvault-sdk-*.tgz ./contextvault-cli-*.tgz \
 && rm ./*.tgz
COPY worker.cjs ./worker.cjs
ENV PATH="/opt/contextvault-client/node_modules/.bin:${PATH}"
ENTRYPOINT ["contextvault"]
