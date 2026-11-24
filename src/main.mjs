import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync, watch } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from './rpc.mjs';
import { Telegram } from './telegram.mjs';
import { StateStore } from './state.mjs';
import { discoverProjects } from './projects.mjs';
import { loadToken } from './credentials.mjs';
import { Assistant } from './assistant.mjs';
import { acquireInstance } from './instance.mjs';
import { hasStopRequest } from './stop-request.mjs';
import { ContextSync } from './context.mjs';
import { readLifecycleEvents } from './lifecycle.mjs';
import { DesktopTools } from './desktop-tools.mjs';
import { DesktopMonitor } from './desktop.mjs';

if (process.platform !== 'win32') process.umask(0o077);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const local = join(root, '.local');
mkdirSync(local, { recursive: true });
let instance, rpc, telegram, assistant, desktop, desktopTools, watcher, contextTimer, desktopTimer, typingTimer, eventWatcher, eventDebounce, stopping = false;
const healthFile = join(local, 'health.json');
const stopRequested = () => hasStopRequest(join(local, 'stop.json'), instance.nonce, join(local, 'paused.json'));
const health = data => writeFileSync(healthFile, JSON.stringify({ ...data, pid: process.pid, at: new Date().toISOString() }));
async function stop() {
  if (stopping) return;
  stopping = true;
  assistant?.beginShutdown();
  desktop?.close(); desktopTools?.close();
  clearInterval(watcher);
  clearInterval(contextTimer);
  clearInterval(desktopTimer);
  clearInterval(typingTimer);
  clearTimeout(eventDebounce);
  eventWatcher?.close();
  telegram?.close();
  if (assistant && rpc && !rpc.closed) {
    await Promise.allSettled([...assistant.active].map(([threadId, id]) => {
      const job = assistant.store.data.jobs[id];
      return job.turnId ? rpc.call('turn/interrupt', { threadId, turnId: job.turnId }, 3000) : Promise.resolve();
    }));
  }
  assistant?.markDisconnected();
  assistant?.close();
  rpc?.close();
  await Promise.allSettled([assistant?.serial, desktop?.inflight, assistant?.controls.flushing, assistant?.controls.cleanupPending, assistant?.controls.heldPending].filter(Boolean));
  instance?.release();
  health({ status: 'stopped' });
}

