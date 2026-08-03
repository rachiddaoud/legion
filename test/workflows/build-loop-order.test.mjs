// Behaviour guard for workflows/build-loop.js — the parts that live in CONTROL FLOW and in the
// text of a dispatch, both of which a source-grep cannot check honestly. Four groups:
//
// SELECTION ORDER (T13 — R5's workflow half, PLAN-V3 decision 2: "Order in the file is never
// load-bearing"). The workflow used to iterate tasks.json in FILE order and only deferred
// dependencies that had already failed in the same run, so a plan listing T2 before T1 built T2
// first — against unbuilt ground. These tests pin the fix: selection is a deterministic
// topological pass, stable (file order) for equal-depth tasks so re-runs reproduce, and deferral
// is transitive when a dependency chain stalls.
//
// REVIEW ROUTING AND BRIEF CONTENT (T20 — M0 findings 7 and 8). The fix round's re-review must go
// back to the LENS THAT FAILED, carrying that lens's own findings verbatim: M0 re-reviewed a codex
// fail with the Claude lens, so the finding that stopped the task was cleared by an agent that
// never raised it. And the builder's brief must carry the mutation sweep, because for a test-only
// diff nothing else distinguishes a load-bearing test from one that passes against broken code.
// Both are prompt-borne — the assertions therefore read the prompts the fakes captured, which is
// the only place that behaviour exists.
//
// MILESTONE INTERLEAVING AND THE CLOSE (T28 — PLAN-V3 decision 11's 2026-07-29 amendment, S-008).
// Milestone N's tasks, then milestone N's CLOSE (squash → boundary gate → milestone code review →
// product review), then milestone N+1 — and nothing of N+1 before N closed. Every one of those
// facts is an ORDER fact, invisible to a source grep, and the resume half (a run that died between
// the last task-done and the close) is a control-flow fact about args.reviews. Both live here.
//
// PER-DISPATCH OPTIONS (T28 — S-009 opus default, S-010 risk tiers, S-008 two-level progress).
// model / effort / phase are not prose: they are fields on every dispatch, so the harness captures
// the whole opts object and the assertions read it.
//
// HOW THE SCRIPT IS EXECUTED. The workflow is NOT an importable module — it uses the sandbox
// globals (args/agent/parallel/log) and a top-level `return`, which no ES module parses. The
// same wrapping trick test/plugin-manifest.test.mjs uses for its parse check is used here to
// RUN it: demote `export const meta` to a local and evaluate the source as the body of an
// AsyncFunction whose parameters are the sandbox globals, injected as fakes. The fakes are the
// hermetic seam: no real agent, no kernel, no git, no filesystem — the assertions are about
// ORDER and DISPATCH SHAPE, which is exactly what the fakes record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SRC = readFileSync(join(ROOT, 'workflows', 'build-loop.js'), 'utf8')
  .replace(/^export const meta/, 'const meta');
const AsyncFunction = Object.getPrototypeOf(async function f() {}).constructor;

/** A plausible tree hash. The squash contract is "the tree did not move", so the fake reports the
 * SAME hash twice by default and a case that wants the failure path reports two. */
const TREE = 'a'.repeat(40);

/** Run the workflow against `tasks` with recording fakes.
 *  - `builderResult(id)` lets a case make one task block or fail (label `<id> build` / `<id> fix`).
 *  - `lensResult(agentType, label)` scripts any reviewer — the two task lenses and the two close
 *    reviewers alike; returning undefined falls back to a clean pass, so a case only writes the
 *    verdicts it is about.
 *  - `squashResult(milestoneId)` / `gateResult(label)` script the milestone closer.
 *  - `kernelResult(argvText, label)` scripts ONE kernel op — returning undefined falls back to
 *    exit 0, so a case only writes the refusal it is about. Added by T31 for the gate-receipt
 *    case: `legion gate verify-receipt --task <id>` refusing is the loop's only defence against a
 *    builder that reports `receipt: true` without having earned one, and it was unreachable from
 *    this harness while every kernel dispatch was hard-coded to succeed.
 *  - `args` merges into the workflow args (profile, reviews, model, squash, …).
 * Every kernel dispatch succeeds (exit 0) unless kernelResult says otherwise, so nothing but the
 * behaviour under test can fail a task.
 * Returns { result, builds, kernelCmds, logs, dispatches } — `dispatches` keeps every
 * {agentType, label, prompt, opts} in order, which is where the prompt- and opts-borne assertions
 * read from. */
async function runLoop(tasks, { builderResult, lensResult, squashResult, gateResult, closeFixResult, kernelResult, args } = {}) {
  const builds = [];
  const kernelCmds = [];
  const logs = [];
  const dispatches = [];
  const agent = async (prompt, opts) => {
    const { agentType, label } = opts;
    dispatches.push({ agentType, label, prompt, opts });
    if (agentType === 'legion:kernel-op') {
      // kernel() interpolates `cd <worktree> && legion <argvText>` — recover the argv text.
      const m = prompt.match(/&& legion ([^\n]+)/);
      const argvText = m ? m[1].trim() : `UNPARSED:${label}`;
      kernelCmds.push(argvText);
      return kernelResult?.(argvText, label) ?? { exitCode: 0, output: '' };
    }
    if (agentType === 'legion:builder') {
      // The closer is a builder-type agent too (`legion gate run` must never reach kernel-op), so
      // the builder dispatches are told apart by LABEL — the same flattened progress entries the
      // viewer renders.
      if (/ squash$/.test(label)) {
        const m = label.replace(/ squash$/, '');
        return squashResult?.(m) ?? { status: 'squashed', commit: 'd'.repeat(40), treeBefore: TREE, treeAfter: TREE };
      }
      if (/boundary gate/.test(label)) return gateResult?.(label) ?? { exitCode: 0, output: '' };
      if (/ close fix$/.test(label)) {
        const m = label.replace(/ close fix$/, '');
        return closeFixResult?.(m) ?? { status: 'built', commit: 'e'.repeat(40), summary: 's', files: [] };
      }
      assert.match(label, / (build|fix)$/, `unexpected builder label ${label}`);
      builds.push(label); // "<id> build" / "<id> fix"
      const id = label.replace(/ (build|fix)$/, '');
      return builderResult?.(id) ?? { status: 'built', commit: 'c'.repeat(40), receipt: true, summary: 's', files: [] };
    }
    if (agentType === 'legion:code-reviewer' || agentType === 'legion:codex-consult' || agentType === 'legion:product-reviewer' || agentType === 'legion:visual-reviewer') {
      const scripted = lensResult?.(agentType, label);
      if (scripted !== undefined) return scripted;
      return agentType === 'legion:codex-consult'
        ? { verdict: 'pass', findings: [], available: true }
        : { verdict: 'pass', findings: [] };
    }
    throw new Error(`unexpected agentType ${agentType}`);
  };
  const parallel = async (thunks) => {
    const out = [];
    for (const th of thunks) out.push(await th()); // sequential is a legal parallel schedule
    return out;
  };
  const run = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', 'budget', SRC);
  const result = await run(
    { dossier: '/dossier', worktree: '/worktree', planPath: '/dossier/plan.md', tasks, ...(args ?? {}) },
    agent, parallel, null, null, (line) => logs.push(String(line)), null,
  );
  return { result, builds, kernelCmds, logs, dispatches };
}

const row = (id, extra = {}) => ({ id, title: `do ${id}`, status: 'pending', attempt: 0, depends_on: [], milestone: 'M1', ...extra });
/** A recorded review as the kernel stores it (src/kernel/state.mjs: {role, verdict, subject,
 * subjectHash, at}). The subject is the PLAIN form the manifest holds — `milestone:M1`, never the
 * shell-quoted `milestone:'M1'` that appears in a kernel-op dispatch. */
const rec = (role, verdict, subject) => ({ role, verdict, subject, subjectHash: 'f'.repeat(64), at: '2026-07-29T00:00:00.000Z' });
/** Every dispatch that is NOT a kernel op, by label — the flattened progress entries in order. */
const flow = (dispatches) => dispatches.filter((d) => d.agentType !== 'legion:kernel-op').map((d) => d.label);

test('tasks are selected in DEPENDENCY order even when the file order contradicts it', async () => {
  // T2 first in the file and dependent on T1; T3 depends on T2. File order would build T2 first,
  // which the kernel's task-start now refuses (R5) — selection must not manufacture that refusal.
  const { result, builds } = await runLoop([
    row('T2', { depends_on: ['T1'] }),
    row('T3', { depends_on: ['T2'] }),
    row('T1'),
  ]);
  assert.deepEqual(builds, ['T1 build', 'T2 build', 'T3 build'],
    'the builder must be dispatched dependency-first, whatever the file order');
  assert.deepEqual(result.built, ['T1', 'T2', 'T3']);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(result.deferred, []);
});

test('equal-depth tasks keep FILE order — the selection is stable, so re-runs reproduce', async () => {
  const { builds } = await runLoop([row('T3'), row('T1'), row('T2')]);
  assert.deepEqual(builds, ['T3 build', 'T1 build', 'T2 build'],
    'no dependency forces an order here, so the file order must be preserved verbatim');
});

test('done tasks skip and their dependents still build, in dependency order', async () => {
  const { result, builds } = await runLoop([
    row('T2', { depends_on: ['T1'] }),
    row('T1', { status: 'done' }),
    row('T3', { depends_on: ['T2'] }),
  ]);
  assert.deepEqual(builds, ['T2 build', 'T3 build'], 'a done dependency is satisfied ground, not a dispatch');
  assert.deepEqual(result.skipped, ['T1']);
  assert.deepEqual(result.built, ['T2', 'T3']);
});

test('a blocked dependency defers its WHOLE dependent chain, transitively', async () => {
  // T1 blocks; T2 depends on T1 and T3 on T2. Deferral must be transitive — without it T3's
  // dependency looks "merely deferred", the loop dispatches it, and task-start fails a task that
  // could never have started. A deferred chain is a chain, and the re-run picks it up whole.
  const { result, builds } = await runLoop(
    [row('T3', { depends_on: ['T2'] }), row('T2', { depends_on: ['T1'] }), row('T1')],
    { builderResult: (id) => (id === 'T1' ? { status: 'blocked', question: 'which widget?' } : undefined) },
  );
  assert.deepEqual(builds, ['T1 build'], 'nothing downstream of the blocked task may be dispatched');
  assert.deepEqual(result.blocked, [{ taskId: 'T1', milestone: 'M1', question: 'which widget?' }]);
  assert.deepEqual(result.deferred.map((d) => d.taskId), ['T2', 'T3']);
  assert.deepEqual(result.built, []);
});

// --- T20: the re-review belongs to the lens that failed (M0 finding 8) -----------------------

