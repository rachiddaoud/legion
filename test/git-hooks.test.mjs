// End-to-end guard for REMOTE-SAFETY LAYER 3, the git-hook half (PLAN-V3 §Remote safety;
// T25): src/kernel/githooks.mjs (the no-clobber installer) and hooks/pre-push.mjs (the guard).
//
// HERMETIC, AND THE PUSH TARGETS ARE REAL. Every scenario builds a throwaway repository plus a
// LOCAL BARE repository used as `origin` — a filesystem path, so the pushes below are genuine
// `git push` invocations that genuinely move refs, with no network anywhere. That matters for
// the two claims a fake could not support: that git actually RUNS the installed stub (a hook
// that never fires is the failure mode no unit test sees), and that `--no-verify` genuinely
// walks past it while the receiving repository genuinely accepts the push — the honest depth
// semantics this layer is documented to have. LEGION_HOME is a temp dir per scenario; the real
// ~/.legion is never touched.
//
// TWO WAYS OF DRIVING THE GUARD, both used deliberately:
//   - THROUGH GIT, for the cases where "does git run it at all" is part of the claim;
//   - DIRECTLY (spawn the script with a cwd, an environment and git's stdin contract), for the
//     decision table. It is the same technique test/hooks.test.mjs uses for the Claude Code
//     hooks, and it is the only way to exercise the hostile-environment case honestly: a real
//     `git push` under an ambient GIT_DIR would push the OTHER repository, so the interesting
//     question — does the GUARD resolve from cwd rather than from the environment git exports
//     into it — cannot be asked that way round.
//
// WHAT THIS FILE DOES NOT CLAIM. Nothing here proves the layer stops a determined agent, and it
// must not read as if it did: `--no-verify` is asserted to WORK, the marker is asserted to be a
// plain environment variable, and the server's refusal (the only guarantee) is not simulated
// here at all — it is proven live on the real fixture and recorded in
// test/acceptance/M0-FIXTURE-LEDGER.md row 8.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHardenedGitEnv } from '../src/kernel/git.mjs';
import {
  FINALIZE_PUSH_ENV, HOOK_MARKER, ensurePrePushHook, hookReportLine, inspectPrePushHook, stubSource,
} from '../src/kernel/githooks.mjs';
import { realIo } from '../src/cli/finalize.mjs';

// The suite must not depend on the developer's ~/.gitconfig or on inherited GIT_* variables.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'legion.mjs');
const GUARD = join(ROOT, 'hooks', 'pre-push.mjs');
const NODE = process.execPath;
const ZERO = '0'.repeat(40);

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
 * `legion project init` (which is what installs the guard), optionally a started feature. */
function scenario({ project = 'gh-proj', protectedFlag = null, feature = false } = {}) {
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
  const init = spawnSync(NODE, [BIN, 'project', 'init', '--root', repo,
    ...(protectedFlag ? ['--protected', protectedFlag] : [])], { encoding: 'utf8', env });
  assert.equal(init.status, 0, init.stderr);
  const s = {
    project, home, bare, env, base,
    repo: realpathSync(repo),
    initStdout: init.stdout,
    idxPath: join(home, 'projects.json'),
    configPath: join(home, 'orgs', 'default', 'projects', project, 'project.json'),
    hookPath: join(realpathSync(repo), '.git', 'hooks', 'pre-push'),
  };
  if (feature) {
    const st = spawnSync(NODE, [BIN, 'feature', 'start', 'f1', '--base', 'main'],
      { cwd: repo, encoding: 'utf8', env });
    assert.equal(st.status, 0, st.stderr);
    s.startStdout = st.stdout;
    s.worktree = realpathSync(join(base, '.legion-worktrees', project, 'f1', 'checkout'));
    s.dossier = join(home, 'orgs', 'default', 'projects', project, 'features', 'f1');
  }
  return s;
}

/** One `<local ref> <local sha> <remote ref> <remote sha>` line, git's pre-push stdin contract. */
const refLine = (remoteRef, sha = 'a'.repeat(40), localRef = remoteRef) =>
  `${localRef} ${sha} ${remoteRef} ${ZERO}\n`;

/** Drive the guard exactly as git does: argv = remote name + URL, refs on stdin, decision in the
 * exit code. `env` is merged over the scenario's (LEGION_HOME included). */
