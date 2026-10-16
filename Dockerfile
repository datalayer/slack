# @Datalayer for Slack: the Bolt service (plans/SLACK.md §10, S-101).
# Built from a clean export of this repository (git archive), never a
# working tree. The exact versions of package.json are installed; no
# lockfile is read (the monorepo keeps none).

FROM node:20.19-bookworm-slim AS build
WORKDIR /app
COPY package.json ./
RUN npm install --ignore-scripts --no-audit --no-fund --no-package-lock
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:20.19-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock \
  && npm cache clean --force
COPY --from=build /app/lib ./lib
COPY migrations ./migrations
COPY manifests ./manifests
COPY scripts/migrate.mjs ./scripts/migrate.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "lib/index.js"]
