import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { Assistant } from '../src/assistant.mjs';

const projectRoot = process.platform === 'win32' ? 'D:\\Projects' : '/tmp/Projects';
const projectA = join(projectRoot, 'a');
const projectB = process.platform === 'win32' ? 'E:\\other' : '/tmp/other';
const freshRoot = join(projectRoot, 'fresh');
const filesystemRoot = parse(projectRoot).root;

// Fake only the external Codex/Telegram boundary; state and dispatch logic are real.
class NativeFixture extends EventEmitter {
  constructor() { super(); this.calls = []; this.closed = false; }
  async call(method, params) {
    this.calls.push({ method, params });
    if (this.failTurn && method === 'turn/start') throw new Error('connection closed; outcome unknown');
    const policy = { sandbox: { type: params.sandbox === 'danger-full-access' ? 'dangerFullAccess' : 'readOnly' }, approvalPolicy: params.approvalPolicy };
    if (method === 'thread/start') return { thread: { id: 'bridge-thread-' + this.calls.length }, ...policy };
    if (method === 'thread/fork') return { thread: { id: 'bridge-fork-' + this.calls.length }, ...policy };
    if (method === 'thread/resume') return { thread: { id: params.threadId }, ...policy };
    if (method === 'turn/start') return { turn: { id: 'turn-' + this.calls.length } };
    if (method === 'thread/read') return { thread: { id: params.threadId, cwd: projectA } };
    return {};
  }
  respond(id, result) { this.calls.push({ responseId: id, result }); }
  reject(id) { this.calls.push({ rejectedId: id }); }
}
function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tg-assistant-'));
  const store = new StateStore(join(dir, 'state.json'));
  store.data.owner = { userId: 1, chatId: 1 };
  const rpc = new NativeFixture();
  const sent = [], telegramCalls = [];
  const telegram = { token: 'TOKEN', async send(chat, text, keyboard) {
    sent.push({ chat, text, keyboard }); return [{ message_id: sent.length }];
  }, async call(method, params) { telegramCalls.push({ method, params }); return true; } };
  const projects = [
    { id: 'a', name: 'A', roots: [projectA] },
    { id: 'parent', name: 'All projects', roots: [projectRoot] },
    { id: 'b', name: 'B', roots: [projectB] }
  ];
  const assistant = new Assistant({ rpc, telegram, store, projects, workspace: dir, ...options });
  assistant.classifyMessage = async () => ({ projectId: null });
  return { dir, store, rpc, sent, telegramCalls, assistant, cleanup() { assistant.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('owner photos keep captions, largest size, selected project and one submission per update', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    f.store.data.selectedProjectId = 'a';
    const downloads = [];
    f.assistant.telegram.downloadImage = async image => { downloads.push(image.file_id); return join(f.dir, 'photo.jpg'); };
    const update = { update_id: 701, message: { from: { id: 1 }, chat: { id: 1, type: 'private' },
      caption: 'Read this receipt', photo: [{ file_id: 'small', width: 50, height: 50 }, { file_id: 'large', width: 900, height: 900 }] } };
    await f.assistant.handleUpdate(update); await f.assistant.serial;
    await f.assistant.handleUpdate(update); await f.assistant.serial;
    assert.deepEqual(downloads, ['large']);
    const starts = f.rpc.calls.filter(c => c.method === 'turn/start');
    assert.equal(starts.length, 1);
    assert.match(starts[0].params.input[0].text, /^Read this receipt/);
    assert.deepEqual(starts[0].params.input[1], { type: 'localImage', path: join(f.dir, 'photo.jpg') });
    assert.equal(Object.values(f.store.data.jobs)[0].scopeProjectId, 'a');
  } finally { f.cleanup(); }
});

test('captionless image files steer the original worker even with another project selected', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect');
    f.store.data.replies['81'] = job.id; f.store.data.selectedProjectId = 'b';
    f.assistant.telegram.downloadImage = async () => join(f.dir, 'image.png');
    await f.assistant.handleUpdate({ update_id: 702, message: { from: { id: 1 }, chat: { id: 1, type: 'private' },
      reply_to_message: { message_id: 81 }, document: { file_id: 'image', mime_type: 'image/png', file_name: 'screenshot.png' } } });
    await f.assistant.serial;
    const steer = f.rpc.calls.find(c => c.method === 'turn/steer');
    assert.equal(steer?.params.threadId, job.threadId);
    assert.match(steer.params.input[0].text, /image/i);
    assert.equal(steer.params.input[1].type, 'localImage');
  } finally { f.cleanup(); }
});

