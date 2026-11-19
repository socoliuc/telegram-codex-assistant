import path from 'node:path';

export function isOwner(message, owner) {
  return Boolean(owner && message?.chat?.type === 'private' && !message?.from?.is_bot &&
    !message.forward_origin && !message.forward_from && !message.sender_chat &&
    message.from?.id === owner.userId && message.chat.id === owner.chatId);
}

export function rootsOverlap(a, b) {
  const normalize = p => path.win32.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  return a.some(x => b.some(y => {
    const left = normalize(x), right = normalize(y);
    return left === right || left.startsWith(right + '\\') || right.startsWith(left + '\\');
  }));
}

export function isWithinRoots(folder, roots) {
  return roots.some(root => {
    const relative = path.win32.relative(root, folder);
    return !relative || (!path.win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..\\'));
  });
}

export function redact(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join('[REDACTED]');
  return text.replace(/sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/(Authorization:\s*Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]');
}

export function splitText(value, limit = 3900) {
  const chunks = [];
  let part = '';
  for (const point of String(value)) {
    if (part.length + point.length > limit) { chunks.push(part); part = ''; }
    part += point;
  }
  if (part) chunks.push(part);
  return chunks;
}

export function claimUpdate(store, updateId) {
  if (!Number.isSafeInteger(updateId) || updateId < store.data.offset) return false;
  store.data.offset = updateId + 1;
  store.save(); // At-most-once intake: never replay a possibly submitted command.
  return true;
}

export function resolveProject(projects, query) {
  const needle = String(query).trim().toLowerCase();
  const exact = projects.filter(p => p.id === query || p.name.toLowerCase() === needle);
  if (exact.length === 1) return exact[0];
  const matches = projects.filter(p => p.name.toLowerCase().includes(needle));
  if (!needle || matches.length !== 1) throw new Error('Choose one exact project name from /projects.');
  return matches[0];
}
