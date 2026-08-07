# M0 fixture-track ledger (T21)

Closes the "Fixture track — still entirely unproven" section of `M0-REPORT.md`. The attended M0
smoke delivered a REAL feature end to end and never went red, so **not one** of PLAN-V3 M0's
fixture cases was exercised by it. This file is the accounting: for every case, either the test
that already proves it (with the decisive assertion quoted) or the test T21 added — and, for the
one case that cannot be proved on this machine at all, the precondition that would let it be.

**The bar every "covered-by" row meets.** A row is only claimed as covered when the cited test is
ADVERSARIAL: it drives the real `bin/legion.mjs` into a state where refusal is the correct answer,
asserts the refusal AND what the refusal names, and asserts that no state moved
(`h.assertUnmoved()` compares manifest bytes). A test that walks the happy path and asserts success
is never accepted as coverage of a refusal. Every row marked *added by T21* was
**mutation-checked**: the guard under test was deleted, the case was confirmed to FAIL, the guard
was restored. The surviving mutant that check found is recorded in row 5.

**How to keep this file honest.** No aspirational rows. If a case's test is deleted, weakened or
renamed, this file is wrong and the chunk-exit gate is reading a lie. Cite file + test name; quote
the assertion that carries the claim, not the setup.

---

## Ledger

| # | Case (PLAN-V3 M0, adversarial form) | Status |
|---|---|---|
| 1 | forged provenance-shaped receipt on a red-gate feature refused by EVERY consumer | covered |
| 2 | red gate ⇒ no receipt minted, `task-done` refuses | covered |
| 3 | malformed plan bounced by `plan check`, nothing imported | covered (cycle added by T21) |
| 4 | stale approval CONSUMED | **added by T21** |
| 5 | kill + resume mid-feature | **added by T21** (+1 finding) |
| 6 | blocked task → `task-answer` → re-run | **added by T21**, in two halves |
| 7 | forward stage-skip / unmet dependency / unclassified past intake | covered |
| 8 | protected-branch push refused by the server | **LIVE-ONLY — PROVEN 2026-07-29** |

---

### 1. Forged provenance-shaped receipt, refused by every consumer — COVERED

`test/acceptance/enforcement.test.mjs` ·
**`1b (T12b) a provenance-SHAPED receipt that names the pinned policy HASH without reproducing its
commands closes nothing`**

The feature runs on `fixture({ gates: 'RED' })` and the case opens with a positive control —
`assert.equal(taskRow(h, 'T1').receipt, undefined, 'fixture: the RED gate must mint nothing')` — so
every receipt it then consumes is a forgery, hand-written by copying the pin out of the neighbouring
`feature.json`, exactly as a caller with Bash can. All four consumers are driven:

| consumer | decisive assertion |
|---|---|
| `gate verify-receipt --task` | `assert.equal(v.code, 1, 'verify-receipt must refuse a receipt whose results[] never ran')` + `assert.match(v.stderr, /provenance/i)` |
| `gate verify-receipt --boundary` | `assert.equal(vb.code, 1, 'the SAME forgery at the boundary tier must refuse too')` |
| `state task-done` | `assert.equal(done.code, 1, 'task-done must refuse it — naming the policy hash correctly proves nothing')` |
| `legion finalize` (C-checks) | `assert.match(fin.stderr, /GATE PROVENANCE/)` and `assert.doesNotMatch(fin.stderr, /must never be invoked/, 'it must refuse BEFORE reaching glab')` |

closed by `h.assertUnmoved(snap, 'four refusals over a pin-copying forgery')`. A second round in the
same test pins the argv comparison: a forgery with the right command NAME, the right COUNT and exit
0 but an undeclared argv is refused —
`assert.equal(done2.code, 1, 'an argv the pinned policy does not declare is not evidence of the pinned policy')`.

Second shape, same file: **`2 (T12) a rev-4-shaped receipt (no gate provenance) closes nothing`** —
`{treeHash, commit, at}` for the REAL current tree, refused by `verify-receipt`
(`'verify-receipt must refuse a receipt no gate issued'`) and by `task-done`
(`'task-done must refuse it too — the tree being real proves nothing'`).

