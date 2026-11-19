import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, mkdirSync, copyFileSync, writeFileSync, realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StateStore } from '../src/state.mjs';
import { Inbox } from '../src/inbox.mjs';
import { ActivityGate } from '../src/activity.mjs';
import { recordLifecycleEvent, readLifecycleEvents, mergeActivityHooks, recordDesktopHost } from '../src/lifecycle.mjs';

function desktopPrompt(dir, options = {}) {
  const { source = 'vscode', originator = 'Codex Desktop', threadSource = 'user', id = 'session',
    turn = 'turn', trigger = 'composer', kind = 'user.text', provenance = 'user',
    text = 'A real desktop message', at = Date.now(), initialHeartbeat = false, agentPath = null } = options;
  const file = join(dir, 'rollout.jsonl');
  const rows = [
    { type: 'session_meta', payload: { id, source, originator, thread_source: threadSource, agent_path: agentPath } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn, turn_attribution: {
      turn_id: turn, turn_trigger: trigger, root_turn_id: turn, initiating_agent_path: agentPath } } }
  ];
  const message = (body, messageKind, time) => ({ type: 'response_item', timestamp: new Date(time).toISOString(), payload: {
    type: 'message', role: 'user', content: [{ type: 'input_text', text: body }],
    internal_chat_message_metadata_passthrough: { turn_id: turn, create_time: time / 1000,
      content_item_kinds: [messageKind], content_item_metadata: [{ provenance: { type: provenance } }] } } });
  if (initialHeartbeat) rows.push(message('<heartbeat>Background work</heartbeat>', 'user.heartbeat', at - 5000));
  rows.push(message(text, kind, at));
  writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + '\n');
  return { hook_event_name: 'UserPromptSubmit', session_id: id, turn_id: turn, cwd: dir, prompt: text, transcript_path: file };
}

