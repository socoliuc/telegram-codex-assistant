import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Telegram } from '../src/telegram.mjs';
import { RpcClient } from '../src/rpc.mjs';

test('Telegram cleanup errors have safe categories and preserve rate-limit delays', async () => {
  let description = '', errorCode = 400;
  const server = createServer((req, res) => {
    res.writeHead(errorCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error_code: errorCode, description: description + ' secret-token', parameters: { retry_after: 120 } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const tg = new Telegram('secret-token', { baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    for (const [text, reason] of [["Bad Request: message can't be deleted", 'message-cannot-delete'],
      ['Bad Request: message to delete not found', 'message-missing'],
      ['Bad Request: message to edit not found', 'message-missing'],
      ['Bad Request: message is not modified', 'message-unchanged'], ['Too Many Requests', undefined]]) {
      description = text; errorCode = reason ? 400 : 429;
      await assert.rejects(tg.call('deleteMessage', { chat_id: 1, message_id: 2 }), e => {
        assert.equal(e.telegramReason, reason); assert.equal(e.retryAfter, 120);
        assert.ok(!JSON.stringify(e).includes('secret-token') && !e.message.includes('secret-token')); return true;
      });
    }
  } finally { tg.close(); server.close(); }
});

test('Telegram image downloads validate streamed bytes, safe paths and image content without leaking tokens', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'tg-images-'));
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x0AAAAASUVORK5CYII=', 'base64');
  let mode = 'ok', calls = 0;
  const server = createServer((req, res) => {
    calls++;
    if (req.url.endsWith('/getFile')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { file_path: mode === 'path' ? '../botsecret-token' : 'photos/image.png', ...(mode === 'metadata' ? { file_size: 999 } : {}) } }));
    } else if (mode === 'redirect') { res.writeHead(302, { Location: '/secret-token' }); res.end(); }
    else if (mode === 'bad') res.end('secret-token is not an image');
    else { res.write(png.subarray(0, 20)); res.end(png.subarray(20)); }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const tg = new Telegram('secret-token', { baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    const file = await tg.downloadImage({ file_id: 'photo' }, folder);
    assert.deepEqual(readFileSync(file), png);
    assert.match(file, /\.png$/);
    for (const value of ['path', 'metadata', 'redirect', 'bad', 'stream']) {
      mode = value;
      await assert.rejects(tg.downloadImage({ file_id: 'photo' }, folder, { maxBytes: value === 'stream' ? 30 : 100 }), e => !e.message.includes('secret-token'));
    }
    const before = calls;
    await assert.rejects(tg.downloadImage({ file_id: 'photo', file_size: 101 }, folder, { maxBytes: 100 }));
    assert.equal(calls, before);
    assert.equal(readdirSync(folder).length, 1);
  } finally { tg.close(); server.close(); rmSync(folder, { recursive: true, force: true }); }
});

test('Telegram suppresses token-bearing upstream errors and does not retry uncertain sends', async () => {
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, description: 'secret-token appears in upstream detail' }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const tg = new Telegram('secret-token', { baseUrl: `http://127.0.0.1:${server.address().port}` });
  try {
    await assert.rejects(tg.call('sendMessage', { chat_id: 1, text: 'hello' }), e =>
      !e.message.includes('secret-token') && e.message.includes('500'));
    assert.equal(calls, 1);
  } finally { server.close(); }
});