Also relevant: **`1 (T12) no path outside \`legion gate\` can produce a receipt that closes a task`**
proves there is no receipt-writing typed op at all —
`assert.match(rec.stderr, /unknown state op/)`.

*Open residual, NOT a gap in this row:* a forger who rewrites BOTH halves of the pin still produces
a receipt that passes provenance. That is an accepted operator decision, documented in
`src/cli/gate.mjs`'s header and in case 1's own comment. It is not re-reported here.

### 2. Red gate ⇒ no receipt, `task-done` refuses — COVERED

`test/acceptance/enforcement.test.mjs` · **`C2 (harness) a RED gate records no receipt at all`**

```
assert.match(r.stderr, /no receipt recorded/);
assert.equal(t.tasks.find((x) => x.id === 'T1').receipt, undefined);
assert.equal(t.receipts.boundary, null);
h.assertUnmoved(snap, 'a red gate');
```

The consumption half is the third part of **`1 (T12) no path outside \`legion gate\` …`**:

```
assert.equal(done.code, 1, 'task-done must refuse without a receipt');
assert.match(done.stderr, /receipt/);
assert.equal(taskRow(h, 'T1').status, 'started', 'the task must not have closed');
```

### 3. Malformed plan bounced, nothing imported — COVERED (cycle added by T21)

| shape | where | decisive assertion |
|---|---|---|
| bad id (injectable, spaced, traversal, empty) | `enforcement.test.mjs` · `9 (T14) \`plan check\` rejects ids the kernel would refuse, importing nothing` | `assert.deepEqual(h.readTasks().tasks, [], 'NOTHING may be imported')` |
| unresolvable dependency | `enforcement.test.mjs` · `C1 (harness) a malformed candidate plan is bounced by \`plan check\` and imports nothing` | `assert.match(r.stderr, /references unknown task 'T9'/)` + `assert.deepEqual(h.readTasks().tasks, [], 'nothing may reach canonical tasks.json')` |
| raw-string `validate` | same test (`C1`) | `assert.match(r.stderr, /must be structured \{cwd,argv,timeoutMs\}/)` |
| **cyclic deps** | **`test/acceptance/m0-fixtures.test.mjs` · `F3c a cyclic plan is bounced by \`plan check --import\` and NOTHING reaches canonical tasks.json`** — ADDED BY T21 | `assert.deepEqual(h.readTasks().tasks, [], 'NOTHING may be imported for ' + label)` over three shapes (two-node, self-loop, three-node cycle behind an entry point) |

Why the cycle needed a new test rather than a citation: `test/cli/plan.test.mjs` already had
`dependency cycle → fail` and `self-loop cycle → fail`, but neither runs `--import`, so nothing
anywhere asserted that a cyclic plan leaves canonical `tasks.json` empty. Acyclicity is validated
ONLY at import (`src/cli/plan.mjs`) — `workflows/build-loop.js` says in its own header that a cycle
hand-edited past that point is appended in file order and left to `task-start` to refuse — so
"import refuses" is the entire guarantee, and it was untested at the import boundary.

### 4. Stale approval CONSUMED — ADDED BY T21

M0 proved the CASCADE live four times (spec edits dropped spec+plan approvals). It never proved the
other half: that a consumer then REFUSES on the re-derived hash. The two are independent — a kernel
that dropped the approval while `stage-complete` consulted the stored `completedStages` would look
identical in the manifests and pass the feature through anyway.

`test/acceptance/m0-fixtures.test.mjs`:

- **`F4a a re-recorded spec artifact makes \`stage-complete spec\` refuse on the re-derived hash`** —
  approve spec v1, amend spec.md, re-record it through `artifact-record` (the operator's own path,
  never a hand-edited manifest), then:
  `assert.equal(r.code, 1, 'a stage whose own approval no longer re-derives must not complete')`,
  `assert.deepEqual(h.readFeature().completedStages?.filter((c) => c.stage === 'spec') ?? [], [], 'a refused stage-complete must not append to the audit trail either')`,
  `h.assertUnmoved(snap, …)`. It then re-approves v2 and completes, so the case cannot pass against a
  kernel that merely wedged the stage shut.
