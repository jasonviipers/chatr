#!/usr/bin/env bash
# Builds the web app for your two addresses and publishes it on Cloudflare (a Worker that serves static files, which
# is free). The custom domain, its DNS record and its certificate are created for you.
#
#   APP_HOST=chat.example.com API_HOST=chat-api.example.com ./deploy-web.sh [worker-name]
#
# First time: `bun x wrangler login` (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID). The domain of APP_HOST
# must be in your Cloudflare account. Set DRY_RUN=1 to build and check everything without publishing.
set -euo pipefail

: "${APP_HOST:?set APP_HOST, the address of the web app (e.g. chat.example.com)}"
: "${API_HOST:?set API_HOST, the address of the API (e.g. chat-api.example.com)}"
NAME="${1:-chatr}"
HERE="$(cd "$(dirname "$0")" && pwd)"

cd "$HERE/../../app"
bun install --frozen-lockfile

# Vite bakes these in at build time
export REACT_APP_HOST="https://${APP_HOST}"
export REACT_APP_API_HOST="https://${API_HOST}"
export REACT_APP_NAME="${REACT_APP_NAME:-Chatr}"
bun run build

cat > "$HERE/wrangler.generated.jsonc" <<JSON
{
  "name": "${NAME}",
  "compatibility_date": "2026-10-01",
  "assets": { "directory": "../../app/build", "not_found_handling": "single-page-application" },
  "routes": [{ "pattern": "${APP_HOST}", "custom_domain": true }]
}
JSON

bun x wrangler deploy --config "$HERE/wrangler.generated.jsonc" ${DRY_RUN:+--dry-run}
