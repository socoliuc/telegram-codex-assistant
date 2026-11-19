#!/bin/sh

set -eu
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/platform.sh"
root=$(telegram_root "$0")
local_dir="$root/.local"
config="$local_dir/config.json"
[ -f "$config" ] || {
  printf '%s\n' 'Run the setup script first.' >&2
  exit 1
}
node_bin=$(telegram_require_node "$root")
mkdir -p "$local_dir/logs"
chmod 700 "$local_dir" "$local_dir/logs"
if [ -e "$local_dir/logs/listener.log" ]; then chmod 600 "$local_dir/logs/listener.log"; fi
rm -f "$local_dir/paused.json"

# The application owns the cross-platform instance lock and shuts down when
# it receives the nonce-bound stop request. Start it detached from this shell.
# The application validates lock ownership and safely reclaims stale locks.
# Let its single-instance guard resolve running and stale PID cases.
nohup "$node_bin" "$root/src/main.mjs" >>"$local_dir/logs/listener.log" 2>&1 </dev/null &
printf 'Assistant launch requested (PID %s). Check Telegram or .local/logs/listener.log.\n' "$!"
