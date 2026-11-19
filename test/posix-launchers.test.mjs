import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const isPosix = process.platform !== 'win32';

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'telegram posix launcher-')));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'src'));
  const nodePath = process.execPath.replaceAll("'", "'\\''");
  for (const script of ['platform.sh', 'setup.sh', 'start.sh', 'stop.sh']) {
    writeFileSync(join(root, 'scripts', script), readFileSync(new URL('../scripts/' + script, import.meta.url)));
  }
  for (const script of ['setup.sh', 'start.sh', 'stop.sh']) chmodSync(join(root, 'scripts', script), 0o700);
  const fakeNode = join(root, 'node');
  const lines = [
    '#!/bin/sh',
    'if [ "${1-}" = --version ]; then printf "%s\\n" v24.1.0; exit 0; fi',
    'if [ "${1-}" = "' + root + '/src/setup.mjs" ]; then printf "%s\\n" setup-ran > "' + root + '/setup-marker"; exit 0; fi',
    'if [ "${1-}" = "' + root + '/src/main.mjs" ]; then exec ' + nodePath + ' "' + root + '/listener.mjs"; fi',
    'exec ' + nodePath + ' "$@"',
    ''
  ];
  writeFileSync(fakeNode, lines.join('\n'));
  chmodSync(fakeNode, 0o700);
  writeFileSync(join(root, 'listener.mjs'), [
    "import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';",
    "import { randomUUID } from 'node:crypto';",
    'const local = ' + JSON.stringify(root + '/.local') + ';',
    'const nonce = randomUUID();',
    "writeFileSync(local + '/instance.json', JSON.stringify({ pid: process.pid, nonce }), { mode: 0o600 });",
    "const timer = setInterval(() => {",
    "  if (!existsSync(local + '/stop.json')) return;",
    "  try { if (JSON.parse(readFileSync(local + '/stop.json', 'utf8')).nonce === nonce) { clearInterval(timer); unlinkSync(local + '/instance.json'); process.exit(0); } } catch {}",
    '}, 30);',
    ''
  ].join('\n'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('POSIX setup delegates to the local setup entry point', { skip: !isPosix }, () => {
  const f = fixture();
  try {
    const result = spawnSync('sh', [join(f.root, 'scripts', 'setup.sh')], { env: { ...process.env, PATH: f.root + ':' + process.env.PATH }, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(f.root, 'setup-marker'), 'utf8').trim(), 'setup-ran');
  } finally { f.cleanup(); }
});

test('POSIX start and stop use the application nonce-bound graceful stop request', { skip: !isPosix }, () => {
  const f = fixture();
  try {
    mkdirSync(join(f.root, '.local'));
    writeFileSync(join(f.root, '.local', 'config.json'), '{}');
    const env = { ...process.env, PATH: f.root + ':' + process.env.PATH };
    const started = spawnSync('sh', [join(f.root, 'scripts', 'start.sh')], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(started.status, 0, started.stderr);
    const lock = join(f.root, '.local', 'instance.json');
    const deadline = Date.now() + 5000;
    while (!existsSync(lock) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    assert.ok(existsSync(lock), 'listener should create its runtime lock');
    const stopped = spawnSync('sh', [join(f.root, 'scripts', 'stop.sh')], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(existsSync(lock), false, 'listener should release its lock after graceful stop');
    assert.ok(existsSync(join(f.root, '.local', 'paused.json')), 'manual stop pauses automatic startup');
  } finally { f.cleanup(); }
});

test('POSIX hook installation preserves other hooks and invokes the local Node handler', { skip: !isPosix }, () => {
  const f = fixture();
  try {
    for (const file of ['lifecycle.mjs', 'presence-provenance.mjs']) {
      writeFileSync(join(f.root, 'src', file), readFileSync(new URL('../src/' + file, import.meta.url)));
    }
    for (const file of ['lifecycle-hook.mjs', 'install-hooks.mjs']) {
      writeFileSync(join(f.root, 'scripts', file), readFileSync(new URL('../scripts/' + file, import.meta.url)));
    }
    const codexHome = join(f.root, 'codex-home');
    mkdirSync(codexHome);
    const hooksPath = join(codexHome, 'hooks.json');
    writeFileSync(hooksPath, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'keep-this-hook' }] }] } }));
    const env = { ...process.env, CODEX_HOME: codexHome };
    const installed = spawnSync(process.execPath, [join(f.root, 'scripts', 'install-hooks.mjs')], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(installed.status, 0, installed.stderr);
    const config = JSON.parse(readFileSync(hooksPath, 'utf8'));
    const commands = Object.values(config.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command)));
    assert.ok(commands.includes('keep-this-hook'));
    assert.ok(commands.some(command => command.includes(join(f.root, 'scripts', 'lifecycle-hook.mjs'))));
    const removed = spawnSync(process.execPath, [join(f.root, 'scripts', 'install-hooks.mjs'), '--remove'], { env, encoding: 'utf8', timeout: 10000 });
    assert.equal(removed.status, 0, removed.stderr);
    assert.deepEqual(JSON.parse(readFileSync(hooksPath, 'utf8')), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'keep-this-hook' }] }] } });
  } finally { f.cleanup(); }
});