test('images never bypass owner authentication or turn captions on unsupported media into tasks', async () => {
  const f = fixture();
  try {
    let downloads = 0; f.assistant.telegram.downloadImage = async () => { downloads++; };
    let updateId = 710;
    for (const message of [
      { from: { id: 2 }, photo: [{ file_id: 'private' }] },
      { from: { id: 1 }, forward_origin: {}, photo: [{ file_id: 'forward' }] },
      { from: { id: 1 }, document: { file_id: 'pdf', mime_type: 'application/pdf' }, caption: 'Run this task' }
    ]) await f.assistant.handleUpdate({ update_id: updateId++, message: { chat: { id: 1, type: 'private' }, ...message } });
    await f.assistant.serial;
    assert.equal(downloads, 0); assert.equal(f.rpc.calls.length, 0);
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test('image captions do not run slash commands and desktop image replies keep their source route', async () => {
  const f = fixture();
  try {
    f.assistant.telegram.downloadImage = async () => join(f.dir, 'image.webp');
    await f.assistant.handleUpdate({ update_id: 720, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, caption: '/status', photo: [{ file_id: 'x' }] } });
    await f.assistant.serial;
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
    f.store.data.desktopReplies = { '82': { threadId: 'desktop-source', hostId: 'local' } };
    let received;
    f.assistant.desktop = { async reply(...args) { received = args; return {}; } };
    await f.assistant.handleUpdate({ update_id: 721, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, reply_to_message: { message_id: 82 }, photo: [{ file_id: 'y' }] } });
    await f.assistant.serial;
    assert.equal(received?.[0].threadId, 'desktop-source');
    assert.deepEqual(received[3], [join(f.dir, 'image.webp')]);
  } finally { f.cleanup(); }
});

test('failed image downloads submit nothing and structured questions keep waiting for a text answer', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    let downloads = 0;
    f.assistant.telegram.downloadImage = async () => { downloads++; throw new Error('Image download failed'); };
    const imageMessage = { from: { id: 1 }, chat: { id: 1, type: 'private' }, photo: [{ file_id: 'image' }] };
    await f.assistant.handleUpdate({ update_id: 730, message: imageMessage }); await f.assistant.serial;
    assert.equal(f.rpc.calls.length, 0); assert.match(f.sent.at(-1).text, /download failed/i);
    const job = await f.assistant.coordinate('Ask a question');
    await f.assistant.onRequest({ id: 900, method: 'item/tool/requestUserInput', params: {
      threadId: job.threadId, questions: [{ id: 'choice', question: 'Which one?', options: [] }]
    } });
    const questionId = [...f.assistant.questionReplies.keys()][0];
    await f.assistant.handleUpdate({ update_id: 731, message: { ...imageMessage, reply_to_message: { message_id: Number(questionId) } } });
    assert.equal(downloads, 1);
    assert.equal(f.assistant.pending.size, 1);
    assert.equal(f.rpc.calls.some(c => c.responseId === 900), false);
    assert.match(f.sent.at(-1).text, /text answer/);
  } finally { f.cleanup(); }
});

test('coordinator delegation forwards current turn images including an image added by steering', async () => {
  const f = fixture();
  try {
    const parent = await f.assistant.coordinate('Use this logo in A', null, ['C:\\first.png']);
    await f.assistant.onRequest({ id: 910, method: 'item/tool/call', params: {
      threadId: parent.threadId, tool: 'dispatch_project', arguments: { project: 'A', prompt: 'Use the attached logo' }
    } });
    let turns = f.rpc.calls.filter(c => c.method === 'turn/start');
    assert.deepEqual(turns.at(-1).params.input[1], { type: 'localImage', path: 'C:\\first.png' });
    await f.assistant.coordinate('Compare these for B', null, ['C:\\second.png']);
    await f.assistant.onRequest({ id: 911, method: 'item/tool/call', params: {
      threadId: parent.threadId, tool: 'dispatch_project', arguments: { project: 'B', prompt: 'Compare both images' }
    } });
    turns = f.rpc.calls.filter(c => c.method === 'turn/start');
    assert.deepEqual(turns.at(-1).params.input.slice(1), [
      { type: 'localImage', path: 'C:\\first.png' }, { type: 'localImage', path: 'C:\\second.png' }
    ]);
  } finally { f.cleanup(); }
});

test('dispatch locks parent/child roots and only creates bridge-owned sessions', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect only.');
    assert.equal(f.store.data.jobs[job.id].status, 'running');
    assert.match(job.threadId, /^bridge-thread-/);
    await assert.rejects(f.assistant.dispatch('All projects', 'Another task'), /overlap|busy/i);
    assert.ok(await f.assistant.dispatch('B', 'Independent inspection'));
    assert.equal(f.rpc.calls.filter(c => c.method === 'thread/resume').length, 0);
  } finally { f.cleanup(); }
});

test('failed turn submission is uncertain and cannot silently be replayed', async () => {
  const f = fixture();
  try {
    f.rpc.failTurn = true;
    await assert.rejects(f.assistant.dispatch('A', 'Change a file'), /unknown/);
    const job = Object.values(f.store.data.jobs)[0];
    assert.equal(job.status, 'uncertain');
    await assert.rejects(f.assistant.dispatch('A', 'Change it again'), /overlap|busy/i);
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
  } finally { f.cleanup(); }
});

test('a proven completion survives a later turn-start timeout', async () => {
  const f = fixture();
  try {
    const original = f.rpc.call.bind(f.rpc);
    f.rpc.call = async (method, params) => {
      if (method === 'turn/start') {
        await f.assistant.onNotification({ method: 'turn/completed', params: {
          threadId: params.threadId, turn: { id: 'fast-turn', status: 'completed' }
        } });
        throw new Error('late timeout');
      }
      return original(method, params);
    };
    await f.assistant.dispatch('A', 'Inspect');
    const job = Object.values(f.store.data.jobs)[0];
    assert.equal(job.status, 'completed');
    assert.equal(f.assistant.active.size, 0);
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test('completion sends one labeled result and preserves reply-to-job routing', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect');
    await f.assistant.onNotification({ method: 'item/completed', params: { threadId: job.threadId, turnId: job.turnId,
      item: { type: 'agentMessage', phase: 'final_answer', text: 'Inspection finished.' } } });
    const event = { method: 'turn/completed', params: { threadId: job.threadId, turn: { id: job.turnId, status: 'completed' } } };
    await f.assistant.onNotification(event);
    await f.assistant.onNotification(event);
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].text, /A.*Inspection finished/s);
    assert.equal(f.store.data.replies['1'], job.id);
    assert.equal(f.store.data.jobs[job.id].status, 'completed');
  } finally { f.cleanup(); }
});

