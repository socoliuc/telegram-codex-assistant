import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareImages } from '../src/outgoing-images.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7x0AAAAASUVORK5CYII=', 'base64');
test('outgoing images use explicit embeds, full text, source roots, safe names and deduplication', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-outgoing-'));
  try {
    const path = join(dir, 'proof (one).png'); writeFileSync(path, png);
    const embed = `![Proof](<${path}>)`;
    const text = 'x'.repeat(900) + '\n' + embed + '\n' + embed + '\n' + '`![Example](not-real.png)`';
    const result = await prepareImages(text, [dir]);
    assert.equal(result.images.length, 1); assert.deepEqual(result.images[0].bytes, png);
    assert.equal(result.images[0].kind, 'photo'); assert.match(result.text, /Image: Proof/);
    assert.ok(!result.text.includes(path)); assert.match(result.text, /not-real\.png/);
    assert.equal(result.skipped, 0);
    const examples = '```md\n' + embed + '\n```\n' + embed + '\n\\' + embed;
    const mixed = await prepareImages(examples, [dir]);
    assert.equal(mixed.images.length, 1);
    assert.equal(mixed.text, '```md\n' + embed + '\n```\nImage: Proof\n\\' + embed);
    const code = '    ' + embed + '\n\t' + embed + '\n``' + embed + '``\n````md\n```\n' + embed + '\n```\n````\n' +
      '~~~\n' + embed + '\n~~~~\n' + '``multiline\n' + embed + '\n``';
    const examplesOnly = await prepareImages(code, [dir]);
    assert.equal(examplesOnly.images.length, 0); assert.equal(examplesOnly.referenced, 0);
    assert.equal(examplesOnly.text, code);
    assert.equal((await prepareImages('````md\n' + embed + '\n```\n' + embed, [dir])).referenced, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('missing, secret, outside-root, junction, fake, oversized and remote images never upload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-outgoing-'));
  try {
    const root = join(dir, 'project'), outside = join(dir, 'other'); mkdirSync(root); mkdirSync(outside);
    mkdirSync(join(root, '.secure')); writeFileSync(join(root, '.secure', 'private.png'), png);
    writeFileSync(join(outside, 'outside.png'), png); writeFileSync(join(root, 'fake.png'), 'not an image');
    symlinkSync(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    const refs = ['missing.png', '.secure/private.png', 'fake.png', 'linked/outside.png', join(outside, 'outside.png'),
      'https://example.com/image.png', '\\\\server\\share\\image.png'];
    const result = await prepareImages(refs.map(p => `![Example](<${p}>)`).join('\n'), [root]);
    assert.equal(result.images.length, 0); assert.equal(result.skipped, refs.length);
    writeFileSync(join(root, 'large.png'), png);
    assert.equal((await prepareImages('![Large](large.png)', [root], { maxBytes: 10 })).images.length, 0);
    assert.equal((await prepareImages(`![No root](<${join(root, 'large.png')}>)`, [])).images.length, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('photo geometry limits fall back to files, and attachment count/total bytes are bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-outgoing-'));
  try {
    const wide = Buffer.from(png); wide.writeUInt32BE(300, 16); writeFileSync(join(dir, 'wide.png'), wide);
    const result = await prepareImages('![Wide](wide.png)', [dir]);
    assert.equal(result.images[0].kind, 'document');
    for (let n = 0; n < 11; n++) writeFileSync(join(dir, `${n}.png`), png);
    const text = Array.from({ length: 11 }, (_, n) => `![${n}](${n}.png)`).join('\n');
    assert.equal((await prepareImages(text, [dir])).images.length, 10);
    assert.equal((await prepareImages(text, [dir], { totalBytes: png.length * 2 })).images.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
