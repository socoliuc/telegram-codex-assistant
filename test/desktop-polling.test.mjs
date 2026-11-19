import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DesktopTools } from '../src/desktop-tools.mjs';
import { DesktopMonitor } from '../src/desktop.mjs';
import { StateStore } from '../src/state.mjs';

function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'desktop-polling-'));
  const store = new StateStore(join(dir, 'state.json'));
  let time = Date.now() + 1000, lists = 0;
  const histories = new Map(), reads = [], polls = [];
  const tools = {
    async list() { lists++; return [...histories.values()].map(h => ({ ...h.thread, status: h.thread.status.type })); },
    async poll(targets) {
      polls.push(structuredClone(targets));
      return { polls: targets.map(t => {
        const h = histories.get(t.threadId), cursor = JSON.stringify(h);
        return { thread: { id: t.threadId, hostId: 'local', status: h.thread.status },
          latestTurn: { id: h.turns[0].id, status: h.turns[0].status }, cursor, changed: cursor !== t.afterCursor };
      }) };
    },
    async read(id, hostId, options) {
      reads.push({ id, options });
      return { ...structuredClone(histories.get(id)), turns: structuredClone(histories.get(id).turns.slice(0, options?.turnLimit || 10)) };
    }
  };
  const monitor = new DesktopMonitor({ tools, store, send: async () => [], loadProjects: () => [],
    now: () => time, minimumScanMs: 0, ...options });
  monitor.inbox.now = () => time;
  const put = (id, status = 'inProgress') => {
    const h = { thread: { id, title: id, cwd: 'D:\\a', updatedAt: time / 1000,
      status: { type: status === 'inProgress' ? 'active' : 'idle', activeFlags: [] } },
      turns: [{ id: 'turn-' + id, status, startedAt: time / 1000, items: [] }] };
    histories.set(id, h); return h;
  };
  return { dir, store, tools, monitor, histories, reads, polls, put,
    get lists() { return lists; }, advance(ms) { time += ms; }, cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}

test('background reads request only the latest turn and never retry an oversized single turn', async () => {
  const tools = new DesktopTools({}), calls = [];
  tools.call = async (name, args) => { calls.push(args); throw new Error('Thread history exceeds the read size limit'); };
  await assert.rejects(tools.read('long', 'local', { turnLimit: 1 }), /size limit/);
  assert.deepEqual(calls.map(c => c.turnLimit), [1]);
});

test('compact status polling batches at most eight targets and preserves cursors', async () => {
  const tools = new DesktopTools({}), calls = [];
  tools.call = async (name, args) => { calls.push({ name, args }); return { polls: args.targets.map(t => ({ thread: { id: t.threadId }, cursor: 'new' })), errors: [] }; };
  const result = await tools.poll(Array.from({ length: 19 }, (_, i) => ({ threadId: String(i), hostId: 'local', afterCursor: 'old-' + i })));
  assert.equal(result.polls.length, 19);
  assert.deepEqual(calls.map(c => c.args.targets.length), [8, 8, 3]);
  assert.ok(calls.every(c => c.name === 'wait_threads' && c.args.timeoutMs === 0));
  assert.equal(calls[1].args.targets[0].afterCursor, 'old-8');
});

test('discovery is limited to twenty recent local chats', async () => {
  const tools = new DesktopTools({}); let requested;
  tools.call = async (name, args) => { requested = args; return { threads: [], pinnedThreads: [] }; };
  await tools.list(); assert.equal(requested.limit, 20);
});

test('compact polling collects remaining targets after the native wait wakes for just one chat', async () => {
  const tools = new DesktopTools({}); let calls = 0;
  tools.call = async (name, args) => {
    calls++;
    return { polls: [{ thread: { id: args.targets[0].threadId }, cursor: 'ready' }], wake: { reason: 'completed' } };
  };
  const result = await tools.poll(Array.from({ length: 5 }, (_, i) => ({ threadId: String(i), hostId: 'local' })));
  assert.deepEqual(result.polls.map(p => p.thread.id), ['0', '1', '2', '3', '4']);
  assert.equal(calls, 5);
});

