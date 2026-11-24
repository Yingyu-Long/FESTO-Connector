#!/usr/bin/env bash
set -euo pipefail

deploy_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd "$deploy_dir/.." && pwd)"
platform="${1:-linux/amd64}"
app_image="festo-connector:1.0.2"
db_image="postgres:17-bookworm"
archive="$deploy_dir/festo-connector-images.tar"

case "$platform" in
  linux/amd64|linux/arm64) ;;
  *) echo "Usage: bash deploy/build.sh [linux/amd64|linux/arm64]" >&2; exit 1 ;;
esac

docker info >/dev/null
docker compose version
docker buildx build --platform "$platform" --load --tag "$app_image" "$project_dir"
if [[ "$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$db_image" 2>/dev/null || true)" != "$platform" ]]; then
  docker pull --platform "$platform" "$db_image"
fi

# Atomic replacement leaves the previous delivery archive intact if export fails.
trap 'rm -f "$archive.partial"' EXIT
docker image save --platform "$platform" --output "$archive.partial" "$app_image" "$db_image"
mv "$archive.partial" "$archive"

if [[ ! -f "$deploy_dir/.env" ]]; then
  umask 077
  password="$(docker run --rm --platform "$platform" --entrypoint node "$app_image" -e "console.log(require('node:crypto').randomBytes(24).toString('hex'))")"
  printf 'POSTGRES_PASSWORD=%s\nAPP_PORT=8080\nDEPLOY_PLATFORM=%s\n' "$password" "$platform" > "$deploy_dir/.env"
else
  echo 'Existing deploy/.env preserved. Ensure DEPLOY_PLATFORM matches the new image.'
fi

docker run --rm --platform "$platform" \
  --mount "type=bind,source=$deploy_dir,target=/delivery" \
  --entrypoint sha256sum "$app_image" \
  /delivery/festo-connector-images.tar | sed 's|/delivery/||' > "$archive.sha256"
echo "Ready: $archive ($platform). Deliver the deploy folder to the customer."
