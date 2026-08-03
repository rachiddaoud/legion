// End-to-end guard for `legion plan check` through the REAL bin, against real fixture git
// repos with LEGION_HOME pinned per scenario (the real ~/.legion is NEVER touched). Every
// scenario runs `project init` + `feature start` + `legion state init` to produce a genuine
// worktree + dossier + tasks.json, then drives `legion plan check` from inside the WORKTREE
// (plan check resolves the dossier by git toplevel, exactly as the architect session runs).
//
// Coverage (spec "node:test" clause): golden pass (report-only writes nothing), each failure
// class (bad shape, dup id, cycle/dangling dep, shell-string validate, traversal/absolute
// cwd, hash mismatch/absent script), advisory warnings do not fail, import refusal after
// task-start (revision unchanged), successful import round-trip readable by `legion state`.
// Plus a direct unit test of validatePlan()'s pure classification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlan } from '../../src/cli/plan.mjs';
import { seedTasks } from '../../src/kernel/state.mjs';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';

// HERMETIC GIT (T7b): the suite ran against the DEVELOPER's ~/.gitconfig and inherited GIT_*
// env, which is exactly why the `status.showUntrackedFiles=no` fail-open was invisible to it
// — a machine with that preference set would have gone GREEN here. This one mutation neuters
// global/system config and every inherited GIT_* variable and pins a deterministic identity;
// every child below spawns from `process.env` (directly or via `{...process.env, LEGION_HOME}`),
// so no other call site changes. A future test that builds an env object from scratch would
// silently opt out.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });


const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'legion.mjs');

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-plan-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) => sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

let n = 0;
/** Fresh sandbox: isolated LEGION_HOME + one-commit fixture repo, a registered project, a
 * started feature `f1` with a real worktree + dossier, and an initialized tasks.json. */
function scenario() {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fix-proj' }, null, 2) + '\n');
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  const env = { ...process.env, LEGION_HOME: home };
  let r = spawnSync(process.execPath, [BIN, 'project', 'init', '--root', repo], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [BIN, 'feature', 'start', 'f1', '--base', 'main'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const dossier = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'features', 'f1');
  const worktree = realpathSync(join(base, '.legion-worktrees', 'fix-proj', 'f1', 'checkout'));
  const s = { home, repo: realpathSync(repo), base, dossier, worktree, env };
  assert.equal(state(s, 'init').status, 0, 'state init');
  return s;
}

/** Run `legion state ...` from inside the feature worktree. */
const state = (s, ...args) =>
  spawnSync(process.execPath, [BIN, 'state', ...args], { cwd: s.worktree, encoding: 'utf8', env: s.env });
/** Run `legion plan check ...` from inside the feature worktree (resolves by git toplevel). */
const planCheck = (s, ...args) =>
  spawnSync(process.execPath, [BIN, 'plan', 'check', '--feature', 'f1', ...args], { cwd: s.worktree, encoding: 'utf8', env: s.env });
/** EARN a gate receipt for a row, the only way there is: a real `legion gate run` (T12 — there is
 * no `receipt-record` op). scenario() ran `project init`, which scaffolds `gates: {}`, so this is
 * a tier-0-only run: green, real, provenanced and deliberately weak. Like the retired op, it
 * checks no task STATUS, which is what the re-import guard cases below depend on. */
function gateOk(s, ...args) {
  const r = spawnSync(process.execPath, [BIN, 'gate', 'run', ...args, ...NOW],
    { cwd: s.worktree, encoding: 'utf8', env: s.env });
  assert.equal(r.status, 0, `legion gate run ${args.join(' ')}: ${r.stderr}`);
  return r;
}

const tasksJson = (s) => JSON.parse(readFileSync(join(s.dossier, 'tasks.json'), 'utf8'));
const writeCandidate = (s, plan) => writeFileSync(join(s.dossier, 'plan.tasks.json'), JSON.stringify(plan, null, 2) + '\n');
const writePlanMd = (s, body = '# the plan\n') => writeFileSync(join(s.dossier, 'plan.md'), body);

const task = (id, extra = {}) => ({ id, title: `do ${id}`, status: 'pending', attempt: 0, ...extra });
const milestone = (id, tasks) => ({ id, title: `milestone ${id}`, tasks });
const goodPlan = (tasks) => ({ milestones: [milestone('M1', tasks)] });

const NOW = ['--now', '2026-07-24T00:00:00.000Z'];

// --- 1. golden pass (report-only writes nothing) ------------------------------------------

test('golden pass: valid plan with structured + script validate → OK, report-only writes nothing', () => {
  const s = scenario();
  const scriptBody = '#!/bin/sh\nnpm test | tail -1\n';
  mkdirSync(join(s.dossier, 'checks'), { recursive: true });
  writeFileSync(join(s.dossier, 'checks', 'full.sh'), scriptBody);
  const plan = goodPlan([
    task('T1', { validate: { cwd: 'src', argv: ['npm', 'test'], timeoutMs: 60000 } }),
    task('T2', { depends_on: ['T1'] }),
    task('T3', { depends_on: ['T1', 'T2'], validate: { script: 'checks/full.sh', sha256: sha256(scriptBody) } }),
  ]);
  writeCandidate(s, plan);
  const r = planCheck(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plan check OK \(3 task\(s\)\)/);
  assert.deepEqual(tasksJson(s).tasks, [], 'report-only must not seed tasks.json');
});

// --- 2. bad shape -------------------------------------------------------------------------

test('bad shape: missing milestones / missing title / bad status / bad attempt each fail', () => {
  const s = scenario();

  writeCandidate(s, { tasks: [] });
  let r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /milestones must be a non-empty array/);

  writeCandidate(s, goodPlan([task('T1'), task('T2'), { id: 'T3', status: 'pending', attempt: 0 }]));
  r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /title must be a non-empty string/);

  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3', { status: 'started' })]));
  r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /status must be 'pending'/);

  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3', { attempt: 1 })]));
  r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /attempt must be 0/);
});

