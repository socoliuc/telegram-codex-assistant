import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { Assistant } from '../src/assistant.mjs';
import { DesktopMonitor } from '../src/desktop.mjs';
import { Inbox } from '../src/inbox.mjs';
import { Telegram } from '../src/telegram.mjs';
import { DesktopTools } from '../src/desktop-tools.mjs';

const projectRoot = process.platform === 'win32' ? 'D:\\' : '/';
const projectA = process.platform === 'win32' ? 'D:\\a' : '/tmp/tg-projects/a';
const projectB = process.platform === 'win32' ? 'D:\\b' : '/tmp/tg-projects/b';
const unrelatedRoot = process.platform === 'win32' ? 'E:\\unrelated-folder-with-a-long-name' : '/tmp/unrelated-folder-with-a-long-name';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-controls-'));
  const store = new StateStore(join(dir, 'state.json'));
  store.data.owner = { userId: 1, chatId: 1 };
  const calls = [], sent = [], native = [], submissions = [], histories = new Map();
  let clock = Date.now(), update = 100;
  const rpc = new EventEmitter();
  rpc.respond = (id, value) => native.push({ id, value });
  rpc.reject = id => native.push({ rejected: id });
  rpc.call = async (method, params) => { native.push({ method, params }); return {}; };
  const telegram = { token: 'TEST_SECRET', async call(method, params) { calls.push({ method, params }); return true; },
    async send(chat, text, keyboard, onDelivered, options) {
      const message = { message_id: sent.length + 1, chat: { id: 1, type: 'private' } };
      sent.push({ text, keyboard, message, options }); onDelivered?.(message); return [message];
    } };
  const projects = [{ id: 'a', name: 'Project A', roots: [projectA] }, { id: 'b', name: 'Project B', roots: [projectB] }];
  const assistant = new Assistant({ store, telegram, rpc, projects, workspace: dir });
  assistant.classifyMessage = async () => ({ projectId: null });
  const inbox = assistant.controls.inbox; inbox.now = () => clock;
  const tools = { async list() { return [...histories.values()].map(h => ({ ...h.thread, status: h.thread.status.type })); },
    async poll(targets) { return { polls: targets.map(t => { const h = histories.get(t.threadId), cursor = JSON.stringify(h); return { thread: { id: t.threadId, status: h.thread.status }, latestTurn: h.turns[0], cursor, changed: cursor !== t.afterCursor }; }) }; },
    async read(id) { return structuredClone(histories.get(id)); },
    async send(id, text) { submissions.push({ id, text }); return { status: 'sent' }; } };
  const monitor = new DesktopMonitor({ tools, store, send: assistant.send.bind(assistant), loadProjects: () => projects, controls: assistant.controls, minimumScanMs: 0, now: () => clock });
  assistant.desktop = monitor;
  const put = (id, kind = 'completion') => {
    const question = kind === 'input';
    const h = { thread: { id, title: 'Task ' + id, cwd: projectA, hostId: 'local', updatedAt: clock, status: { type: question ? 'active' : 'idle' } },
      turns: [{ id: 'turn-' + id, status: question ? 'inProgress' : 'completed', startedAt: Date.now() / 1000 + 1,
        items: [{ type: 'agentMessage', id: question ? 'call_' + id : 'msg_' + id, phase: 'final_answer', text: question ? 'Which color?' : 'Finished the requested work.' }] }] };
    histories.set(id, h); return h;
  };
  const scan = async () => { for (const row of Object.values(store.data.desktopWatch.threads)) row.checkedAt = 0; await monitor.scan(); };
  const nextUpdate = () => { update = Math.max(update, store.data.offset); return update++; };
  const callback = (data, message = sent.at(-1)?.message, userId = 1) => assistant.handleUpdate({ update_id: nextUpdate(), callback_query: { id: 'cb' + update, data, from: { id: userId }, message } });
  const say = (text, messageId) => assistant.handleUpdate({ update_id: update++, message: { text, from: { id: 1 }, chat: { id: 1, type: 'private' }, ...(messageId ? { reply_to_message: { message_id: messageId } } : {}) } });
  return { dir, store, assistant, inbox, tools, monitor, sent, calls, native, submissions, put, scan, callback, say,
    advance(ms) { clock += ms; }, time(at) { clock = at; },
    cleanup() { assistant.close(); rmSync(dir, { recursive: true, force: true }); } };
}

const answerButtons = message => message.keyboard.inline_keyboard.flat().filter(b => b.callback_data?.startsWith('ctl:answer:'));

test('a shared parent folder cannot steal a child project title, including on existing inbox cards', async () => {
  const f = fixture(); try {
    const parent = { id: 'parent', name: 'Shopping', roots: [projectRoot, unrelatedRoot] };
    f.assistant.projects.unshift(parent);
    f.put('launch'); await f.scan();
    assert.match(f.sent[0].text, /^Project A · Update/);
    const old = f.inbox.list('updates')[0];
    old.label = old.route.label = 'Shopping · Task launch';
    delete old.route.origin;
    old.route.projectId = 'parent'; old.route.imageRoots = [projectA, ...parent.roots];
    old.text = old.label + ' — has an update\n\nThe launch finished.\n\nReply here to continue.';
    old.imageSource = ''; old.route.context = '';
    await f.say('/updates'); const text = f.sent.at(-1).text;
    assert.match(text, /Project A · Update/); assert.match(text, /The launch finished/); assert.doesNotMatch(text, /Shopping/);
    assert.equal(old.route.threadId, 'launch'); assert.equal(old.route.projectId, 'parent');
    assert.deepEqual(f.assistant.controls.forDisplay(old).allowedImageRoots, [projectA]);
    old.verifiedOrigin = { cwd: projectA, projectId: 'parent' };
    assert.match(f.assistant.controls.forDisplay(old).displayLabel, /^Shopping ·/);
  } finally { f.cleanup(); }
});

test('saved and fresh automation updates put the action before the chat title and show the message body', async () => {
  const f = fixture(); try {
    const h = f.put('launch'); h.thread.title = 'Plan the launch';
    h.turns[0].items[0].text = '<heartbeat>\n<automation_id>abc</automation_id>\n<decision>notify</decision>\n<message>Review the launch date.</message>\n</heartbeat>';
    await f.scan();
    const card = f.sent[0], item = f.inbox.list('updates')[0];
    assert.match(card.text, /^Project A · Update\nPlan the launch\n\nReview the launch date\./);
    assert.doesNotMatch(card.text, /<heartbeat>|<automation_id>/);
    await f.say('/updates');
    assert.match(f.sent.at(-1).text, /Review the launch date/);
    assert.doesNotMatch(f.sent.at(-1).text, /<heartbeat>|<automation_id>/);
    await f.assistant.controls.item(item.id);
    assert.equal(f.store.data.desktopReplies[f.sent.at(-1).message.message_id].threadId, 'launch');
    assert.match(f.sent.at(-1).text, /^Project A · Update/);
  } finally { f.cleanup(); }
});

test('choice cards replace management controls and repeated option lists with answer buttons', async () => {
  const f = fixture(); try {
    const h = f.put('answer-only', 'input');
    h.turns[0].items[0].text = 'Which color?\n- Blue (Recommended)\n- Green\n\nWhich size?\n- Small\n- Large';
    await f.scan(); const message = f.sent[0], item = f.inbox.list()[0];
    assert.deepEqual(message.keyboard.inline_keyboard.flat().map(b => b.text),
      ['Q1 · Blue (Recommended)', 'Q1 · Green', 'Q2 · Small', 'Q2 · Large']);
    assert.match(message.text, /Which color\?/); assert.match(message.text, /Which size\?/);
    assert.doesNotMatch(message.text, /- Blue|Recommended|\n- Green|\n- Small|\n- Large/);
    await f.callback(answerButtons(message)[0].callback_data, message.message); await f.assistant.serial;
    assert.deepEqual(f.assistant.controls.buttons(item).inline_keyboard.flat().map(b => b.text), ['Q2 · Small', 'Q2 · Large']);
    await f.callback(answerButtons(message)[3].callback_data, message.message); await f.assistant.serial;
    assert.deepEqual(f.assistant.controls.buttons(item).inline_keyboard, []);
  } finally { f.cleanup(); }
});

test('Auto holds proactive alerts, releases only current items after idle, and never resends delivered ones', async () => {
  const f = fixture(); try {
    const controls = f.assistant.controls;
    controls.activity.setMode('auto');
    f.put('held-question', 'input'); f.put('held-completion'); await f.scan();
    assert.equal(f.sent.length, 0);
    const question = f.inbox.list()[0], update = f.inbox.list('updates')[0];
    assert.equal(question.delivery, 'held'); assert.equal(update.delivery, 'held');
    f.inbox.resolve(question, 'Answered in Codex.');
    f.advance(30 * 60_000 - 1); await f.scan(); await controls.flushHeld(); assert.equal(f.sent.length, 0);
    f.advance(1); await f.scan(); await controls.flushHeld();
    assert.equal(f.sent.length, 1); assert.equal(update.delivery, 'delivered');
    assert.ok(f.store.data.desktopReplies[f.sent[0].message.message_id]);
    await controls.flushHeld(); await f.scan(); assert.equal(f.sent.length, 1);
    controls.activity.setMode('paused');
    f.put('paused-failure').turns[0].status = 'failed'; await f.scan();
    assert.equal(f.sent.length, 1);
    await controls.item(update.id); assert.equal(f.sent.length, 2, 'explicit Details still works');
  } finally { f.cleanup(); }
});

test('Automatic catch-up skips pre-absence backlog even when Codex keeps observing it', async () => {
  const f = fixture(); try {
    const c = f.assistant.controls; c.activity.setMode('auto');
    f.put('before-absence', 'input'); await f.scan(); const old = f.inbox.list()[0];
    const originalAt = old.createdAt;
    f.advance(5 * 60_000);
    // A final desktop message, followed by 30 minutes away.
    const lastMessageAt = f.inbox.now();
    c.activity.loadEvents = () => [{ event: 'UserPromptSubmit', origin: 'desktop-user', sessionId: 'human', submittedAt: new Date(lastMessageAt).toISOString(), receivedAt: new Date(lastMessageAt).toISOString() }];
    c.activity.refresh(); f.advance(20 * 60_000);
    f.put('during-absence'); await f.scan(); const recent = f.inbox.list('updates')[0], lastOldObservation = old.observedAt;
    f.advance(10 * 60_000); await f.scan(); await c.flushHeld();
    assert.equal(old.createdAt, originalAt); assert.equal(old.observedAt, lastOldObservation, 'expired active metadata is not a fresh source observation');
    assert.equal(old.delivery, 'inbox'); assert.ok(f.inbox.list().includes(old), 'old unanswered work remains accessible');
    assert.equal(recent.delivery, 'delivered'); assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /during-absence/);
    await c.flushHeld(); assert.equal(f.sent.length, 1);
    await c.item(old.id); assert.equal(f.sent.length, 2, 'explicit Details can still open older work');
    assert.equal(f.store.data.desktopReplies[f.sent[1].message.message_id].threadId, 'before-absence');
  } finally { f.cleanup(); }
});

test('verified-message idle resumes delivery despite repeated background prompts and preserves the 30m cutoff', async () => {
  const f = fixture(); try {
    const c = f.assistant.controls; c.activity.setMode('auto');
    let events = [];
    c.activity.loadEvents = () => events;
    const submit = origin => { const stamp = new Date(f.inbox.now()).toISOString(); events.push({ event: 'UserPromptSubmit', sessionId: 'owner-chat', origin, receivedAt: stamp, submittedAt: stamp }); c.activity.refresh(); };
    submit('desktop-user');
    f.inbox.observe('old-before-last-message', { source: 'desktop', kind: 'input', route: { threadId: 'old' },
      createdAt: f.inbox.now() - 1, label: 'Old question', text: 'Still pending', delivery: 'held' });
    f.advance(10 * 60_000); f.put('real-recent-question', 'input'); await f.scan();
    const question = f.inbox.list().find(item => item.route.threadId === 'real-recent-question');
    for (let i = 0; i < 4; i++) { f.advance(5 * 60_000); submit(i % 2 ? 'unknown' : 'desktop'); await f.scan(); await c.flushHeld(); }
    assert.equal(c.activity.status().blocked, false);
    assert.equal(question.delivery, 'delivered'); assert.equal(f.sent.length, 1);
    assert.equal(f.store.data.desktopReplies[f.sent[0].message.message_id].threadId, 'real-recent-question');
    assert.equal(f.inbox.get(Object.values(f.inbox.data.items).find(item => item.key === 'old-before-last-message').id).delivery, 'inbox');
    submit('desktop-user'); f.put('result-after-return'); await f.scan();
    assert.equal(f.sent.length, 1, 'returning to Codex pauses again');
    for (let i = 0; i < 6; i++) { f.advance(5 * 60_000); submit('unknown'); await f.scan(); await c.flushHeld(); }
    assert.equal(f.sent.length, 2, 'only a genuinely new owner message may postpone resumption');
    assert.match(f.sent[1].text, /result-after-return/);
    await c.flushHeld(); assert.equal(f.sent.length, 2, 'no replay of earlier delivered notifications');
  } finally { f.cleanup(); }
});

test('Automatic uses original completion time for late discovery and preserves fresh results of long tasks', async () => {
  const f = fixture(); try {
    const c = f.assistant.controls; c.activity.setMode('auto'); f.advance(30 * 60_000);
    const old = f.put('late-old-completion');
    old.turns[0].completedAt = (f.inbox.now() - 2 * 60 * 60_000) / 1000;
    old.turns[0].startedAt = old.turns[0].completedAt - 60;
    f.store.data.desktopWatch.enabledAt = new Date(f.inbox.now() - 3 * 60 * 60_000).toISOString();
    const fresh = f.put('fresh-long-task');
    fresh.turns[0].startedAt = old.turns[0].startedAt;
    fresh.turns[0].completedAt = f.inbox.now() / 1000;
    await f.scan();
    const staleItem = f.inbox.list('updates').find(i => i.route.threadId === 'late-old-completion');
    assert.equal(staleItem.sourceAt, old.turns[0].completedAt * 1000);
    assert.equal(staleItem.delivery, 'inbox'); assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /fresh-long-task/);
  } finally { f.cleanup(); }
});

test('Automatic hourly digests include only the last 30 minutes while retaining their hourly trigger', async () => {
  const f = fixture(); try {
    const c = f.assistant.controls; c.activity.setMode('auto'); f.advance(30 * 60_000);
    f.inbox.data.settings.routine = 'digest';
    f.put('older-digest-entry'); await f.scan(); const old = f.inbox.list('updates')[0];
    f.advance(45 * 60_000); f.put('recent-digest-entry'); await f.scan();
    f.advance(15 * 60_000); await f.scan(); await c.flush();
    assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /recent-digest-entry/);
    assert.doesNotMatch(f.sent[0].text, /older-digest-entry/);
    assert.equal(old.delivery, 'inbox'); assert.ok(f.inbox.list('updates').includes(old));
  } finally { f.cleanup(); }
});

test('Automatic rechecks the 30-minute notification age after awaited image preparation', async () => {
  const f = fixture(); let release, pending;
  try {
    const c = f.assistant.controls; c.activity.setMode('auto'); f.advance(30 * 60_000);
    const item = f.inbox.observe('age-during-preparation', { source: 'desktop', kind: 'input', route: { threadId: 'held' },
      createdAt: f.inbox.now() - 30 * 60_000 + 1, text: 'Image question', imageSource: `![Proof](<${join(f.dir, 'missing.png')}>)` });
    let started; const waiting = new Promise(resolve => { started = resolve; });
    f.tools.read = async () => { started(); return new Promise(resolve => { release = () => resolve({ thread: { id: 'held', cwd: f.dir } }); }); };
    pending = c.notify(item); await waiting; f.advance(2); release(); await pending;
    assert.equal(f.sent.length, 0); assert.equal(item.delivery, 'inbox');
  } finally { release?.(); await pending; f.cleanup(); }
});

