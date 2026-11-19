import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

const packageVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export class RpcClient extends EventEmitter {
  constructor({ command = 'codex', args = ['app-server', '--stdio'], cwd, env } = {}) {
    super();
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.proc = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '';
    this.proc.stderr.on('data', () => {}); // Native diagnostics may contain private paths/tool output.
    this.proc.stdin.on('error', () => this.finish());
    this.proc.on('error', () => this.finish());
    this.proc.on('close', () => this.finish());
    this.proc.stdout.setEncoding('utf8'); // Streaming decoder retains split multibyte characters.
    this.proc.stdout.on('data', data => {
      buffer += data;
      if (buffer.length > 32 * 1024 * 1024) return this.close();
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { this.close(); return; }
        if (message.method) this.emit(message.id === undefined ? 'notification' : 'request', message);
        else {
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          clearTimeout(pending.timer);
          if (message.error) pending.reject(Object.assign(new Error(`Codex ${pending.method}: ${message.error.message}`), { code: message.error.code }));
          else pending.resolve(message.result);
        }
      }
    });
  }
  write(message) {
    if (this.closed || !this.proc.stdin.writable) throw new Error('Codex connection closed.');
    this.proc.stdin.write(JSON.stringify(message) + '\n');
  }
  call(method, params = {}, timeout = 30_000) {
    if (this.closed) return Promise.reject(new Error('Codex connection closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; outcome may be unknown. Do not replay automatically.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ id, method, params }); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }
  respond(id, result) { this.write({ id, result }); }
  reject(id, message = 'Unsupported request') { this.write({ id, error: { code: -32601, message } }); }
  async initialize() {
    const result = await this.call('initialize', {
      clientInfo: { name: 'telegram_codex_assistant', title: 'Telegram Codex Assistant', version: packageVersion },
      capabilities: { experimentalApi: true }
    });
    this.write({ method: 'initialized', params: {} });
    return result;
  }
  finish() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error(`Codex connection closed during ${p.method}; outcome may be unknown.`)); }
    this.pending.clear();
    this.emit('closed');
  }
  close() { this.finish(); this.proc.kill(); }
}
