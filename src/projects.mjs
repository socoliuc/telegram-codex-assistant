import { readFileSync, realpathSync, existsSync, statSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { isWithinRoots, pathKey } from './core.mjs';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

export function projectForChat(projects, cwd, reportedProjectId) {
  const reported = reportedProjectId && projects.find(project => project.id === reportedProjectId);
  if (reported || !cwd) return reported || undefined;
  let best, length = -1;
  for (const project of projects) for (const root of project.roots) {
    if (!isWithinRoots(cwd, [root])) continue;
    const size = resolve(root).length;
    if (size > length) { best = project; length = size; }
    else if (size === length && best?.id !== project.id) best = undefined;
  }
  return best;
}

export function discoverProjects(codexHome = process.env.CODEX_HOME || join(homedir(), '.codex'), options = {}) {
  const file = join(codexHome, '.codex-global-state.json');
  const data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  const projects = Object.values(data['local-projects'] || {})
    .filter(p => p.id && p.name && !p.id.startsWith('g-p-') && p.rootPaths?.length &&
      p.rootPaths.every(root => { try { return statSync(root).isDirectory(); } catch { return false; } }))
    .map(p => ({ id: p.id, name: p.name, roots: p.rootPaths.map(root => realpathSync(root)) }));
  for (const entry of options.projects || []) {
    if (!entry || typeof entry.name !== 'string' || !entry.name.trim() ||
        typeof entry.root !== 'string' || !isAbsolute(entry.root)) continue;
    try { if (!statSync(entry.root).isDirectory()) continue; } catch { continue; }
    const root = realpathSync(entry.root);
    const sameRoot = projects.find(project => project.roots.some(existing => pathKey(existing) === pathKey(root)));
    if (sameRoot) continue;
    const id = 'local-' + createHash('sha256').update(root).digest('hex').slice(0, 16);
    projects.push({ id, name: entry.name.trim(), roots: [root] });
  }
  if (options.executionAccess === 'desktop-full-access' && options.assistantRoot && existsSync(options.assistantRoot)) {
    const root = realpathSync(options.assistantRoot);
    if (!projects.some(p => p.roots.some(r => pathKey(r) === pathKey(root))))
      projects.push({ id: 'telegram-codex-assistant-local', name: 'Telegram Codex Assistant', roots: [root] });
  }
  return projects;
}
