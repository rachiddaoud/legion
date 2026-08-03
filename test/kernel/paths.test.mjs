// Guards the v3 path layout invariants: LEGION_HOME read lazily at CALL time (env is
// set AFTER import — a module-load cache would fail these), default home = ~/.legion
// (PLAN-V3, not the v2 engine-root), dossier composition, and safeSegment as the
// traversal guard on every builder. Hermetic: LEGION_HOME saved/restored around the file.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  safeSegment, legionHome, orgsRoot, orgDir, projectsDir, projectDir,
  featuresDir, featureDir, projectsIndexPath, ensureDir,
} from '../../src/kernel/paths.mjs';

const SAVED = process.env.LEGION_HOME;
let HOME;
before(() => { HOME = mkdtempSync(join(tmpdir(), 'legion3-paths-')); });
after(() => {
  if (SAVED === undefined) delete process.env.LEGION_HOME;
  else process.env.LEGION_HOME = SAVED;
  rmSync(HOME, { recursive: true, force: true });
});

test('LEGION_HOME is read lazily — env set after import roots every builder', () => {
  process.env.LEGION_HOME = HOME; // AFTER import: proves no module-load caching
  assert.equal(legionHome(), HOME);
  assert.equal(orgsRoot(), join(HOME, 'orgs'));
  assert.equal(orgDir('acme'), join(HOME, 'orgs', 'acme'));
  assert.equal(projectsDir('acme'), join(HOME, 'orgs', 'acme', 'projects'));
  assert.equal(projectDir('acme', 'cv-mf'), join(HOME, 'orgs', 'acme', 'projects', 'cv-mf'));
  assert.equal(featuresDir('acme', 'cv-mf'), join(HOME, 'orgs', 'acme', 'projects', 'cv-mf', 'features'));
  assert.equal(projectsIndexPath(), join(HOME, 'projects.json'));
});

test('without LEGION_HOME the default home is ~/.legion (v3, not engine root)', () => {
  delete process.env.LEGION_HOME;
  assert.equal(legionHome(), join(homedir(), '.legion'));
  process.env.LEGION_HOME = HOME;
});

// A relative LEGION_HOME would root the home at the invoking cwd and persist relative
// paths into the durable projects.json index — rejected loudly, never resolve()d.
test('relative LEGION_HOME is rejected loudly', () => {
  for (const bad of ['../home', 'home', './legion', '.']) {
    process.env.LEGION_HOME = bad;
    assert.throws(() => legionHome(), /LEGION_HOME must be an absolute path/);
    assert.throws(() => projectsIndexPath(), /LEGION_HOME must be an absolute path/);
  }
  process.env.LEGION_HOME = HOME;
});

test('empty LEGION_HOME is rejected loudly — never a silent ~/.legion fallback', () => {
  try {
    process.env.LEGION_HOME = '';
    assert.throws(() => legionHome(), /LEGION_HOME/);
    assert.throws(() => projectsIndexPath(), /LEGION_HOME/);
  } finally {
    process.env.LEGION_HOME = HOME;
  }
});

test('featureDir composes the dossier path', () => {
  process.env.LEGION_HOME = HOME;
  assert.equal(
    featureDir('acme', 'cv-mf', 'f1'),
    join(HOME, 'orgs', 'acme', 'projects', 'cv-mf', 'features', 'f1'),
  );
});

test('safeSegment accepts legitimate ids and returns them', () => {
  for (const ok of ['_fixture-acme', 'a.b-c_1', 'cv-mf', 'F1', '0start']) {
    assert.equal(safeSegment(ok, 'x'), ok);
  }
});

test('safeSegment rejects traversal, separators, hidden, empty, non-strings', () => {
  for (const bad of ['..', '.', 'a/b', 'a\\b', '', '.hidden', null, undefined, 42, {}]) {
    assert.throws(() => safeSegment(bad, 'x'), /invalid x/);
  }
});

test('every builder throws on a traversal segment', () => {
  process.env.LEGION_HOME = HOME;
  assert.throws(() => orgDir('../x'), /invalid org/);
  assert.throws(() => projectDir('acme', '../x'), /invalid project/);
  assert.throws(() => projectsDir('../x'), /invalid org/);
  assert.throws(() => featuresDir('acme', '../x'), /invalid project/);
  assert.throws(() => featureDir('acme', 'cv-mf', '../x'), /invalid feature/);
  assert.throws(() => featureDir('../x', 'cv-mf', 'f1'), /invalid org/);
});

test('ensureDir creates nested paths, returns the path, and is idempotent', () => {
  process.env.LEGION_HOME = HOME;
  const target = featureDir('acme', 'cv-mf', 'f1');
  assert.equal(ensureDir(target), target);
  assert.ok(statSync(target).isDirectory());
  assert.equal(ensureDir(target), target); // second call must not throw
});