test('explicit Details retires held delivery before sending and never replays a successful or uncertain attempt', async () => {
  for (const outcome of ['delivered', 'unknown']) {
    const f = fixture(); let release, pending;
    try {
      const c = f.assistant.controls; c.activity.setMode('auto');
      f.put('manual-held'); await f.scan(); const item = f.inbox.list('updates')[0];
      assert.equal(item.delivery, 'held');
      const send = f.assistant.send.bind(f.assistant);
      let started; const waiting = new Promise(resolve => { started = resolve; });
      f.assistant.send = async (...args) => {
        started(); await new Promise(resolve => { release = resolve; });
        if (outcome === 'unknown') throw new Error('Delivery unconfirmed');
        return send(...args);
      };
      pending = c.item(item.id).catch(error => { if (outcome !== 'unknown') throw error; });
      await waiting; f.advance(30 * 60_000); await f.scan();
      assert.equal(item.delivery, 'sending', 'claim before the network send');
      await c.flushHeld(); assert.equal(f.sent.length, 0, 'no parallel catch-up');
      release(); await pending;
      assert.equal(item.delivery, outcome);
      assert.equal(f.store.data.notices[item.key], outcome);
      await c.flushHeld(); assert.equal(f.sent.length, outcome === 'delivered' ? 1 : 0);
    } finally { release?.(); await pending; f.cleanup(); }
  }
});

test('Details takes over an already preparing held release without a duplicate notification', async () => {
  for (const outcome of ['delivered', 'unknown']) {
    const f = fixture(); let release, pending;
    try {
      const c = f.assistant.controls;
      const item = f.inbox.observe('release-before-details', { source: 'desktop', kind: 'failure', route: { threadId: 'held' },
        text: 'Image result', imageSource: `![Proof](<${join(f.dir, 'missing.png')}>)`, delivery: 'held' });
      let started; const waiting = new Promise(resolve => { started = resolve; });
      f.tools.read = async () => { started(); return new Promise(resolve => { release = () => resolve({ thread: { id: 'held', cwd: f.dir } }); }); };
      pending = c.flushHeld(); await waiting;
      assert.equal(item.delivery, 'sending');
      item.imageRoots = [f.dir];
      if (outcome === 'unknown') f.assistant.send = async () => { throw new Error('Delivery unconfirmed'); };
      await c.item(item.id).catch(error => { if (outcome !== 'unknown') throw error; });
      release(); await pending; await c.flushHeld();
      assert.equal(item.delivery, outcome);
      assert.equal(f.sent.length, outcome === 'delivered' ? 1 : 0, 'automatic preparation must yield to Details');
    } finally { release?.(); await pending; f.cleanup(); }
  }
});

test('resumed digests wait for a fresh source observation before dispatch', async () => {
  const f = fixture(); try {
    const c = f.assistant.controls; c.inbox.data.settings.routine = 'digest';
    f.put('stale-digest'); await f.scan(); const item = f.inbox.list('updates')[0];
    c.activity.setMode('paused'); f.advance(60 * 60_000);
    await c.flush(); assert.equal(f.sent.length, 0);
    c.activity.setMode('always'); await c.flush();
    assert.equal(f.sent.length, 0, 'unavailable history cannot release a stale digest');
    assert.equal(item.delivery, 'digest');
    await f.scan(); await c.flush(); assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test('Auto preserves direct Telegram results and their follow-up questions while Codex is active', async () => {
  const f = fixture(); try {
    f.assistant.controls.activity.setMode('auto');
    const h = f.put('phone-request');
    h.turns[0].items.unshift({ type: 'userMessage', content: [{ type: 'text', text: 'Owner replied in Telegram [request 800]' }] });
    f.store.data.desktopSubmissions['800'] = { threadId: 'phone-request', requestMarker: 'Owner replied in Telegram [request 800]', status: 'submitted' };
    await f.scan(); assert.equal(f.sent.length, 1);
    h.turns[0].status = 'inProgress'; h.thread.status.type = 'active';
    h.turns[0].items.push({ type: 'agentMessage', id: 'call_phone', phase: 'final_answer', text: 'Which color?\n- Blue\n- Green' });
    await f.scan(); assert.equal(f.sent.length, 2);
    assert.equal(f.inbox.list()[0].route.direct, true);
  } finally { f.cleanup(); }
});

test('Auto also pauses scheduled reminders and digests without discarding them', async () => {
  const f = fixture(); try {
    f.put('reminder-auto', 'input'); await f.scan(); const item = f.inbox.list()[0];
    f.inbox.snooze(item.id);
    f.inbox.data.settings.routine = 'digest'; f.put('digest-auto'); await f.scan();
    f.assistant.controls.activity.setMode('auto');
    f.advance(60 * 60_000); await f.scan();
    f.assistant.controls.activity.loadEvents = () => [{ event: 'UserPromptSubmit', origin: 'desktop-user', sessionId: 'human', submittedAt: new Date(f.inbox.now()).toISOString(), receivedAt: new Date(f.inbox.now()).toISOString() }];
    f.assistant.controls.activity.refresh();
    const count = f.sent.length; await f.assistant.controls.flush(); assert.equal(f.sent.length, count);
    assert.equal(item.reminder, 'pending');
    assert.ok(Object.values(f.inbox.data.items).some(i => i.delivery === 'digest'));
  } finally { f.cleanup(); }
});

test('activity arriving during image preparation holds the unsent notification', async () => {
  const f = fixture(); let release;
  try {
    const c = f.assistant.controls; c.activity.setMode('auto'); f.advance(30 * 60_000);
    const item = f.inbox.observe('late-activity', { source: 'desktop', kind: 'completion', label: 'A',
      route: { threadId: 'late' }, text: 'Image update', imageSource: `![Proof](<${join(f.dir, 'missing.png')}>)` });
    let started;
    const waiting = new Promise(resolve => { started = resolve; });
    f.tools.read = async () => { started(); return new Promise(resolve => { release = () => resolve({ thread: { id: 'late', cwd: f.dir } }); }); };
    const pending = c.notify(item); await waiting;
    c.activity.loadEvents = () => [{ event: 'UserPromptSubmit', origin: 'desktop-user', sessionId: 'human', submittedAt: new Date(f.inbox.now()).toISOString(), receivedAt: new Date(f.inbox.now()).toISOString() }];
    release(); await pending;
    assert.equal(item.delivery, 'held'); assert.equal(f.sent.length, 0);
  } finally { release?.(); f.cleanup(); }
});

test('notification mode buttons require the owner and a current Settings panel', async () => {
  const f = fixture(); try {
    await f.say('/settings'); const panel = f.sent.at(-1).message;
    await f.callback('ctl:notify:auto', panel, 2); assert.equal(f.assistant.controls.activity.mode, 'always');
    await f.callback('ctl:notify:auto', panel); assert.equal(f.assistant.controls.activity.mode, 'auto');
    await f.callback('ctl:home', panel);
    await f.callback('ctl:notify:paused', panel); assert.equal(f.assistant.controls.activity.mode, 'auto');
    f.advance(25 * 60 * 60_000);
    await f.callback('ctl:notify:always', panel); assert.equal(f.assistant.controls.activity.mode, 'auto');
    await f.callback('ctl:notify:always', panel); assert.equal(f.assistant.controls.activity.mode, 'always');
    assert.equal(f.sent.length, 1); assert.equal(f.native.length, 0);
  } finally { f.cleanup(); }
});

test('held media delivery cannot stall the independent notification cleanup timer', async t => {
  const f = fixture(); let release, pending;
  try {
    t.mock.timers.enable({ apis: ['setInterval'] });
    f.put('cleanup-during-catchup'); await f.scan();
    const old = f.inbox.list('updates')[0], original = f.sent[0].message;
    const c = f.assistant.controls; c.activity.setMode('auto'); f.advance(30 * 60_000);
    const item = f.inbox.observe('blocked-held-media', { source: 'desktop', kind: 'completion', route: { threadId: 'held' },
      text: 'Image result', imageSource: `![Proof](<${join(f.dir, 'missing.png')}>)`, delivery: 'held' });
    let started; const waiting = new Promise(resolve => { started = resolve; });
    f.tools.read = async () => { started(); return new Promise(resolve => { release = () => resolve({ thread: { id: 'held', cwd: f.dir } }); }); };
    c.startCleanup(); t.mock.timers.tick(2000); await waiting;
    pending = c.heldPending || c.cleanupPending;
    f.inbox.resolve(old, 'Answered in Codex.'); t.mock.timers.tick(2000);
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(f.calls.some(call => call.method === 'editMessageReplyMarkup' && call.params.message_id === original.message_id));
    assert.equal(item.delivery, 'sending'); assert.equal(f.sent.length, 1, 'media preparation is still blocked');
    release(); await pending;
  } finally { f.assistant.controls.stopCleanup(); release?.(); await pending; f.cleanup(); }
});

test('a snoozed held alert sends once regardless of reminder and catch-up ordering', async () => {
  for (const order of ['reminder-first', 'release-first', 'concurrent']) {
    const f = fixture(); try {
      const c = f.assistant.controls; c.activity.setMode('auto');
      f.put('snoozed-held').turns[0].status = 'failed'; await f.scan();
      const item = f.inbox.list()[0]; f.inbox.snooze(item.id);
      f.advance(60 * 60_000); await f.scan();
      f.monitor.health.lastScanAt = new Date(f.inbox.now()).toISOString();
      if (order === 'reminder-first') { await c.flush(); assert.equal(f.sent.length, 0); await c.flushHeld(); }
      else if (order === 'release-first') { await c.flushHeld(); await c.flush(); }
      else await Promise.all([c.flushHeld(), c.flush()]);
      await c.flush(); assert.equal(f.sent.length, 1, order); assert.equal(item.reminder, 'delivered');
    } finally { f.cleanup(); }
  }
});

test('held catch-up rechecks resolution, freshness and snooze after awaited image preparation', async () => {
  for (const changed of ['resolved', 'stale', 'snoozed']) {
    const f = fixture(); let release, pending;
    try {
      const c = f.assistant.controls;
      const item = f.inbox.observe('changed-held', { source: 'desktop', kind: 'failure', route: { threadId: 'held' },
        text: 'Image result', imageSource: `![Proof](<${join(f.dir, 'missing.png')}>)`, delivery: 'held', reminder: 'pending', snoozedUntil: f.inbox.now() - 1 });
      let started; const waiting = new Promise(resolve => { started = resolve; });
      f.tools.read = async () => { started(); return new Promise(resolve => { release = () => resolve({ thread: { id: 'held', cwd: f.dir } }); }); };
      pending = c.flushHeld(); await waiting;
      if (changed === 'resolved') f.inbox.resolve(item, 'Answered in Codex.');
      else if (changed === 'stale') f.advance(120_001);
      else assert.equal(f.inbox.snooze(item.id), true);
      release(); await pending;
      assert.equal(f.sent.length, 0, changed);
      assert.equal(item.delivery, changed === 'resolved' ? 'inbox' : 'held');
      if (changed === 'snoozed') { assert.equal(item.reminder, 'pending'); assert.ok(item.snoozedUntil > f.inbox.now()); }
    } finally { release?.(); await pending; f.cleanup(); }
  }
});

test('answers made in Codex clear the inbox and every Telegram copy without submitting work', async () => {
  const f = fixture(); try {
    const h = f.put('reverse-answer', 'input');
    h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
    await f.scan(); const item = f.inbox.list()[0];
    await f.assistant.controls.item(item.id);
    await f.assistant.controls.show('attention:0');
    const panelMessage = f.sent.at(-1).message;
    h.turns[0].items.push({ type: 'userMessage', content: [{ type: 'text', text:
      '<send_user_message_question_reply>' + JSON.stringify([{ questionItemId: JSON.stringify(['request_user_input_async', 'call_reverse-answer', 0]),
        question: 'Which color?', answer: 'Green' }]) + '</send_user_message_question_reply>' }] });
    await f.scan(); await f.assistant.controls.flush();
    assert.equal(item.status, 'resolved'); assert.equal(f.inbox.list().some(i => i.id === item.id), false);
    assert.equal(f.submissions.length, 0);
    const panelEdit = f.calls.find(c => c.method === 'editMessageText' && c.params.message_id === panelMessage.message_id);
    assert.ok(panelEdit, 'the existing inbox panel updates without tapping Refresh');
    assert.match(panelEdit.params.text, /No open requests/);
    assert.doesNotMatch(JSON.stringify(panelEdit.params.reply_markup), new RegExp(item.id));
    for (const id of item.messageIds) {
      assert.ok(f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && String(c.params.message_id) === id),
        'every answered notification copy loses its stale controls');
      assert.equal(f.store.data.desktopReplies[id].threadId, 'reverse-answer', 'routes remain as tombstones');
    }
    const before = f.calls.length; await f.assistant.controls.flush(); assert.equal(f.calls.length, before);
  } finally { f.cleanup(); }
});

test('continuing a chat in Codex clears its preceding update and copies from an open inbox', async () => {
  const f = fixture(); try {
    const h = f.put('continued-update'); h.turns[0].completedAt = h.turns[0].startedAt + 1;
    f.put('other-project-update'); await f.scan();
    const item = f.inbox.list('updates').find(i => i.route.threadId === 'continued-update');
    const other = f.inbox.list('updates').find(i => i.route.threadId === 'other-project-update');
    await f.assistant.controls.item(item.id);
    await f.assistant.controls.show('updates:0'); const panel = f.sent.at(-1).message;
    h.turns.unshift({ id: 'codex-followup', status: 'inProgress', startedAt: h.turns[0].completedAt + 1,
      items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Thanks, now check the remaining accounts.' }] }] });
    h.thread.status.type = 'active'; // Native catalog changes when a new turn starts.
    await f.scan(); await f.assistant.controls.flush();
    assert.equal(item.status, 'resolved'); assert.equal(item.continuedByTurnId, 'codex-followup');
    assert.equal(other.status, 'open'); assert.equal(f.inbox.list('updates').length, 1);
    assert.ok(item.messageIds.every(id => f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && String(c.params.message_id) === id)));
    assert.ok(f.calls.some(c => c.method === 'editMessageText' && c.params.message_id === panel.message_id && /Recent updates · 1/.test(c.params.text)));
    assert.equal(f.submissions.length, 0); assert.equal(f.native.length, 0);
  } finally { f.cleanup(); }
});

test('resolved notifications clear on their own timer while an unrelated history read remains blocked', async t => {
  const f = fixture(); let release, scan;
  try {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const h = f.put('answered-source'); h.turns[0].completedAt = h.turns[0].startedAt + 1;
    await f.scan(); const item = f.inbox.list('updates')[0];
    await f.assistant.controls.item(item.id);
    await f.say('/updates'); const panel = f.sent.at(-1).message;
    h.thread.status.type = 'active';
    h.turns.unshift({ id: 'new-codex-message', status: 'inProgress', startedAt: h.turns[0].completedAt + 1,
      items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Continue this work.' }] }] });
    f.put('slow-unrelated-history');
    const read = f.tools.read; let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    f.tools.read = async id => {
      if (id === 'slow-unrelated-history') { entered(); await held; }
      return read(id);
    };
    f.assistant.controls.startCleanup(); scan = f.monitor.scan(); await waiting;
    assert.equal(item.status, 'resolved');
    t.mock.timers.tick(2000);
    await new Promise(resolve => setImmediate(resolve));
    await f.assistant.controls.cleanupPending;
    assert.ok(item.messageIds.every(id => f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && String(c.params.message_id) === id)),
      'cleanup must not wait for the rest of the catalog scan or another user message');
    assert.ok(f.calls.some(c => c.method === 'editMessageText' && c.params.message_id === panel.message_id && /Recent updates · 0/.test(c.params.text)));
    assert.equal(f.submissions.length, 0);
    f.assistant.controls.stopCleanup();
    const afterStop = f.calls.length; t.mock.timers.tick(4000);
    await new Promise(resolve => setImmediate(resolve)); assert.equal(f.calls.length, afterStop);
  } finally {
    f.assistant.controls.stopCleanup(); release?.(); await scan;
    await f.assistant.controls.flushing; await f.assistant.controls.cleanupPending;
    f.cleanup();
  }
});

test('a status change, earlier queued prompt or unrelated question answer is not an update reply', async () => {
  const f = fixture(); try {
    for (const mode of ['no-user', 'queued', 'question-answer']) {
      const h = f.put(mode); h.turns[0].completedAt = h.turns[0].startedAt + 1;
      const next = { id: mode + '-next', status: 'inProgress', startedAt: h.turns[0].completedAt + 1, items: [] };
      if (mode !== 'no-user') next.items.push({ type: 'userMessage', content: [{ type: 'text', text:
        mode === 'question-answer' ? '<send_user_message_question_reply>[]</send_user_message_question_reply>' : 'An earlier queued request' }] });
      if (mode === 'queued') next.startedAt = h.turns[0].startedAt;
      h.turns.unshift(next);
    }
    await f.scan(); await f.assistant.controls.flush();
    assert.equal(f.inbox.list('updates').length, 3);
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
  } finally { f.cleanup(); }
});

test('inbox cleanup retries failed edits and leaves expired panels alone', async () => {
  const f = fixture(); try {
    const h = f.put('panel-recovery', 'input'); h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
    await f.scan(); const item = f.inbox.list()[0];
    await f.assistant.controls.show('attention:0'); const expiredId = f.sent.at(-1).message.message_id;
    await f.assistant.controls.show('attention:0'); const panelId = f.sent.at(-1).message.message_id;
    f.inbox.data.panels[expiredId].expiresAt = f.inbox.now() + 10;
    f.inbox.resolve(item, 'Answered in Codex.');
    let attempts = 0; const call = f.assistant.telegram.call;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'editMessageText' && params.message_id === panelId) { attempts++; f.advance(1000); throw new Error('Offline'); }
      return call(method, params);
    };
    await f.assistant.controls.flush(); await f.assistant.controls.flush();
    assert.equal(attempts, 1);
    assert.equal(f.inbox.data.panels[panelId].retryAt, f.inbox.now() + 60_000);
    assert.equal(f.sent.length, 3, 'a panel that expires during another edit must not be resent');
    assert.equal(f.inbox.list().length, 0);
    f.assistant.telegram.call = call; f.advance(60_001); await f.assistant.controls.flush();
    assert.ok(f.calls.some(c => c.params.message_id === panelId && /No open requests/.test(c.params.text)));
    assert.ok(!f.calls.some(c => c.params.message_id === expiredId));
    assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('a failed closed-question edit retries later without reopening or resubmitting the question', async () => {
  const f = fixture(); try {
    const h = f.put('edit-recovery', 'input'); h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
    await f.scan(); const item = f.inbox.list()[0];
    f.advance(49 * 60 * 60_000); // Telegram cannot delete this old card; edit it instead.
    f.inbox.resolve(item, 'Answered in Codex.');
    const call = f.assistant.telegram.call;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'editMessageReplyMarkup') throw new Error('Temporary connection failure');
      return call(method, params);
    };
    await f.assistant.controls.flush();
    assert.equal(f.inbox.list().length, 0); assert.equal(f.submissions.length, 0);
    assert.ok(item.notificationMessages[item.messageIds[0]].retryAt > f.inbox.now());
    f.assistant.telegram.call = call; f.advance(60_001); await f.assistant.controls.flush();
    const edit = f.calls.find(c => c.method === 'editMessageReplyMarkup');
    assert.deepEqual(edit.params.reply_markup.inline_keyboard, []);
    assert.equal(f.inbox.list().length, 0); assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('review preserves the notification and its images, refreshes Updates, and preserves task state', async () => {
  const f = fixture(); try {
    f.put('review-cleanup'); await f.scan();
    const item = f.inbox.list('updates')[0], message = f.sent[0].message;
    item.mediaMessageIds = ['500'];
    f.assistant.controls.record(item, { message_id: 500 });
    await f.assistant.controls.show('updates:0'); const panelId = f.sent.at(-1).message.message_id;
    await f.callback('ctl:review:' + item.id, message);
    assert.equal(item.status, 'reviewed');
    assert.deepEqual(f.calls.filter(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0).map(c => c.params.message_id).sort((a,b) => a-b), [message.message_id, 500]);
    assert.ok(f.calls.some(c => c.method === 'editMessageText' && c.params.message_id === panelId && /Recent updates · 0/.test(c.params.text)));
    assert.equal(f.submissions.length, 0);
    const edits = f.calls.filter(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0).length;
    await f.assistant.controls.flush();
    assert.equal(f.calls.filter(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0).length, edits, 'successful closures are durable');
  } finally { f.cleanup(); }
});

test('confirmed Telegram answers retire controls, but partial and uncertain submissions remain visible', async () => {
  const f = fixture(); try {
    const h = f.put('cleanup-answer', 'input');
    h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green\n\nWhich size?\n- Small\n- Large';
    await f.scan(); const message = f.sent[0], item = f.inbox.list()[0];
    await f.callback(answerButtons(message)[0].callback_data, message.message); await f.assistant.serial;
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
    assert.ok(f.inbox.list().includes(item));
    await f.callback(answerButtons(message)[3].callback_data, message.message); await f.assistant.serial;
    assert.ok(f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && c.params.message_id === message.message.message_id));
    assert.equal(f.inbox.list().includes(item), false);
    assert.equal(item.status, 'open', 'submission must not pretend Codex completed the request');
    const uncertainHistory = f.put('cleanup-unknown', 'input');
    uncertainHistory.turns[0].items[0].text = 'Choose?\n- One\n- Two';
    await f.scan(); const uncertain = f.inbox.list()[0], uncertainMessage = f.sent.at(-1);
    f.tools.send = async () => { throw new Error('Outcome unknown'); };
    await f.callback(answerButtons(uncertainMessage)[0].callback_data, uncertainMessage.message); await f.assistant.serial;
    assert.ok(f.inbox.list().includes(uncertain));
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === uncertainMessage.message.message_id));
  } finally { f.cleanup(); }
});

test('notification control removal retries transient failures and records missing or old messages durably', async () => {
  const f = fixture(); try {
    f.put('delete-retry', 'input'); await f.scan(); const item = f.inbox.list()[0];
    f.inbox.resolve(item, 'Answered in Codex.');
    let attempts = 0; const call = f.assistant.telegram.call;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'editMessageReplyMarkup') { attempts++; throw Object.assign(new Error('Slow down'), { retryAfter: 120 }); }
      return call(method, params);
    };
    await f.assistant.controls.flush(); await f.assistant.controls.flush();
    assert.equal(attempts, 1);
    f.advance(120_001);
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'editMessageReplyMarkup') { attempts++; throw Object.assign(new Error('Gone'), { telegramReason: 'message-missing' }); }
      return call(method, params);
    };
    await f.assistant.controls.flush(); await f.assistant.controls.flush();
    assert.equal(attempts, 2);
    assert.equal(item.notificationMessages[item.messageIds[0]].status, 'missing');
    assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('legacy undeletable notifications close without buttons and stay closed across restart', async () => {
  const f = fixture(); try {
    f.put('legacy-cleanup'); await f.scan(); const item = f.inbox.list('updates')[0];
    item.mediaMessageIds = ['501']; f.assistant.controls.record(item, { message_id: 501 });
    delete item.notificationMessages;
    f.inbox.review(item.id);
    const call = f.assistant.telegram.call;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'deleteMessage') {
        f.calls.push({ method, params }); throw Object.assign(new Error('Too old'), { telegramReason: 'message-cannot-delete' });
      }
      return call(method, params);
    };
    await f.assistant.controls.flush();
    assert.ok(f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && c.params.message_id === 501));
    for (const edit of f.calls.filter(c => /^editMessage/.test(c.method))) assert.deepEqual(edit.params.reply_markup.inline_keyboard, []);
    const saved = new StateStore(f.store.file); const restored = new Inbox(saved);
    assert.equal(restored.list('updates').length, 0);
    assert.ok(Object.values(restored.get(item.id).notificationMessages).every(m => m.status === 'closed'));
    const before = f.calls.length; await f.assistant.controls.flush(); assert.equal(f.calls.length, before);
  } finally { f.cleanup(); }
});

const outgoingPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x0AAAAASUVORK5CYII=', 'base64');

test('multipart question refresh preserves chunks instead of duplicating the whole question', async () => {
  const f = fixture(); try {
    const item = f.inbox.observe('long-choice', { source: 'desktop', kind: 'input', label: 'Long question',
      text: '', route: { threadId: 'long-choice', hostId: 'local' },
      choiceQuestions: [{ index: 0, title: 'A'.repeat(1890) + '?', options: ['Blue', 'Green'] },
        { index: 1, title: 'B'.repeat(1950) + '?', options: ['Small', 'Large'] }] });
    const payloads = [], tg = new Telegram('test');
    tg.call = async (method, params) => {
      payloads.push({ method, params }); return { message_id: payloads.length, text: params.text };
    };
    f.assistant.telegram = tg;
    await f.assistant.controls.notify(item);
    assert.equal(item.messageIds.length, 2);
    const original = f.assistant.controls.questionText(item);
    assert.ok(original.length > 3900 && original.length < 4000);
    item.choiceSubmissions = { 0: { status: 'saved', answer: 'Blue' } };
    await f.assistant.controls.refreshChoiceMarkup(item);
    const edits = payloads.filter(p => /^edit/.test(p.method));
    assert.equal(edits.length, 2);
    assert.ok(edits.every(p => p.method === 'editMessageReplyMarkup'));
    // Even if the source text becomes short, previously split copies stay split.
    item.choiceQuestions[0].title = 'Color?';
    await f.assistant.controls.refreshChoiceMarkup(item);
    assert.equal(payloads.filter(p => p.method === 'editMessageText').length, 0);
    f.advance(49 * 60 * 60_000);
    f.inbox.resolve(item, 'Answered in Codex.');
    await f.assistant.controls.refreshChoiceMarkup(item);
    const closed = payloads.filter(p => p.method === 'editMessageReplyMarkup' && p.params.reply_markup.inline_keyboard.length === 0);
    assert.equal(closed.length, 2);
    assert.ok(closed.every(p => p.params.text === undefined && p.params.reply_markup.inline_keyboard.length === 0));
  } finally { f.cleanup(); }
});
test('desktop images beyond the brief summary retain exact reply routing and are not resent by Details', async () => {
  const f = fixture(); try {
    const image = join(f.dir, 'proof.png'); writeFileSync(image, outgoingPng);
    const h = f.put('image-source'); h.thread.cwd = f.dir;
    h.turns[0].items[0].text = 'Long summary. '.repeat(85) + `\n![Proof](<${image}>)`;
    let uploads = 0;
    f.assistant.telegram.sendImages = async (chat, images, label, replyTo, record) => {
      uploads++; assert.equal(images.length, 1); assert.equal(replyTo, 1);
      assert.deepEqual(images[0].bytes, outgoingPng); await record({ message_id: 800 }); return [{ message_id: 800 }];
    };
    f.store.data.selectedProjectId = 'b'; await f.scan(); const item = f.inbox.list('updates')[0];
    assert.match(f.sent[0].text, /Open & reply/); assert.equal(item.mediaDelivery.status, 'delivered');
    assert.equal(f.store.data.desktopReplies['800'].threadId, 'image-source');
    await f.say('Continue from this image.', 800); await f.assistant.serial;
    assert.equal(f.submissions[0].id, 'image-source'); assert.equal(f.store.data.selectedProjectId, 'b');
    await Promise.all([f.assistant.controls.item(item.id), f.assistant.controls.item(item.id)]);
    assert.equal(uploads, 1); assert.ok(!f.assistant.controls.choiceMessages(item).includes('800'));
  } finally { f.cleanup(); }
});

test('partially failed media preserves text, image routes and persistent no-replay claims', async () => {
  const f = fixture(); try {
    const image = join(f.dir, 'proof.png'); writeFileSync(image, outgoingPng);
    const h = f.put('partial-media'); h.thread.cwd = f.dir; h.turns[0].items[0].text = `An update.\n![Proof](<${image}>)`;
    let uploads = 0;
    f.assistant.telegram.sendImages = async (chat, images, label, replyTo, record) => {
      uploads++; await record({ message_id: 801 }); throw new Error('Upload response lost');
    };
    await f.scan(); const item = f.inbox.list('updates')[0];
    assert.equal(item.delivery, 'delivered'); assert.equal(item.mediaDelivery.status, 'unknown');
    assert.equal(f.store.data.desktopReplies['801'].threadId, 'partial-media');
    assert.equal(new StateStore(f.store.file).data.inbox.items[item.id].mediaDelivery.status, 'unknown');
    await f.assistant.controls.item(item.id); assert.equal(uploads, 1);
    assert.match(f.sent.at(-1).text, /Image delivery is unconfirmed/);
    item.mediaDelivery.status = 'sending'; f.store.save();
    const restored = new StateStore(f.store.file); new Inbox(restored).recoverBridge();
    assert.equal(restored.data.inbox.items[item.id].mediaDelivery.status, 'unknown');
  } finally { f.cleanup(); }
});

test('a media-failure notice leaves the first Details message selected without forcing the native composer', async () => {
  const f = fixture(); try {
    const image = join(f.dir, 'proof.png'); writeFileSync(image, outgoingPng);
    const h = f.put('details-media-failure'); h.thread.cwd = f.dir;
    h.turns[0].items[0].text = `Done.\n![Proof](<${image}>)`;
    f.inbox.data.settings.routine = 'inbox'; await f.scan();
    const item = f.inbox.list('updates')[0];
    f.assistant.telegram.sendImages = async () => { throw new Error('Upload uncertain'); };
    await f.assistant.controls.item(item.id);
    assert.equal(f.sent.length, 2);
    assert.ok(f.sent.every(m => !m.keyboard.force_reply));
    assert.equal(f.inbox.data.nextReplyMessageId, String(f.sent[0].message.message_id));
    f.advance(49 * 60 * 60_000); f.inbox.review(item.id);
    await f.assistant.controls.flushCleanup();
    assert.equal(f.inbox.data.nextReplyMessageId, undefined);
    let general;
    f.assistant.routeFreshMessage = async text => { general = text; return 'awaiting-route'; };
    await f.say('New general question'); await f.assistant.serial;
    assert.equal(general, 'New general question');
    const edits = f.calls.filter(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0);
    assert.equal(edits.length, 2);
    assert.ok(edits.every(c => !c.params.reply_markup.force_reply && !c.params.reply_markup.inline_keyboard.length));
  } finally { f.cleanup(); }
});

test('bridge image attachments retain job replies and digest mode defers images until Details', async () => {
  const f = fixture(); try {
    const image = join(f.dir, 'proof.png'); writeFileSync(image, outgoingPng);
    let uploads = 0;
    f.assistant.telegram.sendImages = async (chat, images, label, replyTo, record) => {
      uploads++; await record({ message_id: 810 + uploads }); return [{ message_id: 810 + uploads }];
    };
    f.store.data.jobs.j = { id: 'j', project: 'A', roots: [], imageRoots: [f.dir], executionMode: 'read-only-control', threadId: 'worker', status: 'completed' };
    const bridge = await f.assistant.notify('bridge-image', `Done.\n![Proof](<${image}>)`, { source: 'bridge', kind: 'completion', jobId: 'j', label: 'A', imageSource: `Done.\n![Proof](<${image}>)` });
    assert.equal(f.store.data.replies['811'], 'j'); assert.equal(bridge.mediaDelivery.status, 'delivered');
    const h = f.put('digest-image'); h.thread.cwd = f.dir; h.turns[0].items[0].text = `Done.\n![Proof](<${image}>)`;
    f.inbox.data.settings.routine = 'digest'; await f.scan(); assert.equal(uploads, 1);
    const item = f.inbox.list('updates').find(i => i.route?.threadId === 'digest-image');
    await Promise.all([f.assistant.controls.item(item.id), f.assistant.controls.item(item.id)]);
    assert.equal(uploads, 2); assert.equal(f.store.data.desktopReplies['812'].threadId, 'digest-image');
  } finally { f.cleanup(); }
});

