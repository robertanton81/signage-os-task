#!/usr/bin/env bash
# SessionStart hook: put the single next action into context.
#
# CLAUDE.md says "the first unchecked item in TODO.md is the next action", so
# this prints that item with its section and a done/total count. It also warns
# when the working tree has uncommitted changes, which usually means a previous
# session ended before its commit. Never blocks, never edits.
set -uo pipefail

cd "${CLAUDE_PROJECT_DIR:-.}" 2>/dev/null || exit 0

if [ -f TODO.md ]; then
  next=$(awk '
    /^## / { section = $0; sub(/^## /, "", section) }
    /^- \[ \]/ { sub(/^- \[ \] /, ""); print section " -> " $0; exit }
  ' TODO.md)
  done_count=$(grep -c '^- \[x\]' TODO.md)
  total=$(grep -cE '^- \[( |x)\]' TODO.md)
  if [ -n "$next" ]; then
    echo "TODO.md next action (${done_count}/${total} done): ${next}"
  else
    echo "TODO.md: all ${total} items are checked."
  fi
fi

if command -v git >/dev/null 2>&1 && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  dirty=$(git status --porcelain 2>/dev/null | head -5)
  if [ -n "$dirty" ]; then
    echo "WARNING: uncommitted changes in the working tree - a previous session may have ended before committing. Review 'git status' before starting new work."
  fi
fi

exit 0
