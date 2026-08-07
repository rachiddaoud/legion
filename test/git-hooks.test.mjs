// End-to-end guard for the REMOVAL of remote-safety layer 3 (the local push guards, retired
// 2026-08-07 — src/kernel/githooks.mjs header): `legion project init` / `legion feature start`
// must NEUTER the fail-closed stub older versions installed, never orphan it.
//
// WHY THIS FILE STILL EXISTS AFTER THE LAYER IT TESTED IS GONE. The install-era stub `import()`s
// <plugin root>/hooks/pre-push.mjs by absolute file URL and exits 1 when the load fails. That
// guard file no longer ships, so every leftover stub in the field now blocks EVERY push in its
// repository — `legion finalize`'s included. The claims proven here are the removal's, against
// real repositories and a real local bare `origin` (a filesystem path, so the pushes below are
// genuine `git push` invocations that genuinely move refs, with no network anywhere):
//   - the trap is REAL: a planted old stub blocks an ordinary push (git runs it, it dies);
//   - `project init` and `feature start` remove a MARKED stub and say so in one line;
//   - an UNMARKED pre-push hook — the operator's own — is never touched (no-clobber, reversed);
//   - with no stub, ordinary pushes succeed with no `--no-verify` and finalize's real push seam
//     works with no marker env: the server (M0-FIXTURE-LEDGER row 8) is the only refusal left.
// LEGION_HOME is a temp dir per scenario; the real ~/.legion is never touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyHardenedGitEnv } from '../src/kernel/git.mjs';
import {
  HOOK_MARKER, inspectPrePushHook, removePrePushStub, removalReportLine,
} from '../src/kernel/githooks.mjs';
import { pushEnv, realIo } from '../src/cli/finalize.mjs';

// The suite must not depend on the developer's ~/.gitconfig or on inherited GIT_* variables.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'legion.mjs');
const NODE = process.execPath;

// Where the retired guard USED to live in this checkout — the exact URL every stub installed
// from this plugin root carries. The file's absence is not a fixture artifact, it is the point.
const OLD_GUARD_URL = pathToFileURL(join(ROOT, 'hooks', 'pre-push.mjs')).href;

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-githooks-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) => sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);

let n = 0;
/** A sandbox: temp LEGION_HOME, a bare `origin` on disk, a one-commit repo registered with
 * `legion project init`, optionally a started feature. */
function scenario({ project = 'gh-proj', feature = false } = {}) {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  const bare = join(base, 'origin.git');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(base, 'init', '--bare', '-b', 'main', bare);
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: project }, null, 2)}\n`);
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', bare);
  const env = { ...process.env, LEGION_HOME: home };
  const init = spawnSync(NODE, [BIN, 'project', 'init', '--root', repo], { encoding: 'utf8', env });
  assert.equal(init.status, 0, init.stderr);
  const s = {
    project, home, bare, env, base,
    repo: realpathSync(repo),
    initStdout: init.stdout,
    hookPath: join(realpathSync(repo), '.git', 'hooks', 'pre-push'),
  };
  if (feature) {
    const st = spawnSync(NODE, [BIN, 'feature', 'start', 'f1', '--base', 'main'],
      { cwd: repo, encoding: 'utf8', env });
    assert.equal(st.status, 0, st.stderr);
    s.startStdout = st.stdout;
    s.worktree = realpathSync(join(base, '.legion-worktrees', project, 'f1', 'checkout'));
  }
  return s;
}

/** Plant the stub an OLD legion installed — marker line, exec bit, fail-closed import of a guard
 * file that no longer exists. Byte shape mirrors the retired stubSource(): what matters to the
 * remover is the MARKER, and what matters to the trap tests is the fail-closed catch. */
function plantOldStub(path, { guardUrl = OLD_GUARD_URL } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    '#!/usr/bin/env node',
    `// ${HOOK_MARKER}`,
    '// INSTALLED BY legion (`legion project init` / `legion feature start`) — DEFENSE IN DEPTH.',
    `const guard = ${JSON.stringify(guardUrl)};`,
    'import(guard).catch((err) => {',
    '  process.stderr.write(`legion pre-push guard: could not load ${guard}: ${err && err.message || err}\\n`);',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n'));
  chmodSync(path, 0o755);
}

/** A REAL `git push`. Never asserted to succeed in-line — the exit code is the thing under test. */
const push = (cwd, env, ...args) =>
  spawnSync('git', ['push', ...args], { cwd, encoding: 'utf8', env });

/** The branches the bare repository actually holds — "nothing reached the remote" as a fact
 * about the remote, not an inference from an exit code. */
const bareBranches = (s) =>
  sh(s.bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);

// --- the retired layer is genuinely gone ---------------------------------------------------------