test('a partial status response with no target progress remains bounded', async () => {
  const tools = new DesktopTools({}); let calls = 0;
  tools.call = async () => { calls++; return { polls: [], errors: [] }; };
  const result = await tools.poll([{ threadId: 'missing', hostId: 'local' }]);
  assert.equal(calls, 1); assert.equal(result.errors[0].threadId, 'missing');
});

test('an unchanged active chat is not reread even after the old one-minute expiry', async () => {
  const f = fixture(); try {
    f.put('long'); await f.monitor.scan();
    for (let i = 0; i < 10; i++) { f.advance(65_000); await f.monitor.scan(); }
    assert.equal(f.reads.length, 1);
    assert.equal(f.reads[0].options.turnLimit, 1);
    assert.ok(f.polls[1][0].afterCursor);
  } finally { f.cleanup(); }
});

test('unchanged inactive chats never reach the history-bearing status API', async () => {
  const f = fixture(); try {
    f.put('quiet', 'completed'); await f.monitor.scan();
    assert.equal(f.polls.flat().length, 1);
    for (let i = 0; i < 10; i++) { f.advance(65_000); await f.monitor.scan(); }
    assert.equal(f.polls.flat().length, 1);
    assert.equal(f.reads.length, 1);
  } finally { f.cleanup(); }
});

test('old catalog rows and old lifecycle records cannot cause background history reads', async () => {
  const f = fixture(); try {
    const old = f.put('old', 'completed'); old.thread.updatedAt -= 31 * 60;
    f.monitor.loadEvents = () => [{ id: 'stale-hook', sessionId: 'old', receivedAt: new Date(Date.now() - 31 * 60_000).toISOString() }];
    f.put('recent', 'completed'); await f.monitor.scan();
    assert.deepEqual(f.polls.flat().map(t => t.threadId), ['recent']);
    assert.deepEqual(f.reads.map(t => t.id), ['recent']);
    assert.equal(f.monitor.health.skippedOld, 1);
  } finally { f.cleanup(); }
});

test('a fresh lifecycle event admits an old chat without following older history', async () => {
  const f = fixture(); try {
    const old = f.put('old'); old.thread.updatedAt -= 31 * 60;
    f.monitor.loadEvents = () => [{ id: 'fresh-hook', sessionId: 'old', turnId: 'turn-old', receivedAt: new Date().toISOString() }];
    await f.monitor.scan();
    assert.deepEqual(f.reads.map(t => t.id), ['old']);
    assert.equal(f.reads[0].options.turnLimit, 1);
  } finally { f.cleanup(); }
});

test('the scan budget bounds status hydration as well as explicit history reads', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 10; i++) f.put('chat-' + i, 'completed');
    await f.monitor.scan(); assert.equal(f.polls[0].length, 4);
    await f.monitor.scan(); await f.monitor.scan();
    assert.equal(f.polls.flat().length, 10);
    assert.equal(f.reads.length, 10);
  } finally { f.cleanup(); }
});

test('a changed native waiting state is read without a metadata timestamp change', async () => {
  const f = fixture(); try {
    const h = f.put('question'); await f.monitor.scan();
    h.thread.status.activeFlags = ['waitingOnApproval'];
    await f.monitor.scan();
    assert.equal(f.reads.length, 2);
    assert.equal(f.monitor.inbox.list().length, 1);
  } finally { f.cleanup(); }
});

test('unchanged snapshots keep saved requests fresh without recreating or rereading them', async () => {
  const f = fixture(); try {
    const h = f.put('waiting'); h.thread.status.activeFlags = ['waitingOnApproval'];
    await f.monitor.scan(); const item = f.monitor.inbox.list()[0], originalAt = item.createdAt;
    f.advance(30 * 60_000); await f.monitor.scan();
    assert.equal(f.reads.length, 1);
    assert.equal(item.createdAt, originalAt);
    assert.equal(item.observedAt, f.monitor.inbox.now());
  } finally { f.cleanup(); }
});

