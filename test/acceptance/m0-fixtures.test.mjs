// m0-fixtures.test.mjs — the M0 fixture cases that test/acceptance/enforcement.test.mjs did NOT
// already cover (T21). The full case-by-case accounting — what is covered where, what is added
// here, and the one case that cannot be proved on this machine at all — is
// test/acceptance/M0-FIXTURE-LEDGER.md. Read it first; this file is only the missing half.
//
// WHY A SECOND FILE RATHER THAN MORE CASES IN enforcement.test.mjs: that file has a standing
// contract in its own header — it is the chunk-5 acceptance criteria, written before the fixer,
// and its exit condition is "zero remaining todos in THIS file". Appending T21's cases to it would
// dilute a claim other people read. The harness, the walk and the isolation rules are shared
// (test/helpers/fixture.mjs, test/helpers/lifecycle.mjs); only the criteria are separate.
//
// EVERY CASE HERE IS ADVERSARIAL IN THE SAME SENSE THE M0 REPORT USES: it drives the REAL
// bin/legion.mjs to a state where a refusal is the correct answer, asserts the refusal, asserts
// WHY the refusal names, and asserts THAT NO STATE MOVED (h.assertUnmoved compares manifest bytes).
// Delete the guard under test and the case fails — that is the bar the ledger claims for each row,
// and the reason a happy-path assertion is never accepted as coverage of a refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOW, fixture, planTask } from '../helpers/fixture.mjs';
import { advanceTo, ok, taskRow } from '../helpers/lifecycle.mjs';

const THREE = [planTask('T1'), planTask('T2'), planTask('T3')];

/** One task's row as bytes. "T1 is still done" is a claim about the WHOLE row — status, receipt,
 * timestamps — not about its status field, so it is asserted as a string comparison. */
const rowBytes = (h, id) => JSON.stringify(taskRow(h, id));

/** Build task `id` the way the loop does: start, commit, gate, done. */
function buildTask(h, label, id) {
  ok(h, label, 'state', 'task-start', id);
  h.commit(`${id}: work`);
  ok(h, label, 'gate', 'run', '--task', id);
  ok(h, label, 'state', 'task-done', id);
}

// --- F3c. a CYCLIC plan is bounced by `plan check`, and imports nothing ------------------------
// The other three malformed-plan shapes are already covered adversarially with the nothing-imported
// half attached (enforcement case 9 for ids, C1 for the dangling dep and the raw-string validate).
// The CYCLE was covered only by test/cli/plan.test.mjs, which asserts the `plan check` exit code
// and never runs `--import` — so nothing anywhere asserted that a cyclic plan reaches canonical
// tasks.json empty-handed. That gap matters more than it looks: acyclicity is validated ONLY at
// import (src/cli/plan.mjs), and workflows/build-loop.js states in its own header that a cycle
// hand-edited past that point appends its members in file order and relies on `task-start` to
// refuse each. Import is the only place the graph is ever checked, so "import refuses" is the
// whole guarantee.
test('F3c a cyclic plan is bounced by `plan check --import` and NOTHING reaches canonical tasks.json', () => {
  const h = fixture();
  h.writeArtifact('plan.md', '# plan\n'); // present, so --import fails on the CYCLE, not on plan.md

  for (const [label, tasks] of [
    ['a two-node cycle', [planTask('T1', { depends_on: ['T2'] }), planTask('T2', { depends_on: ['T1'] }), planTask('T3')]],
    ['a self-loop', [planTask('T1', { depends_on: ['T1'] }), planTask('T2'), planTask('T3')]],
    // Three nodes, and T1 is reachable from nothing: a visited-only scan reports T1 clean and
    // never revisits T2/T3, so this is the shape that separates a colour walk from a cheap one.
    ['a three-node cycle behind an entry point', [
      planTask('T1', { depends_on: ['T2'] }), planTask('T2', { depends_on: ['T3'] }), planTask('T3', { depends_on: ['T2'] }),
    ]],
  ]) {
    const snap = h.snapshot();
    h.writePlanTasks(tasks);

    const check = h.legion('plan', 'check', '--feature', h.feature);
    assert.equal(check.code, 1, `plan check must reject ${label}`);
    assert.match(check.stderr, /cycle/, `the finding must name the cycle for ${label}: ${check.stderr}`);

    const imported = h.legion('plan', 'check', '--feature', h.feature, '--import');
    assert.equal(imported.code, 1, `--import must refuse ${label} too`);
    assert.deepEqual(h.readTasks().tasks, [], `NOTHING may be imported for ${label}`);
    h.assertUnmoved(snap, `a refused plan check --import for ${label}`);
  }
});

