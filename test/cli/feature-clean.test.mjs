// feature-clean.test.mjs — `legion feature clean <name>` (T19, M0 finding 13) through the REAL
// bin, on the shared acceptance fixture. What this file is FOR, case by case: the closed-only
// refusal; the two retain guards (dirty tree, commits that exist nowhere else); the happy path a
// DELIVERED feature actually takes; the branch guard on its own (worktree already gone — exactly
// the state M0's hand-cleanup left); idempotence; and the hint `close`/`abandon` now print.
//
// THE ARGV RECORDER IS THE POINT OF THIS FILE, not a detail. `legion finalize` is the ONLY
// remote-write path in the tree (PLAN-V3 §Remote safety) and a cleanup command is the obvious
// place for a second one to grow — `git push --delete`, `glab mr close`, a `git fetch` to "check
// what is really pushed". So EVERY clean invocation here runs with a `git` shim and a `glab` shim
// PREPENDED to PATH: both append their whole argv to a log (one token per line) and the git one
// then execs the real git, so the command under test behaves normally while every token it ever
// handed to git is on record. assertLocalOnly() then refuses the log if any token looks remote
// (push/--delete/mr/fetch/a bare `remote`) or if `glab` was invoked at all — and refuses an EMPTY
// log too, because a recorder that captured nothing proves nothing (the shim not being on PATH
// would otherwise read as a pass).
// PATH lookup happens in the CHILD with the env we hand it (libuv sets environ before execvp), so
// the shim intercepts git in the legion process AND in everything legion spawns.
//
// NO NETWORK, and the "already pushed" state is built WITHOUT one: a delivered feature is
// simulated by writing refs/remotes/origin/feat/<name> with `update-ref`. That is precisely what
// `--not --remotes` reads, so the containment guard is exercised for real; a push (even to a local
// bare repo) would be a remote write inside a test whose subject is "never write to the remote".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, NOW_ARGS } from '../helpers/fixture.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'legion.mjs');
const NODE = process.execPath;

/** The real git, resolved ONCE and BEFORE any shim exists on PATH — the shim execs this absolute
 * path, so `command -v git` inside it (which would find the shim) is never needed. */
const REAL_GIT = (() => {
  const r = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  const p = (r.stdout ?? '').trim();
  assert.ok(p.length > 0, 'no git on PATH — this suite drives real git');
  return p;
})();

/** Install the recording shims in a sandbox dir and return {env, log}. `env` is the fixture's own
 * hermetic env with the shim dir PREPENDED, so the fixture's loud non-succeeding glab shim is
 * still behind ours (ours records first, then refuses the same way). */
function recorder(h) {
  const dir = join(h.sandbox, 'recorder');
  mkdirSync(dir, { recursive: true });
  const log = join(dir, 'argv.log');
  const record = (name) => `{ echo "${name}"; for a in "$@"; do echo "$a"; done; } >> '${log}'\n`;
  writeFileSync(join(dir, 'git'), `#!/bin/sh\n${record('git')}exec '${REAL_GIT}' "$@"\n`);
  for (const cli of ['glab', 'gh']) {
    writeFileSync(join(dir, cli),
      `#!/bin/sh\n${record(cli)}echo "legion3 clean test: ${cli} must never be invoked" >&2\nexit 1\n`);
  }
  for (const n of ['git', 'glab', 'gh']) chmodSync(join(dir, n), 0o755);
  return { env: { ...h.env, PATH: dir + delimiter + h.env.PATH }, log };
}

/** Tokens that would mean this command reached past the local repository. `remote`/`fetch` are
 * banned as WHOLE tokens: `--remotes` (the containment read, purely local) must stay legal.
 * `pr` joined `mr` on 2026-08-15 with the second forge — the GitHub verb for the same reach. */
const REMOTE_TOKEN = /^(push|--delete|-d|mr|pr|fetch|remote|ls-remote)$/;