// --- 3. duplicate id ----------------------------------------------------------------------

test('duplicate task id across milestones → fail', () => {
  const s = scenario();
  writeCandidate(s, { milestones: [milestone('M1', [task('T1'), task('T2')]), milestone('M2', [task('T1')])] });
  const r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /duplicate task id 'T1'/);
});

// --- 4. cycle / dangling dep --------------------------------------------------------------

test('dependency cycle → fail', () => {
  const s = scenario();
  writeCandidate(s, goodPlan([task('T1', { depends_on: ['T2'] }), task('T2', { depends_on: ['T1'] }), task('T3')]));
  const r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cycle/);
});

test('self-loop cycle → fail', () => {
  const s = scenario();
  writeCandidate(s, goodPlan([task('T1', { depends_on: ['T1'] }), task('T2'), task('T3')]));
  const r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /cycle/);
});

test('dangling depends_on reference → fail', () => {
  const s = scenario();
  writeCandidate(s, goodPlan([task('T1'), task('T2', { depends_on: ['TX'] }), task('T3')]));
  const r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown task 'TX'/);
});

// --- 5. shell-string validate -------------------------------------------------------------

test('shell-string validate → fail (never a raw string)', () => {
  const s = scenario();
  writeCandidate(s, goodPlan([task('T1', { validate: 'npm test' }), task('T2'), task('T3')]));
  const r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /shell string|structured/);
});

// --- 6. traversal / absolute cwd ----------------------------------------------------------

test('traversal cwd and absolute cwd → fail', () => {
  const s = scenario();
  writeCandidate(s, goodPlan([task('T1', { validate: { cwd: '../etc', argv: ['ls'], timeoutMs: 1000 } }), task('T2'), task('T3')]));
  let r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /traversal|repo-relative/);

  writeCandidate(s, goodPlan([task('T1', { validate: { cwd: '/etc', argv: ['ls'], timeoutMs: 1000 } }), task('T2'), task('T3')]));
  r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /traversal|repo-relative/);
});

// --- 7. hash mismatch / script absent -----------------------------------------------------

test('script validate: sha256 mismatch and missing script both fail', () => {
  const s = scenario();
  const body = '#!/bin/sh\necho hi\n';
  mkdirSync(join(s.dossier, 'checks'), { recursive: true });
  writeFileSync(join(s.dossier, 'checks', 'c.sh'), body);
  // wrong sha
  writeCandidate(s, goodPlan([task('T1', { validate: { script: 'checks/c.sh', sha256: 'a'.repeat(64) } }), task('T2'), task('T3')]));
  let r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /sha256|hash/);
  // absent script (right sha shape, missing file)
  writeCandidate(s, goodPlan([task('T1', { validate: { script: 'checks/missing.sh', sha256: sha256(body) } }), task('T2'), task('T3')]));
  r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /exist/);
});

