import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StateStore } from '../src/state.mjs';
import { Inbox } from '../src/inbox.mjs';
import { ActivityGate, IDLE_MS } from '../src/activity.mjs';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'tg-activity-'));
  const store = new StateStore(join(dir, 'state.json'));
  const inbox = new Inbox(store);
  let now = Date.now(), events = [];
  inbox.now = () => now;
  const options = { loadEvents: () => events, excludeThreadIds: () => ['bridge-owned'] };
  const gate = new ActivityGate(inbox, options);
  return { dir, store, inbox, gate, options,
    advance(ms) { now += ms; },
    event(overrides = {}) { const stamp = overrides.receivedAt || new Date(now).toISOString(); events = [{ id: 'event', event: 'UserPromptSubmit', origin: 'desktop-user', sessionId: 'chat-a', receivedAt: stamp, submittedAt: stamp, ...overrides }]; },
    cleanup() { rmSync(dir, { recursive: true, force: true }); } };
}
const update = { source: 'desktop', kind: 'completion', route: {} };

test('background prompts cannot postpone resumption, but a verified new manual message pauses it again', () => {
  const f = fixture(); try {
    f.gate.setMode('auto');
    const lastUserAt = f.inbox.now();
    for (let i = 0; i < 6; i++) {
      f.advance(5 * 60_000);
      f.event({ origin: i % 2 ? 'unknown' : 'desktop' }); f.gate.refresh();
    }
    assert.equal(f.gate.status().blocked, false, 'six background prompts must not extend the 30m window');
    assert.equal(f.gate.status().resumesAt, lastUserAt + IDLE_MS);
    f.event({ origin: 'desktop-user' }); f.gate.refresh();
    assert.equal(f.gate.status().blocked, true, 'an actual manual submission pauses immediately');
    const actualSubmission = new Date(f.inbox.now()).toISOString();
    f.advance(5 * 60_000); f.event({ origin: 'desktop-user', submittedAt: actualSubmission }); f.gate.refresh();
    assert.equal(f.gate.status().lastPromptAt, Date.parse(actualSubmission), 'a delayed duplicate cannot renew the actual submission time');
    f.advance(IDLE_MS - 5 * 60_000); assert.equal(f.gate.status().blocked, false);
  } finally { f.cleanup(); }
});

test('legacy inferred activity is discarded on upgrade without changing notification settings', () => {
  const f = fixture(); try {
    f.gate.setMode('auto'); const settings = structuredClone(f.inbox.data.settings);
    f.inbox.data.activity = { lastPromptAt: f.inbox.now(), enabledAt: f.inbox.now() - 60 * 60_000 };
    const upgraded = new ActivityGate(f.inbox, f.options);
    assert.equal(upgraded.status().blocked, false, 'an unverified legacy timestamp cannot keep Auto muted');
    assert.deepEqual(f.inbox.data.settings, settings);
  } finally { f.cleanup(); }
});

test('Automatic excludes notifications older than 30 minutes using immutable age, not last observation', () => {
  const f = fixture(); try {
    f.gate.setMode('auto');
    const createdAt = f.inbox.now();
    f.advance(IDLE_MS);
    for (const kind of ['input', 'approval', 'failure', 'completion']) {
      const item = { ...update, kind, createdAt, observedAt: f.inbox.now() };
      assert.equal(f.gate.tooOld(item), false, 'the exact 30-minute boundary remains eligible');
      f.advance(1);
      item.observedAt = f.inbox.now();
      assert.equal(f.gate.tooOld(item), true, 'a fresh scan must not renew an old notification');
      f.advance(-1);
    }
    assert.equal(f.gate.tooOld({ ...update, createdAt: f.inbox.now(), sourceAt: createdAt - 1 }), true, 'late discovery uses original source time');
    assert.equal(f.gate.tooOld({ ...update, createdAt: createdAt - 1, route: { direct: true } }), false);
    assert.equal(f.gate.tooOld({ ...update, source: 'bridge', createdAt: createdAt - 1 }), false);
    const recovered = f.inbox.observe('late-source-time', { ...update, label: 'Old completion', text: 'Completed earlier' });
    f.inbox.observe('late-source-time', { ...update, sourceAt: createdAt - 1 });
    f.inbox.observe('late-source-time', { ...update, sourceAt: f.inbox.now() });
    assert.equal(recovered.sourceAt, createdAt - 1, 'later scans cannot renew recovered source time');
    assert.equal(f.gate.tooOld(recovered), true);
    f.gate.setMode('always');
    assert.equal(f.gate.tooOld({ ...update, createdAt: createdAt - 1 }), false);
  } finally { f.cleanup(); }
});

test('automatic alerts resume at 30 minutes, and a message in any Codex chat pauses them again', () => {
  const f = fixture(); try {
    assert.equal(f.gate.blocks(update), false, 'existing installations keep their previous delivery until Auto is selected');
    f.gate.setMode('auto'); assert.equal(f.gate.blocks(update), true);
    f.advance(IDLE_MS - 1); assert.equal(f.gate.blocks(update), true);
    f.advance(1); assert.equal(f.gate.blocks(update), false);
    f.event({ sessionId: 'another-project' }); f.gate.refresh();
    assert.equal(f.gate.blocks(update), true);
    assert.equal(f.gate.blocks({ ...update, kind: 'input' }), true);
    assert.equal(f.gate.blocks({ ...update, kind: 'approval' }), true);
    assert.equal(f.gate.blocks({ ...update, kind: 'failure' }), true);
    f.advance(IDLE_MS); assert.equal(f.gate.blocks(update), false);
    f.gate.setMode('paused'); assert.equal(f.gate.blocks(update), true);
    f.gate.setMode('always'); assert.equal(f.gate.blocks(update), false);
  } finally { f.cleanup(); }
});

test('tool activity, Telegram, automation and owned sessions never reset the direct-message clock', () => {
  const f = fixture(); try {
    f.gate.setMode('auto'); f.advance(IDLE_MS);
    for (const event of [
      { event: 'PostToolUse' }, { event: 'Stop' }, { origin: 'telegram' },
      { origin: 'automation' }, { origin: 'agent' }, { origin: undefined },
      { sessionId: 'bridge-owned' }, { receivedAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString() }
    ]) { f.event(event); f.gate.refresh(); assert.equal(f.gate.blocks(update), false, JSON.stringify(event)); }
    assert.equal(f.gate.blocks({ source: 'bridge', kind: 'input' }), false);
    f.gate.setMode('paused');
    assert.equal(f.gate.blocks({ ...update, route: { direct: true } }), false);
    assert.equal(f.gate.blocks({ source: 'bridge', kind: 'completion' }), false);
  } finally { f.cleanup(); }
});

test('the automatic mode and activity timestamp survive restart without retaining prompt text', () => {
  const f = fixture(); try {
    f.gate.setMode('auto'); f.advance(5000); f.event(); f.gate.refresh();
    f.advance(29 * 60_000);
    const restarted = new Inbox(new StateStore(f.store.file)); restarted.now = f.inbox.now;
    const gate = new ActivityGate(restarted, f.options);
    assert.equal(gate.blocks(update), true);
    f.advance(60_000); assert.equal(gate.blocks(update), false);
    assert.ok(!JSON.stringify(restarted.data.activity).includes('prompt text'));
  } finally { f.cleanup(); }
});
