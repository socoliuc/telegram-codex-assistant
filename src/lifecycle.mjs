import { mkdirSync, chmodSync, writeFileSync, renameSync, readFileSync, readdirSync, unlinkSync, realpathSync } from 'node:fs';
import { join, isAbsolute, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { verifiedDesktopSubmission } from './presence-provenance.mjs';

export const activityEvents = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Stop', 'Interrupt', 'SessionEnd'];
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
export function recordDesktopHost(file, pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH, bridge = process.env.TELEGRAM_CODEX_BRIDGE === '1') {
  // Only the desktop-provided environment can refresh this local endpoint.
  // Bridge children may inherit an old endpoint across a desktop restart.
  const valid = typeof pipe === 'string' && pipe.length < 1024 &&
    (process.platform === 'win32' ? pipe.startsWith('\\\\.\\pipe\\') : isAbsolute(pipe));
  if (bridge || !valid) return;
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify({ pipe, observedAt:new Date().toISOString() }), { mode:0o600 });
  renameSync(temp,file);
}
const eventNames = folder => readdirSync(folder).filter(n => /^\d{13}-[a-f0-9-]{36}\.json$/.test(n)).sort().reverse();
function pruneEvents(folder, names) {
  // Immutable, uniquely named records: concurrent producers can safely remove
  // only old published records; no writer's temporary file is ever touched.
  for (const name of names.slice(500)) { try { unlinkSync(join(folder, name)); } catch {} }
}

function promptOrigin(input, bridge) {
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim().slice(0, 8192) : '';
  if (bridge || /^(?:<codex_delegation>[\s\S]*?)?Owner replied in Telegram \[request /u.test(prompt)) return { origin: 'telegram' };
  if (/^(?:Automation:|Automation ID:|<(?:automation_context|heartbeat)(?:\s|>))/u.test(prompt) || input.source === 'automation') return { origin: 'automation' };
  if (/^<(?:codex_delegation|subagent_context)(?:\s|>)/u.test(prompt) || input.agent_id) return { origin: 'agent' };
  const proof = verifiedDesktopSubmission(input);
  return proof ? { origin: 'desktop-user', ...proof } : { origin: 'unknown' };
}

export function recordLifecycleEvent(folder, input, { bridge = process.env.TELEGRAM_CODEX_BRIDGE === '1' } = {}) {
  if (!activityEvents.includes(input.hook_event_name) || !validId(input.session_id) ||
      typeof input.cwd !== 'string' || !isAbsolute(input.cwd)) return null;
  let cwd;
  try { cwd = realpathSync(input.cwd); } catch { return null; }
  // Deliberate allowlist: no prompts, commands, tool arguments, transcripts or responses.
  const event = { id: randomUUID(), event: input.hook_event_name, sessionId: input.session_id,
    turnId: validId(input.turn_id) ? input.turn_id : null, cwd, receivedAt: new Date().toISOString(),
    ...(input.hook_event_name === 'UserPromptSubmit' ? promptOrigin(input, bridge) : {}) };
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(folder, 0o700);
  const file = join(folder, `${Date.now()}-${event.id}.json`);
  const temp = file + '.tmp';
  writeFileSync(temp, JSON.stringify(event), { mode: 0o600 });
  renameSync(temp, file);
  pruneEvents(folder, eventNames(folder));
  return event;
}

export function readLifecycleEvents(folder, { limit = 100 } = {}) {
  let names;
  try { names = eventNames(folder); }
  catch { return []; }
  const events = [];
  for (const name of names.slice(0, Math.max(1, Math.min(500, limit)))) {
    try {
      const text = readFileSync(join(folder, name), 'utf8');
      if (text.length > 4096) continue;
      const e = JSON.parse(text);
      if (!activityEvents.includes(e.event) || !validId(e.sessionId) || typeof e.cwd !== 'string' ||
          !Number.isFinite(Date.parse(e.receivedAt)) || !/^[a-f0-9-]{36}$/.test(e.id)) continue;
      events.push({ id: e.id, event: e.event, sessionId: e.sessionId, turnId: validId(e.turnId) ? e.turnId : null, cwd: e.cwd, receivedAt: e.receivedAt,
        ...(['desktop', 'desktop-user', 'telegram', 'automation', 'agent', 'unknown'].includes(e.origin) ? { origin: e.origin } : {}),
        ...(e.origin === 'desktop-user' && Number.isFinite(Date.parse(e.submittedAt)) ? { submittedAt: e.submittedAt } : {}) });
    } catch { /* Concurrent publication or a malformed record is ignored. */ }
  }
  pruneEvents(folder, names);
  return events;
}

export function mergeActivityHooks(current, command, remove = false) {
  const result = structuredClone(current);
  if (!result.hooks) result.hooks = {};
  for (const event of activityEvents) {
    const existing = result.hooks[event] || [];
    if (!Array.isArray(existing)) throw new Error('Existing hook configuration is invalid; preserved without modification.');
    const groups = existing.map(group => ({ ...group, hooks: group.hooks.filter(h => h.command !== command) })).filter(group => group.hooks.length);
    if (!remove) groups.push({ ...(event === 'PostToolUse' ? { matcher: 'apply_patch|Edit|Write' } : {}), hooks: [{
      type: 'command', command, async: event !== 'SessionEnd', timeout: ['Interrupt', 'SessionEnd'].includes(event) ? 3 : 5,
      statusMessage: 'Syncing Telegram assistant activity'
    }] });
    if (groups.length) result.hooks[event] = groups;
    else delete result.hooks[event];
  }
  return result;
}
