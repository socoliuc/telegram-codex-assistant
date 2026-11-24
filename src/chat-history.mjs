// Telegram only returns message IDs as updates arrive. Record IDs and dates
// so clearing never has to guess at the chat's history.
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
    if (this.entries[id]) return false;
    this.entries[id] = { sentAt, ...(message.dice ? { eligibleAt: sentAt + day } : {}) };
    return true;
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
    // Legacy panels, notifications, commands and replies have send times.
    // Route pickers can be registered for housekeeping long after delivery.
    for (const [id, panel] of Object.entries(inbox.panels)) add(id, panel.sentAt, removed(panel.cleanup));
    for (const [id, record] of Object.entries(inbox.housekeeping || {})) {
      const userMessage = record.kind === 'command' || record.kind === 'reply';
      if (userMessage || removed(record.cleanup))
        add(id, userMessage ? record.sentAt : undefined, removed(record.cleanup));
    }
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
    const records = this.inventory();
    const targets = [...new Set(ids)], chatId = this.store.data.owner.chatId;
    let accepted = 0;
    const sendBatch = async ids => {
      const now = this.now();
      const batch = ids.filter(id => this.eligible(records, id, now));
      if (!batch.length) return true;
      try {
        const result = await telegram.call('deleteMessages', {
          chat_id: chatId,
          message_ids: batch.map(Number)
        });
        if (result !== true) return false;
      } catch (error) {
        // Isolate a definite rejection. Stop on a rate limit or an outcome
        // we cannot verify and leave those messages eligible for user retry.
        if (error.telegramReason !== 'message-cannot-delete') return false;
        if (batch.length === 1) return true;
        const middle = Math.floor(batch.length / 2);
        return await sendBatch(batch.slice(0, middle)) && await sendBatch(batch.slice(middle));
      }
      this.markRemoved(batch, records);
      accepted += batch.length;
      return true;
    };
    for (let i = 0; i < targets.length; i += 100) {
      if (!await sendBatch(targets.slice(i, i + 100))) break;
    }
    return { accepted, remaining: ids.length - accepted };
  }
}
