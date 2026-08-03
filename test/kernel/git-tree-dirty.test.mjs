// The DERIVED dirty verdict (kernel/git.mjs header F) at the unit level: worktreeTreeHash /
// worktreeDirt / isWorktreeClean. The CLASS-closing regression proof (three hostile config
// knobs, end-to-end through bin/legion.mjs) lives in test/cli/dirty-check-shape.test.mjs;
// THIS file pins the hazards that the end-to-end path cannot show — that the REAL index and
// worktree are untouched, that no temp index leaks, that an unborn HEAD is decided rather
// than a crash, and where the documented residuals actually sit.
// Every fixture repo is local and hermetic; nothing here touches the network or ~/.legion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyHardenedGitEnv, isWorktreeClean, worktreeDirt, worktreeTreeHash,
} from '../../src/kernel/git.mjs';

// HERMETIC GIT: neuters global/system config and every inherited GIT_* variable, and pins an
// identity so fixture commits work with no ~/.gitconfig.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} (in ${cwd}): ${r.stderr}`);
  return r.stdout.trim();
};
// File-transport submodules are blocked by default since git 2.38; the URL must be absolute.
const shSub = (cwd, ...args) => sh(cwd, '-c', 'protocol.file.allow=always', ...args);

let TMP;
let n = 0;
const dir = (name) => {
  const p = join(TMP, `${name}${n++}`);
  mkdirSync(p, { recursive: true });
  return p;
};
/** A one-commit fixture repo. */
function repo(name = 'r') {
  const p = dir(name);
  sh(p, 'init', '-b', 'main');
  writeFileSync(join(p, 'tracked.txt'), 'x\n');
  sh(p, 'add', '-A');
  sh(p, 'commit', '-m', 'init');
  return p;
}

before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-tree-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

// --- hazard (b): our scratch index, never the repo's ----------------------------------------

test('the REAL index and worktree are untouched, and no temp index survives the call', () => {
  const r = repo('untouched');
  const idxPath = join(r, '.git', 'index');
  const before = { bytes: readFileSync(idxPath), mtimeMs: statSync(idxPath).mtimeMs };
  const fileBefore = readFileSync(join(r, 'tracked.txt'));
  // OUR temp indexes only: sibling test files run in parallel processes and legitimately have
  // their own in flight, so the leak check is scoped to this pid (the name embeds it).
  const mine = () => readdirSync(tmpdir()).filter((f) => f.startsWith(`legion-index-${process.pid}-`));
  assert.deepEqual(mine(), [], 'fixture: no stale temp index before the call');

  writeFileSync(join(r, 'untracked.txt'), 'new\n');
  const d = worktreeDirt(r);
  assert.equal(d.clean, false);

  assert.deepEqual(readFileSync(idxPath), before.bytes, 'the repo index was REWRITTEN');
  assert.equal(statSync(idxPath).mtimeMs, before.mtimeMs, 'the repo index was touched');
  assert.deepEqual(readFileSync(join(r, 'tracked.txt')), fileBefore, 'the worktree was modified');
  assert.deepEqual(mine(), [], 'a temp index (or its .lock) leaked into tmpdir');
  // git itself agrees the repo still sees the file as untracked — nothing was staged.
  assert.match(sh(r, 'status', '--porcelain'), /\?\? untracked\.txt/);
});

