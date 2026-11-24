// These IDs come only from delivered bot notifications. Retain their source
// routes after removal, so a delayed reply can never fall through to General.
export function notificationIds(controls, item) {
  return [...new Set([...(item.messageIds || []), ...(item.mediaMessageIds || []),
    ...Object.keys(item.notificationMessages || {}),
    ...Object.entries(controls.store.data.desktopReplies || {})
      .filter(([, route]) => route.inboxId === item.id).map(([id]) => id)].map(String))]
    .filter(id => /^[1-9]\d*$/.test(id) && !controls.inbox.data.panels[id]);
}

export async function cleanupNotification(controls, item, limit) {
  item.notificationMessages ||= {};
  return cleanupMessages(controls, item.notificationMessages, notificationIds(controls, item), limit,
    { deleteRequested: item.status === 'reviewed' && item.removeReviewedNotification });
}

export async function cleanupPanel(controls, id) {
  const panel = controls.inbox.data.panels[id];
  if (!panel?.dismissedAt || !/^[1-9]\d*$/.test(String(id))) return 0;
  if (!panel.cleanup) {
    panel.cleanup = { sentAt: panel.sentAt };
    controls.store.save(); // Retain the cleanup job if the listener exits during deletion.
  }
  return cleanupMessages(controls, { [id]: panel.cleanup }, [String(id)], 1);
}

export async function cleanupHousekeeping(controls, id) {
  const record = controls.inbox.data.housekeeping?.[id];
  if (!record?.dismissedAt || !record.cleanup || !/^[1-9]\d*$/.test(String(id))) return 0;
  return cleanupMessages(controls, { [id]: record.cleanup }, [String(id)], 1, { editable: record.kind === 'help' });
}

async function cleanupMessages(controls, messages, ids, limit, { editable = true, deleteRequested = false } = {}) {
  const { inbox, store, a } = controls;
  let count = 0;
  for (const id of ids) {
    const entry = messages[id] ||= {};
    const newlyRequested = deleteRequested && !entry.deleteRequested;
    const closed = ['closed', 'manual'].includes(entry.status);
    if (['deleted', 'missing'].includes(entry.status) || (closed && !newlyRequested) || entry.retryAt > inbox.now()) continue;
    if (count >= limit) break;
    count++;
    if (newlyRequested) {
      entry.deleteRequested = true;
      if (closed) delete entry.status;
    }
    // Old records may lack a delivery timestamp. Ask Telegram once instead of
    // assuming a recently resent copy has the age of its original question.
    const tooOld = entry.sentAt && inbox.now() - entry.sentAt >= 48 * 60 * 60_000;
    const payload = { chat_id: store.data.owner.chatId, message_id: Number(id) };
    try {
      if (entry.deleteRequested && !tooOld && entry.status !== 'close-pending') {
        try {
          await a.telegram.call('deleteMessage', payload);
          entry.status = 'deleted'; entry.handledAt = inbox.now();
          delete entry.retryAt; store.save(); continue;
        } catch (error) {
          if (error.telegramReason === 'message-missing') {
            entry.status = 'missing'; entry.handledAt = inbox.now();
            delete entry.retryAt; store.save(); continue;
          }
          if (error.telegramReason !== 'message-cannot-delete') throw error;
          entry.status = 'close-pending'; store.save();
        }
      }
      if (!editable) {
        entry.status = 'manual'; entry.handledAt = inbox.now(); delete entry.retryAt; store.save(); continue;
      }
      await a.telegram.call('editMessageReplyMarkup', { ...payload, reply_markup: { inline_keyboard: [] } });
      entry.status = 'closed'; entry.handledAt = inbox.now(); delete entry.retryAt;
    } catch (error) {
      if (error.telegramReason === 'message-missing' || error.telegramReason === 'message-unchanged') {
        entry.status = error.telegramReason === 'message-missing' ? 'missing' : 'closed';
        entry.handledAt = inbox.now(); delete entry.retryAt;
      } else entry.retryAt = inbox.now() + Math.max(60_000, (error.retryAfter || 0) * 1000);
    }
    store.save();
  }
  return count;
}
