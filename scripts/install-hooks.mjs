import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mergeActivityHooks } from '../src/lifecycle.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const file = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'hooks.json');
const quoteShell = value => "'" + value.replaceAll("'", "'\\''") + "'";
const command = process.platform === 'win32'
  ? 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + join(root, 'scripts', 'lifecycle-hook.ps1') + '"'
  : quoteShell(process.execPath) + ' ' + quoteShell(join(root, 'scripts', 'lifecycle-hook.mjs'));
const currentText = existsSync(file) ? readFileSync(file, 'utf8').replace(/^\uFEFF/, '') : '{}';
const current = JSON.parse(currentText);
const result = mergeActivityHooks(current, command, process.argv.includes('--remove'));
mkdirSync(join(root, '.local'), { recursive: true, mode: 0o700 });
mkdirSync(dirname(file), { recursive: true });
writeFileSync(join(root, '.local', 'hooks-before-' + Date.now() + '.json'), currentText, { mode: 0o600 });
const temp = file + '.' + randomUUID() + '.tmp';
writeFileSync(temp, JSON.stringify(result, null, 2), { mode: 0o600 });
renameSync(temp, file);
console.log(process.argv.includes('--remove') ? 'Activity hook definitions removed; unrelated hooks preserved.' : 'Activity hook definitions installed. Codex trust review is required before execution.');
