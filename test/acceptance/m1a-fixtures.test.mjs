// m1a-fixtures.test.mjs — the KERNEL halves of PLAN-V3 §Milestones M1a's fixture track (T31):
// "plan rejection → revision → re-review; gate-failure → in-loop recovery; approval invalidation
// cascade on spec edit". The case-by-case accounting — what was already covered and cited, what is
// added here, which half of each case is prose-borne rather than kernel-hermetic, and the mutation
// record for every added row — is test/acceptance/M1A-FIXTURE-LEDGER.md. Read it first; this file
// is only the missing half.
//
// WHY A THIRD ACCEPTANCE FILE AND NOT MORE CASES IN m0-fixtures.test.mjs: that file's header states
// its own contract — it is the M0 fixture track, accounted for by M0-FIXTURE-LEDGER.md, and that
// ledger is frozen. Appending M1a cases to it would make an M0 claim other people read cover work
// M0 never scoped. The harness, the walk and the isolation rules are shared verbatim
// (test/helpers/fixture.mjs, test/helpers/lifecycle.mjs); only the criteria are separate.
//
// THE BAR, IDENTICAL TO M0's, AND EVERY CASE HERE MEETS IT: drive the REAL bin/legion.mjs into a
// state where a refusal is the correct answer, assert the refusal, assert WHAT the refusal names,
// and assert THAT NO STATE MOVED (h.assertUnmoved compares manifest bytes). Every case also ends
// on a POSITIVE CONTROL — the same op accepted once the evidence is genuinely repaired — because a
// refusal test that never proves the door opens again passes just as well against a kernel that
// wedged the stage shut, which is a different (and equally broken) product.
//
// AUDIT-FIRST, so nothing here is a second copy of an existing claim. What is deliberately NOT
// re-tested, with the citation that covers it:
//   - a red gate mints no receipt and `task-done` refuses — M0 ledger row 2
//     (enforcement.test.mjs C2 + case 1). Case 2 below starts where that ends: the RECOVERY.
//   - a stale SPEC approval consumed by `stage-complete spec` / `stage-complete build` — M0 ledger
//     row 4 (m0-fixtures.test.mjs F4a/F4b). Case 3 below proves the OTHER end of the cascade.
//   - a plan.md edit killing the plan-critic pass — enforcement.test.mjs 10b. Case 1 below moves
//     the TASK ROWS with plan.md byte-identical, which 10b never does.
//   - the whole invalidation cascade as a manifest fact (spec edit drops approvals.plan) —
//     test/cli/state.test.mjs `cascade: re-recording the spec artifact kills …`. Case 3 proves the
//     CONSUMPTION of that drop, isolated from the spec's own staleness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture, planTask } from '../helpers/fixture.mjs';
import { advanceTo, ok, recordPlanCritic, taskRow } from '../helpers/lifecycle.mjs';

/** One task's row as bytes — "T1 did not move" is a claim about the WHOLE row (status, receipt,
 * timestamps), not about one field. Same helper, same reasoning, as m0-fixtures.test.mjs. */
const rowBytes = (h, id) => JSON.stringify(taskRow(h, id));

/** Stand in `plan` with a real imported plan, a passing critic and a hash-valid approval — the
 * state an architect reaches the moment the plan is first accepted. `stage-complete plan` is the
 * probe throughout case 1: the only honest way to ask "is this plan stage still satisfied" is to
 * ask something that GATES on it (enforcement.test.mjs 10c makes the same argument). */
function approvedPlan(h, tasks) {
  advanceTo(h, 'plan');
  h.seedPlan(tasks);
  recordPlanCritic(h, 'pass');
  ok(h, 'approvedPlan', 'state', 'decision-record', 'plan');
  ok(h, 'approvedPlan', 'state', 'stage-complete', 'plan'); // the plan the critic read IS accepted
}

// =================================================================================================
// CASE 1 — plan rejection → revision → re-review
// =================================================================================================
// The loop PLAN-V3 decision 4 names: "plan rejection → change request → revision → critic
// re-review". Its kernel-enforceable content is two refusals and one accept, and only the kernel
// half is testable here — the WARM half (the same critic instance continuing with its own findings
// as the checklist) is session/loop PROSE, and the ledger records it as skill-borne rather than
// inventing a test for it.

