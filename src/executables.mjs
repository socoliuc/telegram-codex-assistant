import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export function requireNativeExecutable(candidate) {
  if (typeof candidate !== 'string' || !isAbsolute(candidate) || !existsSync(candidate))
    throw new Error('Codex must resolve to an absolute installed native executable, not a command shim.');
  if (process.platform === 'win32' && !/\.exe$/i.test(candidate))
    throw new Error('Use the native Codex executable, not an npm .cmd/.ps1 shim.');
  if (process.platform !== 'win32') {
    try { accessSync(candidate, constants.X_OK); }
    catch { throw new Error('The configured Codex file is not executable.'); }
  }
  return realpathSync(candidate);
}
