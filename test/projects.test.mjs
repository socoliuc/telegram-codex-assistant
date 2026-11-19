import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverProjects, projectForChat } from '../src/projects.mjs';

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
    const file = join(dir, 'not-a-project'); writeFileSync(file, 'file');
    writeFileSync(join(dir, '.codex-global-state.json'), JSON.stringify({ 'local-projects': {
      existing: { id: 'existing', name: 'Existing source', rootPaths: [source] },
      notDirectory: { id: 'file', name: 'File', rootPaths: [file] }
    } }));
    assert.equal(discoverProjects(dir, options).length, 1, 'do not duplicate an already registered source folder');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('configured local roots provide project routing without desktop project discovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'telegram-local-projects-'));
  try {
    const alpha = join(dir, 'alpha'); mkdirSync(alpha);
    const nested = join(alpha, 'nested'); mkdirSync(nested);
    const beta = join(dir, 'beta'); mkdirSync(beta);
    const rootFile = join(dir, 'not-a-project'); writeFileSync(rootFile, 'file');
    const projects = discoverProjects(join(dir, 'codex-home'), { projects: [
      { name: 'Alpha', root: alpha }, { name: 'Nested', root: nested }, { name: 'Beta', root: beta },
      { name: 'Relative ignored', root: '.' }, { name: 'Missing ignored', root: join(dir, 'missing') },
      { name: 'File ignored', root: rootFile }
    ] });
    assert.deepEqual(projects.map(project => project.name), ['Alpha', 'Nested', 'Beta']);
    assert.equal(projectForChat(projects, nested), projects.find(project => project.name === 'Nested'));
    assert.equal(projectForChat(projects, beta), projects.find(project => project.name === 'Beta'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