test('unknown users and duplicate updates never reach Codex', async () => {
  const f = fixture();
  try {
    const msg = { from: { id: 2 }, chat: { id: 2, type: 'private' }, text: 'Deploy it' };
    await f.assistant.handleUpdate({ update_id: 4, message: msg });
    assert.equal(f.rpc.calls.length, 0);
    const own = { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/projects' };
    await f.assistant.handleUpdate({ update_id: 5, message: own });
    await f.assistant.handleUpdate({ update_id: 5, message: own });
    assert.equal(f.sent.length, 1);
  } finally { f.cleanup(); }
});

test('approval button is owner-bound, one-use and never grants session-wide access', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect');
    await f.assistant.onRequest({ id: 77, method: 'item/commandExecution/requestApproval', params: {
      threadId: job.threadId, turnId: job.turnId, command: 'Read project file', cwd: projectA
    } });
    const data = f.sent.at(-1).keyboard.inline_keyboard[0][0].callback_data;
    const base = { id: 'callback', data, message: { chat: { id: 1, type: 'private' } } };
    await f.assistant.handleUpdate({ update_id: 10, callback_query: { ...base, from: { id: 2 } } });
    assert.equal(f.rpc.calls.some(c => c.responseId === 77), false);
    await f.assistant.handleUpdate({ update_id: 11, callback_query: { ...base, from: { id: 1 } } });
    await f.assistant.handleUpdate({ update_id: 12, callback_query: { ...base, from: { id: 1 } } });
    assert.deepEqual(f.rpc.calls.filter(c => c.responseId === 77).map(c => c.result), [{ decision: 'accept' }]);
  } finally { f.cleanup(); }
});

test('model tools cannot submit approvals or dispatch from worker threads', async () => {
  const f = fixture();
  try {
    await f.assistant.onRequest({ id: 88, method: 'item/tool/call', params: {
      threadId: 'unowned-thread', tool: 'dispatch_project', arguments: { project: 'A', prompt: 'Do work' }
    } });
    assert.equal(f.rpc.calls.some(c => c.method === 'turn/start'), false);
    assert.equal(f.rpc.calls.find(c => c.responseId === 88).result.success, false);
  } finally { f.cleanup(); }
});

test('a completed interrupt event is not overwritten by its late RPC response', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect');
    const original = f.rpc.call.bind(f.rpc);
    f.rpc.call = async (method, params) => {
      if (method === 'turn/interrupt') await f.assistant.onNotification({ method: 'turn/completed', params: {
        threadId: job.threadId, turn: { id: job.turnId, status: 'interrupted' }
      } });
      return original(method, params);
    };
    await f.assistant.stop(job.id);
    assert.equal(f.store.data.jobs[job.id].status, 'interrupted');
  } finally { f.cleanup(); }
});

test('a stale item from an older turn cannot become the new job result', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect');
    await f.assistant.onNotification({ method: 'item/completed', params: { threadId: job.threadId, turnId: 'older-turn',
      item: { type: 'agentMessage', phase: 'final_answer', text: 'Old result' } } });
    await f.assistant.onNotification({ method: 'turn/completed', params: { threadId: job.threadId, turn: { id: job.turnId, status: 'completed' } } });
    assert.ok(!f.sent[0].text.includes('Old result'));
  } finally { f.cleanup(); }
});

test('file permission escalation without a fully reviewed diff is declined', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect');
    await f.assistant.onRequest({ id: 99, method: 'item/fileChange/requestApproval', params: {
      threadId: job.threadId, turnId: job.turnId, itemId: 'patch-1', grantRoot: filesystemRoot, reason: 'Allow patch'
    } });
    assert.deepEqual(f.rpc.calls.find(c => c.responseId === 99).result, { decision: 'decline' });
    assert.ok(f.sent.every(m => !m.keyboard));
  } finally { f.cleanup(); }
});

test('a failed error notification cannot reject the detached instruction queue', async () => {
  const f = fixture();
  try {
    f.assistant.coordinate = async () => { throw new Error('Codex unavailable'); };
    f.assistant.telegram.send = async () => { throw new Error('Telegram unavailable'); };
    await f.assistant.handleUpdate({ update_id: 30, message: {
      from: { id: 1 }, chat: { id: 1, type: 'private' }, text: 'Inspect project A'
    } });
    await assert.doesNotReject(f.assistant.serial);
  } finally { f.cleanup(); }
});

test('progress text is not forwarded as a failed turn final answer', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect');
    await f.assistant.onNotification({ method: 'item/completed', params: {
      threadId: job.threadId, turnId: job.turnId,
      item: { type: 'agentMessage', phase: 'commentary', text: 'I will check.' }
    } });
    await f.assistant.onNotification({ method: 'turn/completed', params: {
      threadId: job.threadId, turn: { id: job.turnId, status: 'failed', error: { message: 'failed' } }
    } });
    assert.match(f.sent[0].text, /reported an error/);
    assert.ok(!f.sent[0].text.includes('I will check.'));
  } finally { f.cleanup(); }
});