// --- 7b. null milestone → finding, not a crash (fail-closed shape) ------------------------

test('null milestone entry → nonzero findings, never a TypeError crash', () => {
  const s = scenario();
  writeCandidate(s, { milestones: [null] });
  const r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /milestone\[0\] must be an object/);
  assert.doesNotMatch(r.stderr, /TypeError/);
});

// --- 7c. directory / empty script path → finding, not an EISDIR crash ----------------------

test('script validate pointing at a directory (or empty string) → finding, not EISDIR', () => {
  const s = scenario();
  // script:'' joins to the dossier directory itself → readFileSync would throw EISDIR.
  writeCandidate(s, goodPlan([task('T1', { validate: { script: '', sha256: 'a'.repeat(64) } }), task('T2'), task('T3')]));
  let r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /regular file|exist/);
  assert.doesNotMatch(r.stderr, /EISDIR/);
  // an actual subdirectory of the dossier
  mkdirSync(join(s.dossier, 'checks'), { recursive: true });
  writeCandidate(s, goodPlan([task('T1', { validate: { script: 'checks', sha256: 'a'.repeat(64) } }), task('T2'), task('T3')]));
  r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /regular file|exist/);
  assert.doesNotMatch(r.stderr, /EISDIR/);
});

// --- 7d. un-whitelisted task fields (receipt) are stripped, never seeded -------------------

test('import strips model-supplied receipt/unknown fields — gate evidence cannot be pre-baked', () => {
  const s = scenario();
  writePlanMd(s);
  // A pre-baked receipt whose treeHash = the base tree would make task-done pass with no gate.
  const baseTree = sh(s.worktree, 'rev-parse', 'HEAD^{tree}');
  writeCandidate(s, goodPlan([
    task('T1', { receipt: { treeHash: baseTree, commit: 'x'.repeat(40), at: NOW[1] }, bogus: 1 }),
    task('T2'), task('T3'),
  ]));
  const r = planCheck(s, '--import', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  const seeded = tasksJson(s).tasks.find((x) => x.id === 'T1');
  assert.equal(seeded.receipt, undefined, 'receipt must never be seeded from the candidate');
  assert.equal(seeded.bogus, undefined, 'unknown fields must never be seeded from the candidate');
  // task-done must now refuse: task-start then task-done fails for lack of a real receipt.
  assert.equal(state(s, 'task-start', 'T1').status, 0);
  const done = state(s, 'task-done', 'T1');
  assert.equal(done.status, 1);
  assert.match(done.stderr, /no receipt/);
});

// --- 8. advisory warnings never fail ------------------------------------------------------

test('advisory warnings (task count outside 3-5, title > 72) → OK with warnings printed', () => {
  const s = scenario();
  const longTitle = 'x'.repeat(80);
  writeCandidate(s, goodPlan([task('T1', { title: longTitle }), task('T2')])); // 2 tasks (outside 3-5) + long title
  const r = planCheck(s);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /plan check OK/);
  assert.match(r.stdout, /2 task\(s\); 3-5/);
  assert.match(r.stdout, /> 72 recommended/);
});

// --- 9. re-import: content-only, never clobbering work in flight --------------------------
// An import REPLACES PLAN CONTENT and nothing else. The guard is not "any started/done task
// exists" — that blanket refusal made the pre-merge fixup path (append a task ⇒ re-import ⇒
// build ⇒ re-gate ⇒ re-approve) unreachable by construction, since by pre-merge every task is
// done. It refuses exactly what it says: removing or REWRITING work already in flight.

test('re-import REFUSES when a RECEIPTED task would be rewritten; tasks.json revision unchanged', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  assert.equal(state(s, 'task-start', 'T1').status, 0, 'task-start T1');
  gateOk(s, '--task', 'T1'); // a gate certified a tree for T1
  const revBefore = tasksJson(s).revision;
  writeCandidate(s, goodPlan([task('T1', { title: 'a different T1' }), task('T2'), task('T3')]));
  const r = planCheck(s, '--import', ...NOW);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /removed or rewritten/);
  assert.match(r.stderr, /T1/, 'the refusal must name the task it is protecting');
  assert.equal(tasksJson(s).revision, revBefore, 'refused import must not write tasks.json');
});

