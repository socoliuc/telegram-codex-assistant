import { cleanupHousekeeping } from './notification-cleanup.mjs';
import { isOwner } from './core.mjs';

// Store message IDs and delivery facts, never the owner's message contents.
// Pending/uncertain replies and immutable notification routes remain protected.
export class Housekeeping {
  constructor(controls) {
    this.c = controls;
    this.records = controls.inbox.data.housekeeping ||= {};
    this.cleaning = new Map();
  }
  protected(id) {
    const { data } = this.c.store;
    return Boolean(data.inbox.panels[id] || data.replies?.[id] || data.desktopReplies?.[id] || data.inputReplies?.[id]);
  }
  record(message, kind = 'help', metadata = {}) {
    const id = String(message?.message_id);
    if (!/^[1-9]\d*$/.test(id) || this.protected(id)) return;
    this.records[id] ||= { kind, sentAt: message.date ? message.date * 1000 : this.c.inbox.now() };
    Object.assign(this.records[id], metadata);
    this.c.store.save();
  }
  trackReply(message, inboxId, autoClear = true) {
    this.record(message, 'reply', { delivery: 'pending', ...(inboxId ? { inboxId } : {}), autoClear });
  }
  submitted(id) {
    const record = this.records[String(id)];
    if (record?.kind !== 'reply') return;
    record.delivery = 'submitted'; this.c.store.save();
  }
  collected(id) {
    const record = this.records[String(id)];
    if (record?.kind !== 'reply') return;
    record.delivery = 'collected'; this.c.store.save();
  }
  endUnsent(id, status) {
    const record = this.records[String(id)];
    if (record?.delivery === 'pending' && ['canceled', 'expired'].includes(status)) {
      record.delivery = status; this.c.store.save();
    }
  }
  ready(record) {
    return record.kind !== 'reply' || ['submitted', 'canceled', 'expired'].includes(record.delivery) ||
      (record.delivery === 'collected' && record.inboxId &&
        this.c.inbox.get(record.inboxId)?.nativeAnswerState === 'submitted');
  }
  notice(text, { clearAfterMs = 0 } = {}) {
    return this.c.a.send(text, undefined, { inline_keyboard: [[{ text: 'Close', callback_data: 'ctl:hide' }]] },
      message => this.record(message, 'help', clearAfterMs ? { clearAfter: this.c.inbox.now() + clearAfterMs } : {}), { silent: true });
  }
  candidates() {
    return Object.entries(this.records).filter(([id, item]) => !item.dismissedAt && !this.protected(id) && this.ready(item)).map(([id]) => id);
  }
  queue(ids) {
    let count = 0;
    for (const id of ids) {
      const item = this.records[id];
      if (!item || item.dismissedAt || this.protected(id) || !this.ready(item)) continue;
      item.dismissedAt = this.c.inbox.now(); item.cleanup = { sentAt: item.sentAt }; count++;
    }
    this.c.store.save(); return count;
  }
  async dismiss(id) {
    id = String(id);
    if (!this.records[id] || this.protected(id) || !this.ready(this.records[id])) return false;
    this.queue([id]); await this.clean(id); return true;
  }
  async dismissMessage(message) {
    const id = String(message?.message_id);
    // An explicit owner reply supplies the real ID of an older, untracked
    // message. Never infer IDs from gaps or adopt forwarded/foreign content.
    if (!this.records[id] && isOwner(message, this.c.store.data.owner))
      this.record(message, 'reply', { delivery: 'submitted', autoClear: false });
    return this.dismiss(id);
  }
  clean(id) {
    if (this.protected(id)) return Promise.resolve(0);
    if (this.cleaning.has(id)) return this.cleaning.get(id);
    const promise = cleanupHousekeeping(this.c, id).finally(() => this.cleaning.delete(id));
    this.cleaning.set(id, promise); return promise;
  }
  async flush(limit = 2) {
    let count = 0;
    for (const [id, item] of Object.entries(this.records)) {
      if (count >= limit) break;
      if (!item.dismissedAt && this.ready(item) &&
          ((item.kind === 'reply' && item.autoClear) || (item.clearAfter && item.clearAfter <= this.c.inbox.now()))) this.queue([id]);
      if (item.dismissedAt) count += await this.clean(id);
    }
    return count;
  }
}
