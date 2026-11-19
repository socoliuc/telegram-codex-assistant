import test from 'node:test';
import assert from 'node:assert/strict';
import { requireNativeExecutable } from '../src/executables.mjs';

test('Windows startup rejects command shims before saving a working configuration', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => requireNativeExecutable('C:\\tools\\codex.cmd'), /native|shim/);
  assert.throws(() => requireNativeExecutable('C:\\tools\\codex.ps1'), /native|shim/);
  assert.throws(() => requireNativeExecutable('codex.exe'), /native|shim/);
  assert.equal(requireNativeExecutable(process.execPath).toLowerCase(), process.execPath.toLowerCase());
});
