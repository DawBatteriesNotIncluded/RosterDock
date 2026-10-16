# rosterdock-worker. Build context is the repo root. Ships git and Codex; the model credentials arrive by name
# (OPENAI_API_KEY, ANTHROPIC_API_KEY) from the cluster secret store.
#
# Claude Code is left out: its licence (Anthropic's Commercial Terms) does not allow passing it on, and this
# image is published. For an image you keep in your own registry, build with it from source
#   docker build --build-arg WITH_CLAUDE_CODE=1 -f apps/worker/Dockerfile .
# (docker compose and deploy/scripts/local-cluster.sh do), or add it to a published image (docs/install.md).
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/worker/package.json apps/worker/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @rosterdock/worker...
COPY packages/shared packages/shared
COPY apps/worker apps/worker
RUN pnpm --filter @rosterdock/shared build && pnpm --filter @rosterdock/worker build

FROM node:22-alpine
# The engine CLIs at the versions their stream parsers were recorded with (test/fixtures/README.md); a new
# version is recorded first, then pinned here.
ARG CODEX_VERSION=0.144.5
RUN apk add --no-cache git && npm install -g "@openai/codex@${CODEX_VERSION}" && npm cache clean --force
ARG CLAUDE_CODE_VERSION=2.1.285
ARG WITH_CLAUDE_CODE=0
RUN if [ "$WITH_CLAUDE_CODE" = "1" ]; then npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && npm cache clean --force; fi
# The Claude Code version this worker was tested with, installed or not, for an image built on top of it.
ENV ROSTERDOCK_CLAUDE_CODE_VERSION=${CLAUDE_CODE_VERSION}
ENV NODE_ENV=production ROSTERDOCK_WORK_ROOT=/work ROSTERDOCK_CLAUDE_BIN=claude ROSTERDOCK_CODEX_BIN=codex
WORKDIR /repo/apps/worker
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/package.json /repo/package.json
COPY --from=build /repo/packages/shared/package.json /repo/packages/shared/package.json
COPY --from=build /repo/packages/shared/dist /repo/packages/shared/dist
COPY --from=build /repo/packages/shared/node_modules /repo/packages/shared/node_modules
COPY --from=build /repo/apps/worker/package.json ./package.json
COPY --from=build /repo/apps/worker/node_modules ./node_modules
COPY --from=build /repo/apps/worker/dist ./dist
RUN mkdir -p /work && chown node:node /work
USER node
CMD ["node", "dist/main.js"]
