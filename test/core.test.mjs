import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { isOwner, rootsOverlap, isWithinRoots, redact, splitText, claimUpdate } from '../src/core.mjs';

test('only the paired human in their private chat can issue instructions', () => {
  const owner = { userId: 123, chatId: 123 };
  assert.equal(isOwner({ from: { id: 123 }, chat: { id: 123, type: 'private' } }, owner), true);
  for (const message of [
    { from: { id: 456 }, chat: { id: 123, type: 'private' } },
    { from: { id: 123 }, chat: { id: -10, type: 'group' } },
    { from: { id: 123, is_bot: true }, chat: { id: 123, type: 'private' } },
    { from: { id: 123 }, chat: { id: 123, type: 'private' }, forward_origin: {} },
    { from: { id: 123 }, chat: { id: 123, type: 'private' }, sender_chat: { id: 123 } }
  ]) assert.equal(isOwner(message, owner), false);
});

test('project roots use the current operating system path rules', () => {
  if (process.platform === 'win32') {
    assert.equal(rootsOverlap(['D:\\Projects'], ['d:\\projects\\example.test']), true);
    assert.equal(rootsOverlap(['D:\\Projects\\foo'], ['D:\\Projects\\foobar']), false);
    assert.equal(rootsOverlap(['D:\\Projects'], ['E:\\Projects']), false);
    assert.equal(isWithinRoots('D:\\Projects\\site', ['D:\\Projects']), true);
    assert.equal(isWithinRoots('D:\\Projects2', ['D:\\Projects']), false);
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'tg-roots-'));
    try {
      const parent = join(dir, 'Projects');
      const child = join(parent, 'example.test');
      const sibling = join(dir, 'Projects2');
      assert.equal(rootsOverlap([parent], [child]), true);
      assert.equal(rootsOverlap([parent], [sibling]), false);
      assert.equal(isWithinRoots(child, [parent]), true);
      assert.equal(isWithinRoots(sibling, [parent]), false);
      assert.equal(isWithinRoots('/tmp', ['/']), true);
      assert.equal(isWithinRoots('/tmp2', ['/tmp']), false);
      assert.equal(rootsOverlap(['/'], ['/tmp']), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test('state persists claims before effects and recovers in-flight jobs without replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-codex-test-'));
  try {
    const first = new StateStore(join(dir, 'state.json'));
    assert.equal(claimUpdate(first, 42), true);
    assert.equal(claimUpdate(first, 42), false);
    first.data.jobs.a = { status: 'dispatching', threadId: 't1' };
    first.data.jobs.b = { status: 'completed' };
    first.data.jobs.c = { status: 'stopping', threadId: 't3' };
    first.save();
    const second = new StateStore(join(dir, 'state.json'));
    assert.equal(second.data.offset, 43);
    assert.equal(second.recover().length, 2);
    assert.equal(second.data.jobs.a.status, 'interrupted');
    assert.equal(second.data.jobs.b.status, 'completed');
    assert.equal(second.data.jobs.c.status, 'interrupted');
    assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'))).jobs.a.status, 'interrupted');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('outbound text removes known tokens and common credential forms', () => {
  const fakeApiKey = 'sk-proj-' + 'x'.repeat(24);
  const fakeBotToken = '123456:' + 'z'.repeat(26);
  assert.equal(redact(`token SECRET then ${fakeApiKey} and ${fakeBotToken}`, ['SECRET']),
    'token [REDACTED] then [REDACTED] and [REDACTED]');
  assert.equal(redact('Authorization: Bearer abc.def.ghi'), 'Authorization: Bearer [REDACTED]');
});

test('Telegram chunks preserve Unicode and stay within its UTF-16 limit', () => {
  const text = '🙂'.repeat(2400);
  const chunks = splitText(text, 3900);
  assert.equal(chunks.join(''), text);
  assert.ok(chunks.every(c => c.length <= 3900 && !/[\uD800-\uDBFF]$/.test(c)));
});