test('`legion project init` installs NO hook, and says nothing about one', () => {
  const s = scenario();
  assert.ok(!existsSync(s.hookPath), 'no stub may be written — the local guards are retired');
  assert.doesNotMatch(s.initStdout, /pre-push/, 'the steady state of a retired layer is not news');
});

test('an ordinary push succeeds with NO --no-verify — the server is the only refusal left', () => {
  const s = scenario();
  const r = push(s.repo, s.env, 'origin', 'main');
  assert.equal(r.status, 0, `nothing local may block an ordinary push: ${r.stderr}`);
  assert.ok(bareBranches(s).includes('main'),
    'a local bare has no protection to apply — the server-side refusal (ledger row 8) is the only barrier');
});

// --- the trap the remover exists for -------------------------------------------------------------

test('THE TRAP IS REAL: a leftover old stub blocks every ordinary push, fail-closed', () => {
  const s = scenario();
  plantOldStub(s.hookPath);
  const r = push(s.repo, s.env, 'origin', 'main');
  assert.notEqual(r.status, 0, 'the stub must die loudly on its missing guard file');
  assert.match(r.stderr, /legion pre-push guard: could not load/);
  assert.deepEqual(bareBranches(s), [], 'nothing reached the remote');
});

test('`legion feature start` removes a marked leftover stub and says so in one line', () => {
  const s = scenario();
  plantOldStub(s.hookPath);
  const st = spawnSync(NODE, [BIN, 'feature', 'start', 'f1', '--base', 'main'],
    { cwd: s.repo, encoding: 'utf8', env: s.env });
  assert.equal(st.status, 0, st.stderr);
  assert.ok(!existsSync(s.hookPath), 'feature start is the upgrade path: the stub must be gone');
  const line = st.stdout.split('\n').find((l) => l.includes('pre-push stub'));
  assert.ok(line, 'an actual removal IS news — one line');
  assert.match(line, /removed leftover at/);
  assert.match(line, /only push barrier/, 'the line must state the server-only layering');
  assert.equal(st.stdout.split('\n').filter((l) => l.includes('pre-push stub')).length, 1);
  // …and the repository pushes again.
  const r = push(s.repo, s.env, 'origin', 'main');
  assert.equal(r.status, 0, `with the stub gone the push must succeed: ${r.stderr}`);
});

test('re-running `legion project init` removes a marked leftover stub too', () => {
  const s = scenario();
  plantOldStub(s.hookPath);
  const again = spawnSync(NODE, [BIN, 'project', 'init', '--root', s.repo], { encoding: 'utf8', env: s.env });
  assert.equal(again.status, 0, again.stderr);
  assert.ok(!existsSync(s.hookPath), 're-init is the remedy the old stub itself names on stderr');
  assert.match(again.stdout, /pre-push stub: removed leftover at/);
});

test('NO-CLOBBER REVERSED: an unmarked pre-push hook is the operator\'s and is never deleted', () => {
  const s = scenario();
  const foreign = '#!/bin/sh\n# the operator\'s own hook\nexit 0\n';
  writeFileSync(s.hookPath, foreign);
  chmodSync(s.hookPath, 0o755);
  const st = spawnSync(NODE, [BIN, 'feature', 'start', 'f1', '--base', 'main'],
    { cwd: s.repo, encoding: 'utf8', env: s.env });
  assert.equal(st.status, 0, st.stderr);
  assert.equal(readFileSync(s.hookPath, 'utf8'), foreign, "the operator's hook must survive byte for byte");
  assert.doesNotMatch(st.stdout, /pre-push/, "another person's hook is not legion's news to report");
});

test('a core.hooksPath redirect neither stops the removal nor gets rewritten', () => {
  const s = scenario();
  plantOldStub(s.hookPath); // marked litter at the DEFAULT path — git ignores it under a redirect
  const custom = join(s.base, 'custom-hooks');
  mkdirSync(custom, { recursive: true });
  sh(s.repo, 'config', 'core.hooksPath', custom);
  const st = spawnSync(NODE, [BIN, 'feature', 'start', 'f1', '--base', 'main'],
    { cwd: s.repo, encoding: 'utf8', env: s.env });
  assert.equal(st.status, 0, st.stderr);
  assert.ok(!existsSync(s.hookPath), 'the marked litter at the default path is ours to collect');
  assert.equal(sh(s.repo, 'config', '--get', 'core.hooksPath'), custom, 'the config must be left alone');
  // What removal never touches: the REDIRECTED directory (a hand-copied stub there is the
  // operator's to delete — src/kernel/githooks.mjs decision B).
  assert.ok(!existsSync(join(custom, 'pre-push')), 'and nothing was written into the redirected dir');
});

// --- the remover as a unit: statuses, not throws -------------------------------------------------

