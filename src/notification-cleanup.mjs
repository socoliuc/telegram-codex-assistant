import { redact } from './core.mjs';
import { short } from './inbox.mjs';

// These IDs come only from delivered bot notifications. Retain their source
// routes after removal, so a delayed reply can never fall through to General.
export function notificationIds(controls, item) {
  return [...new Set([...(item.messageIds || []), ...(item.mediaMessageIds || []),
    ...Object.keys(item.notificationMessages || {}),
    ...Object.entries(controls.store.data.desktopReplies || {})
      .filter(([, route]) => route.inboxId === item.id).map(([id]) => id)])]
    .filter(id => /^[1-9]\d*$/.test(String(id)) && !controls.inbox.data.panels[id]).map(String);
}

export async function cleanupNotification(controls, item, limit) {
  return cleanupMessages(controls, item, notificationIds(controls, item), limit);
}

export async function cleanupPanel(controls, id) {
  const panel = controls.inbox.data.panels[id];
  if (!panel?.dismissedAt || !/^[1-9]\d*$/.test(String(id))) return 0;
  if (!panel.cleanup) {
    panel.cleanup = { sentAt: panel.sentAt };
    controls.store.save(); // Retain the cleanup job if the listener exits during deletion.
  }
  return cleanupMessages(controls, { label: 'Menu', status: 'resolved',
    resolution: 'This panel is closed. Send /menu to open the controls again.',
    notificationMessages: { [id]: panel.cleanup } }, [String(id)], 1);
}

export async function cleanupHousekeeping(controls, id) {
  const record = controls.inbox.data.housekeeping?.[id];
  if (!record?.dismissedAt || !record.cleanup || !/^[1-9]\d*$/.test(String(id))) return 0;
  return cleanupMessages(controls, { label: 'Notice', status: 'resolved',
    resolution: 'Dismissed. You can delete this older message in Telegram.',
    notificationMessages: { [id]: record.cleanup } }, [String(id)], 1, !['command', 'reply'].includes(record.kind));
}

async function cleanupMessages(controls, item, ids, limit, editable = true) {
  const { inbox, store, a } = controls;
  item.notificationMessages ||= {};
  let count = 0;
  for (const id of ids) {
    const entry = item.notificationMessages[id] ||= {};
    if (['deleted', 'missing', 'closed', 'manual'].includes(entry.status) || entry.retryAt > inbox.now()) continue;
    if (count >= limit) break;
    count++;
    // Old records may lack a delivery timestamp. Ask Telegram once instead of
    // assuming a recently resent copy has the age of its original question.
    const tooOld = entry.sentAt && inbox.now() - entry.sentAt >= 48 * 60 * 60_000;
    // Expiry/restart is not proof that a collected/uncertain native response
    // reached Codex. Retain a closed inspection notice instead of deleting it.
    const unconfirmedNative = item.nativeAnswerState && item.nativeAnswerState !== 'submitted';
    const payload = { chat_id: store.data.owner.chatId, message_id: Number(id) };
    try {
      if (!tooOld && !unconfirmedNative && entry.status !== 'close-pending') {
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
      const reason = item.status === 'reviewed' ? 'Reviewed.' : item.replySentAt ?
        'Your reply was sent to Codex.' : item.resolution || 'This request is no longer pending.';
      const text = redact(`${short(item.label || 'Codex', 200)} — ${item.status === 'reviewed' ? 'reviewed' : 'closed'}\n\n${short(reason, 1500)}`, [a.telegram.token]);
      const media = item.mediaMessageIds?.includes(id);
      await a.telegram.call(media ? 'editMessageCaption' : 'editMessageText', {
        ...payload, [media ? 'caption' : 'text']: media ? short(text, 1000) : text,
        reply_markup: { inline_keyboard: [], ...(entry.forceReply ? { force_reply: true } : {}) },
        ...(!media ? { link_preview_options: { is_disabled: true } } : {})
      });
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
