# syntax=docker/dockerfile:1.7

FROM node:26.10.0-bookworm-slim AS pnpm-base

RUN npm install --global pnpm@11.1.3

WORKDIR /workspace

# Pin the exact reviewed native source revision until Graft publishes platform artifacts.
FROM rust:1.94-bookworm AS graft-native

ARG GRAFT_REPOSITORY=https://github.com/WilcoKruijer/graft.git
ARG GRAFT_REVISION=7113044c90f810cbb5c25f2fa85d6d99976a655a

RUN apt-get update \
  && apt-get install --yes --no-install-recommends clang libclang-dev llvm-dev cmake libssl-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /graft
RUN git init \
  && git remote add origin "$GRAFT_REPOSITORY" \
  && git fetch --depth=1 origin "$GRAFT_REVISION" \
  && git checkout --detach FETCH_HEAD \
  && test "$(git rev-parse HEAD)" = "$GRAFT_REVISION"
RUN --mount=type=cache,id=graft-cargo-registry,target=/usr/local/cargo/registry,sharing=locked \
  --mount=type=cache,id=graft-cargo-git,target=/usr/local/cargo/git,sharing=locked \
  --mount=type=cache,id=graft-target,target=/graft/target,sharing=locked \
  cargo build --locked --release -p graft-ext \
  && cp target/release/libgraft_ext.so /libgraft_ext.so

FROM pnpm-base AS builder

RUN apt-get update \
  && apt-get install --yes --no-install-recommends build-essential python3 \
  && rm -rf /var/lib/apt/lists/*

COPY json/ .
RUN --mount=type=cache,id=backoffice-node-runtime-demo-pnpm-store,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=backoffice-node-runtime-demo-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm --store-dir=/pnpm/store install --frozen-lockfile

COPY full/ .
RUN --mount=type=cache,id=backoffice-node-runtime-demo-turbo-cache,target=/workspace/.turbo,sharing=locked \
  pnpm exec turbo run build \
    --filter=@fragno-private/backoffice-node-runtime-demo \
    --output-logs=errors-only

FROM builder AS runtime-dependencies

RUN --mount=type=cache,id=backoffice-node-runtime-demo-pnpm-store,target=/pnpm/store,sharing=locked \
  --mount=type=cache,id=backoffice-node-runtime-demo-pnpm-metadata,target=/root/.cache/pnpm,sharing=locked \
  pnpm --store-dir=/pnpm/store \
    --config.inject-workspace-packages=true \
    --filter=@fragno-private/backoffice-node-runtime-demo \
    deploy \
    --prod \
    /runtime

FROM node:26.10.0-bookworm-slim AS runtime

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates tini libssl3 \
  && rm -rf /var/lib/apt/lists/*

COPY --from=runtime-dependencies --chown=node:node /runtime/package.json /app/package.json
COPY --from=runtime-dependencies --chown=node:node /runtime/node_modules /app/node_modules
COPY --from=builder --chown=node:node /workspace/apps/backoffice-node-runtime-demo/dist /app/dist

COPY --from=graft-native --chown=node:node /libgraft_ext.so /app/native/libgraft_ext.so

RUN ln --symbolic \
  /app/node_modules/@fragno-private/backoffice-node-runtime/bin/run.js \
  /usr/local/bin/backoffice-node-runtime

ENV FRAGNO_GRAFT_EXTENSION_PATH=/app/native/libgraft_ext.so
ENV GRAFT_CONFIG=/config/graft.toml
ENV NODE_ENV=production
ENV PATH=/app/node_modules/.bin:$PATH
ENV HOST=0.0.0.0
ENV PORT=8080
ENV BACKOFFICE_NODE_RUNTIME_DEMO_INTERNAL_PORT=8081

RUN mkdir --parents /config /data /runtime-data && chown -R node:node /config /data /runtime-data

WORKDIR /app
USER node

# The final image, not the builder, must load and exercise the native extension.
RUN node dist/testing/native-graft-extension-smoke.js

# Internal ingress needs deployment network restrictions; EXPOSE does not enforce them.
EXPOSE 8080 8081
VOLUME ["/config", "/data", "/runtime-data"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/start-node.js"]