/** One blocking finding, titled so a prompt assertion can prove WHICH lens's list travelled. */
const mustFix = (title) => ({ tier: 'must-fix', title, where: 'src/x.mjs:1', issue: 'i', fix: 'f' });
const reReviews = (dispatches) => dispatches.filter((d) => / re-review:/.test(d.label));
/** How many verdicts of this role reached the kernel FOR THIS SUBJECT — round 1 plus any
 * re-review. The subject is part of the count on purpose: since T28 the milestone close records
 * `code-reviewer` verdicts too, and a count that ignored the subject would silently conflate a
 * task's second lens verdict with its milestone's first. */
const verdictsFor = (kernelCmds, role, subject) =>
  kernelCmds.filter((c) => c.startsWith(`state review-record --role '${role}'`) && c.endsWith(`--subject ${subject}`)).length;

test('a CODEX fail is re-reviewed by CODEX — the other lens never clears a finding it did not raise', async () => {
  // The M0 defect exactly: codex failed the task, the fix round ran, and the CLAUDE lens judged
  // the fix. The finding that stopped the task was cleared by an agent that had never seen it.
  const { result, dispatches, kernelCmds, builds } = await runLoop([row('T1')], {
    lensResult: (type, label) =>
      (label === 'T1 review:codex-consult' ? { verdict: 'fail', available: true, findings: [mustFix('codex saw it')] } : undefined),
  });
  assert.deepEqual(builds, ['T1 build', 'T1 fix'], 'a blocking codex finding must still cost one fix round');
  const re = reReviews(dispatches);
  assert.equal(re.length, 1, 'exactly one lens failed, so exactly one lens re-reviews');
  assert.equal(re[0].agentType, 'legion:codex-consult', 'the re-review goes to the lens that failed');
  assert.match(re[0].prompt, /codex saw it/, "and it carries that lens's own finding verbatim");
  assert.deepEqual(result.built, ['T1'], 'the failing lens cleared its own finding, so the task completes');
  assert.equal(verdictsFor(kernelCmds, 'codex-consult', "task:'T1'"), 2,
    'the re-review verdict is recorded under the codex role');
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "task:'T1'"), 1,
    'the passing lens is not re-dispatched and records no second verdict');
});

test('when BOTH lenses fail, each re-reviews its OWN findings and never the other lens’s', async () => {
  const { result, dispatches } = await runLoop([row('T1')], {
    lensResult: (type, label) => {
      if (label === 'T1 review:code-reviewer') return { verdict: 'fail', findings: [mustFix('claude finding')] };
      if (label === 'T1 review:codex-consult') return { verdict: 'fail', available: true, findings: [mustFix('codex finding')] };
      return undefined; // both re-reviews pass, and the milestone close passes
    },
  });
  const re = reReviews(dispatches);
  assert.deepEqual(re.map((d) => d.agentType).sort(), ['legion:code-reviewer', 'legion:codex-consult']);
  const byType = Object.fromEntries(re.map((d) => [d.agentType, d.prompt]));
  assert.match(byType['legion:code-reviewer'], /claude finding/);
  assert.doesNotMatch(byType['legion:code-reviewer'], /codex finding/,
    "a merged checklist makes each lens grade the other's findings — the checklist is per lens");
  assert.match(byType['legion:codex-consult'], /codex finding/);
  assert.doesNotMatch(byType['legion:codex-consult'], /claude finding/);
  // The BUILDER, by contrast, fixes everything blocking in one round — that list is deliberately merged.
  const fixBrief = dispatches.find((d) => d.label === 'T1 fix').prompt;
  assert.match(fixBrief, /claude finding/);
  assert.match(fixBrief, /codex finding/);
  assert.deepEqual(result.built, ['T1']);
});

test('a lens that PASSED is not dragged into the re-review round', async () => {
  const { dispatches, result } = await runLoop([row('T1')], {
    lensResult: (type, label) =>
      (label === 'T1 review:code-reviewer' ? { verdict: 'fail', findings: [mustFix('claude only')] } : undefined),
  });
  const re = reReviews(dispatches);
  assert.equal(re.length, 1);
  assert.equal(re[0].agentType, 'legion:code-reviewer');
  const codexDispatches = dispatches.filter((d) => d.agentType === 'legion:codex-consult');
  assert.equal(codexDispatches.length, 1, 'codex passed round 1; it has nothing to confirm');
  // c11: re-certification exists at MILESTONE scope only — task-subject verdicts are outside
  // productScope, so a stale task pass gates nothing and re-certifying it would buy dispatches,
  // not evidence. The task fix round must never grow one.
  assert.ok(!dispatches.some((d) => / re-certify:/.test(d.label)),
    'task lenses are never re-certified');
  assert.deepEqual(result.built, ['T1']);
});

test('a failing lens that cannot re-review leaves its finding UNCONFIRMED — the task fails closed', async () => {
  // Codex rejected the task and then went away. The tempting move is to let the Claude lens clear
  // it (that is the M0 defect) or to record a codex verdict nobody produced (forged evidence).
  const { result, dispatches, kernelCmds, logs } = await runLoop([row('T1')], {
    lensResult: (type, label) => {
      if (label === 'T1 review:codex-consult') return { verdict: 'fail', available: true, findings: [mustFix('codex saw it')] };
      if (label === 'T1 re-review:codex-consult') return { verdict: 'fail', findings: [], available: false };
      return undefined;
    },
  });
  assert.deepEqual(result.built, [], 'an unconfirmed finding is not a pass');
  assert.deepEqual(result.failed.map((f) => f.stage), ['review']);
  assert.deepEqual(result.failed[0].unconfirmedBy, ['codex-consult'],
    'the session must be able to tell "never re-judged" from "re-judged and rejected"');
  assert.deepEqual(result.failed[0].findings.map((f) => f.title), ['codex saw it'],
    "the unavailable lens's findings carry forward, unconfirmed");
  assert.equal(verdictsFor(kernelCmds, 'codex-consult', "task:'T1'"), 1,
    'a verdict for a review that did not happen would be forged evidence');
  assert.deepEqual(reReviews(dispatches).map((d) => d.agentType), ['legion:codex-consult'],
    'the Claude lens must not stand in for the lens that failed');
  assert.ok(logs.some((l) => /could not re-review/.test(l)), 'and it is said out loud');
});

test('an unavailable lens whose findings were ALL NOTES still fails the task closed, and is reported', async () => {
  // The hole the previous test cannot see: it scripts the vanished lens with a must-fix, so the
  // fail is carried by `findings`, not by the unavailable status. Here the codex lens rejects the
  // task while raising only NOTE-tier findings — an entirely ordinary consult verdict — so
  // `lensBlocking(codex)` is empty and nothing carries forward. Before the fix, `primaryVerdict`
  // was already 'pass' (Claude cleared its own must-fix) and `findings` empty, so the task was
  // marked DONE while the log claimed "failing closed", `unconfirmedBy` was computed and dropped
  // on the pass path, and nothing reached `degraded`.
  const note = { tier: 'note', title: 'codex nit', where: 'src/x.mjs:9', issue: 'i', fix: 'f' };
  const { result, kernelCmds, logs } = await runLoop([row('T1')], {
    lensResult: (type, label) => {
      if (label === 'T1 review:code-reviewer') return { verdict: 'fail', findings: [mustFix('claude finding')] };
      if (label === 'T1 review:codex-consult') return { verdict: 'fail', available: true, findings: [note] };
      if (label === 'T1 re-review:codex-consult') return { verdict: 'pass', findings: [], available: false };
      return undefined; // the Claude re-review clears its own finding
    },
  });
  assert.deepEqual(result.built, [], 'a lens that rejected this task and never re-judged it is not a pass');
  assert.ok(!kernelCmds.some((c) => /^state task-done/.test(c)), 'and task-done is never dispatched');
  assert.deepEqual(result.failed.map((f) => f.stage), ['review']);
  assert.deepEqual(result.failed[0].unconfirmedBy, ['codex-consult'],
    'the fact must be reported, not merely computed');
  assert.deepEqual(result.failed[0].findings, [],
    'the fail is carried by the unconfirmed status itself — the findings list is legitimately empty');
  assert.deepEqual(result.degraded, ['T1'],
    'a lens vanishing MID-round degrades the review just as much as one gone before it started');
  assert.ok(logs.some((l) => /could not re-review/.test(l)), 'and the log line is now true');
});

test('a mid-round lens loss is pushed to `degraded` ONCE, not once per lens', async () => {
  // Both lenses reject the task and both go away before their re-review. `degraded` is read by id
  // (skills/feature/SKILL.md review step 5); a duplicated id reads as two degraded tasks.
  const { result } = await runLoop([row('T1')], {
    lensResult: (type, label) => {
      if (label === 'T1 review:code-reviewer') return { verdict: 'fail', findings: [mustFix('claude finding')] };
      if (label === 'T1 review:codex-consult') return { verdict: 'fail', available: true, findings: [mustFix('codex finding')] };
      return { verdict: 'pass', findings: [], available: false }; // both re-reviews unavailable
    },
  });
  assert.deepEqual(result.degraded, ['T1']);
  assert.deepEqual(result.failed[0].unconfirmedBy, ['code-reviewer', 'codex-consult']);
  assert.deepEqual(result.built, []);
});

// --- T20: the mutation sweep rides in every brief (M0 finding 7) -----------------------------

test('every builder brief carries the mutation sweep, fix rounds included', async () => {
  const { dispatches } = await runLoop([row('T1')], {
    lensResult: (type, label) =>
      (label === 'T1 review:code-reviewer' ? { verdict: 'fail', findings: [mustFix('needs a fix')] } : undefined),
  });
  const briefs = dispatches.filter((d) => d.agentType === 'legion:builder' && / (build|fix)$/.test(d.label));
  assert.deepEqual(briefs.map((d) => d.label), ['T1 build', 'T1 fix']);
  for (const b of briefs) {
    // The three load-bearing halves: when it applies, what counts as killing a mutant, and the
    // record. A sweep with no reported result is indistinguishable from one that never ran, which
    // is the failure this replaces — so the commit-body clause is not decoration.
    assert.match(b.prompt, /MUTATION SWEEP — REQUIRED WHEN YOUR DIFF IS TEST-ONLY/, `${b.label} states when it applies`);
    assert.match(b.prompt, /confirm AT LEAST ONE NEW TEST FAILS/, `${b.label} states what kills a mutant`);
    assert.match(b.prompt, /surviving plausible mutant is a DEFECT IN THE TESTS/, `${b.label} states the survivor rule`);
    assert.match(b.prompt, /commit message body/, `${b.label} requires the sweep on the record`);
  }
});

