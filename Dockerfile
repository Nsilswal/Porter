# Porter MCP server. Multi-stage so the runtime image carries no build tools.
FROM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
# pnpm asks before purging node_modules, and there is no TTY in a build.
ENV CI=true

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY packages ./packages
COPY apps ./apps

# --ignore-scripts: nothing in this build needs a dependency's postinstall to
# run, and not executing arbitrary install-time code in the image is the safer
# default. esbuild's binary is only needed by the test tooling, not at runtime.
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm build

# No `pnpm prune --prod` here. It strips the workspace symlinks that link
# apps/mcp-server to packages/*, and the server cannot resolve @porter/core
# without them. The dev dependencies it would remove are a few tens of MB.

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
COPY --from=build /app/package.json ./package.json

# Do not run as root.
USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/mcp-server/dist/index.js"]
