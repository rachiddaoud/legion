// End-to-end guard for `legion finalize` — THE ONLY remote-write path (PLAN-V3 §Remote
// safety). Fixtures are built through the REAL bin (project init → feature start → state
// init → commits → receipt/review/decision), with LEGION_HOME pinned to a temp home per
// scenario: the real ~/.legion is NEVER touched.
//
// WHY THE COMMAND ITSELF RUNS IN-PROCESS. finalize's remote effects live behind an injectable
// runner, and a fake cannot be injected through a spawned bin — so the tests drive the exported
// finalizeCore(argv, fakeIo) directly, with process.cwd() moved into the worktree (resolveDossier
// keys on cwd) and LEGION_HOME set, BOTH restored in a finally so nothing leaks into sibling
// tests. Consequence, and the point: this suite NEVER pushes and NEVER runs glab. The fake
// records every call, so "a refusal reached the remote" is observable as a non-empty call list
// rather than inferred.
//
// THE ONE THING A FAKE CANNOT OBSERVE is the argv realIo() hands to git — the refspec and the
// absence of --force live inside the seam, and executing it would be a real push. That single
// property is guarded by a SOURCE assertion at the bottom of this file, stated as such.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finalizeCore, pushEnv } from '../../src/cli/finalize.mjs';
import { readJson } from '../../src/kernel/fsatomic.mjs';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';

// HERMETIC GIT: neuters global/system config and every inherited GIT_* variable and pins a
// deterministic identity. Every child below spawns from process.env, so the ONLY GIT_*
// variables anything sees are the hostile ones the last test sets deliberately.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'legion.mjs');
const NODE = process.execPath;
const NOW_ISO = '2026-07-24T00:00:00.000Z';
const NOW = ['--now', NOW_ISO];

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-finalize-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) => sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);

let n = 0;
/** Fresh sandbox: isolated LEGION_HOME + a one-commit fixture repo with a registered project,
 * a started feature `f1` (real worktree + dossier) and an initialized tasks.json.
 * `ticket` (T37) is passed through to `feature start --ticket` — the REAL flag, so the manifest
 * field under test is written by the real writer and never hand-planted. Absent, the feature is
 * ticket-less and every fixture built before T37 is unchanged. */