test('reviewer dispatch prompts carry the blast-radius mandate (RR3) — task lenses, re-reviews AND the milestone close', async () => {
  // Without it the tiers read as confidence rather than consequence and the single fix round is
  // spent on the long tail — M0's five rounds on a 259-line diff. The close's reviewers get one
  // fix round too, so the mandate binds them for exactly the same reason.
  const { dispatches } = await runLoop([row('T1')], {
    lensResult: (type, label) =>
      (label === 'T1 review:code-reviewer' ? { verdict: 'fail', findings: [mustFix('needs a fix')] } : undefined),
  });
  const lensPrompts = dispatches.filter((d) => /code-reviewer|codex-consult|product-reviewer|visual-reviewer/.test(d.agentType));
  assert.ok(lensPrompts.length >= 5,
    `expected two task lenses, a re-review and two close reviewers, got ${lensPrompts.length}`);
  for (const d of lensPrompts) {
    assert.match(d.prompt, /SEVERITY IS GATED BY BLAST RADIUS/, `${d.label} must carry the mandate`);
    assert.match(d.prompt, /no live call site/, `${d.label} must say what makes a finding a note`);
  }
});

// --- T21: blocked -> task-answer -> re-run, the SELECTION half (M0 fixture case 6) ------------
// The kernel half — `task-answer` recording {question, answer, at} verbatim, refusing a done task,
// and the blocked task closing on a real receipt afterwards — is
// test/acceptance/m0-fixtures.test.mjs. It stops at the manifest, because the thing that has to
// re-select the answered task lives HERE, in a sandboxed script with no kernel and no module
// surface, and can only be driven the way this file drives it. M0-FIXTURE-LEDGER.md row 6 names
// both halves; neither is the case on its own.

test('a re-run selects ONLY the answered blocked task — done tasks skip, and the answer rides the brief', async () => {
  const Q = "which widget? the 'legacy' one or the new one";
  const A = 'the existing one — do not add a second';
  const { result, builds, dispatches, kernelCmds } = await runLoop([
    row('T1', { status: 'done' }),
    row('T2', { status: 'blocked', answers: [{ question: Q, answer: A, at: '2026-07-25T00:00:00.000Z' }] }),
    row('T3', { status: 'done' }),
  ]);

  // SELECTION. `done` is the only status that skips: the re-run must not decide for itself that a
  // blocked task is finished, and must not re-dispatch work that already carries a receipt.
  assert.deepEqual(builds, ['T2 build'], 'exactly one dispatch — the blocked task, and nothing else');
  assert.deepEqual(result.skipped, ['T1', 'T3'], 'both done tasks skip');
  assert.deepEqual(result.built, ['T2']);
  assert.deepEqual(result.blocked, [], 'the answered task is no longer blocked');
  // And no kernel op touches a done task: `task-start T1` would be refused by the kernel anyway,
  // but a loop that dispatches it has already misread its own plan-of-record.
  assert.ok(!kernelCmds.some((c) => /\bT1\b|\bT3\b/.test(c)),
    `no kernel op may name a done task, got: ${kernelCmds.join(' | ')}`);

  // THE ANSWER RIDES THE BRIEF, VERBATIM. This is the whole difference between a re-run and the
  // first run: without it the builder faces the same undecided question and blocks again, forever.
  const brief = dispatches.find((d) => d.label === 'T2 build').prompt;
  assert.match(brief, /RECORDED ANSWERS — these are settled decisions/,
    'the brief must say the answers are settled, not merely quote them');
  assert.ok(brief.includes(Q), `the question must travel verbatim (quotes included): ${brief}`);
  assert.ok(brief.includes(A), 'and so must the answer');
});

test('a blocked task with NO recorded answer is still re-selected — the loop never adjudicates', async () => {
  // The negative control for the case above, and it pins a real boundary: the loop does not gate
  // the re-run on an answer being present, because "has this been answered?" is the session's
  // judgement (PLAN-V3 decision 11) and a loop that refused to retry would strand the task where
  // no operator could see it. What must NOT happen is the brief claiming settled decisions it does
  // not have.
  const { builds, dispatches } = await runLoop([
    row('T1', { status: 'done' }),
    row('T2', { status: 'blocked' }),
  ]);
  assert.deepEqual(builds, ['T2 build']);
  const brief = dispatches.find((d) => d.label === 'T2 build').prompt;
  assert.doesNotMatch(brief, /RECORDED ANSWERS/,
    'an empty answers[] must produce no answers block at all — not an empty one that reads as settled');
});

// --- T28: MILESTONE INTERLEAVING (S-008) ------------------------------------------------------

test('milestone N closes BEFORE milestone N+1 dispatches anything', async () => {
  // The whole point of the amendment: the old loop built every task of every milestone and left
  // all boundary work to one review stage at the end, so milestone 2 was built on a slice no
  // boundary gate had certified and no reviewer had read.
  const { result, dispatches } = await runLoop([
    row('T1', { milestone: 'M1' }),
    row('T2', { milestone: 'M2', depends_on: ['T1'] }),
  ]);
  assert.deepEqual(flow(dispatches), [
    'T1 build', 'T1 review:code-reviewer', 'T1 review:codex-consult',
    'M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review',
    'T2 build', 'T2 review:code-reviewer', 'T2 review:codex-consult',
    'M2 squash', 'M2 boundary gate', 'M2 milestone review', 'M2 product review',
  ], 'tasks then close, per milestone, in §Gates order — never all tasks then all closes');
  assert.deepEqual(result.milestones.map((m) => [m.id, m.outcome]), [['M1', 'closed'], ['M2', 'closed']]);
  assert.deepEqual(result.built, ['T1', 'T2']);
  // The close records its verdicts at MILESTONE scope, one per required role, per milestone.
  const { kernelCmds } = await runLoop([row('T1', { milestone: 'M1' }), row('T2', { milestone: 'M2' })]);
  for (const m of ['M1', 'M2']) {
    assert.equal(verdictsFor(kernelCmds, 'code-reviewer', `milestone:'${m}'`), 1, `${m} code-reviewer verdict`);
    assert.equal(verdictsFor(kernelCmds, 'product-reviewer', `milestone:'${m}'`), 1, `${m} product verdict`);
  }
});

test('every dispatch of a milestone carries opts.phase = the milestone id (two-level progress)', async () => {
  // S-008's display requirement, and it is not cosmetic: the milestones ARE the phase groups the
  // viewer renders, and the flattened entries under each are its dispatches. A dispatch under a
  // global 'Build'/'Review'/'Record' phase would render under no milestone at all.
  const { dispatches } = await runLoop([
    row('T1', { milestone: 'M1' }),
    row('T2', { milestone: 'M2', depends_on: ['T1'] }),
  ]);
  assert.ok(dispatches.length > 10, 'the case must actually dispatch');
  for (const d of dispatches) {
    const expected = /^T1|^M1/.test(d.label) ? 'M1' : 'M2';
    assert.equal(d.opts.phase, expected, `${d.label} must sit in phase ${expected}, got ${d.opts.phase}`);
  }
  const phases = [...new Set(dispatches.map((d) => d.opts.phase))];
  assert.deepEqual(phases, ['M1', 'M2'], 'the only phases are the milestone ids, in milestone order');
});

test('a milestone whose task did not land does NOT close, and every later milestone defers whole', async () => {
  const { result, dispatches, logs } = await runLoop([
    row('T1', { milestone: 'M1' }),
    row('T2', { milestone: 'M2' }),
    row('T3', { milestone: 'M2' }),
  ], { builderResult: (id) => (id === 'T1' ? { status: 'blocked', question: 'which widget?' } : undefined) });
  assert.deepEqual(flow(dispatches), ['T1 build'],
    'no close for an incomplete milestone, and nothing at all for the milestones behind it');
  assert.deepEqual(result.milestones.map((m) => [m.id, m.outcome]), [['M1', 'not-closed'], ['M2', 'deferred']]);
  assert.deepEqual(result.deferred.map((d) => d.taskId), ['T2', 'T3']);
  assert.ok(result.deferred.every((d) => /milestone M1/.test(d.reason)), 'the reason names the milestone that stalled');
  assert.ok(logs.some((l) => /milestone M2: DEFERRED whole/.test(l)));
});

test('a red boundary gate FAILS the close, stops the loop, and leaves later milestones untouched', async () => {
  const { result, dispatches } = await runLoop([
    row('T1', { milestone: 'M1' }),
    row('T2', { milestone: 'M2' }),
  ], { gateResult: () => ({ exitCode: 2, output: 'boundary gate red' }) });
  assert.deepEqual(flow(dispatches), ['T1 build', 'T1 review:code-reviewer', 'T1 review:codex-consult', 'M1 squash', 'M1 boundary gate'],
    'the close stops at the red gate — no reviewer judges a tree the gate refused');
  assert.deepEqual(result.milestones.map((m) => [m.id, m.outcome]), [['M1', 'close-failed'], ['M2', 'deferred']]);
  assert.equal(result.milestones[0].close.boundaryExit, 2, 'the exit code rides back verbatim');
  assert.match(result.milestones[0].detail, /exited 2/);
  assert.deepEqual(result.built, ['T1'], 'the task itself did land — the close is what failed');
});

test('a squash that MOVED THE TREE fails the close — receipts key to trees', async () => {
  // The one thing that makes a content-preserving squash safe is that task receipts key to the
  // TREE hash. A squash that changes the tree orphans every receipt the milestone earned, so the
  // closer reports the pair and the loop refuses on any difference — and refuses just as firmly
  // when the pair is missing, because "they matched" with nothing to compare is the same claim.
  const moved = await runLoop([row('T1')], {
    squashResult: () => ({ status: 'squashed', treeBefore: 'a'.repeat(40), treeAfter: 'b'.repeat(40) }),
  });
  assert.equal(moved.result.milestones[0].outcome, 'close-failed');
  assert.match(moved.result.milestones[0].detail, /CHANGED THE TREE/);
  assert.deepEqual(flow(moved.dispatches).filter((l) => /boundary gate/.test(l)), [],
    'a squash that changed content never reaches the boundary gate');

  const silent = await runLoop([row('T1')], { squashResult: () => ({ status: 'squashed' }) });
  assert.equal(silent.result.milestones[0].outcome, 'close-failed');
  assert.match(silent.result.milestones[0].detail, /did not report a usable tree pair/);

  const refused = await runLoop([row('T1')], { squashResult: () => ({ status: 'refused', detail: 'boundary unclear' }) });
  assert.equal(refused.result.milestones[0].outcome, 'close-failed');
  assert.match(refused.result.milestones[0].detail, /boundary unclear/);
});