test('M1a-1a a recorded plan-critic FAIL blocks `stage-complete plan` while the plan approval is still hash-valid', () => {
  // THE REJECTION ITSELF. The adversarial shape is not "a fail blocks" — it is that the fail blocks
  // WHILE EVERY OTHER PIECE OF EVIDENCE IS GOOD. Round one completed the stage; nothing about the
  // plan has moved since, so `approvals.plan` re-derives valid and `reviewBindingHolds` holds for
  // the new verdict too. The ONLY defect is the verdict, which is exactly the state a rejection
  // leaves behind — and a kernel reading `reviews.some(pass)` would sail straight through it on the
  // round-one pass that is still sitting in the array.
  const h = fixture();
  approvedPlan(h, [planTask('T1'), planTask('T2', { depends_on: ['T1'] })]);

  // The critic rejects the plan on a second read. Same plan, second round.
  recordPlanCritic(h, 'fail');
  assert.ok(h.readTasks().approvals.plan,
    'control: the plan APPROVAL must still be recorded — the rejection is the only thing that changed');
  assert.equal(h.legion('state', 'decision-record', 'plan').code, 0,
    'control: and it must still be re-recordable, i.e. the plan subject itself is intact');

  const snap = h.snapshot();
  const r = h.legion('state', 'stage-complete', 'plan');
  assert.equal(r.code, 1, 'a rejected plan must not complete its stage, whatever else is valid');
  assert.match(r.stderr, /LATEST plan-critic/,
    "the refusal must name the LATEST verdict — a message about a missing review would be a lie, the review is right there");
  assert.match(r.stderr, /an older pass does not carry forward/,
    'and say why the round-one pass does not count, which is the whole content of this guard');
  assert.deepEqual(
    (h.readFeature().completedStages ?? []).filter((c) => c.stage === 'plan').length, 1,
    'the round-one completion is history and stays; the refused one must not append a second entry',
  );
  h.assertUnmoved(snap, 'a refused stage-complete plan over a critic REJECTION');

  // THE POSITIVE CONTROL — the loop closes. The architect revises nothing (the critic's finding was
  // about something it then accepted); the re-review is the only new fact and it releases the stage.
  recordPlanCritic(h, 'pass');
  ok(h, 'M1a-1a', 'state', 'stage-complete', 'plan');
});