function assertLocalOnly(log, what) {
  const lines = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  assert.ok(lines.length > 0,
    `${what}: the argv recorder captured NOTHING — the shim was not on PATH, so this case proves nothing`);
  for (const cli of ['glab', 'gh']) {
    assert.ok(!lines.includes(cli),
      `${what}: ${cli} was invoked; \`legion finalize\` is the only path that may talk to a forge`);
  }
  for (const tok of lines) {
    assert.ok(!REMOTE_TOKEN.test(tok),
      `${what}: argv token '${tok}' reaches the remote — cleanup must never become a second remote-write path\n${lines.join(' ')}`);
  }
  // `push` anywhere in a longer token (a refspec, a URL) is just as damning as the bare verb.
  const smell = lines.find((l) => /push|--delete\b/.test(l));
  assert.equal(smell, undefined, `${what}: argv token '${smell}' looks like a remote write`);
}

/** Run the REAL router with the recorder on PATH, from the MAIN repo root (where `feature clean`
 * is meant to be typed — resolveProject refuses from inside a worktree). */
function cleanRun(h, rec, ...argv) {
  const r = spawnSync(NODE, [BIN, 'feature', ...argv, ...NOW_ARGS], {
    cwd: h.repoRoot, encoding: 'utf8', env: rec.env,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const gitAt = (h, cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=legion test', ...args], {
    cwd, encoding: 'utf8', env: h.env, // the fixture env: NOT recorded, this is setup
  });
  assert.equal(r.status, 0, `setup git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
};

const branchExists = (h, branch) =>
  spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: h.repoRoot, encoding: 'utf8', env: h.env }).status === 0;

/** Mark the branch as pushed WITHOUT a network: refs/remotes/origin/<branch> is exactly what
 * `rev-list --not --remotes` consults, and it is what `legion finalize`'s push would have left. */
const markPushed = (h, branch) =>
  gitAt(h, h.repoRoot, 'update-ref', `refs/remotes/origin/${branch}`, gitAt(h, h.repoRoot, 'rev-parse', branch));

/** Close a feature for real (`legion state close abandoned` needs no receipts) — the honest way to
 * reach a CLOSED manifest without manufacturing the whole finalize chain. */
function closeAbandoned(h) {
  const r = h.legion('state', 'close', 'abandoned');
  assert.equal(r.code, 0, `state close abandoned failed: ${r.stderr}`);
  return r;
}

const dossierIntact = (h, what) => {
  assert.ok(existsSync(h.featurePath), `${what}: the dossier's feature.json was deleted — the dossier is the audit trail`);
  assert.ok(existsSync(h.dossier), `${what}: the dossier directory was deleted`);
};

// --- the refusal ------------------------------------------------------------------------------

test('clean REFUSES a live feature, names its status, and touches nothing', () => {
  const h = fixture();
  const rec = recorder(h);
  const snap = h.snapshot();
  const r = cleanRun(h, rec, 'clean', h.feature);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /is not closed \(status: 'active'\)/);
  assert.match(r.stderr, /legion feature abandon f1/); // an actionable way out, not just a no
  assert.ok(existsSync(h.worktree), 'the worktree of a LIVE feature must survive a refused clean');
  assert.ok(branchExists(h, 'feat/f1'), 'the branch must survive a refused clean');
  h.assertUnmoved(snap, 'refused clean');
  dossierIntact(h, 'refused clean');
  assertLocalOnly(rec.log, 'refused clean');
  h.cleanup();
});

test('clean refuses an unknown feature and a malformed name', () => {
  const h = fixture();
  const rec = recorder(h);
  assert.match(cleanRun(h, rec, 'clean', 'nope').stderr, /does not exist/);
  assert.match(cleanRun(h, rec, 'clean', '../evil').stderr, /feature name/);
  assert.equal(cleanRun(h, rec, 'clean').code, 1); // no name at all
  assertLocalOnly(rec.log, 'refusals');
  h.cleanup();
});

// --- the two retain guards --------------------------------------------------------------------

test('clean RETAINS a worktree with uncommitted changes, and says what blocks it', () => {
  const h = fixture();
  writeFileSync(join(h.worktree, 'unsaved.txt'), 'work nobody has committed\n');
  closeAbandoned(h);
  const rec = recorder(h);
  const snap = h.snapshot();

  const r = cleanRun(h, rec, 'clean', h.feature);
  assert.equal(r.code, 1, 'a retained worktree is not a clean feature — the exit code must say so');
  assert.match(r.stdout, /worktree RETAINED \(uncommitted changes/);
  assert.match(r.stdout, /branch feat\/f1 RETAINED: its worktree is still present/);
  assert.ok(existsSync(join(h.worktree, 'unsaved.txt')), 'uncommitted work must survive clean');
  assert.ok(branchExists(h, 'feat/f1'));
  h.assertUnmoved(snap, 'retaining clean');
  dossierIntact(h, 'retaining clean');
  assertLocalOnly(rec.log, 'dirty retain');
  h.cleanup();
});

test('clean RETAINS a worktree holding commits that exist nowhere else', () => {
  const h = fixture();
  const head = h.commit('work only on this machine');
  closeAbandoned(h);
  const rec = recorder(h);

  const r = cleanRun(h, rec, 'clean', h.feature);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /worktree RETAINED \(1 unpushed commit\(s\)\)/);
  assert.ok(existsSync(h.worktree), 'a worktree with unpushed commits must survive');
  assert.equal(gitAt(h, h.repoRoot, 'rev-parse', 'feat/f1'), head, 'the commit must still be reachable');
  dossierIntact(h, 'unpushed retain');
  assertLocalOnly(rec.log, 'unpushed retain');
  h.cleanup();
});

// --- the happy path a delivered feature takes ---------------------------------------------------

test('clean removes worktree AND branch once the commits are contained in a remote ref', () => {
  const h = fixture();
  h.commit('the delivered work');
  markPushed(h, 'feat/f1'); // what `legion finalize` left behind, minted locally
  // The DELIVERED status by hand: `close delivered` demands the whole finalize chain (boundary
  // receipt at HEAD + pre-merge approval + a read-back MR), none of which changes what `clean`
  // reads — and this suite never touches a remote, so the MR half cannot be earned here.
  h.writeFeature((f) => ({ ...f, revision: f.revision + 1, status: 'delivered', closedAt: '2026-07-25T00:00:00.000Z' }));
  const rec = recorder(h);
  const snap = h.snapshot();

  const r = cleanRun(h, rec, 'clean', h.feature);
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /feature default\/fixproj\/f1 cleaned/);
  assert.match(r.stdout, /worktree removed/);
  assert.match(r.stdout, /branch feat\/f1 deleted/);
  assert.ok(!existsSync(h.worktree), 'the worktree must be gone');
  assert.ok(!branchExists(h, 'feat/f1'), 'the local branch must be gone');
  assert.equal(gitAt(h, h.repoRoot, 'rev-parse', 'refs/remotes/origin/feat/f1').length, 40,
    'the REMOTE-tracking ref must survive — deleting the remote branch is a human act');
  h.assertUnmoved(snap, 'successful clean');
  dossierIntact(h, 'successful clean');
  assertLocalOnly(rec.log, 'happy path');

  // --- idempotence: a second clean re-derives the same answer and reports already-clean ---
  const rec2 = recorder(h);
  const r2 = cleanRun(h, rec2, 'clean', h.feature);
  assert.equal(r2.code, 0, `${r2.stdout}${r2.stderr}`);
  assert.match(r2.stdout, /is already clean/);
  assert.match(r2.stdout, /worktree already gone/);
  assert.match(r2.stdout, /branch feat\/f1 already gone/);
  h.assertUnmoved(snap, 'second clean');
  dossierIntact(h, 'second clean');
  assertLocalOnly(rec2.log, 'idempotent clean');
  h.cleanup();
});

