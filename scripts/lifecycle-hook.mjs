import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { recordLifecycleEvent, recordDesktopHost } from '../src/lifecycle.mjs';

try {
  process.stdin.setEncoding('utf8');
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > 1024 * 1024) process.exit(0);
  }
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  recordDesktopHost(join(root,'.local','desktop-host.json'));
  recordLifecycleEvent(join(root, '.local', 'events'), JSON.parse(text));
} catch { /* Advisory metadata collection must never block or alter Codex work. */ }
// No output or approval/continuation decisions. Codex continues normally.
