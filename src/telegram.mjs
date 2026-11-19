import { redact, splitText } from './core.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function telegramImage(message) {
  if (message.photo?.length) return message.photo.reduce((a, b) =>
    (b.width || 0) * (b.height || 0) > (a.width || 0) * (a.height || 0) ? b : a);
  const file = message.document;
  if (file && (/^image\/(jpeg|png|webp)$/i.test(file.mime_type || '') ||
      ((!file.mime_type || file.mime_type === 'application/octet-stream') && /\.(jpe?g|png|webp)$/i.test(file.file_name || '')))) return file;
  return null;
}

export function imageExtension(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  throw new Error('Send a valid JPEG, PNG or WebP image.');
}

export class Telegram {
  constructor(token, { baseUrl = 'https://api.telegram.org' } = {}) {
    this.token = token;
    this.baseUrl = baseUrl;
    this.abort = new AbortController();
  }
  async call(method, payload = {}) {
    let response;
    const multipart = payload instanceof FormData;
    try {
      response = await fetch(`${this.baseUrl}/bot${this.token}/${method}`, {
        method: 'POST', ...(multipart ? {} : { headers: { 'Content-Type': 'application/json' } }),
        body: multipart ? payload : JSON.stringify(payload), signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(method === 'getUpdates' ? 40_000 : multipart ? 60_000 : 20_000)])
      });
    } catch { throw new Error(`Telegram ${method}: connection failed; outcome may be unknown.`); }
    let data;
    try { data = await response.json(); } catch { throw new Error(`Telegram ${method}: invalid response (${response.status}).`); }
    if (!response.ok || !data.ok) {
      const error = new Error(`Telegram ${method} failed (${data.error_code ?? response.status}).`);
      error.retryAfter = data.parameters?.retry_after;
      error.code = data.error_code ?? response.status;
      // Classify a small allowlist without exposing raw API descriptions.
      const description = String(data.description || '').toLowerCase();
      if (description.includes('message to delete not found') || description.includes('message to edit not found')) error.telegramReason = 'message-missing';
      else if (description.includes("message can't be deleted")) error.telegramReason = 'message-cannot-delete';
      else if (description.includes('message is not modified')) error.telegramReason = 'message-unchanged';
      throw error;
    }
    return data.result;
  }
  close() { this.abort.abort(); }
  async downloadImage(image, directory, { maxBytes = 20 * 1024 * 1024 } = {}) {
    const checkSize = size => { if (size > maxBytes) throw new Error('Image exceeds the download size limit (20 MB).'); };
    checkSize(image.file_size);
    const file = await this.call('getFile', { file_id: image.file_id });
    checkSize(file.file_size);
    if (typeof file.file_path !== 'string' || !/^[a-zA-Z0-9_./-]+$/.test(file.file_path) ||
        file.file_path.split('/').some(part => !part || part === '.' || part === '..'))
      throw new Error('Telegram returned an invalid image path.');
    let bytes;
    try {
      const response = await fetch(`${this.baseUrl}/file/bot${this.token}/${file.file_path}`, {
        redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(30_000)])
      });
      if (!response.ok || !response.body) throw new Error('download failed');
      checkSize(Number(response.headers.get('content-length')));
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { size += chunk.length; checkSize(size); chunks.push(chunk); }
      bytes = Buffer.concat(chunks);
    } catch { throw new Error('Image download failed or exceeded 20 MB. No task was submitted.'); }
    const extension = imageExtension(bytes);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${randomUUID()}.${extension}`);
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    return path;
  }
  async send(chatId, text, replyMarkup, onDelivered, { silent = false } = {}) {
    const sent = [];
    for (const chunk of splitText(redact(text, [this.token]))) {
      const message = await this.call('sendMessage', {
        chat_id: chatId, text: chunk, link_preview_options: { is_disabled: true }, disable_notification: silent,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {})
      });
      sent.push(message);
      await onDelivered?.(message);
    }
    return sent;
  }
  async sendImages(chatId, images, label, replyTo, onDelivered) {
    if (!images.length) return [];
    if (images.length > 10) throw new Error('Too many images in one update.');
    const groups = [];
    for (const image of images) {
      if (!groups.length || groups.at(-1)[0].kind !== image.kind) groups.push([]);
      groups.at(-1).push(image);
    }
    const sent = [];
    for (const group of groups) {
      const form = new FormData();
      form.set('chat_id', String(chatId)); form.set('disable_notification', 'true');
      if (replyTo) form.set('reply_parameters', JSON.stringify({ message_id: replyTo }));
      const media = group.map((image, index) => {
        const field = group.length === 1 ? image.kind : 'image' + index;
        form.set(field, new Blob([image.bytes], { type: image.extension === 'jpg' ? 'image/jpeg' : 'image/' + image.extension }), image.filename);
        const caption = splitText(redact(`${label}\n${image.alt}\nReply to this image to continue in its original conversation.`, [this.token]), 1000)[0];
        if (group.length === 1) form.set('caption', caption);
        return { type: image.kind, media: 'attach://' + field, caption };
      });
      if (group.length > 1) form.set('media', JSON.stringify(media));
      const result = await this.call(group.length > 1 ? 'sendMediaGroup' : group[0].kind === 'photo' ? 'sendPhoto' : 'sendDocument', form);
      const messages = group.length === 1 ? [result] : result;
      if (!Array.isArray(messages) || messages.length !== group.length || messages.some(m => !Number.isSafeInteger(m?.message_id)))
        throw new Error('Telegram image delivery returned an unexpected result; outcome may be unknown.');
      for (const message of messages) { sent.push(message); await onDelivered?.(message); }
    }
    return sent;
  }
}
