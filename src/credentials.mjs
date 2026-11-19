import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync, mkdirSync, linkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const service = 'org.telegram-codex-assistant';
const installRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const localDirectory = join(installRoot, '.local');
const messageKeyReference = join(localDirectory, 'message-encryption-key.ref');

function run(command, args, input) {
  const result = spawnSync(command, args, {
    input, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 128_000
  });
  if (result.error || result.status !== 0) {
    const error = new Error('The operating system credential store is unavailable or locked.');
    error.status = result.status;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout.trim();
}

function dpapi(mode, input) {
  const script = fileURLToPath(new URL('../scripts/credential.ps1', import.meta.url));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (['psmodulepath', 'psexecutionpolicypreference'].includes(key.toLowerCase())) delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Mode', mode], {
    env, input, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 128_000
  });
  if (result.status !== 0 || !result.stdout.trim()) throw new Error('Windows credential protection failed.');
  return result.stdout.trim();
}

function accountFor(file) {
  return createHash('sha256').update(file).digest('hex');
}

function keychainGet(account) {
  if (process.platform === 'darwin')
    return run('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w']);
  if (process.platform === 'linux')
    return run('secret-tool', ['lookup', 'service', service, 'account', account]);
  throw new Error('Secure credentials require Windows, macOS Keychain, or Linux Secret Service.');
}

function keychainSet(account, secret) {
  if (process.platform === 'darwin') {
    if (!/^[A-Za-z0-9:_-]+$/.test(secret)) throw new Error('The macOS credential contains unsupported characters.');
    // Interactive mode reads the command from stdin and exits on EOF.
    const command = `add-generic-password -U -s ${service} -a ${account} -w ${secret}\n`;
    const result = spawnSync('/usr/bin/security', ['-i'], { input: command, encoding: 'utf8', timeout: 15_000, maxBuffer: 128_000 });
    if (result.error || result.status !== 0) {
      const error = new Error('The macOS Keychain is unavailable or locked.');
      error.exitStatus = result.status;
      throw error;
    }
    let saved;
    try { saved = keychainGet(account); }
    catch {
      const error = new Error('The macOS Keychain is unavailable or locked.');
      error.verificationFailed = true;
      throw error;
    }
    if (saved !== secret) {
      const error = new Error('The macOS Keychain is unavailable or locked.');
      error.verificationMismatch = true;
      throw error;
    }
  }
  else if (process.platform === 'linux')
    run('secret-tool', ['store', '--label=Telegram Codex Assistant', 'service', service, 'account', account], secret);
  else throw new Error('Secure credentials require Windows, macOS Keychain, or Linux Secret Service.');
}

function keychainDelete(account) {
  if (process.platform === 'darwin') run('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account]);
  else if (process.platform === 'linux') run('secret-tool', ['clear', 'service', service, 'account', account]);
}

function getKey(create) {
  try {
    const reference = readFileSync(messageKeyReference, 'utf8').trim();
    if (!/^[0-9a-f]{32}$/.test(reference)) throw new Error('The message encryption key reference is invalid.');
    return Buffer.from(keychainGet(`message-encryption-key-${reference}`), 'hex');
  } catch (error) {
    if (error.code !== 'ENOENT' || !create) throw new Error('The message encryption key is missing or unavailable.');
  }

  mkdirSync(localDirectory, { recursive: true, mode: 0o700 });
  const reference = randomBytes(16).toString('hex');
  const key = randomBytes(32);
  const account = `message-encryption-key-${reference}`;
  const temporaryReference = join(localDirectory, `message-key-${reference}.tmp`);
  keychainSet(account, key.toString('hex'));
  try {
    writeFileSync(temporaryReference, reference, { flag: 'wx', mode: 0o600 });
    try {
      // Hard-linking publishes a complete reference atomically without replacing a winner.
      linkSync(temporaryReference, messageKeyReference);
      return key;
    } catch (publishError) {
      if (publishError.code !== 'EEXIST') throw publishError;
      keychainDelete(account);
      const winner = readFileSync(messageKeyReference, 'utf8').trim();
      if (!/^[0-9a-f]{32}$/.test(winner)) throw new Error('The message encryption key reference is invalid.');
      return Buffer.from(keychainGet(`message-encryption-key-${winner}`), 'hex');
    }
  } finally {
    try { unlinkSync(temporaryReference); } catch (cleanupError) { if (cleanupError.code !== 'ENOENT') throw cleanupError; }
  }
}

export function saveToken(file, token) {
  if (process.platform === 'win32') {
    writeFileSync(file, dpapi('Protect', token), { mode: 0o600 });
    return;
  }
  keychainSet(`telegram-token-${accountFor(file)}`, token);
}

export function loadToken(file) {
  if (process.platform === 'win32') return dpapi('Unprotect', readFileSync(file, 'utf8'));
  return keychainGet(`telegram-token-${accountFor(file)}`);
}

export function deleteToken(file) {
  if (process.platform === 'win32') { try { unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; } return; }
  keychainDelete(`telegram-token-${accountFor(file)}`);
}

export function protectMessage(text) {
  if (process.platform === 'win32') return dpapi('Protect', Buffer.from(text, 'utf8').toString('base64'));
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(true), iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function unprotectMessage(ciphertext) {
  if (process.platform === 'win32') return Buffer.from(dpapi('Unprotect', ciphertext), 'base64').toString('utf8');
  const packed = Buffer.from(ciphertext, 'base64');
  if (packed.length < 28) throw new Error('Protected message is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', getKey(false), packed.subarray(0, 12));
  decipher.setAuthTag(packed.subarray(12, 28));
  return Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8');
}