function fireGuard(s, cwd, stdin, env = {}) {
  const r = spawnSync(NODE, [GUARD, 'origin', s.bare], {
    cwd, input: stdin, encoding: 'utf8', env: { ...s.env, ...env },
  });
  if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message ?? r.error) };
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** A REAL `git push`, run under the scenario's environment so the installed stub can resolve
 * LEGION_HOME. Never asserted to succeed — the exit code is the thing under test. */
const push = (cwd, env, ...args) =>
  spawnSync('git', ['push', ...args], { cwd, encoding: 'utf8', env });

/** The branches the bare repository actually holds — "nothing reached the remote" as a fact
 * about the remote, not an inference from an exit code. */
const bareBranches = (s) =>
  sh(s.bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n').filter(Boolean);

// --- the installer ------------------------------------------------------------------------------

test('`legion project init` installs the guard, executable, pointing at THIS checkout', () => {
  const s = scenario();
  assert.ok(existsSync(s.hookPath), 'project init must install the pre-push hook');
  const src = readFileSync(s.hookPath, 'utf8');
  assert.ok(src.includes(HOOK_MARKER), 'the stub must carry the recognition marker');
  assert.ok(src.includes(`file://${GUARD}`), `the stub must exec this checkout's guard: ${GUARD}`);
  // The executable bit is what decides whether git runs it at all — a hook installed 0644 is a
  // hook that silently never fires, which is the worst outcome available here.
  assert.equal(statSync(s.hookPath).mode & 0o111, 0o111, 'the stub must be executable');
  assert.equal(src, stubSource(ROOT), 'the installed bytes are stubSource() and nothing else');
});

test('the install line is HONEST — depth, never a claim that pushes are prevented', () => {
  const s = scenario();
  const line = s.initStdout.split('\n').find((l) => l.includes('pre-push guard'));
  assert.ok(line, '`legion project init` must say one line about the hook');
  // THE claim this whole layer must never make (PLAN-V3 §Remote safety: hooks are depth).
  assert.doesNotMatch(line, /prevent/i, 'the line must not claim pushes are prevented');
  assert.match(line, /DEFENSE IN DEPTH, not the guarantee/);
  assert.match(line, /--no-verify/, 'the caveat must name the bypass concretely');
  assert.match(line, /only the server refuses authoritatively/);
  // One line, not a paragraph: init/start print exactly one.
  assert.equal(s.initStdout.split('\n').filter((l) => l.includes('pre-push guard')).length, 1);
});

test('re-ensuring is idempotent: unchanged when current, updated when stale', () => {
  const s = scenario();
  const before = readFileSync(s.hookPath);
  const same = ensurePrePushHook(s.repo);
  assert.equal(same.status, 'unchanged');
  assert.deepEqual(readFileSync(s.hookPath), before, 'an up-to-date stub must not be rewritten');

  // A legion-MARKED stub written by an older legion (different path, same marker) is an upgrade.
  writeFileSync(s.hookPath, `#!/usr/bin/env node\n// ${HOOK_MARKER}\n// an older stub\n`);
  const up = ensurePrePushHook(s.repo);
  assert.equal(up.status, 'updated');
  assert.equal(readFileSync(s.hookPath, 'utf8'), stubSource(ROOT));
  assert.equal(statSync(s.hookPath).mode & 0o111, 0o111, 'an upgraded stub stays executable');
  assert.match(hookReportLine(up), /DEFENSE IN DEPTH, not the guarantee/);
});

test('a legion stub that lost its exec bit is RE-ARMED, never reported already-installed', () => {
  // The state decision E's rename→chmod window can leave behind (also: an interrupted install, an
  // archive restore, a filesystem with no exec bit). git IGNORES a non-executable hook silently,
  // so the layer is gone — and a content-only idempotence check would call this 'unchanged' and
  // print "already installed", which is a product claim of a guard that is not there.
  const s = scenario();
  chmodSync(s.hookPath, 0o644);
  const bypassed = push(s.repo, s.env, 'origin', 'main');
  assert.equal(bypassed.status, 0, 'git ignores a non-executable hook — that is the state under repair');
  assert.ok(bareBranches(s).includes('main'), 'the protected branch reached the remote with the hook dormant');

  const r = ensurePrePushHook(s.repo);
  assert.equal(r.status, 'updated', 'byte-equality is not enough: a hook git will not run is not installed');
  assert.equal(statSync(s.hookPath).mode & 0o111, 0o111, 'the exec bit must be restored');
  assert.equal(readFileSync(s.hookPath, 'utf8'), stubSource(ROOT), 'and the bytes are left exactly as they were');
  const line = hookReportLine(r);
  assert.doesNotMatch(line, /already installed/, 'THE false claim: an installed guard git is ignoring');
  assert.match(line, /not executable/, 'the line must say what was wrong, not just that something changed');

  // The guard is genuinely back — asserted through git, on a push that has something to send
  // (git does not run pre-push for an up-to-date push, so the assertion needs a new commit).
  writeFileSync(join(s.repo, 'more.txt'), 'more\n');
  sh(s.repo, 'add', '-A');
  gitc(s.repo, 'commit', '-m', 'more');
  const after = push(s.repo, s.env, 'origin', 'main');
  assert.notEqual(after.status, 0, 're-ensuring must actually restore the block');
  assert.match(after.stderr, /legion pre-push guard: PUSH BLOCKED/);

  // A tightened-but-runnable mode is the operator's choice: legion repairs 'git cannot run it',
  // never 'the mode is not the one we would have written'.
  chmodSync(s.hookPath, 0o744);
  assert.equal(ensurePrePushHook(s.repo).status, 'unchanged');
  assert.equal(statSync(s.hookPath).mode & 0o777, 0o744, 'a 0744 stub is still executable and is left alone');
});

test('NO-CLOBBER: a foreign pre-push hook is reported and left byte-identical', () => {
  const s = scenario();
  const foreign = '#!/bin/sh\n# the operator\'s own hook\nexit 0\n';
  writeFileSync(s.hookPath, foreign);
  chmodSync(s.hookPath, 0o755);
  const r = ensurePrePushHook(s.repo);
  assert.equal(r.status, 'skipped-foreign');
  // THE assertion of the case: not backed up, not chained, not merged — untouched.
  assert.equal(readFileSync(s.hookPath, 'utf8'), foreign, "the operator's hook must survive byte for byte");
  const line = hookReportLine(r);
  assert.match(line, /NOT installed/);
  assert.match(line, /left untouched/);
  assert.match(line, /Compose the two by hand/, 'the report must advise composition');
  // …and a re-init must still SUCCEED: the layer is depth, its absence cannot brick onboarding.
  const again = spawnSync(NODE, [BIN, 'project', 'init', '--root', s.repo], { encoding: 'utf8', env: s.env });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /pre-push guard: NOT installed/);
  assert.equal(readFileSync(s.hookPath, 'utf8'), foreign);
});