try {
  instance = acquireInstance(join(local, 'instance.json'));
  // Stop may have raced an automatic launch before this new instance acquired its lock.
  if (stopRequested()) { await stop(); process.exit(0); }
  const config = JSON.parse(readFileSync(join(local, 'config.json'), 'utf8'));
  const tokenFile = join(local, process.platform === 'win32' ? 'telegram-token.dpapi' : 'telegram-token.secure');
  const token = loadToken(tokenFile);
  telegram = new Telegram(token);
  const bot = await telegram.call('getMe');
  if (config.botId !== bot.id) throw new Error('Configured Telegram bot identity does not match its credential.');
  const webhook = await telegram.call('getWebhookInfo');
  if (webhook.url) throw new Error('This bot already has a webhook. Use a separate bot; the existing webhook was preserved.');
  const store = new StateStore(join(local, 'state.json'));
  const recovered = store.recover();
  const loadProjects = () => discoverProjects(undefined, { executionAccess: config.executionAccess,
    assistantRoot: root, projects: config.projects });
  const projects = loadProjects();
  const pairCode = store.data.owner ? undefined : randomBytes(20).toString('hex');
  if (pairCode) writeFileSync(join(local, 'pairing.json'), JSON.stringify({ username: bot.username, code: pairCode }), { mode: 0o600 });
  const workspace = join(root, 'workspace');
  mkdirSync(workspace, { recursive: true });
  rpc = new RpcClient({ command: config.codexBin || 'codex', cwd: root, env:{...process.env,TELEGRAM_CODEX_BRIDGE:'1'} });
  rpc.on('closed', () => { if (!stopping) stop().catch(() => {}); });
  await rpc.initialize();
  if (stopRequested()) { await stop(); process.exit(0); }
  const eventsFolder = join(local, 'events');
  mkdirSync(eventsFolder, { recursive: true });
  const context = new ContextSync({ rpc, loadProjects, loadEvents: () => readLifecycleEvents(eventsFolder),
    excludeThreadIds: () => [store.data.coordinator, ...Object.values(store.data.projectCoordinators || {}).map(c => c.threadId), ...Object.values(store.data.workers).map(w => w.threadId)].filter(Boolean) });
  await context.refresh();
  if (rpc.closed || stopping) throw new Error('Native connection closed during initial context refresh.');
  assistant = new Assistant({ rpc, telegram, store, projects, workspace, pairCode, context, routeCommand: config.codexBin || 'codex',
    executionAccess: config.executionAccess, assistantRoot: root });
  // Readable history is insufficient: restore a writable bridge-owned coordinator
  // before announcing readiness, including recovery from a desktop-held writer.
  if (store.data.owner) await assistant.ensureCoordinator();
  if (store.data.owner && store.data.selectedProjectId && assistant.projects.some(p => p.id === store.data.selectedProjectId))
    await assistant.ensureCoordinator(store.data.selectedProjectId);
  if (rpc.closed || stopping) throw new Error('Native connection closed while restoring the assistant conversation.');
  if (stopRequested()) { await stop(); process.exit(0); }
  const ownedIds = () => [store.data.coordinator, ...(store.data.coordinatorHistory || []),
    ...Object.values(store.data.projectCoordinators || {}).flatMap(c=>[c.threadId,...(c.previousThreadIds || [])]),
    ...Object.values(store.data.workers).flatMap(w=>[w.threadId,...(w.previousThreadIds || [])]),
    ...Object.values(store.data.jobs).map(j=>j.threadId)].filter(Boolean);
  desktopTools = new DesktopTools({ nodeBin: config.nodeBin, hostFile: join(local,'desktop-host.json'), callerThreadId:()=>store.data.coordinator });
  desktop = new DesktopMonitor({ tools:desktopTools, store, send:assistant.send.bind(assistant),
    loadProjects, loadEvents:()=>readLifecycleEvents(eventsFolder), excludeThreadIds:ownedIds, excludeRoots:[local], controls: assistant.controls });
  assistant.desktop = desktop;
  // Presence recovery must examine the entire retained set: a recent prompt
  // may precede many tool events produced while the listener was unavailable.
  assistant.controls.activity.loadEvents = () => readLifecycleEvents(eventsFolder, { limit: 500 });
  assistant.controls.activity.excludeThreadIds = ownedIds;
  assistant.controls.activity.refresh();
  desktop.scan().then(() => assistant.controls.introduce()).catch(()=>{});
  const publishHealth = () => health({ status: 'running', botUsername: bot.username, paired: Boolean(store.data.owner),
    projectCount: assistant.projects.length, coordinatorReady: Boolean(assistant.coordinatorLoaded),
    executionAccess: assistant.fullAccess ? 'desktop-full-access' : 'project-sandbox',
    verifiedCoordinatorPermissions: assistant.sessionPermissions.get(store.data.coordinator) || null,
    desktopNotifications: desktop.health, controlsVersion: 'inbox-v1',
    notificationDelivery: assistant.controls.activity.status(),
    inbox: { needsAttention: assistant.controls.inbox.list().length, snoozed: assistant.controls.inbox.list('snoozed').length },
    contextMode: context.snapshot.mode, contextStatus: context.snapshot.status,
    contextObservedAt: context.snapshot.observedAt, contextRefreshSeconds: 5,
    desktopEventCount: context.snapshot.signals?.length || 0, lastDesktopEventAt: context.snapshot.signals?.[0]?.receivedAt || null });
  contextTimer = setInterval(() => { assistant.controls.activity.refresh(); assistant.refreshContext().catch(() => {}); }, 5000);
  desktopTimer = setInterval(() => { desktop.scan().then(() => assistant.controls.flush()).catch(()=>{}); }, 10_000);
  assistant.controls.startCleanup();
  typingTimer = setInterval(() => { assistant.showTyping().catch(() => {}); }, 4000);
  eventWatcher = watch(eventsFolder, (_event, filename) => {
    if (filename?.endsWith('.json')) assistant.controls.activity.refresh();
    clearTimeout(eventDebounce);
    eventDebounce = setTimeout(() => { if (!stopping) { assistant.refreshContext().catch(() => {}); desktop.scan().catch(()=>{}); } }, 250);
  });
  eventWatcher.on('error', () => eventWatcher.close()); // Periodic refresh remains available.
  publishHealth();
  void assistant.registerMenu();
  watcher = setInterval(() => {
    if (stopRequested()) { stop().catch(() => {}); return; }
    if (store.data.owner && existsSync(join(local, 'pairing.json'))) unlinkSync(join(local, 'pairing.json'));
    publishHealth();
  }, 1500);
  process.once('SIGINT', () => stop().catch(() => {}));
  process.once('SIGTERM', () => stop().catch(() => {}));
  if (store.data.owner && recovered.length) await assistant.send(`Assistant restarted. Jobs ${recovered.join(', ')} need inspection before continuing. Nothing was replayed. See /status.`);
  let backoff = 1000;
  while (!stopping) {
    if (stopRequested()) { await stop(); break; }
    try {
      const updates = await telegram.call('getUpdates', { offset: store.data.offset, timeout: 25,
        allowed_updates: ['message', 'edited_message', 'callback_query'] });
      backoff = 1000;
      for (const update of updates) {
        if (stopping || stopRequested()) { await stop(); break; }
        try { await assistant.handleUpdate(update); }
        catch { await assistant.controls.help('The instruction could not complete. Check /status before retrying; no automatic replay was attempted.'); }
      }
    } catch (e) {
      if (stopping) break;
      if ([401, 409].includes(e.code)) throw new Error('Telegram authentication failed or another bot listener is active.');
      health({ status: 'reconnecting', paired: Boolean(store.data.owner), botUsername: bot.username });
      await delay(Math.min((e.retryAfter || 0) * 1000 || backoff, 30_000));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  await stop();
} catch (e) {
  if (instance) {
    await stop();
    // A competing launch must not overwrite the running owner's health metadata.
    health({ status: 'failed', reason: 'Startup or connection failed. Run local diagnostics; credentials were not logged.' });
  }
  console.error('Assistant could not start or lost a required connection. Run Setup.cmd on Windows or scripts/setup.sh on macOS/Linux, then inspect local health.json.');
  process.exitCode = 1;
}