- **`F4b a stale spec approval refuses a LATER prefix-dependent op — \`stage-complete build\``** —
  every task genuinely done and `stage-complete build` earned, then spec is amended two stages back:
  `assert.match(r.stderr, /earlier stage/i)` and
  `assert.equal(rowBytes(h, 'T1'), t1, 'a stale approval two stages back must not disturb a done task')`.

Adjacent, and deliberately not counted as this case: `enforcement.test.mjs` `5d` re-records spec.md
and drives ONE consumer (`stage-enter review`); `6b` consumes a stale INTAKE approval but changes
`intent.md` on disk *without* re-recording it — a different claim (the hash is re-derived from the
file at consumption). Neither drives `stage-complete` on the stale stage.

### 5. Kill + resume — ADDED BY T21, with one finding

`test/acceptance/m0-fixtures.test.mjs` ·
**`F5 a session restart continues the lifecycle exactly: no re-init, done tasks stay done`**

**What "a fresh process" can and cannot mean here, stated plainly.** `legion` holds no in-process
state: every call in the acceptance suite is already a separate `spawnSync` of `bin/legion.mjs`.
Spawning a second process and calling that the proof would be asserting the harness. What a session
restart actually is to the kernel is three things, and those are what the test asserts:

1. the durable manifests are the whole of the state — the resume path a real session takes:
   `assert.match(hook.stdout, /- stage:\s+build\s+\(status active/)` on the `SessionStart(resume)`
   hook, plus `assert.match(status.stdout, /stage:\s+build/)` from `feature status`;
2. the RE-INIT GUARDS hold — the failure a kill actually produces in the field:
   `assert.match(reinit.stderr, /tasks\.json already exists[\s\S]*refusing to re-initialize/)` and
   `assert.match(restart.stderr, new RegExp("feature '" + h.feature + "' already exists \\(status: active\\)"))`,
   each followed by `h.assertUnmoved(snap, …)`;
3. the lifecycle continues EXACTLY — the task that was mid-flight closes on the receipt it earns
   after the restart (it is NOT re-started), and
   `assert.equal(rowBytes(h, 'T1'), t1Before, 'a done task must survive the restart byte for byte')`,
   then `stage-complete build` accepts.

**Mutation record.** The `feature start` assertion originally read `/already exists/i` and a mutant
that deleted the feature-level guard SURVIVED — the next guard down (`worktree path … already
exists`) fired for an unrelated reason and satisfied the match. The assertion now names the feature
and its status; the mutant is killed.

**FINDING 1 (reported, not pinned by an assertion).** `legion feature status` is unreachable from
the worktree. `src/cli/feature.mjs`'s `resolveProject` documents `{fromAnyWorktree:true}` as the
mode for "READ-ONLY callers that must work in the cwd sessions actually run in", and `legion doctor`
takes it for exactly that reason. `feature status` — read-only, and the first thing a resumed
session runs — does not, so from the worktree PLAN-V3 §Startup step 5 launches every session into,
it answers `repo … is not a registered project`. The test therefore runs it from the main repo root.
The defect is NOT pinned by an assertion here: a test that fails when the bug is fixed is a trap.
Fixing it is out of T21's scope and would break `test/cli/feature.test.mjs`'s
`the not-a-registered-project remediation names the MAIN repo root, never the worktree`, which uses
that refusal as a convenient trigger for an unrelated claim about remediation text.

**CLOSED 2026-07-29 by T22** (append; the audit text above is the record and stands unedited).
`status()` now resolves `{fromAnyWorktree:true}`, so the F5 call above runs **from the worktree** —
the cwd the continuity claim is about — and its comment says so; F5's restart-continuity assertions
are unchanged. The trigger test was REWORKED exactly as this paragraph anticipated, never deleted:
it keeps its name and both decisive assertions (names `--root <main repo>`; never
`--root <worktree>`) and is re-triggered through `feature abandon`, a WRITE path that keeps
default-mode resolution by design, plus two new assertions that the refused abandon destroyed
nothing. The fix is pinned adversarially by two new tests in the same file —
`feature status runs from INSIDE a feature worktree — both forms, identical to the main repo root`
and `--org still disambiguates feature status from inside a worktree; the bare form still refuses`
— both mutation-checked: reverting `status()` to default-mode resolution FAILS both and leaves the
reworked trigger test green (as it must, since it no longer depends on status).