test('image-like metadata cannot attach files and refreshed question wording is never cached behind media state', async () => {
  const f = fixture(); try {
    const image = join(f.dir, 'proof.png'); writeFileSync(image, outgoingPng);
    let uploads = 0;
    f.assistant.telegram.sendImages = async (chat, images, label, replyTo, record) => {
      uploads++; await record({ message_id: 850 }); return [{ message_id: 850 }];
    };
    const metadata = f.put('metadata-image'); metadata.thread.cwd = f.dir;
    metadata.thread.title = '![Metadata only](proof.png)'; await f.scan();
    assert.equal(uploads, 0);
    const h = f.put('changing-image', 'input'); h.thread.cwd = f.dir;
    h.turns[0].items[0].text = `Old wording ![Proof](<${image}>)\n- Blue\n- Green`;
    await f.scan(); const item = f.inbox.list().find(i => i.route?.threadId === 'changing-image');
    assert.equal(uploads, 1);
    h.turns[0].items[0].text = `New wording ![Current proof](<${image}>)\n- Red\n- Green`;
    await f.scan(); await f.assistant.controls.item(item.id);
    assert.equal(uploads, 1); assert.match(f.sent.at(-1).text, /New wording Image: Current proof/);
    assert.doesNotMatch(f.sent.at(-1).text, /Old wording/);
    assert.ok(answerButtons(f.sent.at(-1)).some(b => b.text === 'Red'));
  } finally { f.cleanup(); }
});

test('desktop choices send the full answer to the source once across project switches and copied Details', async () => {
  const f = fixture(); try {
    const h = f.put('choices', 'input'), label = 'Blue ' + 'very long option '.repeat(10);
    h.turns[0].items[0].text = `Which color?\n- ${label}\n- Green`;
    await f.scan(); const original = f.sent[0], item = f.inbox.list()[0];
    assert.equal(answerButtons(original).length, 2);
    assert.equal(answerButtons(original)[0].text, label);
    for (const b of answerButtons(original)) assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    f.store.data.selectedProjectId = 'b'; await f.assistant.controls.item(item.id); const details = f.sent.at(-1);
    const data = answerButtons(details)[0].callback_data;
    await f.callback(data, details.message, 2); assert.equal(f.submissions.length, 0);
    await f.callback(data, { ...details.message, message_id: 999 }); await f.assistant.serial;
    assert.equal(f.submissions.length, 0);
    await f.callback(data, details.message); await f.assistant.serial;
    await f.callback(answerButtons(original)[1].callback_data, original.message); await f.assistant.serial;
    assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].id, 'choices');
    assert.ok(f.submissions[0].text.includes(label)); assert.equal(f.store.data.selectedProjectId, 'b');
    assert.equal(f.calls.filter(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0).length, 2);
    assert.equal(answerButtons({ keyboard: f.assistant.controls.buttons(item) }).length, 0);
  } finally { f.cleanup(); }
});

test('desktop choice clicks recheck native answers and changed options before sending', async () => {
  const f = fixture(); try {
    const h = f.put('choices', 'input'); h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
    await f.scan(); const original = f.sent[0], data = answerButtons(original)[0].callback_data;
    h.turns[0].items[0].text = 'Which color?\n- Red\n- Green';
    await f.callback(data, original.message); await f.assistant.serial; assert.equal(f.submissions.length, 0);
    h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
    h.turns[0].items.push({ type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>' + JSON.stringify([
      { questionItemId: JSON.stringify(['request_user_input_async', 'call_choices', 0]), question: 'Which color?', answer: 'Blue' }
    ]) + '</send_user_message_question_reply>' }] });
    await f.callback(data, original.message); await f.assistant.serial; assert.equal(f.submissions.length, 0);
    await f.scan(); assert.equal(answerButtons({ keyboard: f.assistant.controls.buttons(f.inbox.get(Object.keys(f.inbox.data.items)[0])) }).length, 0);
  } finally { f.cleanup(); }
});

test('multi-question choices keep their original indexes after another question is answered', async () => {
  const f = fixture(); try {
    const h = f.put('multi', 'input');
    h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green\n\nWhich size?\n- Small\n- Large';
    await f.scan(); const original = f.sent[0]; assert.equal(answerButtons(original).length, 4);
    h.turns[0].items.push({ type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>' + JSON.stringify([
      { questionItemId: JSON.stringify(['request_user_input_async', 'call_multi', 0]), question: 'Which color?', answer: 'Blue' }
    ]) + '</send_user_message_question_reply>' }] });
    await f.scan(); const item = f.inbox.list()[0];
    assert.equal(answerButtons({ keyboard: f.assistant.controls.buttons(item) }).length, 2);
    await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
    assert.equal(f.submissions.length, 0);
    await f.callback(answerButtons(original)[3].callback_data, original.message); await f.assistant.serial;
    assert.equal(f.submissions.length, 1); assert.match(f.submissions[0].text, /Which size\?[\s\S]*Large/);
  } finally { f.cleanup(); }
});

test('desktop groups collect every choice before one follow-up creates a newer turn', async () => {
  const f = fixture(); try {
    const h = f.put('batch', 'input'); h.turns[0].status = 'completed'; h.thread.status.type = 'idle';
    h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green\n\nWhich size?\n- Small\n- Large';
    f.tools.send = async (id, text) => {
      f.submissions.push({ id, text }); h.turns.unshift({ id: 'new-turn', status: 'inProgress', items: [] });
      h.thread.status.type = 'active';
      return { status: 'sent' };
    };
    await f.scan(); const original = f.sent[0], item = f.inbox.list()[0];
    await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
    assert.equal(f.submissions.length, 0);
    assert.match(f.calls.filter(c => c.method === 'answerCallbackQuery').at(-1).params.text, /Saved.*1 more answer/);
    assert.equal(new StateStore(f.store.file).data.inbox.items[item.id].choiceSubmissions['0'].status, 'saved');
    await f.scan(); assert.equal(f.inbox.list().length, 1);
    await f.callback(answerButtons(original)[3].callback_data, original.message); await f.assistant.serial;
    assert.equal(f.submissions.length, 1); assert.match(f.submissions[0].text, /Which color\?[\s\S]*Blue[\s\S]*Which size\?[\s\S]*Large/);
    assert.ok(Object.values(item.choiceSubmissions).every(c => c.status === 'submitted'));
    await f.scan(); assert.equal(item.status, 'resolved');
  } finally { f.cleanup(); }
});

test('free text includes a saved desktop choice when answering the rest of a group', async () => {
  const f = fixture(); try {
    const h = f.put('mixed', 'input');
    h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green\n\nWhich size?\n- Small\n- Large';
    await f.scan(); const original = f.sent[0], item = f.inbox.list()[0];
    await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
    await f.say('Use a custom medium size.', original.message.message_id); await f.assistant.serial;
    assert.equal(f.submissions.length, 1); assert.match(f.submissions[0].text, /Blue[\s\S]*custom medium/);
    assert.equal(item.choiceSubmissions['0'].status, 'submitted');
  } finally { f.cleanup(); }
});

test('choice and selected-status labels redact credentials before sending Telegram markup', async () => {
  const f = fixture(); try {
    const h = f.put('redacted-choice', 'input');
    h.turns[0].items[0].text = 'Which setting?\n- password=sampleSecretValue\n- TEST_SECRET';
    await f.scan(); const original = f.sent[0];
    assert.doesNotMatch(JSON.stringify(original.keyboard), /sampleSecretValue|TEST_SECRET/);
    await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
    assert.match(f.submissions[0].text, /password=sampleSecretValue/);
    assert.doesNotMatch(JSON.stringify(f.calls.filter(c => /^editMessage/.test(c.method))), /sampleSecretValue|TEST_SECRET/);
  } finally { f.cleanup(); }
});

test('a queued or uncertain text answer prevents a stale button from submitting the question again', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture(); try {
      const h = f.put('text-claim', 'input'); h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
      await f.scan(); const original = f.sent[0], item = f.inbox.list()[0];
      f.tools.send = async (id, text) => {
        f.submissions.push({ id, text });
        if (uncertain) throw new Error('Connection lost after sending');
        return { status: 'queued' }; // Original native turn and question remain current.
      };
      await f.say('Custom blue', original.message.message_id); await f.assistant.serial;
      await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
      assert.equal(f.submissions.length, 1);
      assert.equal(answerButtons({ keyboard: f.assistant.controls.buttons(item) }).length, 0);
      assert.ok(new StateStore(f.store.file).data.inbox.items[item.id].answerSubmissionId);
    } finally { f.cleanup(); }
  }
});

test('a failed Telegram confirmation cannot erase a durably collected desktop choice', async () => {
  const f = fixture(); try {
    const h = f.put('confirm-failed', 'input');
    h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green\n\nWhich size?\n- Small\n- Large';
    await f.scan(); const original = f.sent[0], item = f.inbox.list()[0];
    const call = f.assistant.telegram.call;
    let popupFailures = 0;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'answerCallbackQuery') { popupFailures++; throw new Error('Telegram confirmation timed out'); }
      return call(method, params);
    };
    f.assistant.telegram.send = async () => { throw new Error('Fallback notice timed out'); };
    await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
    assert.equal(new StateStore(f.store.file).data.inbox.items[item.id].choiceSubmissions['0'].status, 'saved');
    await f.callback(answerButtons(original)[3].callback_data, original.message); await f.assistant.serial;
    assert.equal(popupFailures, 2);
    assert.equal(f.submissions.length, 1); assert.match(f.submissions[0].text, /Blue[\s\S]*Large/);
  } finally { f.cleanup(); }
});

test('queued and uncertain button answers cannot be replayed through free text', async () => {
  for (const uncertain of [false, true]) {
    const f = fixture(); try {
      const h = f.put('button-claim', 'input'); h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
      await f.scan(); const original = f.sent[0], item = f.inbox.list()[0];
      f.tools.send = async (id, text) => {
        f.submissions.push({ id, text });
        if (uncertain) throw new Error('Connection lost after sending');
        return { status: 'queued' };
      };
      await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
      const claim = item.answerSubmissionId;
      await f.say('Blue', original.message.message_id); await f.assistant.serial;
      assert.equal(f.submissions.length, 1); assert.equal(item.answerSubmissionId, claim);
    } finally { f.cleanup(); }
  }
});

test('changed groups keep valid saved choices and release only changed unsubmitted selections', async () => {
  for (const changeSavedQuestion of [false, true]) {
    const f = fixture(); try {
      const h = f.put('changed-group', 'input');
      h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green\n\nWhich size?\n- Small\n- Large';
      await f.scan(); const original = f.sent[0], item = f.inbox.list()[0];
      await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
      h.turns[0].items[0].text = changeSavedQuestion ? 'Which color?\n- Red\n- Green\n\nWhich size?\n- Small\n- Large'
        : 'Which color?\n- Blue\n- Green\n\nWhich size?\n- Medium\n- Large';
      if (changeSavedQuestion) {
        // Free text also rechecks saved selections before the next scan.
        await f.say('Use red and medium instead.', original.message.message_id); await f.assistant.serial;
        assert.equal(item.choiceSubmissions['0'], undefined);
        assert.match(f.submissions[0].text, /His new message:\nUse red and medium instead\./);
      } else {
        await f.scan(); assert.equal(item.choiceSubmissions['0'].status, 'saved');
        await f.assistant.controls.item(item.id); const details = f.sent.at(-1);
        await f.callback(answerButtons(details)[0].callback_data, details.message); await f.assistant.serial;
        assert.match(f.submissions[0].text, /Blue[\s\S]*Medium/);
      }
      assert.equal(f.submissions.length, 1);
    } finally { f.cleanup(); }
  }
});

test('native choice buttons and free text answer separate questions without duplicate native responses', async () => {
  const f = fixture(); try {
    f.store.data.jobs.j = { id: 'j', threadId: 'worker', project: 'A', status: 'running' }; f.assistant.active.set('worker', 'j');
    await f.assistant.onRequest({ id: 88, method: 'item/tool/requestUserInput', params: { threadId: 'worker', questions: [
      { id: 'color', question: 'Which color?', options: [{ label: 'Blue', description: 'A blue background' }, { label: 'Green' }] },
      { id: 'size', question: 'Which size?', options: [{ label: 'Small' }, { label: 'Large' }] }
    ] } });
    const first = f.sent[0], second = f.sent[1];
    const firstItem = f.inbox.list().find(item => item.questionId === 'color');
    await f.assistant.controls.item(firstItem.id);
    assert.ok(f.inbox.data.nextReplyMessageId);
    await f.callback(answerButtons(first)[0].callback_data, first.message); await f.assistant.serial;
    assert.equal(f.inbox.data.nextReplyMessageId, undefined);
    await f.assistant.controls.item(firstItem.id);
    assert.equal(f.inbox.data.nextReplyMessageId, undefined);
    assert.equal(f.native.length, 0); assert.equal(f.inbox.list().length, 2);
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
    await f.callback(answerButtons(first)[1].callback_data, first.message); await f.assistant.serial;
    await f.say('Large', second.message.message_id);
    assert.equal(f.native.length, 1); assert.deepEqual(f.native[0].value.answers, { color: { answers: ['Blue'] }, size: { answers: ['Large'] } });
    await f.callback(answerButtons(second)[0].callback_data, second.message); await f.assistant.serial;
    assert.equal(f.native.length, 1); assert.equal(f.inbox.list().length, 0);
  } finally { f.cleanup(); }
});

test('uncertain desktop choice submissions stay claimed on disk and are never replayed', async () => {
  const f = fixture(); try {
    const h = f.put('uncertain-choice', 'input'); h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
    await f.scan(); const original = f.sent[0];
    f.tools.send = async (id, text) => { f.submissions.push({ id, text }); throw new Error('Connection lost after sending'); };
    await f.callback(answerButtons(original)[0].callback_data, original.message); await f.assistant.serial;
    await f.callback(answerButtons(original)[1].callback_data, original.message); await f.assistant.serial;
    assert.equal(f.submissions.length, 1);
    const saved = new StateStore(f.store.file).data.inbox.items[f.inbox.list()[0].id];
    assert.equal(saved.choiceSubmissions['0'].status, 'unknown');
  } finally { f.cleanup(); }
});

test('Home entry commands and notification navigation reuse one durable panel', async () => {
  const f = fixture(); try {
    await Promise.all([f.say('/menu'), f.say('/help'), f.say('/settings')]);
    const home = f.sent[0].message;
    for (const command of ['/inbox', '/project', '/updates', '/cleanup', '/connection', '/menu']) await f.say(command);
    assert.equal(f.sent.length, 1, 'navigation commands must reuse the existing Home message');
    assert.equal(String(new StateStore(f.store.file).data.inbox.homePanelId), String(home.message_id));
    assert.ok(f.calls.filter(c => c.method === 'editMessageText').every(c => c.params.message_id === home.message_id));
    f.put('source-update'); await f.scan(); const notification = f.sent.at(-1).message;
    const count = f.sent.length;
    await f.callback('ctl:home', notification);
    assert.equal(f.sent.length, count); assert.ok(!f.inbox.data.panels[notification.message_id]);
    assert.equal(f.store.data.desktopReplies[notification.message_id].threadId, 'source-update');
    assert.equal(f.native.length, 0); assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('Home recovers confirmed deletion but never duplicates an unknown edit outcome', async () => {
  const f = fixture(); try {
    await f.say('/menu'); const home = f.sent[0].message, call = f.assistant.telegram.call;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'editMessageText' && params.message_id === home.message_id)
        throw Object.assign(new Error('Gone'), { telegramReason: 'message-missing' });
      return call(method, params);
    };
    await f.say('/settings');
    assert.equal(f.sent.length, 2); assert.ok(f.inbox.data.panels[home.message_id].dismissedAt);
    assert.equal(String(f.inbox.data.homePanelId), String(f.sent.at(-1).message.message_id));
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'editMessageText') throw new Error('Unknown connection outcome');
      return call(method, params);
    };
    await assert.rejects(f.say('/help'), /Unknown connection/);
    assert.equal(f.sent.length, 2);
  } finally { f.cleanup(); }
});

