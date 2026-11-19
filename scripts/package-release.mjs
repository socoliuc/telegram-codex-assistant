import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import manifest from '../package.json' with { type: 'json' };

// Read only committed blobs, including executable bits. Runtime state lives outside this list.
const [platform, destination] = process.argv.slice(2);
if (!['windows', 'macos', 'linux'].includes(platform) || !destination) {
  throw new Error('Usage: node scripts/package-release.mjs <windows|macos|linux> <output-directory>');
}

const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const tracked = git(['ls-tree', '-rz', '--name-only', 'HEAD']).split('\0').filter(Boolean);
const launcherExtension = { windows: '.cmd', macos: '.command', linux: '.sh' }[platform];
const files = tracked.filter(path => {
  if (['LICENSE', 'README.md', 'package.json', '.gitignore'].includes(path)) return true;
  if (/^(src|workspace|docs|test)\//.test(path)) return true;
  if (path.startsWith('scripts/')) {
    if (path.endsWith('.mjs')) return path !== 'scripts/package-release.mjs';
    if (platform === 'windows') return /\.(ps1|pyw|vbs)$/.test(path);
    return path.endsWith('.sh');
  }
  return !path.includes('/') && path.endsWith(launcherExtension);
});

const prefix = manifest.name + '-' + manifest.version;
const format = platform === 'windows' ? 'zip' : 'tar.gz';
const output = join(resolve(destination), prefix + '-' + platform + '.' + format);
mkdirSync(resolve(destination), { recursive: true });
git(['archive', '--format=' + format, '--prefix=' + prefix + '/', '-o', output, 'HEAD', '--', ...files]);
console.log(output);