test('core.hooksPath is honoured by SKIPPING — legion never rewrites the operator\'s git config', () => {
  const s = scenario();
  rmSync(s.hookPath, { force: true });
  const custom = join(s.base, 'custom-hooks');
  mkdirSync(custom, { recursive: true });
  sh(s.repo, 'config', 'core.hooksPath', custom);
  const r = ensurePrePushHook(s.repo);
  assert.equal(r.status, 'skipped-hookspath');
  assert.match(r.detail, /core\.hooksPath/);
  assert.ok(!existsSync(join(custom, 'pre-push')), 'legion must not write into a redirected hooks dir');
  assert.ok(!existsSync(s.hookPath), 'nor into the dir git would ignore — that would print a false "installed"');
  assert.equal(sh(s.repo, 'config', '--get', 'core.hooksPath'), custom, 'the config must be left alone');
  assert.match(hookReportLine(r), /NOT installed/);
});

test('`legion feature start` re-ensures the guard for the repository', () => {
  const s = scenario({ feature: true });
  assert.ok(existsSync(s.hookPath));
  assert.match(s.startStdout, /pre-push guard: already installed/);
  // The upgrade path a project initialized by an older legion takes: the hook is gone, and the
  // next `feature start` puts it back (worktrees share the repository's hooks directory).
  rmSync(s.hookPath, { force: true });
  const st = spawnSync(NODE, [BIN, 'feature', 'start', 'f2', '--base', 'main'],
    { cwd: s.repo, encoding: 'utf8', env: s.env });
  assert.equal(st.status, 0, st.stderr);
  assert.ok(existsSync(s.hookPath), 'feature start must re-ensure the hook');
  assert.match(st.stdout, /pre-push guard: installed at/);
  assert.match(st.stdout, /DEFENSE IN DEPTH, not the guarantee/);
});