test('re-import REFUSES when a receipted task would be dropped from the plan', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  assert.equal(state(s, 'task-start', 'T3').status, 0, 'task-start T3');
  gateOk(s, '--task', 'T3'); // receipt for T3
  writeCandidate(s, goodPlan([task('T1'), task('T2')])); // T3 gone
  const r = planCheck(s, '--import', ...NOW);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /T3/);
});

// The guard protects RECORDED EVIDENCE, not intent. The build loop marks a task `started`
// before dispatching its builder and there is no un-start op, so protecting `started` alone
// would make a failed task's plan text permanently unrewritable — walling off the loop's own
// documented bounce-up (a thin or wrong task goes back to the architect and re-import).
test('re-import REWRITES a started task that never earned a receipt, and RESETS it', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  assert.equal(state(s, 'task-start', 'T2').status, 0, 'the builder was dispatched and its review failed');
  assert.equal(state(s, 'task-answer', 'T2', '--question', 'q?', '--answer', 'a.', ...NOW).status, 0);

  writeCandidate(s, goodPlan([task('T1'), task('T2', { title: 'T2, rewritten by the architect' }), task('T3')]));
  const r = planCheck(s, '--import', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /T2/, 'the reset must be reported, never silent');
  assert.match(r.stdout, /recorded answers were cleared/);

  const t2 = tasksJson(s).tasks.find((x) => x.id === 'T2');
  assert.equal(t2.title, 'T2, rewritten by the architect');
  assert.equal(t2.status, 'pending', 'a rewritten task starts over');
  assert.equal(t2.answers, undefined, 'answers described the OLD text — carrying them is the hazard task-answer refuses on a done task');
  // And the task is startable again, so the bounce-up actually completes.
  assert.equal(state(s, 'task-start', 'T2').status, 0);
});

// The CLI whitelist (tested above) is the reachable path, but seedTasks is EXPORTED and its own
// docblock asserts that no caller-supplied kernel field ever enters tasks[]. An invariant the
// kernel claims has to be held by the kernel: a forged `receipt.treeHash` = the current tree
// makes BOTH `gate verify-receipt` and `task-done` pass with no gate ever run.
test('seedTasks itself strips caller-supplied kernel fields — not only the CLI whitelist does', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  const tree = sh(s.worktree, 'rev-parse', 'HEAD^{tree}');
  const head = sh(s.worktree, 'rev-parse', 'HEAD');

  // Bypass plan.mjs entirely: call the exported kernel function with pre-baked gate evidence.
  seedTasks(s.dossier, [
    {
      id: 'T1', title: 'do T1', status: 'done', attempt: 9, depends_on: [], milestone: 'M1',
      receipt: { treeHash: tree, commit: head, at: 'forged' },
      answers: [{ question: 'forged', answer: 'forged', at: 'forged' }],
      doneAt: 'forged',
    },
    { id: 'T2', title: 'do T2', status: 'pending', attempt: 0, depends_on: [], milestone: 'M1' },
    { id: 'T3', title: 'do T3', status: 'pending', attempt: 0, depends_on: [], milestone: 'M1' },
  ], '2026-07-24T00:00:00.000Z');

  const t1 = tasksJson(s).tasks.find((x) => x.id === 'T1');
  assert.equal(t1.receipt, undefined, 'a supplied receipt must never enter tasks.json');
  assert.equal(t1.status, 'pending', 'the kernel owns status');
  assert.equal(t1.attempt, 0, 'the kernel owns attempt');
  assert.equal(t1.answers, undefined, 'the kernel owns answers');
  assert.equal(t1.doneAt, undefined);
  // The consequence that matters: no gate ran, so the task cannot be completed.
  assert.equal(state(s, 'task-start', 'T1').status, 0);
  const done = state(s, 'task-done', 'T1');
  assert.equal(done.status, 1);
  assert.match(done.stderr, /no receipt/);
});

