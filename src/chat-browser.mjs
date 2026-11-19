import { randomBytes } from 'node:crypto';
import { redact } from './core.mjs';
import { projectForChat } from './projects.mjs';

const control = (text, action) => ({ text, callback_data: 'ctl:' + action });
const navigation = [control('Projects', 'browse'), control('General', 'general'), control('⌂ Home', 'home')];
const pageSize = 6;
const chatDate = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
});

function updatedLabel(value) {
  if (!value) return '';
  const instant = new Date(typeof value === 'number' && value < 1e12 ? value * 1000 : value);
  return Number.isFinite(instant.getTime()) ? chatDate.format(instant) : '';
}

export class ChatBrowser {
  constructor(assistant) { this.a = assistant; }
  get data() { return this.a.store.data; }
  safe(text, limit) {
    const clean = redact(String(text || '').trim(), [this.a.telegram.token]);
    return clean.length > limit ? clean.slice(0, limit - 1).trimEnd() + '…' : clean;
  }
  async panel(text, rows, message, view, options) {
    const nonce = randomBytes(8).toString('hex');
    const actions = options || [];
    const buttons = actions.map(({ label }, index) => [{ text: label, callback_data: `browse:${nonce}:${index}` }]);
    const id = await this.a.controls.panel(text, { inline_keyboard: [...buttons, ...rows] }, message, view);
    if (id) this.menu = { id, view, nonce, actions, expires: Date.now() + 30 * 60_000 };
    return id;
  }
  async projects(message, requestedPage = 0) {
    await this.a.refreshContext();
    const projects = this.a.projects;
    const pages = Math.max(1, Math.ceil(projects.length / pageSize));
    const page = Math.min(requestedPage, pages - 1);
    const actions = projects.slice(page * pageSize, (page + 1) * pageSize)
      .map(project => ({ label: this.safe(project.name, 70), run: msg => this.list(project.id, msg) }));
    if (page) actions.push({ label: '‹ Previous projects', run: msg => this.projects(msg, page - 1) });
    if (page + 1 < pages) actions.push({ label: 'More projects ›', run: msg => this.projects(msg, page + 1) });
    return this.panel(`Projects${pages > 1 ? ` · ${page + 1}/${pages}` : ''}\n\nChoose a project to see its Codex chats.`,
      [navigation.slice(1)], message, 'browse', actions);
  }
  async list(projectId, message, cursor, earlier = []) {
    const project = this.a.projects.find(p => p.id === projectId);
    if (!project) return this.projects(message);
    let page;
    try {
      page = await this.a.rpc.call('thread/list', {
        cwd: project.roots, limit: pageSize, sortKey: 'updated_at', useStateDbOnly: true,
        ...(cursor ? { cursor } : {})
      });
    } catch {
      return this.panel(`${this.safe(project.name, 100)} · Chats\n\nCodex could not load this project’s chats. Try again.`,
        [navigation], message, 'chat-list', [{ label: 'Retry', run: msg => this.list(projectId, msg, cursor, earlier) }]);
    }
    const owned = new Set(this.a.desktop?.excludeThreadIds?.() || []);
    const actions = (page.data || []).filter(thread => thread.id && thread.cwd && !owned.has(thread.id) &&
      projectForChat(this.a.projects, thread.cwd, thread.projectId)?.id === projectId)
      .map(thread => {
        const updated = updatedLabel(thread.updatedAt);
        return { label: this.safe(thread.name || thread.title || thread.preview || 'Untitled chat', updated ? 50 : 72) +
          (updated ? ' · ' + updated : ''), run: msg => this.preview(projectId, thread, msg, cursor, earlier) };
      });
    const hasChats = actions.length > 0;
    if (earlier.length) actions.push({ label: '‹ Newer chats', run: msg => this.list(projectId, msg, earlier.at(-1), earlier.slice(0, -1)) });
    if (page.nextCursor) actions.push({ label: 'Older chats ›', run: msg => this.list(projectId, msg, page.nextCursor, [...earlier, cursor]) });
    actions.push({ label: 'Project Telegram chat', run: msg => this.selectProject(projectId, msg) });
    return this.panel(`${this.safe(project.name, 100)} · Chats\n\n${hasChats ? 'Choose a chat to preview it.' : 'No desktop chats on this page.'}`,
      [navigation], message, 'chat-list', actions);
  }
  selectProject(projectId, message) {
    if (!this.a.projects.some(project => project.id === projectId)) return this.projects(message);
    this.data.selectedProjectId = projectId;
    delete this.data.generalDestination;
    this.a.store.save();
    return this.a.controls.open('home', message);
  }
  async preview(projectId, thread, message, cursor, earlier, active = false) {
    const project = this.a.projects.find(p => p.id === projectId);
    if (!project) return this.projects(message);
    const back = { label: '‹ Chats', run: msg => {
      if (this.data.activeChat) {
        delete this.data.activeChat;
        this.a.store.save();
      }
      return this.list(projectId, msg, cursor, earlier);
    } };
    const title = this.safe(thread.name || thread.title || thread.preview || 'Untitled chat', 100);
    let history;
    try {
      history = await this.a.desktop?.tools.read(thread.id, 'local', { turnLimit: 3 });
      if (history?.thread?.id !== thread.id ||
          projectForChat(this.a.projects, history.thread.cwd, history.thread.projectId)?.id !== projectId ||
          this.a.desktop.excludeThreadIds().includes(thread.id)) throw new Error('Chat unavailable');
    } catch {
      const retry = { label: 'Refresh messages', run: msg => this.preview(projectId, thread, msg, cursor, earlier, active) };
      return this.panel(`${this.safe(project.name, 100)}\n${title}\n\nThis chat could not be opened. Check the desktop connection and try again.`,
        [navigation], message, active ? 'chat-active' : 'chat-preview', [retry, back]);
    }
    const label = this.safe(project.name, 100) + ' · ' + title;
    const excerpts = (history.turns || []).slice(0, 3).reverse().flatMap(({ items = [] }) => {
      const prompt = items.find(item => item.type === 'userMessage')?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n');
      const answer = items.findLast(item => item.type === 'agentMessage' && (!item.phase || item.phase === 'final_answer'))?.text;
      const scheduled = /^(?:Automation(?: ID)?:|<(?:automation_context|heartbeat)(?:\s|>))/.test(prompt?.trim() || '');
      return [scheduled ? 'Scheduled Codex run' : prompt && 'You\n' + this.safe(prompt, 220),
        answer && 'Codex\n' + this.safe(answer, 340)].filter(Boolean);
    });
    const body = excerpts.length ? 'Recent messages\n\n' + excerpts.join('\n\n') : 'This chat has no recent text to preview.';
    const updated = updatedLabel(history.thread.updatedAt || thread.updatedAt);
    const preview = label + (updated ? '\nUpdated ' + updated : '') + '\n\n' + body;
    const refresh = { label: 'Refresh messages', run: msg => this.preview(projectId, thread, msg, cursor, earlier, true) };
    if (active) return this.activePanel(preview, message, [refresh, back]);
    const route = { threadId: thread.id, hostId: 'local', kind: 'chat', projectId, label };
    const enter = { label: 'Message here', run: msg => this.activate(route, preview, msg, [refresh, back]) };
    return this.panel(preview, [navigation], message, 'chat-preview', [enter, back]);
  }
  activePanel(preview, message, actions) {
    return this.panel(preview + '\n\nType a message below. It goes directly to this Codex chat until you leave.',
      [navigation], message, 'chat-active', actions);
  }
  async activate(route, preview, message, actions) {
    const id = await this.activePanel(preview, message, actions);
    if (id) {
      this.a.controls.clearReplyDestination();
      this.data.activeChat = { ...route, panelId: id };
      this.a.store.save();
    }
    return id;
  }
  async choose(q) {
    const match = /^browse:([0-9a-f]{16}):(\d+)$/.exec(String(q.data));
    const menu = this.menu;
    const panel = this.a.controls.inbox.data.panels[String(q.message?.message_id)];
    const action = match && menu?.nonce === match[1] && menu.id === q.message?.message_id &&
      panel?.view === menu.view && !panel.dismissedAt && Date.now() < menu.expires && menu.actions[Number(match[2])];
    if (!action) return this.a.controls.confirm(q, 'This chat menu expired. Open Projects again.');
    this.menu = undefined;
    try { await this.a.telegram.call('answerCallbackQuery', { callback_query_id: q.id }); } catch {}
    return action.run(q.message);
  }
}
