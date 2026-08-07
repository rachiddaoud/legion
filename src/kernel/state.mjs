// state.mjs — the typed state machine behind `legion state <op>`. The
// caller chooses the TRANSITION; the kernel DERIVES and validates the evidence itself —
// callers never supply authoritative identifiers (a model handed `--subject-hash` could
// bless anything). There is no --hash/--sha/--head flag anywhere.
//
// TWO manifests live in the dossier, each with its OWN monotonic revision; every op writes
// EXACTLY ONE of them (cross-manifest READS are fine) and bumps that manifest's revision
// by +1 with a fresh updatedAt:
//   feature.json (created by `feature start`) — stage, profile, session history, status, and
//     the PINNED gate command policy. Written by: stage-enter, stage-complete, session-record,
//     ticket-record, escalate-profile, close.
//   tasks.json   (created by `init`, this module) — tasks, artifacts, approvals, reviews,
//     receipts. Written by: init, artifact-record, decision-record, task-start, task-done,
//     task-answer, review-record, invalidate.
// TWO EXCEPTIONS to "every write lives here", named rather than left implicit:
//   1. `legion finalize` (src/cli/finalize.mjs) records the read-back MR into feature.json. It
//      is not a typed op because its evidence is a REMOTE fact this kernel cannot derive.
//   2. `legion gate` (src/cli/gate.mjs) MINTS RECEIPTS — recordGateReceipt writes tasks.json —
//      and, under `--repin`, moves the pin — repinCommandPolicy writes feature.json. A single
//      `gate run --repin` therefore writes BOTH manifests, which is the one command in the
//      kernel that does; it is two writes through two exported writers, each obeying the
//      one-manifest/revision+1/atomic rule, never one write spanning both.
// Both callers reuse this module's bumpWrite and approvalValid/receiptProvenance — all exported
// for exactly them — so the revision discipline and the FROZEN hashes keep one definition each.
//
// THERE IS NO `receipt-record` OP. A dispatchable receipt writer is a way for a caller to
// certify a tree no gate ever ran on, and it does NOT become safe by deriving the tree hash
// honestly: a prior such writer derived HEAD and the tree itself, refused a dirty worktree, and
// STILL let this chain close a task whose only gate command was `exit 1`. The receipt writer is
// therefore reachable from `legion gate` alone (recordGateReceipt below), and the OPS table —
// which generates `legion state`'s advertised op list — must never regain an entry that writes one.
// THE OP SET GREW EXACTLY ONCE SINCE, BY `ticket-record`, AND THE DISTINCTION IS THE WHOLE
// ARGUMENT. `receipt-record` was refused because it let a caller supply EVIDENCE — a certificate
// the kernel is supposed to derive, gating task-done and finalize. A ticket ref is the opposite
// kind of thing: it is a POINTER AT A HUMAN CONVERSATION that no approval binds, no hash pins and
// no predicate reads, so the operator supplying it blesses nothing (kernel/ticket.mjs header). The
// kernel's only judgment over it is refusing syntactic garbage. That is why one op could be added
// here without reopening that hole — and why the next proposed op has to make the same argument
// from scratch rather than cite this one.
// Every read of either manifest asserts schemaVersion===1 and dies loudly otherwise
// (unknown schema ⇒ a newer/older kernel or a hand-edit; a silent default propagates
// corruption). Writes are atomic-rename via writeJson.
//
// APPROVALS bind to SUBJECT HASHES the kernel recomputes at record time:
//   intake→sha256(intent artifact bytes) ·
//   spec→sha256(spec artifact bytes), and for an INITIATIVE feature carrying an interface
//     contract, sha256(`${sha256(spec bytes)}:${sha256(LIVE contract bytes)}`), see
//     specContractBytes(); no contract ⇒ the single-hash formula ·
//   plan→sha256(`${sha256(plan.md)}:${sha256(JSON.stringify(tasks[].map(planContent)))}`) ·
//   preview→sha256(preview artifact bytes) ·
//   pre-merge→sha256(JSON{head, boundary receipt, canonical reviews}).
//
// REVIEWS BIND TO A DERIVED SUBJECT HASH. A review is
// stored as {role, verdict, subject, subjectHash, at}; subjectHash is DERIVED BY SUBJECT KIND —
// subject `plan` hashes the plan subject (the same combinedPlanHash the plan approval binds),
// task:<id>/milestone:<id>/feature hash the worktree TREE — and the subject must name something
// REAL (an unknown task or milestone refuses; a syntactically valid subject naming nothing is
// exactly the caller assertion this closes). Binding every review to the tree would be WRONG for a
// plan review: plan.md and tasks.json live in the DOSSIER and change without the tree moving, so
// a tree-bound plan-critic pass would survive the plan edit it should have died on. The verdicts
// are FACTS and are never deleted; whether a verdict still describes the live subject is a
// PREDICATE (reviewBindingHolds), re-derived wherever a review is a PREREQUISITE: the plan row
// (the LATEST plan-critic pass must bind to the CURRENT plan), the review row (each profile role's
// latest product-scope verdict must bind to the CURRENT tree), and finalize's C5.
// CONSEQUENCE FOR THE FROZEN PRE-MERGE FORMULA, deliberate and taken exactly once, with no
// real features in flight: adding `subjectHash` to review records changes canonicalReviews()
// output, so every pre-merge approval recorded under an earlier formula no longer validates —
// re-record with `decision-record pre-merge`. The new field is deliberately INSIDE the canonical
// form (a review set that changed must change the subject); the formula is FROZEN again from here.
// DEVIATION (stated): the plan hash mixes the canonical `tasks[]` ARRAY, not the whole
// tasks.json FILE as the implementation plan's prose read literally. A whole-file hash is
// self-referential — decision-record writes the approval INTO tasks.json, changing the
// bytes the approval just bound to, so approvalValid('plan') could NEVER be true and
// stage-complete(plan) would be unreachable. Hashing tasks[] is stable across
// approval/review writes (they don't touch tasks[]) and is the semantic subject anyway
// (what `legion plan check` imports). Once chosen this formula is FROZEN: decision-record
// and approvalValid must recompute identically or every approval silently invalidates.
// THE PLAN SUBJECT FORMULA CHANGED ONCE, deliberately ("too wide"): it used to hash WHOLE task
// rows, so `task-start` mutated the subject and invalidated the plan approval — inert while
// nothing re-checked the approval past the plan stage, but a PERMANENT LIFECYCLE STALL the moment
// the prefix re-derivation below landed (the first task started would strand the feature forever,
// which is why both changes share one commit). The subject now covers plan.md's bytes plus
// planContent()'s six-field projection of each row — precisely the bytes a human assented to;
// kernel-owned progress (status, attempt, receipt, answers, timestamps) is OUTSIDE the subject,
// so ordinary work cannot destroy a valid approval. CONSEQUENCE, stated out loud: plan approvals
// recorded under the earlier formula no longer validate — re-record with `decision-record plan`.
//
// THE STAGE MACHINE ("Facts, not judgments"): manifests store FACTS
// (hashes, receipts with provenance, verdicts, the recorded MR, the timeline), never
// CONCLUSIONS, because a stored conclusion outlives the evidence that produced it. Conclusions
// are PREDICATES RE-DERIVED where they gate something: stageSatisfied(stage) below recomputes
// the prerequisite table from the manifests every time it is asked — it never reads a
// stored completion flag, exactly as approvalValid() never reads a stored valid flag.
// `stageHistory` and `completedStages` are the AUDIT TRAIL of when each stage was entered/first
// satisfied: WRITTEN but NEVER CONSULTED AS AUTHORITY. Do not "optimise" stageSatisfied into a
// lookup of either — that is the stored-conclusion mistake this design exists to kill.
// STAGES is the ONE stage order. Forward `stage-enter` requires the target to be the NEXT stage
// AND the WHOLE PREFIX (intake up to and including the current stage) to re-derive satisfied
// now — not just the current stage, because invalidation can reach a stage the lifecycle moved
// past; and without the prefix check every prerequisite is skippable by simply never calling
// stage-complete. BACKWARD entry is always allowed, recorded, and CLEARS NOTHING: nothing was
// trusted, so if the evidence is still good the round trip costs nothing, and if it is not,
// forward entry refuses on its own. There is deliberately NO clearing mechanism.
// `close delivered` and `legion finalize` re-derive the same whole prefix (corollary 1), plus
// require the current stage to BE `finalize` — reaching finalize once is not evidence.
// PROFILE IS LOAD-BEARING: the kernel owns exactly ONE profile table,
// PROFILE_REVIEW_ROLES (profile → review roles required at stage-complete review). Everything
// else about a profile stays skill data. `unclassified` is intake-only: stageSatisfied(intake)
// refuses it, so no unclassified feature can leave intake, let alone reach review.
// ONE narrow conditional lives OUTSIDE the table: stageSatisfied's
// plan arm excuses the ABSENCE of a plan-critic verdict on 'express' — a stale pass reads as
// absence, a recorded LATEST fail blocks on every profile. It is a guard on one row, not a
// second table; do not grow it into one.
//
// THE COMMAND POLICY HASH IS THE SECOND FROZEN FORMULA, and it carries the same discipline for
// the same reason. commandPolicyHash(normalizedGates, tier) covers the
// project-declared gate commands for ONE tier, and three separate commands must recompute it
// BYTE-IDENTICALLY: `feature start` (which PINS it into feature.json beside baseSha), `legion
// gate run` (which compares live against pinned, and stamps the value it ran under into the
// receipt), and every consumer that verifies a receipt (`task-done`, `gate verify-receipt`,
// `legion finalize`, `close delivered`). One byte of drift in the payload silently invalidates
// EVERY receipt and EVERY pin in existence, so changing it is a schema change, not a refactor.
// CANONICAL BY CONSTRUCTION, four properties and each is load-bearing:
//   (i)   the input is always validateGatesConfig()'s NORMALIZED triple, never raw project.json:
//         it rebuilds every command as {argv:[...], timeoutMs} in fixed key order first;
//   (ii)  the payload is an ARRAY OF TRIPLES indexed by the tier's own list, so no object key
//         order is ever observed — reordering `gates.commands` keys, or the top-level `gates`
//         keys, cannot move the hash;
//   (iii) the TIER ARRAY's order IS policy, because it is the EXECUTION order (cheap→expensive,
//         stop at the first failure), so reordering it must hash differently;
//   (iv)  a command declared under `gates.commands` but not referenced by the tier is not that
//         tier's policy and never enters its hash.
// The tier name and a `v:1` tag live INSIDE the payload, so the same command list under `task`
// and under `boundary` are different policies and a future payload revision is distinguishable.
// A task's own `validate` is deliberately OUTSIDE this hash: it is PLAN-owned, bound by the plan
// approval and (for the {script,sha256} shape) by its own script digest, so folding it in would
// make the policy hash move with every plan edit. Do not "fix" that later.
//
// RECEIPT PROVENANCE (receiptProvenance below) is the ONE definition of "this receipt proves a
// gate ran". Every consumer imports it; a second copy in gate.mjs or finalize.mjs would be the
// drift this paragraph forbids. Checking only the required fields, the tier, and
// commandPolicyHash === the PIN is not enough, because the pin is stored IN PLAIN TEXT
// in feature.json, in the same dossier as tasks.json. Copying two fields across therefore produces
// a receipt that passes, with `results: []`, on a feature whose only gate command was `exit 1`
// (reproduced by execution, still reachable through a hand-written manifest). So it
// also READS THE PINNED COMMAND LIST (`commandPolicy[tier]`) as well as the pinned hash, and refuses:
//   - an ABSENT pinned list, exactly as an absent pinned hash (an EMPTY array is a PRESENT pin —
//     the tier-0-only case; only a non-array is absent), and a MALFORMED one, naming the index;
//   - a pinned list that does not HASH to the pinned hash (feature.json was hand-edited);
//   - `declaredCommands` that does not EQUAL the pinned command count;
//   - a results[] element that is not `{name, argv, exitCode: 0, ms}` — required-fields not
//     exact-keys HERE TOO, so a future per-command field stays additive — and, said out loud, a
//     recorded NON-ZERO exit, because a receipt is minted only on a GREEN run;
//   - results[] that does not REPRODUCE the pinned list: the first `declaredCommands` entries must
//     carry the pinned names in the TIER'S OWN ORDER (that order is policy — it is execution order)
//     with byte-equal argv, POSITIONALLY (duplicate declared names are legal, and a project may
//     legally declare a command named `validate`), followed by at most ONE entry named `validate`
//     and only on the TASK tier. That trailing validate's argv is NEVER compared: it is plan-owned
//     and deliberately outside commandPolicyHash.
// THE REFUSAL ORDER IS LOAD-BEARING: the pin/SUPERSEDED comparisons run BEFORE all of the above, so
// a receipt earned under a superseded policy still says SUPERSEDED instead of reporting a command
// count mismatch that is only a consequence of the re-pin.
// WHAT THIS DOES NOT CLOSE — see src/cli/gate.mjs's header "WHAT A RECEIPT ACTUALLY MEANS" for the
// residual in full. A dossier is a plain file the agent's own Bash can write, and every input this
// function has lives in that same directory — INCLUDING BOTH HALVES OF THE PIN. So a forger who
// copies the pinned list into results[] still passes, and one who rewrites both halves of the pin to
// the EMPTY policy passes while knowing nothing about the real one. This raises the cost from a
// two-field copy to a three-field one, out of the same file; it is not prevention, and nothing here
// claims it is. The list is stored, not derived, so nothing here is a reconstruction of the policy.
//
// CASCADE (deterministic): approvals form a DEPENDENCY DAG, not a flat line —
//   intake ← spec ← plan ← preview       (each child depends on the parent to its left)
//                       ↖ pre-merge
// preview and pre-merge are SIBLINGS off plan: pre-merge's subject is {HEAD, boundary,
// reviews} and NEVER includes preview evidence, so a preview change must not drop a valid
// pre-merge approval (a linear slice would over-invalidate here). Invalidating
// kind K drops approvals[K] and every approval that TRANSITIVELY depends on K (its DAG
// descendants); independent approvals (ancestors, and the preview↔pre-merge sibling)
// survive. APPROVAL_CHAIN is the workflow order + the vocabulary `invalidate <kind>`
// accepts; APPROVAL_PARENT (below) carries the dependency edges the cascade walks.
// artifact-record maps its kind→approval (intent→intake, spec→spec, plan→plan,
// preview→preview; review/repo-brief→none) and runs the same cascade — but ONLY when the
// artifact's {path,hash} actually CHANGED (re-recording identical bytes must not force the
// workflow backward). seedTasks runs it too, on the same changed-only rule: the plan subject
// is BOTH halves of combinedPlanHash, so a re-import that rewrites tasks[] invalidates the
// plan approval exactly as an edited plan.md does. `invalidate <kind>` is the
// caller-triggered form (materiality judgment lives in the session, not the kernel).
// approvalValid(kind) additionally RECOMPUTES the subject hash (belt-and-suspenders vs.
// drift not routed through artifact-record, e.g. plan.md edited directly) — used by
// stage-complete(plan) and close(delivered).
//
// QUESTION PROTOCOL: a builder facing a decision that genuinely
// changes the outcome returns `blocked: <question>` as DATA rather than guessing; the
// session records the human reply via `task-answer`, and the build-loop composes the task's
// `answers[]` into that task's next brief on re-run. question/answer are CONTENT the session
// supplies (like task titles/notes/plan text), NOT authoritative evidence — so
// --question/--answer are legitimate flags here; the no-flag rule covers hashes/HEAD/tree.
// Answering a `done` task is REFUSED: the Q&A would ride into a re-brief for work already
// accepted. Blocked-STATUS tracking deliberately does NOT live here — it belongs to the
// build-loop; task-answer only records the Q&A the loop reads back.
//
// INITIATIVES — CROSS-REPO LIVES ENTIRELY ABOVE THIS KERNEL. An
// initiative is ONE shared intake over N repos producing N ORDINARY single-repo features linked
// by DATA: the primary's dossier hosts the shared artifacts (the recap — recorded here as the
// INTENT artifact, SKILL.md intake step 8 — and the interface CONTRACT), and each secondary's
// feature.json carries an `initiative` block referencing them BY PATH + HASH. One feature is
// still one repo, one worktree, one pin set, one MR; every guarantee above is per feature and
// UNCHANGED. What this module gains is exactly four things and no more:
//   - the `contract` ARTIFACT KIND. Like `review`/`repo-brief` it binds NO approval via
//     ARTIFACT_TO_APPROVAL, so `artifact-record contract` runs no cascade of its own. It is
//     consumed by the by-reference validation below and by the spec SUBJECT — which is how
//     contract drift rides the EXISTING approval cascade instead of inventing a second one.
//   - ONE ADDITIVE PREREQUISITE CLAUSE in stageSatisfied('intake'): for a
//     SECONDARY, the hash-valid-intake-approval half may INSTEAD be satisfied by its recap
//     reference validating NOW. NO new stage, NO new transition, NO new approval kind
//     ("data plus one additive prerequisite clause, not new transitions").
//   - ONE CONDITIONAL CLAUSE in computeSubjectHash('spec'): when the feature carries an
//     interface contract, the spec subject binds the contract's
//     LIVE bytes alongside the spec's. With the clause below it, that is the whole of "a contract
//     edit changes the spec subject, the spec approval falls, and every dependent approval falls
//     with it" — because computeSubjectHash is THE ONE SHARED FORMULA, decision-record,
//     stage-complete, corollary 1's prefix walk and `legion finalize` inherit it with no code of
//     their own.
//   - ONE REFUSAL in artifactRecord: while a feature carries an initiative block, its `contract`
//     artifact MAY NOT MOVE — re-recording it at a DIFFERENT path is refused. The clause above
//     binds the contract BY PATH on both sides (the secondary through the reference `feature start`
//     derived, the primary through its own artifact record), so a relocation — the commonplace
//     "move to a new file" — would leave the old file on disk and every sibling still bound to it:
//     a stale contract that no approval notices. Detecting it
//     at the READER would need a cross-manifest read at verify time (deliberately rejected),
//     so it is refused at the ONE WRITER that can create it, where no sibling read is needed.
//     THE PATH IS THEREFORE IMMUTABLE FOR THE LIFE OF THE BLOCK, which is what makes "a contract
//     edit falls BOTH siblings" true unconditionally rather than only for in-place edits.
// Nothing else in this module reads the block.
// THE BLOCK IS OPTIONAL AND ITS ABSENCE IS THE ORDINARY CASE: every single-repo manifest
// has no such key, and no reader may treat that as an error.
// WHY A REFERENCE AND NOT A COPY: a copy is a conclusion that outlives its evidence (the
// facts-not-conclusions rule). The reference is re-validated on EVERY call — a recap edited AFTER
// intake completed poisons the prefix for the next forward stage-enter, which is the whole point:
// "the primary's recap changed" must be detectable as "no longer what my intake was completed
// against". SIBLING ENUMERATION IS DERIVED BY SCAN, never stored (src/cli/feature.mjs) — a stored
// siblings[] is the same stored conclusion, and writing one into the PRIMARY's manifest from a
// secondary's `feature start` would be a cross-manifest read-modify-write with no CAS.
// ONLY A SECONDARY CARRIES REFS. The primary's recap and contract do not exist yet when its own
// `feature start` runs, so its block is `{id, role:'primary'}` and its shared artifacts are found
// where every other artifact is: its own tasks.json (`artifacts.intent`, `artifacts.contract`).
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './fsatomic.mjs';
import { git, isWorktreeClean } from './git.mjs';
import { safeSegment } from './paths.mjs';
// THE shared ticket-ref validator (kernel/ticket.mjs). Imported, never re-implemented: `feature
// start --ticket` and `ticket-record` must accept and refuse exactly the same strings, or the two
// writers of one field disagree about what that field may hold.
import { validateTicketRef } from './ticket.mjs';