// --- the READ-ONLY inspector (T27: what `legion doctor` asks) ------------------------------------
// Same derivation as the installer (githooks decision F), opposite obligation: it must report
// every state and change none of them. `legion doctor` is read-only absolutely, so an inspector
// that repaired anything would make the whole command a writer.

test('inspectPrePushHook reports every state the installer distinguishes, and repairs NONE of them', () => {
  const s = scenario();
  assert.deepEqual(inspectPrePushHook(s.repo), { status: 'installed', path: s.hookPath, detail: null });

  // A stub git will not execute is NOT installed — decision E, and the one state a content-only
  // check would call green while the guard lay dormant.
  chmodSync(s.hookPath, 0o644);
  assert.equal(inspectPrePushHook(s.repo).status, 'not-executable');
  assert.equal(statSync(s.hookPath).mode & 0o111, 0, 'reporting it must not re-arm it — that is ensure()\'s job');

  writeFileSync(s.hookPath, '#!/bin/sh\nexit 0\n');
  assert.equal(inspectPrePushHook(s.repo).status, 'foreign');
  assert.equal(readFileSync(s.hookPath, 'utf8'), '#!/bin/sh\nexit 0\n');

  rmSync(s.hookPath);
  const absent = inspectPrePushHook(s.repo);
  assert.equal(absent.status, 'absent');
  assert.equal(absent.path, s.hookPath, 'it must name the path the installer WOULD write');
  assert.ok(!existsSync(s.hookPath), 'and asking must not create it');

  const custom = join(s.base, 'inspect-hooks');
  mkdirSync(custom, { recursive: true });
  sh(s.repo, 'config', 'core.hooksPath', custom);
  const redirected = inspectPrePushHook(s.repo);
  assert.equal(redirected.status, 'hookspath');
  assert.equal(redirected.path, custom);
  assert.equal(sh(s.repo, 'config', '--get', 'core.hooksPath'), custom, 'and the config is untouched');
});

test('inspectPrePushHook NEVER throws — an unanswerable question is `unknown`, not a crash', () => {
  // doctor's remote-guards check must not be able to die: a report that throws is no report.
  const nowhere = join(TMP, `not-a-repo-${n++}`);
  mkdirSync(nowhere, { recursive: true });
  const r = inspectPrePushHook(nowhere);
  assert.equal(r.status, 'unknown');
  assert.equal(r.path, null);
  assert.ok(String(r.detail ?? '').length > 0, 'and it says why');
});