test('a delivered question chunk keeps routing when a later chunk fails', async () => {
  const f = fixture();
  try {
    const job = await f.assistant.dispatch('A', 'Inspect');
    f.assistant.telegram.send = async (chat, text, keyboard, delivered) => {
      delivered({ message_id: 101 });
      throw new Error('later chunk failed');
    };
    f.rpc.emit('request', { id: 100, method: 'item/tool/requestUserInput', params: {
      threadId: job.threadId, questions: [{ id: 'choice', question: 'Which option?' }]
    } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.store.data.replies['101'], job.id);
    assert.ok(f.assistant.questionReplies.has('101'));
    assert.equal(f.rpc.calls.some(c => c.rejectedId === 100), false);
    f.assistant.telegram.send = async () => [];
    await f.assistant.handleUpdate({ update_id: 55, message: {
      from: { id: 1 }, chat: { id: 1, type: 'private' }, text: 'First option', reply_to_message: { message_id: 101 }
    } });
    assert.deepEqual(f.rpc.calls.find(c => c.responseId === 100).result, { answers: { choice: { answers: ['First option'] } } });
  } finally { f.cleanup(); }
});

test('shutdown prevents a pending worker startup from submitting a turn', async () => {
  const f = fixture();
  try {
    const original = f.rpc.call.bind(f.rpc);
    let release, entered;
    const wait = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    f.rpc.call = async (method, params) => {
      if (method === 'thread/start') { entered(); await wait; }
      return original(method, params);
    };
    const pending = f.assistant.dispatch('A', 'Inspect');
    await started;
    f.assistant.beginShutdown();
    release();
    await assert.rejects(pending, /stopping/);
    assert.equal(f.rpc.calls.some(c => c.method === 'turn/start'), false);
    await assert.rejects(f.assistant.coordinate('New request'), /stopping/);
  } finally { f.cleanup(); }
});

test('owner instructions refresh context and send a timestamped data snapshot to the coordinator', async () => {
  const f = fixture();
  try {
    let refreshed = 0;
    f.assistant.context = { projects: [{ id: 'fresh', name: 'Latest project', roots: [freshRoot] }], async refresh() {
      refreshed++;
      return { status: 'fresh', observedAt: '2026-10-24T00:00:00Z', recent: [{ name: 'Latest saved task' }] };
    } };
    await f.assistant.coordinate('What changed?');
    assert.equal(refreshed, 1);
    assert.equal(f.assistant.projects[0].name, 'Latest project');
    const prompt = f.rpc.calls.find(c => c.method === 'turn/start').params.input[0].text;
    assert.match(prompt, /Latest saved task/);
    assert.match(prompt, /untrusted/i);
    assert.match(prompt, /2026-10-24/);
    assert.match(prompt, /Current Telegram connection capabilities:.*photos/);
    assert.match(prompt, /Audio, voice transcription.*unsupported/);
  } finally { f.cleanup(); }
});

test('status and coordinator replies use normal text while preserving result reply routing', async () => {
  const f = fixture();
  try {
    await f.assistant.coordinate('Hi');
    const job = Object.values(f.store.data.jobs)[0];
    await f.assistant.onNotification({ method: 'item/completed', params: { threadId: job.threadId, turnId: job.turnId,
      item: { type: 'agentMessage', phase: 'final_answer', text: 'Hello! What shall we work on?' } } });
    await f.assistant.onNotification({ method: 'turn/completed', params: { threadId: job.threadId, turn: { id: job.turnId, status: 'completed' } } });
    assert.equal(f.sent[0].text, 'Hello! What shall we work on?');
    assert.equal(f.store.data.replies['1'], job.id);
    await f.assistant.handleUpdate({ update_id: 80, message: { from: { id: 1 }, chat: { id: 1, type: 'private' }, text: '/status' } });
    assert.ok(!f.sent.at(-1).text.includes('threadId'));
    assert.ok(!f.sent.at(-1).text.startsWith('['));
  } finally { f.cleanup(); }
});

test('registered child projects do not authorize reading parent workspace chats', async () => {
  const f = fixture();
  try {
    f.assistant.projects = [f.assistant.projects[0]];
    f.rpc.call = async () => ({ thread: { cwd: projectRoot } });
    await assert.rejects(f.assistant.readChat('parent-workspace'), /outside registered/);
  } finally { f.cleanup(); }
});

test('busy saved coordinator forks its history once and submits only the current request', async () => {
  const f = fixture();
  try {
    f.store.data.coordinator = 'previous-owned-coordinator';
    const original = f.rpc.call.bind(f.rpc);
    f.rpc.call = async (method, params) => {
      if (method === 'thread/resume') {
        f.rpc.calls.push({ method, params });
        throw Object.assign(new Error('thread already has an active writer'), { code: -32600 });
      }
      return original(method, params);
    };
    await f.assistant.coordinate('Do you support audio recordings here?');
    assert.match(f.store.data.coordinator, /^bridge-fork-/);
    const fork = f.rpc.calls.find(c => c.method === 'thread/fork');
    assert.equal(fork.params.threadId, 'previous-owned-coordinator');
    assert.equal(fork.params.deferGoalContinuation, true);
    assert.equal(fork.params.sandbox, 'read-only');
    const starts = f.rpc.calls.filter(c => c.method === 'turn/start');
    assert.equal(starts.length, 1);
    assert.equal(starts[0].params.input[0].text.split('\n\n')[0], 'Do you support audio recordings here?');
    assert.deepEqual(f.store.data.coordinatorHistory, ['previous-owned-coordinator']);
    assert.equal(f.rpc.calls.some(c => c.method === 'thread/archive'), false);
  } finally { f.cleanup(); }
});

test('unknown resume outcomes do not fork or replay a request', async () => {
  const f = fixture();
  try {
    f.store.data.coordinator = 'saved';
    f.rpc.call = async (method, params) => {
      f.rpc.calls.push({ method, params });
      throw new Error('connection timeout; outcome unknown');
    };
    await assert.rejects(f.assistant.coordinate('Current task'), /timeout/);
    assert.equal(f.store.data.coordinator, 'saved');
    assert.ok(f.rpc.calls.every(c => c.method === 'thread/resume'));
  } finally { f.cleanup(); }
});

test('busy owned project sessions preserve history and rebind only that project worker', async () => {
  const f = fixture();
  try {
    f.store.data.workers.a = { threadId: 'old-worker', roots: f.assistant.projects[0].roots };
    const original = f.rpc.call.bind(f.rpc);
    f.rpc.call = async (method, params) => {
      if (method === 'thread/resume') throw Object.assign(new Error('thread already has an active writer'), { code: -32600 });
      return original(method, params);
    };
    const job = await f.assistant.dispatch('A', 'Only this new task');
    assert.match(job.threadId, /^bridge-fork-/);
    assert.equal(f.store.data.workers.a.threadId, job.threadId);
    assert.deepEqual(f.store.data.workers.a.previousThreadIds, ['old-worker']);
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(f.rpc.calls.find(c => c.method === 'thread/fork').params.sandbox, 'workspace-write');
  } finally { f.cleanup(); }
});

const message = (text, id, extra = {}) => ({ update_id: id, message: {
  from: { id: 1 }, chat: { id: 1, type: 'private' }, text, ...extra
} });
const choose = (data, id, from = 1, messageId = 1) => ({ update_id: id, callback_query: {
  id: 'callback-' + id, data, from: { id: from }, message: { message_id: messageId, chat: { id: 1, type: 'private' } }
} });

test('Auto routes only fresh unscoped messages and keeps the explicit selection independent', async () => {
  const f = fixture(); try {
    const classified = [];
    f.assistant.classifyMessage = async ({ text }) => { classified.push(text); return { projectId: text.includes('website') ? 'a' : null }; };
    await f.assistant.handleUpdate(message('Check my website', 100)); await f.assistant.serial;
    assert.equal(Object.values(f.store.data.jobs)[0].scopeProjectId, 'a');
    assert.ok(!f.store.data.selectedProjectId);
    await f.assistant.handleUpdate(message('Explain moonlight', 101)); await f.assistant.serial;
    const general = Object.values(f.store.data.jobs).find(j => j.project === 'Assistant');
    assert.ok(general);
    f.store.data.replies['99'] = general.id;
    f.store.data.selectedProjectId = 'b';
    await f.assistant.handleUpdate(message('Check my website', 102, { reply_to_message: { message_id: 99 } })); await f.assistant.serial;
    assert.equal(f.rpc.calls.findLast(c => c.method === 'turn/steer').params.threadId, general.threadId);
    await f.assistant.handleUpdate(message('Check my website', 103)); await f.assistant.serial;
    assert.ok(Object.values(f.store.data.jobs).some(j => j.scopeProjectId === 'b'));
    assert.deepEqual(classified, ['Check my website', 'Explain moonlight']);
  } finally { f.cleanup(); }
});

test('ambiguous and unavailable routing waits for one owner tap bound to the original message', async () => {
  for (const unavailable of [false, true]) {
    const f = fixture(); try {
      f.assistant.classifyMessage = async () => { if (unavailable) throw Error('offline'); return { choices: ['a', 'b'] }; };
      const original = 'Actualizăm pagina? 🌙\npassword=sampleSecretValue';
      await f.assistant.handleUpdate(message(original, 100, { message_id: 77 })); await f.assistant.serial;
      const button = f.sent[0].keyboard.inline_keyboard.flat().find(b => b.text === 'B');
      const pending = new StateStore(f.store.file).data.messageRoutes;
      assert.equal(Object.values(pending)[0].messageId, 77);
      assert.ok(!JSON.stringify(pending).includes('sampleSecretValue'));
      assert.ok(!f.sent[0].text.includes('sampleSecretValue'));
      await f.assistant.handleUpdate(choose(button.callback_data, 101, 2));
      await f.assistant.handleUpdate(choose(button.callback_data, 102, 1, 88));
      assert.equal(f.rpc.calls.length, 0);
      await f.assistant.handleUpdate(choose(button.callback_data, 103));
      await f.assistant.handleUpdate(choose(button.callback_data, 104)); await f.assistant.serial;
      assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
      assert.ok(f.rpc.calls.find(c => c.method === 'turn/start').params.input[0].text.startsWith(original));
      assert.equal(Object.values(f.store.data.jobs)[0].scopeProjectId, 'b');
      assert.equal(Object.keys(f.store.data.messageRoutes).length, 0);
      assert.ok(!f.store.data.selectedProjectId);
    } finally { f.cleanup(); }
  }
});

test('a routing shortlist can open every project, retains the request when metadata is stale and honors Cancel', async () => {
  const f = fixture(); try {
    f.assistant.classifyMessage = async () => ({ choices: ['a'] });
    await f.assistant.handleUpdate(message('Inspect this site', 100, { message_id: 77 })); await f.assistant.serial;
    const buttons = f.sent[0].keyboard.inline_keyboard.flat();
    await f.assistant.handleUpdate(choose(buttons.find(b => b.text.includes('All projects')).callback_data, 101));
    const more = f.telegramCalls.findLast(c => c.method === 'editMessageReplyMarkup').params.reply_markup.inline_keyboard.flat();
    f.assistant.refreshContext = async () => ({ status: 'stale' });
    await f.assistant.handleUpdate(choose(more.find(b => b.text === 'B').callback_data, 102)); await f.assistant.serial;
    assert.equal(f.rpc.calls.length, 0);
    assert.equal(Object.keys(f.store.data.messageRoutes).length, 1);
    await f.assistant.handleUpdate(choose(more.find(b => b.text === 'Cancel').callback_data, 103));
    assert.equal(f.rpc.calls.length, 0);
    assert.ok(f.assistant.controls.housekeeping.candidates().includes('77'));
  } finally { f.cleanup(); }
});

test('native project picker switches context without creating or starting any Codex work', async () => {
  const f = fixture();
  try {
    await f.assistant.handleUpdate(message('/project', 100));
    const rows = f.sent.at(-1).keyboard.inline_keyboard;
    assert.equal(rows[0][0].text, 'Auto · choose per message');
    assert.ok(rows.flat().every(b => Buffer.byteLength(b.callback_data) <= 64));
    const selection = rows.flat().find(b => b.text === 'A').callback_data;
    await f.assistant.handleUpdate(choose(selection, 101, 2));
    assert.ok(!f.store.data.selectedProjectId);
    await f.assistant.handleUpdate(choose(selection, 102));
    assert.equal(f.store.data.selectedProjectId, 'a');
    assert.match(f.store.data.inbox.panels['1'].signature, /Current project: A/);
    assert.equal(f.sent.length, 1, 'selection updates the picker message');
    assert.equal(new StateStore(f.store.file).data.selectedProjectId, 'a');
    assert.equal(f.rpc.calls.length, 0);
    await f.assistant.handleUpdate(choose(rows[0][0].callback_data, 103));
    assert.equal(f.store.data.selectedProjectId, 'a', 'old menu cannot change context after use');
    await f.assistant.handleUpdate(message('/projects', 104));
    const picker = f.telegramCalls.filter(c => c.method === 'editMessageText').at(-1).params;
    await f.assistant.handleUpdate(choose(picker.reply_markup.inline_keyboard[0][0].callback_data, 105, 1, picker.message_id));
    assert.equal(f.store.data.selectedProjectId, null);
    assert.equal(f.sent.length, 1, 'reopening projects reuses the Home panel');
    assert.equal(f.rpc.calls.length, 0);
  } finally { f.cleanup(); }
});

test('project paging invalidates old choices and maps visible projects to their actual IDs', async () => {
  const f = fixture(); try {
    f.assistant.projects = Array.from({ length: 14 }, (_, i) => ({ id: 'p' + i, name: 'Project ' + i, roots: [] }));
    await f.assistant.handleUpdate(message('/project', 100));
    const old = f.sent[0].keyboard.inline_keyboard.flat().find(b => b.text === 'Project 1');
    await f.assistant.handleUpdate(choose('ctl:projects:1', 101));
    const page = f.telegramCalls.findLast(c => c.method === 'editMessageText').params;
    assert.match(page.text, /2\/3/);
    await f.assistant.handleUpdate(choose(old.callback_data, 102));
    assert.ok(!f.store.data.selectedProjectId);
    await f.assistant.handleUpdate(choose(page.reply_markup.inline_keyboard.flat().find(b => b.text === 'Project 9').callback_data, 103));
    assert.equal(f.store.data.selectedProjectId, 'p9');
    assert.equal(f.rpc.calls.length, 0);
  } finally { f.cleanup(); }
});

test('expired and removed project buttons never select or start work', async () => {
  const f = fixture();
  try {
    await f.assistant.handleUpdate(message('/project', 100));
    const data = f.sent.at(-1).keyboard.inline_keyboard.flat().find(b => b.text === 'A').callback_data;
    f.assistant.projects = [];
    await f.assistant.handleUpdate(choose(data, 101));
    assert.ok(!f.store.data.selectedProjectId);
    f.assistant.projects = [{ id: 'a', name: 'A', roots: [projectA] }];
    await f.assistant.handleUpdate(message('/project', 102));
    const picker = f.telegramCalls.filter(c => c.method === 'editMessageText').at(-1).params;
    const expired = picker.reply_markup.inline_keyboard.flat().find(b => b.text === 'A').callback_data;
    f.store.data.projectPicker.expiresAt = 0;
    await f.assistant.handleUpdate(choose(expired, 103, 1, picker.message_id));
    assert.ok(!f.store.data.selectedProjectId);
    assert.equal(f.rpc.calls.length, 0);
  } finally { f.cleanup(); }
});

test('General and each selected project keep separate persistent coordinator conversations', async () => {
  const f = fixture();
  try {
    const general = await f.assistant.coordinate('General discussion', null);
    const a = await f.assistant.coordinate('Discuss A', 'a');
    const b = await f.assistant.coordinate('Discuss B', 'b');
    assert.equal(new Set([general.threadId, a.threadId, b.threadId]).size, 3);
    assert.equal(f.store.data.projectCoordinators.a.threadId, a.threadId);
    assert.equal(f.store.data.projectCoordinators.b.threadId, b.threadId);
    f.assistant.active.clear();
    const again = await f.assistant.coordinate('Continue A', 'a');
    assert.equal(again.threadId, a.threadId);
    assert.equal(f.rpc.calls.filter(c => c.method === 'thread/start').length, 3);
    assert.ok(f.rpc.calls.filter(c => c.method === 'thread/start').every(c => c.params.sandbox === 'read-only'));
    const restart = new Assistant({ rpc: f.rpc, telegram: { send: async () => [] }, store: new StateStore(f.store.file), projects: f.assistant.projects, workspace: f.dir });
    try { assert.equal(await restart.ensureCoordinator('a'), a.threadId); } finally { restart.close(); }
  } finally { f.cleanup(); }
});

test('selected project receives only its own automatic context and cannot dispatch or read another project', async () => {
  const f = fixture();
  try {
    f.assistant.context = { projects: f.assistant.projects, async refresh() { return {
      status: 'fresh', projects: f.assistant.projects,
      recent: [{ name: 'A history', cwd: projectA }, { name: 'B private history', cwd: projectB }],
      signals: [{ project: 'A', cwd: projectA }, { project: 'B', cwd: projectB }]
    }; } };
    const job = await f.assistant.coordinate('What changed?', 'a');
    const prompt = f.rpc.calls.find(c => c.method === 'turn/start').params.input[0].text;
    assert.match(prompt, /A history/); assert.ok(!prompt.includes('B private history'));
    await f.assistant.onRequest({ id: 901, method: 'item/tool/call', params: { threadId: job.threadId, tool: 'dispatch_project', arguments: { project: 'B', prompt: 'Change B' } } });
    assert.equal(f.rpc.calls.at(-1).result.success, false);
    assert.equal(Object.keys(f.store.data.workers).length, 0);
    f.rpc.call = async () => ({ thread: { cwd: projectB } });
    await assert.rejects(f.assistant.readChat('b-history', 'a'), /outside/);
  } finally { f.cleanup(); }
});

test('unthreaded queued instructions retain the project selected at receipt', async () => {
  const f = fixture();
  try {
    f.store.data.selectedProjectId = 'a';
    f.store.data.jobs.old = { projectId: 'b', status: 'completed' };
    f.store.data.replies['999'] = 'old';
    let release;
    f.assistant.serial = new Promise(resolve => { release = resolve; });
    const routed = [];
    f.assistant.coordinate = async (text, projectId) => routed.push({ text, projectId });
    f.assistant.dispatch = async () => assert.fail('Old reply must not override selected project');
    await f.assistant.handleUpdate(message('Discuss this', 100));
    f.store.data.selectedProjectId = 'b';
    release(); await f.assistant.serial;
    assert.deepEqual(routed, [{ text: 'Discuss this', projectId: 'a' }]);
  } finally { f.cleanup(); }
});

test('explicit result replies target their worker or discussion project regardless of picker selection',async()=>{
  const f=fixture();try{
    f.store.data.selectedProjectId='b';
    f.store.data.jobs.worker={id:'worker',projectId:'a',status:'completed'};
    f.store.data.jobs.discussion={id:'discussion',scopeProjectId:'a',status:'completed'};
    f.store.data.replies['700']='worker';f.store.data.replies['701']='discussion';
    const routed=[];
    f.assistant.dispatch=async(projectId,text)=>routed.push({projectId,text,kind:'worker'});
    f.assistant.coordinate=async(text,projectId)=>routed.push({projectId,text,kind:'discussion'});
    await f.assistant.handleUpdate(message('Update A',200,{reply_to_message:{message_id:700}}));await f.assistant.serial;
    await f.assistant.handleUpdate(message('Discuss A',201,{reply_to_message:{message_id:701}}));await f.assistant.serial;
    assert.deepEqual(routed,[{projectId:'a',text:'Update A',kind:'worker'},{projectId:'a',text:'Discuss A',kind:'discussion'}]);
    assert.equal(f.store.data.selectedProjectId,'b');
  }finally{f.cleanup();}
});

test('desktop notification replies use their durable exact route and reject unauthorized users',async()=>{
  const f=fixture();try{
    const route={threadId:'desktop-a',hostId:'local',projectId:'a'};
    f.store.data.desktopReplies={'702':route};f.store.data.selectedProjectId='b';
    const routed=[];f.assistant.desktop={async reply(...args){routed.push(args);return {status:'sent'};}};
    f.assistant.coordinate=async()=>assert.fail('Must not route through selected conversation');
    await f.assistant.handleUpdate(message('Edit A',202,{from:{id:2},reply_to_message:{message_id:702}}));
    await f.assistant.handleUpdate(message('Edit A',203,{reply_to_message:{message_id:702}}));await f.assistant.serial;
    assert.equal(routed.length,1);assert.deepEqual(routed[0],[route,'Edit A',203,[]]);
    assert.equal(f.store.data.selectedProjectId,'b');
  }finally{f.cleanup();}
});

test('persisted expired native questions cannot become new instructions in another selected project',async()=>{
  const f=fixture();try{
    f.store.data.inputReplies={'703':{jobId:'old-input',questionId:'q'}};
    f.store.data.selectedProjectId='b';
    let called=false;f.assistant.coordinate=async()=>{called=true;};
    await f.assistant.handleUpdate(message('Yes',204,{reply_to_message:{message_id:703}}));await f.assistant.serial;
    assert.match(f.sent.at(-1).text,/expired|no longer/i);
    assert.equal(called,false);
  }finally{f.cleanup();}
});

test('explicit desktop access applies the authorized permissions to coordinator and worker start/resume', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    await f.assistant.ensureCoordinator();
    await f.assistant.ensureCoordinator('a');
    const worker = await f.assistant.dispatch('A', 'Inspect only');
    f.assistant.active.clear(); f.store.data.jobs[worker.id].status = 'completed';
    await f.assistant.dispatch('A', 'Continue');
    const sessions = f.rpc.calls.filter(c => ['thread/start','thread/resume'].includes(c.method));
    assert.equal(sessions.length, 4);
    for (const { params } of sessions) {
      assert.equal(params.sandbox, 'danger-full-access');
      assert.equal(params.approvalPolicy, 'never');
      assert.equal(params.config['features.shell_tool'], true);
      assert.equal(params.config['features.apps'], true);
      assert.equal(params.config['features.plugins'], true);
      assert.equal(params.config.web_search, 'live');
      assert.ok(!params.developerInstructions.includes('Do not change global Codex configuration or the Telegram bridge'));
    }
    assert.equal(sessions[1].params.cwd, projectA);
  } finally { f.cleanup(); }
});

