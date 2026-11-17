#!/bin/sh
# Odyssey Panel container entrypoint:
#   1. apply the Prisma schema to the SQLite file on /data
#   2. start the Next.js standalone server
set -e
DB_PATH="${DATABASE_URL#file:}"
DB_DIR="$(dirname "$DB_PATH")"
mkdir -p "$DB_DIR"
echo "[odyssey] applying database schema to $DB_PATH ..."
node node_modules/prisma/build/index.js db push --skip-generate --accept-data-loss >/dev/null
echo "[odyssey] starting panel on port ${PORT:-3000} ..."
exec node server.js
