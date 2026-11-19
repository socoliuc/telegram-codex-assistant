import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { claimUpdate } from '../src/core.mjs';

test('a short Windows read lock does not drop a Telegram update claim', { skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-state-lock-'));
  try {
    const store = new StateStore(join(dir, 'state.json'));
    store.save();
    const reader = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      "$ErrorActionPreference = 'Stop'",
      "$handle = [IO.File]::OpenRead((Join-Path (Get-Location) 'state.json'))",
      'try {',
      "  [Console]::WriteLine('locked')",
      '  $limit = [DateTime]::UtcNow.AddSeconds(10)',
      "  while (![IO.Directory]::GetFiles((Get-Location), 'state.json.*.tmp').Length) {",
      "    if ([DateTime]::UtcNow -gt $limit) { throw 'The save never started' }",
      '    Start-Sleep -Milliseconds 10',
      '  }',
      '  Start-Sleep -Milliseconds 350',
      '} finally { $handle.Dispose() }'
    ].join('\n')], { cwd: dir, windowsHide: true });
    const closed = once(reader, 'close');
    try {
      for await (const chunk of reader.stdout) {
        assert.match(chunk.toString(), /locked/);
        assert.equal(claimUpdate(store, 42), true);
        break;
      }
    } finally {
      const [code] = await closed;
      assert.equal(code, 0);
    }
    const reloaded = new StateStore(store.file);
    assert.equal(reloaded.data.offset, 43);
    assert.equal(claimUpdate(reloaded, 42), false);
    assert.deepEqual(readdirSync(dir), ['state.json']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
