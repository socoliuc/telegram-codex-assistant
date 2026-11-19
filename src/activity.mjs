export const IDLE_MS = 30 * 60_000;
const modes = ['auto', 'always', 'paused'];

// Presence uses submitted-message timestamps only, never keyboard contents.
// Keep the last timestamp durable even after lifecycle files are pruned.
export class ActivityGate {
  constructor(inbox, { loadEvents = () => [], excludeThreadIds = () => [] } = {}) {
    Object.assign(this, { inbox, loadEvents, excludeThreadIds });
    this.data = inbox.data.activity ||= {};
    if (this.data.presenceVersion !== 1) {
      // Old inferred Desktop timestamps may have come from helpers. Preserve
      // enablement/settings, but rebuild presence only from verified messages.
      delete this.data.lastPromptAt;
      this.data.presenceVersion = 1; this.inbox.store.save();
    }
  }
  get mode() { return this.inbox.data.settings.notificationMode || 'always'; }
  refresh() {
    const now = this.inbox.now();
    let latest = this.data.lastPromptAt || 0;
    try {
      const excluded = new Set(this.excludeThreadIds());
      for (const event of this.loadEvents()) {
        if (event.event !== 'UserPromptSubmit' || event.origin !== 'desktop-user' || excluded.has(event.sessionId)) continue;
        const at = Date.parse(event.submittedAt);
        if (Number.isFinite(at) && at > latest && at <= now + 5000) latest = Math.min(at, now);
      }
      if (latest > (this.data.lastPromptAt || 0)) {
        this.data.lastPromptAt = latest; this.inbox.store.save();
      }
    } catch { /* Advisory presence failures must not stop the listener. */ }
  }
  setMode(mode) {
    if (!modes.includes(mode)) return false;
    this.refresh();
    this.inbox.data.settings.notificationMode = mode;
    if (mode === 'auto' && !this.data.enabledAt) this.data.enabledAt = this.inbox.now();
    this.inbox.store.save(); return true;
  }
  status() {
    const mode = this.mode;
    const lastPromptAt = this.data.lastPromptAt || this.data.enabledAt;
    const resumesAt = mode === 'auto' && lastPromptAt ? lastPromptAt + IDLE_MS : null;
    const blocked = mode === 'paused' || (mode === 'auto' && resumesAt > this.inbox.now());
    return { mode, blocked, lastPromptAt: this.data.lastPromptAt || null, resumesAt,
      label: mode === 'paused' ? 'Paused' : mode === 'always' ? 'Always send' : blocked ?
        `Automatic · paused while active in Codex · resumes in ${Math.ceil((resumesAt - this.inbox.now()) / 60_000)}m` :
        'Automatic · sending after 30m without a Codex message' };
  }
  blocks(item) {
    // Explicit conversations with Telegram keep working, including follow-up
    // questions on work the owner requested there.
    if (item.source !== 'desktop' || item.route?.direct) return false;
    return this.status().blocked;
  }
  tooOld(item) {
    if (this.mode !== 'auto' || item.source !== 'desktop' || item.route?.direct) return false;
    // A repeated observation proves the request is still open, not that it is
    // new. Late-discovered results also retain their original completion time.
    const timestamps = [item.createdAt, item.sourceAt].filter(at => Number.isFinite(at) && at > 0);
    return !timestamps.length || this.inbox.now() - Math.min(...timestamps) > IDLE_MS;
  }
}
