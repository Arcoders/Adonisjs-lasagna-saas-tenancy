# CI-verification image for the deploy e2e (deploy/docker-compose.e2e.yml).
# Builds the demo app from the monorepo so the prod compose topology can be
# booted and smoke-tested on every PR. The production reference image for
# real applications is deploy/Dockerfile — this one trades its multi-stage
# pruning for workspace fidelity (the demo resolves the packages through
# npm workspace symlinks and runs via tsx, exactly like local dev and CI).
#
# Build context is the REPO ROOT:
#   docker build -f examples/api/Dockerfile -t lasagna-demo:local .
ARG NODE_VERSION=24-bookworm-slim

FROM node:${NODE_VERSION}

# pg_dump/pg_restore for the backup commands, tini as PID 1.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client \
      tini \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /repo \
 && chown node:node /repo

USER node
WORKDIR /repo

# Manifests first so the npm install layer survives source-only changes.
COPY --chown=node:node package.json package-lock.json* .npmrc* ./
COPY --chown=node:node packages/core/package.json packages/core/
COPY --chown=node:node packages/sso/package.json packages/sso/
COPY --chown=node:node packages/billing/package.json packages/billing/
COPY --chown=node:node packages/admin/package.json packages/admin/
COPY --chown=node:node packages/backup/package.json packages/backup/
COPY --chown=node:node examples/api/package.json examples/api/
COPY --chown=node:node benchmarks/package.json benchmarks/

# Mirrors .github/workflows/ci.yml: the repo .npmrc disables scripts for
# local-dev safety; the image is a controlled environment and tsx/esbuild
# need their postinstall to fetch the platform binary.
RUN npm_config_ignore_scripts=false npm install --legacy-peer-deps --include=optional

COPY --chown=node:node . .

# The demo resolves @adonisjs-lasagna/* through each package's build/.
RUN npm run build:all

WORKDIR /repo/examples/api

ENV HOST=0.0.0.0 \
    PORT=3333

EXPOSE 3333

# No HEALTHCHECK here on purpose — deploy/docker-compose.e2e.yml owns the
# /readyz probe so the gate lives next to the topology it protects.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["npx", "tsx", "bin/server.ts"]
