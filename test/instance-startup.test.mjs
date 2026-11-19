import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const quote = value => "'" + value.replaceAll("'", "''") + "'";
function powershell(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

test('start and guardian reject reused PIDs while preserving live and unverifiable locks', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-instance-startup-'));
  try {
    mkdirSync(join(dir, '.local')); mkdirSync(join(dir, 'scripts'));
    for (const name of ['start.ps1', 'watch-codex.ps1', 'instance-status.ps1', 'silent-launcher.ps1'])
      copyFileSync(new URL('../scripts/' + name, import.meta.url), join(dir, 'scripts', name));
    writeFileSync(join(dir, '.local', 'config.json'), '{}');
    const file = join(dir, '.local', 'instance.json');
    const marker = join(dir, 'launched.txt');
    const start = () => powershell(`
      function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle) Set-Content -LiteralPath ${quote(marker)} -Value 'launch' }
      try { & ${quote(join(dir, 'scripts', 'start.ps1'))} } catch { 'inspection-blocked' }
    `);
    writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'live' }));
    assert.match(start(), /already running/);
    assert.equal(existsSync(marker), false);
    utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
    const guardian = JSON.parse(powershell(`& ${quote(join(dir, 'scripts', 'watch-codex.ps1'))} -CheckOnly`));
    assert.equal(guardian.listenerRunning, false);
    assert.notEqual(guardian.status, 'needs-attention');
    assert.match(start(), /launch requested/);
    assert.equal(existsSync(marker), true);
    rmSync(marker);
    writeFileSync(file, '{broken');
    assert.match(start(), /inspection-blocked/);
    assert.equal(existsSync(marker), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
