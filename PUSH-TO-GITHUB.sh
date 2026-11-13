#!/bin/bash
# ── Odyssey Panel — Cloudflare edition · push to GitHub ──────────────
# Creates the GitHub repo (private) and pushes this project with history.
# Usage:  bash PUSH-TO-GITHUB.sh <github-personal-access-token> [org-or-user]
#
# Token needs: repo scope (classic) or Contents+Administration write (fine-grained).
# The token is used only in this process and is never written to any file.
set -euo pipefail

TOKEN="${1:-}"
OWNER="${2:-}"
REPO_NAME="Odyssey-Panel-Cloudflare"

if [ -z "$TOKEN" ]; then
  read -r -p "GitHub Personal Access Token: " TOKEN
fi
if [ -z "$OWNER" ]; then
  read -r -p "GitHub user or org name (default: Odyssey-panel): " OWNER
  OWNER="${OWNER:-Odyssey-panel}"
fi

GH="https://api.github.com"
auth=(-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json")

echo "→ creating repository $OWNER/$REPO_NAME (private) …"
resp=$(curl -sS -X POST "$GH/orgs/$OWNER/repos" "${auth[@]}" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"$REPO_NAME\",\"private\":true,\"description\":\"Odyssey Panel — Cloudflare Workers + D1 edition\"}" || true)

if ! printf '%s' "$resp" | grep -q '"full_name"'; then
  echo "  org path failed ($(printf '%s' "$resp" | python3 -c 'import sys,json;print(json.load(sys.stdin).get("message","?"))' 2>/dev/null || echo '?')), trying user account …"
  resp=$(curl -sS -X POST "$GH/user/repos" "${auth[@]}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"$REPO_NAME\",\"private\":true,\"description\":\"Odyssey Panel — Cloudflare Workers + D1 edition\"}")
fi

FULL=$(printf '%s' "$resp" | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("full_name",""))')
if [ -z "$FULL" ]; then
  # maybe the repo already exists — use it as-is
  FULL="$OWNER/$REPO_NAME"
  echo "  → assuming existing repo: $FULL"
fi

echo "→ pushing main to $FULL …"
git remote remove cf 2>/dev/null || true
git remote add cf "https://x-access-token:${TOKEN}@github.com/${FULL}.git"
git push cf main 2>&1 | sed -E 's#https://[^@]+@#https://[REDACTED]@#g'

echo
echo "✅ Done: https://github.com/$FULL"
echo "   Next: read DEPLOY-CF.md for the Cloudflare deployment."