test('the squash prompt carries the two rails that make it safe, and args.squash === false returns a DEVIATION', async () => {
  const on = await runLoop([row('T1')]);
  const squash = on.dispatches.find((d) => d.label === 'M1 squash');
  assert.match(squash.prompt, /ONE conventional commit/, 'the default is one commit per milestone');
  assert.match(squash.prompt, /rev-parse HEAD\^\{tree\}/, 'the tree pair is derived by the closer, from git');
  assert.match(squash.prompt, /may NOT rewrite at or before that/i, 'the rewrite window stops at the previous close');
  assert.match(squash.prompt, /do NOT push/i, 'remote writes belong to finalize alone');
  assert.deepEqual(on.result.squashDeviations, [], 'the default path is not a deviation');

  const off = await runLoop([row('T1')], { args: { squash: false } });
  assert.deepEqual(flow(off.dispatches).filter((l) => /squash/.test(l)), [], 'nothing is dispatched to squash');
  assert.equal(off.result.squashDeviations.length, 1);
  assert.match(off.result.squashDeviations[0].deviation, /squash default was disabled/);
  assert.equal(off.result.squashDeviations[0].milestone, 'M1');
  assert.equal(off.result.squashDeviations[0].reason, null,
    'the loop knows no reason and must not invent one — the session records it in the review artifact');
  assert.equal(off.result.milestones[0].outcome, 'closed', 'skipping the squash does not fail the close');
});

test('a failing close review costs ONE fix round: fix -> RE-GATE -> the SAME role re-judges its own findings', async () => {
  const { result, dispatches, kernelCmds } = await runLoop([row('T1')], {
    lensResult: (type, label) =>
      (label === 'M1 milestone review' ? { verdict: 'fail', findings: [mustFix('seam between T1 and its caller')] } : undefined),
  });
  assert.deepEqual(flow(dispatches).filter((l) => /^M1/.test(l)), [
    'M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review',
    'M1 close fix', 'M1 boundary gate (re)', 'M1 re-review:code-reviewer', 'M1 re-certify:product-reviewer',
  ], 'the boundary receipt is stale after the fix, so the gate re-runs BEFORE anyone re-judges');
  const re = dispatches.find((d) => d.label === 'M1 re-review:code-reviewer');
  assert.match(re.prompt, /seam between T1 and its caller/, 'RR1: the role re-judges its OWN findings, verbatim');
  const fix = dispatches.find((d) => d.label === 'M1 close fix');
  assert.match(fix.prompt, /seam between T1 and its caller/);
  assert.match(fix.prompt, /never by amending or rebasing/, 'the squashed commit was gated and reviewed — fix forward');
  // c11 (the RR1-stall fix): the passing role is re-CERTIFIED over the delta, never re-REVIEWED —
  // its second dispatch carries the narrow re-certification mandate and NOT the failing lens's
  // findings, and its fresh verdict binds the post-fix tree so stage-complete review holds.
  const product = dispatches.filter((d) => d.agentType === 'legion:product-reviewer');
  assert.equal(product.length, 2, 'round 1 plus the re-certification, nothing else');
  assert.equal(product[1].label, 'M1 re-certify:product-reviewer');
  assert.match(product[1].prompt, /RE-CERTIFICATION/);
  assert.doesNotMatch(product[1].prompt, /seam between T1 and its caller/,
    "the re-certify mandate never carries the failing lens's findings");
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "milestone:'M1'"), 2, 'both rounds are recorded');
  assert.equal(verdictsFor(kernelCmds, 'product-reviewer', "milestone:'M1'"), 2, 'the re-certification verdict is durable state');
  assert.equal(result.milestones[0].outcome, 'closed');
  assert.equal(result.milestones[0].close.fixRound, true);
});

test('a close review still failing after its one fix round fails closed', async () => {
  const { result } = await runLoop([row('T1'), row('T2', { milestone: 'M2' })], {
    lensResult: (type, label) =>
      (/^M1 (milestone review|re-review)/.test(label) ? { verdict: 'fail', findings: [mustFix('still wrong')] } : undefined),
  });
  assert.equal(result.milestones[0].outcome, 'close-failed');
  assert.match(result.milestones[0].detail, /still failing/);
  assert.deepEqual(result.milestones.map((m) => m.outcome), ['close-failed', 'deferred']);
  assert.match(result.nextStep, /Fail closed/);
});

test('a close reviewer that vanishes before its re-review is never stood in for, and records nothing', async () => {
  const { result, kernelCmds } = await runLoop([row('T1')], {
    lensResult: (type, label) => {
      if (label === 'M1 milestone review') return { verdict: 'fail', findings: [mustFix('close finding')] };
      if (label === 'M1 re-review:code-reviewer') return { verdict: 'pass', findings: [], available: false };
      return undefined;
    },
  });
  assert.equal(result.milestones[0].outcome, 'close-failed');
  assert.match(result.milestones[0].detail, /never re-judged/);
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "milestone:'M1'"), 1,
    'a verdict for a re-review that did not happen would be forged evidence');
});

// --- T28: RESUME — the run that died between the last task-done and the close -----------------

test('all tasks done but NO close recorded ⇒ the CLOSE ONLY runs', async () => {
  const { result, builds, dispatches } = await runLoop([
    row('T1', { status: 'done' }), row('T2', { status: 'done' }),
  ], { args: { reviews: [rec('code-reviewer', 'pass', 'task:T1')] } });
  assert.deepEqual(builds, [], 'no task is rebuilt');
  assert.deepEqual(flow(dispatches), ['M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review']);
  assert.deepEqual(result.milestones.map((m) => m.outcome), ['closed']);
  assert.deepEqual(result.skipped, ['T1', 'T2']);
});

test('a close whose required verdicts are already recorded PASSING is skipped', async () => {
  const { result, dispatches, logs } = await runLoop([
    row('T1', { status: 'done' }),
  ], {
    args: {
      reviews: [
        rec('code-reviewer', 'pass', 'milestone:M1'),
        rec('product-reviewer', 'pass', 'milestone:M1'),
      ],
    },
  });
  assert.deepEqual(dispatches, [], 'nothing at all is dispatched — not a squash, not a gate, not a reviewer');
  assert.deepEqual(result.milestones.map((m) => m.outcome), ['close-already-recorded']);
  assert.match(result.note, /nothing outstanding/);
  assert.equal(result.reviewsProvided, true);
  assert.ok(logs.some((l) => /nothing outstanding/.test(l)), 'and the run says why it did nothing');
});

test('the LATEST verdict decides, and a recorded FAIL does not count as a close', async () => {
  const { dispatches } = await runLoop([row('T1', { status: 'done' })], {
    args: {
      reviews: [
        rec('code-reviewer', 'pass', 'milestone:M1'),
        rec('product-reviewer', 'pass', 'milestone:M1'),
        rec('code-reviewer', 'fail', 'milestone:M1'), // a later round rejected it
      ],
    },
  });
  assert.deepEqual(flow(dispatches), ['M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review'],
    'the latest code-reviewer verdict is a fail, so the close is owed again');
});

test('on standard, a recorded code-reviewer pass WITHOUT the product review is not a closed milestone', async () => {
  // The subtle half of the resume rule: the profile decides how many verdicts a close owes, and
  // half a close reads as a close unless the required set is checked.
  const standard = await runLoop([row('T1', { status: 'done' })], {
    args: { profile: 'standard', reviews: [rec('code-reviewer', 'pass', 'milestone:M1')] },
  });
  assert.deepEqual(flow(standard.dispatches), ['M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review']);

  // …and on express the product review is not owed, so the same record IS a closed milestone.
  const express = await runLoop([row('T1', { status: 'done' })], {
    args: { profile: 'express', reviews: [rec('code-reviewer', 'pass', 'milestone:M1')] },
  });
  assert.deepEqual(express.dispatches, []);
  assert.deepEqual(express.result.milestones.map((m) => m.outcome), ['close-already-recorded']);
});

// --- VISUAL REVIEW at the close, plan-declared via notes.visual -------------------------------
// The trigger is the APPROVED PLAN, not the profile: any task of the milestone carrying a truthy
// `notes.visual` makes the close owe a third verdict. Everything below mirrors the product/code
// close cases, because the visual role rides the same machinery — dispatch, fail-closed on a
// missing result, one fix round, own-findings re-review, resume parity.

