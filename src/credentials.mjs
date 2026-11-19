import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function dpapi(mode, input) {
  if (process.platform !== 'win32') throw new Error('This credential store requires Windows DPAPI.');
  const script = fileURLToPath(new URL('../scripts/credential.ps1', import.meta.url));
  // A PowerShell 7 parent can inject modules incompatible with Windows PowerShell 5.
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['psmodulepath', 'psexecutionpolicypreference'].includes(key.toLowerCase())) delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode], {
    env, input, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 128_000
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('Windows credential protection failed.');
  return result.stdout.trim();
}
export function saveToken(file, token) { writeFileSync(file, dpapi('Protect', token), { mode: 0o600 }); }
export function loadToken(file) { return dpapi('Unprotect', readFileSync(file, 'utf8')); }

// Exchange ASCII with Windows PowerShell 5 so emoji and multiline messages round-trip exactly.
export function protectMessage(text) { return dpapi('Protect', Buffer.from(text, 'utf8').toString('base64')); }
export function unprotectMessage(ciphertext) { return Buffer.from(dpapi('Unprotect', ciphertext), 'base64').toString('utf8'); }
