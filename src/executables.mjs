import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function requireNativeExecutable(candidate) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate) || !/\.exe$/i.test(candidate) || !existsSync(candidate))
    throw new Error('The Windows pilot requires a native codex.exe, not an npm .cmd/.ps1 shim. Install/use the desktop-bundled CLI.');
  return realpathSync(candidate);
}
