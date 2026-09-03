#!/usr/bin/env bash
# Publish one JSON file to the repository's `data` branch, where the site reads it from
# raw.githubusercontent.com (no redeploy, no database). Machine commits only: the branch
# is orphaned from the code and no workflow triggers on it.
#   scripts/publish_data.sh <local file> <name on the data branch>
set -euo pipefail
FILE=${1:?local file}
DEST=${2:?destination name}
REPO=${GITHUB_REPOSITORY:?}
TOKEN=${GITHUB_TOKEN:?}
REMOTE="https://x-access-token:${TOKEN}@github.com/${REPO}.git"
TMP=$(mktemp -d)
if ! git clone --quiet --depth 1 --branch data "$REMOTE" "$TMP" 2>/dev/null; then
  git init -q "$TMP"
  git -C "$TMP" checkout -q --orphan data
fi
cp "$FILE" "$TMP/$DEST"
cd "$TMP"
git config user.name "coattail-keeper"
git config user.email "keeper@coattail.cash"
git add "$DEST"
if git diff --cached --quiet; then
  echo "publish_data: $DEST unchanged"
  exit 0
fi
git commit -qm "data: $DEST $(date -u +%FT%TZ)"
git push -q "$REMOTE" HEAD:data
echo "publish_data: pushed $DEST to data branch"
