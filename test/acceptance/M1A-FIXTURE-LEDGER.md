# M1a fixture-track ledger (T31)

Accounts for PLAN-V3 §Milestones **M1a**'s fixture track — *"plan rejection → revision →
re-review; gate-failure → in-loop recovery; approval invalidation cascade on spec edit"* — the same
way `M0-FIXTURE-LEDGER.md` accounts for M0's. For every case: either the test that already proves
it (with the decisive assertion quoted) or the test T31 added, plus the mutation record for every
added row and the honest split between what is **kernel-hermetic** and what is **prose-borne**.

`M0-FIXTURE-LEDGER.md` is **byte-untouched** by this chunk; where an M0 row already carries a claim
this track would otherwise re-prove, it is CITED here and not duplicated.

**The bar every "covered-by" row meets** — identical to M0's, verbatim in force. A row is only
claimed as covered when the cited test is ADVERSARIAL: it drives the real `bin/legion.mjs` into a
state where refusal is the correct answer, asserts the refusal AND what the refusal names, and
asserts that no state moved (`h.assertUnmoved()` compares manifest bytes). A test that walks the
happy path and asserts success is never accepted as coverage of a refusal. Every row marked *added
by T31* was **mutation-checked**: the guard under test deleted or narrowed, the case confirmed to
FAIL, the guard restored. The full record — twelve mutants, twelve killed, none surviving — is at
the bottom, together with the scoping rule that record had to be corrected on.

**How to keep this file honest.** No aspirational rows. If a cited test is deleted, weakened or
renamed, this file is wrong and whoever reads it is reading a lie. Cite file + test name; quote the
assertion that carries the claim, not the setup. A case blocked by a product defect says NOT
COVERED and names the defect — an honest hole outranks a false row.

**No product code was changed by T31.** The chunk adds one acceptance file, two workflow tests, one
optional hook on an existing test harness, and this ledger.

---

## Ledger

| # | Case (PLAN-V3 M1a, adversarial form) | Status |
|---|---|---|
| 1 | plan rejection → revision → re-review | **added by T31** (kernel half); warm half PROSE-BORNE |
| 2 | gate failure → in-loop recovery | **added by T31**, in two halves (kernel + loop); the red-gate refusal itself CITED from M0 row 2 |
| 3 | approval invalidation cascade on spec edit, the DEPENDENT half | **added by T31**; the spec's own half CITED from M0 row 4 |

---

## 1. Plan rejection → revision → re-review — ADDED BY T31 (kernel half)

**Split.** The kernel half is hermetic and is added below. The **warm half** — that the re-review
is performed by *the same critic that rejected the plan, its own findings as the checklist* — is
**PROSE-BORNE and is not tested here, because no test can honestly assert it at this layer.**
See "The prose-borne half" at the end of this section.

### 1(a) A recorded critic FAIL blocks the stage while everything else is valid

`test/acceptance/m1a-fixtures.test.mjs` ·
**``M1a-1a a recorded plan-critic FAIL blocks `stage-complete plan` while the plan approval is still hash-valid``**

Round one completes the stage on a genuine pass; the critic then rejects the plan on a second read
and **nothing else moves** — the case asserts that first, so the refusal cannot be about anything
but the verdict:

```
assert.ok(h.readTasks().approvals.plan,
  'control: the plan APPROVAL must still be recorded — the rejection is the only thing that changed');
assert.equal(h.legion('state', 'decision-record', 'plan').code, 0,
  'control: and it must still be re-recordable, i.e. the plan subject itself is intact');
```

then the refusal:

```
assert.equal(r.code, 1, 'a rejected plan must not complete its stage, whatever else is valid');
assert.match(r.stderr, /LATEST plan-critic/, …);
assert.match(r.stderr, /an older pass does not carry forward/, …);
assert.deepEqual((h.readFeature().completedStages ?? []).filter((c) => c.stage === 'plan').length, 1,
  'the round-one completion is history and stays; the refused one must not append a second entry');
h.assertUnmoved(snap, 'a refused stage-complete plan over a critic REJECTION');
```

closed by the positive control — `recordPlanCritic(h, 'pass')` then
`ok(h, 'M1a-1a', 'state', 'stage-complete', 'plan')` — so the case cannot pass against a kernel
that merely wedged the stage shut.

