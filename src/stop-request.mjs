import { readFileSync, existsSync } from 'node:fs';

export function hasStopRequest(file, nonce, pauseFile) {
  if (pauseFile && existsSync(pauseFile)) return true;
  try { return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')).nonce === nonce; }
  catch { return false; } // A writer may still be publishing the request; retry next tick.
}
