# Node 24 is the floor: the bot uses the built-in `node:sqlite` module, which
# means there is no native module to compile — the same image builds on x86 and
# on the Raspberry Pi's arm64 without a toolchain.
FROM node:24-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build


FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

# tini reaps zombies and forwards SIGTERM, so `docker stop` shuts the bot down
# cleanly instead of killing it mid-write.
RUN apk add --no-cache tini

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# The database, WhatsApp credentials and payment proofs all live here.
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATA_DIR=/data
VOLUME ["/data"]

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.WEB_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