test('M1a-1b a critic pass recorded BEFORE a re-imported revision dies with the plan it read — plan.md byte-identical', () => {
  // THE ADVERSARIAL CENTRE OF CASE 1. The revision arrives the way an architect actually produces
  // one: a rewritten plan.tasks.json re-imported through `legion plan check --feature <n> --import`.
  //
  // WHAT MAKES IT ADVERSARIAL RATHER THAN A RESTATEMENT OF enforcement.test.mjs 10b: plan.md is
  // NEVER TOUCHED — asserted below, byte for byte. 10b proves a plan.md edit kills the critic pass;
  // if the review subject hashed plan.md alone that test would still be green while a whole
  // rewritten task list slipped past a verdict recorded against the old one. Here plan.md is
  // constant and the TASK ROWS are the only thing that moved, so the case fails against exactly
  // that narrowing. (PLAN-V3 §State corollary 2: evidence binds to precisely what was judged. The
  // critic read plan.md AND the tasks; the subject is both halves — combinedPlanHash.)
  const h = fixture();
  const PLAN_MD = '# plan\nthe shape the critic read on round one\n';
  advanceTo(h, 'plan');
  h.seedPlan([planTask('T1'), planTask('T2', { depends_on: ['T1'] })], { planMd: PLAN_MD });
  recordPlanCritic(h, 'pass');
  ok(h, 'M1a-1b', 'state', 'decision-record', 'plan');
  ok(h, 'M1a-1b', 'state', 'stage-complete', 'plan');
  const criticBefore = h.readTasks().reviews.filter((rv) => rv.role === 'plan-critic').at(-1);
  assert.ok(criticBefore?.subjectHash, 'control: the pass must carry a DERIVED subject hash to begin with');

  // THE REVISION. New task content, one task added, one rewritten — re-imported through the
  // operator's own path. `--import` re-records plan.md too, so the plan.md half of the subject is
  // re-derived from bytes that did not change and cannot be what invalidates anything.
  h.writePlanTasks([
    planTask('T1', { title: 'the task the critic asked to be split', notes: 'mirror: the existing widget' }),
    planTask('T2', { depends_on: ['T1'] }),
    planTask('T3', { depends_on: ['T2'], title: 'the task the critic said was missing' }),
  ]);
  ok(h, 'M1a-1b', 'plan', 'check', '--feature', h.feature, '--import');
  assert.equal(h.readTasks().tasks.length, 3, 'the revision must actually have landed in canonical tasks.json');

  // plan.md IS THE CONTROL. If this ever fails, the case has stopped proving what it claims.
  assert.equal(
    readFileSync(join(h.dossier, 'plan.md'), 'utf8'), PLAN_MD,
    'plan.md must be byte-identical — the whole point is that ONLY the task rows moved',
  );

  // The re-import cascades the plan APPROVAL away (seedTasks: the tasks[] half of the subject
  // changed). Re-record it, so the ONLY stale evidence left in the manifest is the critic verdict
  // and the refusal below can be about nothing else. Without this the refusal would read
  // "no hash-valid plan approval" and the case would prove the cascade, not the review binding.
  assert.ok(!h.readTasks().approvals.plan, 'the re-import must have cascaded the plan approval away');
  ok(h, 'M1a-1b', 'state', 'decision-record', 'plan');
  assert.ok(h.readTasks().approvals.plan, 'and the re-approval over the REVISED plan must be recorded');

  const snap = h.snapshot();
  const r = h.legion('state', 'stage-complete', 'plan');
  assert.equal(r.code, 1, 'a critic pass over the PRE-revision plan cannot satisfy the revised one');
  assert.match(r.stderr, /judged a DIFFERENT plan/,
    'the refusal must say the verdict died with the plan it read — not that a review is missing (one is recorded) and not that the approval is stale (it was just re-recorded)');
  assert.match(r.stderr, /plan-critic/, 'and name the role whose verdict no longer binds');
  assert.ok(h.readTasks().reviews.some((rv) => rv.role === 'plan-critic' && rv.verdict === 'pass'),
    'the verdict is a FACT and must survive as history — only the CONCLUSION is re-derived');
  h.assertUnmoved(snap, 'a refused stage-complete plan over a pre-revision critic pass');

  // THE POSITIVE CONTROL — re-review closes the loop, and the stage moves on. Both halves matter:
  // an accept proves the kernel is not wedged, and `stage-enter build` proves the whole prefix
  // re-derives satisfied over the revised plan rather than merely the plan row.
  recordPlanCritic(h, 'pass');
  ok(h, 'M1a-1b', 'state', 'stage-complete', 'plan');
  ok(h, 'M1a-1b', 'state', 'stage-enter', 'build');
});

// =================================================================================================
// CASE 2 — gate failure → in-loop recovery
// =================================================================================================
// PLAN-V3 §Gates: "A red gate after commit is fixed forward: fixup commit → re-gate". The REFUSAL
// half (red gate ⇒ no receipt ⇒ task-done refuses) is M0 ledger row 2 and is NOT repeated here.
// What was never tested anywhere is that the recovery actually REACHES green — and that it reaches
// it by moving the TREE rather than by weakening the gate.

/** A gate policy whose verdict is a function of the COMMITTED TREE, which is what makes the
 * red→green transition in M1a-2a honest: the same pinned policy, run twice, disagreeing only
 * because the worktree content moved between the runs. It stands in for the project's real test
 * command — h.commit() appends `export const step<n>` to src/index.mjs, so the first commit leaves
 * the suite red ("the builder's work does not pass") and the fixup commit turns it green. A preset
 * that exits 1 unconditionally could never model a recovery, and one swapped between runs would be
 * policy drift, which `legion gate` refuses outright (enforcement.test.mjs case 3). */
