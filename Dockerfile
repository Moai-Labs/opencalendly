FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY entrypoint.sh ./entrypoint.sh
RUN apk add --no-cache su-exec \
    && chmod 0755 entrypoint.sh \
    && mkdir -p /data \
    && chown node:node /data
ENV NODE_ENV=production PORT=3000 DATA_DIR=/data
EXPOSE 3000
# Start as root only to make a freshly mounted volume writable, then drop to the
# unprivileged "node" user before running the server.
ENTRYPOINT ["/app/entrypoint.sh"]
