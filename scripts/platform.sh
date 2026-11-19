#!/bin/sh

set -eu

telegram_root() {
  CDPATH= cd -- "$(dirname -- "$1")/.." && pwd -P
}

telegram_node() {
  root=$1
  configured=$(node -e "try { process.stdout.write(JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).nodeBin || '') } catch {}" "$root/.local/config.json" 2>/dev/null || true)
  if [ -n "$configured" ] && [ -x "$configured" ]; then
    printf '%s\n' "$configured"
    return
  fi
  command -v node || return 1
}

telegram_require_node() {
  root=$1
  node_bin=$(telegram_node "$root") || {
    printf '%s\n' 'Node.js 24 or newer was not found. Install it and run Setup again.' >&2
    return 1
  }
  version=$("$node_bin" --version)
  major=$(printf '%s\n' "$version" | sed 's/^v//' | cut -d. -f1)
  case "$major" in
    ''|*[!0-9]*) printf 'Could not read the Node.js version: %s\n' "$version" >&2; return 1 ;;
  esac
  if [ "$major" -lt 24 ]; then
    printf 'Node.js 24 or newer is required. Found %s.\n' "$version" >&2
    return 1
  fi
  printf '%s\n' "$node_bin"
}
