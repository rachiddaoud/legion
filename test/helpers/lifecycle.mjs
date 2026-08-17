// lifecycle.mjs — the ONE evidence-only walk of the feature lifecycle, shared by every acceptance
// file (T21). It was born inside test/acceptance/enforcement.test.mjs and moved here VERBATIM when
// a second acceptance file needed it: two copies of a walk that encodes T13's prerequisite table
// is two places for that table to drift, and the drift is only ever discovered as a green test
// over a broken kernel.
//
// WHY IT IS NOT IN fixture.mjs: fixture.mjs builds "a project and feature that exist"; this file
// encodes "what the kernel currently demands at each stage". The first is a harness, the second is
// a claim about the code under test and will move when the prerequisite table moves. Keeping them
// apart keeps that churn out of the harness.
//
// `node --test` DISCOVERS THIS FILE and runs it as a zero-test file — so, exactly as in
// fixture.mjs, module scope declares constants and functions and does NOTHING else: no temp dirs,
// no git, no assertions at import.
//
// EVIDENCE ONLY, NEVER A FORGERY: every stage below is satisfied the way an operator satisfies it —
// artifacts hashed by the kernel through `artifact-record`, approvals recorded over kernel-derived
// subjects, tasks closed by receipts a REAL `legion gate run` minted. Nothing here hand-writes a
// manifest. A case that needs a forgery does it itself, at its own call site, where the reader can
// see it.
import assert from 'node:assert/strict';
import { planTask } from './fixture.mjs';

export const STAGES = ['intake', 'spec', 'plan', 'build', 'review', 'pre-merge', 'finalize'];

/** A step that MUST succeed for the case to be meaningful. Failing loudly here (rather than
 * asserting on a refusal that never happened) is what keeps a red case legible. */