test('desktop permission upgrades preserve existing coordinator history including contested writers', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    f.store.data.coordinator = 'saved-general';
    const original = f.rpc.call.bind(f.rpc);
    f.rpc.call = async (method, params) => {
      if (method === 'thread/resume') throw Object.assign(new Error('already has an active writer'), { code: -32600 });
      return original(method, params);
    };
    await f.assistant.ensureCoordinator();
    const fork = f.rpc.calls.find(c => c.method === 'thread/fork');
    assert.equal(fork.params.sandbox, 'danger-full-access');
    assert.equal(fork.params.approvalPolicy, 'never');
    assert.deepEqual(f.store.data.coordinatorHistory, ['saved-general']);
  } finally { f.cleanup(); }
});

test('full-access direct work reserves roots while allowing its own authorized worker delegation', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    const parent = await f.assistant.coordinate('Inspect project A', 'a');
    assert.deepEqual(parent.roots, [projectA]);
    assert.deepEqual(parent.imageRoots, parent.roots);
    await assert.rejects(f.assistant.dispatch('A', 'Unrelated task'), /busy|overlap/);
    await f.assistant.onRequest({ id: 801, method: 'item/tool/call', params: {
      threadId: parent.threadId, tool: 'dispatch_project', arguments: { project: 'A', prompt: 'Inspect only' }
    } });
    assert.equal(f.rpc.calls.at(-1).result.success, true);
    const child = Object.values(f.store.data.jobs).find(j => j.projectId === 'a');
    assert.equal(child.status, 'running');
    const control = await f.assistant.coordinate('What is happening with A?', 'parent');
    assert.deepEqual(control.roots, []);
    assert.deepEqual(control.imageRoots, f.assistant.projects.find(p => p.id === 'parent').roots);
    assert.equal(control.executionMode, 'read-only-control');
    const turn = f.rpc.calls.filter(c => c.method === 'turn/start').at(-1);
    assert.equal(turn.params.sandboxPolicy.type, 'readOnly');
  } finally { f.cleanup(); }
});

