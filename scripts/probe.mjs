import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { RpcClient } from '../src/rpc.mjs';
import { discoverProjects } from '../src/projects.mjs';
import { StateStore } from '../src/state.mjs';
import { Assistant } from '../src/assistant.mjs';
import { protectMessage, unprotectMessage } from '../src/credentials.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
if (process.platform !== 'win32') process.umask(0o077);
const local = join(root, '.local', 'probe-' + Date.now());
mkdirSync(local, { recursive: true });
const rpc = new RpcClient({ cwd: root });
const evidence = { at: new Date().toISOString(), inference: process.argv.includes('--inference') };
let assistant;
try {
  await rpc.initialize();
  const account = await rpc.call('account/read', {});
  evidence.authType = account.account?.type || 'available';
  const threads = await rpc.call('thread/list', { limit: 3, sortKey: 'updated_at' });
  evidence.savedHistoryReadable = Array.isArray(threads.data);
  evidence.projectsDiscovered = discoverProjects().length;
  const marker = 'local-protection-roundtrip';
  evidence.credentialRoundTrip = unprotectMessage(protectMessage(marker)) === marker;
  if (process.platform === 'win32') evidence.dpapiRoundTrip = evidence.credentialRoundTrip;
  if (evidence.inference) {
    const store = new StateStore(join(local, 'state.json'));
    store.data.owner = { userId: 1, chatId: 1 };
    const messages = [];
    const telegram = { token: '', async send(chat, text) { messages.push(text); return [{ message_id: messages.length }]; }, async call() {} };
    assistant = new Assistant({ rpc, telegram, store, projects: [{ id: 'pilot', name: 'Telegram pilot', roots: [local] }], workspace: join(root, 'workspace'), workerSandbox: 'read-only' });
    await assistant.coordinate('Use list_projects, then call dispatch_project once for Telegram pilot with this exact task: "Reply exactly NATIVE_PILOT_OK. Do not use tools or change any files." Then briefly confirm the submitted job id. Do not wait for the worker or run any other project tasks.');
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      const jobs = Object.values(store.data.jobs);
      if (jobs.length >= 2 && jobs.every(j => !['dispatching', 'running', 'awaiting_approval'].includes(j.status))) break;
      await delay(500);
    }
    const jobs = Object.values(store.data.jobs);
    evidence.coordinatorDynamicDispatch = jobs.some(j => j.projectId === 'pilot');
    evidence.workerFinalReceived = messages.some(m => m.includes('NATIVE_PILOT_OK') && m.startsWith('Telegram pilot'));
    evidence.jobStatuses = jobs.map(j => ({ project: j.project, status: j.status }));
    evidence.threadIds = jobs.map(j => j.threadId);
    if (!evidence.coordinatorDynamicDispatch || !evidence.workerFinalReceived || jobs.some(j => j.status !== 'completed'))
      throw new Error('Native inference pilot did not complete all expected stages.');
  }
  evidence.ok = true;
  writeFileSync(join(local, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} catch (e) {
  evidence.ok = false;
  evidence.error = String(e.message).slice(0, 1500);
  writeFileSync(join(local, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  process.exitCode = 1;
} finally { assistant?.close(); rpc.close(); }