const TREE_SENSITIVE_GATES = {
  commands: {
    suite: {
      argv: [process.execPath, '-e',
        "const s=require('node:fs').readFileSync('src/index.mjs','utf8');"
        + "if(!s.includes('step1')){console.error('suite: 1 failing assertion in src/index.mjs');process.exit(1)}"],
      timeoutMs: 30_000,
    },
  },
  task: ['suite'],
  boundary: ['suite'],
};

test('M1a-2a a RED task gate recovers FORWARD: fixup commit → green re-gate → a receipt keyed to the NEW tree closes it', () => {
  const h = fixture({ gates: TREE_SENSITIVE_GATES });
  advanceTo(h, 'build', { tasks: [planTask('T1'), planTask('T2')] });
  ok(h, 'M1a-2a', 'state', 'task-start', 'T1');

  // The builder commits work that does not pass the gate — the ordinary case, and the one the
  // protocol is written for (edit → self-test → commit → gate, with the gate as the arbiter).
  h.commit('T1: work that does not pass the suite');
  const failedTree = h.tree();

  const snap = h.snapshot();
  const red = h.legion('gate', 'run', '--task', 'T1');
  assert.equal(red.code, 1, 'the gate must go red on the tree the builder committed');
  assert.match(red.stderr, /suite/, 'the refusal must name the command that failed');
  assert.equal(taskRow(h, 'T1').receipt, undefined, 'a red gate mints NOTHING (M0 row 2 — cited, re-asserted here only as this case\'s precondition)');
  const done = h.legion('state', 'task-done', 'T1');
  assert.equal(done.code, 1, 'and there is nothing for task-done to consume');
  assert.match(done.stderr, /receipt/, 'the refusal must name what is missing');
  assert.equal(taskRow(h, 'T1').status, 'started', 'the task must still be open for the fixup');
  h.assertUnmoved(snap, 'a red gate followed by a refused task-done');

  // THE RECOVERY. A fixup commit — never a re-pin, never a policy edit — and the SAME pinned
  // policy now passes because the tree it is judging is different.
  const pinBefore = JSON.stringify(h.readFeature().commandPolicyHash);
  h.commit('T1: the fixup');
  const fixedTree = h.tree();
  assert.notEqual(fixedTree, failedTree, 'the fixup must actually have moved the tree');
  ok(h, 'M1a-2a', 'gate', 'run', '--task', 'T1');

  // THE CLAIM THIS CASE EXISTS FOR: the receipt keys to the tree that PASSED, not the one that
  // failed, and `task-done` consumes exactly that.
  const receipt = taskRow(h, 'T1').receipt;
  assert.equal(receipt.treeHash, fixedTree, 'the receipt must key to the POST-FIX tree');
  assert.notEqual(receipt.treeHash, failedTree, 'and never to the tree the gate refused');
  assert.equal(receipt.results.at(-1).exitCode, 0, 'its provenance must record the command actually passing');
  ok(h, 'M1a-2a', 'state', 'task-done', 'T1');
  assert.equal(taskRow(h, 'T1').status, 'done');

  // AND THE RECOVERY DID NOT BUY ITSELF A CHEAPER GATE. A "recovery" that re-pins the policy is the
  // failure mode PLAN-V3 §Gates pins the policy to prevent, and it would look identical from the
  // task row alone.
  assert.equal(JSON.stringify(h.readFeature().commandPolicyHash), pinBefore,
    'the pinned gate policy must be untouched — a red gate is fixed by moving the tree, never by moving the gate');
  assert.equal(h.readFeature().commandPolicyHistory, undefined,
    'and nothing may have been re-pinned behind the operator');
  assert.equal(receipt.commandPolicyHash, JSON.parse(pinBefore).task,
    'the receipt certifies the tree under the PINNED task policy, which is what makes it consumable');
});

