#!/bin/sh

set -eu
umask 077
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
. "$script_dir/platform.sh"
root=$(telegram_root "$0")
local_dir="$root/.local"
mkdir -p "$local_dir"
chmod 700 "$local_dir"
node_bin=$(telegram_require_node "$root")
lock="$local_dir/instance.json"

if [ ! -f "$lock" ]; then
  printf '%s\n' 'Assistant is not running.'
  exit 0
fi

result=$("$node_bin" --input-type=module - "$lock" "$local_dir/stop.json" "$local_dir/paused.json" <<'NODE'
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const [lockPath, stopPath, pausePath] = process.argv.slice(2);
let current;
try {
  current = JSON.parse(readFileSync(lockPath, 'utf8'));
  if (!Number.isSafeInteger(current.pid) || current.pid <= 0 || typeof current.nonce !== 'string') throw new Error('Invalid lock');
} catch {
  console.error('The instance lock is unreadable. Inspect .local/instance.json.');
  process.exit(2);
}
try {
  process.kill(current.pid, 0);
} catch (error) {
  if (error.code !== 'ESRCH') throw error;
  // Only the guarded startup path reclaims stale locks.
  process.stdout.write('stale');
  process.exit(0);
}
for (const [destination, value] of [[stopPath, { nonce: current.nonce }], [pausePath, { pausedAt: new Date().toISOString() }]]) {
  const temporary = destination + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, destination);
}
process.stdout.write('running');
NODE
 ) || exit $?

if [ "$result" = stale ]; then
  printf '%s\n' 'Assistant is not running. Start will reclaim the stale lock.'
  exit 0
fi

printf '%s\n' 'Graceful stop requested. Waiting for the listener to release its lock.'
attempt=0
while [ -f "$lock" ] && [ "$attempt" -lt 30 ]; do
  sleep 1
  attempt=$((attempt + 1))
done
if [ -f "$lock" ]; then
  printf '%s\n' 'The listener has not released its lock yet. Check .local/logs/listener.log.' >&2
  exit 1
fi
printf '%s\n' 'Assistant stopped.'