test('digest navigation and resolved Details keep the existing Home panel', async () => {
  const f = fixture(); try {
    await f.say('/menu'); const home = f.sent[0].message;
    await f.assistant.controls.panel('Your updates', { inline_keyboard: [[{ text: 'Updates', callback_data: 'ctl:updates:0' }]] }, undefined, 'digest');
    const digest = f.sent.at(-1).message;
    await f.callback('ctl:updates:0', digest);
    assert.equal(f.sent.length, 2);
    assert.equal(String(f.inbox.data.homePanelId), String(home.message_id));
    assert.equal(f.inbox.data.panels[digest.message_id].view, 'digest');
    assert.equal(f.calls.filter(c => c.method === 'editMessageText').at(-1).params.message_id, home.message_id);
    const item = f.inbox.observe('closed-details', { source: 'desktop', kind: 'completion', label: 'Reviewed result' });
    f.inbox.review(item.id); await f.assistant.controls.item(item.id);
    assert.equal(f.sent.length, 2);
  } finally { f.cleanup(); }
});

test('automatic inbox refreshes cannot overwrite newer Home navigation in either queue order', async () => {
  for (const first of ['refresh', 'navigation']) {
    const f = fixture(); try {
      f.put('home-refresh-race', 'input'); await f.scan(); await f.say('/inbox');
      const home = f.sent.at(-1).message;
      f.inbox.resolve(f.inbox.list()[0], 'Answered in Codex.');
      let entered, release;
      const waiting = new Promise(resolve => { entered = resolve; });
      const held = new Promise(resolve => { release = resolve; });
      const call = f.assistant.telegram.call;
      if (first === 'refresh') f.assistant.telegram.call = async (method, params) => {
        if (method === 'editMessageText' && /No open requests/.test(params.text)) { entered(); await held; }
        return call(method, params);
      };
      else f.tools.list = async () => { entered(); await held; return []; };
      const pending = first === 'refresh' ? f.assistant.controls.refreshClosedInboxPanels() : f.assistant.controls.open('running');
      await waiting;
      const later = first === 'refresh' ? f.assistant.controls.open('settings') : f.assistant.controls.refreshClosedInboxPanels();
      await new Promise(resolve => setImmediate(resolve)); release();
      await Promise.all([pending, later]);
      const expected = first === 'refresh' ? 'settings' : 'running';
      assert.equal(f.inbox.data.panels[home.message_id].view, expected);
      const last = f.calls.filter(c => c.method === 'editMessageText' && c.params.message_id === home.message_id).at(-1).params.text;
      assert.match(last, expected === 'settings' ? /Notification settings/ : /Running work/);
    } finally { f.cleanup(); }
  }
});

test('successful answer buttons use a popup without a new confirmation message', async () => {
  const f = fixture(); try {
    f.put('quiet-button', 'input').turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
    await f.scan(); const message = f.sent[0];
    await f.callback(answerButtons(message)[1].callback_data, message.message); await f.assistant.serial;
    assert.equal(f.submissions.length, 1); assert.equal(f.sent.length, 1);
    assert.ok(f.calls.some(c => c.method === 'answerCallbackQuery' && /Sent.*quiet-button/s.test(c.params.text || '')));
  } finally { f.cleanup(); }
});

test('housekeeping records only controls and offers silent closable help', async () => {
  const f = fixture(); try {
    let dispatched = 0; f.assistant.coordinate = async () => { dispatched++; };
    const send = (id, text) => f.assistant.handleUpdate({ update_id: id, message: { message_id: id,
      from: { id: 1 }, chat: { id: 1, type: 'private' }, text } });
    await send(1001, '/menu'); await send(1002, '/dismiss');
    const help = f.sent.at(-1);
    assert.equal(help.options?.silent, true);
    assert.ok(help.keyboard.inline_keyboard.flat().some(b => b.callback_data === 'ctl:hide'));
    await send(1003, 'Inspect this project'); await f.assistant.serial;
    assert.equal(dispatched, 1);
    assert.ok(f.inbox.data.housekeeping['1001']); assert.ok(f.inbox.data.housekeeping['1002']);
    assert.equal(f.inbox.data.housekeeping['1003']?.delivery, 'submitted');
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === 1003), 'ordinary prompts wait for explicit cleanup');
    await f.assistant.callback({ id: 'foreign-hide', data: 'ctl:hide', from: { id: 2 }, message: help.message });
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === help.message.message_id));
    await f.assistant.callback({ id: 'owner-hide', data: 'ctl:hide', from: { id: 1 }, message: help.message });
    assert.equal(f.inbox.data.housekeeping[help.message.message_id].cleanup.status, 'deleted');
  } finally { f.cleanup(); }
});

const ownerReply = (f, id, text, target) => f.assistant.handleUpdate({ update_id: f.store.data.offset,
  message: { message_id: id, date: Math.floor(f.inbox.now() / 1000), text,
    from: { id: 1 }, chat: { id: 1, type: 'private' },
    ...(target ? { reply_to_message: typeof target === 'object' ? target : { message_id: target } } : {}) } });

test('sent replies and notifications are retained and the confirmation loses its buttons', async () => {
  const f = fixture(); try {
    f.put('reply-clutter'); await f.scan();
    const item = f.inbox.list('updates')[0], original = f.sent[0].message;
    await f.assistant.controls.item(item.id); const details = f.sent.at(-1).message;
    f.store.data.selectedProjectId = 'b';
    await ownerReply(f, 9001, 'Thanks, will do', details.message_id); await f.assistant.serial;
    await f.assistant.controls.flushCleanup();
    for (const id of [original.message_id, details.message_id])
      assert.ok(f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && c.params.message_id === id));
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
    assert.equal(f.submissions[0].id, 'reply-clutter'); assert.equal(f.inbox.list('updates').length, 0);
    assert.equal(f.inbox.data.housekeeping['9001'].delivery, 'submitted');
    const receipt = f.sent.at(-1).message;
    assert.match(f.sent.at(-1).text, /Sent your reply/);
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === receipt.message_id));
    f.advance(5001); await f.assistant.controls.flushCleanup();
    assert.ok(f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && c.params.message_id === receipt.message_id));
    assert.ok(f.store.data.desktopReplies[details.message_id], 'cleanup preserves exact reply routes');
  } finally { f.cleanup(); }
});

test('typed commands bring controls forward, inline buttons reuse them, and an uncertain send keeps the current picker', async () => {
  const f = fixture(); try {
    await ownerReply(f, 9001, '/menu'); const old = f.sent.at(-1).message;
    await ownerReply(f, 9002, '/inbox'); const inbox = f.sent.at(-1).message;
    assert.notEqual(inbox.message_id, old.message_id);
    assert.equal(f.inbox.data.homePanelId, String(inbox.message_id));
    assert.ok(f.inbox.data.panels[old.message_id].dismissedAt);
    await f.callback('ctl:projects', inbox);
    assert.equal(f.sent.length, 2);
    assert.equal(f.inbox.data.panels[inbox.message_id].view, 'projects');
    const picker = structuredClone(f.store.data.projectPicker);
    f.assistant.telegram.send = async () => { throw Error('Unknown send outcome'); };
    await assert.rejects(ownerReply(f, 9003, '/project'), /Unknown send outcome/);
    assert.deepEqual(f.store.data.projectPicker, picker);
    assert.equal(f.inbox.data.homePanelId, String(inbox.message_id));
    assert.ok(!f.inbox.data.panels[inbox.message_id].dismissedAt);
  } finally { f.cleanup(); }
});

test('Clear bot panels and notices uses one snapshot and keeps uncertain replies, requests, updates and Home', async () => {
  const f = fixture(); try {
    await ownerReply(f, 9001, '/menu');
    await f.assistant.controls.show('settings'); const other = f.sent.at(-1).message;
    await f.assistant.controls.help('Sent your earlier reply.'); const help = f.sent.at(-1).message;
    f.put('uncertain-clutter'); f.put('pending-clutter', 'input'); await f.scan();
    const item = f.inbox.list('updates')[0], original = Number(item.messageIds[0]);
    f.tools.send = async () => { throw new Error('Unknown delivery'); };
    await ownerReply(f, 9002, 'Keep this until confirmed', original); await f.assistant.serial;
    await ownerReply(f, 9003, '/cleanup');
    const home = f.sent.at(-1).message;
    const buttons = f.sent.at(-1).keyboard.inline_keyboard.flat();
    const action = buttons.find(b => b.text.startsWith('Clear bot panels and notices')).callback_data;
    await f.assistant.controls.help('A newly arrived notice'); const fresh = f.sent.at(-1).message;
    await f.callback(action, home, 2);
    assert.ok(!f.inbox.data.panels[other.message_id].dismissedAt);
    await f.callback(action, home); await f.assistant.controls.flushCleanup();
    for (const id of [help.message_id, other.message_id])
      assert.ok(f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === id));
    for (const id of [9001, 9002, 9003, home.message_id, original, fresh.message_id])
      assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === id));
    assert.equal(item.status, 'open'); assert.equal(f.inbox.list().length, 1);
    assert.ok(f.inbox.data.housekeeping['9002']);
    assert.ok(!f.assistant.controls.housekeeping.candidates().includes('9002'));
    await f.callback(action, home); await f.assistant.controls.flushCleanup();
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === fresh.message_id), 'stale buttons cannot sweep new arrivals');
  } finally { f.cleanup(); }
});

test('partial native text answers stay until the entire group reaches Codex', async () => {
  const f = fixture(); try {
    f.store.data.jobs.j = { id: 'j', threadId: 'worker', project: 'A', status: 'running' }; f.assistant.active.set('worker', 'j');
    await f.assistant.onRequest({ id: 88, method: 'item/tool/requestUserInput', params: { threadId: 'worker', questions: [
      { id: 'a', question: 'Which color?' }, { id: 'b', question: 'Which size?' }
    ] } });
    const first = f.sent[0].message, second = f.sent[1].message;
    await ownerReply(f, 9001, 'Blue', first.message_id); await f.assistant.controls.flushCleanup();
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === 9001));
    assert.ok(!f.assistant.controls.housekeeping.candidates().includes('9001'));
    await ownerReply(f, 9003, 'Red', first.message_id);
    await ownerReply(f, 9002, 'Large', second.message_id); await f.assistant.controls.flushCleanup();
    assert.equal(f.native.length, 1);
    for (const id of [9001, 9002]) assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === id));
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === 9003), 'a rejected duplicate answer was never sent');
    assert.ok(!f.assistant.controls.housekeeping.candidates().includes('9003'));
    assert.equal(f.inbox.list().length, 0);
  } finally { f.cleanup(); }
});

test('dismiss can remove an older owner message without adopting foreign or forwarded content', async () => {
  const f = fixture(); try {
    for (const [id, from, extra] of [[9001, 1, {}], [9002, 2, {}], [9003, 1, { forward_origin: { type: 'user' } }]]) {
      await ownerReply(f, id + 100, '/dismiss', { message_id: id, text: 'Old reply',
        from: { id: from }, chat: { id: 1, type: 'private' }, ...extra });
    }
    assert.ok(f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === 9001));
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && [9002, 9003].includes(c.params.message_id)));
    assert.ok(!f.calls.some(c => c.method === 'editMessageText' && c.params.message_id === 9001));
  } finally { f.cleanup(); }
});

test('Cleanup opens from More and preserves the owner message', async () => {
  const f = fixture(); try {
    f.assistant.coordinate = async () => {};
    await ownerReply(f, 9001, 'An ordinary accepted prompt'); await f.assistant.serial;
    assert.ok(!f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === 9001));
    await ownerReply(f, 9002, '/menu'); const home = f.sent.at(-1).message;
    assert.ok(!f.sent.at(-1).keyboard.inline_keyboard.flat().some(b => b.callback_data.startsWith('ctl:clean:')));
    await f.callback('ctl:more', home); await f.callback('ctl:cleanup', home);
    const action = f.calls.filter(c => c.method === 'editMessageText').at(-1).params.reply_markup.inline_keyboard.flat().find(b => b.text.startsWith('Clear bot panels and notices')).callback_data;
    const call = f.assistant.telegram.call;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'deleteMessage' && params.message_id === 9001)
        throw Object.assign(new Error('Cannot delete'), { telegramReason: 'message-cannot-delete' });
      return call(method, params);
    };
    await f.callback(action, home); await f.assistant.controls.flushCleanup();
    assert.equal(f.inbox.data.housekeeping['9001'].cleanup, undefined);
    assert.ok(!f.calls.some(c => /^editMessage/.test(c.method) && c.params.message_id === 9001));
    assert.equal(f.inbox.data.panels[home.message_id].view, 'cleanup');
    assert.equal(f.sent.length, 1, 'the clear action updates Home without appending another panel');
  } finally { f.cleanup(); }
});

test('a rejected callback acknowledgement cannot block Close or Refresh', async () => {
  const f = fixture(); try {
    await f.say('/menu');
    const panel = f.sent.at(-1).message;
    await f.callback('ctl:running', panel);
    const call = f.assistant.telegram.call;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'answerCallbackQuery') throw Object.assign(new Error('Callback acknowledgement expired'), { code: 400 });
      return call(method, params);
    };
    f.put('new-active-task', 'input');
    await f.callback('ctl:running', panel);
    assert.match(f.calls.filter(entry => entry.method === 'editMessageText').at(-1).params.text, /new-active-task/);
    await f.callback('ctl:close', panel);
    assert.deepEqual(f.calls.filter(entry => entry.method === 'deleteMessage').map(entry => entry.params.message_id), [panel.message_id]);
  } finally { f.cleanup(); }
});

test('a verified tap retires a reviewed update whose delivery acknowledgement was lost', async () => {
  const f = fixture(); try {
    f.assistant.telegram.token = '111222:' + 'fixture'.repeat(5);
    const item = f.inbox.observe('uncertain-notification', { source: 'desktop', kind: 'completion',
      label: 'An update', text: 'The full update stays here.', route: { threadId: 'source', hostId: 'local' } });
    item.delivery = 'unknown';
    f.inbox.review(item.id);
    const data = 'ctl:item:' + item.id;
    const card = { message_id: 891, chat: { id: 1, type: 'private' }, from: { id: 111222, is_bot: true },
      reply_markup: { inline_keyboard: [[{ text: 'Open & reply', callback_data: data }]] } };
    await f.callback(data, { ...card, message_id: 892, from: { id: 111223, is_bot: true } });
    assert.equal(item.messageIds, undefined);
    await f.callback(data, card);
    assert.equal(item.delivery, 'delivered');
    assert.deepEqual(item.messageIds, ['891']);
    assert.equal(f.inbox.data.nextReplyMessageId, undefined);
    assert.ok(f.calls.some(c => c.method === 'answerCallbackQuery' && /already reviewed/.test(c.params.text)));
    assert.deepEqual(f.calls.filter(c => c.params.message_id === 891).map(({ method }) => method), ['editMessageReplyMarkup']);
  } finally { f.cleanup(); }
});