test('expired active metadata cannot renew a native request observation', async () => {
  const f = fixture(); try {
    const h = f.put('waiting'); h.thread.status.activeFlags = ['waitingOnApproval'];
    await f.monitor.scan(); const item = f.monitor.inbox.list()[0], observedAt = item.observedAt;
    f.advance(31 * 60_000); h.thread.status.activeFlags = [];
    await f.monitor.scan();
    assert.equal(item.observedAt, observedAt);
    assert.equal(f.polls.flat().length, 1);
  } finally { f.cleanup(); }
});

test('an explicitly due old reminder verifies its source and cannot revive a cleared request', async () => {
  const f = fixture(); try {
    const h = f.put('waiting'); h.thread.status.activeFlags = ['waitingOnApproval'];
    await f.monitor.scan(); const item = f.monitor.inbox.list()[0];
    assert.equal(f.monitor.inbox.snooze(item.id), true);
    f.advance(60 * 60_000); h.thread.status.activeFlags = [];
    await f.monitor.scan();
    assert.equal(f.polls.flat().length, 2);
    assert.equal(item.status, 'resolved');
  } finally { f.cleanup(); }
});

test('failed reads back off despite progress changes and recover immediately for a new turn', async () => {
  const f = fixture(); try {
    const h = f.put('long'); let attempts = 0;
    f.tools.read = async () => { attempts++; throw new Error('Thread history exceeds the read size limit'); };
    await f.monitor.scan();
    for (let i = 0; i < 5; i++) { f.advance(1000); h.thread.updatedAt++; await f.monitor.scan(); }
    assert.equal(attempts, 1);
    assert.equal(f.polls.flat().length, 1, 'backoff also skips history-bearing status hydration');
    h.turns[0].id = 'new-small-turn';
    f.monitor.loadEvents = () => [{ id: 'new-turn-hook', sessionId: 'long', turnId: 'new-small-turn', receivedAt: new Date().toISOString() }];
    await f.monitor.scan();
    assert.equal(attempts, 2);
    f.advance(5 * 60_000 + 1); await f.monitor.scan();
    assert.equal(attempts, 3);
  } finally { f.cleanup(); }
});

test('backed-off chats cannot consume status slots ahead of healthy recent work', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 4; i++) f.put('blocked-' + i);
    const read = f.tools.read;
    f.tools.read = async (...args) => { if (args[0].startsWith('blocked-')) throw new Error('temporarily unreadable'); return read(...args); };
    await f.monitor.scan();
    f.put('healthy'); await f.monitor.scan();
    assert.deepEqual(f.polls[1].map(t => t.threadId), ['healthy']);
    assert.deepEqual(f.reads.map(t => t.id), ['healthy']);
    assert.equal(f.monitor.health.backedOff, 4);
  } finally { f.cleanup(); }
});

test('failed status targets back off before they can starve healthy catalog rows', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 4; i++) f.put('unreadable-' + i);
    f.put('healthy'); const poll = f.tools.poll, attempts = [];
    f.tools.poll = async targets => {
      attempts.push(structuredClone(targets));
      return { ...await poll(targets.filter(t => t.threadId === 'healthy')),
        errors: targets.filter(t => t.threadId !== 'healthy').map(t => ({ threadId: t.threadId, message: 'temporarily unreadable' })) };
    };
    await f.monitor.scan(); await f.monitor.scan();
    assert.deepEqual(attempts[1].map(t => t.threadId), ['healthy']);
    assert.deepEqual(f.reads.map(t => t.id), ['healthy']);
  } finally { f.cleanup(); }
});

test('the prompt event belonging to a failed turn cannot bypass its own backoff', async () => {
  const f = fixture(); try {
    f.put('broken');
    f.monitor.loadEvents = () => [{ id: 'own-prompt', event: 'UserPromptSubmit', sessionId: 'broken', turnId: 'turn-broken', receivedAt: new Date().toISOString() }];
    f.tools.read = async () => { throw new Error('temporarily unreadable'); };
    await f.monitor.scan(); f.advance(5000); await f.monitor.scan();
    assert.equal(f.polls.flat().length, 1);
    assert.equal(f.monitor.health.backedOff, 1);
  } finally { f.cleanup(); }
});

