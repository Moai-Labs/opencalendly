#!/bin/sh
# A freshly mounted volume root may be owned by root; make it writable by the
# unprivileged user the server runs as, then drop privileges.
DATA_DIR="${DATA_DIR:-/data}"
mkdir -p "$DATA_DIR"
chown node:node "$DATA_DIR" 2>/dev/null || true
exec su-exec node:node node server.js
