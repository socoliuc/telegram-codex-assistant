import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function ownerIsStale(file, pid) {
  try { process.kill(pid, 0); }
  catch (e) { if (e.code === 'ESRCH') return true; }
  if (process.platform !== 'win32') return false;
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['psmodulepath', 'psexecutionpolicypreference'].includes(key.toLowerCase())) delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('../scripts/instance-status.ps1', import.meta.url)), '-LockPath', file],
  { env, encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 128000 });
  // Inspection failures preserve the lock; they never authorize takeover.
  return result.status === 0 && result.stdout.trim() === 'stale';
}

export function acquireInstance(file) {
  // Protect the complete read/check/unlink/create sequence, not just final creation.
  // A crash while holding this short guard requires local inspection; never steal it.
  const guard = file + '.guard';
  const guardNonce = randomBytes(16).toString('hex');
  try { writeFileSync(guard, JSON.stringify({ pid: process.pid, nonce: guardNonce }), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if (e.code === 'EEXIST') throw new Error('Another startup/recovery guard exists. Inspect it locally before restarting.');
    throw e;
  }
  try {
    if (existsSync(file)) {
      const old = JSON.parse(readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(old.pid) || old.pid <= 0) throw new Error('Invalid instance PID; inspect the lock before restarting.');
      if (!ownerIsStale(file, old.pid)) throw new Error('The assistant is already running or its owner could not be verified.');
      unlinkSync(file);
    }
    const lock = { pid: process.pid, nonce: randomBytes(16).toString('hex') };
    writeFileSync(file, JSON.stringify(lock), { flag: 'wx', mode: 0o600 });
    return { ...lock, release() {
      if (existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).nonce === lock.nonce) unlinkSync(file);
    } };
  } finally {
    if (existsSync(guard) && JSON.parse(readFileSync(guard, 'utf8')).nonce === guardNonce) unlinkSync(guard);
  }
}
