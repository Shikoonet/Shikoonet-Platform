#!/bin/sh
set -e

mkdir -p /app/logs /app/sessions

echo "Running database migrations..."
uv run alembic upgrade head

exec "$@"