test('a scan has a fixed history budget and later scans process deferred chats', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 10; i++) f.put('chat-' + i);
    await f.monitor.scan(); assert.equal(f.reads.length, 4);
    await f.monitor.scan(); assert.equal(f.reads.length, 8);
    await f.monitor.scan(); assert.equal(f.reads.length, 10);
  } finally { f.cleanup(); }
});

test('busy chats with open notices cannot consume the entire budget ahead of a new chat', async () => {
  const f = fixture(); try {
    for (let i = 0; i < 4; i++) f.put('busy-' + i);
    await f.monitor.scan();
    for (let i = 0; i < 4; i++) {
      f.monitor.inbox.observe('notice-' + i, { source: 'desktop', kind: 'input', text: 'Pending',
        route: { threadId: 'busy-' + i, turnId: 'turn-busy-' + i } });
      f.histories.get('busy-' + i).thread.updatedAt++;
    }
    f.put('new-chat'); f.reads.length = 0;
    await f.monitor.scan();
    assert.ok(f.reads.some(read => read.id === 'new-chat'));
  } finally { f.cleanup(); }
});

test('lifecycle bursts cannot start more than one scan in five seconds', async () => {
  const f = fixture({ minimumScanMs: 5000 }); try {
    f.put('one');
    for (let i = 0; i < 10; i++) await f.monitor.scan();
    assert.equal(f.lists, 1);
    f.advance(5000); await f.monitor.scan(); assert.equal(f.lists, 2);
  } finally { f.cleanup(); }
});

test('deferred lifecycle events remain pending until their own chat is read', async () => {
  const f = fixture(); try {
    const events = [];
    for (let i = 0; i < 10; i++) {
      const h = f.put('chat-' + i);
      events.push({ id: 'event-' + i, sessionId: h.thread.id, turnId: h.turns[0].id, receivedAt: new Date().toISOString() });
    }
    f.monitor.loadEvents = () => events;
    await f.monitor.scan(); assert.equal(f.store.data.desktopWatch.eventIds.length, 4);
    await f.monitor.scan(); assert.equal(f.store.data.desktopWatch.eventIds.length, 8);
    await f.monitor.scan(); assert.equal(f.store.data.desktopWatch.eventIds.length, 10);
  } finally { f.cleanup(); }
});

test('an expired ephemeral hook is consumed without treating a real chat as unavailable', async () => {
  const f = fixture(); try {
    f.put('real');
    f.monitor.loadEvents = () => [{ id: 'expired-hook', sessionId: 'ephemeral', receivedAt: new Date().toISOString() }];
    const poll = f.tools.poll;
    f.tools.poll = async targets => ({ ...await poll(targets.filter(t => t.threadId !== 'ephemeral')),
      errors: [{ threadId: 'ephemeral', message: 'No Codex thread found for threadId: ephemeral.' }] });
    await f.monitor.scan();
    assert.equal(f.monitor.health.readFailures, 0);
    assert.ok(f.store.data.desktopWatch.eventIds.includes('expired-hook'));
    assert.deepEqual(f.reads.map(r => r.id), ['real']);
  } finally { f.cleanup(); }
});

test('stable private validation chats cannot exhaust the read budget on every scan', async () => {
  const f = fixture({ excludeRoots: ['D:\\private'] }); try {
    for (let i = 0; i < 4; i++) f.put('private-' + i).thread.cwd = 'D:\\private\\probe-' + i;
    f.put('real');
    f.tools.list = async () => [...f.histories.values()].map(h => ({ id: h.thread.id, updatedAt: h.thread.updatedAt, status: h.thread.status.type }));
    await f.monitor.scan(); await f.monitor.scan();
    assert.ok(f.reads.some(r => r.id === 'real'));
    assert.ok(f.reads.filter(r => r.id === 'private-0').length <= 1);
  } finally { f.cleanup(); }
});

