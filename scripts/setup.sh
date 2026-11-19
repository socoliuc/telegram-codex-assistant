#!/bin/sh

set -eu
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/platform.sh"
root=$(telegram_root "$0")
node_bin=$(telegram_require_node "$root")
cd "$root"
exec "$node_bin" "$root/src/setup.mjs"