### 6. Blocked task → `task-answer` → re-run — ADDED BY T21, in two halves

The case spans two layers that cannot be driven from one harness, so it is two tests. Neither is
the case on its own.

**Kernel half** — `test/acceptance/m0-fixtures.test.mjs` ·
**`F6 \`task-answer\` records {question, answer, at} verbatim on a blocked task, and refuses a done one`**

```
assert.deepEqual(taskRow(h, 'T2').answers, [{ question: Q, answer: A, at: NOW }]);
assert.deepEqual(Object.keys(taskRow(h, 'T2').answers[0]), ['question', 'answer', 'at']);
assert.equal(taskRow(h, 'T2').status, 'blocked', 'recording an answer does not itself unblock the task');
```

plus the adversarial half — the same answer against the DONE task, reachable by a one-character typo
in the id: `assert.equal(late.code, 1, 'task-answer must refuse a done task')` +
`h.assertUnmoved(snap, 'a refused task-answer on a done task')` — and the re-run: the blocked task
restarts, closes on a real gate receipt, and
`assert.deepEqual(taskRow(h, 'T2').answers, [{ question: Q, answer: A, at: NOW }], 'the recorded decision must survive the task closing')`.
`blocked` is written by hand because no typed op writes it — the build workflow reports it as DATA
(PLAN-V3 decision 11), exactly as `enforcement.test.mjs` case 6 already does.

**Selection half** — `test/workflows/build-loop-order.test.mjs` ·
**`a re-run selects ONLY the answered blocked task — done tasks skip, and the answer rides the brief`**

```
assert.deepEqual(builds, ['build:T2'], 'exactly one dispatch — the blocked task, and nothing else');
assert.deepEqual(result.skipped, ['T1', 'T3'], 'both done tasks skip');
assert.ok(!kernelCmds.some((c) => /\bT1\b|\bT3\b/.test(c)), 'no kernel op may name a done task');
assert.match(brief, /RECORDED ANSWERS — these are settled decisions/);
assert.ok(brief.includes(Q)); assert.ok(brief.includes(A));
```

with a negative control, **`a blocked task with NO recorded answer is still re-selected — the loop
never adjudicates`**:
`assert.doesNotMatch(brief, /RECORDED ANSWERS/, 'an empty answers[] must produce no answers block at all — not an empty one that reads as settled')`.

**FINDING 2 (spec deviation, reported).** T21's spec said the selector "is exported or testable".
It is neither: `workflows/build-loop.js` is not an importable module (sandbox globals, top-level
`return`), so the selection half cannot use the acceptance fixture and lives in the workflow suite,
driven by that file's existing `runLoop()` AsyncFunction harness. Nothing is weakened by this — the
fakes are the hermetic seam and the assertions are about order and prompt content, which is where
the behaviour actually is — but the case is split across two files and both must be read together.

Pre-existing and adjacent, not the case: `test/kernel/state.test.mjs` carries `task-answer`'s full
behavioural matrix (append order, revision accounting, unknown task, missing flags);
`test/cli/state.test.mjs` carries the flag-parsing forms; `build-loop-order.test.mjs` already had
`done tasks skip and their dependents still build` and `a blocked dependency defers its WHOLE
dependent chain, transitively`.

### 7. Forward stage-skip / unmet dependency / unclassified past intake — COVERED

All in `test/acceptance/enforcement.test.mjs`:

| sub-case | test | decisive assertion |
|---|---|---|
| forward jump over the whole lifecycle | `5a (T13) \`stage-enter finalize\` from intake is refused, naming the expected next stage` | `assert.match(r.stderr, /spec/, 'the refusal must name the expected next stage')` |
| the one-hop-at-a-time WALK (the bypass that keeps `stageHistory` perfectly ordered) | `5b (T13) the one-hop-at-a-time WALK is refused at the FIRST forward hop` | `assert.equal(first.code, 1, 'forward entry requires the prefix to re-derive satisfied, not merely to be ordered')`, then every remaining hop refused with `h.assertUnmoved(snap, …)` per hop |
| `task-start` on an unmet dependency, with the dependent task FIRST in the file | `8 (T13) \`task-start T2\` refuses while its depends_on T1 is not done — even with T2 first in the file` | `assert.match(r.stderr, /T1/, 'the refusal must name the unmet dependency')`, then T2 starts once T1 is genuinely done |
| unclassified cannot complete intake | `6b (T13) \`stage-complete intake\` refuses …` | `assert.equal(r.code, 1, 'an unclassified feature cannot complete intake')` + `assert.match(r.stderr, /unclassified\|profile/i)` |
| unclassified cannot complete review either (reached LEGITIMATELY, so classification is the only defect) | `7 (T13) \`stage-complete review\` refuses without the profile's review set, and an unclassified feature never completes review` | `assert.equal(r2.code, 1, 'an unclassified feature cannot complete review at all — every stage past intake requires a member of {express, standard, full}')` |