// --- typed vocabularies (an op outside these dies loudly; the model cannot fabricate) ---
export const STAGES = ['intake', 'spec', 'plan', 'build', 'review', 'pre-merge', 'finalize'];
// `contract` is the initiative's INTERFACE CONTRACT — the artifact that actually spans
// repositories (endpoints, payloads, error shapes). It is recorded like any other artifact and,
// like review/repo-brief, binds NO approval directly (ARTIFACT_TO_APPROVAL below): its consumers
// are the spec SUBJECT and the secondary's by-reference intake, never a cascade edge of its
// own. A component naming a kind this list does not hold is caught by test/plugin-manifest.
export const ARTIFACT_KINDS = ['intent', 'spec', 'plan', 'preview', 'review', 'repo-brief', 'contract'];
export const DECISION_KINDS = ['intake', 'spec', 'plan', 'preview', 'pre-merge'];
export const PROFILES = ['express', 'standard', 'full'];
/** The pre-classification placeholder `feature start` writes. INTAKE-ONLY, and deliberately NOT
 * a member of PROFILES: escalate-profile can never set it (back), and stageSatisfied(intake)
 * refuses it, so an unclassified feature cannot leave intake.
 * feature.mjs IMPORTS this for the initial manifest value, so the enum and the manifest cannot
 * disagree. */
export const UNCLASSIFIED_PROFILE = 'unclassified';
/** THE ONE profile table the kernel owns: profile → the review ROLES whose
 * latest feature/milestone-scope verdict must be a PASS for stage-complete review. A prerequisite
 * the kernel enforces cannot live in prose the kernel cannot read — and everything ELSE about a
 * profile (artifacts, approval conversations, ceremony) stays skill data: do not grow this into a
 * profile engine. `express` requires NONE here by design — its product sign-off is still demanded
 * by finalize's C5, a separate layered check that reads subjects, not roles.
 * NO row names `codex-consult`: the consult is a SECOND lens, never
 * the unique one, and its absence is an environmental fact about a machine, not a fact about the
 * feature — a kernel requirement here turns a missing CLI into an unfinishable feature. Full's
 * extra rigour (the plan-stage consult, the milestone-close consult) is skill/loop ceremony that
 * runs when the lens exists and degrades on record when it does not. */
export const PROFILE_REVIEW_ROLES = {
  express: [],
  standard: ['code-reviewer', 'product-reviewer'],
  full: ['code-reviewer', 'product-reviewer'],
};
export const CLOSE_MODES = ['delivered', 'abandoned'];
// The approval spine, in workflow order. Also the set `invalidate <kind>` accepts.
export const APPROVAL_CHAIN = ['intake', 'spec', 'plan', 'preview', 'pre-merge'];
// The approval dependency DAG as child→parent edges (root has null). The cascade drops a
// kind and its transitive descendants; preview and pre-merge are SIBLINGS off plan, so
// invalidating one leaves the other's approval intact (header CASCADE).
const APPROVAL_PARENT = { intake: null, spec: 'intake', plan: 'spec', preview: 'plan', 'pre-merge': 'plan' };
// artifact kind → the approval whose subject it is (review/repo-brief/contract bind no approval —
// the contract reaches approvals through the SPEC SUBJECT, not through a cascade edge).
const ARTIFACT_TO_APPROVAL = { intent: 'intake', spec: 'spec', plan: 'plan', preview: 'preview' };

// --- pure evidence helpers (exported for direct unit testing) -----------------------------

/** sha256 hex of a string or Buffer. The ONLY hash primitive; every subject flows through it. */
export function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Plan subject: plan.md bytes bound with the CONTENT PROJECTION of the task list — the six
 * plan-owned fields per row (planContent below: id, title, depends_on, milestone, validate,
 * notes), NEVER the live rows. FROZEN formula, changed exactly once (header APPROVALS:
 * whole-row hashing meant `task-start` invalidated the plan approval, which under prefix
 * re-derivation strands the feature permanently; plan approvals recorded under the earlier
 * formula no longer validate).
 * planContent — not projectPlanRow, which adds the constants status/attempt — so the choice of
 * projection is deliberate rather than an accident of which helper a comment named. */
export function combinedPlanHash(planBytes, tasksArray) {
  return sha256(`${sha256(planBytes)}:${sha256(JSON.stringify(tasksArray.map(planContent)))}`);
}

// --- the gate command policy: the second FROZEN formula (header) ---------------------------
/** The two gate tiers, in the order `feature start` pins them. */
export const GATE_TIERS = ['task', 'boundary'];

/** The command TRIPLES one tier's policy consists of: `[name, argv, timeoutMs]` per declared
 * command, in the tier's own EXECUTION order. `normalized` is validateGatesConfig()'s
 * {commands, task, boundary} triple (src/cli/gate.mjs) — never raw project.json. A tier naming a
 * command the triple does not declare is a caller that skipped validation, and dies loudly
 * rather than hashing `undefined` into a policy. */
export function commandPolicyTriples(normalized, tier) {
  if (!GATE_TIERS.includes(tier)) throw new Error(`not a gate tier: '${tier}' (tiers: ${GATE_TIERS.join(', ')})`);
  return (normalized?.[tier] ?? []).map((name) => {
    const cmd = normalized?.commands?.[name];
    if (cmd == null) {
      throw new Error(
        `commandPolicyTriples: gates.${tier} names undeclared command '${name}' — pass ` +
        `validateGatesConfig()'s normalized triple, never a raw gates block`,
      );
    }
    return [name, cmd.argv, cmd.timeoutMs];
  });
}

/** THE FROZEN PAYLOAD, in ONE place: receiptProvenance has
 * to hash a pinned triple LIST that came out of feature.json rather than a normalized gates
 * block, and a second `JSON.stringify({v:1, tier, commands})` anywhere is precisely the drift the
 * header forbids. commandPolicyHash below composes this with
 * commandPolicyTriples exactly the same way, and the golden freeze test in
 * test/kernel/state.test.mjs is what PROVES that rather than asserting it. */
function policyPayloadHash(triples, tier) {
  return sha256(JSON.stringify({ v: 1, tier, commands: triples }));
}

/** FROZEN formula (header THE COMMAND POLICY HASH): sha256 over the canonical serialization of
 * ONE tier's resolved command list. The recorder, the pinner and every verifier recompute this
 * byte-identically or every receipt silently stops certifying. commandPolicyTriples still throws
 * on a tier outside GATE_TIERS, so that guard is unchanged by the extraction. */
export function commandPolicyHash(normalized, tier) {
  return policyPayloadHash(commandPolicyTriples(normalized, tier), tier);
}

