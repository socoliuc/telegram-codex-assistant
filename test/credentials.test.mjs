import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { saveToken, loadToken, deleteToken, protectMessage, unprotectMessage } from '../src/credentials.mjs';

test('DPAPI protects and reloads locally without inheriting incompatible PowerShell modules', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-dpapi-'));
  try {
    const file = join(dir, 'credential.dpapi');
    saveToken(file, 'benign-test-credential');
    assert.equal(loadToken(file), 'benign-test-credential');
    assert.ok(!readFileSync(file, 'utf8').includes('benign-test-credential'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('macOS Keychain or Linux Secret Service stores credentials and encrypted reply text', {
  skip: !['darwin', 'linux'].includes(process.platform) || (process.platform === 'linux' && !process.env.DBUS_SESSION_BUS_ADDRESS)
}, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-secure-'));
  const file = join(dir, 'token-reference');
  const token = 'synthetic-test-token-only';
  try {
    saveToken(file, token);
    assert.equal(loadToken(file), token);
    const source = 'Reply text with unicode 🧭';
    const encrypted = protectMessage(source);
    assert.notEqual(encrypted, source);
    assert.equal(unprotectMessage(encrypted), source);
    assert.throws(() => unprotectMessage(encrypted.slice(0, -4)), /authenticate|invalid/i);
  } finally {
    deleteToken(file);
    rmSync(dir, { recursive: true, force: true });
  }
});