**Pre-existing coverage this row does NOT pretend to have discovered, and the honest delta.**
`test/cli/state.test.mjs` · `stage-complete plan reads the LATEST plan-critic verdict, not any
historic pass` already pins the same kernel guard through the real bin
(`assert.match(r.stderr, /LATEST plan-critic/)`). **This is the thinnest of the three added
rows.** What M1a-1a adds is exactly two things, both required by the bar above and neither present
there: (i) `h.assertUnmoved` — the cli test never asks whether the refusal moved state; (ii)
isolation — the cli test edits `plan.md` and re-approves between rounds, so more than the verdict
has moved, while M1a-1a proves the FAIL alone is sufficient with the approval provably intact. It
also runs on a plan imported through `plan check --import`; the cli test's `seedTasks()` hand-writes
`tasks.json` and never exercises the import path.

### 1(b) THE ADVERSARIAL CENTRE — a pass recorded before a re-imported revision dies with it

`test/acceptance/m1a-fixtures.test.mjs` ·
**`M1a-1b a critic pass recorded BEFORE a re-imported revision dies with the plan it read — plan.md byte-identical`**

The revision arrives the way an architect produces one: a rewritten `plan.tasks.json` re-imported
through `legion plan check --feature <name> --import` (SKILL.md plan step 5's exact instruction).
**`plan.md` is never touched, and that is what makes the case adversarial** rather than a
restatement of `enforcement.test.mjs` 10b:

```
assert.equal(readFileSync(join(h.dossier, 'plan.md'), 'utf8'), PLAN_MD,
  'plan.md must be byte-identical — the whole point is that ONLY the task rows moved');
```

The plan approval is deliberately re-recorded after the re-import, so the ONLY stale evidence left
is the critic verdict and the refusal can be about nothing else:

```
assert.ok(!h.readTasks().approvals.plan, 'the re-import must have cascaded the plan approval away');
ok(h, 'M1a-1b', 'state', 'decision-record', 'plan');
…
assert.equal(r.code, 1, 'a critic pass over the PRE-revision plan cannot satisfy the revised one');
assert.match(r.stderr, /judged a DIFFERENT plan/,
  'the refusal must say the verdict died with the plan it read — not that a review is missing (one is recorded) and not that the approval is stale (it was just re-recorded)');
assert.ok(h.readTasks().reviews.some((rv) => rv.role === 'plan-critic' && rv.verdict === 'pass'),
  'the verdict is a FACT and must survive as history — only the CONCLUSION is re-derived');
h.assertUnmoved(snap, 'a refused stage-complete plan over a pre-revision critic pass');
```

**Why this is not `enforcement.test.mjs` 10b again, proven rather than argued.** 10b
(`a PLAN review is bound to the plan, and a FEATURE review survives a dossier-only edit`) moves
`plan.md` and never the task rows. Mutant **M3** below narrows the plan review's subject to
`plan.md`'s bytes alone — the exact over-narrowing PLAN-V3 §State corollary 2 warns about in the
other direction — and **10b stays GREEN while M1a-1b FAILS**. That cross-check is the evidence that
this row covers ground nothing else did.

### 1(c) Positive control

Tail of the same test: a fresh critic pass on the revised plan releases the stage, and the
lifecycle moves on — `stage-enter build` is the second half because it re-derives the whole prefix
over the revised plan rather than only the plan row.

```
recordPlanCritic(h, 'pass');
ok(h, 'M1a-1b', 'state', 'stage-complete', 'plan');
ok(h, 'M1a-1b', 'state', 'stage-enter', 'build');
```

### The prose-borne half — WARM re-review (RR1). NOT TESTED, and deliberately

PLAN-V3 decision 1 and `skills/feature/SKILL.md` RR1 require the re-review to be **warm**: *"the
same critic that rejected the plan, its own findings as the checklist … A fresh critic only if that
one is gone, and then its prompt carries the prior findings verbatim"* (SKILL.md plan step 5, §475
RR1). To the kernel a warm re-review and a cold one are the same `review-record` call — there is no
kernel surface that can tell them apart, and **fabricating a test for prose is worse than an honest
gap**, because it reads as proof of something nothing checks.