test('Telegram confirms each delivered chunk before attempting the next', async () => {
  let calls = 0;
  const replies = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    replies.push(JSON.parse(Buffer.concat(chunks)).reply_parameters);
    calls++;
    res.writeHead(calls === 1 ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(calls === 1 ? { ok: true, result: { message_id: 42 } } : { ok: false, error_code: 500 }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const tg = new Telegram('test', { baseUrl: `http://127.0.0.1:${server.address().port}` });
  const delivered = [];
  try {
    await assert.rejects(tg.send(1, 'x'.repeat(9000), undefined, m => delivered.push(m.message_id), { replyTo: 12 }), /500/);
    assert.deepEqual(delivered, [42]);
    assert.deepEqual(replies, [12, 42].map(message_id => ({ message_id, allow_sending_without_reply: true })));
    assert.equal(calls, 2);
  } finally { server.close(); }
});

test('outgoing photos and albums use multipart bytes, safe captions, silence and reply references', async () => {
  const requests = [], delivered = [];
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const form = await new Request('http://localhost', { method: 'POST', headers: req.headers, body: Buffer.concat(chunks) }).formData();
    requests.push({ method: req.url.split('/').at(-1), form });
    const result = form.has('media') ? [{ message_id: 12 }, { message_id: 13 }] : { message_id: 11 };
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const tg = new Telegram('test-secret', { baseUrl: `http://127.0.0.1:${server.address().port}` });
  const image = { kind: 'photo', extension: 'png', bytes: Buffer.from('image bytes'), filename: 'image-1.png', alt: 'password=exampleValue' };
  try {
    await tg.sendImages(1, [image], 'Project test-secret', 42, m => delivered.push(m.message_id));
    await tg.sendImages(1, [image, { ...image, filename: 'image-2.png' }], 'Project', 42, m => delivered.push(m.message_id));
    assert.deepEqual(requests.map(r => r.method), ['sendPhoto', 'sendMediaGroup']);
    assert.deepEqual(delivered, [11, 12, 13]);
    for (const { form } of requests) {
      assert.equal(form.get('chat_id'), '1'); assert.equal(form.get('disable_notification'), 'true');
      assert.deepEqual(JSON.parse(form.get('reply_parameters')), { message_id: 42, allow_sending_without_reply: true });
      assert.ok(!form.has('reply_markup')); // Native controls remain on the text message.
    }
    assert.equal(requests[0].form.get('photo').name, 'image-1.png');
    assert.equal(await requests[0].form.get('photo').text(), 'image bytes');
    assert.doesNotMatch(requests[0].form.get('caption'), /test-secret|exampleValue/);
    assert.deepEqual(JSON.parse(requests[1].form.get('media')).map(m => [m.type, m.media]), [['photo', 'attach://image0'], ['photo', 'attach://image1']]);
  } finally { tg.close(); server.close(); }
});

test('mixed image/file sends preserve confirmed routes and never retry an uncertain later upload', async () => {
  let calls = 0; const delivered = [];
  const server = createServer((req, res) => {
    calls++;
    if (calls === 2) { req.socket.destroy(); return; }
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, result: { message_id: 21 } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const tg = new Telegram('test-secret', { baseUrl: `http://127.0.0.1:${server.address().port}` });
  const image = { kind: 'photo', extension: 'png', bytes: Buffer.from('image bytes'), filename: 'image-1.png', alt: 'Image' };
  try {
    await assert.rejects(tg.sendImages(1, [image, { ...image, kind: 'document', extension: 'webp' }], 'Project', 42,
      m => delivered.push(m.message_id)), /outcome may be unknown/);
    assert.deepEqual(delivered, [21]); assert.equal(calls, 2);
  } finally { tg.close(); server.close(); }
});

test('RPC handles split lines, out-of-order replies, and server-initiated requests', async () => {
  const code = `let b=''; process.stdin.on('data',d=>{b+=d;let n;while((n=b.indexOf('\\n'))>=0){const m=JSON.parse(b.slice(0,n));b=b.slice(n+1);if(m.method==='first'){process.stdout.write(JSON.stringify({id:90,method:'ask',params:{value:7}})+'\\n');setTimeout(()=>{const s=JSON.stringify({id:m.id,result:{value:1}})+'\\n';process.stdout.write(s.slice(0,8));setTimeout(()=>process.stdout.write(s.slice(8)),10);},30);}else if(m.method==='second')process.stdout.write(JSON.stringify({id:m.id,result:{value:2}})+'\\n');else if(m.id===90)process.stdout.write(JSON.stringify({method:'answered',params:m.result})+'\\n');}});`;
  const rpc = new RpcClient({ command: process.execPath, args: ['-e', code] });
  rpc.on('request', m => rpc.respond(m.id, { value: m.params.value + 1 }));
  const event = once(rpc, 'notification');
  try {
    assert.deepEqual(await Promise.all([rpc.call('first'), rpc.call('second')]), [{ value: 1 }, { value: 2 }]);
    assert.deepEqual((await event)[0], { method: 'answered', params: { value: 8 } });
  } finally { rpc.close(); }
});

test('RPC disconnect rejects outstanding calls without replaying them', async () => {
  const rpc = new RpcClient({ command: process.execPath, args: ['-e', "process.stdin.once('data',()=>process.exit(0))"] });
  await assert.rejects(rpc.call('turn/start'), /closed/i);
});

test('RPC preserves Romanian text and emoji split across native UTF-8 pipe chunks', async () => {
  const code = `process.stdin.once('data',d=>{const m=JSON.parse(d);const raw=Buffer.from(JSON.stringify({id:m.id,result:{text:'Bună 🙂'}})+'\\n');const cut=raw.indexOf(Buffer.from('ă'))+1;process.stdout.write(raw.subarray(0,cut));setTimeout(()=>process.stdout.write(raw.subarray(cut)),60);});`;
  const rpc = new RpcClient({ command: process.execPath, args: ['-e', code] });
  try { assert.deepEqual(await rpc.call('read'), { text: 'Bună 🙂' }); }
  finally { rpc.close(); }
});
