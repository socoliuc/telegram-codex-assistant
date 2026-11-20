// Telegram only returns message IDs as updates arrive. Record IDs and dates
// so a confirmed clear never has to guess at the chat's history.
const lifetime = 48 * 60 * 60_000;
const day = lifetime / 2;
const removed = entry => ['deleted', 'missing'].includes(entry?.status);

export class ChatHistory {
  constructor(store, now) {
    this.store = store;
    this.now = now;
  }
  get entries() { return this.store.data.telegramMessages ||= {}; }
  record(message) {
    const id = message?.message_id;
    if (!Number.isSafeInteger(id) || id <= 0) return;
    const now = this.now();
    if (now - (this.prunedAt || 0) >= 60 * 60_000) {
      for (const [key, value] of Object.entries(this.entries)) {
        if (value.sentAt <= now - lifetime) delete this.entries[key];
      }
      this.prunedAt = now;
    }
    const sentAt = message.date > 0 ? message.date * 1000 : now;
    this.entries[id] ||= { sentAt, ...(message.dice ? { eligibleAt: sentAt + day } : {}) };
  }
  inventory() {
    const records = new Map();
    const inbox = this.store.data.inbox;
    const add = (id, sentAt, wasRemoved) => {
      if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return;
      const entry = records.get(id) || {};
      if (sentAt > 0) entry.sentAt = sentAt;
      if (wasRemoved) entry.removed = true;
      records.set(id, entry);
    };
    // Older installations already know the exact IDs and dates of these
    // messages. Merge them into the inventory without adopting ID ranges.
    for (const [id, panel] of Object.entries(inbox.panels)) add(id, panel.sentAt, removed(panel.cleanup));
    for (const [id, record] of Object.entries(inbox.housekeeping || {})) add(id, record.sentAt, removed(record.cleanup));
    for (const item of Object.values(inbox.items)) {
      for (const [id, copy] of Object.entries(item.notificationMessages || {})) add(id, copy.sentAt, removed(copy));
    }
    for (const [id, record] of Object.entries(this.entries)) {
      add(id, record.sentAt, record.removed);
      if (record.eligibleAt && records.has(id)) records.get(id).eligibleAt = record.eligibleAt;
    }
    return records;
  }
  eligible(records, id, now) {
    const entry = records.get(id);
    return Boolean(entry && !entry.removed && entry.sentAt <= now && entry.sentAt > now - lifetime &&
      (!entry.eligibleAt || entry.eligibleAt < now));
  }
  targets(exclude) {
    const now = this.now(), records = this.inventory();
    return [...records.keys()].filter(id => id !== String(exclude) && this.eligible(records, id, now));
  }
  markRemoved(ids, records) {
    const now = this.now();
    const inbox = this.store.data.inbox;
    const deletion = { status: 'deleted', handledAt: now };
    for (const id of ids) {
      const record = this.entries[id] ||= { sentAt: records.get(id).sentAt };
      record.removed = true;
      const panel = inbox.panels[id];
      if (panel) Object.assign(panel, { dismissedAt: now, expiresAt: 0, cleanup: { ...deletion } });
      const notice = inbox.housekeeping?.[id];
      if (notice) Object.assign(notice, { dismissedAt: now, cleanup: { ...deletion } });
    }
    const cleared = new Set(ids);
    for (const item of Object.values(inbox.items)) {
      for (const [id, copy] of Object.entries(item.notificationMessages || {})) {
        if (cleared.has(id)) Object.assign(copy, deletion);
      }
    }
    this.store.save();
  }
  async clear(ids, telegram) {
    const records = this.inventory(), now = this.now();
    const targets = [...new Set(ids)].filter(id => this.eligible(records, id, now));
    let accepted = 0;
    for (let i = 0; i < targets.length; i += 100) {
      const batch = targets.slice(i, i + 100);
      try {
        const result = await telegram.call('deleteMessages', {
          chat_id: this.store.data.owner.chatId,
          message_ids: batch.map(Number)
        });
        if (result !== true) break;
      } catch {
        // A failed batch may be rate-limited or have an unknown outcome.
        // Keep it available for a new explicit confirmation.
        break;
      }
      this.markRemoved(batch, records);
      accepted += batch.length;
    }
    return { accepted, remaining: ids.length - accepted };
  }
}