test('removePrePushStub returns a STATUS for every outcome and removalReportLine renders honestly', () => {
  const s = scenario();
  // 'none' — the steady state, silent.
  const none = removePrePushStub(s.repo);
  assert.equal(none.status, 'none');
  assert.equal(removalReportLine(none), '', 'a permanent "no stub" line would be noise about a retired layer');
  // 'removed' — one line, server-only framing.
  plantOldStub(s.hookPath);
  const removed = removePrePushStub(s.repo);
  assert.equal(removed.status, 'removed');
  assert.ok(!existsSync(s.hookPath));
  assert.match(removalReportLine(removed), /removed leftover at/);
  assert.match(removalReportLine(removed), /only push barrier/);
  // 'kept-foreign' — untouched and silent.
  writeFileSync(s.hookPath, '#!/bin/sh\nexit 0\n');
  const kept = removePrePushStub(s.repo);
  assert.equal(kept.status, 'kept-foreign');
  assert.ok(existsSync(s.hookPath));
  assert.equal(removalReportLine(kept), '');
  // 'failed' — a status, never a throw; the line names the consequence.
  rmSync(s.hookPath);
  const nowhere = join(TMP, `not-a-repo-${n++}`);
  mkdirSync(nowhere, { recursive: true });
  const failed = removePrePushStub(nowhere);
  assert.equal(failed.status, 'failed');
  assert.ok(String(failed.detail ?? '').length > 0, 'and it says why');
  assert.match(removalReportLine(failed), /could NOT remove/);
  assert.match(removalReportLine(failed), /EVERY ordinary push/);
});

// --- the READ-ONLY inspector (what `legion doctor` asks) -----------------------------------------

test('inspectPrePushHook reports every leftover state and repairs NONE of them', () => {
  const s = scenario();
  assert.equal(inspectPrePushHook(s.repo).status, 'clean');

  plantOldStub(s.hookPath);
  const leftover = inspectPrePushHook(s.repo);
  assert.equal(leftover.status, 'leftover', 'git will run this stub and every push will die in it');
  assert.equal(leftover.path, s.hookPath);
  assert.ok(existsSync(s.hookPath), 'reporting must not remove — doctor is read-only absolutely');

  // Without the exec bit git ignores the stub: litter, not a push blocker.
  chmodSync(s.hookPath, 0o644);
  assert.equal(inspectPrePushHook(s.repo).status, 'leftover-inert');

  writeFileSync(s.hookPath, '#!/bin/sh\nexit 0\n');
  assert.equal(inspectPrePushHook(s.repo).status, 'foreign');

  rmSync(s.hookPath);
  assert.equal(inspectPrePushHook(s.repo).status, 'clean');

  // The inspector answers about the EFFECTIVE hooks dir — the one git actually reads — because
  // its question is "will the next push die in a dead stub", not "where did the installer write".
  const custom = join(s.base, 'inspect-hooks');
  mkdirSync(custom, { recursive: true });
  sh(s.repo, 'config', 'core.hooksPath', custom);
  assert.equal(inspectPrePushHook(s.repo).status, 'clean', 'an empty redirected dir runs nothing');
  plantOldStub(join(custom, 'pre-push'));
  const redirected = inspectPrePushHook(s.repo);
  assert.equal(redirected.status, 'leftover', 'a hand-copied stub in the redirected dir is one git runs');
  assert.equal(redirected.path, join(custom, 'pre-push'));
  assert.ok(existsSync(join(custom, 'pre-push')), 'named for the operator to delete, never deleted for them');
});

test('inspectPrePushHook NEVER throws — an unanswerable question is `unknown`, not a crash', () => {
  const nowhere = join(TMP, `not-a-repo-${n++}`);
  mkdirSync(nowhere, { recursive: true });
  const r = inspectPrePushHook(nowhere);
  assert.equal(r.status, 'unknown');
  assert.equal(r.path, null);
  assert.ok(String(r.detail ?? '').length > 0, 'and it says why');
});

// --- finalize's real push seam, with no marker and no stub ---------------------------------------

test("finalize's REAL push works with no local guard and carries no marker env", async () => {
  const s = scenario({ feature: true });
  writeFileSync(join(s.worktree, 'work.txt'), 'work\n');
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', 'work');

  const home = process.env.LEGION_HOME;
  try {
    process.env.LEGION_HOME = s.home;
    realIo().gitPush(s.worktree, s.bare, 'feat/f1'); // throws loudly if the push is refused
  } finally {
    if (home === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = home;
  }
  assert.ok(bareBranches(s).includes('feat/f1'), "finalize's own push must reach the remote");

  // The retired guard's marker died with it: pushEnv still hardens the prompt and sets nothing
  // else, and nothing leaks onto this process.
  const env = pushEnv({});
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!('LEGION_FINALIZE_PUSH' in env), 'the marker is gone from the push environment');
  assert.equal(process.env.LEGION_FINALIZE_PUSH, undefined);
});
