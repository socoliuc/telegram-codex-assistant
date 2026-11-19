import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ContextSync } from '../src/context.mjs';

const projectA = process.platform === 'win32' ? 'D:\\a' : join(tmpdir(), 'tg-context-projects', 'a');
const projectB = process.platform === 'win32' ? 'E:\\b' : join(tmpdir(), 'tg-context-projects', 'b');
const worktreeA = process.platform === 'win32' ? 'C:\\worktrees\\a' : join(tmpdir(), 'tg-worktrees', 'a');
const privateRoot = process.platform === 'win32' ? 'E:\\private' : join(tmpdir(), 'tg-private');

test('context follows project and saved chat changes without resuming desktop chats', async () => {
  let projects = [{ id: 'a', name: 'A', roots: [projectA] }];
  let title = 'Initial work';
  const calls = [];
  const context = new ContextSync({ loadProjects: () => projects, rpc: { async call(method, params) {
    calls.push({ method, params });
    return { data: [{ id: 'desktop', name: title, cwd: projects[0].roots[0], updatedAt: 123 }] };
  } } });
  assert.equal((await context.refresh()).recent[0].name, 'Initial work');
  projects = [{ id: 'b', name: 'B', roots: [projectB] }]; title = 'New work';
  const snapshot = await context.refresh();
  assert.equal(snapshot.projects[0].name, 'B');
  assert.equal(snapshot.recent[0].name, 'New work');
  assert.deepEqual(calls.at(-1).params.cwd, [projectB]);
  assert.ok(calls.every(c => c.method === 'thread/list' && c.params.useStateDbOnly));
  assert.equal(snapshot.mode, 'saved-history-sync');
});

test('failed context refresh retains last known projects but labels the snapshot stale', async () => {
  let fail = false;
  const context = new ContextSync({ loadProjects: () => {
    if (fail) throw new Error('private upstream detail');
    return [{ id: 'a', name: 'A', roots: [projectA] }];
  }, rpc: { async call() { return { data: [] }; } } });
  await context.refresh(); fail = true;
  const snapshot = await context.refresh();
  assert.equal(snapshot.status, 'stale');
  assert.equal(snapshot.projects[0].name, 'A');
  assert.ok(!JSON.stringify(snapshot).includes('private upstream'));
});

test('an empty project list never queries unrelated histories', async () => {
  const context = new ContextSync({ loadProjects: () => [], rpc: { async call() { throw new Error('must not query'); } } });
  assert.equal((await context.refresh()).status, 'fresh');
});

test('live worktree signals map to a registered project through saved session identity', async () => {
  const context = new ContextSync({ loadProjects: () => [{ id: 'a', name: 'A', roots: [projectA] }],
    excludeThreadIds: () => ['owned'],
    loadEvents: () => [
      { id: 'event-1', event: 'PostToolUse', sessionId: 'desktop-session', cwd: worktreeA, receivedAt: new Date().toISOString() },
      { id: 'event-2', event: 'Stop', sessionId: 'unrelated', cwd: privateRoot },
      { id: 'event-3', event: 'Stop', sessionId: 'owned', cwd: projectA }
    ], rpc: { async call() { return { data: [{ id: 'desktop', sessionId: 'desktop-session', name: 'A work', cwd: projectA, updatedAt: 1 }] }; } } });
  const snapshot = await context.refresh();
  assert.equal(snapshot.signals.length, 1);
  assert.equal(snapshot.signals[0].project, 'A');
  assert.equal(snapshot.mode, 'lifecycle-and-saved-history');
  assert.match(snapshot.signalNote, /not proof/i);
});