### 8. Protected-branch push refused by the server — LIVE-ONLY, PROVEN 2026-07-29

**Still not covered by the hermetic suite, and deliberately not written there.** This is the
SERVER's refusal — PLAN-V3 §Remote safety layer 1 — and faking the server proves nothing about the
server. PLAN-V3 M0 is explicit that "a test that asserts the intended path while the bypass stays
open is worse than no test". The acceptance suite stays hermetic by construction —
`test/helpers/fixture.mjs` prepends a `fakebin` whose `glab` shim prints a refusal and exits 1
precisely so an accidental remote call is loud rather than real — and `legion finalize` remains the
only remote-write path in the product (PLAN-V3 §Remote safety), which no test here may exercise.
What changed is that the two preconditions below are now met on a real fixture, so the LIVE case was
run by hand and is recorded here as evidence, not as a test.

**Preconditions (both were org-side, on the operator — M0-REPORT "Org-side actions"), now met:**

1. **A fixture GitLab project with REAL protection.** `gitlab.intech.dev/rachid.daoud/rachid_test`
   (project id 1848), branch `main`: `push_access_levels` and `merge_access_levels` both
   `Maintainers (40)` only, `allow_force_push: false`. Note this is a project the operator owns
   personally, not cv-mf — cv-mf's `develop` still accepts a direct Developer push
   (M0-REPORT refusal 2; tightening it is a request to cv-mf's maintainers, who the operator does
   not have Maintainer access over, and stays open by design, unrelated to this row).
2. **A dedicated, minimally-permissioned agent identity.** A GitLab Project Access Token (role
   Developer, scopes `api` + `write_repository`) resolves to its own bot user
   (`project_1848_bot_3ff839ac0f7e18a36f97a2ee8bad703e`, id 473) — genuinely distinct from the human
   merger (`rachid.daoud`, the project Owner). It was supplied via the `GITLAB_TOKEN` environment
   variable per command, never via `glab auth login` — that would have overwritten the operator's
   personal `gitlab.intech.dev` session (glab stores one token per hostname), which other work
   (cv-mf) depends on. `GITLAB_TOKEN` takes precedence over the stored config for every `glab`
   subprocess `legion` shells out to, so this gives real identity separation without touching global
   auth state.

**What running it looked like:**

- `legion project init --org fixture --name rachid-test --gates <gates.json>` registered the fixture
  (tiny npm repo, `package.json` test script `node --test`, one passing test — the declared gate
  command for both `task` and `boundary` tiers).
- `GITLAB_TOKEN=<bot token> legion doctor`, run from the fixture repo, went **FULLY GREEN — 5 pass,
  0 warn, 0 fail** — including `glab-auth` (`✓ Logged in to gitlab.intech.dev as
  project_1848_bot_3ff839ac0f7e18a36f97a2ee8bad703e (GITLAB_TOKEN)`) and `branch-protection`
  (`server-side protection VERIFIED on rachid.daoud/rachid_test: the agent identity
  (developer (30)) can neither push nor merge main`).
- From a `git worktree` off the fixture repo (one commit ahead of `main`, so the push would have been
  a clean fast-forward on permission alone), a raw `git push` straight to `main`, authenticated as the
  bot over HTTPS (Basic auth, `oauth2:<token>` — the smart-HTTP endpoint returned
  `401 www-authenticate: Basic`, a bare `PRIVATE-TOKEN` header is not accepted there), was **REJECTED
  BY THE SERVER**:
  ```
  remote: GitLab: You are not allowed to push code to protected branches on this project.
  ! [remote rejected] test/push-refusal -> main (pre-receive hook declined)
  ```
  exit 1. `git ls-remote` immediately after confirmed `main` unmoved (`ffcbf79…`, identical to
  before the attempt) — the refusal changed nothing.
