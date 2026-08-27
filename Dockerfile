# Node 24 is the floor: the bot uses the built-in `node:sqlite` module, which
# means there is no native module to compile — the same image builds on x86 and
# on the Raspberry Pi's arm64 without a toolchain.
#
# BUILD_FROM lets Home Assistant's add-on builder substitute its own base image
# (see build.yaml) while a plain `docker build` keeps the default. One Dockerfile
# serves both the notebook and the Pi.
ARG BUILD_FROM=node:24-alpine

FROM ${BUILD_FROM} AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM ${BUILD_FROM} AS runtime

WORKDIR /app
ENV NODE_ENV=production

# tini reaps zombies and forwards SIGTERM so `docker stop` shuts the bot down
# cleanly rather than killing it mid-write. su-exec drops root in the entrypoint.
RUN apk add --no-cache tini su-exec

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# The database, WhatsApp credentials and backups all live here. Home Assistant
# mounts its own /data over this, which is why the entrypoint fixes ownership
# at runtime instead of relying on this chown.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