test('a re-import that DROPS an in-flight task names it — recorded answers never vanish quietly', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  assert.equal(state(s, 'task-start', 'T2').status, 0);
  assert.equal(state(s, 'task-answer', 'T2', '--question', 'q?', '--answer', 'a.', ...NOW).status, 0);

  writeCandidate(s, goodPlan([task('T1'), task('T3')])); // T2 dropped; no receipt, so allowed
  const r = planCheck(s, '--import', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gone from the plan \(T2\)/, 'the dropped task must be named');
  assert.match(r.stdout, /recorded answers went with them/);
  assert.deepEqual(tasksJson(s).tasks.map((x) => x.id), ['T1', 'T3']);
});

test('a rewritten pending task never inherits a receipt — gate evidence cannot survive new text', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  // A receipt can be earned against a PENDING task (`legion gate run` checks no status, exactly as
  // the retired receipt-record op did not), so the merge must not carry it across a rewrite:
  // HEAD's tree would still match, and task-done would pass having never gated the new content.
  gateOk(s, '--task', 'T2'); // receipt on a pending task
  writeCandidate(s, goodPlan([task('T1'), task('T2', { title: 'rewritten' }), task('T3')]));
  const r = planCheck(s, '--import', ...NOW);
  // T2 now HAS evidence, so the rewrite is refused outright — the stronger of the two answers.
  assert.equal(r.status, 1, 'a receipted task is protected whatever its status');
  assert.match(r.stderr, /T2/);
});

test('re-import APPENDS beside work in flight, carrying status/receipt/answers through', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  assert.equal(state(s, 'task-start', 'T1').status, 0, 'task-start T1');
  gateOk(s, '--task', 'T1'); // receipt for T1
  assert.equal(state(s, 'task-answer', 'T2', '--question', 'q?', '--answer', 'a.', ...NOW).status, 0, 'answer on pending T2');

  // The pre-merge fixup shape: the same tasks, plus an appended one.
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3'), task('T4', { depends_on: ['T1'] })]));
  const r = planCheck(s, '--import', ...NOW);
  assert.equal(r.status, 0, r.stderr);

  const t = tasksJson(s);
  assert.deepEqual(t.tasks.map((x) => x.id), ['T1', 'T2', 'T3', 'T4']);
  assert.equal(t.tasks[0].status, 'started', 'in-flight status survives a re-import');
  assert.ok(t.tasks[0].receipt?.treeHash, 'the gate receipt survives a re-import');
  assert.deepEqual(t.tasks[1].answers.map((a) => a.answer), ['a.'], 'recorded human answers are never dropped');
  assert.equal(t.tasks[3].status, 'pending', 'the appended task arrives pending');
});

test('a re-import that CHANGES tasks[] invalidates the plan approval — tasks[] is half the subject', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  assert.equal(state(s, 'decision-record', 'plan', ...NOW).status, 0, 'plan approved');
  assert.ok(tasksJson(s).approvals.plan, 'approval recorded');

  // plan.md is untouched, so artifact-record's cascade is a no-op — only seedTasks can catch
  // this. Without it the approval would survive while its subject silently drifted.
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3'), task('T4')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'append imports cleanly');
  assert.equal(tasksJson(s).approvals.plan, undefined, 'a changed task list drops the plan approval');
});

test('an IDENTICAL re-import keeps a valid plan approval — it must not force the workflow back', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  assert.equal(state(s, 'decision-record', 'plan', ...NOW).status, 0, 'plan approved');
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 're-import of identical bytes');
  assert.ok(tasksJson(s).approvals.plan, 'identical re-record must not invalidate');
});