test('worktreeTreeHash equals HEAD^{tree} on a clean tree and changes with the content', () => {
  const r = repo('hash');
  assert.equal(worktreeTreeHash(r), sh(r, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(isWorktreeClean(r), true);
  writeFileSync(join(r, 'tracked.txt'), 'modified\n');
  assert.notEqual(worktreeTreeHash(r), sh(r, 'rev-parse', 'HEAD^{tree}'));
  const d = worktreeDirt(r);
  assert.equal(d.clean, false);
  assert.equal(d.headTree, sh(r, 'rev-parse', 'HEAD^{tree}'));
  // (the XY prefix's leading space is eaten by the seam's trim of stdout — cosmetic, and
  // pre-existing: `paths` is a human-readable report, never parsed by anything)
  assert.deepEqual(d.paths, ['M tracked.txt']);
  // and a DELETED tracked file is dirt too (the shape `status`-as-verdict also caught, kept)
  const r2 = repo('deleted');
  rmSync(join(r2, 'tracked.txt'));
  assert.equal(isWorktreeClean(r2), false);
});

// --- hazard (c): no HEAD is DECIDED, never a crash -------------------------------------------

test('unborn HEAD: an empty repo is clean, an unborn repo holding a file is DIRTY', () => {
  const empty = dir('unborn-empty');
  sh(empty, 'init', '-b', 'main');
  const d0 = worktreeDirt(empty);
  assert.equal(d0.clean, true, 'a genuinely empty unborn repo is clean, not a crash');
  assert.equal(d0.treeHash, d0.headTree);

  const withFile = dir('unborn-file');
  sh(withFile, 'init', '-b', 'main');
  writeFileSync(join(withFile, 'a.txt'), 'a\n');
  const d1 = worktreeDirt(withFile);
  assert.equal(d1.clean, false, 'files on an unborn branch are uncommitted work');
  assert.ok(d1.paths.some((p) => p.includes('a.txt')), `paths should name a.txt: ${d1.paths}`);
});

// --- hazard (e): ignored files are NOT dirt (unchanged decision, gate.mjs 12) ------------------

test('a .gitignore-d file reads CLEAN — the documented residual, neither widened nor narrowed', () => {
  const r = repo('ignored');
  writeFileSync(join(r, '.gitignore'), 'build/\n');
  sh(r, 'add', '-A');
  sh(r, 'commit', '-m', 'ignore build');
  mkdirSync(join(r, 'build'));
  writeFileSync(join(r, 'build', 'out.js'), 'compiled\n');
  assert.equal(isWorktreeClean(r), true, 'ignored build output must not block a gate');
});

// --- hazard (f): submodules — the gitlink is covered, its CONTENTS are not ---------------------

/** A superproject with an initialised `sub` submodule at its committed gitlink, plus the
 * inner repo (two commits, so the gitlink can be MOVED). */
function withSubmodule(name) {
  const inner = dir(`${name}-inner`);
  sh(inner, 'init', '-b', 'main');
  writeFileSync(join(inner, 'a.txt'), 'a\n');
  sh(inner, 'add', '-A');
  sh(inner, 'commit', '-m', 'c1');
  writeFileSync(join(inner, 'b.txt'), 'b\n');
  sh(inner, 'add', '-A');
  sh(inner, 'commit', '-m', 'c2');

  const sup = repo(`${name}-super`);
  shSub(sup, 'submodule', 'add', inner, 'sub');
  sh(sup, 'commit', '-m', 'add sub');
  return { sup, inner };
}

test('submodules: a MOVED gitlink is dirty; content INSIDE the submodule is not our tree', () => {
  const { sup } = withSubmodule('sm');
  assert.equal(isWorktreeClean(sup), true, 'fixture: the superproject starts clean');

  // (1) content changed INSIDE the submodule — not in the superproject tree, and not in the
  //     tree any receipt certifies either. Stated in header F(f) as NOT full coverage.
  writeFileSync(join(sup, 'sub', 'a.txt'), 'edited inside the submodule\n');
  assert.equal(isWorktreeClean(sup), true,
    'the superproject tree records a gitlink, not the submodule\'s contents');
  sh(join(sup, 'sub'), 'checkout', '--', 'a.txt');

  // (2) a MOVED gitlink IS in the superproject tree — the case submodule.<name>.ignore=all hid.
  sh(join(sup, 'sub'), 'checkout', 'HEAD~1');
  const d = worktreeDirt(sup);
  assert.equal(d.clean, false, 'a moved submodule HEAD changes the superproject tree');
  assert.ok(d.paths.some((p) => p.includes('sub')), `paths should name sub: ${d.paths}`);
});

test('an UNINITIALISED submodule in a linked worktree reads DIRTY and the trees name it', () => {
  // `git worktree add` does NOT populate submodules, so `sub` is an empty directory and
  // `add -A` drops the gitlink. Deliberate and fail-closed (header F(f)); the point of this
  // test is that the MESSAGE still names the path, because plain `status` says nothing.
  const { sup } = withSubmodule('uninit');
  const wt = join(TMP, `linked${n++}`);
  sh(sup, 'worktree', 'add', wt, '-b', 'feat/x');
  assert.equal(readdirSync(join(wt, 'sub')).length, 0, 'fixture: the linked worktree leaves sub empty');
  assert.equal(sh(wt, 'status', '--porcelain'), '', 'fixture: plain status says nothing about it');

  const d = worktreeDirt(wt);
  assert.equal(d.clean, false, 'a missing gitlink must not read as clean');
  assert.deepEqual(d.paths, ['D\tsub'], 'the diff-tree fallback names the path status could not');

  // …and once initialised at the committed gitlink it is clean again (the check is not just
  // refusing everything with a submodule in it).
  shSub(wt, 'submodule', 'update', '--init');
  assert.equal(isWorktreeClean(wt), true);
});

// --- hazard (a): the GIT_INDEX_FILE allowance is INTERNAL ONLY ---------------------------------

test('an ambient GIT_INDEX_FILE cannot steer the verdict, and its decoy is left alone', () => {
  const r = repo('ambient-index');
  const decoy = join(TMP, `decoy-index${n++}`);
  // A decoy index that already contains the untracked file — if the helper honoured the
  // ambient variable it would read the decoy's staged state instead of the worktree.
  writeFileSync(join(r, 'untracked.txt'), 'sk-would-be-a-secret\n');
  spawnSync('git', ['add', '-A'], { cwd: r, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: decoy } });
  const decoyBytes = readFileSync(decoy);

  const saved = process.env.GIT_INDEX_FILE;
  try {
    process.env.GIT_INDEX_FILE = decoy;
    const d = worktreeDirt(r);
    assert.equal(d.clean, false, 'the untracked file is dirt no matter what index git is pointed at');
    assert.ok(d.paths.some((p) => p.includes('untracked.txt')), `paths: ${d.paths}`);
    assert.equal(d.headTree, sh(r, 'rev-parse', 'HEAD^{tree}'));
  } finally {
    if (saved === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = saved;
  }
  assert.deepEqual(readFileSync(decoy), decoyBytes, 'the ambient index file was written to');
});