- The probe branch and worktree were removed afterward; the fixture repo and its `legion`
  registration (`fixture/rachid-test`) are kept for reuse by the c8 defense-in-depth slice (PLAN-V3
  §Remote safety layer 3), which needs this same real-protection fixture to prove the hook layer
  blocks first and the server still refuses underneath it.

#### Layer 3 proven on the same fixture — APPENDED 2026-07-29 (T27, chunk 8)

Everything above stands unedited; this subsection records the LAYERED proof PLAN-V3 §Remote safety
schedules for the defense-in-depth slice — "hook blocks first; with hooks bypassed the SERVER still
refuses". Same repository, same protection, same day. **One arm ran live, one is cited from the row
above, and which is which is stated per arm rather than blurred into "proven".**

**Setup (step 1).** `legion project init --root /Users/rachid.mohamed-daoud/Work/rachid_test --org
fixture --name rachid-test` was re-run — the shipped path, not a hand-installed file. It printed
`project fixture/rachid-test up to date` plus
`pre-push guard: installed at /Users/rachid.mohamed-daoud/Work/rachid_test/.git/hooks/pre-push`, and
`project.json` was byte-identical before and after (sha256 diffed): re-init reconciled nothing and
the only thing that changed on disk was the hook. The guard was absent before because the fixture
was registered on 2026-07-29 by a legion that predated T25.

