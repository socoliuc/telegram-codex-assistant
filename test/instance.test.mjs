import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireInstance } from '../src/instance.mjs';

test('a competing startup guard prevents stale-lock reclamation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-instance-'));
  const file = join(dir, 'instance.json');
  try {
    writeFileSync(file, JSON.stringify({ pid: 2147483647, nonce: 'old' }));
    writeFileSync(file + '.guard', JSON.stringify({ pid: process.pid, nonce: 'another-startup' }));
    assert.throws(() => acquireInstance(file), /startup|recovery|guard/i);
    assert.equal(JSON.parse(readFileSync(file)).nonce, 'old');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('duplicate launches preserve the live owner and release only their own lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-instance-'));
  const file = join(dir, 'instance.json');
  try {
    const first = acquireInstance(file);
    assert.throws(() => acquireInstance(file), /already running/i);
    assert.equal(JSON.parse(readFileSync(file)).nonce, first.nonce);
    first.release();
    assert.equal(existsSync(file), false);
    assert.equal(existsSync(file + '.guard'), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a reused live PID cannot keep a lock created before that process started', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-instance-'));
  const file = join(dir, 'instance.json');
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, nonce: 'previous-process' }));
    utimesSync(file, new Date('2020-01-01'), new Date('2020-01-01'));
    const reclaimed = acquireInstance(file);
    assert.notEqual(reclaimed.nonce, 'previous-process');
    assert.doesNotThrow(() => process.kill(process.pid, 0), 'recovery must never kill the reused PID');
    reclaimed.release();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
