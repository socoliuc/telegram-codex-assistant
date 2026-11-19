import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasStopRequest } from '../src/stop-request.mjs';

test('stop watcher retries partial writes and accepts only its instance nonce', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-stop-'));
  const file = join(dir, 'stop.json');
  try {
    assert.equal(hasStopRequest(file, 'current'), false);
    writeFileSync(file, '{"nonce":');
    assert.equal(hasStopRequest(file, 'current'), false);
    writeFileSync(file, '{"nonce":"previous"}');
    assert.equal(hasStopRequest(file, 'current'), false);
    writeFileSync(file, '{"nonce":"current"}');
    assert.equal(hasStopRequest(file, 'current'), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a Stop pause applies to a new automatic instance even when the stop nonce belongs to its predecessor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-stop-race-'));
  const file = join(dir, 'stop.json');
  const pause = join(dir, 'paused.json');
  try {
    writeFileSync(file, '{"nonce":"previous-instance"}');
    assert.equal(hasStopRequest(file, 'new-instance', pause), false);
    writeFileSync(pause, '{}');
    assert.equal(hasStopRequest(file, 'new-instance', pause), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