test('a milestone with a notes.visual task dispatches the visual reviewer at its close — and only then', async () => {
  const flagged = await runLoop([
    row('T1', { notes: { visual: ['/dashboard', '/dashboard?empty'] } }),
    row('T2'), // one flagged task flags the whole milestone
  ]);
  assert.deepEqual(flow(flagged.dispatches).filter((l) => /^M1 /.test(l)), [
    'M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review', 'M1 visual review',
  ], 'the visual reviewer joins the close, after the boundary gate like every close reviewer');
  assert.equal(verdictsFor(flagged.kernelCmds, 'visual-reviewer', "milestone:'M1'"), 1, 'its verdict is recorded at milestone scope');
  assert.equal(flagged.result.milestones[0].outcome, 'closed');
  const visual = flagged.dispatches.find((d) => d.label === 'M1 visual review');
  assert.equal(visual.agentType, 'legion:visual-reviewer');
  assert.equal(visual.opts.phase, 'M1', 'the close dispatch sits in its milestone phase group');
  assert.equal(visual.opts.model, 'opus', 'the model default rides every close dispatch');
  assert.match(visual.prompt, /## Visual review/, 'the prompt points at the plan section, which the agent reads itself');
  assert.match(visual.prompt, /\/dossier\/visual\/M1\//, 'screenshots are directed to the dossier, never the worktree');
  assert.match(visual.prompt, /review-visual\.md/);
  assert.match(visual.prompt, /fail closed/i, 'unavailability must be a failing review, never a silent pass');

  const plain = await runLoop([row('T1')]);
  assert.ok(!plain.dispatches.some((d) => d.agentType === 'legion:visual-reviewer'),
    'no flag, no visual dispatch — a review nobody declared is a cost nobody approved');
  assert.equal(verdictsFor(plain.kernelCmds, 'visual-reviewer', "milestone:'M1'"), 0,
    'and no verdict is recorded for a review that did not run — that would be forged evidence');
});

test('a visual reviewer that returns nothing fails closed, costs the fix round, and re-judges its own absence', async () => {
  const { result, dispatches, kernelCmds } = await runLoop([row('T1', { notes: { visual: true } })], {
    lensResult: (type, label) => (label === 'M1 visual review' ? null : undefined),
  });
  assert.deepEqual(flow(dispatches).filter((l) => /^M1 /.test(l)), [
    'M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review', 'M1 visual review',
    'M1 close fix', 'M1 boundary gate (re)', 'M1 re-review:visual-reviewer',
    'M1 re-certify:code-reviewer', 'M1 re-certify:product-reviewer',
  ], 'a missing result is a failing review: fix round, re-gate, the SAME role re-judges, and the passers re-certify');
  assert.equal(verdictsFor(kernelCmds, 'visual-reviewer', "milestone:'M1'"), 2, 'the round-1 fail and the round-2 verdict are both recorded');
  assert.equal(result.milestones[0].outcome, 'closed', 'the harness re-review passes, so the close lands');
});

test('a failing visual review rides the ONE fix round and re-judges its OWN findings verbatim', async () => {
  const { result, dispatches, kernelCmds } = await runLoop([row('T1', { notes: { visual: true } })], {
    lensResult: (type, label) =>
      (label === 'M1 visual review' ? { verdict: 'fail', findings: [mustFix('button overlaps footer at 390px')] } : undefined),
  });
  const re = dispatches.find((d) => d.label === 'M1 re-review:visual-reviewer');
  assert.match(re.prompt, /button overlaps footer at 390px/, 'RR1: the visual role re-judges its OWN findings, verbatim');
  // c11: the passing roles are re-CERTIFIED, never re-REVIEWED — no re-review label, a re-certify
  // label, and the re-certify mandate never carries the visual lens's finding.
  assert.ok(!dispatches.some((d) => d.label === 'M1 re-review:code-reviewer'), 'the roles that passed are not re-reviewed');
  const reCert = dispatches.find((d) => d.label === 'M1 re-certify:code-reviewer');
  assert.ok(reCert, 'the passing role re-earns its certificate over the fix delta');
  assert.doesNotMatch(reCert.prompt, /button overlaps footer at 390px/);
  assert.deepEqual(
    dispatches.filter((d) => d.agentType === 'legion:code-reviewer' && /^M1 /.test(d.label)).map((d) => d.label),
    ['M1 milestone review', 'M1 re-certify:code-reviewer'],
    'at the close: round 1 plus the re-certification, nothing else');
  assert.equal(verdictsFor(kernelCmds, 'visual-reviewer', "milestone:'M1'"), 2, 'both rounds are recorded');
  assert.equal(result.milestones[0].outcome, 'closed');
  assert.equal(result.milestones[0].close.fixRound, true);

  const stillFailing = await runLoop([row('T1', { notes: { visual: true } }), row('T2', { milestone: 'M2' })], {
    lensResult: (type, label) =>
      (/^M1 (visual review|re-review:visual-reviewer)/.test(label)
        ? { verdict: 'fail', findings: [mustFix('still broken')] } : undefined),
  });
  assert.deepEqual(stillFailing.result.milestones.map((m) => m.outcome), ['close-failed', 'deferred'],
    'a visual review still failing after its one round fails the close, and later milestones defer');
});

// --- c11: DELTA RE-CERTIFICATION (the RR1-stall fix) ------------------------------------------
// The stall: the close fix commit moves the tree; every milestone verdict binds the tree at
// record time; stage-complete review re-derives the binding against the CURRENT tree. So a close
// where one role passed round 1 and another failed left the passer's verdict hashing a tree that
// no longer exists — the loop reported `closed`, the kernel refused the stage. The passers now
// re-earn their certificate over the delta; these cases pin the fail-closed halves.

test('a re-certification FAIL fails the close, distinctly — the fix regressed a lens that had passed', async () => {
  const { result, kernelCmds } = await runLoop([row('T1')], {
    lensResult: (type, label) => {
      if (label === 'M1 milestone review') return { verdict: 'fail', findings: [mustFix('seam finding')] };
      if (label === 'M1 re-certify:product-reviewer') return { verdict: 'fail', findings: [mustFix('acceptance A2 regressed')] };
      return undefined;
    },
  });
  assert.equal(result.milestones[0].outcome, 'close-failed');
  assert.match(result.milestones[0].detail, /re-certification returned fail/);
  assert.match(result.milestones[0].detail, /product-reviewer/);
  assert.equal(verdictsFor(kernelCmds, 'product-reviewer', "milestone:'M1'"), 2,
    'the round-1 pass AND the re-certification fail are both durable — the evidence describes the post-fix tree');
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "milestone:'M1'"), 2);
});

test('a re-certification that returns NOTHING records nothing and fails the close', async () => {
  const { result, kernelCmds } = await runLoop([row('T1')], {
    lensResult: (type, label) => {
      if (label === 'M1 milestone review') return { verdict: 'fail', findings: [mustFix('seam finding')] };
      if (label === 'M1 re-certify:product-reviewer') return null;
      return undefined;
    },
  });
  assert.equal(result.milestones[0].outcome, 'close-failed');
  assert.match(result.milestones[0].detail, /never re-earned/);
  assert.equal(verdictsFor(kernelCmds, 'product-reviewer', "milestone:'M1'"), 1,
    'a verdict for a re-certification that did not happen would be forged evidence');
});

test('a close with NO fix round dispatches no re-certification', async () => {
  const { dispatches, result } = await runLoop([row('T1')]);
  assert.ok(!dispatches.some((d) => / re-certify:/.test(d.label)),
    'a clean close leaves every round-1 verdict binding the tree it was recorded on');
  assert.equal(result.milestones[0].outcome, 'closed');
});

test('RESUME parity: a flagged milestone with only code+product recorded passing is NOT closed', async () => {
  const twoOfThree = await runLoop([row('T1', { status: 'done', notes: { visual: true } })], {
    args: { reviews: [rec('code-reviewer', 'pass', 'milestone:M1'), rec('product-reviewer', 'pass', 'milestone:M1')] },
  });
  assert.deepEqual(flow(twoOfThree.dispatches), [
    'M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review', 'M1 visual review',
  ], 'two verdicts recorded when three are owed is an OPEN close — skipping here is the false-"closed" hole');

  const allThree = await runLoop([row('T1', { status: 'done', notes: { visual: true } })], {
    args: {
      reviews: [
        rec('code-reviewer', 'pass', 'milestone:M1'),
        rec('product-reviewer', 'pass', 'milestone:M1'),
        rec('visual-reviewer', 'pass', 'milestone:M1'),
      ],
    },
  });
  assert.deepEqual(allThree.dispatches, [], 'all three recorded passing ⇒ nothing to do');
  assert.deepEqual(allThree.result.milestones.map((m) => m.outcome), ['close-already-recorded']);
});

test('args.reviews ABSENT is treated as nothing recorded, and the return says so', async () => {
  const { result, dispatches } = await runLoop([row('T1', { status: 'done' })]);
  assert.equal(result.reviewsProvided, false, 'the session must be able to see that the loop was told nothing');
  assert.deepEqual(flow(dispatches), ['M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review'],
    'over-closing is safe; skipping a close on absent evidence is not');
});

test('a milestone that built work this run re-closes even when an old close is recorded passing', async () => {
  // The hole the arrived-done half of the rule closes: a recorded close describes the slice as it
  // stood BEFORE this run's commits. Skipping on it would leave the new work with no squash, no
  // boundary gate and no milestone-scope review at all.
  const { result, dispatches } = await runLoop([
    row('T1', { status: 'done' }),
    row('T2'), // new work in the same milestone
  ], {
    args: {
      reviews: [
        rec('code-reviewer', 'pass', 'milestone:M1'),
        rec('product-reviewer', 'pass', 'milestone:M1'),
      ],
    },
  });
  assert.deepEqual(flow(dispatches).filter((l) => /^M1/.test(l)),
    ['M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review']);
  assert.deepEqual(result.milestones.map((m) => m.outcome), ['closed']);
});

test('the product review runs PER MILESTONE, and only on the profiles that require it', async () => {
  const standard = await runLoop([row('T1', { milestone: 'M1' }), row('T2', { milestone: 'M2' })]);
  assert.deepEqual(flow(standard.dispatches).filter((l) => /product review/.test(l)),
    ['M1 product review', 'M2 product review'], 'once per milestone, not once at the end');
  assert.equal(standard.result.profile, 'standard');
  assert.equal(standard.result.profileAssumed, true, 'an absent profile is treated as standard AND reported as assumed');

  const express = await runLoop([row('T1')], { args: { profile: 'express' } });
  assert.deepEqual(flow(express.dispatches).filter((l) => /product review/.test(l)), []);
  assert.equal(express.result.profileAssumed, false);
  assert.equal(express.result.profileCoerced, false, 'a recognised profile is never reported as coerced');

  const full = await runLoop([row('T1')], { args: { profile: 'full' } });
  assert.deepEqual(flow(full.dispatches).filter((l) => /product review/.test(l)), ['M1 product review']);

  // c11 (amended same day, operator ruling): FULL also closes with the codex lens, as an
  // ADVISORY second opinion — dispatched and recorded when it runs, never required, never
  // counted by the resume predicate, degrading on record when the CLI is absent.
  // Label-anchored to 'codex review': the task-scope 'T1 review:codex-consult' dispatch is
  // present on every dual-lens profile and must not satisfy these assertions.
  assert.deepEqual(flow(full.dispatches).filter((l) => /codex review/.test(l)), ['M1 codex review']);
  assert.equal(verdictsFor(full.kernelCmds, 'codex-consult', "milestone:'M1'"), 1,
    'the codex close verdict is durable state at milestone scope');
  const fullCodexPrompt = full.dispatches.find((d) => d.label === 'M1 codex review').prompt;
  assert.match(fullCodexPrompt, /MILESTONE scope/);
  assert.match(fullCodexPrompt, /ADVISORY second lens/, 'the prompt says absence degrades — honesty costs nothing');
  assert.deepEqual(flow(standard.dispatches).filter((l) => /codex review/.test(l)), [],
    'standard closes without the codex lens');
  assert.equal(verdictsFor(standard.kernelCmds, 'codex-consult', "milestone:'M1'"), 0);
  assert.deepEqual(flow(express.dispatches).filter((l) => /codex review/.test(l)), []);

  // The product reviewer grades the SPEC'S ACCEPTANCE ROWS for what this milestone delivers —
  // otherwise it re-reviews the code and the milestone has no product evidence at all.
  const prompt = standard.dispatches.find((d) => d.label === 'M1 product review').prompt;
  assert.match(prompt, /ACCEPTANCE ROWS/);
  assert.match(prompt, /THIS MILESTONE/);
  assert.match(prompt, /Over-delivery is a finding/);
  const milestoneReview = standard.dispatches.find((d) => d.label === 'M1 milestone review').prompt;
  assert.match(milestoneReview, /MILESTONE MODE/, 'the code review is over the assembled diff, not one task');
});

test('codex unavailable at a FULL close DEGRADES on record — the close lands, no verdict, no fix round', async () => {
  // Operator ruling 2026-07-31: the consult is a second lens, never the unique one — its absence
  // is an environmental fact about a machine, and legion must not fail on it at any stage. The
  // close records NO codex verdict (a verdict for a review that did not happen is forged
  // evidence), reports the degradation, and closes on the required lenses.
  const { result, dispatches, kernelCmds, logs } = await runLoop([row('T1')], {
    args: { profile: 'full' },
    lensResult: (type, label) =>
      (label === 'M1 codex review' ? { verdict: 'pass', findings: [], available: false } : undefined),
  });
  assert.equal(result.milestones[0].outcome, 'closed', 'a missing consult lens never fails the close');
  assert.equal(verdictsFor(kernelCmds, 'codex-consult', "milestone:'M1'"), 0,
    'nothing is recorded for a review that did not happen');
  assert.deepEqual(result.milestones[0].close.degraded, ['codex-consult'],
    'the degradation is durable in the close report, for the review artifact and the pre-merge human');
  assert.ok(!dispatches.some((d) => d.label === 'M1 close fix'), 'no fix round on a clean, degraded close');
  assert.ok(logs.some((l) => /DEGRADED close/.test(l)), 'and the run says so');
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "milestone:'M1'"), 1);
  assert.equal(verdictsFor(kernelCmds, 'product-reviewer', "milestone:'M1'"), 1);
});