/** THE PIN IS BOTH HALVES, AND THIS DOCBLOCK IS THE ONE PLACE THAT SAYS WHAT COMPARES THEM.
 * Everywhere else — gate.mjs decision 16, feature.mjs, the tests — points HERE instead of
 * restating it. That indirection is not style: a claim restated by hand in several files drifts
 * from the code as those files are edited independently, and a manual sweep for the drifted copy
 * reliably misses one. The kernel already forbids a second copy of
 * receiptProvenance and of the commandPolicyHash formula, for exactly the reason it must forbid a
 * second copy of THIS: a restated invariant drifts from the code as surely as a reimplemented one.
 * If you are about to describe what the pin is or what reads it, link this docblock.
 *
 * The whole per-feature pin, both tiers at once:
 *   commandPolicyHash[tier] — WHICH policy this feature is certified by. The only thing a
 *     SUPERSEDED verdict compares, and the thing `feature start` and `--repin` agree on.
 *   commandPolicy[tier]     — the command TRIPLES that hash covers. LOAD-BEARING, not
 *     decorative: receiptProvenance hashes this list and requires the receipt's results[] to
 *     reproduce it, so a `commandPolicy` edited ON ITS OWN REFUSES rather than being ignored. It
 *     also lets a drift refusal print WHAT changed instead of two opaque hashes.
 * Both are written by `feature start` and by `gate run --repin`, from this one definition, so they
 * can never be written out of step. Neither half may be dropped as duplication of the other, and a
 * dossier carrying only one is a refusal, never a default.
 *
 * WHAT THIS DOES NOT MEAN, said exactly: a `commandPolicy` edited TOGETHER WITH ITS HASH is neither refused nor
 * ignored — it is ADOPTED as the policy the receipt is certified against, because both halves
 * agreeing is indistinguishable from a real write. That is the residual, and gate.mjs's header
 * "WHAT REMAINS OPEN" owns it in full. */
export function commandPolicyPin(normalized) {
  return {
    commandPolicyHash: Object.fromEntries(GATE_TIERS.map((t) => [t, commandPolicyHash(normalized, t)])),
    commandPolicy: Object.fromEntries(GATE_TIERS.map((t) => [t, commandPolicyTriples(normalized, t)])),
  };
}

/** Element-wise argv equality. An argv is an ordered list of exact bytes handed to execFile, so
 * nothing about it is order- or length-insensitive. */
const sameArgv = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** THE ONE DEFINITION of "this receipt proves a gate ran" (header RECEIPT PROVENANCE). Returns
 * {ok:true} or {ok:false, why}; `why` is the operator-facing half of every consumer's refusal.
 * REQUIRED-FIELDS, not exact-keys: a later kernel may add provenance fields without invalidating
 * receipts already earned. The two OPTIONAL fields are validated only for TYPE — a receipt is
 * not invalid for carrying `allowConfig`/`repinnedFrom`, nor for lacking them; their mere
 * presence is the audit signal downstream renders.
 * AN ABSENT PIN IS A REFUSAL, and so is an ABSENT PINNED COMMAND LIST. A missing per-tier
 * pin — of either half — means nothing declared what this feature would be certified by, so there
 * is nothing to compare against; defaulting to "fine" would reopen the receipt-forgery hole through
 * the back door.
 * `pinnedTriples` is feature.json's `commandPolicy[tier]`, and an EMPTY ARRAY IS A PRESENT PIN
 * (the tier-0-only case `project init` scaffolds) — only a non-array is absent.
 * THE REFUSAL ORDER IS LOAD-BEARING: the eleven original steps run FIRST and unchanged, so a
 * receipt whose policy was SUPERSEDED still says SUPERSEDED rather than reporting a command-count
 * mismatch that is merely a consequence of the re-pin. The command-list checks append after them. */
export function receiptProvenance(receipt, { tier, pinnedHash, pinnedTriples }) {
  if (!GATE_TIERS.includes(tier)) throw new Error(`not a gate tier: '${tier}' (tiers: ${GATE_TIERS.join(', ')})`);
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { ok: false, why: 'no receipt recorded' };
  }
  if (receipt.tier !== tier) {
    return { ok: false, why: `it carries no gate provenance (tier is ${JSON.stringify(receipt.tier ?? null)}, expected '${tier}') — only \`legion gate\` mints receipts` };
  }
  if (typeof receipt.commandPolicyHash !== 'string' || receipt.commandPolicyHash.length === 0) {
    return { ok: false, why: 'it carries no gate provenance (commandPolicyHash is missing) — only `legion gate` mints receipts' };
  }
  if (!Number.isInteger(receipt.declaredCommands) || receipt.declaredCommands < 0) {
    return { ok: false, why: 'it carries no gate provenance (declaredCommands is missing or not a non-negative integer)' };
  }
  if (!Array.isArray(receipt.results)) {
    return { ok: false, why: 'it carries no gate provenance (results[] is missing)' };
  }
  if (typeof receipt.head !== 'string' || typeof receipt.treeHash !== 'string') {
    return { ok: false, why: 'it carries no gate provenance (head/treeHash must be the strings the kernel derived)' };
  }
  if ('allowConfig' in receipt && typeof receipt.allowConfig !== 'boolean') {
    return { ok: false, why: 'its allowConfig waiver is not a boolean' };
  }
  if ('repinnedFrom' in receipt && typeof receipt.repinnedFrom !== 'string') {
    return { ok: false, why: 'its repinnedFrom audit field is not a string' };
  }
  if (typeof pinnedHash !== 'string' || pinnedHash.length === 0) {
    return {
      ok: false,
      why: `no ${tier} gate command policy is PINNED in feature.json — nothing declares what this ` +
        `feature is certified by; pin the live policy with \`legion gate run --repin\``,
    };
  }
  if (receipt.commandPolicyHash !== pinnedHash) {
    return {
      ok: false,
      why: `the gate policy it ran under has been SUPERSEDED (receipt policy ${receipt.commandPolicyHash}, ` +
        `pinned policy ${pinnedHash}) — re-gate under the current pin`,
    };
  }
  // --- the receipt must reproduce the PINNED POLICY, not merely name its hash -----------
  // Comparing only two hashes and a handful of types leaves a bypass reachable: `results: []` with
  // `declaredCommands: 1` and a commandPolicyHash COPIED out of the neighbouring feature.json would
  // pass. From here on the pinned command LIST is read.
  if (!Array.isArray(pinnedTriples)) {
    return {
      ok: false,
      why: `the pinned ${tier} gate policy names a hash but not the COMMANDS it covers (feature.json ` +
        `has no commandPolicy.${tier} list), so what this receipt claims to have run cannot be ` +
        `checked — re-pin the live policy with \`legion gate run --repin\``,
    };
  }
  for (let i = 0; i < pinnedTriples.length; i += 1) {
    const triple = pinnedTriples[i];
    const malformed = !Array.isArray(triple)
      || typeof triple[0] !== 'string' || triple[0].length === 0
      || !Array.isArray(triple[1]) || !triple[1].every((a) => typeof a === 'string');
    if (malformed) {
      return {
        ok: false,
        why: `the pinned ${tier} gate policy is malformed at command ${i} (expected ` +
          `[name, argv[], timeoutMs]) — re-pin the live policy with \`legion gate run --repin\``,
      };
    }
  }
  // PIN SELF-CONSISTENCY — it stops the pin being edited by HALVES, and that is all it stops.
  // Without it, emptying `commandPolicy[tier]` while KEEPING the copied hash would make every check
  // below pass vacuously. With it, that particular edit refuses. It does NOT raise the cost of the
  // forgery overall: a forger who moves BOTH halves to the empty policy is self-consistent by
  // construction and still passes (gate.mjs's residual states this outright). It reads only what it
  // already had, and it can never refuse a pin a real `feature start` or `--repin` wrote —
  // commandPolicyPin writes both halves from one definition.
  if (policyPayloadHash(pinnedTriples, tier) !== pinnedHash) {
    return {
      ok: false,
      why: `the pinned ${tier} command list does not hash to the pinned policy ${pinnedHash} — ` +
        `feature.json's commandPolicy has been hand-edited, so the pin no longer describes a real ` +
        `policy; re-pin the live policy with \`legion gate run --repin\``,
    };
  }
  if (receipt.declaredCommands !== pinnedTriples.length) {
    return {
      ok: false,
      why: `it claims ${receipt.declaredCommands} declared ${tier} command(s) while the pinned policy ` +
        `declares ${pinnedTriples.length} — a receipt must account for exactly the pinned policy`,
    };
  }
  // PER-ELEMENT SHAPE, required-fields not exact-keys (a future per-command field must stay
  // additive, exactly as the receipt's own optional fields are).
  for (let i = 0; i < receipt.results.length; i += 1) {
    const r = receipt.results[i];
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, why: `its results[${i}] is not a command result object` };
    }
    if (typeof r.name !== 'string' || r.name.length === 0) {
      return { ok: false, why: `its results[${i}].name is missing or not a non-empty string` };
    }
    if (!Array.isArray(r.argv) || r.argv.length === 0 || !r.argv.every((a) => typeof a === 'string')) {
      return { ok: false, why: `its results[${i}] ('${r.name}') has no argv — expected a non-empty array of strings` };
    }
    if (r.exitCode !== 0) {
      return {
        ok: false,
        why: `its results[${i}] ('${r.name}') records exitCode ${JSON.stringify(r.exitCode ?? null)} — a ` +
          `receipt is minted only on a GREEN run, so a recorded non-zero exit is incoherent evidence`,
      };
    }
    if (typeof r.ms !== 'number' || !Number.isFinite(r.ms) || r.ms < 0) {
      return { ok: false, why: `its results[${i}] ('${r.name}') has no ms — expected a non-negative number of milliseconds` };
    }
  }
  // MATCH THE PINNED POLICY. The comparison is POSITIONAL, never over a set of names: duplicate
  // declared names are legal (validateGatesConfig does not de-duplicate) and a project may legally
  // declare a command literally named `validate`.
  const declared = pinnedTriples.length;
  if (receipt.results.length < declared) {
    return {
      ok: false,
      why: `it records ${receipt.results.length} command result(s) for ${declared} pinned ${tier} ` +
        `command(s) — the results it does not carry are the commands it did not run`,
    };
  }
  for (let i = 0; i < declared; i += 1) {
    const [name, argv] = pinnedTriples[i];
    if (receipt.results[i].name !== name) {
      return {
        ok: false,
        why: `its results[${i}] is '${receipt.results[i].name}' where the pinned ${tier} policy declares ` +
          `'${name}' — THE ORDER IS POLICY, because it is the EXECUTION order (cheap → expensive, ` +
          `stop at the first failure)`,
      };
    }
    if (!sameArgv(receipt.results[i].argv, argv)) {
      return {
        ok: false,
        why: `its results[${i}] ('${name}') ran ${JSON.stringify(receipt.results[i].argv)} where the pinned ` +
          `${tier} policy declares ${JSON.stringify(argv)}`,
      };
    }
  }
  // AT MOST ONE trailing entry, and only the TASK tier's own `validate`: gate.mjs builds the queue
  // as the declared names in tier order and then optionally pushes the task's validate, which the
  // boundary tier never does. THE VALIDATE'S ARGV IS DELIBERATELY NOT COMPARED — it is PLAN-owned,
  // bound by the plan approval and (for the {script,sha256} shape) by its own script digest, and
  // outside commandPolicyHash on purpose; comparing it would couple the policy to every plan edit.
  const extra = receipt.results.length - declared;
  if (extra > 1) {
    return {
      ok: false,
      why: `it records ${extra} command result(s) beyond the ${declared} pinned ${tier} command(s) — at ` +
        `most one may follow them, and only the task's own \`validate\``,
    };
  }
  if (extra === 1) {
    const trailing = receipt.results[declared];
    if (tier !== 'task') {
      return {
        ok: false,
        why: `it records a trailing '${trailing.name}' beyond the ${declared} pinned ${tier} command(s) — ` +
          `the boundary tier never runs a task's validate`,
      };
    }
    if (trailing.name !== 'validate') {
      return {
        ok: false,
        why: `it records a trailing '${trailing.name}' beyond the ${declared} pinned ${tier} command(s) — ` +
          `only the task's own \`validate\` may follow the declared commands`,
      };
    }
  }
  return { ok: true };
}

/** Deterministic review ordering for the pre-merge subject (reviews append in wall order).
 * The sort key is the WHOLE stringified record, INCLUDING `subjectHash`, on
 * purpose (header REVIEWS BIND): excluding it would let a review re-bound to different evidence
 * leave the pre-merge subject unmoved, i.e. a review set that changed without changing the
 * subject. FROZEN with that field in; pre-merge approvals recorded without it no longer validate. */