// --- F4. a stale approval is CONSUMED, not merely dropped -------------------------------------
// M0 proved the CASCADE live four times over: editing spec.md dropped the spec and plan approvals.
// What the smoke never proved is the other half — that a consumer then REFUSES on the re-derived
// hash. The two are independent: a kernel that dropped the approval and a `stage-complete` that
// consulted `completedStages` instead of re-deriving would look identical in the manifests and pass
// the feature through anyway. So both consumers are driven here, and the artifact is changed
// THROUGH `artifact-record` (the operator's own path), never by a hand-edited manifest.
//
// Coverage note, because the neighbouring cases look like this one and are not: enforcement 6b(b)
// consumes a stale INTAKE approval, but it changes intent.md on disk WITHOUT re-recording it, so it
// proves the hash is re-derived at consumption from the file — a different claim. enforcement 5d
// re-records spec.md and then drives ONE consumer, `stage-enter review`. Neither drives
// `stage-complete` on the stale stage itself.

test('F4a a re-recorded spec artifact makes `stage-complete spec` refuse on the re-derived hash', () => {
  const h = fixture();
  advanceTo(h, 'spec');

  // The approval, earned honestly over v1 of the artifact.
  h.writeArtifact('spec.md', '# spec\nv1 — what we agreed to build\n');
  ok(h, 'F4a', 'state', 'artifact-record', 'spec', 'spec.md');
  ok(h, 'F4a', 'state', 'decision-record', 'spec');
  assert.ok(h.readTasks().approvals.spec, 'the case needs a genuinely recorded spec approval');

  // The amendment, through the SAME op an operator uses. The cascade half: the approval falls.
  h.writeArtifact('spec.md', '# spec\nv2 — the scope moved materially\n');
  ok(h, 'F4a', 'state', 'artifact-record', 'spec', 'spec.md');
  assert.ok(!h.readTasks().approvals.spec,
    'the cascade half: an artifact whose bytes moved takes its approval with it');

  // The CONSUMPTION half, which is what was never proved live.
  const snap = h.snapshot();
  const r = h.legion('state', 'stage-complete', 'spec');
  assert.equal(r.code, 1, 'a stage whose own approval no longer re-derives must not complete');
  assert.match(r.stderr, /spec/, 'the refusal must name the stage');
  assert.match(r.stderr, /approval|decision/i, 'and what is missing');
  assert.deepEqual(h.readFeature().completedStages?.filter((c) => c.stage === 'spec') ?? [], [],
    'a refused stage-complete must not append to the audit trail either');
  h.assertUnmoved(snap, 'a refused stage-complete over a consumed stale approval');

  // And re-approving v2 — assent to what is actually there — releases it. Without this the case
  // would pass just as well against a kernel that had wedged the stage shut permanently.
  ok(h, 'F4a', 'state', 'decision-record', 'spec');
  ok(h, 'F4a', 'state', 'stage-complete', 'spec');
});

test('F4b a stale spec approval refuses a LATER prefix-dependent op — `stage-complete build`', () => {
  const h = fixture();
  advanceTo(h, 'build', { tasks: THREE });
  for (const t of THREE) buildTask(h, 'F4b', t.id);
  // Standing in build with every task genuinely done: `stage-complete build` is earned RIGHT NOW,
  // and the only thing that changes below is two stages back.
  const t1 = rowBytes(h, 'T1');

  h.writeArtifact('spec.md', '# spec\nthe scope moved after the build finished\n');
  ok(h, 'F4b', 'state', 'artifact-record', 'spec', 'spec.md');
  assert.ok(!h.readTasks().approvals.spec, 'the spec approval must have fallen with its subject');
  assert.ok(!h.readTasks().approvals.plan, 'and the plan approval with it — invalidation cascades forward');

  const snap = h.snapshot();
  const r = h.legion('state', 'stage-complete', 'build');
  assert.equal(r.code, 1, 'stage-complete re-derives the WHOLE prefix, not only its own stage');
  assert.match(r.stderr, /spec/, 'the refusal must name the stale EARLIER stage');
  assert.match(r.stderr, /earlier stage/i, 'and say that it is earlier, so the operator knows where to look');
  h.assertUnmoved(snap, 'a refused stage-complete build over a stale spec approval');

  // The build itself is untouched: invalidation is about assent, never about work. A kernel that
  // "cleaned up" by reopening tasks would destroy earned receipts to enforce a stage rule.
  assert.equal(rowBytes(h, 'T1'), t1, 'a stale approval two stages back must not disturb a done task');
});