test('navigation and automatic housekeeping preserve sent messages and delivered updates', async () => {
  const f = fixture(); try {
    await f.say('/menu');
    const first = f.sent.at(-1).message;
    await ownerReply(f, 9001, '/status');
    const second = f.sent.at(-1).message;
    const h = f.assistant.controls.housekeeping;
    h.trackReply({ message_id: 9002 });
    h.submitted(9002);
    f.put('reviewed-update'); await f.scan();
    const item = f.inbox.list('updates')[0];
    f.inbox.review(item.id);
    f.advance(90_000);
    await f.assistant.controls.flushCleanup();
    assert.ok(f.inbox.data.panels[first.message_id].dismissedAt);
    assert.ok(!f.inbox.data.panels[second.message_id].dismissedAt);
    assert.deepEqual(f.calls.filter(entry => entry.method === 'deleteMessage'), []);
    for (const id of [first.message_id, ...item.messageIds]) {
      assert.ok(f.calls.some(entry => entry.method === 'editMessageReplyMarkup' &&
        entry.params.message_id === Number(id) && entry.params.reply_markup.inline_keyboard.length === 0));
    }
  } finally { f.cleanup(); }
});

test('Clear chat asks first and deletes only the confirmed recent messages in the paired chat', async () => {
  const f = fixture(); try {
    await f.say('/menu');
    const home = f.sent.at(-1).message;
    const buttons = () => JSON.parse(f.inbox.data.panels[home.message_id].signature)[1].inline_keyboard.flat();
    const confirmation = () => buttons().find(b => b.callback_data.startsWith('ctl:clear-confirm:')).callback_data;
    const deletes = () => f.calls.filter(c => c.method === 'deleteMessages');
    const history = f.assistant.controls.history;
    const today = Math.floor(f.inbox.now() / 1000);
    const item = f.inbox.observe('keep-inbox', { source: 'bridge', kind: 'failure', label: 'Check task' });
    item.notificationMessages = { 802: { sentAt: today * 1000 } };
    await ownerReply(f, 800, '/unknown', { message_id: 801, chat: { id: 1, type: 'private' } });
    history.record({ message_id: 803, date: today - 49 * 3600 });
    history.record({ message_id: 804, date: today, dice: {} });
    history.record({ message_id: 805, date: today });
    f.store.save();
    await f.callback('ctl:clear-chat', home);
    const canceled = confirmation();
    await f.callback('ctl:home', home);
    await f.callback(canceled, home);
    assert.equal(deletes().length, 0);
    await f.callback('ctl:clear-chat', home);
    const action = confirmation();
    const snapshot = f.inbox.data.panels[home.message_id].clearOffer.ids.map(Number);
    assert.ok(snapshot.includes(800));
    assert.ok(snapshot.includes(802));
    assert.ok(snapshot.includes(805));
    assert.ok(!snapshot.some(id => [803, 804, home.message_id].includes(id)));
    await f.callback(action, home, 2);
    assert.equal(deletes().length, 0);
    const later = (await f.assistant.send('An answer after the confirmation opened'))[0];
    await f.callback(action, home);
    await f.callback(action, home);
    assert.deepEqual(deletes().map(c => c.params), [{ chat_id: 1, message_ids: snapshot }]);
    assert.equal(history.entries[String(later.message_id)].removed, undefined);
    assert.equal(f.inbox.get(item.id).status, 'open');
    assert.match(JSON.parse(f.inbox.data.panels[home.message_id].signature)[0], /Recent messages cleared/);
  } finally { f.cleanup(); }
});

test('Clear chat batches Telegram requests and keeps a failed batch eligible for explicit retry', async () => {
  const f = fixture(); try {
    const history = f.assistant.controls.history, date = Math.floor(f.inbox.now() / 1000);
    for (let id = 1000; id < 1105; id++) history.record({ message_id: id, date });
    const call = f.assistant.telegram.call;
    const batches = [];
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'deleteMessages') {
        batches.push(params.message_ids);
        if (batches.length === 2) throw new Error('Unknown outcome');
      }
      return call(method, params);
    };
    const targets = history.targets();
    assert.deepEqual(await history.clear(targets, f.assistant.telegram), { accepted: 100, remaining: 5 });
    assert.deepEqual(batches.map(batch => batch.length), [100, 5]);
    assert.deepEqual(history.targets(), ['1100', '1101', '1102', '1103', '1104']);
    assert.deepEqual(await history.clear(history.targets(), f.assistant.telegram), { accepted: 5, remaining: 0 });
    assert.deepEqual(history.targets(), []);
  } finally { f.cleanup(); }
});

