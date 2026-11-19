import { openSync, readSync, closeSync, fstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const manualKinds = new Set(['user.text', 'user.image', 'user.file', 'user.audio']);
const manualTriggers = new Set(['composer', 'send_user_message_async_question']);
const normalize = text => String(text ?? '').replace(/\r\n/g, '\n').trim();
const localPath = file => typeof file === 'string' && isAbsolute(file) && !file.startsWith('//') &&
  (!file.startsWith('\\\\') || /^\\\\\?\\[a-z]:\\/i.test(file));

// This adapter deliberately accepts only the verified local Desktop format.
// Unknown formats fail closed. Read a bounded header and tail, never the full
// history (which can be gigabytes). No text or transcript paths are persisted.
export function verifiedDesktopSubmission(input, { at = Date.now(), matchPrompt = true } = {}) {
  let fd;
  try {
    if (!input.session_id || !input.turn_id || !localPath(input.transcript_path) ||
        (matchPrompt && typeof input.prompt !== 'string')) return null;
    const file = realpathSync(input.transcript_path);
    if (!localPath(file)) return null;
    fd = openSync(file, 'r');
    const stat = fstatSync(fd);
    if (!stat.isFile()) return null;
    const head = Buffer.alloc(Math.min(stat.size, 128 * 1024));
    const headSize = readSync(fd, head, 0, head.length, 0), end = head.subarray(0, headSize).indexOf(10);
    if (end < 0) return null;
    const record = JSON.parse(head.subarray(0, end).toString('utf8'));
    const meta = record.payload;
    if (record.type !== 'session_meta' || meta?.id !== input.session_id ||
        (meta.session_id && meta.session_id !== input.session_id) || meta.source !== 'vscode' ||
        meta.originator !== 'Codex Desktop' || meta.thread_source !== 'user' || meta.agent_path || meta.agent_role) return null;
    const start = Math.max(end + 1, stat.size - 2 * 1024 * 1024);
    const tail = Buffer.alloc(stat.size - start);
    const tailSize = readSync(fd, tail, 0, tail.length, start);
    let lines = tail.subarray(0, tailSize).toString('utf8').split('\n');
    if (start > end + 1) lines = lines.slice(1); // The first line may be partial.
    const rows = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const task = rows.findLast(row => row.type === 'event_msg' && row.payload?.type === 'task_started' && row.payload.turn_id === input.turn_id);
    const attribution = task?.payload?.turn_attribution;
    if (!attribution || attribution.turn_id !== input.turn_id || attribution.root_turn_id !== input.turn_id || attribution.initiating_agent_path) return null;
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index], message = row.payload;
      if (row.type !== 'response_item' || message?.type !== 'message' || message.role !== 'user') continue;
      const data = message.internal_chat_message_metadata_passthrough;
      if (data?.turn_id !== input.turn_id || !Array.isArray(data.content_item_kinds) || !data.content_item_kinds.length ||
          !data.content_item_kinds.every(kind => manualKinds.has(kind)) ||
          !Array.isArray(data.content_item_metadata) || data.content_item_metadata.length !== data.content_item_kinds.length ||
          !data.content_item_metadata.every(item => item.provenance?.type === 'user')) continue;
      const submittedAt = data.create_time * 1000;
      if (!Number.isFinite(submittedAt) || submittedAt < at - 15_000 || submittedAt > at + 5000) continue;
      const text = (message.content || []).filter(part => part.type === 'input_text').map(part => part.text).join('\n');
      if (matchPrompt && normalize(text) !== normalize(input.prompt)) continue;
      const manualDuringAutomation = attribution.turn_trigger?.startsWith('automation_') && rows.slice(0, index).some(previous =>
        previous.type === 'response_item' && previous.payload?.role === 'user' &&
        previous.payload.internal_chat_message_metadata_passthrough?.turn_id === input.turn_id &&
        previous.payload.internal_chat_message_metadata_passthrough.content_item_kinds?.includes('user.heartbeat'));
      if (!manualTriggers.has(attribution.turn_trigger) && !manualDuringAutomation) continue;
      return { submittedAt: new Date(submittedAt).toISOString() };
    }
  } catch { /* Unavailable, partial or unrecognized provenance is not human activity. */ }
  finally { if (fd !== undefined) closeSync(fd); }
  return null;
}
