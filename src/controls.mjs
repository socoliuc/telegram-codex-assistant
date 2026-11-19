import { Inbox, isOpen, isVisible, needsAttention, short } from './inbox.mjs';
import { cleanupNotification, cleanupPanel, notificationIds } from './notification-cleanup.mjs';
import { redact, splitText } from './core.mjs';
import { alertBody, alertHeading, alertPreview, displayMessage, formatJobs } from './presentation.mjs';
import { projectForChat } from './projects.mjs';
import { randomBytes } from 'node:crypto';
import { Housekeeping } from './housekeeping.mjs';
import { ActivityGate } from './activity.mjs';
import { questionChoices, choiceRevision } from './choices.mjs';
import { imageReferences, prepareImages, renderAttachedImages } from './outgoing-images.mjs';

const button = (text, action) => ({ text, callback_data: 'ctl:' + action });
const homeButton = button('⌂ Home', 'home');
const moreButton = button('‹ More', 'more');

export const unconfirmedReply = 'awaiting-details-delivery';

export class Controls {
  constructor(assistant) {
    this.a = assistant; this.inbox = new Inbox(assistant.store);
    this.inbox.recoverBridge();
    this.cleaning = new Map();
    this.panelEdits = new Map();
    this.housekeeping = new Housekeeping(this);
    this.activity = new ActivityGate(this.inbox);
    this.openSerial = Promise.resolve();
  }
  get store() { return this.a.store; }
  forDisplay(item) {
    const origin = item.verifiedOrigin || item.route?.origin || (item.route?.reportedProjectId && {
      projectId: item.route.reportedProjectId, cwd: item.route.imageRoots?.[0] });
    const cwd = origin?.cwd || item.route?.imageRoots?.[0], split = item.label?.indexOf(' · ') ?? -1;
    if (item.source !== 'desktop' || !cwd || split < 0) return item;
    const project = projectForChat(this.a.projects, cwd, origin?.projectId);
    const needsOrigin = !origin && project?.id !== (item.route.projectId || undefined);
    const name = needsOrigin ? 'Project unverified' : project?.name || 'General';
    const displayLabel = redact(name + item.label.slice(split), [this.a.telegram.token]);
    const allowedImageRoots = needsOrigin ? [] : [...new Set([cwd, ...(project?.roots || [])])];
    return { ...item, displayLabel, needsOrigin, allowedImageRoots };
  }
  async verifyLegacyOrigins(items) {
    // Only owner-opened lists and Details can request metadata for a conflicting legacy label.
    // Background refreshes and proactive notifications must never widen the monitor's read budget.
    const needing = items.filter(item => this.forDisplay(item).needsOrigin);
    const ids = [...new Set(needing.map(item => item.route.threadId).filter(Boolean))];
    for (const id of ids) {
      try {
        const { thread } = await this.a.desktop.tools.read(id, 'local', { turnLimit: 1 });
        if (thread?.id !== id || !thread.cwd) continue;
        for (const item of needing.filter(x => x.route.threadId === id)) {
          item.verifiedOrigin = { cwd: thread.cwd, projectId: thread.projectId || null };
        }
        this.store.save();
      } catch { /* An unavailable source keeps the neutral label and cannot add media roots. */ }
    }
  }
  help(text) { return this.housekeeping.notice(text); }
  receipt(text) { return this.housekeeping.notice(text, { clearAfterMs: 5000 }); }
  async confirm(q, text) {
    try { await this.a.telegram.call('answerCallbackQuery', { callback_query_id: q.id,
      text: short(redact(text, [this.a.telegram.token]), 190) }); }
    catch { try { await this.help(text); } catch {} }
  }
  activePanel() {
    const panels = this.inbox.data.panels;
    const valid = id => panels[id] && !panels[id].dismissedAt && panels[id].view !== 'digest';
    const id = valid(this.inbox.data.homePanelId) ? this.inbox.data.homePanelId : Object.keys(panels).reverse().find(valid);
    return id ? { message_id: Number(id) } : undefined;
  }
  open(view = 'home', message, afterMessageId = 0) {
    if (view === 'home') this.clearReplyDestination();
    const run = async () => {
      const explicit = this.inbox.data.panels[String(message?.message_id)];
      let target = explicit && explicit.view !== 'digest' ? message : this.activePanel();
      if (target && this.inbox.data.panels[String(target.message_id)]?.dismissedAt) return;
      // Telegram edits stay at their original scroll position. A slash command
      // needs a panel below it, while inline buttons stay on the panel being used.
      const previous = target && target.message_id < afterMessageId ? this.inbox.data.panels[String(target.message_id)] : null;
      if (previous) target = undefined;
      const projects = /^projects(?::(\d+))?$/.exec(view);
      const render = () => projects ? this.a.showProjectPicker(target, Number(projects[1] || 0)) : this.show(view, target, true);
      let id;
      try { id = await render(); }
      catch (error) {
        if (error.telegramReason !== 'message-missing' || !target) throw error;
        const old = this.inbox.data.panels[String(target.message_id)];
        Object.assign(old, { dismissedAt: this.inbox.now(), expiresAt: 0,
          cleanup: { status: 'missing', handledAt: this.inbox.now() } });
        delete this.inbox.data.homePanelId; this.store.save();
        target = undefined; id = await render();
      }
      if (id && !this.inbox.data.panels[String(id)]?.dismissedAt) {
        this.inbox.data.homePanelId = String(id);
        if (previous && !previous.dismissedAt) {
          previous.dismissedAt = this.inbox.now(); previous.expiresAt = 0;
          previous.cleanup = { sentAt: previous.sentAt };
        }
        this.store.save();
      }
      return id;
    };
    return this.queuePanel(run);
  }
  queuePanel(run) {
    const pending = this.openSerial.catch(() => {}).then(run);
    this.openSerial = pending; return pending;
  }
  replyable(item) {
    const job = this.store.data.jobs[item.jobId];
    return Boolean(item.route?.threadId || job?.threadId || job?.projectId || job?.scopeProjectId);
  }
  clearReplyDestination() {
    const id = this.inbox.data.nextReplyMessageId;
    if (id) {
      delete this.inbox.data.nextReplyMessageId;
      this.store.save();
    }
    return id;
  }
  buttons(item) {
    if (!isVisible(item)) return { inline_keyboard: [] };
    const rows = [], questions = item.choiceQuestions || [];
    const submitted = item.answerSubmissionId || item.replySentAt;
    if (item.kind === 'input' && isOpen(item) && !item.route?.nativeWaiting && !submitted && !item.nativeAnswerState) {
      const revision = choiceRevision(questions);
      for (const q of questions) {
        if (item.answeredQuestionIndexes?.includes(q.index)) continue;
        const sent = item.choiceSubmissions?.[q.index];
        if (sent) continue;
        for (const [index, option] of q.options.entries()) rows.push([button(
          redact((questions.length > 1 ? `Q${q.index + 1} · ` : '') + option, [this.a.telegram.token]),
          `answer:${item.id}:${revision}:${q.index}:${index}`)]);
      }
    }
    // Question cards contain only the actual answers. Management stays in /menu.
    if (item.kind === 'input') return { inline_keyboard: rows };
    rows.push([button(this.replyable(item) ? 'Open & reply' : 'Details', 'item:' + item.id)]);
    if (needsAttention(item) && isOpen(item) && item.source === 'desktop') rows.push([button('Remind me in 1 hour', 'snooze:' + item.id)]);
    if (!['input', 'approval'].includes(item.kind)) rows.push([button('Mark reviewed', 'review:' + item.id)]);
    rows.push([homeButton]);
    return { inline_keyboard: rows };
  }
  questionText(item) {
    if (item.kind !== 'input' || !item.choiceQuestions?.some(q => q.options.length)) return null;
    item = this.forDisplay(item);
    if (!isOpen(item)) return `${alertHeading(item, 'Question closed')}\n\n${short(item.resolution || 'This question is no longer pending.', 1500)}`;
    const submitted = item.answerSubmissionId || item.replySentAt;
    const questions = item.choiceQuestions.map(q => {
      const selected = item.choiceSubmissions?.[q.index];
      const status = item.answeredQuestionIndexes?.includes(q.index) ? '\nAnswered in Codex.' : selected ?
        `\n${selected.status === 'saved' ? 'Saved' : selected.status === 'submitted' ? 'Sent' : 'Awaiting confirmation'}: ${selected.answer}` : '';
      return `${item.choiceQuestions.length > 1 ? `Q${q.index + 1}. ` : ''}${q.title}${status}`;
    }).join('\n\n');
    const footer = item.nativeAnswerState === 'collected' ? 'Saved. Waiting for the remaining answers before sending to Codex.' :
      ['sending', 'unknown'].includes(item.nativeAnswerState) ? 'Answer delivery is unconfirmed. Check Codex before retrying.' :
      submitted ? 'Your answer was sent. Waiting for Codex to reflect it.' : 'Choose an answer below, or reply in your own words.';
    const media = item.mediaDelivery?.status === 'unknown' ? '\n\nImage delivery is unconfirmed; it has not been retried.' : '';
    const skipped = item.imageSkipped ? `\n\n${item.imageSkipped} ${item.imageSkipped === 1 ? 'image could' : 'images could'} not be attached. See the original reply in Codex.` : '';
    return renderAttachedImages(`${alertHeading(item, submitted ? 'Answer sent' : 'Question')}\n\n${questions}\n\n${footer}${media}${skipped}`, item.mediaDelivery?.sources || []);
  }
  record(item, message, metadata = {}) {
    const id = String(message.message_id);
    item.notificationMessages ||= {};
    item.notificationMessages[id] ||= { sentAt: message.date ? message.date * 1000 : this.inbox.now() };
    if (metadata.forceReply) item.notificationMessages[id].forceReply = true;
    item.messageIds = [...new Set([...(item.messageIds || []), id])].slice(-20);
    if (item.choiceQuestions?.some(q => q.options.length) && !item.mediaMessageIds?.includes(id)) {
      item.choiceMarkup ||= {};
      item.choiceMarkup[id] = { ...metadata, signature: JSON.stringify([this.buttons(item), this.questionText(item)]) };
    }
    if (item.source === 'desktop') {
      this.store.data.desktopReplies ||= {};
      this.store.data.desktopReplies[id] = item.route;
    } else if (item.questionId) {
      this.store.data.inputReplies ||= {};
      this.store.data.inputReplies[id] = { jobId: item.jobId, questionId: item.questionId };
      if (this.a.pending.has(item.questionKey)) this.a.questionReplies.set(id, { key: item.questionKey, questionId: item.questionId });
    }
    this.store.save();
  }
  suppressOld(item) {
    if (!this.activity.tooOld(item)) return false;
    item.delivery = 'inbox'; item.ageSuppressedAt ||= this.inbox.now();
    this.store.data.notices[item.key] = 'inbox'; this.store.save(); return true;
  }
  async notify(item, keyboard, onDelivered, { heldRelease = false } = {}) {
    this.activity.refresh();
    if (this.suppressOld(item)) return;
    if (this.activity.blocks(item)) {
      item.delivery = 'held'; item.heldAt ||= this.inbox.now(); this.store.save(); return;
    }
    const policy = this.inbox.policy(item);
    if (['digest', 'inbox'].includes(policy)) {
      item.delivery = policy; item.digestAt = this.inbox.now() + 60 * 60_000; this.store.save(); return;
    }
    const claim = randomBytes(8).toString('hex');
    item.deliveryClaim = claim; item.delivery = 'sending'; this.store.save();
    const brief = item.source === 'desktop' && !needsAttention(item) && this.inbox.data.settings.detail === 'brief';
    try {
      await this.sendItem(item, '', keyboard || this.buttons(item), (message, metadata) => {
        this.record(item, message, metadata); onDelivered?.(message);
      }, { silent: policy === 'silent', brief, proactive: true, heldRelease, claim });
      if (item.deliveryClaim === claim && item.delivery === 'sending') item.delivery = 'delivered';
    } catch (e) { if (item.deliveryClaim === claim) item.delivery = 'unknown'; throw e; }
    finally { this.store.save(); }
  }
  async item(id) {
    this.clearReplyDestination();
    const item = this.inbox.get(id);
    if (!item) return this.a.send('That inbox item is no longer available. Open /inbox for current requests.');
    if (!isVisible(item)) return this.open(needsAttention(item) ? 'attention:0' : 'updates:0');
    // Details are new, immutable reply targets. Never edit a menu into a
    // different conversation while leaving an old reply route on its message.
    // An explicit attempt also retires held delivery. Persist its claim before
    // awaiting Telegram so catch-up cannot replay a successful or uncertain send.
    const held = item.delivery === 'held' || (item.delivery === 'sending' && item.deliveryClaim);
    const claim = held ? randomBytes(8).toString('hex') : null;
    if (held) { item.deliveryClaim = claim; item.delivery = 'sending'; this.store.data.notices[item.key] = 'sending'; this.store.save(); }
    try {
      if (this.forDisplay(item).needsOrigin) {
        await this.verifyLegacyOrigins([item]);
        if (!isVisible(item)) {
          if (held && item.deliveryClaim === claim) item.delivery = 'inbox';
          return this.open(needsAttention(item) ? 'attention:0' : 'updates:0');
        }
      }
      let keyboard = this.buttons(item);
      const native = item.questionKey && this.a.pending.get(item.questionKey);
      if (item.kind === 'approval' && native) keyboard = { inline_keyboard: [[
        { text: 'Approve once', callback_data: 'approve:' + item.questionKey },
        { text: 'Decline', callback_data: 'decline:' + item.questionKey }], [homeButton]] };
      // A native ForceReply remains in the Telegram composer after Home.
      // Bind the next plain message to the delivered Details card instead.
      const selectReply = this.replyable(item) && item.kind !== 'approval' && !item.route?.nativeWaiting &&
        !item.answerSubmissionId && !item.replySentAt && !item.nativeAnswerState;
      if (selectReply && item.kind === 'input') keyboard = { inline_keyboard: [...keyboard.inline_keyboard, [homeButton]] };
      const status = (!isOpen(item) ? '\n\n' + (item.resolution || 'Marked reviewed.') : item.replySentAt ? '\n\nYour reply was sent. Waiting for Codex to reflect the result.' : '') +
        (!this.replyable(item) ? '\n\nNo conversation was created for this task. Inspect /status and choose its project before sending a fresh instruction.' : '');
      let selectFirst = selectReply;
      if (selectReply) {
        this.inbox.data.nextReplyMessageId = unconfirmedReply;
        this.store.save();
      }
      await this.sendItem(item, status, keyboard, (message, metadata) => {
        if (selectFirst) {
          this.inbox.data.nextReplyMessageId = String(message.message_id);
          selectFirst = false;
        }
        this.record(item, message, metadata);
      }, { silent: true, replyPrompt: selectReply });
      if (held && item.deliveryClaim === claim) item.delivery = 'delivered';
    } catch (error) { if (held && item.deliveryClaim === claim) item.delivery = 'unknown'; throw error; }
    finally { if (held && item.deliveryClaim === claim) { this.store.data.notices[item.key] = item.delivery; this.store.save(); } }
  }
  async sendItem(item, status, keyboard, record, { silent = false, brief = false, proactive = false, heldRelease = false, claim, replyPrompt = false } = {}) {
    const source = item.imageSource || '';
    const display = this.forDisplay(item);
    let prepared, body = alertBody(display), renderedSource = source;
    const attempted = () => ['sending', 'delivered', 'unknown'].includes(item.mediaDelivery?.status);
    if (item.kind !== 'approval' && !attempted() && imageReferences(source).length) {
      const job = this.store.data.jobs[item.jobId];
      let roots = item.source === 'desktop' ? item.route?.imageRoots || item.imageRoots : job?.imageRoots || job?.roots;
      if (!roots?.length && !display.allowedImageRoots && item.source === 'desktop' && this.a.desktop && item.route?.threadId) {
        try {
          const current = await this.a.desktop.tools.read(item.route.threadId, item.route.hostId);
          if (current.thread?.id === item.route.threadId && current.thread.cwd) roots = [current.thread.cwd];
        } catch { /* Text remains deliverable when the source directory is unavailable. */ }
      }
      prepared = await prepareImages(source, roots || [], { currentRoots: display.allowedImageRoots });
      item.imageSkipped = prepared.skipped;
      renderedSource = prepared.text;
    }
    if (attempted()) renderedSource = renderAttachedImages(source, item.mediaDelivery.sources || []);
    const sourceStart = source ? body.lastIndexOf(source) : -1;
    if (sourceStart >= 0) body = body.slice(0, sourceStart) + displayMessage(renderedSource) + body.slice(sourceStart + source.length);
    const questionText = this.questionText(item);
    if (questionText) body = renderAttachedImages(questionText, prepared?.sources || item.mediaDelivery?.sources || []);
    if (brief && body.length > 800) body = body.slice(0, 700) + '\n\nTap Open & reply for the full update.';
    if (!questionText && prepared?.skipped) body += `\n\n${prepared.skipped} ${prepared.skipped === 1 ? 'image could' : 'images could'} not be attached. See the original reply in Codex.`;
    if (!questionText && item.mediaDelivery?.status === 'unknown') body += '\n\nImage delivery is unconfirmed; it has not been retried.';
    const text = body + (questionText ? '' : status) + (replyPrompt ? '\n\nType your reply here, or tap Home to cancel.' : '');
    // Preparation can await image files or native source metadata. Recheck
    // activity before sending in case the owner returned to Codex meanwhile.
    if (proactive) {
      if (item.deliveryClaim !== claim) return []; // Explicit Details took over this attempt.
      this.activity.refresh();
      if (!isVisible(item)) {
        item.delivery = 'inbox'; this.store.save(); return [];
      }
      if (this.suppressOld(item)) return [];
      if (this.a.stopping || this.activity.blocks(item) || (heldRelease &&
          (this.inbox.now() - item.observedAt >= 120_000 || item.snoozedUntil > this.inbox.now()))) {
        item.delivery = 'held'; item.heldAt ||= this.inbox.now(); this.store.save(); return [];
      }
      if (item.source === 'desktop') keyboard = this.buttons(item);
    }
    const multipart = splitText(redact(text, [this.a.telegram.token])).length > 1;
    const recordText = (message, multipart = false) => record?.(message,
      { multipart, ...(keyboard?.force_reply ? { forceReply: true } : {}) });
    const messages = await this.a.send(text, item.jobId, keyboard,
      message => recordText(message, multipart), { silent });
    if (!prepared?.images.length || attempted() || !messages.length || this.a.stopping) return messages;
    // Text/controls are already delivered. Claim the entire media operation
    // before upload; a concurrent Details view or restart cannot replay it.
    item.mediaDelivery = { status: 'sending', at: this.inbox.now(), count: prepared.images.length, sources: prepared.sources, messageIds: [] };
    this.store.save();
    try {
      await this.a.telegram.sendImages(this.store.data.owner.chatId, prepared.images, display.displayLabel || item.label || 'Codex', messages[0].message_id, message => {
        const id = String(message.message_id);
        item.mediaDelivery.messageIds.push(id);
        item.mediaMessageIds = [...(item.mediaMessageIds || []), id];
        if (item.jobId) this.store.data.replies[id] = item.jobId;
        this.record(item, message);
      });
      item.mediaDelivery.status = 'delivered';
    } catch {
      item.mediaDelivery.status = 'unknown'; this.store.save();
      try { await this.a.send('The text arrived, but image delivery could not be confirmed. I haven’t retried the images.', item.jobId, keyboard, recordText, { silent: true }); } catch {}
    } finally { this.store.save(); }
    return messages;
  }
  async show(view = 'home', message, explicit = false) {
    this.syncJobs();
    let text, rows, cleanupOffer;
    const settings = this.inbox.data.settings;
    const selected = this.a.projects.find(p => p.id === this.store.data.selectedProjectId);
    const attention = this.inbox.list(), snoozed = this.inbox.list('snoozed');
    if (view === 'cleanup') {
      const currentId = String(message?.message_id || this.inbox.data.homePanelId || '');
      cleanupOffer = { nonce: randomBytes(6).toString('hex'), expiresAt: this.inbox.now() + 5 * 60_000,
        targets: {
          panels: Object.keys(this.inbox.data.panels).filter(id => id !== currentId && !this.inbox.data.panels[id].dismissedAt),
          chat: this.housekeeping.candidates(),
          updates: this.inbox.list('updates').filter(item => item.kind === 'completion').map(item => item.id)
        } };
    }
    if (view === 'home') {
      const destination = selected?.name || (this.store.data.selectedProjectId ? 'Unavailable project' : 'Auto');
      text = `Home\nCurrent project: ${destination}\n\n` + (selected ? 'Type a message to work in this project.' :
        this.store.data.selectedProjectId ? 'Choose an available project before sending a task.' : 'Type a message. I’ll find its project or keep it in General.');
      rows = [[button(`✉ Inbox · ${attention.length}`, 'attention:0')], [button('⇄ Switch project', 'projects')],
        [button('▶ Running', 'running'), button('≡ Updates', 'updates:0')], [button('More ›', 'more')]];
    } else if (view === 'more') {
      text = 'More\n\nAlerts: ' + this.activity.status().label;
      rows = [[button('Alert settings', 'settings')], [button('Connection', 'health'), button('Cleanup', 'cleanup')], [homeButton]];
    } else if (/^(attention|snoozed|updates):\d+$/.test(view)) {
      const [filter, rawPage] = view.split(':');
      const items = this.inbox.list(filter), pages = Math.max(1, Math.ceil(items.length / 5));
      const page = Math.min(Number(rawPage), pages - 1), pageItems = items.slice(page * 5, page * 5 + 5);
      if (explicit && pageItems.some(item => this.forDisplay(item).needsOrigin)) {
        await this.verifyLegacyOrigins(pageItems);
        return this.show(view, message);
      }
      const shown = pageItems.map(i => this.forDisplay(i));
      text = `${filter === 'attention' ? 'Inbox' : filter === 'snoozed' ? 'Snoozed requests' : 'Recent updates'} · ${items.length}${pages > 1 ? '   Page ' + (page + 1) + '/' + pages : ''}\n\n` +
        (filter === 'attention' ? 'Questions, approvals, and tasks to check.\n\n' : '') +
        (shown.map((item, i) => `${page * 5 + i + 1}. ${short(alertHeading(item), 140)} · ${this.age(item.createdAt)}${item.replySentAt ? ' · reply sent' : ''}${['sending', 'unknown'].includes(item.delivery) ? ' · delivery unconfirmed' : ''}\n${short(alertPreview(item), 140)}`).join('\n\n') ||
        (filter === 'attention' ? 'No open requests in the inbox.' : 'Nothing here yet.'));
      text += '\n\n' + this.freshness();
      rows = shown.map((item, i) => [button(`${page * 5 + i + 1}. ${short(alertHeading(item).split('\n')[0], 52)}`, 'item:' + item.id)]);
      if (pages > 1) rows.push([...(page ? [button('Previous', filter + ':' + (page - 1))] : []), ...(page + 1 < pages ? [button('Next', filter + ':' + (page + 1))] : [])]);
      if (filter === 'attention' && snoozed.length) rows.push([button(`Snoozed · ${snoozed.length}`, 'snoozed:0')]);
      rows.push([button('↻ Refresh', view), filter === 'snoozed' ? button('‹ Inbox', 'attention:0') : homeButton]);
    } else if (view === 'settings') {
      const projectId = selected?.id || 'general';
      const muted = settings.mutedProjects.includes(projectId);
      text = `Notification settings\n\nTelegram alerts: ${this.activity.status().label}\nAutomatic pauses proactive alerts after a submitted Codex message and resumes after 30 minutes. Held items stay in the inbox; only notifications from the last 30 minutes are sent when alerts resume.\n\nRoutine desktop updates: ${settings.routine === 'inbox' ? 'inbox only' : settings.routine === 'digest' ? 'hourly digest' : settings.routine}\nQuiet hours: ${settings.quiet ? '23:00–08:00' : 'off'} (${settings.timeZone})\nQuestions and failures during quiet hours: ${settings.urgentDuringQuiet ? 'notify normally' : 'send silently'}\nUpdate length: ${settings.detail}\nRoutine alerts for ${selected?.name || 'General'}: ${muted ? 'inbox only' : 'follow defaults'}\n\nQuestions and failures remain in the inbox. Your direct Telegram conversations always work.`;
      rows = [[button('Automatic · 30m', 'notify:auto'), button('Always send', 'notify:always'), button('Pause alerts', 'notify:paused')],
        [button('Immediate', 'mode:immediate'), button('Silent', 'mode:silent')],
        [button('Hourly digest', 'mode:digest'), button('Inbox only', 'mode:inbox')],
        [button(settings.quiet ? 'Disable quiet hours' : 'Quiet hours 23–08', 'quiet:' + (settings.quiet ? 'off' : 'on'))],
        [button(settings.urgentDuringQuiet ? 'Send urgent quietly at night' : 'Allow urgent night alerts', 'urgent:' + (settings.urgentDuringQuiet ? 'off' : 'on'))],
        [button(settings.detail === 'brief' ? 'Show full updates' : 'Use brief updates', 'detail:' + (settings.detail === 'brief' ? 'full' : 'brief'))],
        [button(muted ? 'Enable this project’s updates' : 'Mute this project’s routine updates', 'mute:' + (muted ? 'off' : 'on'))],
        [moreButton, homeButton]];
    } else if (view === 'cleanup') {
      const counts = Object.fromEntries(Object.entries(cleanupOffer.targets).map(([key, ids]) => [key, ids.length]));
      const manual = Object.values(this.housekeeping.records).filter(item => item.cleanup?.status === 'manual').length;
      text = `Cleanup\n\nClear all clutter removes other panels, commands, sent replies and confirmations.\nHome, pending or uncertain replies, questions, approvals, failures and unreviewed updates stay.\n\nClose other panels: ${counts.panels}\nClear commands, replies and notices: ${counts.chat}\nMark completed updates reviewed: ${counts.updates}\n\nOnly tracked messages can be cleared in bulk. Reply /dismiss to an older sent message to remove it.${manual ? `\n\n${manual} older sent ${manual === 1 ? 'message needs' : 'messages need'} Telegram’s Delete action.` : ''}`;
      rows = [[button(`Clear all clutter · ${counts.panels + counts.chat}`, 'clean:all:' + cleanupOffer.nonce)],
        [button(`Close other panels · ${counts.panels}`, 'clean:panels:' + cleanupOffer.nonce)],
        [button(`Clear commands / replies / notices · ${counts.chat}`, 'clean:chat:' + cleanupOffer.nonce)],
        [button(`Mark updates reviewed · ${counts.updates}`, 'clean:updates:' + cleanupOffer.nonce)],
        [button('↻ Refresh', 'cleanup'), moreButton, homeButton]];
    } else if (view === 'running') {
      let desktop;
      try {
        const active = (await this.a.desktop.tools.list()).filter(row => row.status === 'active');
        desktop = active.length ? active.slice(0, 12).map(row => '• ' + short(row.title || '(untitled)', 150)).join('\n') : 'No active chats in the latest desktop listing.';
        if (active.length > 12) desktop += `\n…and ${active.length - 12} more.`;
      } catch { desktop = 'Current desktop activity is unavailable.'; }
      text = `Running work\n\nCodex desktop\n${desktop}\n\nWork requested through Telegram\n${formatJobs(this.a.jobs())}`;
      rows = [[button('↻ Refresh', 'running'), homeButton]];
    } else if (view === 'health') {
      const snapshot = this.a.context?.snapshot;
      text = `Connection\n\n${this.freshness()}\nContext: ${snapshot?.status || 'unavailable'}${snapshot?.observedAt ? ' · checked ' + this.age(Date.parse(snapshot.observedAt)) : ''}\nProjects: ${this.a.projects.length}\nListener: ${this.a.stopping ? 'stopping' : 'running'}\nActive controls: inbox-v1\n\nText and photos/images are enabled. Voice is not enabled. Some approval forms still require Codex on your computer.\n\nThe computer must be awake and online. This panel shows the last observed state; it cannot announce its own loss of power.`;
      rows = [[button('↻ Refresh', 'health'), moreButton, homeButton]];
    } else return;
    const id = await this.panel(text, { inline_keyboard: rows }, message, view);
    if (cleanupOffer && id && !this.inbox.data.panels[String(id)]?.dismissedAt) {
      this.inbox.data.panels[String(id)].cleanupOffer = cleanupOffer; this.store.save();
    }
    return id;
  }
  async runCleanup(q, scope, nonce) {
    const panel = this.inbox.data.panels[String(q.message?.message_id)], offer = panel?.cleanupOffer;
    if (!panel || panel.dismissedAt || !['cleanup', 'home'].includes(panel.view) || (panel.view === 'home' && scope !== 'all') || !offer || offer.usedAt ||
        offer.nonce !== nonce || offer.expiresAt <= this.inbox.now() || !['all', 'panels', 'chat', 'updates'].includes(scope))
      return this.confirm(q, 'This cleanup selection expired. Open Cleanup again.');
    offer.usedAt = this.inbox.now(); this.store.save();
    let count = 0;
    if (['panels', 'all'].includes(scope)) {
      for (const id of offer.targets.panels) {
        const target = this.inbox.data.panels[id];
        if (!target || target.dismissedAt || id === String(q.message.message_id) || id === String(this.inbox.data.homePanelId)) continue;
        target.dismissedAt = this.inbox.now(); target.expiresAt = 0; target.cleanup = { sentAt: target.sentAt }; count++;
      }
      this.store.save();
    }
    if (['chat', 'all'].includes(scope)) count += this.housekeeping.queue(offer.targets.chat);
    if (scope === 'updates') for (const id of offer.targets.updates) {
      const item = this.inbox.get(id);
      if (item?.kind === 'completion' && isVisible(item) && this.inbox.review(id)) count++;
    }
    await this.confirm(q, count ? scope === 'updates' ? `${count} updates marked reviewed.` : `Cleanup started for ${count} messages.` : 'Nothing to clear here.');
    await this.flush();
    return this.open(scope === 'all' ? panel.view : 'cleanup', q.message);
  }
  freshness() {
    const health = this.a.desktop?.health;
    const stale = !health?.lastScanAt || this.inbox.now() - Date.parse(health.lastScanAt) > 120_000;
    return `Desktop monitoring: ${health?.status === 'connected' && !stale ? 'connected' : 'not current'}${health?.lastScanAt ? ' · checked ' + this.age(Date.parse(health.lastScanAt)) : ''}${health?.readFailures ? ` · ${health.readFailures} chats unavailable` : ''}.`;
  }
  age(at) { const minutes = Math.max(0, Math.floor((this.inbox.now() - at) / 60_000)); return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`; }
  async panel(text, keyboard, message, view, options = { silent: true }) {
    const rows = [...(keyboard?.inline_keyboard || [])], last = rows.at(-1);
    const close = button('Close', 'close');
    if (last?.length < 3 && last.some(b => ['ctl:home', 'ctl:more'].includes(b.callback_data))) rows[rows.length - 1] = [...last, close];
    else rows.push([close]);
    keyboard = { ...keyboard, inline_keyboard: rows };
    const id = String(message?.message_id);
    const panel = this.inbox.data.panels[id];
    if (panel?.dismissedAt) return message.message_id;
    if (panel && !panel.dismissedAt) {
      // Skip a no-op edit (Telegram returns 400 for an unchanged message).
      const signature = JSON.stringify([text, keyboard]);
      if (panel.signature !== signature) {
        try { await this.editPanel(id, {
          chat_id: this.store.data.owner.chatId, message_id: message.message_id,
          text: redact(text, [this.a.telegram.token]), reply_markup: keyboard, link_preview_options: { is_disabled: true }
        }); } catch (error) { if (error.telegramReason !== 'message-unchanged') throw error; }
      }
      if (panel.dismissedAt) return message.message_id;
      Object.assign(panel, { signature, view, projectId: this.store.data.selectedProjectId || 'general',
        expiresAt: this.inbox.now() + 24 * 60 * 60_000 }); this.store.save();
      return message.message_id;
    }
    const messages = await this.a.send(text, undefined, keyboard, m => {
      this.inbox.data.panels[String(m.message_id)] = { view, signature: JSON.stringify([text, keyboard]),
        sentAt: m.date ? m.date * 1000 : this.inbox.now(),
        projectId: this.store.data.selectedProjectId || 'general', expiresAt: this.inbox.now() + 24 * 60 * 60_000 };
      // Menu records have no source route. Bound their retention, keeping recent
      // invalid/expired replies recognisable instead of silently rerouting them.
      const keys = Object.keys(this.inbox.data.panels);
      for (const old of keys.slice(0, Math.max(0, keys.length - 500))) delete this.inbox.data.panels[old];
      this.store.save();
    }, options);
    return messages[0]?.message_id;
  }
  async editPanel(id, payload) {
    const edits = this.panelEdits.get(id) || new Set();
    const request = this.a.telegram.call('editMessageText', payload);
    edits.add(request); this.panelEdits.set(id, edits);
    try { return await request; }
    finally { edits.delete(request); if (!edits.size) this.panelEdits.delete(id); }
  }
  async dismissPanel(message) {
    const id = String(message?.message_id);
    if (!/^[1-9]\d*$/.test(id)) return false;
    let panel = this.inbox.data.panels[id];
    if (!panel) {
      // Before project pickers joined the panel registry, only their Telegram
      // message remains. Accept an owner reply to this bot's exact legacy shape.
      const botId = Number(String(this.a.telegram.token).split(':')[0]);
      const rows = message.reply_markup?.inline_keyboard;
      if (!botId || message.from?.id !== botId || !message.from?.is_bot ||
          message.chat?.id !== this.store.data.owner.chatId || message.chat?.type !== 'private' ||
          message.forward_origin || message.forward_from || message.sender_chat ||
          this.store.data.desktopReplies?.[id] || this.store.data.inputReplies?.[id] || this.store.data.replies?.[id] ||
          !/^Current project: [^\n]+\n\nChoose a project for your next messages,/.test(message.text || '') ||
          !rows?.length || !rows.flat().length || !rows.flat().every(b => /^project:[a-f0-9]{16}:\d+$/.test(b.callback_data || '')))
        return false;
      panel = this.inbox.data.panels[id] = { view: 'projects', sentAt: message.date ? message.date * 1000 : undefined };
    }
    panel.dismissedAt ||= this.inbox.now(); panel.expiresAt = 0;
    panel.cleanup ||= { sentAt: panel.sentAt };
    if (String(this.inbox.data.homePanelId) === id) delete this.inbox.data.homePanelId;
    this.store.save();
    await this.cleanupPanel(id);
    return true;
  }
  cleanupPanel(id) {
    const key = 'panel:' + id;
    if (this.cleaning.has(key)) return this.cleaning.get(key);
    const pending = (async () => {
      // Dismissal blocks new edits. Let every earlier edit settle before a
      // fallback closure, so an old refresh cannot restore its controls.
      await Promise.allSettled([...(this.panelEdits.get(id) || [])]);
      return cleanupPanel(this, id);
    })().finally(() => this.cleaning.delete(key));
    this.cleaning.set(key, pending); return pending;
  }
  async callback(q) {
    const action = String(q.data).slice(4), [verb, value] = action.split(':');
    if (verb === 'answer') return this.answer(q, action);
    if (verb === 'clean') return this.runCleanup(q, value, action.split(':')[2]);
    if (action === 'home') {
      const selected = this.clearReplyDestination();
      try { await this.a.telegram.call('answerCallbackQuery', { callback_query_id: q.id }); }
      catch { /* The callback receipt cannot change the owner's Home selection. */ }
      const panel = this.inbox.data.panels[String(q.message?.message_id)];
      if (panel?.dismissedAt) return this.open('home');
      return !panel && selected
        ? this.open('home', undefined, q.message?.message_id) : this.open('home', q.message);
    }
    await this.a.telegram.call('answerCallbackQuery', { callback_query_id: q.id });
    if (verb === 'close') return this.dismissPanel(q.message);
    if (verb === 'hide') return this.housekeeping.dismiss(q.message?.message_id);
    if (this.inbox.data.panels[String(q.message?.message_id)]?.dismissedAt) return;
    if (verb === 'item') return this.item(value);
    if (verb === 'snooze') { this.inbox.snooze(value); return this.open('snoozed:0', q.message); }
    if (verb === 'review') {
      if (this.inbox.review(value)) await this.refreshChoiceMarkup(this.inbox.get(value));
      return this.refreshClosedInboxPanels();
    }
    if (verb === 'projects' && /^projects(?::\d+)?$/.test(action)) return this.open(action, q.message);
    const settings = this.inbox.data.settings;
    const panel = this.inbox.data.panels[String(q.message?.message_id)];
    const setting = ['notify', 'mode', 'quiet', 'urgent', 'detail', 'mute'].includes(verb);
    if (setting) {
      if (!panel || panel.dismissedAt || panel.view !== 'settings' || panel.expiresAt <= this.inbox.now()) return this.open('settings', q.message);
      if (verb === 'notify') this.activity.setMode(value);
      if (verb === 'mode' && ['immediate', 'silent', 'digest', 'inbox'].includes(value)) settings.routine = value;
      if (verb === 'quiet' && ['on', 'off'].includes(value)) settings.quiet = value === 'on';
      if (verb === 'urgent' && ['on', 'off'].includes(value)) settings.urgentDuringQuiet = value === 'on';
      if (verb === 'detail' && ['brief', 'full'].includes(value)) settings.detail = value;
      if (verb === 'mute' && ['on', 'off'].includes(value)) {
        // Bind project settings to the project displayed when the menu opened.
        const projectId = panel.projectId;
        if (projectId !== (this.store.data.selectedProjectId || 'general')) return this.open('settings', q.message);
        settings.mutedProjects = settings.mutedProjects.filter(p => p !== projectId);
        if (value === 'on') settings.mutedProjects.push(projectId);
      }
      this.store.save(); return this.open('settings', q.message);
    }
    return this.open(action, q.message);
  }
  choiceMessages(item) {
    return notificationIds(this, item)
      .filter(id => !item.mediaMessageIds?.includes(id)).slice(-20);
  }
  async markBridgeReplySent(messageId) {
    const item = Object.values(this.inbox.data.items).find(item => item.source === 'bridge' &&
      !['input', 'approval'].includes(item.kind) && notificationIds(this, item).includes(String(messageId)));
    if (!item) return;
    item.replySentAt = this.inbox.now(); this.store.save();
    await this.refreshChoiceMarkup(item); await this.refreshClosedInboxPanels();
  }
  async answer(q, action) {
    const match = /^answer:([a-f0-9]{20}):([a-f0-9]{8}):(\d{1,2}):(\d{1,2})$/.exec(action);
    const item = match && this.inbox.get(match[1]);
    if (!item || item.kind !== 'input' || !isOpen(item) || item.route?.nativeWaiting ||
        !this.choiceMessages(item).includes(String(q.message?.message_id)))
      return this.confirm(q, 'That question is no longer available here. Open /inbox for current requests.');
    const [, , revision, rawQuestion, rawOption] = match;
    const questionIndex = Number(rawQuestion), optionIndex = Number(rawOption);
    const question = item.choiceQuestions?.find(question => question.index === questionIndex);
    if (!question || revision !== choiceRevision(item.choiceQuestions) || question.options[optionIndex] === undefined)
      return this.confirm(q, 'Those choices have changed. Open /inbox for the current question.');
    if (item.answerSubmissionId || item.replySentAt || item.answeredQuestionIndexes?.includes(questionIndex) || item.choiceSubmissions?.[questionIndex])
      return this.confirm(q, 'An answer was already sent or is awaiting confirmation. Check /inbox; nothing was sent again.');
    const answer = question.options[optionIndex], requestId = 'choice:' + q.id;
    const claim = { requestId, answer, status: 'sending', at: this.inbox.now() };
    item.choiceSubmissions ||= {}; item.choiceSubmissions[questionIndex] = claim; this.store.save();
    const execute = async () => {
      let nativeAttempted = false;
      try {
        this.a.assertRunning();
        let remaining = 0;
        if (item.source === 'desktop') {
          if (!this.a.desktop) throw new Error('Desktop connection is unavailable.');
          const result = await this.a.desktop.reply(item.route, answer, requestId, [], { revision, questionIndex, optionIndex });
          remaining = result.remaining || 0;
        } else {
          const pending = this.a.pending.get(item.questionKey);
          const current = pending?.params.questions.find(question => question.id === item.questionId);
          if (!current || pending.answers?.[item.questionId] || choiceRevision(questionChoices({ questions: [current] })) !== revision)
            throw new Error('That native question expired, changed, or was already answered.');
          nativeAttempted = true;
          remaining = await this.a.answerQuestion({ key: item.questionKey, questionId: item.questionId }, answer);
        }
        if ((!remaining || item.source === 'bridge') && notificationIds(this, item).includes(this.inbox.data.nextReplyMessageId))
          this.clearReplyDestination();
        claim.status = remaining ? 'saved' : 'submitted'; this.store.save();
        await this.confirm(q, remaining ? `Saved: ${answer}. ${remaining} more ${remaining === 1 ? 'answer' : 'answers'} needed.` : `Sent to ${this.forDisplay(item).displayLabel || item.label || 'the original conversation'}.`);
      } catch (error) {
        const submitted = this.store.data.desktopSubmissions?.[requestId];
        if (!['saved', 'submitted'].includes(claim.status)) {
          if (submitted || nativeAttempted) claim.status = submitted?.status === 'submitted' ? 'submitted' : 'unknown';
          else delete item.choiceSubmissions[questionIndex]; // No submission was attempted; a read failure can be retried.
        }
        this.store.save();
        try { await this.a.send(`Your choice could not be confirmed: ${redact(error.message, [this.a.telegram.token])}\nNothing was sent to another project. Check /inbox before retrying.`); } catch {}
      } finally {
        await this.refreshChoiceMarkup(item);
        if (item.source === 'bridge') await this.flush(); else await this.refreshClosedInboxPanels();
      }
    };
    // Native input unblocks its waiting job, so it must bypass queued starts.
    if (item.source === 'bridge') return execute();
    this.a.serial = this.a.serial.catch(() => {}).then(execute);
  }
  async refreshChoiceMarkup(item, limit = 20) {
    if (item.replySentAt && item.notificationMessages?.[this.inbox.data.nextReplyMessageId])
      this.clearReplyDestination();
    if (!isVisible(item)) {
      // An expired question can still have an answer in the owner's composer.
      // Keep its identity until Home so that answer cannot fall through to Auto.
      if (item.kind !== 'input' && item.notificationMessages?.[this.inbox.data.nextReplyMessageId]) this.clearReplyDestination();
      if (this.cleaning.has(item.id)) return 0;
      const pending = cleanupNotification(this, item, limit).finally(() => this.cleaning.delete(item.id));
      this.cleaning.set(item.id, pending); return pending;
    }
    if (!item.choiceQuestions?.some(q => q.options.length)) return 0;
    const keyboard = this.buttons(item), body = this.questionText(item), signature = JSON.stringify([keyboard, body]);
    item.choiceMarkup ||= {};
    let count = 0;
    for (const id of this.choiceMessages(item)) {
      const previous = item.choiceMarkup[id];
      if (previous?.signature === signature || previous?.retryAt > this.inbox.now()) continue;
      if (count >= limit) break;
      count++;
      try {
        const selected = this.inbox.data.nextReplyMessageId === id && isVisible(item) && !item.answerSubmissionId;
        const payload = { chat_id: this.store.data.owner.chatId, message_id: Number(id), reply_markup: {
          inline_keyboard: selected ? [...keyboard.inline_keyboard, [homeButton]] : keyboard.inline_keyboard,
          ...(item.notificationMessages?.[id]?.forceReply ? { force_reply: true } : {}) } };
        // Preserve multipart and legacy boundaries while a question is open.
        // Closed copies become short notices regardless of their former size.
        if (body && body.length <= 3900 && (!isOpen(item) || previous?.multipart === false)) await this.a.telegram.call('editMessageText', {
          ...payload, text: redact(body, [this.a.telegram.token]), link_preview_options: { is_disabled: true } });
        else await this.a.telegram.call('editMessageReplyMarkup', payload);
        item.choiceMarkup[id] = { ...previous, signature };
      } catch (error) {
        item.choiceMarkup[id] = { ...previous, signature: previous?.signature,
          retryAt: this.inbox.now() + Math.max(60_000, (error.retryAfter || 0) * 1000) };
      }
      this.store.save();
    }
    return count;
  }
  syncJobs() {
    for (const job of Object.values(this.store.data.jobs)) if (['failed', 'uncertain', 'interrupted'].includes(job.status)) {
      this.inbox.observe('job-check:' + job.id, { source: 'bridge', kind: 'failure', jobId: job.id,
        label: job.project || 'General', text: `${job.project || 'General'} — needs checking\n\n${job.recoveryNote || job.output || 'The task ' + job.status + '. Inspect its current state before continuing.'}\n\nMarking this reviewed only clears the inbox; it does not stop, replay or release the task.` });
    }
  }
  async refreshClosedInboxPanels(limit = 2) {
    const closed = Object.values(this.inbox.data.items).filter(item => !isVisible(item));
    let count = 0;
    for (const [id, panel] of Object.entries(this.inbox.data.panels).reverse()) {
      if (count >= limit) break;
      const now = this.inbox.now();
      if (panel.dismissedAt || !/^(attention|snoozed|updates):\d+$/.test(panel.view) || panel.expiresAt <= now || panel.retryAt > now) continue;
      // Only refresh lists that still visibly reference a closed request.
      // Never turn a question/reply target or a settings panel into an inbox.
      if (!closed.some(item => panel.signature?.includes('ctl:item:' + item.id))) continue;
      count++;
      const expectedView = panel.view;
      try {
        await this.queuePanel(async () => {
          // A queued refresh must not restore a view the owner navigated away
          // from while a preceding Home edit was still in flight.
          if (panel.dismissedAt || panel.view !== expectedView || panel.expiresAt <= this.inbox.now()) return;
          if (!closed.some(item => panel.signature?.includes('ctl:item:' + item.id))) return;
          await this.show(expectedView, { message_id: Number(id) });
        });
        delete panel.retryAt;
      } catch (error) {
        panel.retryAt = this.inbox.now() + Math.max(60_000, (error.retryAfter || 0) * 1000);
      }
      this.store.save();
    }
  }
  flush() {
    if (this.flushing || this.a.stopping) return this.flushing || Promise.resolve();
    this.flushing = this.flushNow().finally(() => { this.flushing = null; }); return this.flushing;
  }
  startCleanup() {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => {
      this.flushCleanup().catch(() => {});
      this.flushHeld().catch(() => {});
    }, 2000);
    this.cleanupTimer.unref?.();
  }
  stopCleanup() { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
  flushCleanup() {
    if (this.cleanupPending || this.a.stopping) return this.cleanupPending || Promise.resolve();
    this.cleanupPending = this.cleanupNow().finally(() => { this.cleanupPending = null; });
    return this.cleanupPending;
  }
  async cleanupNow() {
    let edits = 0;
    const routes = this.store.data.messageRoutes || {};
    const expired = Object.keys(routes).filter(key => routes[key].expiresAt <= this.inbox.now());
    if (expired.length) {
      for (const key of expired) {
        if (!routes[key].claimed) this.housekeeping.endUnsent(routes[key].messageId, 'expired');
        this.housekeeping.record({ message_id: routes[key].panelId }, 'help', { clearAfter: this.inbox.now() });
        delete routes[key];
      }
      this.store.save();
    }
    await this.housekeeping.flush();
    for (const [id, panel] of Object.entries(this.inbox.data.panels).reverse()) {
      if (edits >= 2) break;
      if (panel.dismissedAt && panel.cleanup) edits += await this.cleanupPanel(id);
    }
    for (const item of Object.values(this.inbox.data.items).sort((a,b) =>
      (b.reviewedAt || b.replySentAt || b.resolvedAt || b.observedAt || b.createdAt) - (a.reviewedAt || a.replySentAt || a.resolvedAt || a.observedAt || a.createdAt))) {
      if (edits >= 3) break;
      edits += await this.refreshChoiceMarkup(item, 3 - edits);
    }
    await this.refreshClosedInboxPanels();
  }
  flushHeld() {
    if (this.heldPending || this.a.stopping) return this.heldPending || Promise.resolve();
    this.heldPending = this.releaseHeldNow().finally(() => { this.heldPending = null; });
    return this.heldPending;
  }
  async releaseHeldNow() {
    let sent = 0;
    for (const item of Object.values(this.inbox.data.items).sort((a, b) => Number(needsAttention(b)) - Number(needsAttention(a)) || b.createdAt - a.createdAt)) {
      if (item.delivery !== 'held') continue;
      if (!isVisible(item)) {
        item.delivery = 'inbox'; this.store.data.notices[item.key] = 'inbox'; this.store.save(); continue;
      }
      if (this.suppressOld(item)) continue;
      if (sent >= 1 || this.a.stopping || this.activity.blocks(item) || item.snoozedUntil > this.inbox.now()) continue;
      // Releasing a held alert requires a recent observation of that source,
      // so an unavailable history cannot resurrect an already answered request.
      if (this.inbox.now() - item.observedAt >= 120_000) continue;
      sent++;
      const reminder = item.reminder === 'pending';
      if (reminder) { item.reminder = 'sending'; this.store.save(); }
      try { await this.notify(item, undefined, undefined, { heldRelease: true }); }
      catch { /* An unknown outcome stays claimed and is never replayed. */ }
      if (reminder) item.reminder = ['delivered', 'unknown'].includes(item.delivery) ? item.delivery :
        isVisible(item) ? 'pending' : 'cancelled';
      this.store.data.notices[item.key] = item.delivery; this.store.save();
    }
  }
  async flushNow() {
    const now = this.inbox.now();
    await this.flushCleanup();
    // Only a still-fresh observation justifies a reminder that needs action.
    const fresh = this.a.desktop?.health?.status === 'connected' && now - Date.parse(this.a.desktop.health.lastScanAt) < 120_000;
    for (const item of Object.values(this.inbox.data.items)) if (fresh && item.delivery !== 'held' && !this.activity.blocks(item) && now - item.observedAt < 120_000 && isVisible(item) && item.reminder === 'pending' && item.snoozedUntil <= now) {
      item.reminder = 'sending'; this.store.save();
      const text = `Reminder · ${this.questionText(item) || item.text}`;
      const multipart = splitText(redact(text, [this.a.telegram.token])).length > 1;
      try { await this.a.send(text, item.jobId, this.buttons(item), m => this.record(item, m, { multipart }),
        { silent: this.inbox.quietNow() && !this.inbox.data.settings.urgentDuringQuiet }); item.reminder = 'delivered'; }
      catch { item.reminder = 'unknown'; }
      this.store.save();
    }
    if (this.inbox.quietNow()) return;
    const queued = Object.values(this.inbox.data.items).filter(item => item.delivery === 'digest');
    for (const item of queued) if (!isVisible(item) || this.inbox.policy(item) === 'inbox') item.delivery = 'inbox';
    this.store.save();
    let due = queued.filter(item => item.delivery === 'digest' && !this.activity.blocks(item) &&
      (item.source !== 'desktop' || now - item.observedAt < 120_000));
    // The first due item releases the whole eligible batch. Staggered updates
    // must not turn into one notification per arrival an hour later.
    if (!due.some(item => item.digestAt <= now)) return;
    // Keep the hourly trigger even if its oldest entry has aged out. The
    // resulting digest contains only recent entries, never the old backlog.
    due = due.filter(item => !this.suppressOld(item));
    if (!due.length) return;
    for (const item of due) item.delivery = 'sending'; this.store.save();
    try {
      await this.panel(`Your updates · ${due.length}\n\n${due.slice(0, 8).map(i => short(this.forDisplay(i).displayLabel || i.label, 110)).join('\n')}\n\nOpen Updates for details and to reply to the right conversation.`,
        { inline_keyboard: [[button('Updates', 'updates:0'), button('Needs attention', 'attention:0')]] }, undefined, 'digest',
        { silent: this.inbox.data.settings.routine === 'silent' });
      for (const item of due) item.delivery = 'delivered';
    } catch { for (const item of due) item.delivery = 'unknown'; }
    this.store.save();
  }
  async introduce() {
    if (!this.store.data.owner || this.inbox.data.announcement || this.a.stopping) return;
    // Persist the claim before sending. An uncertain send is never replayed.
    this.inbox.data.announcement = 'sending'; this.store.save();
    try { await this.open('home'); this.inbox.data.announcement = 'delivered'; }
    catch { this.inbox.data.announcement = 'unknown'; }
    this.store.save();
  }
}