test('matching answers in later turns resolve saved questions only after every question is answered', async () => {
  const f = fixture(); try {
    const h = f.put('one');
    const item = f.monitor.inbox.observe('older-question', { source: 'desktop', kind: 'input', text: 'Which color? Which size?',
      choiceQuestions: [{ index: 0, title: 'Which color?', options: ['Blue', 'Red'] }, { index: 1, title: 'Which size?', options: ['Small', 'Large'] }],
      route: { threadId: 'one', turnId: 'older-turn', questionItemId: 'call_group', context: 'Which color?\n\nWhich size?' } });
    const answer = (index, question) => ({ type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>' +
      JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'call_group', index]), question, answer: 'Chosen' }]) +
      '</send_user_message_question_reply>' }] });
    h.turns[0].items = [answer(0, 'Which color?')]; await f.monitor.scan();
    assert.equal(item.status, 'open'); assert.deepEqual(item.answeredQuestionIndexes, [0]);
    h.turns[0].id = 'another-answer-turn'; h.turns[0].items = [answer(1, 'Which size?')];
    await f.monitor.scan(); assert.equal(item.status, 'resolved');
  } finally { f.cleanup(); }
});

test('unreadable event-only targets rotate so later healthy events are still inspected', async () => {
  const f = fixture(); try {
    f.put('healthy'); f.tools.list = async () => [];
    f.monitor.loadEvents = () => [...Array.from({ length: 8 }, (_, i) => 'unreadable-' + i), 'healthy'].map(id =>
      ({ id: 'event-' + id, sessionId: id, receivedAt: new Date().toISOString() }));
    const poll = f.tools.poll;
    f.tools.poll = async targets => ({ ...await poll(targets.filter(t => t.threadId === 'healthy')),
      errors: targets.filter(t => t.threadId !== 'healthy').map(t => ({ threadId: t.threadId, message: 'Temporarily unreadable' })) });
    await f.monitor.scan(); await f.monitor.scan();
    assert.ok(f.reads.some(r => r.id === 'healthy'));
  } finally { f.cleanup(); }
});

test('poll failures do not fall back to expensive history scans', async () => {
  const f = fixture(); try {
    f.put('one'); f.tools.poll = async () => { throw new Error('offline'); };
    await f.monitor.scan(); assert.equal(f.reads.length, 0);
    assert.equal(f.monitor.health.status, 'unavailable');
  } finally { f.cleanup(); }
});

test('a new user turn acknowledges an earlier result without fetching the older turn', async () => {
  const f = fixture(); try {
    const h = f.put('one');
    const item = f.monitor.inbox.observe('earlier-result', { source: 'desktop', kind: 'completion',
      label: 'One', text: 'Earlier result', sourceAt: Date.now() - 1000,
      route: { threadId: 'one', turnId: 'earlier-turn' } });
    h.turns[0].items = [{ type: 'userMessage', id: 'followup', content: [{ type: 'text', text: 'Continue with the next step' }] }];
    await f.monitor.scan();
    assert.equal(item.status, 'resolved');
    assert.equal(item.continuedByTurnId, h.turns[0].id);
  } finally { f.cleanup(); }
});

test('a continuation before notice creation acknowledges results by completion time', async () => {
  const f = fixture(); try {
    const h = f.put('one'), observedAt = f.monitor.inbox.now();
    const notice = (key, sourceAt) => f.monitor.inbox.observe(key, { source: 'desktop', kind: 'completion',
      label: 'One', text: key, sourceAt, route: { threadId: 'one', turnId: key } });
    const earlier = notice('earlier-result', observedAt - 2000);
    const later = notice('later-result', observedAt - 500);
    h.turns[0].startedAt = (observedAt - 1000) / 1000;
    h.turns[0].items = [{ type: 'userMessage', content: [{ type: 'text', text: 'Continue' }] }];
    await f.monitor.scan();
    assert.equal(earlier.status, 'resolved');
    assert.equal(later.status, 'open');
  } finally { f.cleanup(); }
});
