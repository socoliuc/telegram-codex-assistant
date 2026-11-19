import { isWithinRoots, pathKey } from './core.mjs';

export class ContextSync {
  constructor({ rpc, loadProjects, loadEvents = () => [], excludeThreadIds = () => [] }) {
    Object.assign(this, { rpc, loadProjects, loadEvents, excludeThreadIds });
    this.projects = [];
    this.snapshot = { mode: 'saved-history-sync', status: 'stale', projects: [], recent: [], observedAt: null };
  }
  refresh() {
    if (this.inflight) return this.inflight;
    this.inflight = this.update().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  async update() {
    try {
      const projects = this.loadProjects();
      const roots = [...new Set(projects.flatMap(p => p.roots))];
      const allowed = new Set(roots.map(pathKey));
      const excluded = new Set(this.excludeThreadIds());
      const page = roots.length ? await this.rpc.call('thread/list', {
        cwd: roots, limit: 50, sortKey: 'updated_at', useStateDbOnly: true
      }) : { data: [] };
      this.projects = projects;
      const signals = this.loadEvents().flatMap(e => {
        const indexed = page.data.find(t => t.cwd && allowed.has(pathKey(t.cwd)) && (t.sessionId === e.sessionId || t.id === e.sessionId));
        if (excluded.has(e.sessionId) || excluded.has(indexed?.id)) return [];
        const scope = indexed?.cwd || e.cwd;
        if (!isWithinRoots(scope, roots)) return [];
        const project = projects.flatMap(p => p.roots.map(root => ({ project: p.name, root })))
          .filter(p => isWithinRoots(scope, [p.root])).sort((a, b) => b.root.length - a.root.length)[0]?.project;
        return [{ ...e, project: project || 'Codex project' }];
      }).slice(0, 12);
      this.snapshot = {
        mode: signals.length ? 'lifecycle-and-saved-history' : 'saved-history-sync', status: 'fresh', observedAt: new Date().toISOString(),
        note: 'Recent saved chat metadata only. This is not desktop live runtime status. Read the chat for details; inspect actual files before making changes.',
        projects,
        signals,
        signalNote: 'Lifecycle event observations only. Stop is not proof of successful completion; other hooks may continue a turn. No prompts or content are captured.',
        recent: page.data.filter(t => t.cwd && allowed.has(pathKey(t.cwd)) && !excluded.has(t.id)).slice(0, 12)
          .map(t => ({ id: t.id, name: (t.name || '(untitled)').slice(0, 160), cwd: t.cwd, updatedAt: t.updatedAt })),
        moreAvailable: Boolean(page.nextCursor) || page.data.length > 12
      };
    } catch {
      this.snapshot = { ...this.snapshot, status: 'stale', error: 'Could not refresh current Codex context. Do not describe the previous snapshot as current.' };
    }
    return this.snapshot;
  }
}