test('RESUME parity on FULL: code+product recorded passing IS a closed milestone — codex is advisory, never owed', async () => {
  const recorded = await runLoop([row('T1', { status: 'done' })], {
    args: {
      profile: 'full',
      reviews: [rec('code-reviewer', 'pass', 'milestone:M1'), rec('product-reviewer', 'pass', 'milestone:M1')],
    },
  });
  assert.deepEqual(recorded.dispatches, [],
    'the advisory consult lens is not counted by the resume predicate — a degraded close must not re-run forever');
  assert.deepEqual(recorded.result.milestones.map((mm) => mm.outcome), ['close-already-recorded']);

  // …and a fresh full close still dispatches it: advisory means not-required, not not-run.
  const fresh = await runLoop([row('T1', { status: 'done' })], { args: { profile: 'full' } });
  assert.deepEqual(flow(fresh.dispatches), [
    'M1 squash', 'M1 boundary gate', 'M1 milestone review', 'M1 product review', 'M1 codex review',
  ]);
});

test('FULL plus notes.visual composes THREE required close roles plus the advisory codex lens', async () => {
  const { result, dispatches, kernelCmds } = await runLoop(
    [row('T1', { notes: { visual: true } })], { args: { profile: 'full' } },
  );
  assert.deepEqual(flow(dispatches).filter((l) => /^M1 (milestone|product|codex|visual) review$/.test(l)), [
    'M1 milestone review', 'M1 product review', 'M1 visual review', 'M1 codex review',
  ], 'required roles first (the resume mirror), the advisory lens appended after');
  assert.equal(result.milestones[0].outcome, 'closed');
  for (const role of ['code-reviewer', 'product-reviewer', 'codex-consult', 'visual-reviewer']) {
    assert.equal(verdictsFor(kernelCmds, role, "milestone:'M1'"), 1,
      `${role} verdict recorded — the advisory lens IS recorded when it actually ran`);
  }
});

test('codex vanishing at RE-CERTIFICATION degrades — the close still lands on the required lenses', async () => {
  // Full profile; the code review fails round 1 (fix round), codex passed round 1 and then the
  // CLI vanished before re-certifying. Its stale round-1 pass is counted by nothing, so the
  // degradation costs a report note — never the close.
  const { result, kernelCmds } = await runLoop([row('T1')], {
    args: { profile: 'full' },
    lensResult: (type, label) => {
      if (label === 'M1 milestone review') return { verdict: 'fail', findings: [mustFix('seam finding')] };
      if (label === 'M1 re-certify:codex-consult') return { verdict: 'pass', findings: [], available: false };
      return undefined;
    },
  });
  assert.equal(result.milestones[0].outcome, 'closed');
  assert.deepEqual(result.milestones[0].close.degraded, ['codex-consult']);
  assert.equal(verdictsFor(kernelCmds, 'codex-consult', "milestone:'M1'"), 1,
    'the round-1 pass stands; nothing is recorded for the re-certification that did not happen');
  assert.equal(verdictsFor(kernelCmds, 'product-reviewer', "milestone:'M1'"), 2,
    'the required passer still re-earns its certificate');
});

test('an unrecognised args.profile is coerced to STANDARD, loudly — a typo never buys the cheap close', async () => {
  // 'Standard' used to sail through PROFILE_GIVEN and land outside the product-review whitelist,
  // so a capitalisation typo silently bought the express-shaped close nobody granted. Fail-closed
  // came only at stage-complete review, after the whole build.
  const { result, dispatches, logs } = await runLoop([row('T1')], { args: { profile: 'Standard' } });
  assert.deepEqual(flow(dispatches).filter((l) => /product review/.test(l)), ['M1 product review'],
    'the coerced profile owes the product review, exactly as standard does');
  assert.equal(result.profile, 'standard');
  assert.equal(result.profileCoerced, true, 'the coercion is reported, distinctly from assumption');
  assert.equal(result.profileAssumed, false, 'a present-but-unrecognised profile is not "absent"');
  assert.ok(logs.some((l) => /COERCED/.test(l) && /Standard/.test(l)), 'and the log names the bad value');
});

test('a FORWARD cross-milestone dependency is refused up front — no dispatch, no deadlock, no reorder', async () => {
  await assert.rejects(
    () => runLoop([
      row('T1', { milestone: 'M1', depends_on: ['T2'] }),
      row('T2', { milestone: 'M2' }),
    ]),
    (err) => {
      assert.match(err.message, /refuses to run/);
      assert.match(err.message, /T1 \(milestone M1\) depends on T2 \(milestone M2\)/,
        'the refusal must name both tasks and both milestones — the architect has to fix one of them');
      return true;
    },
  );
  // A dependency that is ALREADY DONE describes no impossibility: nothing has to run out of order.
  const { result } = await runLoop([
    row('T1', { milestone: 'M1', depends_on: ['T2'] }),
    row('T2', { milestone: 'M2', status: 'done' }),
  ]);
  assert.deepEqual(result.built, ['T1']);
});

test('a task with no usable milestone is refused up front — the milestone is what the loop iterates', async () => {
  await assert.rejects(
    () => runLoop([{ id: 'T1', title: 't', status: 'pending', attempt: 0, depends_on: [] }]),
    /carry no usable milestone id/,
  );
  await assert.rejects(
    () => runLoop([row('T1', { milestone: '../escape' })]),
    /carry no usable milestone id/,
  );
});

// --- T28: PER-TASK RISK TIERS (S-010) ---------------------------------------------------------

test("notes.risk 'low' reviews with ONE lens: codex is never dispatched, one verdict, singleLens not degraded", async () => {
  const { result, dispatches, kernelCmds, logs } = await runLoop([
    row('T1', { notes: { risk: 'low', mirror: 'src/x.mjs:1' } }),
  ]);
  assert.deepEqual(dispatches.filter((d) => d.agentType === 'legion:codex-consult'), [],
    'a low-risk task does not pay for a second lens');
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "task:'T1'"), 1);
  assert.equal(verdictsFor(kernelCmds, 'codex-consult', "task:'T1'"), 0,
    'a verdict for a lens that was never dispatched would be forged evidence');
  assert.deepEqual(result.singleLens, [{ taskId: 'T1', tier: 'low' }]);
  assert.deepEqual(result.degraded, [],
    'by design is NOT degradation — the pre-merge human must be able to tell them apart');
  assert.deepEqual(result.built, ['T1']);
  assert.ok(logs.some((l) => /single-lens review BY DESIGN/.test(l)));
  // The tier buys review cheapness, never gate cheapness.
  assert.ok(kernelCmds.includes("gate verify-receipt --task 'T1'"));
  assert.ok(kernelCmds.includes("state task-done 'T1'"));
  // The advisory notes still ride the brief in full — a tier must not swallow the mirror.
  assert.match(dispatches.find((d) => d.label === 'T1 build').prompt, /mirror: src\/x\.mjs:1/);
});

test("notes.risk 'trivial' is a DIFF SCAN at low effort, and its fix round keeps the same shape", async () => {
  const { result, dispatches } = await runLoop([row('T1', { notes: { risk: 'trivial' } })], {
    lensResult: (type, label) =>
      (label === 'T1 review:code-reviewer' ? { verdict: 'fail', findings: [mustFix('renamed the wrong symbol')] } : undefined),
  });
  const review = dispatches.find((d) => d.label === 'T1 review:code-reviewer');
  assert.match(review.prompt, /DIFF SCAN, not an adversarial review/);
  assert.match(review.prompt, /NOTHING ELSE/, 'the scan is: does the diff do what the task says, and nothing more');
  assert.equal(review.opts.effort, 'low', 'a diff scan does not need a deep-thinking budget');
  const re = dispatches.find((d) => d.label === 'T1 re-review:code-reviewer');
  assert.ok(re, 'the one fix round is unchanged for whichever lens ran');
  assert.equal(re.opts.effort, 'low');
  assert.match(re.prompt, /renamed the wrong symbol/, 'RR1 still binds: its own finding, verbatim');
  assert.deepEqual(result.singleLens, [{ taskId: 'T1', tier: 'trivial' }]);
  assert.deepEqual(result.built, ['T1']);
});

// --- THE FULL PROFILE OWNS THE TASK REVIEW ----------------------------------------------------
// On `full` the plan's risk tier is ignored and the Claude lens splits into one dispatch per
// DIMENSION. Both facts live in control flow and in dispatch text, so both are only observable
// from here. The dangerous half is the verdict arithmetic: three lenses sharing the `code-reviewer`
// role write into an append-only reviews array whose readers take the LATEST row, so anything
// short of an AND-fold recorded ONCE lets a passing dimension mask a failing one.

const FULL = { args: { profile: 'full' } };
/** The dimension keys, in dispatch order — the labels the split is supposed to produce. */
const DIMS = ['correctness', 'tests', 'design'];
const claudeLenses = (dispatches) =>
  dispatches.filter((d) => d.agentType === 'legion:code-reviewer' && / review:/.test(d.label)).map((d) => d.label);

test('FULL splits the Claude lens by dimension and IGNORES the plan risk tier', async () => {
  const { result, dispatches, logs } = await runLoop([row('T1', { notes: { risk: 'low', mirror: 'src/x.mjs:1' } })], FULL);
  assert.deepEqual(claudeLenses(dispatches), DIMS.map((k) => `T1 review:code-reviewer[${k}]`));
  assert.deepEqual(dispatches.filter((d) => d.agentType === 'legion:codex-consult').map((d) => d.label),
    ['T1 review:codex-consult', 'M1 codex review'],
    'the codex lenses still run on full — the dimensions are an addition, not a replacement');
  assert.deepEqual(result.singleLens, [],
    "a tier the profile ignored did not buy a single lens, so it is not a by-design single-lens task");
  assert.deepEqual(result.tiersIgnored, [{ taskId: 'T1', tier: 'low' }],
    'the pre-merge human must see that the plan asked for cheapness and the profile declined');
  assert.deepEqual(result.degraded, [], 'nothing degraded — four lenses ran');
  assert.deepEqual(result.built, ['T1']);
  assert.ok(logs.some((l) => /risk tier 'low' IGNORED/.test(l)));
  // The tier bought nothing anywhere else either: same gate, same receipt, same notes in the brief.
  assert.match(dispatches.find((d) => d.label === 'T1 build').prompt, /mirror: src\/x\.mjs:1/);
});