**The hook blocks first — LIVE, this machine, this fixture (step 2).** From a throwaway worktree
(`t27/layer3-probe`, one probe commit `a48990e` on top of `main`'s `ffcbf79`), a raw
`git push origin HEAD:main`:

```
legion pre-push guard: PUSH BLOCKED.
  'main' is a PROTECTED branch of project fixture/rachid-test
  (recorded by `legion project init`: main — matched by 'main').
```

exit 1, and `git ls-remote origin refs/heads/main` before and after both read
`ffcbf795411232e72feb82baabb6c3cc15db933b` — nothing moved.

**WHERE IN THE PUSH THE REFUSAL LANDS, corrected against the task spec.** The spec asked for
evidence that "the hook exits before git contacts the remote". `GIT_TRACE=1 GIT_TRACE_PACKET=1` shows
that is NOT how git works, and the honest claim is narrower — and still exactly the claim layer 3
needs. In order, from the captured trace:

```
trace: run_command: … ssh -p 10022 git@gitlab.intech.dev 'git-receive-pack …'   ← connect + auth
packet:  push< ffcbf795…  refs/heads/main\0report-status … agent=git/2.53…       ← ref advertisement (a READ)
trace: run_command: /Users/…/rachid_test/.git/hooks/pre-push origin ssh://…      ← THE GUARD RUNS
legion pre-push guard: PUSH BLOCKED.                                             ← and refuses
error: failed to push some refs to 'ssh://gitlab.intech.dev:10022/…'
packet:  push> 0000                                                              ← flush, then hang up
```

git connects and reads the remote's refs BEFORE running `pre-push`, necessarily: the hook's stdin
contract (`<local ref> <local sha> <remote ref> <remote sha>`) contains the remote sha, which only
the advertisement can supply. What the trace does prove is the thing that matters: **the only bytes
git ever sent toward the remote were the read half plus a flush packet** — no `push>` ref-update
command, no pack, no object transfer. So the correct sentence is "the guard refuses before anything
is written to the remote", never "before git contacts the remote". Recorded here because a ledger
that overstates its own evidence is worth less than no ledger.

**With hooks bypassed the server still refuses — CITED, not re-run (step 3).** `GITLAB_TOKEN` was
NOT present in this session's environment, and the chunk's fixture rules forbid the fallback: the
operator's stored `gitlab.intech.dev` credentials are the project OWNER, so a `git push --no-verify`
under them would have SUCCEEDED and moved `main` — a probe that destroys its own fixture and proves
the opposite of its claim. The arm is therefore cited from **the row above, proven 2026-07-29**: same
project (id 1848), same `main` protected to Maintainers-only, and — the stronger form of the same
fact — **no local hook existed at all when that push was refused by the server**. A bypassed hook and
an absent hook present the server with the identical request. The live `--no-verify` re-run under the
bot token remains attended-remaining.

**`legion doctor` in the fixture repo (step 4).** Run from the main checkout and again from the
throwaway worktree, identical verdicts:

- `remote-guards` **PASS** — `legion's pre-push guard is installed for fixture/rachid-test at
  /Users/…/rachid_test/.git/hooks/pre-push`, with the depth framing in the detail itself.
- `branch-protection` **FAIL** — `the agent identity (owner (50)) CAN push 'main' — rule 'main'
  allows maintainer (40) and above`. **That is the correct verdict, not a regression of the row
  above.** Without `GITLAB_TOKEN` every `glab` subprocess uses the operator's stored personal
  session, and `rachid.daoud` really is the project Owner and really can push `main`; the row above
  read PASS because it ran as the Developer bot, which is the identity legion is meant to run as.
  The check is three-valued about **the identity in use**, and it said the true thing about this one.

That pairing is worth more than a second green would have been: **a machine with the local guard
installed and green still had a server-side verdict of "this identity CAN push the protected
branch"** — layer 3 present and correct, layer 1 red, and the guard did nothing whatsoever to make
that push safe. It is the layering, printed by the product, in one table.

**Cleanup (step 5).** The probe worktree and `t27/layer3-probe` were removed; `main` sits at
`ffcbf79`, the working tree is clean, `.git/hooks/pre-push` stays installed. The fixture repo and its
registration remain standing infrastructure.

**THE ORDERING IS THE POINT.** The hook fired first and refused before anything was written to the
remote — and removing it changes nothing about the server. That is the whole content of layer 3: it
can refuse a push the server would have accepted; it can never make a push the server accepts safe.
`--no-verify` walks past it by design (test/git-hooks.test.mjs asserts that bypass WORKS), and what
is left underneath is the row above.

#### AMENDED 2026-08-07 — the local guard layer proven above was subsequently REMOVED

Everything above stands unedited; it records real runs of a layer that existed when they ran. On
2026-08-07, by owner decision, legion removed BOTH local remote-write guards — the pre-push hook
whose refusal is captured in this subsection and the plugin's PreToolUse Bash guard: a developer
using legion is free to push and open merge requests by hand, and the server-side refusal proven in
row 8 (this section's step 3 citation) is the surviving guarantee — now the whole story, not the
bottom layer of one. `legion project init` / `legion feature start` now REMOVE a leftover stub
(its fail-closed import would otherwise block every push once the guard file stopped shipping —
test/git-hooks.test.mjs proves the trap and the removal), and `legion doctor`'s `remote-guards`
check now reports leftovers instead of installations. The fixture repo's own stub at
`/Users/…/rachid_test/.git/hooks/pre-push` is such a leftover until a `project init` /
`feature start` next runs there.

---

## Findings raised by this audit

1. **`legion feature status` is unreachable from the worktree** — see row 5. Read-only command
   missing `{fromAnyWorktree:true}`; a resumed session, which by PLAN-V3 §Startup step 5 stands in
   the worktree, gets "is not a registered project". Not fixed here (out of T21's scope; the fix
   would break an unrelated green test that uses the refusal as a trigger).
   **CLOSED 2026-07-29 by T22** (append-only; the text above stands) — `status()` resolves
   `{fromAnyWorktree:true}`, while `start`/`abandon`/`clean` keep default-mode resolution by
   design (they are write paths). The trigger test was reworked onto `feature abandon` — same
   name, same two decisive assertions, never deleted — F5 now asks status from the worktree, and
   two new adversarial tests pin the fix. See row 5.
2. **The build-loop selector is neither exported nor module-importable** — see row 6. T21's spec
   assumed otherwise; the selection half of case 6 therefore lives in the workflow suite rather than
   the acceptance suite.
3. **A surviving mutant, found and killed during the sweep** — see row 5. `/already exists/i` was
   satisfied by a *different* guard than the one under test. Recorded because it is the same defect
   class M0-REPORT finding 7 describes ("a test whose title claims more than its fixture proves"),
   and because the sweep is the only thing that found it.