export function canonicalReviews(reviews) {
  return [...reviews].sort((a, b) => {
    const ka = JSON.stringify(a);
    const kb = JSON.stringify(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/** Drop `fromKind` and every approval that TRANSITIVELY depends on it (its DAG descendants);
 *  ancestors and independent siblings (e.g. preview↔pre-merge) survive. */
export function cascadeInvalidate(approvals, fromKind) {
  if (!(fromKind in APPROVAL_PARENT)) {
    throw new Error(`not an approval kind: '${fromKind}' (kinds: ${APPROVAL_CHAIN.join(', ')})`);
  }
  const dependsOn = (kind) => { // does `kind` reach `fromKind` walking parent edges?
    for (let k = kind; k != null; k = APPROVAL_PARENT[k]) if (k === fromKind) return true;
    return false;
  };
  const next = {};
  for (const [k, v] of Object.entries(approvals)) if (!dependsOn(k)) next[k] = v;
  return next;
}

// --- manifest IO (schema-guarded, revision-bumping) ---------------------------------------
const featurePathOf = (dossier) => join(dossier, 'feature.json');
const tasksPathOf = (dossier) => join(dossier, 'tasks.json');

/** Read a manifest and assert schemaVersion 1 — an unknown schema dies loudly (never a default). */
function readManifest(path) {
  const doc = readJson(path); // missing/corrupt ⇒ throws naming the path
  if (doc.schemaVersion !== 1) {
    throw new Error(`unknown schemaVersion ${JSON.stringify(doc.schemaVersion)} in ${path} — this kernel reads/writes schemaVersion 1 only`);
  }
  return doc;
}

function loadFeature(dossier) {
  const p = featurePathOf(dossier);
  if (!existsSync(p)) throw new Error(`no feature.json at ${p} — run \`legion feature start\` first`);
  return readManifest(p);
}

function loadTasks(dossier) {
  const p = tasksPathOf(dossier);
  if (!existsSync(p)) throw new Error(`no tasks.json at ${p} — run \`legion state init\` first`);
  return readManifest(p);
}

/** Write `doc` back with revision+1 and updatedAt=now. The op's SINGLE manifest write.
 * EXPORTED for `legion finalize` (src/cli/finalize.mjs) — the one writer of feature.json
 * outside this module. It obeys the same rule every op here does: ONE manifest per command,
 * revision+1, atomic rename. Exported rather than reimplemented so the revision discipline
 * has exactly one definition. */
export function bumpWrite(path, doc, now) {
  writeJson(path, { ...doc, revision: doc.revision + 1, updatedAt: now });
}

/** The half of a task row the PLAN owns. Everything else on a row (status, attempt, receipt,
 * answers, startedAt, doneAt) is kernel-DERIVED evidence an import must never forge. */
function planContent(x) {
  return JSON.stringify({
    id: x.id,
    title: x.title,
    depends_on: x.depends_on ?? [],
    milestone: x.milestone ?? null,
    validate: x.validate ?? null,
    notes: x.notes ?? null,
  });
}

/** One incoming row, reduced to plan content with the kernel's own status/attempt — the shape
 * every canonical row has. THE PROJECTION IS THE ENFORCEMENT, and it belongs here rather than
 * only in the caller: the docblock above claims a supplied `receipt` can never enter tasks[],
 * but comparing with planContent() only DECIDES things, it does not strip, so a row spread
 * through the merge carried whatever else was on it. `legion plan check --import` whitelists
 * too (src/cli/plan.mjs) and that is the reachable path today — but seedTasks is exported, and
 * an invariant asserted by the kernel has to be held by the kernel. A forged
 * `receipt.treeHash` = the current tree makes `gate verify-receipt` and `task-done` both pass
 * with no gate ever run, which is the single worst outcome in this system.
 * Key order matches what the importer already produced, so first-import bytes are unchanged. */
function projectPlanRow(x) {
  const row = {
    id: x.id,
    title: x.title,
    status: 'pending',
    attempt: 0,
    depends_on: x.depends_on ?? [],
    milestone: x.milestone,
  };
  if (x.validate !== undefined) row.validate = x.validate;
  if (x.notes !== undefined) row.notes = x.notes;
  return row;
}

/** A row carries RECORDED EVIDENCE once a gate has certified a tree for it, or once it is
 * done. That — not "someone typed task-start" — is what a re-import must never overwrite:
 * `started` is an intention, a receipt is a fact. The distinction is load-bearing, because the
 * build loop marks a task `started` before dispatching its builder and there is no un-start
 * op; protecting `started` alone would make a failed task's plan text permanently unrewritable
 * and wall off the loop's own bounce-up path (workflows/build-loop.js: a task that turns out
 * thin, wrong or missing a dependency goes back to the architect and re-import). */
const hasEvidence = (x) => x.status === 'done' || x.receipt != null;

/** Key-order-independent value equality. seedTasks needs it because a row REBUILT by spreading
 * differs byte-wise from the stored row that ops appended fields to over time, while being the
 * same value — and byte-wise is exactly the wrong question to ask when deciding whether a plan
 * changed (see seedTasks). */
function sameValue(a, b) {
  const canon = (v) => JSON.stringify(v, (_k, val) => (
    val !== null && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val
  ));
  return canon(a) === canon(b);
}

/** Seed canonical tasks[] from a validated candidate plan (invoked directly by
 * `legion plan check --import`, NOT via the argv OPS table — it needs structured plan
 * DATA, not argv, so there is no shell-string surface to fabricate through).
 *
 * AN IMPORT REPLACES PLAN CONTENT ONLY, AND MAY NOT OVERWRITE RECORDED EVIDENCE. It refuses
 * when a row with evidence (done, or holding a gate receipt — see hasEvidence) would be
 * REMOVED or REWRITTEN; it ACCEPTS appends, and edits to rows that have produced no evidence
 * yet, carrying every completed row through untouched. The narrow guard is what makes the two
 * documented recovery paths reachable at all: the pre-merge fixup (architect appends a task ⇒
 * re-import ⇒ build ⇒ re-gate ⇒ re-approve), which a blanket started/done refusal made
 * impossible since by pre-merge every task is done; and the build loop's bounce-up, where a
 * task that turns out wrong is rewritten by the architect — the loop having already marked it
 * `started`, with no op that un-starts it.
 *
 * A REWRITTEN ROW IS RESET, NOT PATCHED. Its status, attempt, startedAt and recorded `answers`
 * all described the OLD text; carrying them into new text is the same hazard task-answer
 * already refuses on a done task ("a stale answer would ride into a re-brief"). Only a row
 * whose plan content is UNCHANGED keeps its kernel-owned fields. The reset ids — and the ids
 * dropped from the plan entirely — are returned so the caller can say out loud what went.
 *
 * KNOWN BOUNDARY, stated rather than left to be rediscovered: rewriting a `started` row assumes
 * ONE SESSION PER FEATURE, which is the design (skills/feature/SKILL.md) but is not locked. If
 * a builder were still in flight for a task this import resets, its later `gate run --task`
 * would record a receipt against the rewritten row, certifying a tree its gate ran the OLD
 * `validate` over. It stays narrow — `task-done` re-derives HEAD's tree, so the stale receipt
 * only survives if the rewritten task produces no commit at all — and closing it properly needs
 * a receipt bound to a task GENERATION, not a status check here.
 *
 * THE CASCADE IS HALF THIS FUNCTION'S JOB. The plan approval's subject is
 * `combinedPlanHash(plan.md bytes, tasks[])` — BOTH halves. artifact-record cascades on the
 * plan.md half; nothing cascaded on the tasks[] half, so a re-import that changed only the
 * task list left `approvals.plan` recorded while its subject silently drifted. Same rule as
 * artifact-record: cascade only when the list actually CHANGED, so re-importing an identical
 * plan never forces the workflow backward.
 *
 * "CHANGED" IS A VALUE QUESTION, NEVER A BYTE QUESTION, and getting that wrong is subtle
 * enough to have shipped once already. A row rebuilt here by spreading gets this function's
 * key order; the stored row has whatever order the ops appended in (task-start adds startedAt,
 * then `gate run` adds receipt). Comparing serializations therefore reported CHANGED for a
 * re-import of literally identical bytes — dropping a valid plan approval — and, worse, wrote
 * the reordered row, moving the `tasks[]` half of the plan subject for free. So an unchanged
 * row is returned AS THE STORED OBJECT ITSELF, which keeps the write byte-identical and lets
 * the top-level comparison stay a plain one. Single revision-bumping write. */
export function seedTasks(dossier, tasks, now) {
  const t = loadTasks(dossier); // schema-guarded; throws the loud "run `legion state init`" if absent
  const incoming = new Map(tasks.map((x) => [x.id, x]));
  const clobbered = t.tasks
    .filter(hasEvidence)
    .filter((x) => {
      const next = incoming.get(x.id);
      return !next || planContent(next) !== planContent(x);
    })
    .map((x) => x.id);
  if (clobbered.length > 0) {
    throw new Error(
      `refusing to import plan: ${clobbered.length} task(s) with recorded gate evidence would be ` +
      `removed or rewritten (${clobbered.join(', ')}) — a re-import may append tasks, and may rewrite ` +
      `a task no gate has certified yet, but never one that is done or already holds a receipt`,
    );
  }
  const existing = new Map(t.tasks.map((x) => [x.id, x]));
  const reset = [];
  const merged = tasks.map((x) => {
    const row = projectPlanRow(x); // nothing kernel-owned survives from the caller, ever
    const prev = existing.get(x.id);
    if (!prev) return row;
    if (planContent(prev) !== planContent(x)) {
      // Rewritten, and guaranteed evidence-free by the guard above: the projected row starts
      // over (pending, attempt 0, no receipt, no answers). Reported, never silent.
      reset.push(x.id);
      return row;
    }
    const carried = { status: prev.status, attempt: prev.attempt };
    for (const k of ['receipt', 'answers', 'startedAt', 'doneAt']) {
      if (prev[k] !== undefined) carried[k] = prev[k];
    }
    const rebuilt = { ...row, ...carried };
    return sameValue(rebuilt, prev) ? prev : rebuilt; // identical ⇒ the STORED bytes, verbatim
  });
  // A row that VANISHES from the plan is legitimate (the guard above already refused to drop
  // one carrying evidence), but it is never silent: it may take recorded human answers with
  // it, and a session that does not know they are gone will not think to ask again.
  const removed = t.tasks.filter((x) => !incoming.has(x.id)).map((x) => x.id);
  const changed = JSON.stringify(merged) !== JSON.stringify(t.tasks);
  const approvals = changed ? cascadeInvalidate(t.approvals, 'plan') : t.approvals;
  bumpWrite(tasksPathOf(dossier), { ...t, tasks: merged, approvals }, now);
  return { reset, removed, changed };
}

function pkgVersion() {
  return readJson(fileURLToPath(new URL('../../package.json', import.meta.url))).version;
}

// --- git evidence (derived, never supplied) -----------------------------------------------
// These three ARE the evidence, and an UNHARDENED git inherits the config and GIT_* env
// that redefine what they report — which is why git() is hardened by default and there is
// no unhardened helper to reach for (kernel/git.mjs header E).
// THE DIRTY CHECK IS DERIVED, NOT INFERRED FROM ABSENCE OF OUTPUT (kernel/git.mjs
// header F). `status --porcelain` === '' is fail-OPEN by SHAPE: any
// config that silences status reads as clean (status.showUntrackedFiles=no would let the
// receipt writer bless a worktree holding an untracked `sk-…` key; so would core.excludesFile;
// so would submodule.<name>.ignore=all / diff.ignoreSubmodules=all, which also hides a MOVED
// GITLINK). isClean instead writes the worktree into a temp index and
// compares the resulting TREE to HEAD's — the same property this receipt certifies, and one
// no config can forge short of a hash collision.
// BLAST RADIUS (deliberate, and bounded): all three are derivations invoked with an EXPLICIT
// cwd, so nothing here can change WHICH repository they read — hardening only stops ambient
// env (GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE) from changing it. No caller and no test depends
// on user config influencing them. Where
// a silencing knob (any of the four) would previously have let a receipt be recorded, it now
// REFUSES — enforced in recordGateReceipt below, which is the only writer left.
// An uninitialised submodule directory reads DIRTY (its gitlink
// is absent from the derived tree) — fail-closed; run `git submodule update --init`.
const headOf = (worktree) => git(['rev-parse', 'HEAD'], worktree);
const treeOf = (worktree) => git(['rev-parse', 'HEAD^{tree}'], worktree);
// THE one shared dirty check — three hand-copied status argvs had already drifted apart.
const isClean = isWorktreeClean;

/** The recorded artifact for `kind`, or a loud refusal — the subject is missing. */
function requireArtifact(tasks, kind) {
  const a = tasks.artifacts[kind];
  if (!a) throw new Error(`no ${kind} artifact recorded — \`legion state artifact-record ${kind} <path>\` first`);
  return a;
}

/** The interface-contract BYTES this feature's spec subject binds, or null when there is no
 * contract in play — the ordinary single-repo case, and the one that must stay byte-identical
 * (its hash is pinned into every sibling's spec content).
 *
 * WHERE THE CONTRACT IS FOUND, PER ROLE, and why the two answers differ:
 *   - SECONDARY: `initiative.contract.path` — the reference `feature start` derived by reading the
 *     PRIMARY's dossier. The path is used; the recorded HASH deliberately is NOT. The subject must
 *     bind what is on disk NOW, so that an edit of the primary's contract moves this feature's
 *     spec subject; binding the recorded hash would freeze the subject against a value that only
 *     changes when someone re-starts the feature, i.e. exactly the stale-evidence defect.
 *   - PRIMARY (and any other role a manifest carries): its OWN recorded `contract` artifact. The
 *     primary HOSTS the file, so its block carries no reference (feature.mjs: there is nothing to
 *     reference at its own start) — and the fact "this feature's contract is that file" already
 *     lives in tasks.json where every other artifact fact lives. THE ALTERNATIVE WAS REJECTED
 *     DELIBERATELY: having `artifact-record contract` write a {path,hash} ref into feature.json
 *     would store a second copy of a fact the manifest already holds (facts-not-conclusions — a
 *     copy drifts and outlives its evidence) and would make one op write two manifests. Reading
 *     the artifact record is the same fact, asked at the moment it gates something.
 *     THE CONTRACT SPANS BOTH REPOSITORIES, so the primary's spec must bind it too — otherwise
 *     "an edit invalidates BOTH siblings' spec approvals" is satisfied by the
 *     secondary alone and the repo that OWNS the contract is the one that never notices it moved.
 *
 * THE TWO ANSWERS ARE HELD ON THE SAME FILE BY A REFUSAL, NOT BY HOPE: the secondary
 * resolves a PATH pinned at start, the primary resolves its own record, and those could diverge the
 * moment `artifact-record contract` accepted a different path — the primary's spec would fall while
 * the sibling kept binding an abandoned file that is still there and still hash-valid. artifactRecord
 * therefore REFUSES to move a contract while the block stands, so within one initiative there is
 * exactly one contract file and "an edit falls BOTH siblings" holds for every reachable edit, not
 * only for in-place ones. Do not weaken that refusal without giving this function a way to notice.
 *
 * GATED ON THE INITIATIVE BLOCK, always: a feature with no block returns null even if it recorded
 * a `contract` artifact, so no non-initiative feature's spec subject can change under this clause.
 * An UNKNOWN role resolves like the host rather than like "no contract": a hand-edited role must
 * not be a way to silently drop the binding (the narrow-role reading belongs to
 * isInitiativeSecondary, where an unknown role means "the ordinary requirement stands" — the
 * fail-CLOSED answer there and, for the same reason, here).
 *
 * ACCEPTED CONSEQUENCE, stated: recording a contract for the FIRST time after the spec was
 * approved moves the spec subject and drops that approval. That is correct and fail-closed — the
 * spec is now bound to a contract nobody approved it against — and it costs one
 * `decision-record spec`.
 * A contract that is REFERENCED (or recorded) and then unreadable THROWS, which approvalValid
 * reads as "invalid" through its catch — the existing missing-artifact direction, fail-closed for
 * free — while decision-record surfaces the message itself. */
function specContractBytes(tasks, feature) {
  const init = feature?.initiative;
  if (init == null) return null;
  const read = (path, what) => {
    try { return readFileSync(path); }
    catch (err) {
      throw new Error(
        `the spec subject binds ${what} at ${path}, which cannot be read (${err.message}) — the ` +
        `interface contract spans both repositories of initiative '${init.id}', so a spec approval ` +
        `cannot be computed while it is gone; restore it (or re-record the primary's contract and ` +
        `re-start this feature) before recording a spec decision`,
      );
    }
  };
  if (init.role === 'secondary') {
    const ref = init.contract;
    if (ref == null || typeof ref.path !== 'string' || ref.path.length === 0) {
      throw new Error(
        `the initiative '${init.id}' block carries no usable contract reference ({path, hash}) — ` +
        `the manifest has been hand-edited; re-start this feature with ` +
        `\`legion feature start … --initiative ${init.id}\` so the reference is re-derived`,
      );
    }
    return read(ref.path, "the primary's interface contract");
  }
  const a = tasks.artifacts?.contract;
  if (a == null || typeof a.path !== 'string' || a.path.length === 0) return null;
  return read(a.path, 'this feature\'s recorded interface contract');
}

/** Recompute a decision's subject hash from live evidence. Throws when the subject is
 * missing (artifact unrecorded/deleted, or boundary receipt absent for pre-merge).
 *
 * THIS IS THE ONE SHARED FORMULA and that sharing IS the design (header APPROVALS): `decision-record`
 * records what this returns, `approvalValid` re-derives it, `stage-complete` and corollary 1's
 * prefix walk call `approvalValid`, and `legion finalize` imports the same predicate — so the
 * spec clause below reaches every one of them with ZERO changes to their code. A second copy
 * of any of these formulas anywhere is the drift that makes "the cascade is verified, not assumed"
 * untrue, which is why there is none.
 *
 * THE SPEC FRAMING: with a contract in play the subject is
 * `sha256(sha256(spec bytes) + ':' + sha256(contract bytes))` — the SAME two-digest framing
 * combinedPlanHash uses, and unambiguous for the same reason: each half is a FIXED-WIDTH 64-char
 * hex digest and ':' is not a hex character, so no reshuffling of bytes between the two files can
 * produce the same input string. (Concatenating the raw file bytes with a separator would be the
 * literal reading and is weaker: a separator can occur INSIDE either file.) */
function computeSubjectHash(kind, tasks, feature) {
  switch (kind) {
    case 'intake':
      return sha256(readFileSync(requireArtifact(tasks, 'intent').path));
    case 'spec': {
      const specBytes = readFileSync(requireArtifact(tasks, 'spec').path);
      const contractBytes = specContractBytes(tasks, feature);
      // NO CONTRACT ⇒ THE SINGLE-HASH FORMULA, byte for byte. Every single-repo feature, every
      // manifest written before initiatives existed, and every existing test depend on this arm.
      if (contractBytes === null) return sha256(specBytes);
      return sha256(`${sha256(specBytes)}:${sha256(contractBytes)}`);
    }
    case 'plan':
      return combinedPlanHash(readFileSync(requireArtifact(tasks, 'plan').path), tasks.tasks);
    case 'preview':
      return sha256(readFileSync(requireArtifact(tasks, 'preview').path));
    case 'pre-merge': {
      if (!tasks.receipts.boundary) {
        throw new Error('pre-merge subject requires a boundary receipt — `legion gate run --boundary` first (the gate is the only minter)');
      }
      return sha256(JSON.stringify({
        head: headOf(feature.worktree),
        boundary: tasks.receipts.boundary,
        reviews: canonicalReviews(tasks.reviews),
      }));
    }
    default:
      throw new Error(`not a decision kind: '${kind}' (kinds: ${DECISION_KINDS.join(', ')})`);
  }
}

/** True iff the approval exists AND its stored subjectHash still matches live evidence.
 * Any recompute failure (missing artifact/receipt) reads as INVALID, never a throw.
 * EXPORTED for `legion finalize`, which must not carry a second copy of the pre-merge hash:
 * the subject formula is FROZEN (header APPROVALS) precisely because the recorder and every
 * verifier have to recompute it byte-identically or every approval silently invalidates. */
export function approvalValid(kind, tasks, feature) {
  const appr = tasks.approvals[kind];
  if (!appr) return false;
  try { return computeSubjectHash(kind, tasks, feature) === appr.subjectHash; }
  catch { return false; }
}

/** Does an initiative reference STILL describe the file it was derived from? {ok:true}, or
 * {ok:false, why} naming the path, WHICH check failed, and what that means (header INITIATIVES).
 * A reference is `{path, hash}` — an ABSOLUTE path in the PRIMARY's dossier plus the sha256 the
 * kernel derived by reading that file at `feature start`. Both halves are re-read HERE, on every
 * call, because the reference is a FACT about bytes and "is it still true" is a PREDICATE: a copy
 * of the answer would be the stored conclusion this design exists to kill.
 * FAIL-CLOSED IN EVERY DIRECTION — a malformed/absent ref, an unreadable file and a hash mismatch
 * are all "does not validate", never a throw and never a pass. The two failures are DISTINGUISHED
 * in `why` because their remedies differ: a GONE recap means the primary's dossier moved (nothing
 * to re-reference), while a CHANGED one means the agreement itself moved and must be re-agreed.
 * EXPORTED so the by-reference intake clause and the spec-subject clause share ONE definition —
 * a second copy is the drift that makes "the cascade is verified, not assumed" untrue. */
export function initiativeRefValid(ref, what) {
  if (ref == null || typeof ref.path !== 'string' || ref.path.length === 0
      || typeof ref.hash !== 'string' || ref.hash.length === 0) {
    return { ok: false, why: `the initiative block carries no usable ${what} reference ({path, hash}) — the manifest has been hand-edited; re-start this feature with \`legion feature start … --initiative <id>\` so the reference is re-derived` };
  }
  let bytes;
  try { bytes = readFileSync(ref.path); }
  catch (err) {
    return { ok: false, why: `the primary's ${what} at ${ref.path} cannot be read (${err.message}) — the file it was referenced against is GONE, so nothing backs this reference any more` };
  }
  const live = sha256(bytes);
  if (live !== ref.hash) {
    return { ok: false, why: `the primary's ${what} at ${ref.path} CHANGED — referenced sha256 ${ref.hash}, live ${live}; what this feature is bound to is no longer what is on disk` };
  }
  return { ok: true };
}

/** Is this feature an initiative SECONDARY — the only kind that may complete intake by reference?
 * Deliberately narrow: the role must be exactly
 * `secondary`, so a hand-written role the kernel does not know reads as "no alternative" and the
 * ordinary approval requirement stands, unchanged.
 * THE ROLE ALONE OPENS THE ARM — whether the reference is USABLE is initiativeRefValid's question,
 * asked next. Treating a role-without-a-reference as "not a secondary" would answer a broken
 * manifest with a message about a missing approval, sending the operator to record one instead of
 * to the manifest that is actually wrong. Both paths refuse; only one of them says why. */
const isInitiativeSecondary = (feature) => feature?.initiative?.role === 'secondary';

// --- the stage machine: conclusions RE-DERIVED, never stored (header THE STAGE MACHINE) -------

/** The subject hash a review of `subject` binds, derived by SUBJECT KIND (header REVIEWS BIND):
 * `plan` → the plan subject (computeSubjectHash('plan') — the SAME frozen combinedPlanHash the
 * plan approval binds, so recorder and verifier cannot diverge), everything else → the worktree
 * TREE. Throws when the subject's evidence is missing (no plan artifact recorded yet) — record
 * time surfaces that loudly; verify time reads it as "does not bind" via the catch below. */
function reviewSubjectHash(subject, tasks, feature) {
  if (subject === 'plan') return computeSubjectHash('plan', tasks, feature);
  return treeOf(feature.worktree);
}

/** The LATEST plan-critic verdict ON THE PLAN, never merely some passing one. `reviews.some(pass)`
 * matched any pass ever recorded, and the plan approval's subject does NOT hash `reviews` (unlike
 * pre-merge's) — so one round-1 pass permanently pre-satisfied the check while a later FAIL stood
 * recorded. Not latent: a feature re-enters the plan stage whenever work is appended (the
 * pre-merge fixup, skills/feature/SKILL.md), and those trips are always a second-or-later round.
 * SUBJECT `plan` ONLY: a plan-critic verdict recorded against `feature` is tree-bound and
 * would survive the very plan edit this row exists to catch — a review of the tree is not a
 * review of the plan, whoever recorded it. Ordering comes from the array's APPEND order, which
 * reviewRecord owns — never from `at`, which is caller-supplied via --now. */
function latestPlanCritic(tasks) {
  const verdicts = tasks.reviews.filter((r) => r.role === 'plan-critic' && r.subject === 'plan');
  return verdicts.length > 0 ? verdicts[verdicts.length - 1] : null;
}

/** Does this verdict still describe the live subject? Compares the STORED subjectHash against the
 * same derivation review-record performed (one definition: reviewSubjectHash). FAIL-CLOSED on a
 * record with no derived hash — a hand-written review, or one recorded before this field existed,
 * is bound to nothing, and counting it would reopen the caller-assertion hole through the
 * manifest — and on any derivation failure (subject
 * evidence missing reads as "does not bind", never a throw; same posture as approvalValid).
 * EXPORTED for `legion finalize` C5, which must not re-implement the comparison. */
export function reviewBindingHolds(review, tasks, feature) {
  if (typeof review.subjectHash !== 'string' || review.subjectHash.length === 0) return false;
  try { return reviewSubjectHash(review.subject, tasks, feature) === review.subjectHash; }
  catch { return false; }
}

/** Feature-level sign-off scope: `feature` or `milestone:<id>`. A `task:<id>` review is per-task
 * sign-off and never satisfies a PROFILE requirement — the same line finalize's C5 draws. */
const productScope = (r) => r.subject === 'feature' || String(r.subject).startsWith('milestone:');

/** THE PREREQUISITE TABLE, one arm per stage, re-derived from the manifests on every call.
 * Returns {ok:true} or {ok:false, why} — `why` is the operator-facing half of
 * every consumer's refusal and names what is missing plus the op that records it. This is a PURE
 * function of (tasks, feature) and live git/dossier evidence via approvalValid; it reads no
 * stored completion, ever (header THE STAGE MACHINE). `finalize` has no row: its exit is
 * `legion finalize` + `close delivered`, which carry their own chains. */
export function stageSatisfied(stage, tasks, feature) {
  const ok = { ok: true };
  const fail = (why) => ({ ok: false, why });
  switch (stage) {
    case 'intake': {
      // Omitting this row would leave the recap-and-agreement guarantee outside the state machine
      // entirely. Intake is also the LAST moment
      // classification can happen before later prerequisites depend on the profile.
      if (!tasks.artifacts.intent) {
        return fail('no intent artifact recorded — `legion state artifact-record intent <path>` after the recap');
      }
      if (!approvalValid('intake', tasks, feature)) {
        // THE ONE ADDITIVE CLAUSE (header INITIATIVES). An
        // initiative SECONDARY may satisfy the recap-and-agreement half BY REFERENCE: the recap
        // happened ONCE, with the human, in the primary's intake session, and a second recap
        // conversation would be ceremony while a rubber stamp would be a silent invariant break.
        // ALTERNATIVE, NOT REPLACEMENT — this arm is reached only when no hash-valid approval
        // exists, so a secondary that DID hold its own recap conversation is not punished for it.
        // The guarantee still holds because the reference is re-validated HERE, on every call: a
        // recap that was deleted or edited after this feature completed intake stops satisfying
        // the row, which is what makes a later forward `stage-enter` refuse (corollary 1's prefix
        // walk calls straight into this function).
        if (!isInitiativeSecondary(feature)) {
          return fail('no hash-valid intake approval — record/re-record it with `legion state decision-record intake`');
        }
        const byRef = initiativeRefValid(feature.initiative.recap, 'recap');
        if (!byRef.ok) {
          return fail(
            `no hash-valid intake approval, and the initiative '${feature.initiative.id}' recap REFERENCE does not validate: ${byRef.why}. ` +
            `Either re-agree in THIS feature (\`legion state decision-record intake\` after recording its own intent artifact) ` +
            `or, once the primary's recap is back in place, re-start this feature so the reference is re-derived`,
          );
        }
      }
      // CLASSIFICATION IS NEVER BY REFERENCE: the
      // profile selects THIS feature's review set, and a sibling's profile is chosen
      // independently. The clause above buys nothing here, deliberately.
      if (!PROFILES.includes(feature.profile)) {
        return fail(`the profile is '${feature.profile}' — classify with \`legion state escalate-profile <profile>\` (one of ${PROFILES.join(', ')}; unclassified is intake-only)`);
      }
      return ok;
    }
    case 'spec': {
      if (!tasks.artifacts.spec) {
        return fail('no spec artifact recorded — `legion state artifact-record spec <path>`');
      }
      if (!approvalValid('spec', tasks, feature)) {
        return fail('no hash-valid spec approval — record/re-record it with `legion state decision-record spec`');
      }
      return ok;
    }
    case 'plan': {
      // EXPRESS CARVE-OUT: on 'express' the critic is not mandatory —
      // ABSENCE is excused, and a stale pass (binding no longer holds) reads as absence, so the
      // binding check is skipped too. A recorded LATEST FAIL blocks on EVERY profile: an excused
      // review is one nobody performed, never one performed and rejected. A GUARD on this one
      // row, not a second profile table (header PROFILE IS LOAD-BEARING) — PROFILE_REVIEW_ROLES
      // is untouched.
      const critic = latestPlanCritic(tasks);
      const criticExcused = feature.profile === 'express';
      if (!critic && !criticExcused) {
        return fail('no plan-critic review of the PLAN recorded — the critic must review the current plan (`legion state review-record --role plan-critic --verdict pass --subject plan`)');
      }
      if (critic && critic.verdict !== 'pass') {
        return fail("the LATEST plan-critic review is a 'fail' — re-review the current plan (an older pass does not carry forward)");
      }
      if (!approvalValid('plan', tasks, feature)) {
        return fail('no hash-valid plan approval — record/re-record the plan decision');
      }
      if (critic && !criticExcused && !reviewBindingHolds(critic, tasks, feature)) {
        return fail('the LATEST plan-critic pass judged a DIFFERENT plan — its subject hash no longer matches plan.md + the task rows, so the verdict died with the plan it reviewed; re-review the current plan');
      }
      return ok;
    }
    case 'build': {
      // EVERY task done. A blocked or pending task is an unfinished build — the question protocol
      // makes blocked tasks ordinary, so any non-'done' status counts, by exclusion
      // rather than by enumerating statuses.
      const open = tasks.tasks.filter((x) => x.status !== 'done');
      if (open.length > 0) {
        return fail(`${open.length} task(s) not done: ${open.map((x) => `${x.id} (${x.status ?? 'pending'})`).join(', ')} — a blocked or pending task is an unfinished build`);
      }
      return ok;
    }
    case 'review': {
      if (!PROFILES.includes(feature.profile)) {
        return fail(`the profile is '${feature.profile}' — no review requirement is defined for an unclassified feature; classify with \`legion state escalate-profile <profile>\``);
      }
      const missing = PROFILE_REVIEW_ROLES[feature.profile].filter((role) => {
        const scoped = tasks.reviews.filter((r) => r.role === role && productScope(r));
        const latest = scoped.length > 0 ? scoped[scoped.length - 1] : null;
        return !latest || latest.verdict !== 'pass' || !reviewBindingHolds(latest, tasks, feature);
      });
      if (missing.length > 0) {
        return fail(`the '${feature.profile}' profile requires a passing review (subject 'feature' or 'milestone:<id>') from: ${missing.join(', ')} — record each with \`legion state review-record\``);
      }
      return ok;
    }
    case 'pre-merge': {
      if (!approvalValid('pre-merge', tasks, feature)) {
        return fail('no hash-valid pre-merge approval — record/re-record it with `legion state decision-record pre-merge`');
      }
      return ok;
    }
    case 'finalize':
      return ok;
    default:
      throw new Error(`not a stage: '${stage}' (stages: ${STAGES.join(', ')})`);
  }
}

/** The corollary-1 net: walk STAGES from intake THROUGH `through` (inclusive) and return the
 * FIRST stage whose prerequisites do not re-derive, as {stage, why} — or null when the whole
 * prefix holds. Every op that advances or closes the lifecycle calls this (stage-enter forward,
 * stage-complete, close delivered) and so does `legion finalize`: wiring it into one consumer
 * leaves the others reading stale conclusions. EXPORTED for finalize.mjs, which must not
 * re-implement the walk. */
export function unsatisfiedPrefix(through, tasks, feature) {
  const end = STAGES.indexOf(through);
  if (end < 0) throw new Error(`not a stage: '${through}' (stages: ${STAGES.join(', ')})`);
  for (const stage of STAGES.slice(0, end + 1)) {
    const s = stageSatisfied(stage, tasks, feature);
    if (!s.ok) return { stage, why: s.why };
  }
  return null;
}

// --- operations ---------------------------------------------------------------------------
// Signature: (dossier, { flags, positional }, now) → stdout summary string. positional[0]
// is the op name; positional[1..] are its arguments. Each validates prerequisites, derives
// evidence, then performs its single revision-bumping atomic write.

function init(dossier, _args, now) {
  const fPath = featurePathOf(dossier);
  if (!existsSync(fPath)) {
    throw new Error(`cannot init state: no feature.json at ${fPath} — run \`legion feature start\` first`);
  }
  const feature = readManifest(fPath);
  const tPath = tasksPathOf(dossier);
  if (existsSync(tPath)) throw new Error(`tasks.json already exists at ${tPath} — refusing to re-initialize`);
  writeJson(tPath, {
    schemaVersion: 1,
    legionVersion: pkgVersion(),
    revision: 0,
    featureId: feature.featureId,
    tasks: [],
    artifacts: {},
    approvals: {},
    reviews: [],
    receipts: { boundary: null },
    createdAt: now,
    updatedAt: now,
  });
  return `initialized tasks.json at ${tPath}`;
}

function stageEnter(dossier, { positional }, now) {
  const stage = positional[1];
  if (!STAGES.includes(stage)) throw new Error(`invalid stage '${stage}' — one of ${STAGES.join(', ')}`);
  const f = loadFeature(dossier);
  // A CLOSED feature accepts no transition — same rule as close() refusing a second close. This is
  // a refusal tightening, not a clearing mechanism: an amendment acts on an ACTIVE feature; after
  // close, new work is a new feature.
  if (f.status === 'delivered' || f.status === 'abandoned') {
    throw new Error(`feature is closed (status: ${f.status}) — a closed feature accepts no stage transition; new work is a new feature`);
  }
  const cur = STAGES.indexOf(f.stage);
  if (cur < 0) {
    throw new Error(`feature.json stage '${f.stage}' is not a stage this kernel knows (${STAGES.join(', ')}) — the manifest has been hand-edited; repair it before any transition`);
  }
  const tgt = STAGES.indexOf(stage);
  if (tgt === cur) {
    throw new Error(`already in stage '${stage}' — stage-enter records a transition, not a position`);
  }
  if (tgt > cur) {
    // FORWARD (header THE STAGE MACHINE): one hop at a time, AND the WHOLE prefix — intake up to
    // and including the CURRENT stage — must re-derive satisfied now. Not "the current stage was
    // completed": invalidation can reach a stage the lifecycle already moved past, and without
    // the prefix check every prerequisite in the table is skippable by walking the stages in
    // order and simply never calling stage-complete (the stageHistory would even look perfect).
    if (tgt !== cur + 1) {
      throw new Error(`cannot enter stage '${stage}' from '${f.stage}' — forward entry is one stage at a time, and the next stage is '${STAGES[cur + 1]}'`);
    }
    const t = loadTasks(dossier);
    const bad = unsatisfiedPrefix(f.stage, t, f);
    if (bad) {
      throw new Error(`cannot enter stage '${stage}': stage '${bad.stage}' does not re-derive satisfied — ${bad.why}`);
    }
  }
  // BACKWARD (tgt < cur), or a validated forward hop. Backward entry is always allowed, recorded,
  // and CLEARS NOTHING — nothing was trusted, so there is nothing to clear: still-good evidence
  // re-derives true on the way forward and the round trip costs nothing; changed evidence makes
  // forward entry refuse on its own. Do not add a clearing mechanism here — it is the
  // stored-conclusion mistake in a second costume.
  const stageHistory = [...(f.stageHistory ?? []), { stage, at: now }];
  bumpWrite(featurePathOf(dossier), { ...f, stage, stageHistory }, now);
  return `entered stage ${stage}`;
}

function stageComplete(dossier, { positional }, now) {
  const stage = positional[1];
  if (!STAGES.includes(stage)) throw new Error(`invalid stage '${stage}' — one of ${STAGES.join(', ')}`);
  const f = loadFeature(dossier);
  if (f.stage !== stage) throw new Error(`cannot complete stage '${stage}' — current stage is '${f.stage}'`);
  // The prerequisite table, re-derived for the WHOLE prefix up to and including this stage
  // (stageSatisfied carries each row; the plan row's LATEST-critic rationale lives on
  // latestPlanCritic). Completing a stage while an EARLIER one no longer re-derives would store
  // an ordered-looking trail over a broken lifecycle — corollary 1 applies here exactly as it
  // does to stage-enter forward.
  const t = loadTasks(dossier);
  const bad = unsatisfiedPrefix(stage, t, f);
  if (bad) {
    throw new Error(bad.stage === stage
      ? `stage-complete ${stage} refused: ${bad.why}`
      : `stage-complete ${stage} refused: earlier stage '${bad.stage}' does not re-derive satisfied — ${bad.why}`);
  }
  // completedStages is AUDIT TRAIL only — written here, consulted as authority nowhere (header).
  const completedStages = [...(f.completedStages ?? []), { stage, at: now }];
  bumpWrite(featurePathOf(dossier), { ...f, completedStages }, now);
  return `completed stage ${stage}`;
}

function artifactRecord(dossier, { positional }, now) {
  const kind = positional[1];
  const rel = positional[2];
  if (!ARTIFACT_KINDS.includes(kind)) throw new Error(`invalid artifact kind '${kind}' — one of ${ARTIFACT_KINDS.join(', ')}`);
  if (rel == null) throw new Error('artifact-record requires a <path>');
  const abs = isAbsolute(rel) ? rel : join(dossier, rel);
  let real;
  try { real = realpathSync(abs); }
  catch (e) { throw new Error(`artifact path ${abs} does not exist: ${e.message}`); }
  const hash = sha256(readFileSync(real));
  const t = loadTasks(dossier);
  const artifacts = { ...t.artifacts, [kind]: { path: real, hash, at: now } };
  // A CHANGED artifact deterministically invalidates its approval + every dependent one;
  // re-recording identical {path,hash} keeps valid approvals (never forces the workflow
  // backward). The subject hash the approval bound to is a function of these two.
  let approvals = t.approvals;
  const apprKind = ARTIFACT_TO_APPROVAL[kind];
  const prev = t.artifacts[kind];
  // THE INITIATIVE CONTRACT MAY NOT MOVE: siblings bind the contract BY PATH — a
  // secondary through the `initiative.contract` reference `feature start` derived, the primary
  // through this very record — so re-recording it at a DIFFERENT file relocates the primary's
  // binding while leaving every sibling bound to the ABANDONED file, which stays on disk and stays
  // hash-valid. That is a stale contract no approval can notice: the cascade fires in the primary's
  // repo alone and the sibling builds on. Refused HERE because this is the only writer that can
  // create the split, and because the alternative (resolving the contract cross-manifest at verify
  // time) is the sibling read this design rejects. NARROW BY CONSTRUCTION: the manifest is read only when
  // a contract record is genuinely being relocated, so non-initiative features — and every other
  // artifact kind — reach exactly the code they reached before, byte for byte.
  // THE SANCTIONED EDIT IS IN PLACE, which is also the one the subject clause watches; a genuine
  // relocation means the initiative's siblings must be re-derived against the new path, which no
  // single-feature op can do honestly.
  if (kind === 'contract' && prev && prev.path !== real && loadFeature(dossier).initiative != null) {
    throw new Error(
      `this feature belongs to an initiative and already records its interface contract at ` +
      `${prev.path} — its siblings bind THAT PATH (feature.json initiative.contract.path, derived ` +
      `at \`legion feature start … --initiative\`), so recording the contract at ${real} would ` +
      `leave them bound to the old file and building against a stale contract. Edit the contract ` +
      `IN PLACE at ${prev.path} and re-record it there: that edit falls every sibling's spec ` +
      `approval, which is the point. Moving it is not supported while the initiative block stands`,
    );
  }
  const changed = !prev || prev.path !== real || prev.hash !== hash;
  if (apprKind && changed) approvals = cascadeInvalidate(approvals, apprKind);
  bumpWrite(tasksPathOf(dossier), { ...t, artifacts, approvals }, now);
  return `recorded ${kind} artifact ${real} (sha256 ${hash})`;
}

function decisionRecord(dossier, { positional }, now) {
  const kind = positional[1];
  if (!DECISION_KINDS.includes(kind)) throw new Error(`invalid decision kind '${kind}' — one of ${DECISION_KINDS.join(', ')}`);
  const t = loadTasks(dossier);
  const f = loadFeature(dossier);
  const subjectHash = computeSubjectHash(kind, t, f); // recomputed NOW; refuses if subject missing
  const approvals = { ...t.approvals, [kind]: { kind, subjectHash, at: now } };
  bumpWrite(tasksPathOf(dossier), { ...t, approvals }, now);
  return `recorded ${kind} decision (subjectHash ${subjectHash})`;
}

function taskStart(dossier, { positional }, now) {
  const id = safeSegment(positional[1], 'task id');
  const t = loadTasks(dossier);
  const i = t.tasks.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`unknown task '${id}' — not in tasks.json (import a plan via \`legion plan check\`)`);
  if (t.tasks[i].status === 'done') throw new Error(`task '${id}' is already done`);
  // DEPENDENCIES ARE ENFORCED AT EXECUTION. `plan check` validated the
  // GRAPH (references resolve, acyclic); "T1 is done before T2 starts" is a property of the RUN,
  // and only this check keeps a builder off unbuilt ground. Order in the file is never
  // load-bearing — a plan listing T2 before T1 refuses here all the same.
  const done = new Set(t.tasks.filter((x) => x.status === 'done').map((x) => x.id));
  const unmet = (t.tasks[i].depends_on ?? []).filter((d) => !done.has(d));
  if (unmet.length > 0) {
    throw new Error(`cannot start task '${id}' — depends_on not yet done: ${unmet.join(', ')} (finish the dependency first; dependency order is enforced at execution, not merely validated at import)`);
  }
  const tasks = t.tasks.map((x, j) => (j === i ? { ...x, status: 'started', startedAt: now } : x));
  bumpWrite(tasksPathOf(dossier), { ...t, tasks }, now);
  return `started task ${id}`;
}

function taskDone(dossier, { positional }, now) {
  const id = safeSegment(positional[1], 'task id');
  const t = loadTasks(dossier);
  const f = loadFeature(dossier);
  const i = t.tasks.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`unknown task '${id}' — not in tasks.json`);
  const task = t.tasks[i];
  if (task.status !== 'started') throw new Error(`task '${id}' is not started (status: ${task.status ?? 'none'})`);
  // Derive the CURRENT commit tree ourselves; require a task receipt keyed to it AND CARRYING
  // GATE PROVENANCE. A caller SHA is never accepted.
  // THE TREE COMPARISON ALONE IS NOT ENOUGH: a receipt
  // whose tree is real and whose gate never ran is "internally honest yet proves nothing", so
  // provenance is checked FIRST and against the PINNED policy — not the live one, which an agent
  // can weaken and re-gate under (see gate.mjs, "Why pinned").
  const tree = treeOf(f.worktree);
  if (!task.receipt) throw new Error(`task '${id}' has no receipt — run \`legion gate run --task ${id}\` (the gate is the only minter)`);
  const prov = receiptProvenance(task.receipt, {
    tier: 'task', pinnedHash: f.commandPolicyHash?.task, pinnedTriples: f.commandPolicy?.task,
  });
  if (!prov.ok) {
    throw new Error(`task '${id}' receipt fails GATE PROVENANCE: ${prov.why} — re-run \`legion gate run --task ${id}\``);
  }
  if (task.receipt.treeHash !== tree) {
    throw new Error(`task '${id}' receipt treeHash ${task.receipt.treeHash} != current HEAD tree ${tree} — re-gate and re-record`);
  }
  const tasks = t.tasks.map((x, j) => (j === i ? { ...x, status: 'done', doneAt: now } : x));
  bumpWrite(tasksPathOf(dossier), { ...t, tasks }, now);
  return `completed task ${id}`;
}

/** Append one {question, answer, at} to a task's answers[] — the question protocol's write
 * path (header QUESTION PROTOCOL). Flags are validated BEFORE the manifest read (pure-argv
 * checks first, as reviewRecord does). `== null` not falsiness: an intentionally
 * empty --answer "" is legitimate content and is stored verbatim. Only the matched task is
 * rebuilt — every other field and every sibling task is carried through by spread. */
function taskAnswer(dossier, { flags, positional }, now) {
  const id = safeSegment(positional[1], 'task id');
  const question = flags.question;
  const answer = flags.answer;
  if (question == null) throw new Error('task-answer requires --question <question>');
  if (answer == null) throw new Error('task-answer requires --answer <answer>');
  const t = loadTasks(dossier);
  const i = t.tasks.findIndex((x) => x.id === id);
  if (i < 0) throw new Error(`unknown task '${id}' — not in tasks.json, refusing task-answer`);
  const task = t.tasks[i];
  if (task.status === 'done') {
    throw new Error(`task '${id}' is already done — refusing task-answer (a stale answer would ride into a re-brief)`);
  }
  const tasks = t.tasks.map((x, j) => (
    j === i ? { ...x, answers: [...(x.answers ?? []), { question, answer, at: now }] } : x
  ));
  bumpWrite(tasksPathOf(dossier), { ...t, tasks }, now);
  return `recorded answer for task ${id}`;
}

/** Record a verdict BOUND to what it judged (header REVIEWS BIND — R3). The caller supplies
 * role/verdict/subject (content, like a task title); the kernel derives the subjectHash itself
 * and validates that the subject NAMES SOMETHING REAL — there is no --subject-hash flag, and a
 * syntactically valid subject naming no task/milestone refuses rather than recording a verdict
 * about nothing. */
function reviewRecord(dossier, { flags }, now) {
  const role = flags.role;
  const verdict = flags.verdict;
  const subject = flags.subject;
  if (role == null) throw new Error('review-record requires --role <role>');
  if (verdict !== 'pass' && verdict !== 'fail') throw new Error(`review-record --verdict must be pass|fail, got '${verdict}'`);
  if (subject == null || !/^(task:.+|milestone:.+|feature|plan)$/.test(subject)) {
    throw new Error(`review-record --subject must be task:<id> | milestone:<id> | feature | plan, got '${subject}'`);
  }
  const t = loadTasks(dossier);
  const f = loadFeature(dossier);
  if (subject.startsWith('task:')) {
    const id = subject.slice('task:'.length);
    if (!t.tasks.some((x) => x.id === id)) {
      throw new Error(`review subject names unknown task '${id}' — not in tasks.json; a verdict about a task that does not exist is a caller assertion, not evidence`);
    }
  }
  if (subject.startsWith('milestone:')) {
    const id = subject.slice('milestone:'.length);
    if (!t.tasks.some((x) => x.milestone === id)) {
      throw new Error(`review subject names unknown milestone '${id}' — no task in tasks.json belongs to it`);
    }
  }
  const subjectHash = reviewSubjectHash(subject, t, f); // derived NOW, by kind; throws loudly if the subject's evidence is missing
  const reviews = [...t.reviews, { role, verdict, subject, subjectHash, at: now }];
  bumpWrite(tasksPathOf(dossier), { ...t, reviews }, now);
  return `recorded ${role} review: ${verdict} on ${subject} (subjectHash ${subjectHash})`;
}

// --- the receipt writer: EXPORTED, and deliberately NOT in OPS ------------------------------
// These two are the second named exception in the header. They are ordinary exported functions
// rather than typed ops precisely so that `legion state` cannot reach them: there is no argv
// shape, no flag surface and no dispatch entry that mints a receipt. `legion gate` (src/cli/
// gate.mjs) is the only caller of either, which is what makes "the gate is the only minter"
// a property of the code rather than a sentence in a document.

/** Mint the receipt for a GREEN gate run. ONE bumpWrite of tasks.json.
 *
 * THE KERNEL STILL DERIVES ITS OWN EVIDENCE. `expectHead`/`expectTree` are NOT the values
 * recorded — head and tree are derived here, from the worktree feature.json names — they are the
 * values the gate SCANNED, and disagreement is a refusal. That is gate.mjs decision 13 restated
 * on the kernel side, and the duplication is deliberate: gate.mjs keeps its own richer ABORTED
 * message (it knows which tier ran and what it should have been), while this guard is what makes
 * the invariant true for any caller, including a future one. A caller cannot pass a HEAD it
 * wishes were true — it can only be refused for naming one that is not.
 *
 * The dirty check is the DERIVED tree comparison (kernel/git.mjs header F), not `git status`:
 * staged/untracked content must not dodge the gate, and no config knob may silence the check
 * (this is the last remaining reachable path to that fail-open). */
export function recordGateReceipt(dossier, spec, now) {
  const {
    tier, taskId = null, expectHead, expectTree, commandPolicyHash: policyHash,
    declaredCommands, results, allowConfig = false, repinnedFrom = null,
  } = spec;
  if (!GATE_TIERS.includes(tier)) throw new Error(`not a gate tier: '${tier}' (tiers: ${GATE_TIERS.join(', ')})`);
  if (typeof policyHash !== 'string' || policyHash.length === 0) {
    throw new Error('recordGateReceipt requires the commandPolicyHash the run actually ran under');
  }
  if (!Number.isInteger(declaredCommands) || declaredCommands < 0 || !Array.isArray(results)) {
    throw new Error('recordGateReceipt requires declaredCommands (int >= 0) and results[]');
  }
  const f = loadFeature(dossier);
  if (!isClean(f.worktree)) {
    throw new Error(`worktree ${f.worktree} is dirty — commit or clean it before a gate may record a receipt`);
  }
  const head = headOf(f.worktree);
  const tree = treeOf(f.worktree);
  if (expectHead !== head || expectTree !== tree) {
    throw new Error(
      `refusing to record a ${tier} receipt: the repository moved between the gated scan and the ` +
      `record (gated HEAD ${expectHead} tree ${expectTree}; derived HEAD ${head} tree ${tree}) — ` +
      `a receipt may only certify the tree the gate actually scanned`,
    );
  }
  // Key order matches the gate's documented receipt shape; the optional audit fields append.
  const receipt = { tier, commandPolicyHash: policyHash, results, declaredCommands, head, treeHash: tree, at: now };
  if (allowConfig) receipt.allowConfig = true;
  if (repinnedFrom != null) receipt.repinnedFrom = repinnedFrom;
  const weak = declaredCommands === 0 ? ' — TIER-0 ONLY: 0 declared commands, a real but WEAK certificate' : '';
  const t = loadTasks(dossier);
  if (tier === 'task') {
    const id = safeSegment(taskId, 'task id');
    const i = t.tasks.findIndex((x) => x.id === id);
    if (i < 0) throw new Error(`unknown task '${id}' — not in tasks.json`);
    const tasks = t.tasks.map((x, j) => (j === i ? { ...x, receipt } : x));
    bumpWrite(tasksPathOf(dossier), { ...t, tasks }, now);
    return `recorded task receipt for ${id} (tree ${tree}, ${declaredCommands} declared task command(s)${weak})`;
  }
  const receipts = { ...t.receipts, boundary: receipt };
  bumpWrite(tasksPathOf(dossier), { ...t, receipts }, now);
  return `recorded boundary receipt (HEAD ${head}, ${declaredCommands} declared boundary command(s)${weak})`;
}

/** Move the per-feature gate policy PIN to the live project policy, AND RECORD THE MOVE. ONE
 * bumpWrite of feature.json. Called only by `legion gate run --repin`, whose header owns the
 * ordering decision. `pin` is commandPolicyPin()'s output, so the hashes and the command lists
 * they describe are written from one definition and cannot disagree.
 *
 * THE AUDIT TRAIL LIVES WHERE THE PIN LIVES — a `commandPolicyHistory` entry
 * `{from:{task,boundary}, to:{task,boundary}, at}` appended here whenever the pin actually MOVES.
 * `from` is read out of the manifest at write time and never passed in: the superseded value is a
 * fact this function is the last to hold, and a caller-supplied one could be anything.
 * WHY THE TRAIL IS NOT DERIVED FROM RECEIPTS — state the two concrete cases, because "the receipt
 * already carries repinnedFrom, this history is duplication" is exactly what a future reader will
 * otherwise conclude:
 *   1. A RE-PIN IS UNCONDITIONAL; A RECEIPT IS CONDITIONAL. `--repin` moves the pin before the
 *      tiers run, so a re-pinning run that then goes RED — or aborts under gate decision 13 —
 *      mints NO RECEIPT AT ALL. The policy has moved and the only record was a line on stdout;
 *      the next ordinary green run then mints a receipt that looks perfectly un-re-pinned.
 *   2. A RE-PIN MOVES BOTH TIERS; A RECEIPT IS PER TIER. `gate run --task <id> --repin` stamps
 *      `repinnedFrom` on that task's receipt only, while the BOUNDARY pin moved too — and
 *      `legion finalize` reads the BOUNDARY receipt, so a weakened task gate reached the
 *      pre-merge human with no indication whatsoever.
 * Both are the same general mistake: record the FACT where the fact is, never
 * infer it from an artifact that may not exist or may not cover it. The receipt's `repinnedFrom`
 * REMAINS, as convenience evidence BOUND TO THE CERTIFIED TREE — it answers "was this particular
 * certificate earned across a policy change" — but it is NOT the trail. Do not simplify the
 * history away as duplication, and do not drop `repinnedFrom` in the history's favour.
 *
 * A `done` task is NEVER retroactively reopened by a re-pin, and there is deliberately NO
 * retroactive sweep: nothing here iterates task receipts, and nothing anywhere does.
 * Returns {moved, repaired, from, to, summary}; `moved` is the SINGLE definition of "the pin
 * actually changed", so the caller renders the same verdict this function wrote by. `repaired` is
 * the narrower fact that the pin's LIST half was rewritten while the policy stood still — a write,
 * but NOT a policy change, and deliberately not in the history. */
export function repinCommandPolicy(dossier, pin, now) {
  const f = loadFeature(dossier);
  const to = pin.commandPolicyHash;
  // An ABSENT prior pin is a real `from` (null per tier), not a reason to skip the entry: moving
  // from "nothing was ever declared" to a policy is a change the human should see too.
  const from = Object.fromEntries(GATE_TIERS.map((t) => [t, f.commandPolicyHash?.[t] ?? null]));
  const moved = GATE_TIERS.some((t) => from[t] !== to[t]);
  // THE PIN IS BOTH HALVES, SO `--repin` MUST BE ABLE TO REPAIR EITHER. `moved` used to be computed
  // from the HASHES alone and gated the whole write, which made this function a provable NO-OP in
  // exactly the state receiptProvenance's newest refusals name it as the remedy for: a pinned
  // command LIST that is absent or hand-edited while the hash still matches the live policy. The
  // refusal said "re-pin the live policy with `legion gate run --repin`", the operator ran it, it
  // wrote nothing, and the refusal repeated forever — an instruction that cannot clear the state it
  // refuses.
  // (Both halves of the pin are always written together, so no committed kernel ever writes a hash
  // without a list. A dossier with NEITHER half refuses one step earlier on the absent PIN, and
  // `--repin` already recovers it because `from` is then null per tier and `moved` is true. The
  // only reachable state needing this repair is a hand-edit.)
  const listStale = GATE_TIERS.some(
    (t) => JSON.stringify(f.commandPolicy?.[t]) !== JSON.stringify(pin.commandPolicy[t]),
  );
  // NOTHING IS WRITTEN WHEN NOTHING IS STALE. A no-drift, no-repair `--repin` that still bumped
  // `revision` and reset `commandPolicyPinnedAt` would report itself as "re-pinned just now" when
  // it re-pinned nothing.
  if (moved || listStale) {
    bumpWrite(featurePathOf(dossier), {
      ...f,
      ...pin,
      // A REPAIR IS NOT A RE-PIN, so neither of the two facts that record a MOVE may be written for
      // one: the hashes are unchanged, meaning the live policy is the policy this feature was
      // already pinned to, and `pin.commandPolicy` is by definition the list that hash covers.
      // Stamping `commandPolicyPinnedAt` would date the pin to the repair, and appending a
      // {from, to} entry whose two sides are equal would put a policy change that never happened in
      // front of the pre-merge human — the exact "stored conclusion" §State forbids.
      ...(moved
        ? {
          commandPolicyPinnedAt: now,
          commandPolicyHistory: [...(f.commandPolicyHistory ?? []), { from, to: { ...to }, at: now }],
        }
        : {}),
    }, now);
  }
  return {
    moved,
    // `repaired` is the list-only write: true ONLY when the hashes stood still and the list did not.
    // Kept distinct from `moved` because they are different facts with different audiences — `moved`
    // is a policy change the human gate must see, `repaired` is a corrupted manifest made whole.
    repaired: !moved && listStale,
    from,
    to,
    summary: moved
      ? `re-pinned the gate command policy (task ${to.task}, boundary ${to.boundary}) — recorded in commandPolicyHistory`
      : listStale
        ? `repaired the pinned gate command LIST from the live policy (task ${to.task}, boundary ${to.boundary}) — `
          + 'the policy itself is unchanged, so this is not a re-pin and nothing was added to commandPolicyHistory'
        : `gate command policy pin unchanged (task ${to.task}, boundary ${to.boundary})`,
  };
}

function sessionRecord(dossier, { flags }, now) {
  const sessionId = flags['session-id'];
  if (sessionId == null) throw new Error('session-record requires --session-id <id>');
  const f = loadFeature(dossier);
  const sessionHistory = [...(f.sessionHistory ?? []), { sessionId, at: now }];
  bumpWrite(featurePathOf(dossier), { ...f, sessionHistory, currentSession: sessionId }, now);
  return `recorded session ${sessionId}`;
}

/** THE ONE ADDITIVE OP: the op list
 * grows by exactly this and nothing else. It records OPERATOR-SUPPLIED DATA, which is why it can
 * exist at all where `receipt-record` cannot: a ticket ref proves nothing, gates nothing and is
 * read by no predicate, so a caller supplying one blesses nothing (kernel/ticket.mjs header). The
 * shape deliberately mirrors session-record — one field, one write, one line — because the moment
 * this op grows a second field it stops being "record the ref the human just gave you".
 * IDEMPOTENT BY OVERWRITE: re-recording the same ref, or a different one, simply sets `ticket`;
 * there is no history array, because a ticket is a pointer at a live conversation, not a fact
 * about a tree, and nothing downstream needs to know it once pointed elsewhere. The revision bump
 * is where the change is visible — deliberately unconditional, so an operator can tell that the op
 * ran rather than having to infer it from a field that already held that value.
 * The ref is validated by the SHARED validator (import above), so `--ticket` at start and this op
 * refuse the same garbage with the same words. */
function ticketRecord(dossier, { positional }, now) {
  const { ref } = validateTicketRef(positional[1], 'ticket-record <ref>');
  const f = loadFeature(dossier);
  bumpWrite(featurePathOf(dossier), { ...f, ticket: ref }, now);
  return `recorded ticket ${ref}`;
}

// MONOTONIC BY RANK. Lowering un-owes review the classification already promised — the
// stored profile is the requirement stageSatisfied(review) re-derives against, so a lowering is
// evidence-weakening, not reclassification; scope that shrank goes back through intake honestly.
// SAME-PROFILE RE-SET IS IDEMPOTENT, deliberately: a re-entrant session (crash, /clear) re-runs
// its classification step, and refusing the no-op would fail a walk that changed nothing —
// ticket-record's idempotent-by-overwrite precedent; the revision bump is where the op stays
// visible. A hand-edited/unknown stored profile ranks as unclassified, so a valid target always
// repairs it.
const PROFILE_RANK = { [UNCLASSIFIED_PROFILE]: 0, express: 1, standard: 2, full: 3 };

function escalateProfile(dossier, { positional }, now) {
  const profile = positional[1];
  if (!PROFILES.includes(profile)) throw new Error(`invalid profile '${profile}' — one of ${PROFILES.join(', ')}`);
  const f = loadFeature(dossier);
  if ((PROFILE_RANK[profile] ?? 0) < (PROFILE_RANK[f.profile] ?? 0)) {
    throw new Error(`escalate-profile is monotonic: '${f.profile}' -> '${profile}' would LOWER the profile — ` +
      `review owed under '${f.profile}' cannot be un-owed by reclassifying ` +
      `(rank: ${UNCLASSIFIED_PROFILE} < ${PROFILES.join(' < ')})`);
  }
  bumpWrite(featurePathOf(dossier), { ...f, profile }, now);
  return `profile set to ${profile}`;
}

function invalidate(dossier, { positional }, now) {
  const kind = positional[1];
  if (!APPROVAL_CHAIN.includes(kind)) throw new Error(`invalid approval kind '${kind}' — one of ${APPROVAL_CHAIN.join(', ')}`);
  const t = loadTasks(dossier);
  const approvals = cascadeInvalidate(t.approvals, kind);
  bumpWrite(tasksPathOf(dossier), { ...t, approvals }, now);
  return `invalidated ${kind} and dependents`;
}

function close(dossier, { positional }, now) {
  const mode = positional[1];
  if (!CLOSE_MODES.includes(mode)) throw new Error(`invalid close mode '${mode}' — one of ${CLOSE_MODES.join(', ')}`);
  const f = loadFeature(dossier);
  if (f.status === 'delivered' || f.status === 'abandoned') {
    throw new Error(`feature is already closed (status: ${f.status})`);
  }
  if (mode === 'delivered') {
    // Delivered requires the FINALIZE STAGE, then the pre-merge chain: a boundary receipt for the
    // CURRENT HEAD that CARRIES GATE PROVENANCE under the pinned policy, a still-hash-valid
    // pre-merge approval, a VERIFIED MR at that same HEAD (all derived; a later commit or a
    // drifted subject fails closed) — and finally the WHOLE lifecycle prefix re-derived
    // (corollary 1). THE ORDER IS LOAD-BEARING: stage → boundary → stale-boundary → provenance →
    // approval → MR → prefix, so each refusal names the NEXT unmet link in the chain; the prefix
    // net runs LAST because when a specific link is broken its specific refusal is the legible
    // one, and the net exists for what the chain cannot see (e.g. a review set raised by
    // escalate-profile after finalize was reached — every chain link still holds there).
    //
    // THE STAGE CLAUSE: a backward re-entry out of finalize
    // clears nothing — the recorded MR, receipt and approval all still describe HEAD — so
    // without this clause a feature deliberately moved back into `plan` could still be closed
    // delivered on the old evidence as long as HEAD had not moved yet.
    if (f.stage !== 'finalize') {
      throw new Error(`close delivered requires the current stage to be 'finalize' (currently '${f.stage}') — a feature is closed at the end of its lifecycle, not wherever old evidence still validates`);
    }
    const t = loadTasks(dossier);
    if (!t.receipts.boundary) throw new Error('close delivered requires a boundary receipt — `legion gate run --boundary`');
    const head = headOf(f.worktree);
    if (t.receipts.boundary.head !== head) {
      throw new Error(`close delivered: boundary receipt is for ${t.receipts.boundary.head}, current HEAD is ${head} (stale — re-gate \`legion gate run --boundary\`)`);
    }
    const prov = receiptProvenance(t.receipts.boundary, {
      tier: 'boundary', pinnedHash: f.commandPolicyHash?.boundary, pinnedTriples: f.commandPolicy?.boundary,
    });
    if (!prov.ok) {
      throw new Error(`close delivered: the boundary receipt fails GATE PROVENANCE: ${prov.why} — re-run \`legion gate run --boundary\``);
    }
    if (!approvalValid('pre-merge', t, f)) {
      throw new Error('close delivered requires a hash-valid pre-merge approval');
    }
    // close(delivered) requires a boundary receipt plus a verified MR. The MR is the
    // one fact this kernel cannot derive — `legion finalize` reads it back from the server and
    // records it (it is the one writer of feature.json outside this module). HEAD is DERIVED
    // here, never supplied: an MR for an older commit certifies a tree that is not what was
    // delivered, and closing on it would be a claim of success the code does not deliver.
    const mr = f.mr;
    if (!mr) {
      throw new Error('close delivered requires a verified MR — run `legion finalize` (it pushes the branch, opens the MR against the PINNED base, reads it back and records it in feature.json)');
    }
    if (mr.headSha !== head) {
      throw new Error(`close delivered: recorded MR !${mr.iid} is for ${mr.headSha}, current HEAD is ${head} (stale — re-run \`legion finalize\` to update and re-record it)`);
    }
    // The corollary-1 net (header THE STAGE MACHINE): reaching finalize once is not evidence the
    // lifecycle is STILL satisfied — re-derive the whole prefix at the moment of closing.
    const bad = unsatisfiedPrefix('finalize', t, f);
    if (bad) {
      throw new Error(`close delivered refused: stage '${bad.stage}' no longer re-derives satisfied — ${bad.why}`);
    }
  }
  bumpWrite(featurePathOf(dossier), { ...f, status: mode, closedAt: now }, now);
  return `feature closed: ${mode}\n${cleanHint(f)}`;
}

/** THE `legion feature clean` hint (after `close delivered` nothing removes the
 * worktree, so without this an operator has to clean up by hand). Defined HERE, in the module that already writes every
 * other "run `legion gate run --boundary` / `legion finalize`" remediation, and imported by
 * src/cli/feature.mjs so `close` and `feature abandon` cannot print two different cleanups. The
 * cycle rule is what fixes the direction: cli/feature.mjs already imports this kernel module, and
 * a kernel module may never import a CLI one.
 * IT IS PROSE, NOT A PASTEABLE `cd … && …` LINE, and that is deliberate: a shell line would have
 * to quote repoRoot (a path may hold a space or a semicolon) and the only quoter lives in the CLI
 * layer, on the far side of that rule. The feature NAME and the ORG are both safeSegment-shaped
 * (paths.mjs guards each at `project init` / `feature start`), so the command itself is safe to
 * print verbatim.
 * `--org` IS NOT DECORATION AND IS NOT CONDITIONAL. One repo root may be registered under several
 * orgs — a supported, tested configuration — and src/cli/feature.mjs's resolveProject() then
 * REFUSES with "matches multiple projects … disambiguate with --org". A hint that omits the flag
 * advertises a command that does not run, so it is always emitted: the record knows its own org,
 * and this printer cannot see the index to know whether today's registration is ambiguous.
 * TIMING IS PART OF THE ADVICE: cleanup belongs after the MR is merged
 * or closed, never at MR creation — a pre-merge rejection → fixup loop still needs the worktree
 * after the MR exists. `clean` cannot enforce that (the MR's fate is not local evidence), so the
 * hint says it. */
export function cleanHint(f) {
  return `local cleanup, once the MR is merged or closed:\n` +
    `  legion feature clean ${f.name} --org ${f.org}   — run it in ${f.repoRoot}, not in the worktree it deletes\n` +
    `  it removes the worktree and ${f.branch}; the dossier and the REMOTE branch are never touched\n`;
}

const OPS = {
  init,
  'stage-enter': stageEnter,
  'stage-complete': stageComplete,
  'artifact-record': artifactRecord,
  'decision-record': decisionRecord,
  'task-start': taskStart,
  'task-done': taskDone,
  'task-answer': taskAnswer,
  'review-record': reviewRecord,
  // NO 'receipt-record'. The header says why, and STATE_OPS below generates `legion state`'s
  // advertised op list from this table — so an entry here is an advertised, dispatchable way to
  // certify a tree no gate ran on. recordGateReceipt is exported for `legion gate` instead.
  'session-record': sessionRecord,
  // The ONE sanctioned growth of this table (ticketRecord's docblock): it writes DATA, not
  // evidence. Any further entry is a frozen-surface change, not a feature.
  'ticket-record': ticketRecord,
  'escalate-profile': escalateProfile,
  invalidate,
  close,
};

export const STATE_OPS = Object.keys(OPS);

/** Dispatch one typed op against a resolved dossier. Unknown ops die loudly. */
export function dispatch(op, dossier, args, now) {
  const fn = OPS[op];
  if (!fn) throw new Error(`unknown state op '${op}' — one of: ${STATE_OPS.join(', ')}`);
  return fn(dossier, args, now);
}