test("FULL ignores 'trivial' too: no diff-scan mandate and no low-effort budget survives it", async () => {
  const { result, dispatches } = await runLoop([row('T1', { notes: { risk: 'trivial' } })], FULL);
  const lenses = dispatches.filter((d) => d.agentType === 'legion:code-reviewer' && / review:/.test(d.label));
  assert.equal(lenses.length, 3);
  for (const l of lenses) {
    assert.doesNotMatch(l.prompt, /DIFF SCAN/, `${l.label} must be an adversarial review, not a scan`);
    assert.equal(l.opts.effort, undefined, `${l.label} keeps the agent's own high effort`);
  }
  assert.deepEqual(result.tiersIgnored, [{ taskId: 'T1', tier: 'trivial' }]);
});

test('each dimension prompt names ITS OWN mandate and disclaims the others', async () => {
  // Three copies of one prompt would differ only by sampling noise. The narrowing IS the lens, so
  // the mandates must be pairwise distinct and each must say an out-of-dimension observation is
  // dropped — a lens hedging into its siblings' territory rebuilds the unfocused review three times.
  const { dispatches } = await runLoop([row('T1')], FULL);
  const prompts = new Map(DIMS.map((k) => [k, dispatches.find((d) => d.label === `T1 review:code-reviewer[${k}]`).prompt]));
  assert.equal(new Set(prompts.values()).size, 3, 'the three prompts must not be the same prompt');
  for (const [key, prompt] of prompts) {
    assert.match(prompt, new RegExp(`your dimension is '${key}'`), `${key} is told which lens it is`);
    assert.match(prompt, /DROP it, do not report it/, `${key} drops out-of-dimension findings`);
    assert.match(prompt, /blast radius/i, 'RR3 still binds every lens on every profile');
  }
  assert.match(prompts.get('correctness'), /authz bypass/);
  assert.match(prompts.get('tests'), /tautological/);
  assert.match(prompts.get('design'), /smell baseline/);
});

test('THREE dimension lenses record exactly ONE code-reviewer verdict — a pass must not mask a fail', async () => {
  // reviews is append-only and its readers take the LATEST row for a role+subject, so three rows
  // under one role would let 'design' passing overwrite 'correctness' failing. One fold, one row.
  const { kernelCmds } = await runLoop([row('T1')], FULL);
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "task:'T1'"), 1,
    'one verdict for the Claude side, however many lenses produced it');
  assert.equal(verdictsFor(kernelCmds, 'codex-consult', "task:'T1'"), 1);
});

test('ONE failing dimension fails the task, and ONLY that dimension re-reviews its own findings', async () => {
  const { result, dispatches, kernelCmds } = await runLoop([row('T1')], {
    ...FULL,
    lensResult: (type, label) =>
      (label === 'T1 review:code-reviewer[tests]'
        ? { verdict: 'fail', findings: [mustFix('the reproducer passes on the unfixed code')] }
        : undefined),
  });
  assert.deepEqual(reReviews(dispatches).map((d) => d.label), ['T1 re-review:code-reviewer[tests]'],
    'a dimension that passed has nothing to confirm and is not re-dispatched');
  assert.match(reReviews(dispatches)[0].prompt, /the reproducer passes on the unfixed code/,
    "RR1 binds per dimension: the re-review carries that lens's OWN findings verbatim");
  assert.deepEqual(result.built, ['T1'], 'the fix cleared the one dimension that rejected it');
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "task:'T1'"), 2,
    'round 1 and the re-review round, one folded row each');
});

test('a passing dimension re-review NEVER clears a still-failing one', async () => {
  // The AND-fold guard. With a single `primaryVerdict = reVerdict` assignment the last dimension to
  // re-review decides the task, and 'design' passing would ship a task 'correctness' still rejects.
  const { result, dispatches } = await runLoop([row('T1')], {
    ...FULL,
    lensResult: (type, label) => {
      if (label === 'T1 review:code-reviewer[correctness]') return { verdict: 'fail', findings: [mustFix('authz bypass on the admin path')] };
      if (label === 'T1 review:code-reviewer[design]') return { verdict: 'fail', findings: [mustFix('god screen')] };
      if (label === 'T1 re-review:code-reviewer[design]') return { verdict: 'pass', findings: [] };
      if (label === 'T1 re-review:code-reviewer[correctness]') return { verdict: 'fail', findings: [mustFix('authz bypass on the admin path')] };
      return undefined;
    },
  });
  assert.deepEqual(reReviews(dispatches).map((d) => d.label).sort(),
    ['T1 re-review:code-reviewer[correctness]', 'T1 re-review:code-reviewer[design]']);
  assert.deepEqual(result.built, [], 'one unresolved dimension is enough to fail the task');
  assert.deepEqual(result.failed[0].findings.map((f) => f.title), ['authz bypass on the admin path']);
});

test('a dimension that vanishes mid-round is unconfirmed BY NAME, and fails the task closed', async () => {
  // `unconfirmedBy` tells the session which lens never re-judged its own rejection. On full that
  // has to name the dimension: "code-reviewer" alone cannot say which third of the review is missing.
  const { result, kernelCmds } = await runLoop([row('T1')], {
    ...FULL,
    lensResult: (type, label) => {
      if (label === 'T1 review:code-reviewer[correctness]') return { verdict: 'fail', findings: [mustFix('data-loss path')] };
      if (label === 'T1 re-review:code-reviewer[correctness]') return null;
      return undefined;
    },
  });
  assert.deepEqual(result.failed[0].unconfirmedBy, ['code-reviewer[correctness]']);
  assert.deepEqual(result.degraded, ['T1'], 'the review this task got is not the review it was owed');
  assert.deepEqual(result.built, []);
  assert.equal(verdictsFor(kernelCmds, 'code-reviewer', "task:'T1'"), 1,
    'round 1 only — a verdict for a re-review that never happened would be forged evidence');
});

test('codex absent on FULL still leaves three Claude lenses, and still degrades on record', async () => {
  // The reason the split exists: on a machine with no codex CLI, `full` must still buy more review
  // than `standard` does. Three lenses ran; the missing fourth is reported, not papered over.
  const { result, dispatches } = await runLoop([row('T1', { notes: { risk: 'low' } })], {
    ...FULL,
    lensResult: (type) => (type === 'legion:codex-consult' ? { verdict: 'pass', findings: [], available: false } : undefined),
  });
  assert.deepEqual(claudeLenses(dispatches), DIMS.map((k) => `T1 review:code-reviewer[${k}]`));
  assert.deepEqual(result.degraded, ['T1']);
  assert.deepEqual(result.tiersIgnored, [{ taskId: 'T1', tier: 'low' }]);
  assert.deepEqual(result.built, ['T1']);
});

test('STANDARD is untouched: one whole-checklist lens, tiers honoured, nothing ignored', async () => {
  const { result, dispatches } = await runLoop([row('T1', { notes: { risk: 'low' } })], { args: { profile: 'standard' } });
  assert.deepEqual(claudeLenses(dispatches), ['T1 review:code-reviewer'],
    'no dimension suffix, no split — the label the other profiles have always produced');
  assert.deepEqual(result.singleLens, [{ taskId: 'T1', tier: 'low' }]);
  assert.deepEqual(result.tiersIgnored, [], 'tiersIgnored is [] not absent on every other profile');
  const untiered = await runLoop([row('T1')], { args: { profile: 'standard' } });
  assert.deepEqual(claudeLenses(untiered.dispatches), ['T1 review:code-reviewer']);
  assert.deepEqual(untiered.result.tiersIgnored, []);
});

test('an absent, unknown or malformed risk tier falls through to the DUAL-lens path', async () => {
  // The default must be the expensive one: a typo ('lo', 'Low', 'trivial ') or a tier someone
  // invented must not silently buy cheapness the architect never granted.
  for (const notes of [undefined, { risk: 'Low' }, { risk: 'medium' }, { risk: true }, 'risk: low', ['low']]) {
    const { result, dispatches } = await runLoop([row('T1', notes === undefined ? {} : { notes })]);
    const lenses = dispatches.filter((d) => / review:(code-reviewer|codex-consult)$/.test(d.label)).map((d) => d.label);
    assert.deepEqual(lenses, ['T1 review:code-reviewer', 'T1 review:codex-consult'],
      `notes ${JSON.stringify(notes)} must not tier the review`);
    assert.deepEqual(result.singleLens, []);
  }
});

// --- T28: OPUS BY DEFAULT (S-009) -------------------------------------------------------------

test('builder, closer and reviewer dispatches default to opus; kernel-op inherits; args.model overrides', async () => {
  const { dispatches } = await runLoop([row('T1')], {
    lensResult: (type, label) =>
      (label === 'T1 review:code-reviewer' ? { verdict: 'fail', findings: [mustFix('one round')] } : undefined),
  });
  assert.ok(dispatches.length > 8);
  for (const d of dispatches) {
    if (d.agentType === 'legion:kernel-op') {
      assert.equal('model' in d.opts, false,
        `${d.label}: kernel-op must stay model-inherit — a one-command agent needs no opus`);
    } else {
      assert.equal(d.opts.model, 'opus', `${d.label} must default to opus`);
    }
  }
  // Every non-kernel role is represented above, or the loop would be vacuous.
  assert.deepEqual([...new Set(dispatches.filter((d) => d.opts.model).map((d) => d.agentType))].sort(),
    ['legion:builder', 'legion:code-reviewer', 'legion:codex-consult', 'legion:product-reviewer']);

  const override = await runLoop([row('T1')], { args: { model: 'sonnet' } });
  for (const d of override.dispatches) {
    if (d.agentType === 'legion:kernel-op') assert.equal('model' in d.opts, false);
    else assert.equal(d.opts.model, 'sonnet', `${d.label}: args.model must pass through verbatim`);
  }
});

// --- T31: GATE-FAILURE → IN-LOOP RECOVERY, the LOOP half (PLAN-V3 M1a fixture case 2) ---------
// The kernel half — a red gate mints nothing, the fixup commit re-gates green, and the receipt
// keys to the POST-FIX tree — is test/acceptance/m1a-fixtures.test.mjs (M1a-2a/M1a-2b). What only
// this harness can prove is the loop's own behaviour around that refusal, and it is entirely
// control flow: WHERE a receipt-less task lands, that it is never reviewed or closed on the
// builder's say-so, and that the re-run picks up exactly it. `legion gate verify-receipt` is the
// loop's ONE defence against a builder that reports `receipt: true` without having earned one
// (workflows/build-loop.js reads the kernel's exit code and never the self-report), so a loop that
// carried on past a non-zero exit would spend two review lenses and a `task-done` on an
// uncertified tree. Accounted for in test/acceptance/M1A-FIXTURE-LEDGER.md, case 2.

/** Refuse `gate verify-receipt --task <id>` for exactly one task; everything else exits 0. The
 * argv text is what the loop composed (`sq()`-quoted), which is also what the assertion below
 * reads back — matching the quoted form is deliberate, so a change in quoting cannot silently make
 * this hook stop matching and turn the case green for the wrong reason. */
