import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';

async function waitFor(read, message) {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(message);
}

// The real launcher, OS keyring, local setup server and Codex app-server run in
// a disposable installation. Only Telegram's HTTP responses are simulated.
test('pair from the packaged setup page and open Home', {
  skip: process.env.TEST_PACKAGED_PAIRING !== '1', timeout: 100_000
}, async () => {
  const temp = mkdtempSync(join(tmpdir(), 'tg-package-'));
  const root = join(temp, 'installation with spaces');
  mkdirSync(root);
  for (const item of ['src', 'scripts', 'workspace', 'package.json']) cpSync(resolve(item), join(root, item), { recursive: true });
  const launcher = process.platform === 'darwin' ? 'Setup.command' : 'setup.sh';
  cpSync(resolve(launcher), join(root, launcher));
  const local = join(root, '.local');
  const project = join(temp, 'Atlas');
  mkdirSync(project);
  const token = '987654:' + randomBytes(24).toString('hex');
  const mock = join(temp, 'telegram-fixture.mjs');
  writeFileSync(mock, `
    import { existsSync, readFileSync, appendFileSync } from 'node:fs';
    import { join } from 'node:path';
    import { setTimeout as delay } from 'node:timers/promises';
    const base = process.env.TEST_INSTALLATION;
    const pairing = join(base, '.local', 'pairing.json');
    const message = (id, text) => ({ update_id: id, message: {
      message_id: id, text, from: {id: 17}, chat: {id: 17, type: 'private'}
    }});
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (new URL(url).hostname !== 'api.telegram.org') return realFetch(url, options);
      const method = new URL(url).pathname.split('/').pop();
      const payload = JSON.parse(options.body);
      let result = true;
      if (method === 'getMe') result = { id: 45, is_bot: true, username: 'fixture_bot' };
      if (method === 'getWebhookInfo') result = { url: '' };
      if (method === 'getUpdates') {
        await delay(100);
        result = !payload.offset && existsSync(pairing)
          ? [message(1, '/start ' + JSON.parse(readFileSync(pairing)).code), message(2, '/menu')] : [];
      }
      if (method === 'sendMessage') {
        appendFileSync(join(base, 'delivery.jsonl'), JSON.stringify(payload) + '\\n');
        result = {message_id: 301};
      }
      return Response.json({ ok: true, result });
    };
  `);
  const codexHome = join(temp, 'codex-home');
  mkdirSync(codexHome);
  const env = { ...process.env, CODEX_HOME: codexHome, TEST_INSTALLATION: root,
    NODE_OPTIONS: '--import=' + pathToFileURL(mock).href };
  const setup = spawn(join(root, launcher), [], { cwd: root, env, stdio: 'ignore' });
  const closed = once(setup, 'close');
  try {
    const urlFile = join(local, 'setup-url.txt');
    const url = await waitFor(() => existsSync(urlFile) && readFileSync(urlFile, 'utf8'), 'Setup did not publish its local URL.');
    assert.equal((await fetch(url)).status, 200);
    const post = await fetch(url + '/connect', { method: 'POST', headers: { Origin: new URL(url).origin },
      body: new URLSearchParams({ username: 'fixture_bot', token, projects: 'Atlas | ' + project }) });
    assert.equal(post.status, 200, 'The packaged setup could not connect the fixture bot.');
    await waitFor(() => {
      const log = join(root, 'delivery.jsonl');
      if (!existsSync(log)) return false;
      return readFileSync(log, 'utf8').trim().split('\n').some(line => {
        const panel = JSON.parse(line);
        return panel.chat_id === 17 && /Auto/i.test(panel.text) && panel.reply_markup?.inline_keyboard?.length;
      });
    }, 'The paired owner did not receive the Auto Home panel.');
    assert.equal(JSON.parse(readFileSync(join(local, 'state.json'))).owner.userId, 17);
    assert.equal(JSON.parse(readFileSync(join(local, 'health.json'))).projectCount, 1);
    assert.ok(!readFileSync(join(local, 'config.json'), 'utf8').includes(token));
  } finally {
    try {
      if (existsSync(join(local, 'instance.json'))) {
        const stop = spawnSync('sh', [join(root, 'scripts', 'stop.sh')], { env, timeout: 40_000 });
        assert.equal(stop.status, 0, 'Listener failed to stop.');
        // The launcher waits for the lock to disappear. The listener writes
        // its final health status immediately afterward.
        await waitFor(() => {
          try { return JSON.parse(readFileSync(join(local, 'health.json'), 'utf8')).status === 'stopped'; }
          catch { return false; }
        }, 'Listener did not publish its stopped status.');
      }
    } finally {
      setup.kill();
      await closed;
      rmSync(temp, { recursive: true, force: true });
    }
  }
});
