ARG NODE_VERSION=24
FROM node:${NODE_VERSION}-bookworm-slim
WORKDIR /proof
COPY agentorg-cli-*.tgz ./sdk.tgz
COPY package-lock.json ./package-lock.json
COPY scripts/verify-packed-sdk.mjs ./scripts/verify-packed-sdk.mjs
COPY test/fixtures/packed-* ./test/fixtures/
CMD ["node", "scripts/verify-packed-sdk.mjs", "sdk.tgz"]