test('the inspector resolves from the path it is GIVEN, never from an ambient GIT_DIR', () => {
  // The same in-scope hostile environment the guard faces (git exports GIT_DIR into hooks, and a
  // shell that exported it is a shell doctor can be run from). Both repos carry a distinguishable
  // hook state, so an inspector that read the environment would answer about the wrong one.
  const a = scenario({ project: 'inspect-a' });
  const b = scenario({ project: 'inspect-b' });
  rmSync(b.hookPath);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = join(b.repo, '.git');
  process.env.GIT_WORK_TREE = b.repo;
  try {
    assert.equal(inspectPrePushHook(a.repo).status, 'installed', 'A is answered about, not B');
    assert.equal(inspectPrePushHook(b.repo).status, 'absent');
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// --- the guard's decision table --------------------------------------------------------------

test('rule 1: the finalize marker ALLOWS, silently, even from a feature worktree', () => {
  const s = scenario({ feature: true });
  const r = fireGuard(s, s.worktree, refLine('refs/heads/main'), { [FINALIZE_PUSH_ENV]: '1' });
  assert.equal(r.code, 0, `the marker must allow: ${r.stderr}`);
  assert.equal(r.stderr, '', 'an allow is SILENT — a chatty one is noise the operator learns to skip');
  assert.equal(r.stdout, '');
  // Set-but-EMPTY is a broken export, not a marker: it must not disable the guard.
  const empty = fireGuard(s, s.worktree, refLine('refs/heads/feat/f1'), { [FINALIZE_PUSH_ENV]: '' });
  assert.equal(empty.code, 1, 'an empty marker value must not read as "present"');
});

test('rule 2: a push to a PROTECTED branch is blocked, naming the branch and the sanctioned path', () => {
  const s = scenario();
  const r = fireGuard(s, s.repo, refLine('refs/heads/main'));
  assert.equal(r.code, 1, 'a protected-branch push must be refused');
  assert.match(r.stderr, /'main' is a PROTECTED branch of project default\/gh-proj/);
  assert.match(r.stderr, /legion finalize/, 'the refusal must name the sanctioned path');
  assert.match(r.stderr, /DEFENSE IN DEPTH, not the guarantee/, 'and must not read as a guarantee');
  assert.match(r.stderr, /--no-verify/, 'the escape hatch is documented in the refusal itself');
});

test('rule 2: protected patterns are WILDCARDS, matched exactly as doctor matches them', () => {
  const s = scenario({ project: 'wild-proj', protectedFlag: 'release/*' });
  assert.equal(fireGuard(s, s.repo, refLine('refs/heads/release/1.0')).code, 1,
    "'release/*' must cover release/1.0");
  const r = fireGuard(s, s.repo, refLine('refs/heads/releaseX'));
  assert.equal(r.code, 0, "'release/*' must NOT cover releaseX — anchored matching, not a prefix");
  // A branch nobody protected is nobody's business (rule 4), even in a managed repository.
  assert.equal(fireGuard(s, s.repo, refLine('refs/heads/main')).code, 0,
    'an --protected list that omits main leaves main unprotected here, and the guard must say so by allowing');
});

test('rule 2 covers a DELETION of a protected branch too', () => {
  const s = scenario();
  const r = fireGuard(s, s.repo, `(delete) ${ZERO} refs/heads/main ${'b'.repeat(40)}\n`);
  assert.equal(r.code, 1, 'deleting a protected branch is at least as consequential as writing to it');
  assert.match(r.stderr, /PROTECTED branch/);
});

test('rule 2 is about BRANCHES: a tag ref is not matched against protectedBranches', () => {
  const s = scenario();
  const r = fireGuard(s, s.repo, refLine('refs/tags/main'));
  assert.equal(r.code, 0, "a tag named 'main' must not be refused for spelling like a protected branch");
});

test('rule 3b: a push from a REGISTERED FEATURE WORKTREE is blocked, naming the feature', () => {
  const s = scenario({ feature: true });
  // A ref that is NEITHER protected NOR a registered feature branch, so the ONLY thing that can
  // refuse it is the cwd-keyed limb — otherwise this test would be passing on 3a's answer.
  const r = fireGuard(s, s.worktree, refLine('refs/heads/scratch'));
  assert.equal(r.code, 1, 'a push out of a feature checkout goes through finalize, whatever the ref');
  assert.match(r.stderr, /worktree of legion feature default\/gh-proj\/f1/);
  assert.match(r.stderr, /branch feat\/f1/);
  assert.match(r.stderr, /legion finalize/);
  assert.match(r.stderr, /DEFENSE IN DEPTH, not the guarantee/);
  // …and it still decides when git hands the guard no parseable ref lines at all.
  assert.equal(fireGuard(s, s.worktree, '').code, 1, 'no refs is not an early allow from a feature worktree');
});

test('rule 3a: a REGISTERED FEATURE BRANCH is blocked from the main checkout too, not just its worktree', () => {
  // THE hole a cwd-only rule 3 leaves: one `cd ..` inside the same repository, no --no-verify, no
  // env spoofing, and the branch the guard just refused to publish publishes cleanly. Keyed on the
  // pushed REF, so the same push is refused from every checkout of the repository.
  const s = scenario({ feature: true });
  const r = fireGuard(s, s.repo, refLine('refs/heads/feat/f1'));
  assert.equal(r.code, 1, 'the feature branch is a feature branch wherever it is pushed from');
  assert.match(r.stderr, /'feat\/f1' is the branch of legion feature default\/gh-proj\/f1/);
  assert.match(r.stderr, /legion finalize/, 'the refusal must name the sanctioned path');
  assert.match(r.stderr, /DEFENSE IN DEPTH, not the guarantee/);

  // For real, through git, from the MAIN checkout — and the bare must not hold the branch after.
  const real = push(s.repo, s.env, 'origin', 'feat/f1');
  assert.notEqual(real.status, 0, 'a real push of the feature branch from the parent directory must fail');
  assert.ok(!bareBranches(s).includes('feat/f1'), 'the feature branch must not have reached the remote');

  // Rule 3a matches only branches `legion feature start` itself created: the operator's own
  // branches, however similarly spelled, stay their own business (rule 4).
  assert.equal(fireGuard(s, s.repo, refLine('refs/heads/feat/f1-notes')).code, 0,
    'a near-miss branch name is not a registered feature branch');
});

test('rule 4: an unrelated branch from the MAIN checkout is allowed, silently', () => {
  const s = scenario({ feature: true });
  const r = fireGuard(s, s.repo, refLine('refs/heads/scratch'));
  assert.equal(r.code, 0, "the operator's ordinary work is none of legion's business");
  assert.equal(r.stderr, '');
});

test('rule 4: a repository nobody registered is allowed, even with the guard installed', () => {
  const s = scenario();
  const other = join(s.base, 'unmanaged');
  mkdirSync(other, { recursive: true });
  sh(other, 'init', '-b', 'main');
  writeFileSync(join(other, 'x.txt'), 'x\n');
  sh(other, 'add', '-A');
  gitc(other, 'commit', '-m', 'init');
  const r = fireGuard(s, realpathSync(other), refLine('refs/heads/main'));
  assert.equal(r.code, 0, 'an unregistered repo has no protected set and no feature worktrees');
  assert.equal(r.stderr, '');
});

// --- fail-closed: the ABSENT / CORRUPT line ------------------------------------------------------

test('a CORRUPT projects.json blocks, naming the cause', () => {
  const s = scenario();
  writeFileSync(s.idxPath, '{ this is not json\n');
  const r = fireGuard(s, s.repo, refLine('refs/heads/scratch'));
  assert.equal(r.code, 1, 'an index we cannot read is an answer we do not have — fail closed');
  assert.match(r.stderr, /projects\.json/);
  assert.match(r.stderr, /unreadable/);
});

test('a MALFORMED projects.json (projects is not an array) blocks, naming the cause', () => {
  const s = scenario();
  writeFileSync(s.idxPath, `${JSON.stringify({ version: 1, schemaVersion: 1, projects: {} })}\n`);
  const r = fireGuard(s, s.repo, refLine('refs/heads/scratch'));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /malformed/);
});

test('an unreadable project.json blocks — the protected set is what rule 2 needs', () => {
  const s = scenario();
  writeFileSync(s.configPath, '{ nope\n');
  const r = fireGuard(s, s.repo, refLine('refs/heads/scratch'));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not be\n?\s*read|corrupt/);
});

test('a project.json with no protectedBranches array blocks, naming the remedy', () => {
  const s = scenario();
  const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
  delete cfg.protectedBranches;
  writeFileSync(s.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  const r = fireGuard(s, s.repo, refLine('refs/heads/scratch'));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /protectedBranches/);
  assert.match(r.stderr, /legion project init/, 'a refusal must name the way out');
});

test('a repo registered as MORE THAN ONE project blocks — a hook has no --org to disambiguate', () => {
  const s = scenario();
  const idx = JSON.parse(readFileSync(s.idxPath, 'utf8'));
  idx.projects.push({ ...idx.projects[0], org: 'other' });
  writeFileSync(s.idxPath, `${JSON.stringify(idx, null, 2)}\n`);
  const r = fireGuard(s, s.repo, refLine('refs/heads/scratch'));
  assert.equal(r.code, 1);
  assert.match(r.stderr, /MORE THAN ONE legion project/);
});

test('an ABSENT projects.json ALLOWS — absent is not corrupt, and a bricked repo buys no safety', () => {
  const s = scenario();
  rmSync(s.idxPath, { force: true });
  const r = fireGuard(s, s.repo, refLine('refs/heads/main'));
  assert.equal(r.code, 0, 'nothing on this machine is registered, so nothing here is protected');
  assert.equal(r.stderr, '');
});

// --- the in-scope hostile environment: GIT_DIR/GIT_WORK_TREE, which GIT ITSELF exports ----------

test('an ambient GIT_DIR/GIT_WORK_TREE aimed at ANOTHER repo never re-aims the guard', () => {
  // A: registered, main protected. B: an ordinary repository nobody registered.
  const a = scenario({ project: 'hostile-a' });
  const b = join(a.base, 'repo-b');
  mkdirSync(b, { recursive: true });
  sh(b, 'init', '-b', 'main');
  writeFileSync(join(b, 'x.txt'), 'x\n');
  sh(b, 'add', '-A');
  gitc(b, 'commit', '-m', 'init');
  const bReal = realpathSync(b);
  const hostileB = { GIT_DIR: join(bReal, '.git'), GIT_WORK_TREE: bReal };
  const hostileA = { GIT_DIR: join(a.repo, '.git'), GIT_WORK_TREE: a.repo };

  // Standing in A, with the environment pointing at UNREGISTERED B: the protection that applies
  // is A's, because cwd decides. Reading the environment would have allowed this push.
  const inA = fireGuard(a, a.repo, refLine('refs/heads/main'), hostileB);
  assert.equal(inA.code, 1, "the guard must judge the repository cwd is in, not the one GIT_DIR names");
  assert.match(inA.stderr, /PROTECTED branch of project default\/hostile-a/);

  // The converse, which a naive fix would get wrong in the other direction: standing in
  // UNREGISTERED B with the environment pointing at A must not import A's protected set.
  const inB = fireGuard(a, bReal, refLine('refs/heads/main'), hostileA);
  assert.equal(inB.code, 0, "B is not a legion project, whatever GIT_DIR says");
  assert.equal(inB.stderr, '');
});

// --- real pushes against a local bare repository -------------------------------------------------

test('git RUNS the installed stub: a real push to protected main is refused and the bare is unmoved', () => {
  const s = scenario();
  const before = bareBranches(s);
  const r = push(s.repo, s.env, 'origin', 'main');
  assert.notEqual(r.status, 0, 'the push must fail');
  assert.match(r.stderr, /legion pre-push guard: PUSH BLOCKED/);
  assert.deepEqual(bareBranches(s), before, 'nothing reached the remote');
});

test('--no-verify BYPASSES the guard and the bare ACCEPTS the push — the honest depth semantics', () => {
  // Asserted because it is the DESIGN (PLAN-V3 §Remote safety: hooks can be disabled; only the
  // server is authoritative), not a gap. A local bare accepts what a protected GitLab branch
  // would refuse — that difference IS the layering, and row 8 of the M0 fixture ledger is where
  // the server's half of it is proven.
  const s = scenario();
  const r = push(s.repo, s.env, '--no-verify', 'origin', 'main');
  assert.equal(r.status, 0, `--no-verify must reach the remote: ${r.stderr}`);
  assert.ok(bareBranches(s).includes('main'), 'the local bare has no protection to apply');
});

test("finalize's REAL push carries the marker, so the guard it installed lets it through", async () => {
  const s = scenario({ feature: true });
  writeFileSync(join(s.worktree, 'work.txt'), 'work\n');
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', 'work');

  // realIo().gitPush is the production seam — a genuine `git push` under the operator's config,
  // which is exactly why the guard fires on it. Rule 3 would block this push without the marker.
  const raw = push(s.worktree, s.env, 'origin', 'feat/f1');
  assert.notEqual(raw.status, 0, 'a raw push from the worktree must be blocked');
  // Rule 3a answers first here (the pushed ref IS the feature branch) and 3b would answer second;
  // the assertion is on what both limbs must deliver — the feature named — not on which fired.
  assert.match(raw.stderr, /legion feature default\/gh-proj\/f1/);

  const home = process.env.LEGION_HOME;
  try {
    process.env.LEGION_HOME = s.home;
    realIo().gitPush(s.worktree, s.bare, 'feat/f1'); // throws loudly if the push is refused
  } finally {
    if (home === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = home;
  }
  assert.ok(bareBranches(s).includes('feat/f1'), "finalize's own push must reach the remote");
  // …and the marker was set on the SUBPROCESS, never on this process: nothing else finalize
  // shells out to may claim to be the push.
  assert.equal(process.env[FINALIZE_PUSH_ENV], undefined,
    'the marker must never be set process-wide');
});
