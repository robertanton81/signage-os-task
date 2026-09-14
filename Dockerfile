# syntax=docker/dockerfile:1
#
# One image per application, built from the monorepo. Development only.
# The three runtime targets differ only in their CMD, so they share every layer.

FROM node:24-alpine AS base
# corepack ships with the image and resolves the pnpm version pinned in the root package.json
# `packageManager` field, so the image runs exactly the pnpm a developer runs. CI=true makes pnpm
# behave as in CI (frozen lockfile by default, no prompts); the second variable keeps corepack from
# asking before it fetches pnpm.
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /repo

FROM base AS build
# .dockerignore keeps node_modules and dist out of the context, so this is always a clean install
# and a fresh compile: the same shape as `git clone && pnpm install && pnpm build`. Sources are
# copied before the install, so a source change re-installs; accepted for a stack that is built
# once (decision 5 names the cache-mount upgrade).
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Reconciles node_modules down to the production set. The build has already run, so nothing left
# in dist depends on what this removes.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts

FROM node:24-alpine AS runtime
WORKDIR /repo
COPY --from=build /repo /repo
USER node

FROM runtime AS ingest
CMD ["node", "apps/ingest/dist/main.js"]

FROM runtime AS processing
CMD ["node", "apps/processing/dist/main.js"]

FROM runtime AS emulator
CMD ["node", "apps/emulator/dist/main.js"]
