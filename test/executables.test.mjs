import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireNativeExecutable } from '../src/executables.mjs';

test('Windows startup rejects command shims before saving a working configuration', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => requireNativeExecutable('C:\\tools\\codex.cmd'), /native|shim/);
  assert.throws(() => requireNativeExecutable('C:\\tools\\codex.ps1'), /native|shim/);
  assert.throws(() => requireNativeExecutable('codex.exe'), /native|shim/);
  assert.equal(requireNativeExecutable(process.execPath).toLowerCase(), process.execPath.toLowerCase());
});

test('POSIX startup accepts executable Codex files and rejects non-executable files', { skip: process.platform === 'win32' }, () => {
  const folder = mkdtempSync(join(tmpdir(), 'tg-executable-'));
  const executable = join(folder, 'codex');
  try {
    writeFileSync(executable, '#!/bin/sh\nexit 0\n');
    chmodSync(executable, 0o700);
    assert.equal(requireNativeExecutable(executable), realpathSync(executable));
    chmodSync(executable, 0o600);
    assert.throws(() => requireNativeExecutable(executable), /not executable/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