// THE CASE THE TEST ABOVE CANNOT SEE, and the one that actually broke. Once ops have appended
// kernel fields, a stored row's KEY ORDER is the order those ops ran; a row rebuilt by the
// merge gets the merge's order. Comparing serializations then reports CHANGED for a re-import
// of literally identical bytes — cascading a valid approval away — and writes the reordered
// row, which moves the tasks[] half of the plan subject for free. "Changed" is a value
// question, never a byte question.
test('an identical re-import AFTER task-start + a gate receipt still keeps the approval', () => {
  const s = scenario();
  writePlanMd(s);
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 'first import');
  assert.equal(state(s, 'task-start', 'T1').status, 0, 'appends startedAt');
  gateOk(s, '--task', 'T1'); // appends receipt AFTER startedAt
  assert.equal(state(s, 'decision-record', 'plan', ...NOW).status, 0, 'plan approved over the live task list');
  const before = tasksJson(s);

  assert.equal(planCheck(s, '--import', ...NOW).status, 0, 're-import, not one byte of the plan edited');
  const after = tasksJson(s);
  assert.ok(after.approvals.plan, 'a no-op import must not drop the approval and demand re-approval');
  assert.equal(after.approvals.plan.subjectHash, before.approvals.plan.subjectHash, 'nor move the subject');
  assert.deepEqual(after.tasks, before.tasks, 'the rows round-trip unchanged');
  assert.equal(JSON.stringify(after.tasks), JSON.stringify(before.tasks),
    'BYTE-identical: seedTasks decides "changed" (and therefore the cascade) by comparing stored ' +
    'bytes, so a silent key reorder would cascade a valid approval away on a no-op import ' +
    '(the plan SUBJECT itself hashes the planContent projection since T13 and would not move)');
});

// --- 10. successful import round-trip readable by state -----------------------------------

test('import seeds tasks + records plan.md, and the seed is a valid state input', () => {
  const s = scenario();
  const planBody = '# the real plan\n';
  writePlanMd(s, planBody);
  writeCandidate(s, goodPlan([task('T1'), task('T2', { depends_on: ['T1'] }), task('T3')]));
  const r = planCheck(s, '--import', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  const t = tasksJson(s);
  assert.equal(t.tasks.length, 3);
  for (const x of t.tasks) {
    assert.equal(x.status, 'pending');
    assert.equal(x.attempt, 0);
    assert.equal(x.milestone, 'M1');
  }
  assert.deepEqual(t.tasks[1].depends_on, ['T1']);
  assert.equal(t.artifacts.plan.hash, sha256(planBody), 'plan.md recorded with a matching sha256');
  // the seed is a valid state input: task-start succeeds on a seeded task
  assert.equal(state(s, 'task-start', 'T1').status, 0, 'seeded task is startable');
  assert.equal(tasksJson(s).tasks[0].status, 'started');
});

test('import without plan.md surfaces a clean finding (not a raw artifact-record throw)', () => {
  const s = scenario();
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  const r = planCheck(s, '--import', ...NOW);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no plan\.md/);
  assert.deepEqual(tasksJson(s).tasks, [], 'no seed when plan.md missing');
});

test('missing candidate plan.tasks.json → clean finding', () => {
  const s = scenario();
  const r = planCheck(s);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no candidate plan/);
});

// --- resolution + usage refusals ----------------------------------------------------------

test('plan check refuses outside a feature worktree and requires --feature', () => {
  const s = scenario();
  writeCandidate(s, goodPlan([task('T1'), task('T2'), task('T3')]));
  const rOut = spawnSync(process.execPath, [BIN, 'plan', 'check', '--feature', 'f1'], { cwd: s.repo, encoding: 'utf8', env: s.env });
  assert.equal(rOut.status, 1);
  assert.match(rOut.stderr, /not a registered legion feature worktree/);
  const rNoFeat = spawnSync(process.execPath, [BIN, 'plan', 'check'], { cwd: s.worktree, encoding: 'utf8', env: s.env });
  assert.equal(rNoFeat.status, 1);
  assert.match(rNoFeat.stderr, /missing --feature/);
});

// --- direct unit test of the pure validator -----------------------------------------------

test('validatePlan() classifies errors vs warnings without touching disk', () => {
  const dossier = '/nonexistent';
  const ok = validatePlan(goodPlan([task('T1'), task('T2'), task('T3')]), dossier);
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.warnings, []);
  assert.equal(ok.tasks.length, 3);
  assert.equal(ok.tasks[0].milestone, 'M1');

  const warn = validatePlan(goodPlan([task('T1'), task('T2')]), dossier); // 2 tasks
  assert.deepEqual(warn.errors, []);
  assert.equal(warn.warnings.length, 1);

  const bad = validatePlan(goodPlan([task('T1', { validate: 'sh -c x' }), task('T2'), task('T3')]), dossier);
  assert.ok(bad.errors.some((e) => /shell string/.test(e)));
});
