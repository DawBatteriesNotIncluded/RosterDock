# rosterdock-web: static build served by nginx, /api proxied to the board service.
# The build runs on the builder's own platform: its output is the same files for every target platform.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @rosterdock/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @rosterdock/shared build && pnpm --filter @rosterdock/web build

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
