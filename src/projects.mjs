import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { isWithinRoots } from './core.mjs';
import { homedir } from 'node:os';

export function projectForChat(projects, cwd, reportedProjectId) {
  const reported = reportedProjectId && projects.find(project => project.id === reportedProjectId);
  if (reported || !cwd) return reported || undefined;
  let best, length = -1;
  for (const project of projects) for (const root of project.roots) {
    if (!isWithinRoots(cwd, [root])) continue;
    const size = win32.resolve(root).length;
    if (size > length) { best = project; length = size; }
    else if (size === length && best?.id !== project.id) best = undefined;
  }
  return best;
}

export function discoverProjects(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), options = {}) {
  const file = join(codexHome, '.codex-global-state.json');
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const projects = Object.values(data['local-projects'] || {})
    .filter(p => p.id && p.name && !p.id.startsWith('g-p-') && p.rootPaths?.length && p.rootPaths.every(existsSync))
    .map(p => ({ id: p.id, name: p.name, roots: p.rootPaths.map(root => realpathSync(root)) }));
  if (options.executionAccess === 'desktop-full-access' && options.assistantRoot && existsSync(options.assistantRoot)) {
    const root = realpathSync(options.assistantRoot);
    if (!projects.some(p => p.roots.some(r => r.toLowerCase() === root.toLowerCase())))
      projects.push({ id: 'telegram-codex-assistant-local', name: 'Telegram Codex Assistant', roots: [root] });
  }
  return projects;
}
