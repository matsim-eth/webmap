#!/bin/sh
# Select nginx site config based on PROXY_MODE (dev|deploy).
# Mounted configs live in /etc/nginx/sites/ to avoid collisions
# with the default.conf that nginx ships with.

set -e

MODE="${PROXY_MODE:-dev}"

case "$MODE" in
  deploy|prod|production)
    SRC="/etc/nginx/sites/deploy.conf" ;;
  *)
    SRC="/etc/nginx/sites/dev.conf" ;;
esac

echo "proxy: mode=$MODE  config=$SRC"
cp "$SRC" /etc/nginx/conf.d/default.conf