test('presence requires a matching manual Desktop submission and fails closed for background and unknown sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-presence-proof-'));
  try {
    for (const [options, manual] of [
      [{}, true],
      [{ text: 'Răspuns real\nA doua linie' }, true],
      [{ trigger: 'send_user_message_async_question', text: '<send_user_message_question_reply>Blue</send_user_message_question_reply>' }, true],
      [{ trigger: 'automation_heartbeat_scheduled', initialHeartbeat: true, text: 'My actual correction while the task is running' }, true],
      [{ kind: 'user.heartbeat', trigger: 'automation_heartbeat_scheduled', text: 'Continue background work' }, false],
      [{ trigger: 'automation_heartbeat_scheduled', text: 'An automatic initial instruction' }, false],
      [{ trigger: 'mcp_followup', text: 'An unmarked programmatic follow-up' }, false],
      [{ source: 'exec', originator: 'codex_exec' }, false],
      [{ source: { subagent: { parent_thread_id: 'parent' } }, agentPath: '/root/worker' }, false],
      [{ provenance: 'harness' }, false],
      [{ at: Date.now() - 60_000 }, false],
      [{ at: Date.now() + 60_000 }, false]
    ]) {
      const input = desktopPrompt(dir, options);
      const event = recordLifecycleEvent(join(dir, 'events'), input, { bridge: false });
      assert.equal(event.origin === 'desktop-user', manual, JSON.stringify(options));
    }
    const input = desktopPrompt(dir);
    for (const changed of [
      { transcript_path: undefined }, { transcript_path: join(dir, 'missing.jsonl') },
      { session_id: 'another-session' }, { turn_id: 'another-turn' }, { prompt: 'Not the persisted user submission' }
    ]) {
      const event = recordLifecycleEvent(join(dir, 'events'), { ...input, ...changed }, { bridge: false });
      assert.notEqual(event.origin, 'desktop-user', JSON.stringify(changed));
    }
    assert.equal(recordLifecycleEvent(join(dir, 'events'), { ...input, agent_id: 'worker' }, { bridge: false }).origin, 'agent');
    writeFileSync(input.transcript_path, 'invalid metadata\n');
    assert.notEqual(recordLifecycleEvent(join(dir, 'events'), input, { bridge: false }).origin, 'desktop-user');
    const saved = JSON.stringify(readLifecycleEvents(join(dir, 'events'), { limit: 500 }));
    assert.ok(!saved.includes('A real desktop message')); assert.ok(!saved.includes('transcript_path'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('lifecycle capture stores only activity metadata, never prompts, commands or assistant text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-events-'));
  try {
    const events = join(dir, 'events');
    const event = recordLifecycleEvent(events, { hook_event_name: 'Stop', cwd: dir, session_id: 'session-1', turn_id: 'turn-1',
      prompt: 'private prompt', tool_input: { command: 'private command' }, last_assistant_message: 'private response' });
    assert.equal(event.event, 'Stop');
    const saved = readLifecycleEvents(events);
    assert.equal(saved.length, 1);
    assert.ok(!JSON.stringify(saved).includes('private'));
    assert.equal(recordLifecycleEvent(events, { hook_event_name: 'Unknown', cwd: dir, session_id: '../escape' }), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('prompt activity records only its origin and ignores Telegram and automated messages for presence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-prompt-origin-'));
  try {
    for (const [prompt, origin, options] of [
      ['Private human prompt', 'desktop-user', { bridge: false }],
      ['Bridge-owned instruction', 'telegram', { bridge: true }],
      ['Owner replied in Telegram [request 123] to this earlier completion', 'telegram', { bridge: false }],
      ['<codex_delegation><input>Owner replied in Telegram [request 123]</input></codex_delegation>', 'telegram', { bridge: false }],
      ['Automation: Daily check\nAutomation ID: daily-check\nPrivate scheduled prompt', 'automation', { bridge: false }],
      ['<automation_context>Private scheduled prompt</automation_context>', 'automation', { bridge: false }],
      ['<heartbeat>\n<automation_id>scheduled-check</automation_id>\nPrivate scheduled prompt\n</heartbeat>', 'automation', { bridge: false }],
      ['<codex_delegation>Private delegated prompt</codex_delegation>', 'agent', { bridge: false }]
    ]) {
      const event = recordLifecycleEvent(dir, desktopPrompt(dir, { text: prompt }), options);
      assert.equal(event.origin, origin);
    }
    const saved = readLifecycleEvents(dir);
    assert.ok(saved.some(e => e.origin === 'desktop-user' && Number.isFinite(Date.parse(e.submittedAt))));
    assert.ok(saved.every(e => !('prompt' in e)));
    assert.ok(!JSON.stringify(saved).includes('Private'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('activity recovery reads a recent submitted message beyond the context snapshot limit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-recover-presence-'));
  try {
    const events = join(dir, 'events'); mkdirSync(events);
    const now = Date.now(), promptAt = now - 60_000;
    for (let i = 0; i <= 150; i++) {
      const id = randomUUID(), at = promptAt + i;
      writeFileSync(join(events, `${at}-${id}.json`), JSON.stringify({ id, sessionId: 'desktop-chat', cwd: dir,
        event: i ? 'PostToolUse' : 'UserPromptSubmit', ...(i ? {} : { origin: 'desktop-user', submittedAt: new Date(at).toISOString() }), receivedAt: new Date(at).toISOString() }));
    }
    assert.equal(readLifecycleEvents(events).length, 100, 'ordinary context snapshots stay bounded');
    const inbox = new Inbox(new StateStore(join(dir, 'state.json'))); inbox.now = () => now;
    inbox.data.settings.notificationMode = 'auto';
    inbox.data.activity = { lastPromptAt: now - 60 * 60_000 };
    const gate = new ActivityGate(inbox, { loadEvents: () => readLifecycleEvents(events, { limit: 500 }) });
    gate.refresh();
    assert.equal(gate.status().lastPromptAt, promptAt);
    assert.equal(gate.status().blocked, true, 'restart must not release alerts early');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('activity hook installation preserves existing hooks and is reversible without trusting hooks', () => {
  const existing = { description: 'Keep this', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'existing-command' }] }] } };
  const installed = mergeActivityHooks(existing, 'our-command');
  assert.equal(installed.hooks.Stop[0].hooks[0].command, 'existing-command');
  assert.equal(installed.hooks.Stop.length, 2);
  assert.deepEqual(mergeActivityHooks(installed, 'our-command'), installed);
  const removed = mergeActivityHooks(installed, 'our-command', true);
  assert.deepEqual(removed, existing);
  assert.ok(!JSON.stringify(installed).includes('bypass-hook-trust'));
});

test('desktop endpoint refresh stays separate from activity data and bridge children cannot overwrite it',()=>{
  const dir=mkdtempSync(join(tmpdir(),'desktop-host-'));try{
    const file=join(dir,'desktop-host.json');
    const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\new-desktop' : join(dir, 'new-desktop.sock');
    const staleEndpoint = process.platform === 'win32' ? '\\\\.\\pipe\\stale-bridge' : join(dir, 'stale-bridge.sock');
    recordDesktopHost(file,endpoint,false);
    recordDesktopHost(file,staleEndpoint,true);
    assert.equal(JSON.parse(readFileSync(file,'utf8')).pipe,endpoint);
    recordLifecycleEvent(join(dir,'events'),{hook_event_name:'Stop',session_id:'host-test',turn_id:'turn',cwd:dir});
    assert.ok(!JSON.stringify(readLifecycleEvents(join(dir,'events'))).includes('pipe'));
    recordDesktopHost(file,'https://not-a-desktop-pipe',false);
    assert.equal(JSON.parse(readFileSync(file,'utf8')).pipe,endpoint);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('producers bound retained event files without a running listener', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-retention-'));
  try {
    const events = join(dir, 'events');
    for (let i = 0; i < 505; i++) recordLifecycleEvent(events, { hook_event_name: 'Stop', session_id: 'session', cwd: dir });
    assert.equal(readdirSync(events).filter(n => n.endsWith('.json')).length, 500);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('concurrent metadata producers retain their bound without touching temporary publications', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-concurrent-events-'));
  try {
    const events = join(dir, 'events');
    for (let i = 0; i < 480; i++) recordLifecycleEvent(events, { hook_event_name: 'Stop', session_id: 'seed', cwd: dir });
    const moduleUrl = new URL('../src/lifecycle.mjs', import.meta.url).href;
    const code = `import {recordLifecycleEvent} from ${JSON.stringify(moduleUrl)};for(let i=0;i<40;i++)recordLifecycleEvent(${JSON.stringify(events)},{hook_event_name:'Stop',session_id:'concurrent',cwd:${JSON.stringify(dir)}});`;
    await Promise.all([1, 2].map(() => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', status => status === 0 ? resolve() : reject(new Error('Producer failed')));
    })));
    const names = readdirSync(events);
    assert.equal(names.filter(n => n.endsWith('.json')).length, 500);
    assert.ok(names.every(n => !n.endsWith('.tmp')));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Windows hook wrapper forwards UTF-8 bytes with an incompatible parent module path', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-nunți-'));
  try {
    for (const folder of ['scripts', 'src', '.local']) mkdirSync(join(dir, folder));
    copyFileSync(new URL('../scripts/lifecycle-hook.ps1', import.meta.url), join(dir, 'scripts', 'lifecycle-hook.ps1'));
    copyFileSync(new URL('../scripts/lifecycle-hook.mjs', import.meta.url), join(dir, 'scripts', 'lifecycle-hook.mjs'));
    copyFileSync(new URL('../src/lifecycle.mjs', import.meta.url), join(dir, 'src', 'lifecycle.mjs'));
    copyFileSync(new URL('../src/presence-provenance.mjs', import.meta.url), join(dir, 'src', 'presence-provenance.mjs'));
    writeFileSync(join(dir, '.local', 'config.json'), JSON.stringify({ nodeBin: process.execPath }));
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'scripts', 'lifecycle-hook.ps1')], {
      input: Buffer.from(JSON.stringify({ hook_event_name: 'Stop', session_id: 'utf8-test', cwd: dir })),
      env: { ...process.env, PSModulePath: 'C:\\unusable-module-path' }, windowsHide: true, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.status, 0);
    const events = readLifecycleEvents(join(dir, '.local', 'events'));
    assert.equal(events.length, 1);
    assert.equal(events[0].cwd, realpathSync(dir));
    assert.equal(result.stdout.trim(), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
