#!/usr/bin/env bash
# Builds the web app for your two addresses and uploads it to Cloudflare Pages.
#
#   APP_HOST=chat.example.com API_HOST=chat-api.example.com ./deploy-pages.sh [pages-project-name]
#
# First time: `bun x wrangler login` (or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID). The project is
# created if it does not exist. Add APP_HOST as the project's custom domain afterwards (see README.md).
set -euo pipefail

: "${APP_HOST:?set APP_HOST, the address of the web app (e.g. chat.example.com)}"
: "${API_HOST:?set API_HOST, the address of the API (e.g. chat-api.example.com)}"
PROJECT="${1:-chatr}"

cd "$(dirname "$0")/../../app"
bun install --frozen-lockfile

# Vite bakes these in at build time
export REACT_APP_HOST="https://${APP_HOST}"
export REACT_APP_API_HOST="https://${API_HOST}"
export REACT_APP_NAME="${REACT_APP_NAME:-Chatr}"
bun run build

bun x wrangler pages project create "$PROJECT" --production-branch main 2>/dev/null || true
bun x wrangler pages deploy build --project-name "$PROJECT" --branch main