// --- the branch guard on its own (the state M0's hand-cleanup left behind) -----------------------

test('with the worktree already gone, an uncontained branch is RETAINED, a contained one deleted', () => {
  const h = fixture();
  h.commit('work');
  closeAbandoned(h);
  gitAt(h, h.repoRoot, 'worktree', 'remove', '--force', h.worktree); // the M0 hand-cleanup
  const rec = recorder(h);

  const r = cleanRun(h, rec, 'clean', h.feature);
  assert.equal(r.code, 1, 'a surviving branch is not a clean feature');
  assert.match(r.stdout, /worktree already gone/);
  assert.match(r.stdout, /branch feat\/f1 RETAINED \(1 commit\(s\) reachable from neither main@/);
  assert.match(r.stdout, /git -C .* branch -D feat\/f1/, 'the operator gets the exact manual command');
  assert.ok(branchExists(h, 'feat/f1'), 'an uncontained branch must survive');
  assertLocalOnly(rec.log, 'branch retain');

  // Once the commits are reachable from a remote ref, the same command deletes the branch.
  markPushed(h, 'feat/f1');
  const rec2 = recorder(h);
  const r2 = cleanRun(h, rec2, 'clean', h.feature);
  assert.equal(r2.code, 0, `${r2.stdout}${r2.stderr}`);
  assert.match(r2.stdout, /branch feat\/f1 deleted/);
  assert.ok(!branchExists(h, 'feat/f1'));
  dossierIntact(h, 'branch clean');
  assertLocalOnly(rec2.log, 'branch delete');
  h.cleanup();
});

// --- the hint (M0 finding 13: the operator had no idea a cleanup existed) ------------------------

test('state close prints the clean hint, naming the repo root and never the dossier', () => {
  const h = fixture();
  const r = closeAbandoned(h);
  assert.match(r.stdout, /feature closed: abandoned/);
  assert.match(r.stdout, /legion feature clean f1 --org default/);
  assert.ok(r.stdout.includes(h.repoRoot), 'the hint must say WHERE to run it — clean refuses inside the worktree');
  assert.match(r.stdout, /dossier and the REMOTE branch are never touched/);
  h.cleanup();
});

/** The hinted command, taken from the OUTPUT and not retyped: everything on the `legion …` line up
 * to the em dash that starts the prose. Parsing it is the whole point of the case below — a hint is
 * only advice if what it literally prints runs. */
function hintedArgv(stdout) {
  const line = stdout.split('\n').find((l) => l.trim().startsWith('legion feature clean'));
  assert.ok(line, `no clean hint in output:\n${stdout}`);
  return line.split('—')[0].trim().split(/\s+/).slice(1); // drop the `legion` the shim provides
}

test('the hint carries --org, so it still runs when one repo is registered under two orgs', () => {
  // A repo registered under two orgs is supported (project init --org) and makes resolveProject
  // REFUSE an un-disambiguated `feature clean`. The hint is printed on the success path of close,
  // so a hint that cannot run is command output claiming a cleanup it does not deliver.
  const h = fixture();
  const second = h.legionIn(h.repoRoot, 'project', 'init', '--root', h.repoRoot, '--org', 'acme');
  assert.equal(second.code, 0, `second-org registration failed: ${second.stderr}`);

  const hint = closeAbandoned(h).stdout;
  const argv = hintedArgv(hint);
  assert.deepEqual(argv, ['feature', 'clean', 'f1', '--org', 'default'],
    'the hint must name the feature AND the org its record was registered under');

  // The bare form is what used to be advertised — assert it really is refused, so the case above
  // cannot pass vacuously.
  const rec = recorder(h);
  const bare = cleanRun(h, rec, 'clean', h.feature);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /matches multiple projects .* disambiguate with --org/);

  // And the printed command, run verbatim from the repo root, delivers the cleanup.
  const rec2 = recorder(h);
  const r = cleanRun(h, rec2, ...argv.slice(1));
  assert.equal(r.code, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /feature default\/fixproj\/f1 cleaned/);
  assert.ok(!existsSync(h.worktree), 'the hinted command must actually remove the worktree');
  assert.ok(!branchExists(h, 'feat/f1'));
  dossierIntact(h, 'dual-org hint');
  assertLocalOnly(rec2.log, 'dual-org hint');
  h.cleanup();
});

test('abandon prints the hint only when something actually survives it', () => {
  const h = fixture();
  writeFileSync(join(h.worktree, 'unsaved.txt'), 'work\n');
  const retained = h.legionIn(h.repoRoot, 'feature', 'abandon', h.feature);
  assert.equal(retained.code, 0, retained.stderr);
  assert.match(retained.stdout, /RETAINED/);
  assert.match(retained.stdout, /legion feature clean f1/, 'a retained abandon must point at clean');

  // A clean abandon removed everything itself: pointing at `clean` there teaches the operator to
  // ignore hints.
  const h2 = fixture({ feature: 'f2' });
  const gone = h2.legionIn(h2.repoRoot, 'feature', 'abandon', 'f2');
  assert.equal(gone.code, 0, gone.stderr);
  assert.match(gone.stdout, /worktree removed/);
  assert.ok(!gone.stdout.includes('legion feature clean'),
    'nothing survived a clean abandon — the hint would be advice to clean an empty repo');
  h.cleanup();
  h2.cleanup();
});