// --- F5. kill + resume ------------------------------------------------------------------------
// HOW THIS CASE IS HONEST ABOUT WHAT IT PROVES. `legion` holds NO in-process state: every call in
// this suite is already a separate `spawnSync` of bin/legion.mjs, so "run the second half in a
// fresh process" is not a manipulation this file can perform — it is the ambient condition of every
// other test here. Writing a case that spawns a second process and calls that the proof would be
// asserting the harness, not the kernel.
//
// What a session restart actually IS to the kernel is three things, and those are what is asserted:
//   (a) the durable manifests are the whole of the state — the resume path a real session takes
//       (the SessionStart hook, then `feature status`) reports the exact mid-build position with
//       nothing carried over from the killed session;
//   (b) the RE-INIT GUARDS hold — a resumed session that helpfully re-runs `state init` or
//       `feature start` is refused and destroys nothing. This is the failure mode a kill actually
//       produces in the field, and it is the adversarial half of the case;
//   (c) the lifecycle continues EXACTLY: the task that was mid-flight when the kill landed closes
//       on the receipt it earns after it, done tasks stay done byte for byte, and `stage-complete
//       build` accepts — no stage is re-walked, no task is re-run.
test('F5 a session restart continues the lifecycle exactly: no re-init, done tasks stay done', () => {
  const h = fixture();
  advanceTo(h, 'build', { tasks: THREE });

  // --- before the kill: T1 done, T2 started, T3 never reached ---
  buildTask(h, 'F5', 'T1');
  ok(h, 'F5', 'state', 'task-start', 'T2');
  const t1Before = rowBytes(h, 'T1');
  assert.equal(taskRow(h, 'T2').status, 'started', 'the case needs a task genuinely mid-flight');
  assert.equal(taskRow(h, 'T3').status, 'pending');

  // --- the kill: nothing to simulate. The next paragraph is a new session over the same dossier ---

  // (a) the resume path reads the durable state back. SessionStart is what Claude Code fires on a
  // resume; it records the session and injects the stage as additionalContext.
  const sessionsBefore = (h.readFeature().sessionHistory ?? []).length;
  const hook = h.fireHook('session-start', {
    hook_event_name: 'SessionStart', session_id: 'sess-after-kill', cwd: h.worktree, source: 'resume',
  });
  assert.equal(hook.code, 0, `SessionStart must succeed on resume: ${hook.stderr}`);
  // The exact rendered line, not a bare /build/: the word appears in half a dozen places in that
  // context block (task titles, the resume instruction), so a loose match passes against a hook
  // that lost the stage entirely.
  assert.match(hook.stdout, /- stage:\s+build\s+\(status active/,
    'the injected context must carry the stage the kill left behind, and that the feature is live');
  assert.equal((h.readFeature().sessionHistory ?? []).length, sessionsBefore + 1,
    'the resumed session must be on the record');

  // RUN FROM THE WORKTREE — the cwd a resumed session actually stands in (PLAN-V3 §Startup step 5),
  // which is the whole point of asking here. T21 had to run this from the main repo root and
  // reported why as finding 1 (M0-FIXTURE-LEDGER.md row 5): `feature status` is read-only but
  // resolved by CHECKOUT, so from the worktree it answered "is not a registered project". T22 gave
  // it resolveProject's {fromAnyWorktree:true} mode — the mode `legion doctor` already took for
  // exactly this reason — so the continuity claim is now proved from the cwd it is made about.
  const status = h.legion('feature', 'status', h.feature);
  assert.equal(status.code, 0, `feature status must succeed from inside the worktree: ${status.stderr}`);
  assert.match(status.stdout, /stage:\s+build/, '`feature status` must report the stage the kill left behind');
  assert.match(status.stdout, /status:\s+active/, 'and that the feature is still active, not restarted');

  // (b) the re-init guards. A resumed session that re-bootstraps is the real hazard: `state init`
  // would blank tasks.json (every receipt, approval and review with it) and `feature start` would
  // re-pin the gate policy. Both must refuse, and neither may move a byte.
  const snap = h.snapshot();
  const reinit = h.legion('state', 'init');
  assert.equal(reinit.code, 1, '`state init` on a live feature must refuse — it would blank tasks.json');
  assert.match(reinit.stderr, /tasks\.json already exists[\s\S]*refusing to re-initialize/,
    'and name tasks.json — the file that would have been blanked');
  h.assertUnmoved(snap, 'a refused `state init` on resume');

  const restart = h.legionIn(h.repoRoot, 'feature', 'start', h.feature, '--base', 'main');
  assert.equal(restart.code, 1, '`feature start` on a live feature must refuse — it would re-pin the gate policy');
  // NAMING THE FEATURE IS THE POINT. `/already exists/` alone is satisfied by the NEXT guard down
  // (`worktree path ... already exists`), which fires for an unrelated reason and would let a
  // deleted feature-level guard pass this case — a surviving mutant, proven by sweep, not assumed.
  assert.match(restart.stderr, new RegExp(`feature '${h.feature}' already exists \\(status: active\\)`),
    'the refusal must be the FEATURE-level guard, not the worktree-path one behind it');
  h.assertUnmoved(snap, 'a refused `feature start` on resume');

  // (c) the lifecycle continues from exactly where it stopped. T2 was already started before the
  // kill, so it is NOT re-started here — it closes on the receipt it earns now.
  h.commit('T2: work');
  ok(h, 'F5', 'gate', 'run', '--task', 'T2');
  ok(h, 'F5', 'state', 'task-done', 'T2');
  buildTask(h, 'F5', 'T3');
  assert.equal(rowBytes(h, 'T1'), t1Before, 'a done task must survive the restart byte for byte');
  ok(h, 'F5', 'state', 'stage-complete', 'build');
  assert.equal(h.readFeature().stage, 'build', 'and no stage was re-walked to get there');
});

// --- F6. blocked -> task-answer -> re-run, the kernel half ------------------------------------
// The workflow half (the selector re-selecting ONLY the blocked task) is in
// test/workflows/build-loop-order.test.mjs — the selection lives inside a sandboxed script with no
// kernel, no git and no module surface, so it cannot be driven through this harness at all. Ledger
// row 6 names both halves.
//
// NO TYPED OP WRITES `blocked`. The build workflow reports it as DATA (PLAN-V3 decision 11) and the
// session acts on it, so the row is hand-written here exactly as enforcement case 6 does.
test('F6 `task-answer` records {question, answer, at} verbatim on a blocked task, and refuses a done one', () => {
  const h = fixture();
  advanceTo(h, 'build', { tasks: THREE });
  buildTask(h, 'F6', 'T1');
  ok(h, 'F6', 'state', 'task-start', 'T2');
  h.writeTasks((doc) => ({
    ...doc,
    tasks: doc.tasks.map((t) => (t.id === 'T2' ? { ...t, status: 'blocked' } : t)),
  }));
  const t1Before = rowBytes(h, 'T1');
  const revBefore = h.readTasks().revision;

  const Q = "which widget? the 'legacy' one or the new one";
  const A = 'the existing one — do not add a second';
  ok(h, 'F6', 'state', 'task-answer', 'T2', '--question', Q, '--answer', A);

  // VERBATIM, and exactly three keys: the workflow folds this straight into the next brief, so a
  // kernel that normalised the text or added fields would put words in the human's mouth.
  assert.deepEqual(taskRow(h, 'T2').answers, [{ question: Q, answer: A, at: NOW }]);
  assert.deepEqual(Object.keys(taskRow(h, 'T2').answers[0]), ['question', 'answer', 'at']);
  assert.equal(taskRow(h, 'T2').status, 'blocked', 'recording an answer does not itself unblock the task');
  assert.equal(h.readTasks().revision, revBefore + 1, 'exactly one revision bump');
  assert.equal(rowBytes(h, 'T1'), t1Before, 'and no other row moved');

  // ADVERSARIAL: the same answer against the DONE task. A stale answer riding into a re-brief is
  // the hazard, and it is reachable by a one-character typo in the task id.
  const snap = h.snapshot();
  const late = h.legion('state', 'task-answer', 'T1', '--question', Q, '--answer', A);
  assert.equal(late.code, 1, 'task-answer must refuse a done task');
  assert.match(late.stderr, /done/, 'and name why');
  h.assertUnmoved(snap, 'a refused task-answer on a done task');

  // THE RE-RUN, kernel-side: the blocked task is restartable (only `done` bars a re-start), it
  // closes on a real receipt, and the recorded answer survives the close — the workflow reads
  // `answers` back on every future re-brief, so losing it here would lose the decision.
  h.commit('T2: answered work');
  ok(h, 'F6', 'gate', 'run', '--task', 'T2');
  ok(h, 'F6', 'state', 'task-start', 'T2');
  ok(h, 'F6', 'gate', 'run', '--task', 'T2');
  ok(h, 'F6', 'state', 'task-done', 'T2');
  assert.equal(taskRow(h, 'T2').status, 'done');
  assert.deepEqual(taskRow(h, 'T2').answers, [{ question: Q, answer: A, at: NOW }],
    'the recorded decision must survive the task closing');
  assert.equal(rowBytes(h, 'T1'), t1Before, 'and T1 is still done, untouched by any of it');
});
