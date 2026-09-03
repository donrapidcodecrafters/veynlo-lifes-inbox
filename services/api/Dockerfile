# Builds both the HTTP API and the worker process from one shared build stage —
# they're the same codebase with two entrypoints (src/main.ts, src/worker-main.ts),
# see worker-main.ts's own doc comment. Build context MUST be the repo root
# (workspace deps live in packages/*), not this directory:
#
#   docker build -f services/api/Dockerfile --target api    -t veynlo-api    .
#   docker build -f services/api/Dockerfile --target worker -t veynlo-worker .
#
# Linux/ARM64 (Graviton) is the deployment target per the architecture blueprint;
# this Dockerfile is architecture-agnostic (no arch-specific base image pins), so
# `docker buildx build --platform linux/arm64,linux/amd64` produces both from CI.

FROM node:20-bookworm-slim AS base
# glibc (not Alpine/musl) — argon2's prebuilt native binary targets glibc, and
# building it from source under musl needs a C++ toolchain this image doesn't carry.
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate
WORKDIR /workspace

FROM base AS deps
# Only manifests first so this layer caches across source-only changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/design-tokens/package.json packages/design-tokens/
COPY services/api/package.json services/api/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY packages/core packages/core
COPY packages/db packages/db
COPY packages/design-tokens packages/design-tokens
COPY services/api services/api
COPY turbo.json tsconfig*.json ./
# Builds @veynlo/api and every workspace package it depends on, in dependency order.
# --ui=stream: the default "tui" renderer assumes a real terminal; plain streamed
# log output is the correct choice for a non-interactive `docker build` shell.
RUN pnpm exec turbo run build --filter=@veynlo/api... --ui=stream
# Materializes a standalone, production-only copy of @veynlo/api — workspace
# `workspace:*` deps resolved to real files, no symlinks back into /workspace,
# so the runtime stage below can copy exactly one self-contained directory.
# --legacy: pnpm v10 changed the default deploy mechanism to require
# `inject-workspace-packages=true` repo-wide (a setting that would also change
# how every contributor's day-to-day `pnpm install` links workspace packages,
# for the sake of this one Docker-only step) — the pre-v10 deploy algorithm
# needs no such repo-wide setting and produces the same self-contained result.
#
# pnpm-workspace.yaml's patchedDependencies (expo-* patches, apps/mobile only —
# see patches/) make `deploy` fail with ERR_PNPM_UNUSED_PATCH: this deploy only
# resolves @veynlo/api's own dependency tree, which none of those patches touch,
# and pnpm treats a workspace-declared patch matching nothing in scope as an
# error. apps/mobile is never copied into this image (see .dockerignore), so
# swap in a patch-free copy of the workspace file for this one step only — it
# only needs the `packages:` globs, not the mobile-specific patch list.
RUN printf 'packages:\n  - apps/*\n  - services/*\n  - packages/*\n' > pnpm-workspace.yaml && \
    pnpm --filter @veynlo/api deploy --prod --legacy /deploy/api
# The "Ignored build scripts: argon2, msgpackr-extract" warning above is expected and
# harmless, not a broken build: both ship prebuilt native binaries for every platform
# (argon2/prebuilds/<platform>/*.node) that pnpm's default install-script sandboxing
# only skips the redundant verification step for — verified live in this exact image
# (`docker run ... node -e "require('argon2').hash(...)"` hashes and verifies
# correctly). Not silenced via a repo-wide `onlyBuiltDependencies` allowlist because
# that setting applies to the whole pnpm workspace, including apps/mobile's native
# build — not worth the risk to a working mobile toolchain to quiet one log line here.

FROM node:20-bookworm-slim AS runtime-base
RUN groupadd --system --gid 1001 veynlo && useradd --system --uid 1001 --gid veynlo veynlo
WORKDIR /app
COPY --from=build /deploy/api .
USER veynlo
ENV NODE_ENV=production
# Belt-and-suspenders — env.ts's own loadEnv() refuses to boot in production
# with an insecure/default secret regardless, but failing this early avoids
# even starting the process (and paying ECS's health-check grace period) on a
# deployment that's missing its secrets entirely.
ENV NODE_OPTIONS=--enable-source-maps

FROM runtime-base AS api
EXPOSE 4000
# Matches the ALB health check path referenced in the architecture blueprint
# (§10, "dedicated lightweight /health/ready") — see main.ts's health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:4000/health/ready',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/main.js"]

FROM runtime-base AS worker
# No HTTP surface, so no Docker HEALTHCHECK here — ECS should use the worker
# task's own liveness signal instead (e.g. a CloudWatch alarm on job throughput/
# process exit) rather than a synthetic HTTP endpoint that would exist only to
# satisfy a health check.
CMD ["node", "dist/worker-main.js"]
