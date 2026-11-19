import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects } from '../src/projects.mjs';

test('authorized desktop access exposes the real assistant source without editing desktop project state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-projects-'));
  try {
    const source = join(dir, 'assistant'); mkdirSync(source);
    const options = { executionAccess: 'desktop-full-access', assistantRoot: source };
    assert.deepEqual(discoverProjects(dir), []);
    const added = discoverProjects(dir, options);
    assert.equal(added.length, 1);
    assert.equal(added[0].name, 'Telegram Codex Assistant');
    assert.equal(added[0].roots[0], source);
    writeFileSync(join(dir, '.codex-global-state.json'), JSON.stringify({ 'local-projects': {
      existing: { id: 'existing', name: 'Existing source', rootPaths: [source] }
    } }));
    assert.equal(discoverProjects(dir, options).length, 1, 'do not duplicate an already registered source folder');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