function scenario(project = 'fix-proj', { ticket = null, remote = null } = {}) {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: project }, null, 2) + '\n');
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  // A remote finalize can find. It is never fetched from or pushed to: the push is faked, and
  // the only real read is `git remote get-url origin`, finalize's pre-write existence check.
  // `remote` also decides the FORGE: `project init` detects it from this URL, so a github.com
  // origin makes every finalize below drive gh with no extra config (2026-08-15).
  sh(repo, 'remote', 'add', 'origin', remote ?? `git@gitlab.invalid:acme/${project}.git`);
  const env = { ...process.env, LEGION_HOME: home };
  let r = spawnSync(NODE, [BIN, 'project', 'init', '--root', repo], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(NODE, [BIN, 'feature', 'start', 'f1', '--base', 'main', ...(ticket === null ? [] : ['--ticket', ticket])],
    { cwd: repo, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const s = {
    project,
    home,
    repo: realpathSync(repo),
    dossier: join(home, 'orgs', 'default', 'projects', project, 'features', 'f1'),
    configPath: join(home, 'orgs', 'default', 'projects', project, 'project.json'),
    worktree: realpathSync(join(base, '.legion-worktrees', project, 'f1', 'checkout')),
    env,
  };
  assert.equal(state(s, 'init').status, 0, 'state init');
  return s;
}

const state = (s, ...args) =>
  spawnSync(NODE, [BIN, 'state', ...args], { cwd: s.worktree, encoding: 'utf8', env: s.env });
const stateOk = (s, ...args) => {
  const r = state(s, ...args, ...NOW);
  assert.equal(r.status, 0, `legion state ${args.join(' ')}: ${r.stderr}`);
  return r;
};

const featureJson = (s) => readJson(join(s.dossier, 'feature.json'));
const tasksJson = (s) => readJson(join(s.dossier, 'tasks.json'));
const headOf = (s) => sh(s.worktree, 'rev-parse', 'HEAD');

/** EARN the boundary receipt the only way there is: a real `legion gate run --boundary` (T12 —
 * there is no `receipt-record` op; PLAN-V3 §State/R1). `project init` scaffolds `gates: {}`, so it
 * is a tier-0-only run — green, real and carrying full provenance under the pinned policy, which
 * is what keeps finalize's EXTENDED C3 from changing any pre-existing refusal in this file. */
function gateOk(s, ...args) {
  const r = spawnSync(NODE, [BIN, 'gate', 'run', ...args, ...NOW], { cwd: s.worktree, encoding: 'utf8', env: s.env });
  assert.equal(r.status, 0, `legion gate run ${args.join(' ')}: ${r.stderr}`);
  return r;
}
/** MINT a review receipt through the real surface the reviewer's SubagentStop hook calls. */
function mintReceipt(s, agentType, verdict = 'pass') {
  const r = spawnSync(NODE, [BIN, 'gate', 'review-receipt', '--agent-type', agentType,
    '--agent-id', 'fin-test', '--verdict', verdict, ...NOW], { cwd: s.worktree, encoding: 'utf8', env: s.env });
  assert.equal(r.status, 0, `legion gate review-receipt ${agentType}: ${r.stderr}`);
  return r;
}
/** Patch project.json's gates block AFTER `feature start` pinned the policy — i.e. cause DRIFT. */
function setGates(s, gates) {
  const cfg = readJson(s.configPath);
  writeFileSync(s.configPath, `${JSON.stringify({ ...cfg, gates }, null, 2)}\n`);
}

/** Write files into the worktree and commit them. */
function commitInWorktree(s, files, msg = 'work') {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(s.worktree, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', msg);
}

/** A dossier artifact file; returns its absolute path. */
function writeArtifact(s, name, body) {
  const p = join(s.dossier, name);
  writeFileSync(p, body);
  return p;
}

/** Hand-edit tasks.json — for the vanished-evidence fixtures ONLY (same rule as the acceptance
 * suite's writeTasks: since T13 a feature cannot REACH finalize with evidence missing, so the
 * broken states these tests need are constructed the one way a caller could construct them). */
function writeTasksHand(s, fn) {
  const p = join(s.dossier, 'tasks.json');
  const doc = readJson(p);
  writeFileSync(p, `${JSON.stringify(fn(doc) ?? doc, null, 2)}\n`);
}

/** THE LADDER to a finalizable feature — since T13 that is the WHOLE lifecycle, walked on real
 * evidence: finalize's C6 requires the finalize STAGE and the prefix re-deriving satisfied, so
 * a feature that never left intake would refuse there instead of at the condition under test.
 * Express profile: `stage-complete review` requires no recorded reviews (kernel
 * PROFILE_REVIEW_ROLES), which keeps C5 independently exercisable. The walk records a
 * plan-critic PASS with subject 'plan' (T14: the plan row counts only PLAN-bound critic
 * verdicts, and subject 'plan' is never product scope, so it cannot satisfy C5 by accident);
 * the C5 refusal tests hand-empty reviews[] afterwards and re-record the pre-merge decision.
 * ORDER IS LOAD-BEARING at the end: the pre-merge subject hashes the canonical reviews, so a
 * review recorded AFTER decision-record drifts the subject and the approval is born invalid
 * (that is exactly the fixture for the C4 refusal test). `boundary` lets the re-pin tests run
 * the boundary gate as `['--boundary', '--repin']`. */
function ladder(s, { review = ['--role', 'product', '--verdict', 'pass', '--subject', 'feature'], boundary = ['--boundary'] } = {}) {
  writeArtifact(s, 'intent.md', '# intent\n');
  stateOk(s, 'artifact-record', 'intent', 'intent.md');
  stateOk(s, 'decision-record', 'intake');
  stateOk(s, 'escalate-profile', 'express');
  stateOk(s, 'stage-complete', 'intake');
  stateOk(s, 'stage-enter', 'spec');
  writeArtifact(s, 'spec.md', '# spec\n');
  stateOk(s, 'artifact-record', 'spec', 'spec.md');
  stateOk(s, 'decision-record', 'spec');
  stateOk(s, 'stage-complete', 'spec');
  stateOk(s, 'stage-enter', 'plan');
  writeArtifact(s, 'plan.md', '# plan\n');
  stateOk(s, 'artifact-record', 'plan', 'plan.md');
  mintReceipt(s, 'legion:plan-critic'); // the record consumes attendance evidence
  stateOk(s, 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan');
  stateOk(s, 'decision-record', 'plan');
  stateOk(s, 'stage-complete', 'plan');
  stateOk(s, 'stage-enter', 'build');
  stateOk(s, 'stage-complete', 'build'); // no tasks seeded: an empty build is a finished build
  stateOk(s, 'stage-enter', 'review');
  stateOk(s, 'stage-complete', 'review');
  stateOk(s, 'stage-enter', 'pre-merge');
  gateOk(s, ...boundary);
  if (review) stateOk(s, 'review-record', ...review);
  stateOk(s, 'decision-record', 'pre-merge');
  stateOk(s, 'stage-complete', 'pre-merge');
  stateOk(s, 'stage-enter', 'finalize');
}

/** The pre-merge-rejection → fixup loop, AFTER a first finalize: the feature already stands in
 * finalize, so only the head-bound evidence is re-earned — re-gate, NEW review, re-approve
 * (PLAN-V3 decision 4). Since T14 the first pass's product review is BOUND to the tree it
 * judged, so a fixup commit kills it for C5 and a fresh one is part of the loop, recorded
 * BEFORE the pre-merge decision (which hashes the reviews array). */
function refresh(s) {
  gateOk(s, '--boundary');
  stateOk(s, 'review-record', '--role', 'product', '--verdict', 'pass', '--subject', 'feature');
  stateOk(s, 'decision-record', 'pre-merge');
}

/** Seed ONE canonical done task (milestone M1) by hand, BEFORE the ladder runs, for the C5 tests
 * whose review subject must name a REAL task/milestone (T14: review-record refuses a subject
 * naming nothing). Before the ladder, so the plan approval it records covers the row; `done`, so
 * `stage-complete build` stays satisfied; no receipt, which nothing in the prefix demands of a
 * done row. */
function seedDoneTask(s) {
  writeTasksHand(s, (doc) => ({
    ...doc,
    tasks: [{ id: 'T1', title: 'do T1', status: 'done', attempt: 0, depends_on: [], milestone: 'M1' }],
  }));
}

// --- the injected runner --------------------------------------------------------------------

/** A recording fake. `glab` defaults to "create says nothing, view returns a canned MR".
 * `cli` selects WHICH forge CLI the responder answers on (2026-08-15): the seam grew a second
 * argv passthrough, and a fake that answered both would let a test pass while finalize drove
 * the WRONG CLI — so the unused one throws, exactly as a missing binary would. */
function makeIo(responder, cli = 'glab') {
  const io = {
    calls: [],
    gitPush(worktree, remote, branch) {
      io.calls.push({ kind: 'gitPush', worktree, remote, branch });
      return '';
    },
  };
  for (const name of ['glab', 'gh']) {
    io[name] = (args, cwd) => {
      io.calls.push({ kind: name, args, cwd });
      if (name !== cli) throw new Error(`${name} was invoked, but this project's forge drives ${cli}`);
      return responder ? responder(args, cwd) : '';
    };
  }
  return io;
}

/** A fake GitLab whose `mr view` answers only when an MR EXISTS — glab exits nonzero for a
 * branch with none, which is exactly what finalize's pre-create probe reads as "absent".
 * `mr create` makes it exist and REJECTS a duplicate, as GitLab does, so a test that provokes a
 * second create fails loudly instead of passing quietly. The head sha is captured EAGERLY, at
 * construction time: resolving it lazily would run a `git` child while the hostile-env test has
 * GIT_DIR exported, and the fixture would then answer about the OTHER repository — a fixture bug
 * that reads exactly like the bug under test. `onView` may throw (a glab failure) or return a
 * string to substitute the payload; `onCreate` runs side effects between create and read-back. */
function glabServer(s, { open = false, over = {}, onView, onCreate, onNote, onIssueNote } = {}) {
  let exists = open;
  const sha = headOf(s);
  const body = () => JSON.stringify({
    iid: 42,
    web_url: 'https://gitlab.invalid/acme/fix-proj/-/merge_requests/42',
    target_branch: 'main',
    source_branch: 'feat/f1',
    sha,
    ...over,
  });
  return (args) => {
    // T37: the ticket comment. FIRST, because it shares `note` with the MR surface and only
    // `args[0]` tells them apart — a fixture that answered the issue note on the MR branch would
    // make the independence tests below pass for the wrong reason.
    if (args[0] === 'issue') {
      if (args[1] !== 'note') throw new Error(`unexpected glab ${args.join(' ')}`);
      onIssueNote?.();
      return '';
    }
    if (args[1] === 'create') {
      if (exists) throw new Error('glab: another open merge request already exists for this source branch');
      exists = true;
      onCreate?.();
      return '';
    }
    if (args[1] === 'view') {
      if (!exists) throw new Error("glab: no open merge request available for 'feat/f1'");
      const sub = onView?.();
      return typeof sub === 'string' ? sub : body();
    }
    // T18: the append-only finalize-event comment. `onNote` may throw, which is a glab failure the
    // command must survive — never edit or delete, so there is nothing else this surface can do.
    if (args[1] === 'note') {
      onNote?.();
      return '';
    }
    throw new Error(`unexpected glab ${args.join(' ')}`);
  };
}

/** A fake GITHUB (2026-08-15), gh's semantics rather than glab's, because the two differ in the
 * one place finalize has to care about: `gh pr view <branch>` RESOLVES A CLOSED OR MERGED PR
 * where glab's `mr view` exits nonzero, so "the CLI answered" is not the same fact as "a PR is
 * open". `state` is what the payload reports; `exists: false` makes view exit nonzero (gh's
 * no-PR-for-branch behaviour). `gh pr create` rejects a duplicate OPEN PR as GitHub does — and
 * ACCEPTS one when the previous PR is closed, which is the behaviour the closed-PR test pins. */
function ghServer(s, { open = false, state = 'OPEN', over = {}, onView, onCreate, onNote, onIssueNote } = {}) {
  let exists = open;
  let prState = state;
  const sha = headOf(s);
  const body = () => JSON.stringify({
    number: 42,
    url: 'https://github.com/acme/fix-proj/pull/42',
    baseRefName: 'main',
    headRefName: 'feat/f1',
    headRefOid: sha,
    state: prState,
    ...over,
  });
  return (args) => {
    if (args[0] === 'issue') {
      if (args[1] !== 'comment') throw new Error(`unexpected gh ${args.join(' ')}`);
      onIssueNote?.();
      return '';
    }
    if (args[1] === 'create') {
      if (exists && prState === 'OPEN') throw new Error('gh: a pull request for branch "feat/f1" into branch "main" already exists');
      exists = true;
      prState = 'OPEN'; // a create always yields an OPEN PR, even where a closed one preceded it
      onCreate?.();
      return '';
    }
    if (args[1] === 'view') {
      if (!exists) throw new Error('gh: no pull requests found for branch "feat/f1"');
      const sub = onView?.();
      return typeof sub === 'string' ? sub : body();
    }
    if (args[1] === 'comment') {
      onNote?.();
      return '';
    }
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
}

/** The one comment posted per successful finalize event, or undefined. */
const noteOf = (io) => io.calls.find((c) => c.kind === 'glab' && c.args[0] === 'mr' && c.args[1] === 'note');
/** Every ISSUE note this run posted (T37) — a LIST, because "exactly one per event" and "none at
 * all for a ticket-less feature" are both counting claims. */
const issueNotesOf = (io) => io.calls.filter((c) => c.kind === 'glab' && c.args[0] === 'issue');
/** The body handed to `mr create`, or undefined. */
const bodyOf = (io) => {
  const create = io.calls.find((c) => c.kind === 'glab' && c.args[1] === 'create');
  return create && create.args[create.args.indexOf('--description') + 1];
};
/** Anything that looks like a derived identifier: a git object id or a policy hash. The MR body
 * carries NONE of these since T18 — they enforce nothing there and cannot be checked without the
 * machine-local dossier (src/cli/finalize.mjs header). */
const HASHLIKE = /\b[0-9a-f]{40,64}\b/;

/** Write the session-authored MR overview into the dossier and return its absolute path. */
function descriptionFile(s, body = 'What changed and why.\n\nHow to review it: start at src/a.mjs.\n') {
  return writeArtifact(s, 'mr-description.md', body);
}

/** Drive finalizeCore in-process against `s`, capturing stdout/stderr. cwd + LEGION_HOME are
 * restored unconditionally; so are the stream writers. */
async function finalize(s, io, argv = NOW, envOverrides = {}) {
  const prevCwd = process.cwd();
  const prevHome = process.env.LEGION_HOME;
  const prevOverrides = Object.fromEntries(Object.keys(envOverrides).map((k) => [k, process.env[k]]));
  const out = [];
  const err = [];
  const so = process.stdout.write;
  const se = process.stderr.write;
  try {
    process.env.LEGION_HOME = s.home;
    for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;
    process.chdir(s.worktree);
    process.stdout.write = (c) => { out.push(String(c)); return true; };
    process.stderr.write = (c) => { err.push(String(c)); return true; };
    const code = await finalizeCore(argv, io);
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = so;
    process.stderr.write = se;
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prevHome;
    for (const [k, v] of Object.entries(prevOverrides)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

/** Every refusal shares this shape: nonzero, and the runner was never reached. */
function assertRefused(r, io, re) {
  assert.equal(r.code, 1, `expected a refusal, got ${r.code}\n${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /finalize REFUSED — nothing was pushed/);
  assert.match(r.stderr, re);
  assert.deepEqual(io.calls, [], `a refusal reached the remote: ${JSON.stringify(io.calls)}`);
}

// --- 1. wrong branch ---------------------------------------------------------------------------

test('refuses when the worktree is not on the feature branch — zero remote calls', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  sh(s.worktree, 'checkout', '-b', 'other');
  const io = makeIo(glabServer(s));
  assertRefused(await finalize(s, io), io, /is on 'other', not the feature branch 'feat\/f1'/);
});

test('refuses a DETACHED HEAD (which reads as branch "HEAD") — zero remote calls', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  sh(s.worktree, 'checkout', '--detach');
  const io = makeIo(glabServer(s));
  assertRefused(await finalize(s, io), io, /DETACHED HEAD/);
});

// --- 2. dirty worktree ---------------------------------------------------------------------------

test('refuses a dirty worktree, naming the path — zero remote calls', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  writeFileSync(join(s.worktree, 'stray.txt'), 'uncommitted\n');
  const io = makeIo(glabServer(s));
  assertRefused(await finalize(s, io), io, /is dirty \(.*stray\.txt/s);
});

// --- 3. missing boundary receipt -------------------------------------------------------------

test('refuses when no boundary receipt is recorded — zero remote calls', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  // Since T13 the walk cannot reach finalize WITHOUT the receipt (the pre-merge subject requires
  // it), so the C3-absent state is VANISHED evidence — hand-removed, as only a manifest edit can.
  writeTasksHand(s, (doc) => ({ ...doc, receipts: { ...doc.receipts, boundary: null } }));
  const io = makeIo(glabServer(s));
  assertRefused(await finalize(s, io), io, /no boundary receipt recorded/);
});

// --- 4. stale receipt ---------------------------------------------------------------------------

test('refuses a boundary receipt that a later commit made stale, naming both SHAs', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const receiptHead = headOf(s);
  commitInWorktree(s, { 'src/b.mjs': 'export const b = 2;\n' }, 'more');
  const newHead = headOf(s);
  assert.notEqual(receiptHead, newHead);
  const io = makeIo(glabServer(s));
  const r = await finalize(s, io);
  assertRefused(r, io, /stale, re-gate/);
  assert.ok(r.stderr.includes(receiptHead), 'the refusal must name the receipt SHA');
  assert.ok(r.stderr.includes(newHead), 'the refusal must name the current HEAD');
});

// --- 5. invalid pre-merge approval ------------------------------------------------------------

test('refuses when the pre-merge approval is no longer hash-valid — zero remote calls', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  // A review recorded AFTER the decision drifts the pre-merge subject (it hashes the canonical
  // reviews), so the recorded approval no longer matches recomputed evidence.
  stateOk(s, 'review-record', '--role', 'skeptic', '--verdict', 'pass', '--subject', 'feature');
  const io = makeIo(glabServer(s));
  assertRefused(await finalize(s, io), io, /no hash-valid pre-merge approval/);
});

// --- 6. no passing product/milestone review ----------------------------------------------------

test('refuses with a hash-VALID approval but no reviews at all (C4 does not imply C5)', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s, { review: null });
  // The walk left the plan-critic pass in reviews[] (subject 'plan' since T14 — C5 would not
  // count it, but "no reviews AT ALL" is the claim), and since T13 no walked feature can reach
  // finalize without it. The empty array is therefore a HAND-CONSTRUCTED state — precisely the
  // adversarial shape C5 is depth against — and the pre-merge decision is re-recorded over it so
  // C4 stays hash-valid (it hashes an EMPTY reviews[] perfectly happily) and C5 alone decides.
  writeTasksHand(s, (doc) => ({ ...doc, reviews: [] }));
  stateOk(s, 'decision-record', 'pre-merge');
  const io = makeIo(glabServer(s));
  assertRefused(await finalize(s, io), io, /no passing product\/milestone review/);
});

test('a task:<id> review and a failing review do not satisfy the product requirement', async () => {
  for (const review of [
    ['--role', 'product', '--verdict', 'pass', '--subject', 'task:T1'],
    ['--role', 'product', '--verdict', 'fail', '--subject', 'feature'],
  ]) {
    const s = scenario();
    commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
    seedDoneTask(s); // T14: `task:T1` must name a REAL task or review-record refuses
    ladder(s, { review: null });
    // Same shape as the empty-reviews case above: strip the walk's plan-critic pass, leave ONLY
    // the review under test, re-approve so C4 holds and C5 alone decides.
    writeTasksHand(s, (doc) => ({ ...doc, reviews: [] }));
    stateOk(s, 'review-record', ...review);
    stateOk(s, 'decision-record', 'pre-merge');
    const io = makeIo(glabServer(s));
    assertRefused(await finalize(s, io), io, /no passing product\/milestone review/);
  }
});

test('a passing milestone:<id> review DOES satisfy it', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  seedDoneTask(s); // T14: `milestone:M1` must name a milestone some real task belongs to
  ladder(s, { review: ['--role', 'product', '--verdict', 'pass', '--subject', 'milestone:M1'] });
  const io = makeIo(glabServer(s));
  const r = await finalize(s, io);
  assert.equal(r.code, 0, r.stderr);
});

// --- 6b. a closed feature ----------------------------------------------------------------------

test('refuses a feature that is not active', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  // close(delivered) now requires the MR record finalize writes (kernel/state.mjs), so the
  // feature must be finalized before it can be closed — which is the real sequence anyway.
  assert.equal((await finalize(s, makeIo(glabServer(s)))).code, 0);
  const close = state(s, 'close', 'delivered', ...NOW);
  assert.equal(close.status, 0, close.stderr);
  const io = makeIo(glabServer(s, { open: true }));
  assertRefused(await finalize(s, io), io, /is 'delivered' — finalize acts only on an active feature/);
});

// --- 7. the happy path ---------------------------------------------------------------------------

test('happy path: push once, one MR against the PINNED base, read back, recorded', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const head = headOf(s);
  const before = featureJson(s);
  const io = makeIo(glabServer(s));

  const r = await finalize(s, io);
  assert.equal(r.code, 0, r.stderr);

  // --- exactly five calls, in the contract's order: push → PROBE → create → view → note ---
  assert.equal(io.calls.length, 5, JSON.stringify(io.calls, null, 2));
  assert.deepEqual(io.calls[0], { kind: 'gitPush', worktree: s.worktree, remote: 'origin', branch: 'feat/f1' });

  // The pre-create probe: the SAME argv as the read-back — one glab surface, one parser. It
  // fails here (no MR is open yet), which is what licenses the create that follows.
  const probe = io.calls[1];
  assert.equal(probe.kind, 'glab');
  assert.deepEqual(probe.args, ['mr', 'view', 'feat/f1', '--output', 'json']);
  assert.equal(probe.cwd, s.worktree);

  const create = io.calls[2];
  assert.equal(create.kind, 'glab');
  assert.equal(create.cwd, s.worktree);
  assert.deepEqual(create.args.slice(0, 2), ['mr', 'create']);
  // The MR target is the PINNED base from feature.json — asserted against the manifest, not
  // against a literal, so a caller-supplied target could never satisfy this.
  const ti = create.args.indexOf('--target-branch');
  assert.ok(ti > 0, 'mr create must pass --target-branch');
  assert.equal(create.args[ti + 1], before.baseBranch);
  assert.equal(create.args[create.args.indexOf('--source-branch') + 1], before.branch);
  assert.ok(!create.args.includes('--force'));

  const view = io.calls[3];
  assert.deepEqual(view.args, ['mr', 'view', 'feat/f1', '--output', 'json']);
  assert.equal(view.cwd, s.worktree);

  // The process metadata is a COMMENT, posted LAST — after the read-back and after the record, so
  // a comment can never exist for an MR feature.json does not know about.
  const note = io.calls[4];
  assert.equal(note.kind, 'glab');
  assert.deepEqual(note.args.slice(0, 3), ['mr', 'note', '42']);
  assert.equal(note.args[3], '--message');
  assert.equal(note.cwd, s.worktree);

  // --- the recorded MR: server-reported fields + DERIVED head, nothing invented ---
  const after = featureJson(s);
  assert.deepEqual(after.mr, {
    iid: 42,
    url: 'https://gitlab.invalid/acme/fix-proj/-/merge_requests/42',
    targetBranch: 'main',
    headSha: head,
    at: NOW_ISO,
    // The rendering marker (2026-08-15): which notation the id takes, `!42` here.
    forge: 'gitlab',
  });
  assert.equal(after.revision, before.revision + 1, 'exactly one revision-bumping write');
  assert.equal(after.updatedAt, NOW_ISO);
  // Round-trips through the same reader every other consumer uses.
  assert.deepEqual(readJson(join(s.dossier, 'feature.json')).mr, after.mr);
});

// --- 7b. C3 + the MR body carry the receipt's PROVENANCE (T12) --------------------------------

test('C3 refuses a boundary receipt that carries no gate provenance — zero remote calls', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  // Downgrade the earned receipt to the rev-4 shape: a REAL head and a REAL tree, and nothing that
  // proves a gate ran. Hand-written because nothing can produce this shape any more, which is the
  // point (R1: the demonstrated bypass minted exactly this through the retired typed op).
  const tasksPath = join(s.dossier, 'tasks.json');
  const doc = readJson(tasksPath);
  const b = doc.receipts.boundary;
  doc.receipts.boundary = { head: b.head, treeHash: b.treeHash, at: b.at };
  writeFileSync(tasksPath, `${JSON.stringify(doc, null, 2)}\n`);

  const io = makeIo(glabServer(s));
  const r = await finalize(s, io);
  assertRefused(r, io, /fails GATE PROVENANCE/);
  assert.match(r.stderr, /legion gate run --boundary/, 'and it must name the remedy');
});

test('the finalize COMMENT renders the gates-green claim and a mid-feature RE-PIN — the trail reaches the human gate', async () => {
  // THE AUDIT TRAIL MUST REACH THE HUMAN, not stop at a log line. A re-pin cannot be prevented (an
  // agent with Bash can edit the project config and re-pin in one command), so the whole guarantee
  // is that it cannot be done QUIETLY — and the pre-merge human is the enforcement point. Dropping
  // this rendering would leave a documented guarantee the code does not deliver. Since T18 it is
  // the COMMENT that carries it, because a body is written once at create and then describes the
  // first HEAD forever.
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  // Earn the boundary receipt under a policy that MOVED: declare a command AFTER `feature start`
  // pinned `gates: {}`, then adopt it with --repin (the ladder's boundary run carries the flag —
  // the walk itself runs no other gate, so the re-pin happens exactly once, where it always did).
  setGates(s, { commands: { ok: { argv: [NODE, '-e', 'process.exit(0)'], timeoutMs: 30000 } }, task: [], boundary: ['ok'] });
  const pinBefore = featureJson(s).commandPolicyHash.boundary;
  ladder(s, { boundary: ['--boundary', '--repin'] });
  const receipt = tasksJson(s).receipts.boundary;
  assert.equal(receipt.repinnedFrom, pinBefore, 'fixture: the receipt must carry the superseded pin');
  assert.equal(receipt.declaredCommands, 1);

  const io = makeIo(glabServer(s));
  assert.equal((await finalize(s, io)).code, 0);
  const text = noteOf(io).args[4];
  // The gates-green claim in WORDS: tier, the command that ran, that it exited green, the HEAD.
  assert.match(text, /\*\*Gates: GREEN\.\*\*/);
  assert.ok(text.includes(headOf(s)), 'the comment must name the commit it certifies');
  assert.match(text, /1 declared boundary command\(s\) ran and every one exited 0: ok\./);
  assert.match(text, /gate policy that changed mid-feature/, 'the human must see it as they approve');
  assert.match(text, /- the boundary gate policy changed at 2026-07-24T/,
    'which tier moved and when — the facts the history actually retains');
  assert.match(text, /runs — boundary: ok; task: no declared commands/,
    'and what the policy it is certified by runs TODAY, in words');
  assert.match(text, /earned across a policy re-pin/, "the receipt's own narrower fact, not dropped as duplication");
  assert.doesNotMatch(text, /TIER-0 ONLY/, 'this feature declares a real command');
  assert.doesNotMatch(text, /waiver used/i);
  // The superseded policy is named by TIER and TIME, never by hash: a hash in the MR proves
  // nothing to a colleague and cannot be checked without the machine-local dossier.
  assert.ok(!text.includes(pinBefore), `the comment must not carry the superseded policy hash: ${text}`);
});

test('a TASK-tier re-pin also reaches the finalize comment, though no boundary receipt can witness it', async () => {
  // THE CASE THE RECEIPT-DERIVED TRAIL MISSED ENTIRELY, and the reason the trail lives in
  // feature.json. `--repin` moves BOTH tiers, but a receipt is per tier: weakening the TASK gate
  // and adopting it stamps `repinnedFrom` on a TASK receipt, while finalize reads the BOUNDARY
  // receipt — so the pre-merge human saw nothing at all. The history is what closes it.
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  // Declare a command on the TASK tier only, after `feature start` pinned `gates: {}`, and adopt
  // it via the ladder's boundary run: a BOUNDARY run whose own tier did not move — the task tier did.
  setGates(s, { commands: { ok: { argv: [NODE, '-e', 'process.exit(0)'], timeoutMs: 30000 } }, task: ['ok'], boundary: [] });
  const pinBefore = featureJson(s).commandPolicyHash;
  ladder(s, { boundary: ['--boundary', '--repin'] });

  const boundary = tasksJson(s).receipts.boundary;
  assert.equal('repinnedFrom' in boundary, false,
    'fixture: the boundary tier did not move, so its receipt carries nothing — that is the whole point');
  const history = featureJson(s).commandPolicyHistory;
  assert.equal(history.length, 1, 'but the pin moved, so the history has it');
  assert.notEqual(history[0].to.task, pinBefore.task, 'and it is the TASK pin that changed');

  const io = makeIo(glabServer(s));
  assert.equal((await finalize(s, io)).code, 0);
  const text = noteOf(io).args[4];
  assert.match(text, /gate policy that changed mid-feature/,
    'a task-tier re-pin must reach the human too, or the guarantee is boundary-only');
  assert.match(text, /- the task gate policy changed at/, 'naming the TASK tier');
  assert.doesNotMatch(text, /- the boundary gate policy/, 'and only the tier that actually moved');
  assert.match(text, /runs — boundary: no declared commands \(tier-0 only\); task: ok\./);
  assert.doesNotMatch(text, /earned across a policy re-pin/, 'this boundary certificate was not');
});

test('the finalize comment marks a TIER-0-ONLY certificate as weak, and an ordinary one carries no audit lines', async () => {
  const s = scenario(); // `project init` scaffolds gates: {} ⇒ 0 declared boundary commands
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io = makeIo(glabServer(s));
  assert.equal((await finalize(s, io)).code, 0);
  const text = noteOf(io).args[4];
  assert.match(text, /TIER-0 ONLY/, 'a green receipt certifying only "no secrets" must say so (R11)');
  assert.match(text, /says NOTHING\s+about tests, lint or types/);
  assert.doesNotMatch(text, /declared boundary command\(s\) ran/, 'none did');
  assert.doesNotMatch(text, /changed mid-feature/, 'nothing was re-pinned');
  assert.doesNotMatch(text, /waiver used/i, 'and no waiver was used');
  assert.doesNotMatch(text, /earned across a policy re-pin/);
});

// --- 7c. T18: the body is a HUMAN DOCUMENT, the metadata is an append-only COMMENT --------------

test('the body is the session prose plus EXACTLY ONE kernel line — and no hash reaches the MR', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const prose = 'Adds a utils test suite.\n\nHow to review: start at src/a.mjs.\n\nResidual: F4 is out of scope.\n';
  const io = makeIo(glabServer(s));
  const r = await finalize(s, io, [...NOW, '--description-file', descriptionFile(s, prose)]);
  assert.equal(r.code, 0, r.stderr);
  // EXACT equality, not a match: "the kernel appends exactly one trailing line and nothing else"
  // is only testable as an equality — a substring assertion passes on a body that also carries a
  // receipt block, which is the thing being removed.
  assert.equal(bodyOf(io),
    'Adds a utils test suite.\n\nHow to review: start at src/a.mjs.\n\nResidual: F4 is out of scope.'
    + '\n\nOpened by legion finalize · evidence trail in the feature dossier.');
  assert.doesNotMatch(bodyOf(io), HASHLIKE, 'no derived identifier may reach the MR body');
  // The evidence did not vanish — it moved to the comment, where it stays current per event.
  assert.ok(noteOf(io), 'the finalize-event comment is what carries the process metadata now');
});

test('absent --description-file the body is the feature id plus that line — never invented prose', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io = makeIo(glabServer(s));
  assert.equal((await finalize(s, io)).code, 0);
  assert.equal(bodyOf(io),
    `legion feature ${featureJson(s).featureId}`
    + '\n\nOpened by legion finalize · evidence trail in the feature dossier.');
  assert.doesNotMatch(bodyOf(io), HASHLIKE);
});

test('a MISSING --description-file is a loud refusal naming the path — zero remote calls', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const missing = join(s.dossier, 'mr-description.md');
  const io = makeIo(glabServer(s));
  const r = await finalize(s, io, [...NOW, '--description-file', missing]);
  assertRefused(r, io, /--description-file .*mr-description\.md does not exist/);
  assert.match(r.stderr, /never invents prose/);
  assert.ok(!('mr' in featureJson(s)), 'and nothing was recorded');
});

test('an EMPTY --description-file refuses rather than silently publishing a bare MR', async () => {
  // Passing the flag is a claim that an overview was authored. Honouring an empty file with the
  // id-only fallback would open an MR that says nothing while the session believes it said
  // something — the same "success the code does not deliver" shape the fallback exists to avoid.
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io = makeIo(glabServer(s));
  const r = await finalize(s, io, [...NOW, '--description-file', descriptionFile(s, '   \n\n')]);
  assertRefused(r, io, /is empty — an empty overview is not an overview/);
});

test('a comment is posted on CREATE and again on RE-FINALIZE, each certifying its own HEAD', async () => {
  // THE describe()-STALE LIMITATION, retired. The body is written once, at create; the ordinary
  // pre-merge-rejection → fixup loop then moves HEAD, and before T18 the MR still described the
  // FIRST head forever. An append-only comment per finalize EVENT is what makes the trail current.
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io1 = makeIo(glabServer(s));
  assert.equal((await finalize(s, io1)).code, 0);
  const head1 = headOf(s);
  assert.ok(noteOf(io1).args[4].includes(head1), 'the create-path comment certifies the created HEAD');

  commitInWorktree(s, { 'src/a.mjs': 'export const a = 2;\n' }, 'fixup');
  refresh(s);
  const head2 = headOf(s);
  assert.notEqual(head2, head1);

  const io2 = makeIo(glabServer(s, { open: true }));
  const r2 = await finalize(s, io2, NOW);
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(!io2.calls.some((c) => c.kind === 'glab' && c.args[1] === 'create'), 'never a second mr create');
  const second = noteOf(io2);
  assert.ok(second, 'a re-finalize must post its own comment — that is what retires the stale body');
  assert.deepEqual(second.args.slice(0, 4), ['mr', 'note', '42', '--message']);
  assert.ok(second.args[4].includes(head2), 'and it certifies the NEW head');
  assert.ok(!second.args[4].includes(head1), 'not the head the body still describes');
  assert.match(r2.stdout, /posted the gates-green comment on MR !42/);
});

test('a comment-post failure is REPORTED, never fatal: the MR stays open and recorded, exit 0', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const before = featureJson(s);
  const io = makeIo(glabServer(s, { onNote: () => { throw new Error('glab: 403 Forbidden'); } }));

  const r = await finalize(s, io);
  assert.equal(r.code, 0, `a lost comment must not fail a finalize that pushed and recorded\n${r.stderr}`);
  assert.match(r.stderr, /THE MR COMMENT COULD NOT BE POSTED: glab: 403 Forbidden/);
  assert.match(r.stderr, /THE MR EXISTS AND IS RECORDED: !42/);
  assert.doesNotMatch(r.stderr, /finalize FAILED/, 'it is not a failure of the finalize');
  // The composed text is printed for the operator, because an idempotent re-run posts nothing.
  assert.match(r.stderr, /--- 8< ---[\s\S]*\*\*Gates: GREEN\.\*\*[\s\S]*--- >8 ---/);
  assert.match(r.stderr, /will NOT post it/);
  // The two facts the message claims are true of the manifest.
  const after = featureJson(s);
  assert.equal(after.mr.iid, 42);
  assert.equal(after.mr.headSha, headOf(s));
  assert.equal(after.revision, before.revision + 1);
});

test('the idempotent re-run posts NO comment — no finalize event happened', async () => {
  // Append-only is PER EVENT. A re-run at the same head pushes nothing, opens nothing and writes
  // nothing, so a comment would be a claim that something happened.
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  assert.equal((await finalize(s, makeIo(glabServer(s)))).code, 0);
  const io2 = makeIo(glabServer(s, { open: true }));
  assert.equal((await finalize(s, io2)).code, 0);
  assert.deepEqual(io2.calls, [], 'an idempotent re-run must not touch the remote at all');
});

// --- 7d. T37: the closing-reference line + the append-only TICKET comment ----------------------
//
// The ticket is OPERATOR-SUPPLIED DATA (kernel/ticket.mjs header): it gates nothing here, so
// every test below is about RENDERING and about REACH — what the body says, which issue is
// commented, how many times, and above all what a TICKET-LESS feature still does, byte for byte.

/** Patch the ticket fields of project.json AFTER `feature start` — the read-time-resolution
 * fixture. It cannot cause gate-policy drift: the `gates` block is untouched. */
function setTicketConfig(s, fields) {
  const cfg = readJson(s.configPath);
  writeFileSync(s.configPath, `${JSON.stringify({ ...cfg, ...fields }, null, 2)}\n`);
}
/** Write ~/.legion/orgs/default/org.json VERBATIM — including deliberately corrupt bytes, which
 * is a state no legion command produces and the whole point of the refusal being tested. */
function writeOrgConfig(s, text) {
  writeFileSync(join(s.home, 'orgs', 'default', 'org.json'), text);
}
const TRAILER = 'Opened by legion finalize · evidence trail in the feature dossier.';

test('a ticketed feature: the closing line JOINS the kernel tail, and ONE issue note carries the MR url', async () => {
  const s = scenario('fix-proj', { ticket: '#123' });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  assert.equal(featureJson(s).ticket, '#123', 'the real flag wrote the real field');
  const io = makeIo(glabServer(s));
  const r = await finalize(s, io, [...NOW, '--description-file', descriptionFile(s, 'Prose.\n')]);
  assert.equal(r.code, 0, r.stderr);

  // EXACT equality: "prose plus ONE kernel-appended tail" does not get looser because a ticket
  // exists — the closing line joins that tail, it does not become a third block.
  assert.equal(bodyOf(io), `Prose.\n\nCloses #123\n${TRAILER}`);
  assert.doesNotMatch(bodyOf(io), HASHLIKE, 'a ticket buys the body a link, never a hash');

  const notes = issueNotesOf(io);
  assert.equal(notes.length, 1, `exactly one issue note per event: ${JSON.stringify(notes, null, 2)}`);
  assert.deepEqual(notes[0].args.slice(0, 4), ['issue', 'note', '123', '--message']);
  assert.equal(notes[0].cwd, s.worktree);
  assert.ok(notes[0].args[4].includes('https://gitlab.invalid/acme/fix-proj/-/merge_requests/42'),
    'the issue note carries the MR link — that is what it is for');
  assert.ok(notes[0].args[4].includes(headOf(s)), 'and the head this event finalized');
  // The comment is LAST: an issue can never be told about an MR feature.json does not know.
  assert.equal(io.calls.at(-1), notes[0]);
  assert.ok(noteOf(io), 'the MR still gets its own gates-green comment — different audience');
  assert.match(r.stdout, /posted the finalize-event comment on issue #123/);
});

test('a resolved ticket project renders the CROSS-PROJECT form and targets --repo; none renders bare', async () => {
  // GitLab's auto-close fires cross-project only on the full path, so the two cases must render
  // differently — and the issue note must be posted where the issue actually lives.
  const bare = scenario('fix-proj', { ticket: '7' });
  commitInWorktree(bare, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(bare);
  const io1 = makeIo(glabServer(bare));
  assert.equal((await finalize(bare, io1)).code, 0);
  assert.ok(bodyOf(io1).endsWith(`\n\nCloses #7\n${TRAILER}`), bodyOf(io1));
  assert.deepEqual(issueNotesOf(io1)[0].args.slice(0, 4), ['issue', 'note', '7', '--message']);
  assert.ok(!issueNotesOf(io1)[0].args.includes('--repo'),
    'with no ticket project glab resolves the issue from the worktree remote, exactly as it does the MR');

  // Configured project: the config is read at FINALIZE time, so setting it after `feature start`
  // is exactly the supported operator move.
  const cross = scenario('fix-proj', { ticket: '#7' });
  commitInWorktree(cross, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(cross);
  setTicketConfig(cross, { ticketProject: 'acme/tracker' });
  const io2 = makeIo(glabServer(cross));
  assert.equal((await finalize(cross, io2)).code, 0);
  assert.ok(bodyOf(io2).endsWith(`\n\nCloses acme/tracker#7\n${TRAILER}`), bodyOf(io2));
  const n2 = issueNotesOf(io2)[0];
  assert.deepEqual(n2.args.slice(0, 3), ['issue', 'note', '7']);
  assert.deepEqual(n2.args.slice(-2), ['--repo', 'acme/tracker']);

  // A ref that names its OWN project wins over config: it points at one specific issue.
  const explicit = scenario('fix-proj', { ticket: 'other/tracker#9' });
  commitInWorktree(explicit, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(explicit);
  setTicketConfig(explicit, { ticketProject: 'acme/tracker' });
  const io3 = makeIo(glabServer(explicit));
  assert.equal((await finalize(explicit, io3)).code, 0);
  assert.ok(bodyOf(io3).endsWith(`\n\nCloses other/tracker#9\n${TRAILER}`), bodyOf(io3));
  assert.deepEqual(issueNotesOf(io3)[0].args.slice(-2), ['--repo', 'other/tracker']);
});

test('a TICKET-LESS finalize is BYTE-IDENTICAL to pre-T37: same call sequence, same body, no issue call', async () => {
  // THE RED LINE OF THE WHOLE TRACK. Pinned by LITERAL expectation rather than by re-deriving
  // anything from the code under test: a re-derived expectation moves with the code it is meant
  // to hold still.
  const s = scenario(); // no --ticket
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  assert.ok(!('ticket' in featureJson(s)), 'the field is OMITTED, not null');
  // A ticket project configured for the PROJECT changes nothing: with no ticket there is nothing
  // to render and nobody to comment.
  setTicketConfig(s, { ticketProject: 'acme/tracker', ticketClosingStyle: 'fixes' });
  const io = makeIo(glabServer(s));
  const r = await finalize(s, io, [...NOW, '--description-file', descriptionFile(s, 'Prose.\n')]);
  assert.equal(r.code, 0, r.stderr);

  assert.equal(bodyOf(io), `Prose.\n\n${TRAILER}`, 'the tail is BODY_TRAILER alone');
  assert.deepEqual(
    io.calls.map((c) => (c.kind === 'gitPush' ? 'gitPush' : `glab ${c.args[0]} ${c.args[1]}`)),
    ['gitPush', 'glab mr view', 'glab mr create', 'glab mr view', 'glab mr note'],
    'the five-call sequence of the pre-T37 happy path, unchanged and with nothing appended',
  );
  assert.deepEqual(issueNotesOf(io), [], 'a ticket-less feature makes NO issue call at all');
  assert.doesNotMatch(r.stdout, /issue/);
});

test('re-finalize at a NEW head posts a SECOND issue note — append-only, never an edit', async () => {
  const s = scenario('fix-proj', { ticket: '#123' });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io1 = makeIo(glabServer(s));
  assert.equal((await finalize(s, io1)).code, 0);
  const head1 = headOf(s);
  assert.equal(issueNotesOf(io1).length, 1);
  assert.ok(issueNotesOf(io1)[0].args[4].includes(head1));

  commitInWorktree(s, { 'src/a.mjs': 'export const a = 2;\n' }, 'fixup');
  refresh(s);
  const head2 = headOf(s);
  assert.notEqual(head2, head1);

  const io2 = makeIo(glabServer(s, { open: true }));
  const r2 = await finalize(s, io2);
  assert.equal(r2.code, 0, r2.stderr);
  const second = issueNotesOf(io2);
  assert.equal(second.length, 1, 'one per EVENT — the second event posts its own, not an edit of the first');
  assert.equal(second[0].args[1], 'note', 'the ONLY issue subcommand this kernel composes');
  assert.ok(second[0].args[4].includes(head2), 'and it certifies the NEW head');
  assert.ok(!second[0].args[4].includes(head1));
  // Append-only, stated as the absence it is: no argv anywhere may mutate an existing note.
  for (const c of [...io1.calls, ...io2.calls]) {
    if (c.kind !== 'glab') continue;
    assert.ok(!['update', 'edit', 'delete', 'note-update', 'reply'].includes(c.args[1]),
      `finalize composed a MUTATING glab call: ${c.args.join(' ')}`);
  }
});

test('the same-head re-run posts NO issue comment either — no finalize event happened', async () => {
  const s = scenario('fix-proj', { ticket: '#123' });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  assert.equal((await finalize(s, makeIo(glabServer(s)))).code, 0);
  const io2 = makeIo(glabServer(s, { open: true }));
  assert.equal((await finalize(s, io2)).code, 0);
  assert.deepEqual(io2.calls, [], 'a ticket buys no new remote call on an idempotent re-run');
});

test('an ISSUE-comment failure is REPORTED, never fatal: exit 0, the MR comment still posted', async () => {
  const s = scenario('fix-proj', { ticket: '#123' });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io = makeIo(glabServer(s, { onIssueNote: () => { throw new Error('glab: 404 Not Found'); } }));
  const r = await finalize(s, io);
  assert.equal(r.code, 0, `a lost issue comment must not fail a finalize that pushed and recorded\n${r.stderr}`);
  assert.match(r.stderr, /THE TICKET COMMENT COULD NOT BE POSTED on issue #123: glab: 404 Not Found/);
  assert.match(r.stderr, /THE MR EXISTS AND IS RECORDED: !42/);
  assert.doesNotMatch(r.stderr, /finalize FAILED/);
  assert.match(r.stderr, /--- 8< ---[\s\S]*merge_requests\/42[\s\S]*--- >8 ---/, 'the composed text is printed to paste');
  assert.ok(noteOf(io), 'and the MR comment — posted BEFORE it — is untouched by the failure');
  assert.equal(featureJson(s).mr.headSha, headOf(s), 'the record the message claims exists, does');
});

test('an MR-comment failure still ATTEMPTS the ticket comment — the two trys are independent both ways', async () => {
  const s = scenario('fix-proj', { ticket: '#123' });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io = makeIo(glabServer(s, { onNote: () => { throw new Error('glab: 403 Forbidden'); } }));
  const r = await finalize(s, io);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stderr, /THE MR COMMENT COULD NOT BE POSTED/);
  assert.equal(issueNotesOf(io).length, 1,
    'one lost comment must never cost the other — sharing a try would swallow this one silently');
  assert.match(r.stdout, /posted the finalize-event comment on issue #123/);
});

test('config edited between `feature start` and finalize renders the NEW value — resolution is at READ time', async () => {
  // The ticket format is not evidence-bearing, so it is PINNED NOWHERE (contrast the gate policy
  // pin). An operator who picked the wrong closing keyword fixes the config, not the feature.
  const s = scenario('fix-proj', { ticket: '#123' });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  assert.ok(!JSON.stringify(featureJson(s)).includes('ticketClosingStyle'),
    'nothing about the RENDERING may be written into the feature manifest');
  setTicketConfig(s, { ticketClosingStyle: 'refs' });
  const io = makeIo(glabServer(s));
  assert.equal((await finalize(s, io)).code, 0);
  assert.ok(bodyOf(io).endsWith(`\n\nRefs #123\n${TRAILER}`), bodyOf(io));

  // And the org level composes underneath it, read just as freshly.
  const org = scenario('fix-proj', { ticket: '#5' });
  commitInWorktree(org, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(org);
  writeOrgConfig(org, `${JSON.stringify({ ticketProject: 'acme/tracker', ticketClosingStyle: 'fixes' }, null, 2)}\n`);
  const io2 = makeIo(glabServer(org));
  assert.equal((await finalize(org, io2)).code, 0);
  assert.ok(bodyOf(io2).endsWith(`\n\nFixes acme/tracker#5\n${TRAILER}`), bodyOf(io2));
});

test('a CORRUPT org.json refuses LOUDLY before any remote call — never after the push', async () => {
  // A refusal discovered after the push is a refusal that cannot un-push, which is why the ticket
  // is resolved with the verification chain rather than at the moment of rendering. The empty call
  // log IS the ordering assertion.
  const s = scenario('fix-proj', { ticket: '#123' });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  writeOrgConfig(s, '{ this is not json\n');
  const io = makeIo(glabServer(s));
  const r = await finalize(s, io);
  assertRefused(r, io, /org\.json exists but cannot be read as JSON/);
  assert.match(r.stderr, /NOT treated as absent/);
  assert.ok(!('mr' in featureJson(s)), 'and nothing was recorded');

  // Fix the file and the same feature finalizes — the refusal was about the config, not the ticket.
  writeOrgConfig(s, `${JSON.stringify({ ticketClosingStyle: 'resolves' }, null, 2)}\n`);
  const io2 = makeIo(glabServer(s));
  assert.equal((await finalize(s, io2)).code, 0);
  assert.ok(bodyOf(io2).endsWith(`\n\nResolves #123\n${TRAILER}`), bodyOf(io2));
});

test('a hand-edited GARBAGE ticket field refuses before any remote call, naming feature.json', async () => {
  // `feature start --ticket` and `legion state ticket-record` both validate, so only a hand-edit
  // reaches here — and composing a link out of garbage, or silently dropping it and opening an MR
  // the operator believes links their issue, are both worse than refusing.
  const s = scenario('fix-proj', { ticket: '#123' });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const p = join(s.dossier, 'feature.json');
  writeFileSync(p, `${JSON.stringify({ ...readJson(p), ticket: 'not a ref' }, null, 2)}\n`);
  const io = makeIo(glabServer(s));
  assertRefused(await finalize(s, io), io, /the feature's ticket could not be resolved:[\s\S]*feature\.json/);
});

// --- 8. read-back failure AFTER a successful push -------------------------------------------

// Every case starts with NO open MR (`open: false`), so the probe reports absent, `mr create`
// runs (hence /merge request opened: YES/) and it is the POST-create read-back that fails —
// which is the shape these tests are about. `onView` fires only when an MR exists, i.e. only on
// that read-back.
for (const [label, opts, expect] of [
  ['glab throws', { onView: () => { throw new Error('glab: connection refused'); } }, /connection refused/],
  ['glab returns garbage', { onView: () => 'not json at all' }, /could not parse/],
  ['the MR targets the wrong branch', { over: { target_branch: 'release' } }, /the target branch is "release", expected the PINNED base "main"/],
]) {
  test(`read-back failure (${label}) exits nonzero, reports the push, records NO mr`, async () => {
    const s = scenario();
    commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
    ladder(s);
    const before = featureJson(s);
    const io = makeIo(glabServer(s, { open: false, ...opts }));

    const r = await finalize(s, io);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, /finalize FAILED AFTER THE REMOTE WRITE/);
    assert.match(r.stderr, expect);
    assert.match(r.stderr, /branch pushed to origin: YES/);
    assert.match(r.stderr, /merge request opened: {6}YES/);
    assert.match(r.stderr, /recorded in feature\.json: {2}NO/);
    assert.match(r.stderr, /CHECK GITLAB BY HAND/);

    const after = featureJson(s);
    assert.ok(!('mr' in after), 'a failed read-back must never leave an mr record');
    assert.equal(after.revision, before.revision, 'nothing was written');
  });
}

test('a read-back missing iid/url is a failure, not a partial record', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io = makeIo(glabServer(s, { over: { iid: '42', web_url: undefined } }));
  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /the MR id must be an integer/);
  assert.match(r.stderr, /the url must be a non-empty string/);
  assert.ok(!('mr' in featureJson(s)));
});

test('a read-back whose sha is not the pushed HEAD is a failure', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io = makeIo(glabServer(s, { over: { sha: '0'.repeat(40) } }));
  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /the head sha is "0{40}", expected the pushed HEAD/);
  assert.ok(!('mr' in featureJson(s)));
});

// --- 9. idempotence ------------------------------------------------------------------------------

test('a re-run at the SAME head is idempotent: zero io calls, zero writes, exit 0', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  assert.equal((await finalize(s, makeIo(glabServer(s)))).code, 0);
  const after1 = featureJson(s);

  const io2 = makeIo(glabServer(s));
  const r = await finalize(s, io2);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /already recorded for HEAD/);
  assert.deepEqual(io2.calls, [], 'an idempotent re-run must not touch the remote');
  assert.deepEqual(featureJson(s), after1, 'an idempotent re-run must not write');
});

test('a re-run at a NEW head pushes and re-reads BY IID — never a second `mr create`', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  assert.equal((await finalize(s, makeIo(glabServer(s)))).code, 0);

  // A fixup commit, re-gated and re-approved — the ordinary "pre-merge rejection → fixup" loop.
  // The feature already stands in finalize, so only the head-bound evidence is re-earned.
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 2;\n' }, 'fixup');
  refresh(s);
  const newHead = headOf(s);
  const before = featureJson(s);

  // The MR really is open server-side after run 1 — and `mr create` would now THROW if reached.
  const io = makeIo(glabServer(s, { open: true }));
  const r = await finalize(s, io);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(io.calls.length, 3, JSON.stringify(io.calls, null, 2));
  assert.equal(io.calls[0].kind, 'gitPush');
  assert.deepEqual(io.calls[1].args, ['mr', 'view', '42', '--output', 'json']);
  assert.deepEqual(io.calls[2].args.slice(0, 3), ['mr', 'note', '42']);
  assert.ok(!io.calls.some((c) => c.kind === 'glab' && c.args[1] === 'create'), 'never a second mr create');
  assert.equal(featureJson(s).mr.headSha, newHead);
  assert.equal(featureJson(s).revision, before.revision + 1);
});

test('a create that succeeds with a failed read-back records nothing — and the NEXT run finds that MR without creating a second', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const before = featureJson(s);

  // Run 1: no MR exists ⇒ the probe reports absent ⇒ create succeeds ⇒ the read-back fails.
  // `onView` fires only once an MR exists, so the FIRST onView call IS the post-create read-back.
  let views = 0;
  const io1 = makeIo(glabServer(s, {
    open: false,
    onView: () => { if (++views === 1) throw new Error('glab: connection refused'); },
  }));
  const r1 = await finalize(s, io1);
  assert.equal(r1.code, 1, r1.stdout);
  assert.match(r1.stderr, /merge request opened: {6}YES/);
  assert.match(r1.stderr, /recorded in feature\.json: {2}NO/);
  assert.ok(!('mr' in featureJson(s)), 'a failed read-back must never leave an mr record');
  assert.equal(featureJson(s).revision, before.revision, 'nothing was written');

  // Run 2: the MR really is open on the server, and nothing in feature.json points at it. The
  // old code called `mr create` again and could never recover; this one resolves it by branch.
  const io2 = makeIo(glabServer(s, { open: true }));
  const r2 = await finalize(s, io2);
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(!io2.calls.some((c) => c.kind === 'glab' && c.args[1] === 'create'), 'never a second mr create');
  assert.equal(io2.calls.length, 3, JSON.stringify(io2.calls, null, 2));
  assert.equal(io2.calls[0].kind, 'gitPush');
  assert.deepEqual(io2.calls[1].args, ['mr', 'view', 'feat/f1', '--output', 'json']);
  assert.deepEqual(io2.calls[2].args.slice(0, 3), ['mr', 'note', '42']);
  assert.match(r2.stdout, /already open for feat\/f1/);
  assert.equal(featureJson(s).mr.iid, 42);
  assert.equal(featureJson(s).mr.headSha, headOf(s));
  assert.equal(featureJson(s).revision, before.revision + 1);
});

// --- 9b. a concurrent write to feature.json during the remote round trips ----------------------

test('a concurrent write to feature.json between the push and the record is refused, not reverted', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const before = featureJson(s);

  // The SessionStart hook's `session-record` (PLAN-V3 §Startup) firing mid-finalize, spawned
  // through the REAL bin so it is a genuine typed write with a genuine revision bump.
  const io = makeIo(glabServer(s, {
    onCreate: () => {
      const r = spawnSync(NODE, [BIN, 'state', 'session-record', '--session-id', 's2', ...NOW],
        { cwd: s.worktree, encoding: 'utf8', env: s.env });
      assert.equal(r.status, 0, r.stderr);
    },
  }));

  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /finalize FAILED AFTER THE REMOTE WRITE/);
  assert.match(r.stderr, /revision \d+ → \d+/);
  assert.match(r.stderr, /THE MR IS OPEN/);

  const after = featureJson(s);
  assert.ok(!('mr' in after), 'finalize must not record over a manifest that moved');
  assert.equal(after.currentSession, 's2', 'the concurrent write SURVIVED');
  assert.equal(after.revision, before.revision + 1, "the revision is the concurrent write's, not finalize's");
});

// --- 10. a hostile ambient environment must not change WHICH repo is finalized -----------------

test('a hostile GIT_DIR/GIT_WORK_TREE aimed at repo B does not redirect finalize away from A', async () => {
  const a = scenario('proj-a');
  const b = scenario('proj-b');
  commitInWorktree(a, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(a);
  commitInWorktree(b, { 'src/b.mjs': 'export const b = 2;\n' });
  ladder(b);
  const bBefore = featureJson(b);

  const io = makeIo(glabServer(a));
  const r = await finalize(a, io, NOW, { GIT_DIR: join(b.repo, '.git'), GIT_WORK_TREE: b.repo });
  assert.equal(r.code, 0, r.stderr);

  // The repo the operator stood in is the one that was verified and pushed.
  assert.equal(io.calls[0].worktree, a.worktree);
  assert.equal(io.calls[0].branch, 'feat/f1');
  for (const c of io.calls) if (c.kind === 'glab') assert.equal(c.cwd, a.worktree);
  const recorded = JSON.stringify(io.calls);
  for (const needle of [b.repo, b.worktree, b.dossier, 'proj-b']) {
    assert.ok(!recorded.includes(needle), `the recorded calls refer to repo B: ${needle}`);
  }

  // B is not a party to this command.
  assert.deepEqual(featureJson(b), bBefore, "B's feature.json was written by a command run in A");
  assert.equal(featureJson(a).mr.headSha, headOf(a));
});

// --- usage / argv shape --------------------------------------------------------------------------

test('a stray positional and a bad --now die loudly before anything is resolved', async () => {
  const io = makeIo();
  await assert.rejects(() => finalizeCore(['ship-it'], io), /takes no positional arguments/);
  await assert.rejects(() => finalizeCore(['--now', 'never'], io), /invalid --now/);
  assert.deepEqual(io.calls, []);
});

// --- the seam's own argv: a SOURCE assertion, and labelled as one -------------------------------

test('the push seam uses a fully-qualified refspec and never --force (source guard)', () => {
  // The refspec lives inside realIo(); executing it would be a real push, which this suite
  // must never do. A source assertion is the honest substitute — it catches the regression that
  // matters (someone "simplifying" to `git push origin <branch>`, which `push.default` /
  // `remote.<n>.push` in the operator's config can then redirect, or adding --force).
  const src = readFileSync(join(ROOT, 'src', 'cli', 'finalize.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.match(code, /gitUserRepo\(\['push', '--set-upstream', remote, `refs\/heads\/\$\{branch\}:refs\/heads\/\$\{branch\}`\]/);
  assert.ok(!/--force/.test(code), 'finalize must never force-push');
  assert.match(code, /GIT_TERMINAL_PROMPT: '0'/, 'a missing credential must fail, never hang');
});

// --- the push subprocess environment: prompt-hardened, and NO retired marker --------------------
// Until 2026-08-07 pushEnv also carried LEGION_FINALIZE_PUSH=1, the marker the retired local
// pre-push guard keyed its allow rule on. The guards were removed (server-only decision —
// src/kernel/githooks.mjs header); what is pinned here is that the marker stayed removed and the
// one property that still matters — a missing credential fails loudly — survived it.

test('pushEnv hardens the prompt, preserves the base, and carries no retired marker', () => {
  const built = pushEnv({ PATH: '/nowhere', KEEP: 'yes' });
  assert.equal(built.GIT_TERMINAL_PROMPT, '0');
  assert.equal(built.KEEP, 'yes', 'the caller\'s environment must survive');
  assert.ok(!('LEGION_FINALIZE_PUSH' in built),
    'the marker died with the guard it announced this push to');

  // In source too: nothing may set the marker anywhere — process-wide or on any subprocess.
  const src = readFileSync(join(ROOT, 'src', 'cli', 'finalize.mjs'), 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
  assert.ok(!/LEGION_FINALIZE_PUSH/.test(code), 'the marker must not come back in code');
  assert.equal((code.match(/pushEnv\(/g) ?? []).length, 2,
    'pushEnv is defined once and called once — from gitPush and nowhere else');
});

// --- GITHUB (2026-08-15 — the second forge) ------------------------------------------------------
// The claim under test is NOT "gh works" (a fake cannot prove that) but "the SAME flow, driving
// the OTHER CLI, composes the argvs GitHub's semantics require and records the same shape". The
// gitlab cases above are unchanged and still pass — that is half the evidence; these are the
// other half. `makeIo(..., 'gh')` throws if glab is touched, so drift toward the wrong CLI is a
// failure rather than a silent double-support.

const GH_REMOTE = 'git@github.com:acme/fix-proj.git';
/** A finalizable GitHub feature: a github.com origin, so `project init` records forge github. */
function ghScenario(opts = {}) {
  const s = scenario('fix-proj', { ...opts, remote: GH_REMOTE });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  return s;
}

test('github: push once, one PR against the PINNED base, read back, recorded with # notation', async () => {
  const s = ghScenario();
  ladder(s);
  const head = headOf(s);
  const before = featureJson(s);
  const io = makeIo(ghServer(s), 'gh');

  const r = await finalize(s, io, [...NOW, '--description-file', descriptionFile(s)]);
  assert.equal(r.code, 0, r.stderr);

  // THE CALL ORDER IS THE CONTRACT, exactly as on gitlab: push → look up → create → read back →
  // comment. Nothing before the push, and the comment strictly after the record.
  assert.deepEqual(io.calls.map((c) => `${c.kind} ${c.args ? c.args.slice(0, 2).join(' ') : ''}`.trim()), [
    'gitPush', 'gh pr view', 'gh pr create', 'gh pr view', 'gh pr comment',
  ]);
  for (const c of io.calls) assert.equal(c.cwd ?? c.worktree, s.worktree, 'every call runs in the worktree');

  // The create argv: gh's OWN flag spelling, and the target is the PINNED base, never a flag.
  const create = io.calls.find((c) => c.args?.[1] === 'create');
  assert.deepEqual(create.args.slice(0, 6), ['pr', 'create', '--head', 'feat/f1', '--base', 'main']);
  assert.equal(create.args[create.args.indexOf('--title') + 1], 'f1');
  const body = create.args[create.args.indexOf('--body') + 1];
  assert.match(body, /How to review it/, "the session's prose is the body");
  assert.match(body, /Opened by legion finalize · evidence trail in the feature dossier\.$/);
  assert.ok(!HASHLIKE.test(body), 'no hashes in a PR body, on either forge');

  // The read-back is gh's --json projection, and the fields it asks for are the ones validated.
  assert.deepEqual(io.calls[1].args, ['pr', 'view', 'feat/f1', '--json', 'number,url,baseRefName,headRefName,headRefOid,state']);

  // The record: same SHAPE as gitlab (close delivered reads headSha out of it), forge marker github.
  assert.deepEqual(featureJson(s).mr, {
    iid: 42,
    url: 'https://github.com/acme/fix-proj/pull/42',
    targetBranch: 'main',
    headSha: head,
    at: NOW_ISO,
    forge: 'github',
  });
  assert.equal(featureJson(s).revision, before.revision + 1, 'exactly one revision-bumping write');
  assert.match(r.stdout, /recorded PR #42 → https:\/\/github\.com\/acme\/fix-proj\/pull\/42/);
  assert.ok(!r.stdout.includes('!42'), "GitLab's !iid notation must never appear for a PR");
});

test('github: a CLOSED PR for the branch does NOT suppress create — an open one does', async () => {
  // THE ONE REAL SEMANTIC DIFFERENCE (src/cli/finalize.mjs probeOpenMr): `gh pr view <branch>`
  // resolves closed and merged PRs too. Reading that as "already open" would refuse to open the
  // PR this finalize exists to open, and the feature would be stranded with no kernel path.
  const s = ghScenario();
  ladder(s);
  const io = makeIo(ghServer(s, { open: true, state: 'CLOSED' }), 'gh');
  assert.equal((await finalize(s, io)).code, 0);
  assert.ok(io.calls.some((c) => c.args?.[1] === 'create'), 'a closed PR must not suppress create');
  assert.equal(featureJson(s).mr.iid, 42);

  // …while an OPEN one is exactly what the look-first probe exists to find: no second create.
  const s2 = ghScenario();
  ladder(s2);
  const io2 = makeIo(ghServer(s2, { open: true, state: 'OPEN' }), 'gh');
  const r2 = await finalize(s2, io2);
  assert.equal(r2.code, 0, r2.stderr);
  assert.ok(!io2.calls.some((c) => c.args?.[1] === 'create'), 'an open PR must suppress create');
  assert.match(r2.stdout, /a PR is already open for feat\/f1 — skipping create, recording it/);
});

test('github: a re-run at the same head is idempotent and prints # notation; a moved head re-reads by number', async () => {
  const s = ghScenario();
  ladder(s);
  assert.equal((await finalize(s, makeIo(ghServer(s), 'gh'))).code, 0);

  const idem = makeIo(ghServer(s, { open: true }), 'gh');
  const r = await finalize(s, idem);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(idem.calls, [], 'an idempotent re-run reaches the remote never');
  assert.match(r.stdout, /PR #42 already recorded for HEAD/);
  assert.match(r.stdout, /no push, no PR, no write/);

  // A fixup moves HEAD: the recorded PR is re-read BY NUMBER, never created a second time.
  commitInWorktree(s, { 'src/b.mjs': 'export const b = 2;\n' }, 'fixup');
  refresh(s);
  const io2 = makeIo(ghServer(s, { open: true }), 'gh');
  const r2 = await finalize(s, io2);
  assert.equal(r2.code, 0, r2.stderr);
  assert.deepEqual(io2.calls.map((c) => `${c.kind} ${c.args ? c.args.slice(0, 3).join(' ') : ''}`.trim()), [
    'gitPush', 'gh pr view 42', 'gh pr comment 42',
  ]);
  assert.equal(featureJson(s).mr.headSha, headOf(s), 'the record follows the new head');
});

test('github: the ticket track posts `gh issue comment` and renders the closing line in the PR body', async () => {
  const s = ghScenario({ ticket: '#7' });
  ladder(s);
  const io = makeIo(ghServer(s), 'gh');
  const r = await finalize(s, io);
  assert.equal(r.code, 0, r.stderr);

  const create = io.calls.find((c) => c.args?.[1] === 'create');
  const body = create.args[create.args.indexOf('--body') + 1];
  assert.match(body, /^Closes #7$/m, 'the closing keyword works on GitHub as it does on GitLab');

  const notes = io.calls.filter((c) => c.args?.[0] === 'issue');
  assert.equal(notes.length, 1, 'exactly one issue comment per finalize event');
  assert.deepEqual(notes[0].args.slice(0, 3), ['issue', 'comment', '7']);
  assert.equal(notes[0].args[3], '--body');
  assert.match(notes[0].args[4], /pull request https:\/\/github\.com\/acme\/fix-proj\/pull\/42/);
  assert.ok(!notes[0].args.includes('--repo'), 'no repo flag when the issues live in the code repo');
});

test('github: a failure after the push reports the PR noun, the gh remedy and CHECK GITHUB', async () => {
  const s = ghScenario();
  ladder(s);
  const io = makeIo(ghServer(s, { onView: () => { throw new Error('gh: connection refused'); } }), 'gh');
  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /finalize FAILED AFTER THE REMOTE WRITE: gh: connection refused/);
  assert.match(r.stderr, /branch pushed to origin: YES/);
  assert.match(r.stderr, /pull request opened: {7}YES/);
  assert.match(r.stderr, /recorded in feature\.json: {2}NO/);
  assert.match(r.stderr, /CHECK GITHUB BY HAND: an open PR may exist/);
  assert.match(r.stderr, /once gh works/);
  assert.ok(!('mr' in featureJson(s)), 'a failed read-back must never leave a record');
});

test('github: a read-back that does not match the feature is refused field by field', async () => {
  const s = ghScenario();
  ladder(s);
  const io = makeIo(ghServer(s, { over: { number: '42', url: '', baseRefName: 'release' } }), 'gh');
  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /the PR read back from GitHub does not match this feature/);
  assert.match(r.stderr, /the PR id must be an integer/);
  assert.match(r.stderr, /the url must be a non-empty string/);
  assert.match(r.stderr, /the target branch is "release", expected the PINNED base "main"/);
  assert.ok(!('mr' in featureJson(s)));
});

test('the forge is resolved from CONFIG, not the remote alone — and a broken config refuses pre-remote', async () => {
  // project.json's recorded field beats detection: a github.com remote with `forge: gitlab`
  // recorded (the self-hosted-override shape, inverted) must drive glab.
  const s = ghScenario();
  ladder(s);
  const cfg = readJson(s.configPath);
  writeFileSync(s.configPath, `${JSON.stringify({ ...cfg, forge: 'gitlab' }, null, 2)}\n`);
  const io = makeIo(glabServer(s), 'glab');
  assert.equal((await finalize(s, io)).code, 0, 'the recorded forge decides');
  assert.equal(featureJson(s).mr.forge, 'gitlab');

  // A garbage value refuses BEFORE the remote — the ticket rule, applied to the forge.
  const s2 = ghScenario();
  ladder(s2);
  const cfg2 = readJson(s2.configPath);
  writeFileSync(s2.configPath, `${JSON.stringify({ ...cfg2, forge: 'bitbucket' }, null, 2)}\n`);
  const io2 = makeIo(ghServer(s2), 'gh');
  const r2 = await finalize(s2, io2);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /finalize REFUSED — nothing was pushed: the project's forge could not be resolved/);
  assert.match(r2.stderr, /invalid forge "bitbucket"/);
  assert.deepEqual(io2.calls, [], 'a refusal must reach the remote never');
});

test('a corrupt org.json now refuses a TICKET-LESS finalize too — the 2026-08-15 narrowing, pinned', async () => {
  // BEHAVIOUR CHANGE, deliberate and recorded in src/cli/finalize.mjs's header: forge resolution
  // reads org.json on every run, so the "a ticket-less finalize reads no org.json" property is
  // gone. It fails CLOSED (nothing pushed), which is why the change was acceptable — this test
  // exists so nobody re-discovers it as a surprise.
  const s = ghScenario(); // NO ticket
  ladder(s);
  writeFileSync(join(s.home, 'orgs', 'default', 'org.json'), '{ not json\n');
  const io = makeIo(ghServer(s), 'gh');
  const r = await finalize(s, io);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /finalize REFUSED — nothing was pushed: the project's forge could not be resolved/);
  assert.match(r.stderr, /org\.json/);
  assert.match(r.stderr, /NOT treated as absent/);
  assert.deepEqual(io.calls, [], 'nothing reached the remote');
});

// --- the dual-lens review's findings, pinned (2026-08-15) ----------------------------------------
// Every case below is a defect a reviewer found in the first GitHub implementation. They are kept
// as tests rather than as header prose because each one passed a green suite before it was fixed.

test('github: a recorded PR that is no longer OPEN is refused, never re-recorded as the delivery', async () => {
  // It used to be re-read and ANNOUNCED as "already open" — a sentence the payload contradicted —
  // and `close delivered` would then accept a closed PR as the verified delivery.
  const s = ghScenario();
  ladder(s);
  assert.equal((await finalize(s, makeIo(ghServer(s), 'gh'))).code, 0);
  const recorded = featureJson(s).mr;

  commitInWorktree(s, { 'src/b.mjs': 'export const b = 2;\n' }, 'fixup');
  refresh(s);
  const io = makeIo(ghServer(s, { open: true, state: 'CLOSED' }), 'gh');
  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /the recorded PR #42 is no longer OPEN on GitHub/);
  assert.match(r.stderr, /clear the `mr` field of feature\.json/);
  assert.deepEqual(featureJson(s).mr, recorded, 'the stale record is left exactly as it was');
});

test('github: a read-back with no headRefOid is refused — the local HEAD is never asserted as verified', async () => {
  const s = ghScenario();
  ladder(s);
  const io = makeIo(ghServer(s, { over: { headRefOid: undefined } }), 'gh');
  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /GitHub returned no head sha, so the PR cannot be shown to contain the pushed HEAD/);
  assert.ok(!('mr' in featureJson(s)));
});

test('gitlab keeps its documented sha optionality — the requirement is per forge, not global', async () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s);
  const io = makeIo(glabServer(s, { over: { sha: undefined } }), 'glab');
  const r = await finalize(s, io);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(featureJson(s).mr.iid, 42, 'glab version variance stays tolerated, as before');
});

test('an id recorded on ONE forge is never re-interpreted against another', async () => {
  const s = ghScenario();
  ladder(s);
  assert.equal((await finalize(s, makeIo(ghServer(s), 'gh'))).code, 0);
  assert.equal(featureJson(s).mr.forge, 'github');

  // The project is re-pointed at GitLab; the recorded #42 names an object on the other server.
  const cfg = readJson(s.configPath);
  writeFileSync(s.configPath, `${JSON.stringify({ ...cfg, forge: 'gitlab' }, null, 2)}\n`);
  commitInWorktree(s, { 'src/c.mjs': 'export const c = 3;\n' }, 'fixup');
  refresh(s);
  const io = makeIo(glabServer(s), 'glab');
  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /has a github PR recorded/);
  assert.match(r.stderr, /this project now resolves to 'gitlab'/);
  assert.deepEqual(io.calls, [], 'a refusal must reach the remote never');
});

test('github: a ticket project with more than owner/repo is refused BEFORE the push', async () => {
  // `gh --repo` parses [HOST/]OWNER/REPO, so `group/sub/repo` would post the issue comment at a
  // host named "group". The ref validator is deliberately loose (GitLab nests); the forge-specific
  // narrowing belongs here, pre-remote.
  const s = ghScenario({ ticket: 'group/sub/repo#7' });
  ladder(s);
  const io = makeIo(ghServer(s), 'gh');
  const r = await finalize(s, io);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /finalize REFUSED — nothing was pushed/);
  assert.match(r.stderr, /has 3 path segments, but GitHub addresses issues as owner\/repo/);
  assert.match(r.stderr, /would read 'group' as a HOSTNAME/);
  assert.deepEqual(io.calls, []);

  // …and the same nested path stays legal on GitLab, where projects genuinely nest.
  const s2 = scenario('fix-proj', { ticket: 'group/sub/repo#7' });
  commitInWorktree(s2, { 'src/a.mjs': 'export const a = 1;\n' });
  ladder(s2);
  const io2 = makeIo(glabServer(s2), 'glab');
  assert.equal((await finalize(s2, io2)).code, 0);
  assert.ok(io2.calls.some((c) => c.args?.[0] === 'issue' && c.args.includes('group/sub/repo')));
});

test('a GitHub project whose project.json vanished still drives gh — the remote decides, not the default', async () => {
  // resolveForge's last resort before DEFAULT_FORGE is URL detection, and finalize now hands it
  // the origin URL: without that, a missing project.json silently selected glab at a GitHub remote.
  const s = ghScenario();
  ladder(s);
  rmSync(s.configPath);
  const io = makeIo(ghServer(s), 'gh');
  const r = await finalize(s, io);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(featureJson(s).mr.forge, 'github');
});
