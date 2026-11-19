import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, existsSync, readFileSync, writeFileSync, openSync, closeSync, chmodSync, realpathSync, statSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { saveToken } from './credentials.mjs';
import { Telegram } from './telegram.mjs';
import { requireNativeExecutable } from './executables.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const local = join(root, '.local');
if (process.platform !== 'win32') process.umask(0o077);
mkdirSync(local, { recursive: true });
if (process.platform === 'win32') {
  const acl = spawnSync('icacls.exe', [local, '/inheritance:r', '/grant:r', `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`, 'SYSTEM:(OI)(CI)F'], { windowsHide: true, encoding: 'utf8' });
  if (acl.status !== 0) throw new Error('Could not protect the local credential directory.');
} else chmodSync(local, 0o700);
const nonce = randomBytes(24).toString('hex');
let port, busy = false;
const escape = value => String(value).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]);
function running() {
  try { const lock = JSON.parse(readFileSync(join(local, 'instance.json'), 'utf8')); process.kill(lock.pid, 0); return true; }
  catch { return false; }
}
function page(note = '') {
  let pairing;
  if (existsSync(join(local, 'pairing.json'))) pairing = JSON.parse(readFileSync(join(local, 'pairing.json'), 'utf8'));
  const live = running();
  const paired = existsSync(join(local, 'state.json')) && JSON.parse(readFileSync(join(local, 'state.json'), 'utf8')).owner;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect your Codex assistant</title>
  <style>body{font:17px system-ui;background:#f4f5f7;color:#17212b;max-width:700px;margin:50px auto;padding:24px}main{background:white;padding:32px;border-radius:18px}h1{font-size:30px}p{line-height:1.6}label{display:block;margin:22px 0 6px}input{box-sizing:border-box;width:100%;padding:12px;font:inherit;border:1px solid #b7c1ca;border-radius:7px}button,a.button{display:inline-block;background:#1768b3;color:white;padding:12px 18px;border:0;border-radius:8px;font:inherit;cursor:pointer;text-decoration:none}small{color:#52606d}.note{background:#e8f1fa;padding:16px;border-radius:8px}code{overflow-wrap:anywhere}</style><main>
  <h1>Your Telegram Codex assistant</h1>
  ${note ? `<p class="note">${escape(note)}</p>` : ''}
  ${paired && live ? '<p class="note">Your assistant is running and paired. Open your bot in Telegram and send /menu.</p>' : ''}
  ${live && pairing && !paired ? `<p>The bot is running. Connect your Telegram account:</p><p><a class="button" href="https://t.me/${escape(pairing.username)}?start=${escape(pairing.code)}" rel="noreferrer">Pair with @${escape(pairing.username)}</a></p><p>Open that link in Telegram and press <strong>Start</strong>. This one-time link authorizes your account. Keep it private.</p><p>Then send <code>/menu</code> to open Home. <a href="/${nonce}">Refresh connection status</a></p>` : ''}
  ${!live ? `<p>1. In Telegram, open the verified <a href="https://t.me/BotFather" rel="noreferrer">@BotFather</a>, send <code>/newbot</code> and choose a name and username.</p>
  <p>2. Enter that bot's details below. The token is stored in your operating system's secure credential store. Do not paste it into the Codex chat.</p>
  <form method="post" action="/${nonce}/connect"><label for="username">Bot username</label><input id="username" name="username" placeholder="my_codex_assistant_bot" required autocomplete="off" pattern="@?[A-Za-z0-9_]+">
  <label for="token">Bot token from BotFather</label><input id="token" name="token" type="password" required autocomplete="off" spellcheck="false" maxlength="200">
  <label for="projects">Project folders (optional, one per line as name | absolute folder path)</label><textarea id="projects" name="projects" rows="5" placeholder="Website | /Users/you/Projects/website"></textarea>
  <p><button>Connect this bot</button></p></form>` : ''}
  <p><a href="/${nonce}">Refresh connection status</a></p>
  <p><small>The assistant can read relevant Codex history and open project conversations. Open &amp; reply sends a follow-up to the conversation shown on the card. Your PC must remain awake and online. Only your paired private Telegram account can issue instructions.</small></p></main></html>`;
}
const server = createServer(async (req, res) => {
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" };
  if (req.headers.host !== `127.0.0.1:${port}`) { res.writeHead(403); res.end(); return; }
  if (req.method === 'GET' && req.url === `/${nonce}`) { res.writeHead(200, headers); res.end(page()); return; }
  if (req.method !== 'POST' || req.url !== `/${nonce}/connect` || req.headers.origin !== `http://127.0.0.1:${port}` || busy) {
    res.writeHead(403); res.end(); return;
  }
  busy = true;
  let tg;
  try {
    if (running()) throw new Error('The assistant is already running.');
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2048) throw new Error('Form is too large.'); }
    const values = new URLSearchParams(body);
    const token = values.get('token')?.trim();
    const expected = values.get('username')?.trim().replace(/^@/, '').toLowerCase();
    if (!/^\d{5,}:[A-Za-z0-9_-]{20,}$/.test(token || '')) throw new Error('Enter the bot token from BotFather.');
    tg = new Telegram(token);
    const bot = await tg.call('getMe');
    if (!bot.is_bot || bot.username.toLowerCase() !== expected) throw new Error('The token belongs to a different bot username. Nothing was connected.');
    const webhook = await tg.call('getWebhookInfo');
    if (webhook.url) throw new Error('That bot is already connected through a webhook. Create a separate bot; its current connection was preserved.');
    const previousConfig = existsSync(join(local, 'config.json')) ? JSON.parse(readFileSync(join(local, 'config.json'), 'utf8')) : {};
    if (existsSync(join(local, 'state.json'))) {
      if (previousConfig.botId !== bot.id) throw new Error('This installation is already bound to another bot. Use its original credential.');
    }
    const command = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-Command', '(Get-Command codex.exe -CommandType Application -ErrorAction Stop).Source'], { windowsHide: true, encoding: 'utf8' })
      : spawnSync('/bin/sh', ['-c', 'command -v codex'], { encoding: 'utf8' });
    if (command.status !== 0 || !command.stdout.trim()) throw new Error('Codex CLI was not found.');
    const codexBin = requireNativeExecutable(process.platform === 'win32' ? command.stdout.trim() : realpathSync(command.stdout.trim()));
    const projectsInput = values.get('projects')?.trim();
    const projects = projectsInput ? projectsInput.split(/\r?\n/).map(line => {
      const separator = line.indexOf('|');
      if (separator < 1) throw new Error('Use one project per line in the format name | absolute folder path.');
      const name = line.slice(0, separator).trim();
      const folder = line.slice(separator + 1).trim();
      if (!name || !isAbsolute(folder) || !existsSync(folder) || !statSync(folder).isDirectory())
        throw new Error(`Project ${name || 'folder'} needs an existing absolute directory path.`);
      return { name, root: realpathSync(folder) };
    }) : (previousConfig.projects || []);
    if (new Set(projects.map(project => project.root)).size !== projects.length) throw new Error('Each project folder can appear only once.');
    const tokenFile = join(local, process.platform === 'win32' ? 'telegram-token.dpapi' : 'telegram-token.secure');
    saveToken(tokenFile, token);
    writeFileSync(join(local, 'config.json'), JSON.stringify({ botId: bot.id, botUsername: bot.username, codexBin, nodeBin: process.execPath,
      projects,
      ...(previousConfig.botId === bot.id && previousConfig.executionAccess === 'desktop-full-access' ? { executionAccess: previousConfig.executionAccess } : {}) }, null, 2));
    const log = openSync(join(local, 'runtime.log'), 'a');
    const child = process.platform === 'win32'
      ? spawn(process.execPath, [join(root, 'src', 'main.mjs')], { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] })
      : spawn('sh', [join(root, 'scripts', 'start.sh')], { cwd: root, detached: true, stdio: ['ignore', log, log] });
    child.unref(); closeSync(log);
    for (let i = 0; i < 15 && !existsSync(join(local, 'pairing.json')) && !running(); i++) await delay(500);
    await delay(1000);
    res.writeHead(200, headers); res.end(page(`Verified @${bot.username}. Credential saved locally. Use the pairing link below when it appears; refresh if startup is still in progress.`));
  } catch (e) {
    const message = /token|credential|Telegram/.test(e.message) ? 'Could not verify/connect the bot. Check its token and username locally, then try again.' : e.message;
    res.writeHead(400, headers); res.end(page(message));
  } finally { tg?.close(); busy = false; }
});
server.listen(0, '127.0.0.1', () => {
  port = server.address().port;
  const url = `http://127.0.0.1:${port}/${nonce}`;
  writeFileSync(join(local, 'setup-url.txt'), url, { mode: 0o600 });
  console.log(`Local setup: ${url}`);
});
setTimeout(() => server.close(), 60 * 60_000).unref();
