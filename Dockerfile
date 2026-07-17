FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ARG CODEX_CLI_VERSION=0.144.5
ARG APP_VERSION=development
ARG APP_REVISION=unknown
ARG APP_BUILT_AT=unknown

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4317 \
    CODEX_LOOP_VERSION=${APP_VERSION} \
    CODEX_LOOP_REVISION=${APP_REVISION} \
    CODEX_LOOP_BUILT_AT=${APP_BUILT_AT}

WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_CLI_VERSION}" tsx

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY server ./server
COPY src/domain ./src/domain
COPY src/data ./src/data

RUN mkdir -p /app/data /workspace /root/.codex

EXPOSE 4317
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4317/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["tsx", "server/index.ts"]

