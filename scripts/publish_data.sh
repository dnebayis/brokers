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
# Scheduled and dispatched indexer runs may overlap for a few minutes (they have separate
# concurrency groups on purpose), and the keeper publishes too, so two publishes can race:
# the second push is rejected as non-fast-forward and, without a retry, that file's update
# is simply lost until the next pass. Re-clone and re-apply, up to three times.
for attempt in 1 2 3; do
  TMP=$(mktemp -d)
  if ! git clone --quiet --depth 1 --branch data "$REMOTE" "$TMP" 2>/dev/null; then
    git init -q "$TMP"
    git -C "$TMP" checkout -q --orphan data
  fi
  cp "$FILE" "$TMP/$DEST"
  # Vercel would otherwise try (and fail) to build this data-only branch on every push:
  # tell it, from the branch itself, that `data` never deploys. Both locations, so the
  # project's root-directory setting does not matter.
  mkdir -p "$TMP/frontend"
  printf '{ "git": { "deploymentEnabled": { "data": false } } }\n' > "$TMP/vercel.json"
  cp "$TMP/vercel.json" "$TMP/frontend/vercel.json"
  git -C "$TMP" config user.name "coattail-keeper"
  git -C "$TMP" config user.email "keeper@coattail.cash"
  git -C "$TMP" add "$DEST" vercel.json frontend/vercel.json
  if git -C "$TMP" diff --cached --quiet; then
    echo "publish_data: $DEST unchanged"
    exit 0
  fi
  git -C "$TMP" commit -qm "data: $DEST $(date -u +%FT%TZ)"
  if git -C "$TMP" push -q "$REMOTE" HEAD:data 2>/dev/null; then
    echo "publish_data: pushed $DEST to data branch"
    exit 0
  fi
  echo "publish_data: push of $DEST rejected (attempt $attempt/3, concurrent publish?); retrying"
  rm -rf "$TMP"
  sleep $((attempt * 5))
done
echo "publish_data: giving up on $DEST after 3 attempts" >&2
exit 1
