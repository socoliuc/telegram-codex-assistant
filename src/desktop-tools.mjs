import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { RpcClient } from './rpc.mjs';
import { redact } from './core.mjs';

const validPipe = path => typeof path === 'string' && path.length < 1024 &&
  (process.platform === 'win32' ? path.startsWith('\\\\.\\pipe\\') : isAbsolute(path));
function discoverServer() {
  const root = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'plugins', 'cache', 'openai-bundled', 'codex-app-tools');
  const versions = readdirSync(root).sort((a,b) => b.localeCompare(a, undefined, { numeric: true }));
  const file = versions.map(v => join(root,v,'server.mjs')).find(existsSync);
  if (!file) throw new Error('The bundled Codex app-tools adapter is unavailable.');
  return file;
}
class McpClient extends RpcClient {
  write(message) { super.write({ jsonrpc: '2.0', ...message }); }
  async initialize() {
    await this.call('initialize', { protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'telegram_desktop_notifications', version: '0.1.0' } });
    this.write({ method: 'notifications/initialized', params: {} });
    const page = await this.call('tools/list');
    for (const name of ['list_threads','read_thread','wait_threads','send_message_to_thread'])
      if (!page.tools.some(t => t.name === name)) throw new Error('Required desktop app tool is unavailable.');
  }
}
export class DesktopTools {
  constructor({ nodeBin = process.execPath, hostFile, callerThreadId, serverPath }) {
    Object.assign(this, { nodeBin, hostFile, callerThreadId, serverPath });
  }
  pipePath() {
    try { const data = JSON.parse(readFileSync(this.hostFile,'utf8')); if (validPipe(data.pipe)) return data.pipe; } catch {}
    if (validPipe(process.env.CODEX_APP_TOOLS_PIPE_PATH)) return process.env.CODEX_APP_TOOLS_PIPE_PATH;
    throw new Error('Waiting for the Codex desktop app connection.');
  }
  async connect() {
    const pipe = this.pipePath();
    if (this.connecting) return this.connecting;
    if (this.rpc && !this.rpc.closed && this.pipe === pipe) return this.rpc;
    this.connecting = (async () => {
      this.rpc?.close(); this.pipe = pipe;
      const rpc = new McpClient({ command: this.nodeBin, args: [this.serverPath || discoverServer()],
        env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipe } });
      this.rpc = rpc;
      try { await rpc.initialize(); return rpc; } catch(error) { rpc.close(); throw error; }
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async call(name, args) {
    if (!['list_threads','read_thread','wait_threads','send_message_to_thread'].includes(name)) throw new Error('Unsupported desktop action.');
    const rpc = await this.connect();
    const caller = this.callerThreadId();
    if (!caller) throw new Error('The paired assistant conversation is not ready.');
    const result = await rpc.call('tools/call', { name, arguments: args, _meta: { threadId: caller } }, 60_000);
    const text = (result.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result.isError) throw new Error(redact(text || 'Desktop action could not complete.'));
    try { return JSON.parse(text); } catch { return { status: 'accepted', text }; }
  }
  async list() {
    const page = await this.call('list_threads', { limit: 20 });
    if (!Array.isArray(page.threads) || !Array.isArray(page.pinnedThreads)) throw new Error('Invalid desktop thread catalog.');
    return [...new Map([...page.pinnedThreads, ...page.threads].filter(t => t.kind === 'codex' && (!t.hostId || t.hostId === 'local')).map(t => [t.id, t])).values()]
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 20);
  }
  async poll(targets) {
    const result = { polls: [], errors: [] };
    let pending = [...targets];
    while (pending.length) {
      const batch = pending.slice(0, 8);
      const page = await this.call('wait_threads', { targets: batch, timeoutMs: 0 });
      if (!Array.isArray(page.polls)) throw new Error('Invalid desktop status snapshot.');
      result.polls.push(...page.polls); result.errors.push(...(page.errors || []));
      // A ready/finished chat can wake wait_threads before the other requested
      // snapshots are returned. Continue only with targets not yet covered.
      const received = new Set([...page.polls.map(p => p.thread?.id), ...(page.errors || []).map(e => e.threadId || e.target?.threadId)]);
      if (!batch.some(t => received.has(t.threadId))) {
        for (const target of batch) { received.add(target.threadId); result.errors.push({ threadId: target.threadId, error: 'Status snapshot unavailable.' }); }
      }
      pending = pending.filter(t => !received.has(t.threadId));
    }
    return result;
  }
  async read(threadId, hostId = 'local', { turnLimit: requestedTurns = 10 } = {}) {
    if (!Number.isInteger(requestedTurns) || requestedTurns < 1 || requestedTurns > 10) throw new Error('Invalid desktop turn limit.');
    const args = { threadId, hostId, includeOutputs: false, maxOutputCharsPerItem: 8000 };
    for (const turnLimit of [requestedTurns, ...[2, 1].filter(n => n < requestedTurns)]) {
      try { return await this.call('read_thread', { ...args, turnLimit }); }
      catch (error) {
        // Keep the preceding result when possible so a later Codex reply can
        // clear its notification. Only an explicit size failure permits these
        // bounded read retries; writes and unknown outcomes are never replayed.
        if (turnLimit === 1 || !/Thread history exceeds the read size limit/i.test(error.message)) throw error;
      }
    }
  }
  send(threadId, prompt, hostId = 'local') { return this.call('send_message_to_thread', { threadId, hostId, prompt }); }
  close() { this.rpc?.close(); }
}