test('full-access coordinators can ask the paired owner for missing decisions', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    const job = await f.assistant.coordinate('Ask a decision');
    await f.assistant.onRequest({ id: 802, method: 'item/tool/requestUserInput', params: {
      threadId: job.threadId, questions: [{ id: 'decision', question: 'Which branch?', options: [] }]
    } });
    assert.match(f.sent.at(-1).text, /Which branch/);
    await f.assistant.handleUpdate(message('main', 300, { reply_to_message: { message_id: f.sent.length } }));
    assert.equal(f.rpc.calls.find(c => c.responseId === 802).result.answers.decision.answers[0], 'main');
  } finally { f.cleanup(); }
});

test('permission migration appends current trusted instructions to saved coordinator and worker history', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    f.store.data.coordinator = 'previously-read-only';
    f.store.data.workers.a = { threadId: 'previously-restricted-worker', roots: f.assistant.projects[0].roots };
    await f.assistant.ensureCoordinator();
    await f.assistant.dispatch('A', 'Authorized inspection');
    const injected = f.rpc.calls.filter(c => c.method === 'thread/inject_items');
    assert.deepEqual(injected.map(c => c.params.threadId), ['previously-read-only', 'previously-restricted-worker']);
    for (const { params } of injected) {
      assert.equal(params.items[0].role, 'developer');
      assert.match(params.items[0].content[0].text, /full filesystem, shell and network access/);
      assert.match(params.items[0].content[0].text, /supersede/i);
    }
  } finally { f.cleanup(); }
});

