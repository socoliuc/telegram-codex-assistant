import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isWithinRoots, pathKey, redact } from './core.mjs';
import { imageExtension } from './telegram.mjs';

export function imageReferences(text) {
  // Keep positions stable while ignoring examples inside fenced/inline code.
  let fence;
  let visible = String(text).replace(/[^\n]*(?:\n|$)/g, line => {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/m);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence[0] && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = null;
      return ' '.repeat(line.length);
    }
    if (delimiter) { fence = delimiter[1]; return ' '.repeat(line.length); }
    if (/^(?: {4}|\t)/.test(line)) return ' '.repeat(line.length);
    return line;
  });
  const runs = [...visible.matchAll(/`+/g)];
  for (let i = 0; i < runs.length; i++) {
    const close = runs.findIndex((run, j) => j > i && run[0].length === runs[i][0].length);
    if (close < 0) continue;
    const start = runs[i].index, end = runs[close].index + runs[close][0].length;
    visible = visible.slice(0, start) + ' '.repeat(end - start) + visible.slice(end);
    i = close;
  }
  return [...visible.matchAll(/(?<!\\)!\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:[^()\n]|\([^()\n]*\))+?))\s*\)/g)]
    .map(m => ({ index: m.index, markup: String(text).slice(m.index, m.index + m[0].length), alt: m[1], source: (m[2] || m[3]).trim() }));
}

export function renderAttachedImages(text, sources) {
  let rendered = String(text);
  for (const ref of imageReferences(text).filter(r => sources.includes(r.source)).reverse()) rendered = rendered.slice(0, ref.index) +
    `Image: ${redact(ref.alt || 'attached image')}` + rendered.slice(ref.index + ref.markup.length);
  return rendered;
}

function localPath(source, root) {
  let value = source.replace(/\s+["'][^"']*["']$/, '');
  if (/^file:/i.test(value)) {
    const url = new URL(value);
    if (url.hostname || url.search || url.hash) throw new Error('Non-local file reference');
    value = fileURLToPath(url);
  } else {
    if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error('Non-local image');
    value = decodeURIComponent(value);
  }
  if (/^\/[a-z]:\//i.test(value)) value = value.slice(1);
  if (/^[\\/]{2}|\0/.test(value) || value.replace(/^[a-z]:/i, '').includes(':') || /[?#]/.test(value)) throw new Error('Unsupported path');
  if (!/\.(?:jpe?g|png|webp)$/i.test(value)) throw new Error('Unsupported image type');
  return path.resolve(root, value);
}

function dimensions(bytes, extension) {
  if (extension === 'png' && bytes.length >= 24 && bytes.toString('ascii', 12, 16) === 'IHDR')
    return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
  if (extension === 'jpg') {
    let offset = 2;
    while (offset + 4 <= bytes.length && bytes[offset] === 255) {
      const marker = bytes[offset + 1]; offset += 2;
      if (marker === 217 || marker === 218) break;
      if (marker === 255 || (marker >= 208 && marker <= 215)) continue;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7)
        return [bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)];
      offset += length;
    }
  }
  return null;
}

const privateFolder = value => /(?:^|[\\/])(?:\.secure|\.ssh|\.aws|\.azure|\.git|credentials)(?:[\\/]|$)/i.test(value);
export async function prepareImages(text, roots, { maxBytes = 20 * 1024 * 1024, totalBytes = 50 * 1024 * 1024, currentRoots } = {}) {
  const refs = imageReferences(text), images = [], seen = new Map(), replacements = [];
  const canonicalize = async paths => (await Promise.all(paths.map(root => realpath(root).catch(() => null)))).filter(Boolean);
  const [canonicalRoots, current] = await Promise.all([canonicalize(roots || []), currentRoots && canonicalize(currentRoots)]);
  let skipped = 0, used = 0;
  for (const ref of refs) {
    let file;
    try {
      if (!canonicalRoots.length) throw new Error('No source root');
      const candidate = localPath(ref.source, canonicalRoots[0]);
      if (privateFolder(candidate)) throw new Error('Private folder');
      const canonical = await realpath(candidate), key = pathKey(canonical);
      if (privateFolder(canonical) || !isWithinRoots(canonical, canonicalRoots) || (current && !isWithinRoots(canonical, current)))
        throw new Error('Outside source roots');
      if (seen.has(key)) { replacements.push(ref); continue; }
      if (images.length >= 10) throw new Error('Image count limit');
      file = await open(canonical, 'r');
      const stat = await file.stat();
      if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes || used + stat.size > totalBytes) throw new Error('Image size limit');
      // Read at most the checked size, even if a file grows during this read.
      const bytes = Buffer.alloc(stat.size); let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!read.bytesRead) throw new Error('Image changed while reading');
        offset += read.bytesRead;
      }
      const extension = imageExtension(bytes), size = dimensions(bytes, extension);
      if (extension !== 'webp' && (!size || !size.every(n => n > 0))) throw new Error('Invalid image dimensions');
      const photo = size && bytes.length <= 10 * 1024 * 1024 && size[0] + size[1] <= 10000 && Math.max(...size) / Math.min(...size) <= 20;
      images.push({ bytes, extension, kind: photo ? 'photo' : 'document', alt: redact(ref.alt || 'Image'),
        filename: `image-${images.length + 1}.${extension}` });
      seen.set(key, true); used += bytes.length;
      replacements.push(ref);
    } catch { skipped++; }
    finally { await file?.close(); }
  }
  const sources = [...new Set(replacements.map(r => r.source))];
  return { images, text: renderAttachedImages(text, sources), sources, skipped, referenced: refs.length };
}