test('Running reuses Home and separates live desktop activity from bridge jobs', async () => {
  const f = fixture(); try {
    f.put('active-desktop', 'input'); f.put('idle-desktop');
    await f.say('/menu'); await f.say('/status');
    const panel = f.calls.filter(c => c.method === 'editMessageText').at(-1).params;
    assert.match(panel.text, /Codex desktop[\s\S]*Task active-desktop[\s\S]*Work requested through Telegram/);
    assert.doesNotMatch(panel.text, /Task idle-desktop/);
    assert.equal(f.sent.length, 1); assert.equal(f.submissions.length, 0);
    f.tools.list = async () => { throw new Error('Desktop unavailable'); };
    await f.callback('ctl:running', f.sent[0].message);
    assert.match(f.calls.filter(c => c.method === 'editMessageText').at(-1).params.text, /desktop activity is unavailable/);
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test('Cleanup uses the displayed snapshot and protects questions, approvals, failures and new updates', async () => {
  const f = fixture(); try {
    await f.say('/menu'); const home = f.sent.at(-1).message;
    f.put('question-protected', 'input'); f.put('old-completion'); await f.scan();
    const old = f.inbox.list('updates')[0], question = f.inbox.list()[0];
    const approval = f.inbox.observe('protected-approval', { source: 'bridge', kind: 'approval', label: 'Approval', text: 'Approve?' });
    const failure = f.inbox.observe('protected-failure', { source: 'bridge', kind: 'failure', label: 'Failure', text: 'Check this' });
    await f.say('/cleanup');
    const keyboard = f.calls.filter(c => c.method === 'editMessageText').at(-1).params.reply_markup;
    const action = keyboard.inline_keyboard.flat().find(b => b.callback_data.startsWith('ctl:clean:updates:')).callback_data;
    f.put('new-completion'); await f.scan();
    await f.callback(action, home, 2); assert.equal(old.status, 'open');
    await f.callback(action, home); await f.assistant.controls.flush();
    assert.equal(old.status, 'reviewed');
    assert.equal(f.inbox.list('updates').length, 1);
    assert.equal(question.status, 'open'); assert.equal(approval.status, 'open'); assert.equal(failure.status, 'open');
    await f.callback(action, home);
    assert.equal(f.inbox.list('updates').length, 1, 'a stale cleanup button cannot include a new update');
    assert.ok(f.store.data.desktopReplies[old.messageIds[0]]);
    assert.equal(f.native.length, 0); assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('Cleanup closes other bot panels and retries bot notice deletion without editing user messages', async () => {
  const f = fixture(); try {
    await f.say('/menu');
    await f.assistant.controls.show('settings'); const other = f.sent.at(-1).message;
    const command = { update_id: 9001, message: { message_id: 9001, text: '/cleanup', from: { id: 1 }, chat: { id: 1, type: 'private' } } };
    await f.assistant.handleUpdate(command);
    const home = f.sent.at(-1).message;
    const keyboard = () => JSON.parse(f.inbox.data.panels[home.message_id].signature)[1].inline_keyboard.flat();
    const panelAction = keyboard().find(b => b.callback_data.startsWith('ctl:clean:panels:')).callback_data;
    await f.assistant.callback({ id: 'clean-panels', data: panelAction, from: { id: 1 }, message: home });
    assert.ok(f.inbox.data.panels[other.message_id].dismissedAt); assert.ok(!f.inbox.data.panels[home.message_id].dismissedAt);
    const notice = (await f.assistant.controls.help('Retry this notice'))[0];
    await f.callback('ctl:cleanup', home);
    const chatAction = keyboard().find(b => b.callback_data.startsWith('ctl:clean:chat:')).callback_data;
    const call = f.assistant.telegram.call; let deletes = 0;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'deleteMessage' && params.message_id === notice.message_id) { deletes++; throw Object.assign(new Error('Slow'), { retryAfter: 60 }); }
      return call(method, params);
    };
    await f.assistant.callback({ id: 'clean-chat', data: chatAction, from: { id: 1 }, message: home });
    await f.assistant.controls.flush(); assert.equal(deletes, 1);
    f.advance(60_001);
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'deleteMessage' && params.message_id === notice.message_id) throw Object.assign(new Error('Old'), { telegramReason: 'message-cannot-delete' });
      return call(method, params);
    };
    await f.assistant.controls.flush();
    assert.equal(f.inbox.data.housekeeping[notice.message_id].cleanup.status, 'closed');
    assert.ok(!f.calls.some(c => c.method === 'editMessageText' && c.params.message_id === notice.message_id));
    assert.ok(!f.inbox.data.panels[home.message_id].dismissedAt);
    assert.equal(f.inbox.data.housekeeping['9001'].cleanup, undefined);
  } finally { f.cleanup(); }
});

test('menu, settings, project selection and connection share the same message', async () => {
  const f = fixture(); try {
    await f.say('/menu'); const panel = f.sent.at(-1).message;
    await f.callback('ctl:settings', panel);
    await f.callback('ctl:detail:full', panel);
    await f.callback('ctl:home', panel);
    await f.callback('ctl:projects', panel);
    assert.equal(f.sent.length, 1, 'navigation must not append a project picker');
    const picker = f.calls.filter(c => c.method === 'editMessageText').at(-1).params;
    assert.equal(picker.message_id, panel.message_id);
    assert.ok(picker.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'ctl:home'));
    const choice = picker.reply_markup.inline_keyboard.flat().find(b => b.text === 'Project A').callback_data;
    await f.callback(choice, panel);
    assert.equal(f.store.data.selectedProjectId, 'a');
    assert.equal(f.inbox.data.panels[panel.message_id].view, 'home');
    assert.match(f.calls.filter(c => c.method === 'editMessageText').at(-1).params.text, /Send to: Project A/);
    await f.callback('ctl:settings', panel);
    await f.callback('ctl:health', panel);
    await f.callback('ctl:home', panel);
    assert.equal(f.sent.length, 1, 'selection and return navigation stay in place');
    assert.ok(f.calls.filter(c => c.method === 'editMessageText').every(c => c.params.message_id === panel.message_id));
    assert.equal(f.native.length, 0); assert.deepEqual(f.store.data.jobs, {});
    await f.say('A menu reply must not launch work', panel.message_id);
    await f.assistant.serial;
    assert.equal(f.native.length, 0); assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('Close removes only its panel, keeps settings and routes, and survives repeated callbacks', async () => {
  const f = fixture(); try {
    f.put('untouched-question', 'input'); await f.scan(); const question = f.inbox.list()[0];
    await f.say('/settings'); const panel = f.sent.at(-1).message;
    const settings = structuredClone(f.inbox.data.settings);
    assert.ok(f.sent.at(-1).keyboard.inline_keyboard.flat().some(b => b.callback_data === 'ctl:close'));
    await f.callback('ctl:close', panel, 2);
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
    await f.callback('ctl:close', panel);
    await f.callback('ctl:close', panel);
    await f.assistant.controls.flush();
    assert.deepEqual(f.calls.filter(c => c.method === 'deleteMessage').map(c => c.params.message_id), [panel.message_id]);
    assert.ok(f.inbox.data.panels[panel.message_id].dismissedAt);
    assert.equal(new StateStore(f.store.file).data.inbox.panels[panel.message_id].cleanup.status, 'deleted');
    assert.deepEqual(f.inbox.data.settings, settings);
    assert.equal(question.status, 'open'); assert.equal(f.inbox.list().length, 1);
    assert.equal(f.sent.length, 2, 'closing must not append a replacement message');
    assert.equal(f.native.length, 0); assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('replying /dismiss recognizes a legacy bot picker but refuses foreign or routed messages', async () => {
  const f = fixture(); try {
    f.assistant.telegram.token = '999:TEST_SECRET';
    const legacy = { message_id: 900, date: Math.floor(Date.now() / 1000), from: { id: 999, is_bot: true },
      chat: { id: 1, type: 'private' }, text: 'Current project: General / No project\n\nChoose a project for your next messages, or General for a separate general discussion. Switching does not start or stop work.',
      reply_markup: { inline_keyboard: [[{ text: 'General / No project', callback_data: 'project:0123456789abcdef:0' }]] } };
    let updateId = 9000;
    const dismiss = reply => f.assistant.handleUpdate({ update_id: updateId++, message: { message_id: updateId,
      text: '/dismiss', from: { id: 1 }, chat: { id: 1, type: 'private' }, reply_to_message: reply } });
    await dismiss({ ...legacy, message_id: 901, from: { id: 998, is_bot: true } });
    await dismiss({ ...legacy, message_id: 902, forward_origin: { type: 'user' } });
    f.store.data.desktopReplies['903'] = { threadId: 'original', kind: 'input' };
    await dismiss({ ...legacy, message_id: 903 });
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
    f.store.data.projectPicker = { nonce: '0123456789abcdef', choices: [null, 'a'], expiresAt: Date.now() + 60_000 };
    await dismiss(legacy);
    assert.ok(f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === 900));
    assert.ok(f.inbox.data.panels['900'].dismissedAt);
    await f.assistant.callback({ id: 'legacy-closed', data: 'project:0123456789abcdef:1', from: { id: 1 }, message: legacy });
    assert.equal(f.store.data.selectedProjectId || null, null);
    await f.assistant.serial;
    assert.equal(f.native.length, 0); assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('closing panels retries transient failures and leaves old undeletable menus without controls', async () => {
  const f = fixture(); try {
    await f.say('/menu'); const panel = f.sent.at(-1).message;
    const call = f.assistant.telegram.call; let attempts = 0;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'deleteMessage') { attempts++; throw Object.assign(new Error('Slow down'), { retryAfter: 120 }); }
      return call(method, params);
    };
    await f.callback('ctl:close', panel); await f.assistant.controls.flush();
    assert.equal(attempts, 1); assert.equal(f.inbox.data.panels[panel.message_id].cleanup.retryAt, f.inbox.now() + 120_000);
    f.advance(120_001); f.assistant.telegram.call = call; await f.assistant.controls.flush();
    assert.equal(f.inbox.data.panels[panel.message_id].cleanup.status, 'deleted');
    await f.say('/menu'); const old = f.sent.at(-1).message;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'deleteMessage') throw Object.assign(new Error('Old'), { telegramReason: 'message-cannot-delete' });
      return call(method, params);
    };
    await f.callback('ctl:close', old);
    const edit = f.calls.find(c => c.method === 'editMessageReplyMarkup' && c.params.message_id === old.message_id);
    assert.deepEqual(edit.params.reply_markup.inline_keyboard, []);
    assert.equal(f.inbox.data.panels[old.message_id].cleanup.status, 'closed');
    assert.equal(f.sent.length, 2);
  } finally { f.cleanup(); }
});

test('a closed panel survives an interrupted cleanup start and an in-flight inbox refresh', async () => {
  const f = fixture(); try {
    await f.say('/menu'); const menu = f.sent.at(-1).message;
    const cleanup = f.assistant.controls.cleanupPanel.bind(f.assistant.controls);
    f.assistant.controls.cleanupPanel = async () => 0;
    await f.callback('ctl:close', menu);
    assert.ok(new StateStore(f.store.file).data.inbox.panels[menu.message_id].cleanup,
      'dismissal must persist its cleanup job in the same save');
    f.assistant.controls.cleanupPanel = cleanup;
    await f.assistant.controls.flush();
    assert.equal(f.inbox.data.panels[menu.message_id].cleanup.status, 'deleted');

    f.put('refresh-race', 'input'); await f.scan();
    await f.say('/inbox'); const inboxPanel = f.sent.at(-1).message;
    f.inbox.resolve(f.inbox.list()[0], 'Answered in Codex.');
    let release, entered, editFinished = false, deletedDuringEdit = false;
    const waiting = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const call = f.assistant.telegram.call;
    f.assistant.telegram.call = async (method, params) => {
      if (method === 'deleteMessage' && params.message_id === inboxPanel.message_id) {
        deletedDuringEdit = !editFinished;
        throw Object.assign(new Error('Old'), { telegramReason: 'message-cannot-delete' });
      }
      if (method === 'editMessageText' && params.message_id === inboxPanel.message_id && !/panel is closed/.test(params.text)) {
        entered(); await held; editFinished = true;
      }
      return call(method, params);
    };
    const refresh = f.assistant.controls.refreshClosedInboxPanels(); await waiting;
    const closing = f.assistant.controls.dismissPanel(inboxPanel);
    await new Promise(resolve => setImmediate(resolve));
    release(); await Promise.all([closing, refresh]);
    assert.equal(deletedDuringEdit, false, 'closure must wait until the earlier edit finishes');
    assert.equal(f.inbox.data.panels[inboxPanel.message_id].expiresAt, 0);
    const lastEdit = f.calls.filter(c => c.method.startsWith('editMessage') && c.params.message_id === inboxPanel.message_id).at(-1);
    assert.equal(lastEdit.method, 'editMessageReplyMarkup');
    assert.deepEqual(lastEdit.params.reply_markup.inline_keyboard, []);
    const sent = f.sent.length;
    await f.assistant.controls.show('attention:0', inboxPanel);
    await f.assistant.controls.flush();
    assert.equal(f.sent.length, sent, 'a concurrent or delayed refresh cannot recreate a closed panel');
  } finally { f.cleanup(); }
});

test('expired settings refresh in place without applying the stale action', async () => {
  const f = fixture(); try {
    await f.say('/settings'); const panel = f.sent.at(-1).message;
    f.advance(25 * 60 * 60_000);
    await f.callback('ctl:mode:digest', panel);
    assert.equal(f.inbox.data.settings.routine, 'immediate');
    assert.equal(f.sent.length, 1, 'the known panel is refreshed instead of duplicated');
    assert.ok(f.inbox.data.panels[panel.message_id].expiresAt > f.inbox.now());
    await f.callback('ctl:mode:digest', panel);
    assert.equal(f.inbox.data.settings.routine, 'digest');
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test('project selection is bound to its panel and cannot apply after navigating away', async () => {
  const f = fixture(); try {
    await f.say('/project'); const panel = f.sent.at(-1).message;
    const choice = f.sent.at(-1).keyboard.inline_keyboard.flat().find(b => b.text === 'Project B').callback_data;
    assert.equal(f.inbox.data.panels[panel.message_id]?.view, 'projects');
    await f.callback(choice, { ...panel, message_id: 999 });
    assert.ok(!f.store.data.selectedProjectId);
    await f.callback('ctl:home', panel);
    await f.callback(choice, panel);
    assert.ok(!f.store.data.selectedProjectId);
    assert.equal(f.sent.length, 1); assert.equal(f.native.length, 0);
  } finally { f.cleanup(); }
});

test('dismissed panels remain closed when old navigation is clicked', async () => {
  const f = fixture(); try {
    await f.say('/menu'); const panel = f.sent.at(-1).message;
    f.inbox.data.panels[panel.message_id].dismissedAt = f.inbox.now();
    f.inbox.data.panels[panel.message_id].expiresAt = 0;
    await f.callback('ctl:settings', panel);
    assert.equal(f.sent.length, 1);
    assert.ok(!f.calls.some(c => c.method === 'editMessageText' && c.params.message_id === panel.message_id));
  } finally { f.cleanup(); }
});

test('native menus edit in place without Codex turns, preserve preferences and reject foreign users', async () => {
  const f = fixture(); try {
    f.store.data.selectedProjectId = 'a';
    await f.say('/settings'); const panel = f.sent.at(-1).message;
    await f.callback('ctl:mode:digest', panel, 2);
    assert.equal(f.inbox.data.settings.routine, 'immediate');
    await f.callback('ctl:mode:digest', panel);
    await f.callback('ctl:quiet:on', panel);
    assert.equal(f.sent.length, 1); assert.ok(f.calls.some(c => c.method === 'editMessageText'));
    f.store.data.selectedProjectId = 'b';
    await f.callback('ctl:mute:on', panel); // Stale project A button refreshes, never mutes B.
    assert.deepEqual(f.inbox.data.settings.mutedProjects, []);
    await f.callback('ctl:mute:on', panel);
    assert.deepEqual(f.inbox.data.settings.mutedProjects, ['b']);
    await f.callback('ctl:mode:invalid', panel);
    const saved = new Inbox(new StateStore(f.store.file));
    assert.equal(saved.data.settings.routine, 'digest'); assert.equal(saved.data.settings.quiet, true);
    assert.equal(f.native.length, 0);
    for (const m of f.sent) for (const row of m.keyboard?.inline_keyboard || []) for (const b of row)
      assert.ok(Buffer.byteLength(b.callback_data) <= 64);
    f.advance(25 * 60 * 60_000);
    await f.callback('ctl:mode:immediate', panel);
    assert.equal(f.inbox.data.settings.routine, 'digest'); // Expired setting button refreshes only.
  } finally { f.cleanup(); }
});

test('Details retain original reply routes while menus can never become mutable conversation targets', async () => {
  const f = fixture(); try {
    f.put('original'); await f.scan();
    const item = Object.values(f.inbox.data.items)[0], original = f.sent[0].message;
    f.store.data.selectedProjectId = 'b';
    await f.callback('ctl:item:' + item.id, original);
    const details = f.sent.at(-1).message;
    assert.ok(!f.sent.at(-1).keyboard.force_reply);
    assert.equal(f.inbox.data.nextReplyMessageId, String(details.message_id));
    await f.callback('ctl:home', details);
    assert.equal(f.inbox.data.nextReplyMessageId, undefined);
    assert.ok(!f.calls.some(c => c.method === 'editMessageText' && [original.message_id, details.message_id].includes(c.params.message_id)));
    const menu = f.sent.at(-1).message;
    await f.say('Do it', menu.message_id); await f.assistant.serial;
    assert.equal(f.submissions.length, 0); assert.equal(f.native.length, 0);
    await f.say('Change the original', details.message_id); await f.assistant.serial;
    assert.equal(f.submissions[0].id, 'original');
    assert.match(f.submissions[0].text, /Change the original/);
    assert.ok([original, details].every(m => f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && c.params.message_id === m.message_id)),
      'a confirmed reply clears both the original and the Details copy');
    await f.say('Unknown old menu', 9999); await f.assistant.serial;
    assert.equal(f.submissions.length, 1); assert.equal(f.native.length, 0);
  } finally { f.cleanup(); }
});

test('an uncertain Details reply retains every notification copy and cannot fall through to General', async () => {
  const f = fixture(); try {
    f.put('uncertain-details'); await f.scan();
    const item = f.inbox.list('updates')[0], original = f.sent[0].message;
    await f.callback('ctl:item:' + item.id, original); const details = f.sent.at(-1).message;
    f.store.data.selectedProjectId = 'b';
    f.tools.send = async (id, text) => { f.submissions.push({ id, text }); throw new Error('Delivery is unknown'); };
    await f.say('Continue the original task', details.message_id); await f.assistant.serial;
    await f.assistant.controls.flushCleanup();
    assert.equal(f.submissions.length, 1); assert.equal(f.submissions[0].id, 'uncertain-details');
    assert.equal(item.replySentAt, undefined);
    assert.ok([original, details].every(m => !f.calls.some(c => c.method === 'deleteMessage' && c.params.message_id === m.message_id)));
    assert.equal(f.native.length, 0);
  } finally { f.cleanup(); }
});

test('Open and reply selects one plain message, and Home restores Auto without an explicit Telegram reply', async () => {
  const f = fixture(); try {
    f.put('project-a'); await f.scan();
    const item = f.inbox.list('updates')[0], card = f.sent[0].message;
    const fresh = [];
    f.assistant.routeFreshMessage = async text => { fresh.push(text); return 'awaiting-route'; };
    await f.callback('ctl:item:' + item.id, card);
    assert.equal(new StateStore(f.store.file).data.inbox.nextReplyMessageId, String(f.sent.at(-1).message.message_id));
    const telegramCall = f.assistant.telegram.call.bind(f.assistant.telegram);
    f.assistant.telegram.call = async (method, args) => {
      if (method === 'answerCallbackQuery') throw new Error('Callback expired');
      return telegramCall(method, args);
    };
    await f.callback('ctl:home', f.sent.at(-1).message);
    f.assistant.telegram.call = telegramCall;
    await f.say('A general question'); await f.assistant.serial;
    assert.deepEqual(fresh, ['A general question']);
    assert.deepEqual(f.submissions, []);
    await f.callback('ctl:item:' + item.id, card);
    const selected = f.inbox.data.nextReplyMessageId;
    await f.say('Explicit reply to an unknown target', 9999);
    assert.equal(f.inbox.data.nextReplyMessageId, selected);
    await assert.rejects(f.say('/release missing'), /interrupted/);
    assert.equal(f.inbox.data.nextReplyMessageId, selected);
    await f.assistant.controls.help('Unrelated notice');
    await f.callback('ctl:hide', f.sent.at(-1).message);
    await f.say('Follow up in Project A'); await f.assistant.serial;
    assert.equal(f.submissions[0].id, 'project-a');
    await f.say('Another general question'); await f.assistant.serial;
    assert.deepEqual(fresh, ['A general question', 'Another general question']);
    assert.ok(!f.store.data.selectedProjectId);
  } finally { f.cleanup(); }
});

test('partial choices keep the selected Details route and Home control', async () => {
  const f = fixture(); try {
    f.put('partial-details', 'input').turns[0].items[0].text = 'Which color?\n- Blue\n- Green\n\nWhich size?\n- Small\n- Large';
    await f.scan(); const item = f.inbox.list()[0];
    await f.assistant.controls.item(item.id); const details = f.sent.at(-1);
    assert.ok(!details.keyboard.force_reply);
    await f.callback(answerButtons(details)[0].callback_data, details.message); await f.assistant.serial;
    const edit = f.calls.filter(c => /^editMessage/.test(c.method) && c.params.message_id === details.message.message_id).at(-1);
    assert.ok(!edit.params.reply_markup.force_reply);
    assert.equal(f.inbox.data.nextReplyMessageId, String(details.message.message_id));
    const labels = edit.params.reply_markup.inline_keyboard.flat().map(b => b.text);
    assert.ok(labels.includes('⌂ Home'));
    assert.ok(labels.some(label => label.startsWith('Q2')));
    assert.ok(!labels.some(label => label.startsWith('Q1')));
    assert.equal(f.submissions.length, 0);
  } finally { f.cleanup(); }
});

test('uncertain Details delivery cannot silently route a follow-up to Auto', async () => {
  const f = fixture(); try {
    f.put('target'); await f.scan();
    const item = f.inbox.list('updates')[0];
    const send = f.assistant.telegram.send;
    f.assistant.telegram.send = async () => { throw new Error('unknown delivery'); };
    await assert.rejects(f.assistant.controls.item(item.id), /unknown delivery/);
    f.assistant.telegram.send = send;
    f.assistant.routeFreshMessage = () => assert.fail('Unexpected Auto dispatch');
    await f.say('Sensitive follow-up'); await f.assistant.serial;
    assert.match(f.sent.at(-1).text, /could not confirm which reply card opened/);
    await f.callback('ctl:home', f.sent[0].message);
    assert.equal(f.inbox.data.nextReplyMessageId, undefined);
  } finally { f.cleanup(); }
});

test('reply sent stays distinct from resolved and only fresh source evidence clears an input item', async () => {
  const f = fixture(); try {
    const h = f.put('question', 'input'); await f.scan();
    const item = f.inbox.list()[0], route = f.store.data.desktopReplies['1'];
    await f.assistant.controls.item(item.id);
    assert.ok(f.inbox.data.nextReplyMessageId);
    await f.say('Blue', 1); await f.assistant.serial;
    assert.equal(f.inbox.data.nextReplyMessageId, undefined);
    assert.ok(item.replySentAt); assert.equal(item.status, 'open');
    const poll = f.tools.poll; f.tools.poll = async () => { throw new Error('offline'); };
    await f.scan(); assert.equal(item.status, 'open'); assert.match(f.assistant.controls.freshness(), /not current/);
    f.tools.poll = poll;
    h.turns[0].items.push({ type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>' + JSON.stringify([
      { questionItemId: JSON.stringify(['request_user_input_async', 'call_question', 0]), question: 'Which color?', answer: 'Blue' }
    ]) + '</send_user_message_question_reply>' }] });
    await f.scan(); assert.equal(item.status, 'resolved');
    await assert.rejects(f.monitor.reply(route, 'Red instead', 802), /no longer pending/);
    assert.equal(f.submissions.length, 1);
  } finally { f.cleanup(); }
});

test('a completed question that now has a final result rejects stale replies even before the next scan', async () => {
  const f = fixture(); try {
    const h = f.put('done', 'input'); await f.scan();
    h.turns[0].status = 'completed'; h.thread.status.type = 'idle';
    h.turns[0].items.push({ type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'All work finished.' });
    await assert.rejects(f.monitor.reply(f.store.data.desktopReplies['1'], 'Blue', 803), /no longer pending/);
    await f.scan(); assert.equal(f.inbox.list().length, 0); assert.equal(f.inbox.list('updates').length, 1);
  } finally { f.cleanup(); }
});

test('desktop answers without choice text resolve flattened choice questions and reject stale replies before scanning', async () => {
  const f = fixture(); try {
    const h = f.put('choices', 'input');
    h.turns[0].items[0].text = 'Which color?\n- Blue\n- Green';
    await f.scan(); const item = f.inbox.list()[0], route = f.store.data.desktopReplies['1'];
    h.turns[0].items.push({ type: 'userMessage', content: [{ type: 'text', text: '<send_user_message_question_reply>' + JSON.stringify([
      { questionItemId: JSON.stringify(['request_user_input_async', 'call_choices', 0]), question: 'Which color?', answer: 'Blue' }
    ]) + '</send_user_message_question_reply>' }] });
    await assert.rejects(f.monitor.reply(route, 'Blue again', 804), /no longer pending/);
    assert.equal(f.submissions.length, 0);
    await f.scan(); assert.equal(item.status, 'resolved');
  } finally { f.cleanup(); }
});

test('existing and uncertain notifications populate the inbox without replaying across restart', async () => {
  const f = fixture(); try {
    f.put('known', 'input');
    f.store.data.notices['desktop:local:known:turn-known:question:call_known'] = 'unknown';
    await f.scan(); assert.equal(f.sent.length, 0); assert.equal(f.inbox.list()[0].delivery, 'unknown');
    f.store.save(); const restored = new StateStore(f.store.file);
    const monitor = new DesktopMonitor({ tools: f.tools, store: restored, loadProjects: () => [], send: async () => { throw new Error('must not send'); } });
    restored.data.desktopWatch.threads.known.checkedAt = 0;
    await monitor.scan(); assert.equal(monitor.inbox.list().length, 1);
    assert.equal(monitor.inbox.list()[0].delivery, 'unknown');
  } finally { f.cleanup(); }
});

test('native collected answers stay visible until submission and retain stale-reply guards after restart', async () => {
  const f = fixture(); try {
    f.store.data.jobs.j = { id: 'j', threadId: 'worker', project: 'A', status: 'running' }; f.assistant.active.set('worker', 'j');
    await f.assistant.onRequest({ id: 88, method: 'item/tool/requestUserInput', params: { threadId: 'worker', questions: [
      { id: 'a', question: 'Which color?' }, { id: 'b', question: 'Which size?' }
    ] } });
    const items = f.inbox.list(); assert.equal(items.length, 2);
    const first = items.find(i => i.questionId === 'a'); await f.assistant.controls.item(first.id);
    await f.say('Blue', f.sent.at(-1).message.message_id);
    assert.equal(f.inbox.list().length, 2); assert.match(f.sent.at(-1).text, /1 more question/);
    assert.equal(f.native.length, 0);
    const pending = items.find(i => i.questionId === 'b'); await f.assistant.controls.item(pending.id);
    const replyId = f.sent.at(-1).message.message_id;
    const restarted = new Inbox(new StateStore(f.store.file)); restarted.recoverBridge();
    assert.equal(restarted.list().length, 0);
    assert.ok(restarted.store.data.inputReplies[replyId]);
    await f.say('Large', replyId);
    assert.equal(f.native.length, 1); assert.deepEqual(f.native[0].value.answers, { a: { answers: ['Blue'] }, b: { answers: ['Large'] } });
    assert.equal(f.inbox.list().length, 0);
  } finally { f.cleanup(); }
});

test('an uncertain native answer is retained through restart instead of deleted as answered', async () => {
  const f = fixture(); try {
    f.store.data.jobs.j = { id: 'j', threadId: 'worker', project: 'A', status: 'running' }; f.assistant.active.set('worker', 'j');
    await f.assistant.onRequest({ id: 88, method: 'item/tool/requestUserInput', params: { threadId: 'worker', questions: [
      { id: 'a', question: 'Choose a color?', options: [{ label: 'Blue' }, { label: 'Green' }] }
    ] } });
    const item = f.inbox.list()[0], message = f.sent[0];
    f.assistant.rpc.respond = () => { throw new Error('Pipe disconnected'); };
    await f.callback(answerButtons(message)[0].callback_data, message.message);
    assert.equal(item.status, 'open'); assert.equal(item.nativeAnswerState, 'unknown');
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
    f.inbox.recoverBridge(); await f.assistant.controls.flush();
    assert.equal(f.calls.filter(c => c.method === 'deleteMessage').length, 0);
    assert.ok(f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.message_id === message.message.message_id &&
      c.params.reply_markup.inline_keyboard.length === 0));
  } finally { f.cleanup(); }
});

test('confirmed replies dismiss only their exact bridge result for workers, steering and coordinators', async () => {
  for (const mode of ['worker', 'steer', 'coordinator', 'uncertain']) {
    const f = fixture(); try {
      f.store.data.jobs.j = { id: 'j', threadId: 'worker', project: 'A', projectId: mode === 'coordinator' ? undefined : 'a',
        status: mode === 'steer' ? 'running' : 'completed', turnId: 'old-turn' };
      const first = f.inbox.observe('reply-result-a', { source: 'bridge', kind: 'completion', jobId: 'j', text: 'First result' });
      const other = f.inbox.observe('reply-result-b', { source: 'bridge', kind: 'completion', jobId: 'j', text: 'Other result' });
      await f.assistant.controls.notify(first); const message = f.sent.at(-1).message;
      await f.assistant.controls.notify(other);
      f.assistant.dispatch = async () => { if (mode === 'uncertain') throw new Error('Unknown result'); };
      f.assistant.coordinate = async () => {};
      f.store.data.selectedProjectId = 'b';
      await f.say('Test follow-up', message.message_id); await f.assistant.serial;
      assert.equal(Boolean(first.replySentAt), mode !== 'uncertain');
      assert.equal(f.calls.some(c => c.method === 'editMessageReplyMarkup' && c.params.reply_markup.inline_keyboard.length === 0 && c.params.message_id === message.message_id), mode !== 'uncertain');
      assert.ok(f.inbox.list('updates').includes(other));
      assert.equal(f.store.data.selectedProjectId, 'b');
    } finally { f.cleanup(); }
  }
});

test('native approval buttons from Details authorize exactly once and reviewing failures never releases jobs', async () => {
  const f = fixture(); try {
    f.store.data.jobs.j = { id: 'j', threadId: 'worker', project: 'A', status: 'running' }; f.assistant.active.set('worker', 'j');
    await f.assistant.onRequest({ id: 89, method: 'item/commandExecution/requestApproval', params: { threadId: 'worker', command: 'echo hello' } });
    const item = f.inbox.list()[0]; await f.assistant.controls.item(item.id);
    const data = f.sent.at(-1).keyboard.inline_keyboard[0][0].callback_data;
    await f.callback(data); await f.callback(data);
    assert.equal(f.native.length, 1); assert.equal(f.native[0].value.decision, 'accept'); assert.equal(item.status, 'resolved');
    f.store.data.jobs.j.status = 'uncertain'; f.assistant.controls.syncJobs();
    const failure = f.inbox.list()[0]; await f.callback('ctl:review:' + failure.id);
    assert.equal(f.store.data.jobs.j.status, 'uncertain'); assert.equal(failure.status, 'reviewed');
  } finally { f.cleanup(); }
});

test('quiet hours cross midnight locally and preserve urgent visibility and direct responses', () => {
  const f = fixture(); try {
    const settings = f.inbox.data.settings; settings.quiet = true; settings.timeZone = 'UTC';
    const routine = { source: 'desktop', kind: 'completion', route: { projectId: 'a' } };
    f.time(Date.parse('2026-10-28T23:30:00Z'));
    assert.equal(f.inbox.policy(routine), 'digest');
    assert.equal(f.inbox.policy({ kind: 'input', source: 'desktop' }), 'immediate');
    settings.urgentDuringQuiet = false;
    assert.equal(f.inbox.policy({ kind: 'approval', source: 'desktop' }), 'silent');
    assert.equal(f.inbox.policy({ kind: 'completion', source: 'bridge' }), 'immediate');
    f.time(Date.parse('2026-10-29T07:30:00Z')); assert.equal(f.inbox.quietNow(), true);
    f.time(Date.parse('2026-10-29T08:00:00Z')); assert.equal(f.inbox.quietNow(), false);
    settings.mutedProjects = ['a']; assert.equal(f.inbox.policy(routine), 'inbox');
    assert.equal(f.inbox.policy({ ...routine, kind: 'failure' }), 'immediate');
  } finally { f.cleanup(); }
});

test('hourly digest survives persisted state, sends once, and sends no reviewed or newly muted updates', async () => {
  const f = fixture(); try {
    f.inbox.data.settings.routine = 'digest';
    f.put('first'); f.put('second'); await f.scan(); assert.equal(f.sent.length, 0);
    assert.equal(new Inbox(new StateStore(f.store.file)).list('updates').length, 2);
    const items = f.inbox.list('updates'); f.inbox.review(items[0].id);
    f.advance(60 * 60_000 + 1); await f.scan(); await f.assistant.controls.flush();
    assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Your updates · 1/); assert.equal(f.sent[0].options.silent, false);
    await f.assistant.controls.flush(); assert.equal(f.sent.length, 1);
    f.put('third'); await f.scan();
    f.inbox.data.settings.mutedProjects = ['a'];
    f.advance(60 * 60_000 + 1); await f.assistant.controls.flush(); assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test('unknown digest delivery is never retried automatically', async () => {
  const f = fixture(); try {
    f.inbox.data.settings.routine = 'digest'; f.put('unknown'); await f.scan();
    f.advance(60 * 60_000 + 1); await f.scan(); let attempts = 0;
    f.assistant.telegram.send = async () => { attempts++; throw new Error('timeout'); };
    await f.assistant.controls.flush(); await f.assistant.controls.flush();
    assert.equal(attempts, 1); assert.equal(f.inbox.list('updates')[0].delivery, 'unknown');
  } finally { f.cleanup(); }
});

test('snooze is not an answer and reminders require a fresh observation of that specific request', async () => {
  const f = fixture(); try {
    f.put('snooze', 'input'); await f.scan(); const item = f.inbox.list()[0];
    f.inbox.snooze(item.id); assert.equal(f.inbox.list().length, 0); assert.equal(f.inbox.list('snoozed').length, 1);
    assert.equal(item.status, 'open'); f.advance(60 * 60_000 + 1);
    f.monitor.health = { status: 'connected', lastScanAt: new Date(f.inbox.now()).toISOString() };
    await f.assistant.controls.flush(); assert.equal(f.sent.length, 1); // Global health cannot prove this chat still needs input.
    item.observedAt = f.inbox.now(); await f.assistant.controls.flush(); await f.assistant.controls.flush();
    assert.equal(f.sent.length, 2); assert.match(f.sent[1].text, /Reminder/);
    assert.equal(f.store.data.desktopReplies['2'].threadId, 'snooze');
    f.inbox.snooze(item.id); f.inbox.resolve(item, 'Answered'); f.advance(60 * 60_000 + 1);
    item.observedAt = f.inbox.now(); f.monitor.health.lastScanAt = new Date(f.inbox.now()).toISOString();
    await f.assistant.controls.flush(); assert.equal(f.sent.length, 2);
  } finally { f.cleanup(); }
});

test('Telegram honors quiet delivery and menus introduce themselves only once', async () => {
  const tg = new Telegram('test'); const payloads = [];
  tg.call = async (method, payload) => { payloads.push(payload); return { message_id: payloads.length }; };
  await tg.send(1, 'Normal'); await tg.send(1, 'Quiet', undefined, undefined, { silent: true });
  assert.equal(payloads[0].disable_notification, false); assert.equal(payloads[1].disable_notification, true); tg.close();
  const f = fixture(); try {
    await f.assistant.controls.introduce(); await f.assistant.controls.introduce();
    assert.equal(f.sent.length, 1); assert.equal(f.inbox.data.announcement, 'delivered');
    const fresh = new Inbox(new StateStore(f.store.file)); assert.equal(fresh.data.announcement, 'delivered');
  } finally { f.cleanup(); }
});

test('oversized desktop histories retain the preceding turn when possible without replaying writes', async () => {
  const tools = new DesktopTools({}), calls = [];
  tools.call = async (method, args) => {
    calls.push({ method, args });
    if (args.turnLimit === 10) throw new Error('Thread history exceeds the read size limit. Try fewer turns.');
    return { thread: { id: args.threadId }, turns: [{ id: 'latest' }, { id: 'preceding' }] };
  };
  const result = await tools.read('large'); assert.equal(result.turns[0].id, 'latest');
  assert.equal(result.turns[1].id, 'preceding');
  assert.deepEqual(calls.map(c => c.args.turnLimit), [10, 2]);
  calls.length = 0;
  tools.call = async (method, args) => {
    calls.push({ method, args });
    if (args.turnLimit > 1) throw new Error('Thread history exceeds the read size limit.');
    return { turns: [{ id: 'latest' }] };
  };
  assert.equal((await tools.read('larger')).turns[0].id, 'latest');
  assert.deepEqual(calls.map(c => c.args.turnLimit), [10, 2, 1]);
  calls.length = 0;
  tools.call = async (method, args) => { calls.push({ method, args }); throw new Error('Connection lost'); };
  await assert.rejects(tools.read('large'), /Connection lost/); assert.equal(calls.length, 1);
  calls.length = 0;
  await assert.rejects(tools.send('large', 'Do not replay'), /Connection lost/); assert.equal(calls.length, 1);
  calls.length = 0;
  tools.call = async (method, args) => { calls.push({ method, args }); throw new Error('Thread history exceeds the read size limit.'); };
  await assert.rejects(tools.read('oversized-single-turn'), /read size limit/); assert.equal(calls.length, 3);
});

test('native waiting priority never resolves an unanswered async question', async () => {
  const f = fixture(); try {
    const h = f.put('both', 'input'); await f.scan(); const question = f.inbox.list()[0];
    h.thread.status.activeFlags = ['waitingOnApproval']; await f.scan();
    assert.equal(f.inbox.list().length, 2); assert.equal(question.status, 'open');
    assert.equal(f.sent.length, 2); // Question first, then the native approval only.
    h.thread.status.activeFlags = []; await f.scan();
    assert.equal(f.inbox.list().length, 1); assert.equal(question.status, 'open');
    await f.monitor.reply(question.route, 'Blue', 900); assert.equal(f.submissions[0].id, 'both');
  } finally { f.cleanup(); }
});

test('desktop results explicitly requested in Telegram bypass mute and consume only their matching turn', async () => {
  const f = fixture(); try {
    f.put('original'); await f.scan();
    f.inbox.data.settings.routine = 'inbox'; f.inbox.data.settings.mutedProjects = ['a'];
    const source = f.inbox.list('updates')[0];
    await f.monitor.reply(source.route, 'Change it', 901);
    const h = f.put('original'); h.turns[0].id = 'requested-turn';
    h.thread.updatedAt++; // A completed follow-up advances native catalog metadata.
    h.turns[0].items.unshift({ type: 'userMessage', content: [{ type: 'text', text: f.submissions[0].text }] }); await f.scan();
    assert.equal(f.sent.length, 2); assert.equal(f.store.data.desktopSubmissions['901'].resultTurnId, 'requested-turn');
    h.turns.unshift({ ...h.turns[0], id: 'unrequested-turn', items: h.turns[0].items.filter(i => i.type !== 'userMessage') }); h.thread.updatedAt++; await f.scan();
    assert.equal(f.sent.length, 2);
    const routine = f.inbox.list('updates').find(i => i.route.turnId === 'unrequested-turn');
    assert.equal(routine.delivery, 'inbox');
  } finally { f.cleanup(); }
});

test('queued desktop follow-ups do not mistake the already-running turn for their result', async () => {
  const f = fixture(); try {
    const h = f.put('queued', 'input'); await f.scan();
    f.inbox.data.settings.routine = 'inbox';
    await f.monitor.reply(f.inbox.list()[0].route, 'Also fix the footer', 902);
    h.turns[0].status = 'completed'; h.turns[0].items = [{ type: 'agentMessage', phase: 'final_answer', text: 'Previous work finished.' }];
    await f.scan(); assert.equal(f.store.data.desktopSubmissions['902'].resultTurnId, undefined);
    h.turns.unshift({ id: 'actual-requested-turn', status: 'completed', startedAt: Date.now() / 1000 + 1, items: [
      { type: 'userMessage', content: [{ type: 'text', text: f.submissions[0].text }] },
      { type: 'agentMessage', phase: 'final_answer', text: 'Footer fixed.' }
    ] });
    await f.scan(); assert.equal(f.store.data.desktopSubmissions['902'].resultTurnId, 'actual-requested-turn');
    assert.match(f.sent.at(-1).text, /Footer fixed/);
  } finally { f.cleanup(); }
});

test('questions observed in old running turns remain pending after completion and repeated scans', async () => {
  for (const explicit of [true, false]) {
    const f = fixture(); try {
      const h = f.put('old', 'input'); h.turns[0].startedAt = 1;
      if (!explicit) h.turns[0].items[0].id = 'ordinary-final';
      await f.scan();
      h.turns[0].status = 'completed'; h.thread.status.type = 'idle';
      await f.scan(); await f.scan(); await f.scan();
      assert.equal(f.inbox.list().length, 1); assert.equal(f.inbox.list()[0].status, 'open');
      assert.equal(f.sent.length, 1); // Kept visible, never rebroadcast.
      await f.monitor.reply(f.inbox.list()[0].route, 'Blue', 903);
      assert.equal(f.submissions[0].id, 'old');
    } finally { f.cleanup(); }
  }
});

test('a reply to a failure without a conversation cannot submit work to General', async () => {
  const f = fixture(); try {
    f.store.data.jobs.reservation = { id: 'reservation', project: 'A', status: 'failed', roots: [projectA] };
    f.assistant.controls.syncJobs(); const item = f.inbox.list()[0];
    await f.assistant.controls.item(item.id);
    assert.equal(f.sent.at(-1).keyboard.inline_keyboard[0][0].text, 'Details');
    await f.say('Try again', f.sent.at(-1).message.message_id); await f.assistant.serial;
    assert.equal(f.native.length, 0); assert.match(f.sent.at(-1).text, /not sent to General/);
  } finally { f.cleanup(); }
});

test('staggered updates share a single digest window instead of producing delayed individual alerts', async () => {
  const f = fixture(); try {
    f.inbox.data.settings.routine = 'digest'; f.put('early'); await f.scan();
    f.advance(30 * 60_000); f.put('later'); await f.scan();
    f.advance(30 * 60_000 + 1); await f.scan(); await f.assistant.controls.flush();
    assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /Your updates · 2/);
    f.advance(30 * 60_000); await f.assistant.controls.flush(); assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});