test('full-access startup fails before submitting work when native settings do not match the authorized policy', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    const original = f.rpc.call.bind(f.rpc);
    f.rpc.call = async (method, params) => method === 'thread/start' ? {
      thread: { id: 'restricted' }, sandbox: { type: 'readOnly' }, approvalPolicy: 'never'
    } : original(method, params);
    await assert.rejects(f.assistant.coordinate('Authorized task'), /permission|access/i);
    assert.equal(f.rpc.calls.some(c => c.method === 'turn/start'), false);
    assert.ok(!f.assistant.coordinatorLoaded);
  } finally { f.cleanup(); }
});

test('selected full-access coordinator can interrupt its own direct task', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    const job = await f.assistant.coordinate('Inspect A', 'a');
    await f.assistant.onRequest({ id: 803, method: 'item/tool/call', params: {
      threadId: job.threadId, tool: 'stop_job', arguments: { jobId: job.id }
    } });
    assert.equal(f.rpc.calls.at(-1).result.success, true);
    assert.ok(f.rpc.calls.some(c => c.method === 'turn/interrupt' && c.params.threadId === job.threadId));
  } finally { f.cleanup(); }
});

test('a follow-up waits for an active control turn before restoring full write permissions', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    f.store.data.jobs.busy = { id: 'busy', roots: [projectA], status: 'running' };
    const control = await f.assistant.coordinate('What is happening?', 'a');
    assert.equal(control.executionMode, 'read-only-control');
    f.store.data.jobs.busy.status = 'completed';
    const followup = f.assistant.coordinate('Now apply the requested edit', 'a');
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.rpc.calls.some(c => c.method === 'turn/steer'), false);
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
    f.rpc.emit('notification', { method: 'turn/completed', params: { threadId: control.threadId,
      turn: { id: control.turnId, status: 'completed' } } });
    const next = await followup;
    assert.deepEqual(next.roots, [projectA]);
    assert.equal(next.executionMode, undefined);
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'dangerFullAccess');
  } finally { f.cleanup(); }
});

