import { createHash } from 'node:crypto';
import { redact } from './core.mjs';
import { reconcileSavedChoices } from './choices.mjs';

export const needsAttention = item => ['input', 'approval', 'failure'].includes(item.kind);
export const isOpen = item => !['resolved', 'reviewed'].includes(item.status);
// A confirmed answer no longer needs attention in Telegram. The source can
// remain open until Codex itself reports resolution. A reply is not approval.
export const isVisible = item => isOpen(item) && !(item.kind !== 'approval' && item.replySentAt);
export const short = (text, limit = 140) => String(text || '').length > limit ? String(text).slice(0, limit - 1) + '…' : String(text || '');

// Persistent event inventory. Delivery, answering, snoozing and resolution are
// separate facts; neither a Telegram API acknowledgement nor opening a menu
// proves that a native request was answered.
export class Inbox {
  constructor(store, { now = () => Date.now(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone } = {}) {
    this.store = store; this.now = now;
    store.data.inbox ||= { version: 1, items: {}, panels: {}, settings: {
      routine: 'immediate', quiet: false, urgentDuringQuiet: true,
      detail: 'brief', mutedProjects: [], timeZone
    } };
    if (store.data.inbox.version !== 1) throw new Error('Unsupported inbox state; refusing to reset it.');
    this.data = store.data.inbox;
  }
  observe(key, values) {
    const id = createHash('sha256').update(key).digest('hex').slice(0, 20);
    let item = this.data.items[id];
    if (!item) {
      item = this.data.items[id] = { id, key, createdAt: this.now(), status: 'open', delivery: 'pending',
        ...values, text: redact(values.text), label: redact(values.label),
        ...(values.route ? { route: { ...values.route, label: redact(values.route.label), context: redact(values.route.context), inboxId: id } } : {}) };
    }
    // Choice metadata follows the same immutable source key. Answers and
    // callback claims are separate; refreshing a scan must never erase them.
    if (values.choiceQuestions) {
      item.choiceQuestions = values.choiceQuestions;
      reconcileSavedChoices(item, values.choiceQuestions);
      item.text = redact(values.text);
    }
    if (values.answeredQuestionIndexes) item.answeredQuestionIndexes = values.answeredQuestionIndexes;
    if (values.imageRoots?.length) item.imageRoots = values.imageRoots;
    if (typeof values.imageSource === 'string') item.imageSource = redact(values.imageSource);
    if (Number.isFinite(values.sourceAt) && values.sourceAt > 0)
      item.sourceAt = Math.min(Number.isFinite(item.sourceAt) && item.sourceAt > 0 ? item.sourceAt : Infinity, values.sourceAt);
    item.observedAt = this.now();
    this.store.save();
    return item;
  }
  get(id) { return this.data.items[id]; }
  list(view = 'attention') {
    const now = this.now();
    return Object.values(this.data.items).filter(item => isVisible(item) &&
      (view === 'updates' ? !needsAttention(item) : needsAttention(item)) &&
      (view === 'snoozed' ? item.snoozedUntil > now : view === 'updates' || !(item.snoozedUntil > now)))
      .sort((a, b) => b.createdAt - a.createdAt);
  }
  resolve(item, reason) {
    if (!isOpen(item)) return;
    item.status = 'resolved'; item.resolvedAt = this.now(); item.resolution = reason;
    delete item.snoozedUntil; this.store.save();
  }
  reconcileDesktop(threadId, seen, turns) {
    const known = new Set(turns.map(t => t.id));
    for (const item of Object.values(this.data.items)) {
      if (item.source !== 'desktop' || item.route?.threadId !== threadId ||
          !['input', 'approval'].includes(item.kind) || !isOpen(item)) continue;
      if (known.has(item.route.turnId) && !seen.has(item.id))
        this.resolve(item, 'The latest Codex state no longer shows this request as pending.');
    }
  }
  resolveBridge(key, reason, questionId) {
    for (const item of Object.values(this.data.items)) if (item.source === 'bridge' &&
      item.questionKey === key && (!questionId || item.questionId === questionId)) this.resolve(item, reason);
  }
  recoverBridge() {
    for (const item of Object.values(this.data.items)) if (item.source === 'bridge' && item.questionKey && isOpen(item))
      this.resolve(item, 'This native request expired when the listener restarted. Check the task before continuing.');
    let changed = false;
    for (const item of Object.values(this.data.items)) if (item.mediaDelivery?.status === 'sending') {
      item.mediaDelivery.status = 'unknown'; changed = true;
    }
    if (changed) this.store.save();
  }
  quietNow() {
    if (!this.data.settings.quiet) return false;
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: this.data.settings.timeZone, hour: '2-digit', hourCycle: 'h23' }).format(this.now()));
    return hour >= 23 || hour < 8;
  }
  policy(item) {
    const settings = this.data.settings;
    if (needsAttention(item)) return this.quietNow() && !settings.urgentDuringQuiet ? 'silent' : 'immediate';
    // Responses to work requested through Telegram stay immediate. Preferences
    // govern proactive desktop updates, not replies to the owner's own prompts.
    if (item.source !== 'desktop' || item.route?.direct) return 'immediate';
    if (settings.mutedProjects.includes(item.route?.projectId || 'general') || settings.routine === 'inbox') return 'inbox';
    if (settings.routine === 'digest' || this.quietNow()) return 'digest';
    return settings.routine;
  }
  snooze(id) {
    const item = this.get(id);
    if (!item || !isVisible(item) || !needsAttention(item) || item.source !== 'desktop') return false;
    item.snoozedUntil = this.now() + 60 * 60_000;
    item.reminder = 'pending'; this.store.save(); return true;
  }
  review(id, { removeNotification = false } = {}) {
    const item = this.get(id);
    if (!item || ['input', 'approval'].includes(item.kind)) return false;
    item.status = 'reviewed'; item.reviewedAt = this.now(); delete item.snoozedUntil;
    if (removeNotification) item.removeReviewedNotification = true;
    this.store.save(); return true;
  }
}
