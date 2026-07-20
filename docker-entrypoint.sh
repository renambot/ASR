#!/bin/sh
# Launch uvicorn the same way GO does, driven by env vars.
# Optional TLS: mount cert/key into the container and set SSL_CERT / SSL_KEY
# to their in-container paths (mic access off localhost requires https,
# either here or via a reverse proxy in front).
set -e

PORT="${PORT:-8080}"
set -- uvicorn server:app --host 0.0.0.0 --port "$PORT"

if [ -n "${SSL_CERT:-}" ] && [ -n "${SSL_KEY:-}" ]; then
  set -- "$@" --ssl-certfile "$SSL_CERT" --ssl-keyfile "$SSL_KEY"
fi

exec "$@"