export function ok(h, label, ...argv) {
  const r = h.legion(...argv);
  assert.equal(r.code, 0, `${label}: \`legion ${argv.join(' ')}\` must succeed, got ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  return r;
}

export const taskRow = (h, id) => h.readTasks().tasks.find((t) => t.id === id);

/** Roles the acceptance suite is willing to record to satisfy a profile's required review set. The
 * profile -> review-set map is KERNEL-SIDE (PLAN-V3 decision 10); duplicating it here would make
 * these tests assert their own copy of it, so satisfyReviews() DISCOVERS the requirement instead by
 * recording one role at a time until the kernel accepts. */
export const REVIEW_ROLES = [
  'code-reviewer', 'product-reviewer', 'codex-consult', 'plan-critic',
  'architect', 'builder', 'kernel-op', 'milestone-reviewer',
];

/** MINT the review receipt an enforced reviewer-role record consumes, through the REAL surface
 * the reviewer's SubagentStop hook calls (`legion gate review-receipt`) — never by hand-writing
 * `reviewReceipts[]` (a forgery belongs at a case's own call site, per the header). Returns
 * whether a receipt was minted: the kernel refuses non-reviewer agent types, which is the
 * correct outcome for the deliberately-unknown roles satisfyReviews probes with. */
export function mintReviewReceipt(h, role, verdict = 'pass') {
  const r = h.legion('gate', 'review-receipt', '--agent-type', `legion:${role}`,
    '--agent-id', `acc-${role}`, ...(verdict ? ['--verdict', verdict] : []));
  return r.code === 0;
}

/** The plan review's SUBJECT vocabulary is the kernel's (a plan review carries the PLAN subject
 * hash, not the tree — PLAN-V3 §State corollary 2). Accept either spelling so this setup does not
 * dictate an interface it is not testing. */
export function recordPlanCritic(h, verdict = 'pass') {
  mintReviewReceipt(h, 'plan-critic', verdict); // the record consumes attendance evidence
  for (const subject of ['plan', 'feature']) {
    const r = h.legion('state', 'review-record', '--role', 'plan-critic', '--verdict', verdict, '--subject', subject);
    if (r.code === 0) return subject;
  }
  assert.fail(`review-record refused a plan-critic '${verdict}' under every subject this suite knows (plan, feature)`);
}

/** Record passing reviews until `stage-complete review` accepts, and return what was needed.
 * Records NOTHING when the kernel already accepts (an express profile may require none). */
export function satisfyReviews(h) {
  const recorded = [];
  let r = h.legion('state', 'stage-complete', 'review');
  for (const role of REVIEW_ROLES) {
    if (r.code === 0) break;
    // Reviewer roles record only over a receipt; the probe roles the kernel does not know
    // (architect, builder, …) have no receipt to mint and record bare, as before.
    mintReviewReceipt(h, role);
    ok(h, `satisfyReviews(${role})`, 'state', 'review-record', '--role', role, '--verdict', 'pass', '--subject', 'feature');
    recorded.push(role);
    r = h.legion('state', 'stage-complete', 'review');
  }
  assert.equal(r.code, 0,
    `stage-complete review never accepted (recorded: ${recorded.join(', ') || 'nothing'}): ${(r.stderr || r.stdout).trim()}`);
  return recorded;
}

/** Walk a feature to `target` OUT OF REAL EVIDENCE ONLY. Contract: on return the current stage IS
 * `target` and every EARLIER stage is satisfied; the target stage's own evidence is deliberately
 * NOT recorded, because that is what the cases manipulate.
 *
 * WHY THE WALK IS NOT SELF-DEFEATING, stated because it very nearly was (PLAN-V3 §State
 * corollary 2): closing a task mutates KERNEL-OWNED PROGRESS on its row — status, receipt,
 * timestamps, answers — and that progress is OUTSIDE the plan approval's subject BY SPEC. The
 * subject is plan.md's bytes plus the CONTENT projection of the task rows — `planContent`
 * (src/kernel/state.mjs), the six fields id/title/depends_on/milestone/validate/notes, NOT
 * `projectPlanRow`, which also stamps the constants status:'pending' and attempt:0 — because a
 * human assented to the plan's content, not to progress against it. Were the subject to hash whole
 * rows, the first `task-start` below would invalidate the plan approval and strand the feature:
 * `stage-complete build`, `stage-enter review`, `finalize` and `close delivered` would all be
 * permanently unreachable. enforcement.test.mjs case 10c IS THE ASSERTION THAT PINS THAT, and it is
 * why this walk does NOT re-record the plan approval after closing tasks: a re-record here would
 * paper over the very deadlock 10c exists to catch. */
export function advanceTo(h, target, { profile = 'standard', tasks = [planTask('T1')] } = {}) {
  const want = STAGES.indexOf(target);
  assert.notEqual(want, -1, `advanceTo: '${target}' is not a stage`);

  if (want >= 1) { // intake satisfied: intent artifact + hash-valid approval + classified profile
    h.writeArtifact('intent.md', '# intent\nthe feature we recapped and agreed on\n');
    ok(h, 'intake', 'state', 'artifact-record', 'intent', 'intent.md');
    ok(h, 'intake', 'state', 'decision-record', 'intake');
    ok(h, 'intake', 'state', 'escalate-profile', profile);
    ok(h, 'intake', 'state', 'stage-complete', 'intake');
    ok(h, 'intake', 'state', 'stage-enter', 'spec');
  }
  if (want >= 2) { // spec satisfied
    h.writeArtifact('spec.md', '# spec\nwhat we will build\n');
    ok(h, 'spec', 'state', 'artifact-record', 'spec', 'spec.md');
    ok(h, 'spec', 'state', 'decision-record', 'spec');
    ok(h, 'spec', 'state', 'stage-complete', 'spec');
    ok(h, 'spec', 'state', 'stage-enter', 'plan');
  }
  if (want >= 3) { // plan satisfied: imported plan + passing critic + hash-valid approval
    h.seedPlan(tasks);
    recordPlanCritic(h, 'pass');
    ok(h, 'plan', 'state', 'decision-record', 'plan');
    ok(h, 'plan', 'state', 'stage-complete', 'plan');
    ok(h, 'plan', 'state', 'stage-enter', 'build');
  }
  if (want >= 4) { // build satisfied: every task done, each closed by a real gate receipt
    for (const t of tasks) {
      ok(h, `build ${t.id}`, 'state', 'task-start', t.id);
      h.commit(`${t.id}: work`);
      ok(h, `build ${t.id}`, 'gate', 'run', '--task', t.id);
      ok(h, `build ${t.id}`, 'state', 'task-done', t.id);
    }
    ok(h, 'build', 'state', 'stage-complete', 'build');
    ok(h, 'build', 'state', 'stage-enter', 'review');
  }
  if (want >= 5) { // review satisfied for the CURRENT tree
    satisfyReviews(h);
    ok(h, 'review', 'state', 'stage-enter', 'pre-merge');
  }
  if (want >= 6) { // pre-merge satisfied: boundary receipt at HEAD, then the approval over it
    ok(h, 'pre-merge', 'gate', 'run', '--boundary');
    ok(h, 'pre-merge', 'state', 'decision-record', 'pre-merge');
    ok(h, 'pre-merge', 'state', 'stage-complete', 'pre-merge');
    ok(h, 'pre-merge', 'state', 'stage-enter', 'finalize');
  }
  assert.equal(h.readFeature().stage, target, `advanceTo: expected to be standing in ${target}`);
}