test('M1a-2b a receipt earned green stops certifying the moment another commit lands — and a re-gate restores it', () => {
  // The stale-receipt shape at the CONSUMPTION boundary, with the two halves the existing unit
  // coverage does not carry: the no-state-moved assertion, and the recovery. Cited as the
  // behavioural precedent, deliberately not duplicated in substance: test/cli/gate.test.mjs
  // `verify-receipt passes on a fresh receipt and fails when missing or stale — running nothing`
  // and test/cli/state.test.mjs `task-start/task-done refuse unknown ids; task-done refuses
  // without or with a stale receipt`. Neither asserts that the refusals move nothing, and neither
  // re-gates afterwards, so neither closes the loop this case is about.
  const h = fixture({ gates: 'GREEN' });
  advanceTo(h, 'build', { tasks: [planTask('T1'), planTask('T2')] });
  ok(h, 'M1a-2b', 'state', 'task-start', 'T1');
  h.commit('T1: work');
  ok(h, 'M1a-2b', 'gate', 'run', '--task', 'T1');
  const certifiedTree = h.tree();
  assert.equal(taskRow(h, 'T1').receipt.treeHash, certifiedTree, 'precondition: a genuinely earned receipt');
  ok(h, 'M1a-2b', 'gate', 'verify-receipt', '--task', 'T1'); // control: it certifies RIGHT NOW

  // Another commit lands before the task is closed — a follow-up edit, a rebase, a second builder
  // pass. The receipt is still real, still provenanced, and no longer describes this tree.
  h.commit('a second commit no gate has certified');
  assert.notEqual(h.tree(), certifiedTree, 'the tree must genuinely have moved past the receipt');

  const snap = h.snapshot();
  const done = h.legion('state', 'task-done', 'T1');
  assert.equal(done.code, 1, 'a receipt for a superseded tree closes nothing');
  assert.match(done.stderr, /tree/, 'the refusal must name the tree mismatch, not merely "no receipt" — the receipt is right there');
  const verify = h.legion('gate', 'verify-receipt', '--task', 'T1');
  assert.equal(verify.code, 1, 'and the hook-facing verifier must agree — one answer, two consumers');
  assert.match(verify.stderr, /no valid receipt for task T1/);
  assert.equal(taskRow(h, 'T1').status, 'started', 'the task must not have closed');
  h.assertUnmoved(snap, 'two refusals over a superseded receipt');

  // THE POSITIVE CONTROL: re-gate on the tree that actually exists, and the task closes.
  ok(h, 'M1a-2b', 'gate', 'run', '--task', 'T1');
  assert.equal(taskRow(h, 'T1').receipt.treeHash, h.tree(), 're-gating re-keys the receipt to the current tree');
  ok(h, 'M1a-2b', 'state', 'task-done', 'T1');
  assert.equal(taskRow(h, 'T1').status, 'done');
});

// =================================================================================================
// CASE 3 — approval invalidation cascade on spec edit, the DEPENDENT half
// =================================================================================================
// M0 ledger row 4 (m0-fixtures.test.mjs F4a/F4b) proved the SPEC's own approval is consumed after a
// spec edit, and test/cli/state.test.mjs's cascade tests prove `approvals.plan` is DROPPED from the
// manifest. Neither proves the thing M1a's fixture track names: that the cascade REACHING the plan
// approval is enforced at a consumer. Those are independent — a kernel that dropped the record
// while `stage-complete` consulted `completedStages` would look identical in the manifest and pass
// the feature through anyway, which is the exact defect class §State's facts-not-conclusions rule
// exists to prevent.

