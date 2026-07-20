#!/usr/bin/env bash
# Smoke test against a running `wrangler dev` instance (contract §7 item 6).
# Usage: bash scripts/smoke.sh [base-url]   (default http://127.0.0.1:8787)
set -euo pipefail

BASE="${1:-http://127.0.0.1:8787}"
JAR="$(mktemp)"
trap 'rm -f "$JAR"' EXIT

echo "== dev login (maintainer)"
curl -sf -c "$JAR" -X POST "$BASE/v1/dev/login" \
  -H 'Content-Type: application/json' \
  -d '{"login":"smoke-maintainer","role":"maintainer"}' | head -c 400
echo

echo "== GET /v1/me"
curl -sf -b "$JAR" "$BASE/v1/me" | head -c 400
echo

PROJECT_SLUG="${PROJECT_SLUG:-hollow-creek-anomaly}"
echo "== GET /v1/projects/$PROJECT_SLUG"
curl -sf -b "$JAR" "$BASE/v1/projects/$PROJECT_SLUG" | head -c 400
echo

echo "== GET chapters"
curl -sf -b "$JAR" "$BASE/v1/projects/$PROJECT_SLUG/chapters" | head -c 400
echo

echo "== anonymous request is rejected (expect 401)"
STATUS=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/me")
test "$STATUS" = "401"
echo "401 OK"

echo "smoke: all checks passed"