- **Session form: SKILL.md-borne.** `skills/feature/SKILL.md` plan step 5 and rule RR1. Enforced by
  the session reading its own skill; nothing else. Recorded here as such.
- **Loop form: pinned, and cited rather than re-tested.** The build workflow obeys RR1 in the only
  form a sandbox allows (it cannot continue an agent, so it re-dispatches the failing lens with that
  lens's findings verbatim — `workflows/build-loop.js` header line 133). Pinned by
  `test/workflows/build-loop-order.test.mjs`:
  - `a CODEX fail is re-reviewed by CODEX — the other lens never clears a finding it did not raise`
    — `assert.equal(re[0].agentType, 'legion:codex-consult', 'the re-review goes to the lens that
    failed')` and ``assert.match(re[0].prompt, /codex saw it/, "and it carries that lens's own
    finding verbatim")``.
  - `when BOTH lenses fail, each re-reviews its OWN findings and never the other lens’s` —
    ``assert.doesNotMatch(byType['legion:code-reviewer'], /codex finding/, "a merged checklist makes
    each lens grade the other's findings — the checklist is per lens")``.
  - `a failing close review costs ONE fix round: fix -> RE-GATE -> the SAME role re-judges its own
    findings` — `assert.match(re.prompt, /seam between T1 and its caller/, 'RR1: the role re-judges
    its OWN findings, verbatim')`.

  These pin RR1 for **task and milestone reviews inside the loop**. They do **not** cover the PLAN
  critic, which the loop never dispatches — planning happens in the session, before the loop runs.
  So the plan-rejection loop's warm half has no automated coverage at any layer, and that is the
  accurate statement of this case's residual.

---

## 2. Gate failure → in-loop recovery — ADDED BY T31, in two halves

**The red-gate refusal itself is M0 ledger row 2 and is NOT duplicated** —
`enforcement.test.mjs` · `C2 (harness) a RED gate records no receipt at all` and
`1 (T12) no path outside \`legion gate\` can produce a receipt that closes a task`. M1a's case
starts where that ends: the recovery, which nothing tested anywhere.

### 2(a) THE RECOVERY — fixup commit → green re-gate → a receipt keyed to the NEW tree

`test/acceptance/m1a-fixtures.test.mjs` ·
**`M1a-2a a RED task gate recovers FORWARD: fixup commit → green re-gate → a receipt keyed to the NEW tree closes it`**

The gate policy is `TREE_SENSITIVE_GATES` — a declared command whose verdict is a function of the
**committed tree**, so the same *pinned* policy goes red then green purely because the worktree
moved. A preset that exits 1 unconditionally could never model a recovery, and swapping the preset
between runs would be policy drift, which `legion gate` refuses outright (`enforcement.test.mjs`
case 3). The red half is this case's precondition, cited from M0 row 2 and re-asserted only as such:

```
assert.equal(red.code, 1, 'the gate must go red on the tree the builder committed');
assert.equal(taskRow(h, 'T1').receipt, undefined, 'a red gate mints NOTHING (M0 row 2 — cited …)');
assert.equal(done.code, 1, 'and there is nothing for task-done to consume');
h.assertUnmoved(snap, 'a red gate followed by a refused task-done');
```

The decisive assertions are the recovery's:

```
assert.equal(receipt.treeHash, fixedTree, 'the receipt must key to the POST-FIX tree');
assert.notEqual(receipt.treeHash, failedTree, 'and never to the tree the gate refused');
assert.equal(receipt.results.at(-1).exitCode, 0, 'its provenance must record the command actually passing');
ok(h, 'M1a-2a', 'state', 'task-done', 'T1');
```

and — the half that stops a "recovery" from being a quiet weakening of the gate, which is the
failure mode PLAN-V3 §Gates pins the policy to prevent and which would look identical from the task
row alone:

```
assert.equal(JSON.stringify(h.readFeature().commandPolicyHash), pinBefore,
  'the pinned gate policy must be untouched — a red gate is fixed by moving the tree, never by moving the gate');
assert.equal(h.readFeature().commandPolicyHistory, undefined,
  'and nothing may have been re-pinned behind the operator');
assert.equal(receipt.commandPolicyHash, JSON.parse(pinBefore).task, …);
```

### 2(b) THE STALE-RECEIPT ADVERSARIAL FORM — and the re-gate that restores it

`test/acceptance/m1a-fixtures.test.mjs` ·
**`M1a-2b a receipt earned green stops certifying the moment another commit lands — and a re-gate restores it`**

**Audit outcome, stated because the spec asked the audit to decide.** `enforcement.test.mjs` does
**not** pin this consumption shape. The behavioural precedent lives in two unit-level suites, both
driving the real bin, and **neither meets the bar**:

| cited test | what it gives | what it does not |
|---|---|---|
| `test/cli/gate.test.mjs` · `verify-receipt passes on a fresh receipt and fails when missing or stale — running nothing` | `assert.match(r.stderr, /no valid receipt for task T1/)` after a new commit | no immobility assertion; never re-gates |
| `test/cli/state.test.mjs` · `task-start/task-done refuse unknown ids; task-done refuses without or with a stale receipt` | ``assert.match(r.stderr, /!= current HEAD tree/)`` | no immobility assertion; never re-gates; runs on a hand-written `seedTasks` plan |

So the row is ADDED, with both consumers driven together, the immobility assertion attached, and
the loop closed:

```
assert.equal(done.code, 1, 'a receipt for a superseded tree closes nothing');
assert.match(done.stderr, /tree/, 'the refusal must name the tree mismatch, not merely "no receipt" — the receipt is right there');
assert.equal(verify.code, 1, 'and the hook-facing verifier must agree — one answer, two consumers');
assert.match(verify.stderr, /no valid receipt for task T1/);
assert.equal(taskRow(h, 'T1').status, 'started', 'the task must not have closed');
h.assertUnmoved(snap, 'two refusals over a superseded receipt');
```

positive control:

```
ok(h, 'M1a-2b', 'gate', 'run', '--task', 'T1');
assert.equal(taskRow(h, 'T1').receipt.treeHash, h.tree(), 're-gating re-keys the receipt to the current tree');
ok(h, 'M1a-2b', 'state', 'task-done', 'T1');
```

### 2(c) THE LOOP HALF — where a receipt-less task lands, and what a re-run does with it

`test/workflows/build-loop-order.test.mjs`, two tests, on that file's existing `runLoop()`
AsyncFunction harness (the workflow is not an importable module — M0 ledger finding 2, cited, not
re-reported).

**``a task whose verify-receipt REFUSES lands in failed at stage gate-receipt — never reviewed, never done``**

```
assert.deepEqual(result.failed.map((f) => ({ taskId: f.taskId, stage: f.stage })), [{ taskId: 'T1', stage: 'gate-receipt' }],
  'the failure must be attributed to the RECEIPT, not to the build or the review — the stage is what the session reads');
assert.equal(result.failed[0].builderClaimedReceipt, true, …);
assert.deepEqual(dispatches.filter((d) => /^T1 review/.test(d.label)).map((d) => d.label), [],
  'no review lens may be dispatched for a task whose receipt the kernel refused');
assert.equal(kernelCmds.some((c) => /state task-done 'T1'/.test(c)), false,
  'and task-done must never be attempted — the loop does not ask twice for what it was just refused');
assert.deepEqual(result.milestones.map((m) => [m.id, m.outcome]), [['M1', 'not-closed']], …);
```

The builder in that case returns `receipt: true`. That is the point: `legion gate verify-receipt`
is the loop's ONE defence against a self-reported receipt, and the loop must disbelieve it.

**``the re-run retries EXACTLY the task the receipt check failed — done tasks skip, and it reaches task-done``**

```
assert.deepEqual(builds, ['T1 build'], 'exactly one dispatch — the task that failed, and nothing else');
assert.deepEqual(result.skipped, ['T2'], 'the done task skips; nothing re-builds work the kernel already accepted');
assert.ok(kernelCmds.includes("state task-done 'T1'"),
  'and this time the loop reaches task-done — the recovery is a real forward path, not a permanently poisoned task');
assert.deepEqual(result.milestones.map((m) => m.outcome), ['closed'], …);
```

The re-run's input is the state the failed run leaves behind: `T1` **`started`** (task-start
succeeded before the receipt check) and never done. Mutant **M9d** below proves that is the
load-bearing detail.

**Harness change, stated because it is the only thing T31 touched outside new files.**
`runLoop()` gained an optional `kernelResult(argvText, label)` hook defaulting to exit 0. Every
kernel dispatch was previously hard-coded to succeed, which made a `verify-receipt` refusal
unreachable from this harness — the loop's most important refusal path had no seam to test it
through. No existing test changes behaviour (the default is the old constant).

---

## 3. Approval invalidation cascade on spec edit, the DEPENDENT half — ADDED BY T31

**M0 ledger row 4 proved the SPEC's own approval is consumed** (`m0-fixtures.test.mjs` F4a/F4b) and
`test/cli/state.test.mjs` · `cascade: re-recording the spec artifact kills spec+plan+preview+pre-merge,
intake survives` proves `approvals.plan` is DROPPED from the manifest
(`assert.deepEqual(Object.keys(tasks(s).approvals), ['intake'], 'only intake survives a spec change')`).
Both are cited, neither is duplicated. **What no test proved is that the cascade reaching the PLAN
approval is enforced at a CONSUMER** — and those are independent claims: a kernel that dropped the
record while `stage-complete` consulted `completedStages` would look identical in the manifest and
pass the feature through anyway, which is the exact defect class §State's facts-not-conclusions rule
exists to prevent.

`test/acceptance/m1a-fixtures.test.mjs` ·
**``M1a-3 a spec edit invalidates the PLAN approval at its consumer, isolated from the spec's own staleness``**

The feature is walked **legitimately** to an approved plan (spec approved, plan imported through
`plan check --import`, critic pass, plan approved, `stage-complete plan` accepted), then `spec.md`
is edited and re-recorded through `legion state artifact-record spec <path>` — the operator's own
path, never a hand-edited manifest.

**(b1) the prefix half** — the refusal points upstream:

```
assert.equal(r.code, 1, 'the whole prefix re-derives, so a stale spec blocks the plan stage too');
assert.match(r.stderr, /earlier stage/i, 'and the refusal must say the defect is upstream');
assert.match(r.stderr, /spec/, 'naming the stage that went stale');
h.assertUnmoved(snap, 'a refused stage-complete plan over a stale spec approval');
```

**(b2) THE ISOLATION, AND THE ACTUAL CASCADE PROOF.** The spec approval — and nothing else — is
repaired. If the cascade had **not** reached the plan approval, the plan stage would be fully
satisfied at this moment and the op would ACCEPT: the plan artifact never moved, the critic pass
still binds, the prefix is clean. It refuses, and it refuses naming the **plan's own** approval:

```
ok(h, 'M1a-3', 'state', 'decision-record', 'spec');
assert.ok(!h.readTasks().approvals.plan, 'and the plan approval is still gone — nothing revived it');
…
assert.equal(r.code, 1, 'the plan approval fell by CASCADE and nothing re-recorded it');
assert.match(r.stderr, /hash-valid plan approval/,
  'the refusal must now name the PLAN\'s own approval — an "earlier stage" message here would mean the spec repair did not take and the case proves nothing');
assert.doesNotMatch(r.stderr, /earlier stage/i, 'the prefix is repaired, so the only defect left is the cascaded plan approval');
h.assertUnmoved(snap, 'a refused stage-complete plan over a CASCADED plan approval');
```

and the same claim at the forward-entry consumer:

```
assert.equal(fwd.code, 1, 'forward entry must refuse on the same cascaded approval');
assert.equal(h.readFeature().stage, 'plan', 'and no hop may have landed');
h.assertUnmoved(snap, 'a refused stage-enter build over a cascaded plan approval');
```

**(c) Positive control — and the honest answer to "does the critic verdict survive a spec edit?"**

**IT DOES, and the test asserts that, because it is what the kernel does and what §State says it
should do.** A plan review's subject is the PLAN subject — `plan.md`'s bytes plus the content
projection of the task rows (`reviewSubjectHash` → `computeSubjectHash('plan')`) — and a spec edit
moves neither. PLAN-V3 §State corollary 2: *evidence binds to exactly what was judged — no wider,
no narrower.* The critic read the plan; the plan is unchanged; the verdict still describes it.
Binding it wider (to the spec, or to the tree) is precisely the "too wide" error that corollary
names, and it would force a pointless re-review on every spec typo. Re-recording the **approval** is
a human act — the operator re-assents to a plan they now read against a new spec — and the kernel
demands exactly that and no more. So no re-review is performed, and the assertion is:

```
ok(h, 'M1a-3', 'state', 'decision-record', 'plan');
ok(h, 'M1a-3', 'state', 'stage-complete', 'plan');
assert.equal(JSON.stringify(h.readTasks().reviews.filter((rv) => rv.role === 'plan-critic')), criticBefore,
  'and no critic verdict was recorded, re-recorded or removed to get there — the accept rides the ORIGINAL pass');
ok(h, 'M1a-3', 'state', 'stage-enter', 'build');
```

---

## Mutation record

Every added row, one mutant at a time: apply by exact string replacement, run the tests, restore
with `git checkout --` and byte-compare the restored file against the original. Nine aimed mutants
plus three re-aims; **twelve killed, none survived.** No product file is modified in the committed
tree (`git diff -- src bin workflows hooks agents skills` is empty).

**A SURVIVAL CLAIM IS A FULL-SUITE CLAIM — this record was corrected on exactly that.** T31 first
recorded M9 as SURVIVED on the strength of a single-file run of `build-loop-order.test.mjs`, where
it does survive. It does not survive the suite: it is killed by a SOURCE-TEXT pin in another file
(below). "Killed by the test file I ran" is sound from a single-file run, because a kill is an
existence claim; "changes no test in the suite" is a universal one and only a `npm test` run can
carry it. Every row below that names a count of collateral failures — M9, M9b, M9c, M9d — is a
full-suite run at `c793aaf`, 587 tests, and states its total; M1–M8's kill claims name the file
they were observed in and claim nothing beyond it.

| # | Row | Mutant | Result |
|---|---|---|---|
| M1 | 1(a) | `src/kernel/state.mjs` — delete `if (critic.verdict !== 'pass') return fail(…)` from the plan row | **KILLED** — `M1a-1a` fails |
| M2 | 1(b) | `src/kernel/state.mjs` — delete `if (!reviewBindingHolds(critic, …)) return fail(…)` | **KILLED** — `M1a-1b` fails |
| M3 | 1(b) | `src/kernel/state.mjs` — NARROW `reviewSubjectHash('plan')` to `sha256(plan.md bytes)`, dropping the task rows | **KILLED** — `M1a-1b` fails **and `enforcement.test.mjs` 10b still PASSES**, which is the proof this row covers new ground |
| M4 | 2(a) | `src/cli/gate.mjs` — a failing gate command no longer stops the run (`if (!r.ok)` records the result and continues), so a receipt is minted for a RED tree | **KILLED** — `M1a-2a` fails |
| M5 | 2(b) | `src/kernel/state.mjs` — disable `if (task.receipt.treeHash !== tree)` in `task-done` | **KILLED** — `M1a-2b` fails |
| M6 | 2(b) | `src/cli/gate.mjs` — disable `if (receipt.treeHash === tree)` in `verify-receipt` (always OK) | **KILLED** — `M1a-2b` fails |
| M7 | 3 | `src/kernel/state.mjs` — remove the cascade edge: `APPROVAL_PARENT.plan: 'spec'` → `null` | **KILLED** — `M1a-3` fails |
| M8 | 2(c) loop | `workflows/build-loop.js` — the loop trusts the self-report: `if (gated.exitCode !== 0 && build.receipt !== true)` | **KILLED** — the gate-receipt test fails |
| M9 | 2(c) loop | `workflows/build-loop.js` — top-level `const outstanding = ordered.filter(t => t.status !== 'done')` → `ordered.slice()` | **KILLED — but by a SOURCE-TEXT pin in another file, not by behaviour: full suite 587/586 pass/1 fail, the one failure `test/plugin-manifest.test.mjs:336` `done tasks skip — the re-runnability filter lives in the workflow, not in prose`. Nothing in `build-loop-order.test.mjs` notices. See finding 1** |
| M9b | 2(c) loop | `workflows/build-loop.js` — the real selector: `if (t.status !== 'done') g.outstanding.push(t)` → unconditional push | **KILLED** — full suite 587/577/10: the re-run test plus 9 pre-existing, all in `build-loop-order.test.mjs` |
| M9c | 2(c) loop | `workflows/build-loop.js` — `skipped:` no longer reports the done set (`skipped: []`) | **KILLED** — full suite 587/583/4: the re-run test plus 3 pre-existing |
| M9d | 2(c) loop | `workflows/build-loop.js` — a `started` task is treated as in-flight and NOT re-dispatched: `t.status !== 'done' && t.status !== 'started'` | **KILLED, and EXCLUSIVELY** — full suite 587/586/1, and the single failure IS the re-run test (`build-loop-order.test.mjs:841`) |

**M9d is the one that matters for row 2(c).** M9b and M9c kill the new test but kill a fistful of
pre-existing ones with it, so on their own they would not show the row carries a claim of its own.
M9d — a perfectly plausible implementation ("do not re-dispatch a task another session started") —
fails **only** the new test, because the state a gate-receipt failure leaves behind is precisely a
`started` task and nothing else in the suite re-runs over one.

---

## Findings raised by this audit

1. **A MUTANT NO BEHAVIOURAL TEST CATCHES — killed only by a source-text pin (M9).**
   `workflows/build-loop.js` computes the `status !== 'done'` predicate **twice** over the same
   array: the top-level `outstanding` (line ~277) and, independently, each group's `g.outstanding`
   (line ~305). Only the second is the selector the loop iterates; the first feeds `doneCount`, the
   log line, the budget estimate and the forward-cross-milestone-dependency scan. Delete the filter
   from the first and **every behavioural test still passes** — including
   `build-loop-order.test.mjs`'s `done tasks skip and their dependents still build, in dependency
   order`, whose name is about exactly this. What kills it is one line of `assert.match` against the
   file's SOURCE: `test/plugin-manifest.test.mjs:336` `done tasks skip — the re-runnability filter
   lives in the workflow, not in prose`, matching `/\.filter\(\s*t\s*=>\s*t\.status\s*!==\s*'done'\s*\)/`
   — and the top-level filter is that regex's only match in the file, since the real selector is an
   `if (…) g.outstanding.push(t)`. Full suite under the mutant: 587 tests, 586 pass, that 1 fail.
   **Not a defect today** (same predicate, same source array, so the two cannot disagree), and NOT
   proposed for a fix in this chunk — T31 changes no product code. It is recorded for three reasons.
   A duplicated predicate is a drift surface. **A mutant aimed at the visible filter proves nothing
   about the behavioural selector `g.outstanding`** — the source-text pin fires on the spelling, so
   a green `plugin-manifest` here certifies that a line of text exists, not that done tasks skip;
   that is precisely the "a test that reads as proof while the bypass stays open" shape this track
   exists to prevent, and anyone re-running this sweep must aim at `g.outstanding` (M9b/M9d) to
   learn anything behavioural. And the correction itself is the third: T31 originally recorded M9 as
   SURVIVED from a single-file run and was wrong — see the scoping rule above the table. A mutant
   recorded as surviving when it is killed corrupts the evidence exactly as badly as the reverse.
2. **The stale-receipt consumption shape is not in `enforcement.test.mjs`** (the spec's audit
   question for case 2(b)). It is in `test/cli/gate.test.mjs` and `test/cli/state.test.mjs`, and
   neither meets this ledger's bar — no immobility assertion, no recovery. Row 2(b) was therefore
   ADDED rather than cited; both precedents are named in the row so the overlap is visible.
3. **Row 1(a) is the thinnest addition in this track**, and the row says so. Its kernel guard is
   already pinned by `test/cli/state.test.mjs`; what T31 adds is the immobility assertion, the
   isolation of the FAIL from every other change, and the real import path. Recorded so nobody
   later reads three equally-novel rows where there are two and a half.
4. **The plan-rejection loop's WARM half has no automated coverage at any layer** — see the
   prose-borne section of case 1. The loop's RR1 pins cover task and milestone reviews; the loop
   never dispatches the plan critic. Stated as a residual, not papered over with a test of the
   kernel call that a warm and a cold re-review make identically.

**Cited, not re-reported** (already on HANDOFF's record from chunk 9): the RR1 × tree-binding stall,
the full-profile codex-consult gap, and the `args.profile` whitelist. M0's own rows, the T12b
residual, and row 8's live-only conventions are out of this track's scope by construction.
