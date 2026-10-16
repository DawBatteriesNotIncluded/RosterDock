# rosterdock-board. Build context is the repo root.
FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/board/package.json apps/board/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @rosterdock/board...
COPY packages/shared packages/shared
COPY apps/board apps/board
RUN pnpm --filter @rosterdock/shared build && pnpm --filter @rosterdock/board build

FROM node:22-alpine
# The model CLIs Peter may plan with (Settings > Peter), when the image is built for it:
#   docker build --build-arg WITH_MODEL_CLIS=1 ...
# Their sign-in arrives by name from the cluster secret (the chart's board.plannerEnvNames). Never in a
# published image: Claude Code's licence does not allow passing it on. Pinned to the versions the planner
# fixtures were recorded with (test/fixtures/claude-cli, codex-cli and planners).
ARG WITH_MODEL_CLIS=0
ARG CLAUDE_CODE_VERSION=2.1.285
ARG CODEX_VERSION=0.157.1
RUN if [ "$WITH_MODEL_CLIS" = "1" ]; then npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" && npm cache clean --force; fi
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
WORKDIR /repo/apps/board
COPY --from=build /repo/node_modules /repo/node_modules
COPY --from=build /repo/package.json /repo/package.json
COPY --from=build /repo/packages/shared/package.json /repo/packages/shared/package.json
COPY --from=build /repo/packages/shared/dist /repo/packages/shared/dist
COPY --from=build /repo/packages/shared/node_modules /repo/packages/shared/node_modules
COPY --from=build /repo/apps/board/package.json ./package.json
COPY --from=build /repo/apps/board/node_modules ./node_modules
COPY --from=build /repo/apps/board/dist ./dist
COPY --from=build /repo/apps/board/migrations ./migrations
# The style packs' pinned files and licences (scripts/vendor-styles.mts): switching one on downloads nothing.
COPY --from=build /repo/apps/board/styles ./styles
EXPOSE 3000
# The file secret store of docker compose (ROSTERDOCK_SECRET_STORE=file:/var/lib/rosterdock/secrets) writes here;
# a named volume mounted on it takes this ownership.
RUN mkdir -p /var/lib/rosterdock/secrets && chown node:node /var/lib/rosterdock/secrets
USER node
CMD ["node", "dist/server.js"]
