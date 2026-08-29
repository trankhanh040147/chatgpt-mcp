#!/usr/bin/env bash
# Resolve INPUT_REF to a commit SHA on origin/main history.
# Writes trusted_sha to GITHUB_OUTPUT when set.
set -euo pipefail

REF="${INPUT_REF:-main}"

git fetch origin main --tags

SHA="$(git rev-parse "$REF^{commit}" 2>/dev/null)" || {
  echo "Cannot resolve ref: $REF" >&2
  exit 1
}

if ! git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null; then
  echo "Ref $REF ($SHA) is not on origin/main history" >&2
  exit 1
fi

echo "Trusted ref $REF → $SHA"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "trusted_sha=$SHA" >> "$GITHUB_OUTPUT"
fi
