// Regression guard for the CROSS-REPO DESTRUCTION reproduced in the T7c review: `legion
// feature abandon` run from repo A with GIT_DIR/GIT_WORK_TREE pointed at repo B resolved
// B's project (feature.mjs's `rev-parse --show-toplevel` was UNPINNED), then removed B's
// worktree and force-deleted B's branch while A was untouched and still reported active.
// Two registered projects, ONE hermetic LEGION_HOME, the real bin, a hostile environment.
// The load-bearing assertions are the NEGATIVE ones — B's worktree directory, B's
// feat/f1 branch and B's 'active' manifest must all still be there afterwards; a command
// that mis-resolves is a bug, a command that DESTROYS another repository is the bug this
// file exists for. Verified RED against 0c2c130 (pre-T7c) before the seam was inverted.
// Imports only applyHardenedGitEnv — an export that exists at 0c2c130 — so this file runs
// unmodified against the old tree; a regression test that never failed proves nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';

// HERMETIC GIT: neuters global/system config and every inherited GIT_* variable and pins a
// deterministic identity. Every child below spawns from `process.env`, so the ONLY GIT_*
// variables any child sees are the hostile ones this file sets deliberately.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'legion.mjs');

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) =>
  sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);

let TMP, HOME, A, B;
let n = 0;

/** A one-commit fixture repo nested one level under `<TMP>/s<n>/<slot>` so its worktrees
 * (dirname(repoRoot)/.legion-worktrees/...) stay inside the sandbox. The package.json name
 * decides the project name, so A and B must differ — same-named projects would make the
 * "which project did it resolve?" assertion meaningless. */
function repoAt(base, slot, project) {
  const repo = join(base, slot, project);
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: project }, null, 2) + '\n');
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  const init = spawnSync(process.execPath, [BIN, 'project', 'init', '--root', repo], {
    encoding: 'utf8', env: { ...process.env, LEGION_HOME: HOME },
  });
  assert.equal(init.status, 0, init.stderr);
  const start = spawnSync(process.execPath, [BIN, 'feature', 'start', 'f1', '--base', 'main'], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, LEGION_HOME: HOME },
  });
  assert.equal(start.status, 0, start.stderr);
  return {
    project,
    repo: realpathSync(repo),
    worktree: join(realpathSync(join(base, slot)), '.legion-worktrees', project, 'f1', 'checkout'),
    dossier: join(HOME, 'orgs', 'default', 'projects', project, 'features', 'f1'),
  };
}

const manifest = (r) => JSON.parse(readFileSync(join(r.dossier, 'feature.json'), 'utf8'));
/** Probe with the CLEAN (already hardened) process.env — never the hostile one, or the
 * probe would answer about whichever repo the redirection points at. */
const branchExists = (r) =>
  spawnSync('git', ['-C', r.repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/f1'],
    { encoding: 'utf8', env: process.env }).status === 0;

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'legion3-hostile-'));
  const base = join(TMP, `s${n++}`);
  HOME = join(base, 'home');
  mkdirSync(HOME, { recursive: true });
  A = repoAt(base, 'a', 'proj-a');
  B = repoAt(base, 'b', 'proj-b');
  assert.ok(existsSync(A.worktree), `fixture: ${A.worktree} must exist`);
  assert.ok(existsSync(B.worktree), `fixture: ${B.worktree} must exist`);
  assert.ok(branchExists(A) && branchExists(B), 'fixture: both feat/f1 branches exist');
});
after(() => { rmSync(TMP, { recursive: true, force: true }); });

/** `legion feature ...` from INSIDE repo A, with GIT_DIR/GIT_WORK_TREE aimed at repo B. */
const hostile = (...args) =>
  spawnSync(process.execPath, [BIN, 'feature', ...args], {
    cwd: A.repo,
    encoding: 'utf8',
    env: { ...process.env, LEGION_HOME: HOME, GIT_DIR: join(B.repo, '.git'), GIT_WORK_TREE: B.repo },
  });

test('abandon under a hostile GIT_DIR/GIT_WORK_TREE never touches the OTHER repo', () => {
  const r = hostile('abandon', 'f1');

  // --- the point of the file: B is not a party to this command ---
  assert.ok(existsSync(B.worktree), `B's worktree was DESTROYED by a command run in A: ${B.worktree}`);
  assert.ok(branchExists(B), "B's feat/f1 branch was force-deleted by a command run in A");
  assert.equal(manifest(B).status, 'active', "B's manifest was closed by a command run in A");

  // --- and A, the repo the operator actually stood in, is what got abandoned ---
  // (This is the RESOLVED branch of the spec's "resolves A (or refuses loudly)": the
  // hardened seam strips the redirection, so cwd decides and the command SUCCEEDS on A.)
  assert.equal(r.status, 0, r.stderr);
  assert.equal(manifest(A).status, 'abandoned');
  assert.ok(!existsSync(A.worktree), "A's worktree should have been removed");
  assert.ok(!branchExists(A), "A's feat/f1 should have been deleted with its worktree");
});

test('status under a hostile GIT_DIR/GIT_WORK_TREE reports A, never B', () => {
  const r = hostile('status', 'f1');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /default\/proj-a\/f1/);
  assert.doesNotMatch(r.stdout, /proj-b/);
});
