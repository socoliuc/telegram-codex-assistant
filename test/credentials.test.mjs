import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
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
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-secure-'));
  const file = join(dir, 'token-reference');
  const token = 'synthetic-test-token-only';
  try {
    saveToken(file, token);
    assert.equal(loadToken(file), token);
    const source = 'Reply text with unicode 🧭';
    const moduleUrl = new URL('../src/credentials.mjs', import.meta.url).href;
    const childSource = `import { protectMessage } from '${moduleUrl}'; process.stdout.write(protectMessage(${JSON.stringify(source)}));`;
    const children = [0, 1].map(() => spawn(process.execPath, ['--input-type=module', '--eval', childSource], {
      cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'pipe', 'pipe']
    }));
    const ciphertexts = await Promise.all(children.map(async child => {
      let output = '';
      let error = '';
      child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
      child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; });
      const [code] = await once(child, 'close');
      assert.equal(code, 0, error);
      return output;
    }));
    for (const encrypted of ciphertexts) {
      assert.notEqual(encrypted, source);
      assert.equal(unprotectMessage(encrypted), source);
      assert.throws(() => unprotectMessage(encrypted.slice(0, -4)), /authenticate|invalid/i);
    }
  } finally {
    deleteToken(file);
    rmSync(dir, { recursive: true, force: true });
  }
});
