#!/usr/bin/env bash
# SessionStart hook: report uncommitted changes from the repository root.
set -uo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
cd "$repo_root" || exit 0

dirty=$(git status --porcelain 2>/dev/null | head -5)
if [ -n "$dirty" ]; then
  echo "WARNING: uncommitted changes in the working tree. Review 'git status' before starting new work."
fi

exit 0