const receiptRefusedFor = (id) => (argvText) => (
  argvText === `gate verify-receipt --task '${id}'`
    ? { exitCode: 1, output: `no valid receipt for task ${id} (tree moved) — run \`legion gate run --task ${id}\`` }
    : undefined
);

test('a task whose verify-receipt REFUSES lands in failed at stage gate-receipt — never reviewed, never done', async () => {
  const { result, kernelCmds, dispatches, logs } = await runLoop(
    [row('T1'), row('T2')],
    {
      kernelResult: receiptRefusedFor('T1'),
      // The builder claims it gated. The claim is the hazard: it must change nothing.
      builderResult: (id) => (id === 'T1'
        ? { status: 'built', commit: 'c'.repeat(40), receipt: true, summary: 's', files: [] }
        : undefined),
    },
  );

  assert.deepEqual(result.failed.map((f) => ({ taskId: f.taskId, stage: f.stage })), [{ taskId: 'T1', stage: 'gate-receipt' }],
    'the failure must be attributed to the RECEIPT, not to the build or the review — the stage is what the session reads');
  assert.equal(result.failed[0].builderClaimedReceipt, true,
    'and the builder\'s self-report must be RECORDED as the claim it was, so the operator can see it was disbelieved');
  assert.equal(result.built.indexOf('T1'), -1, 'a task with no valid receipt was not built as far as this loop is concerned');

  // NOTHING WAS SPENT ON IT, and nothing was recorded for it. Both halves matter: reviewing an
  // uncertified tree wastes two lenses on evidence the kernel already refused, and `task-done`
  // would be the loop asking the kernel to close a task it has just been told it cannot.
  assert.deepEqual(dispatches.filter((d) => /^T1 review/.test(d.label)).map((d) => d.label), [],
    'no review lens may be dispatched for a task whose receipt the kernel refused');
  assert.equal(kernelCmds.some((c) => /state task-done 'T1'/.test(c)), false,
    'and task-done must never be attempted — the loop does not ask twice for what it was just refused');
  assert.equal(kernelCmds.some((c) => /review-record.*'T1'/.test(c)), false,
    'nor may any verdict be recorded against it');
  assert.ok(logs.some((l) => /T1: NO VALID GATE RECEIPT/.test(l) && /self-report is not evidence/.test(l)),
    'the log must say the receipt was missing AND that the builder claimed otherwise');

  // The independent task still lands — a receipt failure fails ONE task, not the run — but the
  // milestone does not close over a slice one of whose tasks never landed.
  assert.deepEqual(result.built, ['T2'], 'an unrelated task must still build');
  assert.deepEqual(result.milestones.map((m) => [m.id, m.outcome]), [['M1', 'not-closed']],
    'a milestone missing a task is NOT closed — no squash, no boundary gate, no milestone review over unlanded ground');
});

test('the re-run retries EXACTLY the task the receipt check failed — done tasks skip, and it reaches task-done', async () => {
  // The state the failed run above leaves in tasks.json: T1 `started` (task-start succeeded before
  // the gate check) and never done; T2 done. This is the re-run over that file, with the receipt
  // now earned — the fixup-commit recovery the kernel half proves, seen from the loop.
  const { result, builds, kernelCmds } = await runLoop([
    row('T1', { status: 'started' }),
    row('T2', { status: 'done' }),
  ]);

  assert.deepEqual(builds, ['T1 build'], 'exactly one dispatch — the task that failed, and nothing else');
  assert.deepEqual(result.skipped, ['T2'], 'the done task skips; nothing re-builds work the kernel already accepted');
  assert.deepEqual(result.built, ['T1']);
  assert.deepEqual(result.failed, []);
  assert.ok(kernelCmds.includes("state task-done 'T1'"),
    'and this time the loop reaches task-done — the recovery is a real forward path, not a permanently poisoned task');
  assert.equal(kernelCmds.some((c) => /\bT2\b/.test(c)), false, 'no kernel op may name the done task');
  assert.deepEqual(result.milestones.map((m) => m.outcome), ['closed'],
    'and the milestone closes once every task has genuinely landed');
});

// --- Design concerns and designSignals (the decision grammar's build-side half) ---------------
// A builder contesting a plan premise returns blocked with kind:"design" plus structured halves,
// and reviewer findings may carry a `category` slug whose recurrence across tasks aggregates
// into `designSignals`. Both are DATA the session routes through the plan stage; the loop must
// carry them without gaining a dispatch or a control-flow branch. What is pinned here is the
// passthrough shape (the session consumes it verbatim), the historical shape of an ordinary
// question (exact deepEquals elsewhere in this file double as the no-leak guard), and the
// aggregation rules: blocking findings only, >= 2 DISTINCT tasks, deterministic order.

test('a design-blocked builder rides its structured concern through blocked[] untouched', async () => {
  const { result, builds, dispatches } = await runLoop([row('T1')], {
    builderResult: () => ({
      status: 'blocked', kind: 'design', question: 'one @source on the package instead?',
      premise: 'scanning the package costs +155% CSS', evidence: 'measured for the portals problem, not this one',
      alternative: 'one @source directive on the package',
    }),
  });
  assert.deepEqual(builds, ['T1 build'], 'the concern costs no fix round and no review');
  assert.deepEqual(result.blocked, [{
    taskId: 'T1', milestone: 'M1', question: 'one @source on the package instead?',
    kind: 'design', premise: 'scanning the package costs +155% CSS',
    evidence: 'measured for the portals problem, not this one',
    alternative: 'one @source directive on the package',
  }], 'the structured halves reach the session verbatim — they are what the plan stage consumes');
  assert.equal(dispatches.some((d) => /review/.test(d.label)), false,
    'nothing downstream of a blocked task may be dispatched');
  assert.match(result.nextStep, /kind:"design"[\s\S]*never through task-answer/,
    'the return must route the session to the plan stage, not to task-answer');
});

test('a design concern raised on the FIX round rides through the same shape', async () => {
  let calls = 0;
  const { result } = await runLoop([row('T1')], {
    builderResult: () => (++calls === 1
      ? undefined // round 1 builds clean; the lens below forces the fix round
      : { status: 'blocked', kind: 'design', question: 'q2', premise: 'p2', evidence: 'e2', alternative: 'a2' }),
    lensResult: (type, label) =>
      (label === 'T1 review:code-reviewer' ? { verdict: 'fail', findings: [mustFix('claude finding')] } : undefined),
  });
  assert.deepEqual(result.blocked, [{
    taskId: 'T1', milestone: 'M1', question: 'q2', kind: 'design', premise: 'p2', evidence: 'e2', alternative: 'a2',
  }], 'the fix-round path uses the same entry builder — a concern discovered mid-fix is not second-class');
});

test('designSignals: a category in BLOCKING findings on two DISTINCT tasks — and only then', async () => {
  // T1 and T2 each draw the same category on a must-fix; T3 draws it on a note only. The re-review
  // clears each finding so both tasks complete — a locally-fixed recurrence is EXACTLY the signal
  // (the cv-mf shape: every round fixed the symptom and the wrong premise survived).
  const cat = (title, category, tier = 'must-fix') => ({ tier, title, where: 'src/x.mjs:1', issue: 'i', fix: 'f', category });
  const { result } = await runLoop([row('T1'), row('T2'), row('T3')], {
    lensResult: (type, label) => {
      if (label === 'T1 review:code-reviewer') return { verdict: 'fail', findings: [cat('f1', 'hand-transcription')] };
      if (label === 'T2 review:code-reviewer') return { verdict: 'fail', findings: [cat('f2', 'hand-transcription')] };
      if (label === 'T3 review:code-reviewer') return { verdict: 'pass', findings: [cat('f3', 'hand-transcription', 'note')] };
      return undefined; // re-reviews pass; codex passes; the close passes
    },
  });
  assert.deepEqual(result.built, ['T1', 'T2', 'T3'], 'every finding was cleared — the tasks all land');
  assert.deepEqual(result.designSignals, [{ category: 'hand-transcription', tasks: ['T1', 'T2'] }],
    'two distinct tasks with the category in a BLOCKING finding — the note on T3 never counts');
  assert.match(result.nextStep, /designSignals is non-empty[\s\S]*design route/,
    'an all-green run with a recurring class still routes through the plan stage first');
});

test('a FAILED run still surfaces designSignals in nextStep — the likelier carrier, not the green path', async () => {
  // Codex F2 on this chunk: confirmed blocking findings are what accumulate categories, so
  // failed + signals is the LIKELY combination — and the fail-closed message alone says "re-run
  // after the fix", a local retry under the very premise the signal contests.
  const cat = (title) => ({ tier: 'must-fix', title, where: 'src/x.mjs:1', issue: 'i', fix: 'f', category: 'hand-transcription' });
  const { result } = await runLoop([row('T1'), row('T2')], {
    lensResult: (type, label) => {
      if (label === 'T1 review:code-reviewer') return { verdict: 'fail', findings: [cat('f1')] };
      if (label === 'T2 review:code-reviewer') return { verdict: 'fail', findings: [cat('f2')] };
      if (/ re-review:code-reviewer$/.test(label)) return { verdict: 'fail', findings: [cat('still there')] };
      return undefined;
    },
  });
  assert.deepEqual(result.built, [], 'both tasks fail closed — the re-review confirmed the findings');
  assert.deepEqual(result.designSignals, [{ category: 'hand-transcription', tasks: ['T1', 'T2'] }]);
  assert.match(result.nextStep, /Fail closed/, 'the fail-closed message leads');
  assert.match(result.nextStep, /designSignals is non-empty[\s\S]*design route/,
    'and the design-route instruction must not be swallowed by the failure branch');
});

test('designSignals stays empty on single-task recurrence, and is [] not absent on every path', async () => {
  const cat = { tier: 'must-fix', title: 'f', where: 'src/x.mjs:1', issue: 'i', fix: 'f', category: 'lone-class' };
  const twice = await runLoop([row('T1'), row('T2')], {
    lensResult: (type, label) =>
      (label === 'T1 review:code-reviewer' ? { verdict: 'fail', findings: [cat] } : undefined),
  });
  assert.deepEqual(twice.result.designSignals, [],
    'one task, even counted at round 1 and after the fix round, is not recurrence');
  assert.doesNotMatch(twice.result.nextStep, /designSignals/, 'no signal, no design-route instruction');
  // The nothing-outstanding early return carries the field too — a session must never read
  // `undefined` where the contract says list.
  const done = await runLoop(
    [row('T1', { status: 'done' })],
    { args: { reviews: [rec('code-reviewer', 'pass', 'milestone:M1'), rec('product-reviewer', 'pass', 'milestone:M1')] } },
  );
  assert.deepEqual(done.result.designSignals, [], 'the early return carries the empty list');
});