test('M1a-3 a spec edit invalidates the PLAN approval at its consumer, isolated from the spec\'s own staleness', () => {
  const h = fixture();
  approvedPlan(h, [planTask('T1'), planTask('T2', { depends_on: ['T1'] })]);
  const criticBefore = JSON.stringify(h.readTasks().reviews.filter((rv) => rv.role === 'plan-critic'));

  // The edit, through `artifact-record` — the operator's own path, never a hand-edited manifest.
  h.writeArtifact('spec.md', '# spec\nthe scope moved after the plan was approved\n');
  ok(h, 'M1a-3', 'state', 'artifact-record', 'spec', 'spec.md');
  assert.ok(!h.readTasks().approvals.spec, 'the spec approval falls with its own subject');
  assert.ok(!h.readTasks().approvals.plan, 'and the plan approval falls WITH it — the cascade, as a manifest fact');

  // (b1) The prefix half: standing in `plan`, the refusal names the EARLIER stage. This is F4b's
  // claim one stage closer to the edit, and it is the half that says "look upstream".
  let snap = h.snapshot();
  let r = h.legion('state', 'stage-complete', 'plan');
  assert.equal(r.code, 1, 'the whole prefix re-derives, so a stale spec blocks the plan stage too');
  assert.match(r.stderr, /earlier stage/i, 'and the refusal must say the defect is upstream');
  assert.match(r.stderr, /spec/, 'naming the stage that went stale');
  h.assertUnmoved(snap, 'a refused stage-complete plan over a stale spec approval');

  // (b2) THE ISOLATION, AND THE ACTUAL CASCADE PROOF. Repair the SPEC and nothing else. If the
  // cascade had not reached the plan approval, the plan stage would be fully satisfied right now
  // and this op would ACCEPT — the plan artifact never moved, the critic pass still binds, and the
  // prefix is clean. It refuses, and it refuses naming the PLAN's own approval rather than an
  // earlier stage. That difference is the whole claim: a dependent approval fell with its parent.
  ok(h, 'M1a-3', 'state', 'decision-record', 'spec');
  assert.ok(h.readTasks().approvals.spec, 'the spec approval is repaired');
  assert.ok(!h.readTasks().approvals.plan, 'and the plan approval is still gone — nothing revived it');
  snap = h.snapshot();
  r = h.legion('state', 'stage-complete', 'plan');
  assert.equal(r.code, 1, 'the plan approval fell by CASCADE and nothing re-recorded it');
  assert.match(r.stderr, /hash-valid plan approval/,
    'the refusal must now name the PLAN\'s own approval — an "earlier stage" message here would mean the spec repair did not take and the case proves nothing');
  assert.doesNotMatch(r.stderr, /earlier stage/i, 'the prefix is repaired, so the only defect left is the cascaded plan approval');
  h.assertUnmoved(snap, 'a refused stage-complete plan over a CASCADED plan approval');

  // The same claim at the sharper consumer: forward entry re-derives the prefix INCLUDING the
  // current stage, so `stage-enter build` must refuse for the same reason.
  snap = h.snapshot();
  const fwd = h.legion('state', 'stage-enter', 'build');
  assert.equal(fwd.code, 1, 'forward entry must refuse on the same cascaded approval');
  assert.match(fwd.stderr, /plan/, 'naming the stage whose approval went');
  assert.equal(h.readFeature().stage, 'plan', 'and no hop may have landed');
  h.assertUnmoved(snap, 'a refused stage-enter build over a cascaded plan approval');

  // (c) THE POSITIVE CONTROL, and the honest answer to "does the critic verdict survive a spec
  // edit?". IT DOES, and that is CORRECT per PLAN-V3 §State corollary 2: evidence binds to exactly
  // what was judged. A plan review's subject is the PLAN subject — plan.md's bytes plus the content
  // projection of the task rows — and a spec edit moves neither. The critic read the plan; the plan
  // is unchanged; the verdict still describes it. Re-recording the approval is a HUMAN act (the
  // operator re-assents to a plan they now read against a new spec) and the kernel demands exactly
  // that and no more. So: no re-review is performed below, and the stage must accept.
  ok(h, 'M1a-3', 'state', 'decision-record', 'plan');
  ok(h, 'M1a-3', 'state', 'stage-complete', 'plan');
  assert.equal(JSON.stringify(h.readTasks().reviews.filter((rv) => rv.role === 'plan-critic')), criticBefore,
    'and no critic verdict was recorded, re-recorded or removed to get there — the accept rides the ORIGINAL pass');
  ok(h, 'M1a-3', 'state', 'stage-enter', 'build');
});
