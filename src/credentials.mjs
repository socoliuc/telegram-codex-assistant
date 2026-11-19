import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const service = 'org.telegram-codex-assistant';

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
    return macKeychain('get', account);
  if (process.platform === 'linux')
    return run('secret-tool', ['lookup', 'service', service, 'account', account]);
  throw new Error('Secure credentials require Windows, macOS Keychain, or Linux Secret Service.');
}

function keychainSet(account, secret, replace = true) {
  if (process.platform === 'darwin')
    macKeychain(replace ? 'set' : 'add', account, secret);
  else if (process.platform === 'linux')
    run('secret-tool', ['store', '--label=Telegram Codex Assistant', 'service', service, 'account', account], secret);
  else throw new Error('Secure credentials require Windows, macOS Keychain, or Linux Secret Service.');
}

function keychainDelete(account) {
  if (process.platform === 'darwin') macKeychain('delete', account);
  else if (process.platform === 'linux') run('secret-tool', ['clear', 'service', service, 'account', account]);
}

function macKeychain(operation, account, secret = '') {
  const escapedAccount = JSON.stringify(account);
  const script = `ObjC.import('Foundation'); ObjC.import('Security');
function run(argv) {
  var query = $.NSMutableDictionary.dictionary;
  query.setObject_forKey($.kSecClassGenericPassword, $.kSecClass);
  query.setObject_forKey($("${service}"), $.kSecAttrService);
  query.setObject_forKey($(${escapedAccount}), $.kSecAttrAccount);
  if (argv[0] === 'delete') { var deleted = Number($.SecItemDelete(query)); if (deleted !== 0 && deleted !== -25300) throw new Error('Keychain delete failed ' + deleted); return ''; }
  if (argv[0] === 'get') {
    query.setObject_forKey(true, $.kSecReturnData);
    query.setObject_forKey($.kSecMatchLimitOne, $.kSecMatchLimit);
    var result = Ref(); var status = $.SecItemCopyMatching(query, result);
    if (status !== 0) throw new Error('Keychain lookup failed ' + status);
    var data = ObjC.unwrap(result[0]);
    var value = ObjC.unwrap($(data).base64EncodedStringWithOptions(0));
    return value;
  }
  var input = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  var value = $.NSString.alloc.initWithDataEncoding(input, $.NSUTF8StringEncoding);
  var data = $(value).dataUsingEncoding($.NSUTF8StringEncoding);
  query.setObject_forKey(data, $.kSecValueData);
  query.setObject_forKey($.kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, $.kSecAttrAccessible);
  var status = Number($.SecItemAdd(query, null));
  if (status === -25299 && argv[0] === 'set') {
    var match = $.NSMutableDictionary.dictionary;
    match.setObject_forKey($.kSecClassGenericPassword, $.kSecClass);
    match.setObject_forKey($("${service}"), $.kSecAttrService);
    match.setObject_forKey($(${escapedAccount}), $.kSecAttrAccount);
    var update = $.NSMutableDictionary.dictionary; update.setObject_forKey(data, $.kSecValueData);
    status = Number($.SecItemUpdate(match, update));
  }
  if (status !== 0) throw new Error('Keychain write failed ' + status);
  return '';
}`;
  const result = spawnSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, operation], {
    input: secret, encoding: 'utf8', windowsHide: true, timeout: 15_000, maxBuffer: 128_000
  });
  if (result.status !== 0) {
    const error = new Error('The macOS Keychain is unavailable or locked.');
    error.stderr = result.stderr;
    throw error;
  }
  if (operation === 'get') return Buffer.from(result.stdout.trim(), 'base64').toString('utf8');
  return '';
}

function getKey(create) {
  const account = `message-encryption-key-${accountFor(fileURLToPath(new URL('../', import.meta.url)))}`;
  try { return Buffer.from(keychainGet(account), 'hex'); }
  catch (error) {
    const missing = process.platform === 'darwin'
      ? /lookup failed -25300/.test(error.stderr || '')
      : process.platform === 'linux' && error.status === 1 && !error.stderr;
    if (!missing || !create) throw new Error('The message encryption key is missing or unavailable.');
    const key = randomBytes(32);
    try { keychainSet(account, key.toString('hex'), false); }
    catch (writeError) {
      if (!/write failed -25299/.test(writeError.stderr || '')) throw writeError;
    }
    return Buffer.from(keychainGet(account), 'hex');
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