test('a selected project waits for an overlapping General reply instead of losing writable permissions', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    const general = await f.assistant.coordinate('Explain the project command');
    const selected = f.assistant.coordinate('Apply the requested edit', 'a', ['C:\\photo.png']);
    await new Promise(resolve => setTimeout(resolve, 15));
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
    f.rpc.emit('notification', { method: 'turn/completed', params: { threadId: general.threadId,
      turn: { id: general.turnId, status: 'completed' } } });
    const next = await selected;
    assert.equal(next.scopeProjectId, 'a');
    assert.deepEqual(next.roots, [projectA]);
    assert.equal(next.executionMode, undefined);
    const turns = f.rpc.calls.filter(c => c.method === 'turn/start');
    assert.equal(turns.length, 2);
    assert.equal(turns[1].params.sandboxPolicy.type, 'dangerFullAccess');
    assert.match(turns[1].params.input[0].text, /^Apply the requested edit/);
    assert.deepEqual(turns[1].params.input[1], { type: 'localImage', path: 'C:\\photo.png' });
    assert.equal(f.rpc.calls.some(c => c.method === 'turn/steer'), false);
  } finally { f.cleanup(); }
});

test('queued project work is not submitted when the native connection closes', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    await f.assistant.coordinate('A General reply');
    const selected = f.assistant.coordinate('Edit project A', 'a');
    const rejected = assert.rejects(selected, /connection closed before the queued instruction was submitted/i);
    await new Promise(resolve => setTimeout(resolve, 15));
    f.rpc.emit('closed');
    await rejected;
    assert.equal(f.rpc.calls.filter(c => c.method === 'turn/start').length, 1);
    assert.equal(f.assistant.turnWaiters.size, 0);
  } finally { f.cleanup(); }
});

test('a General question awaiting its answer does not block selected project control', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    const general = await f.assistant.coordinate('Ask a decision');
    await f.assistant.onRequest({ id: 805, method: 'item/tool/requestUserInput', params: {
      threadId: general.threadId, questions: [{ id: 'decision', question: 'Which branch?', options: [] }]
    } });
    const selected = await f.assistant.coordinate('Explain the current blocker', 'a');
    assert.equal(selected.executionMode, 'read-only-control');
    assert.equal(f.assistant.turnWaiters.size, 0);
    assert.equal(f.assistant.pending.size, 1);
  } finally { f.cleanup(); }
});

test('own delegation never skips an older uncertain coordinator job on the same thread', async () => {
  const f = fixture({ executionAccess: 'desktop-full-access' });
  try {
    const threadId = await f.assistant.ensureCoordinator('a');
    f.store.data.jobs.older = { id: 'older', threadId, roots: [projectA], status: 'uncertain' };
    const control = await f.assistant.coordinate('Inspect what happened', 'a');
    await f.assistant.onRequest({ id: 804, method: 'item/tool/call', params: {
      threadId: control.threadId, tool: 'dispatch_project', arguments: { project: 'A', prompt: 'Do it again' }
    } });
    assert.equal(f.rpc.calls.at(-1).result.success, false);
    assert.equal(Object.keys(f.store.data.workers).length, 0);
  } finally { f.cleanup(); }
});
