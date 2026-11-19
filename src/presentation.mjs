const labels = { dispatching: 'getting started', running: 'working', awaiting_approval: 'waiting for your approval',
  stopping: 'stopping', completed: 'finished', failed: 'could not finish', interrupted: 'interrupted',
  uncertain: 'outcome needs checking', reconciled: 'checked and released' };

export const alertNames = { input: 'Question', approval: 'Approval needed', failure: 'Check task', completion: 'Update' };

export function alertHeading(item, action = alertNames[item.kind]) {
  const label = item.displayLabel || item.label || 'General';
  const split = item.source === 'desktop' ? label.indexOf(' · ') : -1;
  const project = split < 0 ? label : label.slice(0, split);
  const chat = split < 0 ? '' : label.slice(split + 3).trim();
  return project + ' · ' + action + (chat && chat !== '(untitled)' && chat !== project ? '\n' + chat : '');
}

// Only unwrap a complete automation envelope. Ordinary text may discuss these tags.
export function displayMessage(text) {
  const envelope = /^\s*<heartbeat>\s*<automation_id>[^<>]*<\/automation_id>\s*<decision>[^<>]*<\/decision>\s*<message>([\s\S]*?)<\/message>\s*<\/heartbeat>\s*$/.exec(text);
  return envelope?.[1].trim() || text;
}

export function alertBody(item) {
  const body = item.text || '';
  if (item.source === 'bridge' && item.label === 'General' && item.kind === 'completion' && body === item.imageSource) return body;
  const heading = alertHeading(item);
  const blank = body.indexOf('\n\n');
  const original = blank < 0 ? '' : body.slice(0, blank);
  if (original && (original === item.label || original.startsWith(item.label + ' — ') || original === 'Approval needed · ' + item.label)) {
    const detail = item.kind === 'failure' && original.startsWith(item.label + ' — ') ? original.slice(item.label.length + 3) : '';
    return alertHeading(item, detail || alertNames[item.kind]) + body.slice(blank);
  }
  return heading + '\n\n' + body;
}

export function alertPreview(item) {
  if (item.imageSource || item.route?.context) return displayMessage(item.imageSource || item.route.context);
  const text = item.text || '', blank = text.indexOf('\n\n');
  const body = blank >= 0 && text.startsWith(item.label + ' — ') ? text.slice(blank + 2).replace(/\n\nReply here to continue\.$/, '') : text;
  return displayMessage(body);
}

export function formatJobs(jobs) {
  if (!jobs.length) return 'Nothing is running through me yet. Tell me what you would like to work on.';
  return jobs.slice(-8).map(job => `${job.project}: ${labels[job.status] || job.status}${
    ['uncertain', 'interrupted'].includes(job.status) ? ` — check what happened before continuing (/release ${job.id} after inspection)` : ''}`).join('\n');
}

export function jobLabel(job) {
  return job.project === 'Assistant' ? 'General' : job.scopeProjectId ? job.project.replace(/ discussion$/, '') : job.project;
}

export function formatCompletion(job, text) {
  if (job.project === 'Assistant') return text;
  const project = jobLabel(job);
  const lead = job.status === 'completed' ? project : `${project} — ${labels[job.status] || job.status}`;
  return `${lead}\n\n${text}`;
}
