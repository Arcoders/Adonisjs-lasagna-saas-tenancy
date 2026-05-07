# syntax=docker/dockerfile:1.7-labs
# Reference Dockerfile for an AdonisJS 7 application using
# @adonisjs-lasagna/saas-tenancy. Multi-stage:
#   builder  — installs dev deps + compiles TS
#   pruner   — drops dev deps in a fresh layer
#   runtime  — minimal distroless image with only what's needed at runtime
#
# Build context expectation: the AdonisJS app root (where package.json lives).
# Adjust the build command at the bottom of `builder` if your script name
# differs (`node ace build` is the AdonisJS 7 default).

# In production, pin to a digest instead of the floating tag below — tags
# are mutable and an upstream rebuild can change what you ship without a
# version bump. Override at build time:
#   docker build --build-arg NODE_VERSION='node@sha256:<digest>' -f deploy/Dockerfile .
# Find the current digest with `docker pull node:24-bookworm-slim && docker
# image inspect --format='{{index .RepoDigests 0}}' node:24-bookworm-slim`.
ARG NODE_VERSION=24-bookworm-slim

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS builder

WORKDIR /app

# System deps: pg_dump for tenant_backup commands, openssl for crypto utilities.
# Keep this list intentionally short — only what the package's runtime needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      postgresql-client \
      openssl \
      ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

COPY . .

ENV NODE_ENV=production
RUN node ace build --ignore-ts-errors

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS pruner

WORKDIR /app

COPY --from=builder /app/build ./build
COPY package.json package-lock.json* ./

# Reinstall production-only deps inside the build dir (Adonis ships build/
# as a self-contained app with its own package.json).
RUN cd build && npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION} AS runtime

# Re-install pg_dump on the runtime layer for the tenant_backup commands.
RUN apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client tini ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3333

# Run as the unprivileged `node` user that the upstream image already
# provides. Distroless would be safer but doesn't include pg_dump.
USER node

COPY --from=pruner --chown=node:node /app/build /app

EXPOSE 3333

# Health check uses /healthz which @adonisjs-lasagna/saas-tenancy exposes
# from src/health when the user mounts it. Adjust the path if your app
# mounts at a different prefix.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "bin/server.js"]
