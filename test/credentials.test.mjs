import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveToken, loadToken } from '../src/credentials.mjs';

test('DPAPI protects and reloads locally without inheriting incompatible PowerShell modules', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-dpapi-'));
  try {
    const file = join(dir, 'credential.dpapi');
    saveToken(file, 'benign-test-credential');
    assert.equal(loadToken(file), 'benign-test-credential');
    assert.ok(!readFileSync(file, 'utf8').includes('benign-test-credential'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
