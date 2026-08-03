// finalize.mjs — `legion finalize`. THE ONLY COMMAND IN
// THE KERNEL THAT WRITES TO A REMOTE. Nothing else pushes, and nothing else opens an MR.
//
// WHAT IT GUARANTEES, AND WHAT IT DOES NOT. Safety is layered on purpose:
// the HARD boundary is server-side (GitLab protected branches + the agent identity's
// permissions, verified by `legion doctor`); finalize is the INTENDED PATH; local git hooks
// and the plugin's PreToolUse hook are defense in depth. Everything this file checks is
// therefore DEFENSE IN DEPTH: it can refuse a push the server would have accepted, it can
// never make a push the server accepts safe. Where server protection is unverified the
// guarantee is BEST-EFFORT and doctor says so — stated here rather than implied, because a
// command that reads as "the safety" invites exactly the trust it cannot carry.
//
// THE VERIFICATION CHAIN, in order, ALL of it derived by the kernel and none of it caller-
// supplied: a model handed an identifier could bless anything — there is no
// --target/--sha/--mr/--title flag here, and the MR target is the PINNED base from
// feature.json, never an argument. `--description-file` is not a counter-example and the
// distinction is the whole point: it supplies PROSE FOR HUMANS, which no check below reads and no
// consumer downstream trusts. A caller may write anything in it and change nothing about what
// this command verifies or refuses:
//   C0 feature.status === 'active' (a closed/failed feature is not finalizable), and
//      feature.json carries both branch and baseBranch;
//   C1 the worktree's CURRENT branch === feature.json.branch (a detached HEAD reads 'HEAD'
//      and therefore refuses — a detached finalize would push a ref nobody tracks);
//   C2 the worktree is CLEAN — via worktreeDirt(), the DERIVED tree comparison (kernel/git.mjs
//      header F). Never a bare `git status` and never a re-typed '--porcelain' literal:
//      absence-of-output was the fail-open shape that was removed;
//   C3 a boundary receipt exists, is bound to the CURRENT HEAD (a receipt for an older commit
//      certifies a tree that is not what we are about to push), AND CARRIES GATE PROVENANCE under
//      the policy PINNED in feature.json — kernel/state.mjs receiptProvenance, IMPORTED, never
//      re-implemented (the commandPolicyHash formula is FROZEN for the same reason C4's is).
//      EXTENDED, not restructured: the head comparison and its refusal text are unchanged, and
//      provenance is a third clause after them. "The tree is real" was never the question; "a
//      gate ran on it, under the policy this feature is certified by" is — which is why the
//      pinned command LIST is passed here beside the pinned hash: provenance also requires the
//      receipt's recorded results[] to REPRODUCE the pinned boundary command list, not merely to
//      carry a policy hash equal to the pin. Copying the pin out of feature.json is not by itself
//      evidence that anything ran, since the pin format is commandPolicyPin (the hashes PLUS the
//      triples they cover) — copying BOTH halves is exactly what still passes. What is true:
//      carrying the policy HASH alone is no longer enough;
//   C4 the pre-merge approval is HASH-VALID — kernel/state.mjs approvalValid('pre-merge'),
//      IMPORTED, never re-implemented. The subject formula is FROZEN (kernel/state.mjs header
//      APPROVALS): a second copy of the hash here would drift and silently invalidate every
//      approval the state machine recorded;
//   C5 at least one PASSING product/milestone review (subject 'feature' or 'milestone:<id>')
//      whose derived subjectHash STILL BINDS to the current tree (kernel/state.mjs
//      reviewBindingHolds, IMPORTED never re-implemented: a pass earned on an older tree is a
//      recorded fact, not current sign-off).
//      DECIDED: a `task:<id>` review does NOT satisfy this — it is per-task sign-off, not
//      product sign-off. And C4 does not imply C5: the pre-merge subject hashes the reviews
//      array whatever it contains, so an approval over an EMPTY reviews[] is perfectly
//      hash-valid. Two independent conditions, checked independently;
//   C6 the feature is in the FINALIZE STAGE and the WHOLE lifecycle prefix re-derives satisfied
//      AT THIS MOMENT (finalize is the end of a lifecycle, not a command that happens to find
//      valid receipts; kernel/state.mjs unsatisfiedPrefix, IMPORTED never re-implemented). C1-C5 keep their order and their
//      texts; C6 runs LAST because when a specific evidence link is broken its specific refusal
//      is the legible one — acceptance case 1b PINS that a forged boundary receipt dies on C3's
//      GATE PROVENANCE, not on the stage of the dossier it was forged into — and C6 exists for
//      what C1-C5 cannot see, e.g. a review set raised by escalate-profile AFTER finalize was
//      reached: HEAD, receipt, reviews and approval are all unchanged then, so every earlier
//      check passes while stageSatisfied(review) is false. It runs BEFORE the idempotence
//      early-exit for the same reason: "an MR is already recorded at this HEAD" must not print
//      success for a feature whose lifecycle no longer holds. The stage-ORDER half of the
//      guarantee is enforced by the WRITER — stage-enter refuses any forward hop that is not the
//      next stage over a satisfied prefix — so an ordered history is a property of how the
//      finalize stage can ever have been reached, not something re-read here as authority
//      (stageHistory is audit trail; kernel/state.mjs header THE STAGE MACHINE).
// ANY unmet condition ⇒ a loud nonzero exit naming it, and NOTHING reaches the remote: every
// io call sits strictly after the whole chain.
//
// THE TICKET IS THE ONE CALLER-SUPPLIED VALUE THIS COMMAND CONSUMES, AND IT IS NOT A CONDITION.
// It gates nothing, blesses nothing and is verified
// by nothing — it is a POINTER AT A HUMAN CONVERSATION the operator supplied at `feature start`
// (kernel/ticket.mjs header), so the chain above neither reads it nor cares whether it exists.
// What it buys is two renderings: the MR body's closing-reference line and one append-only comment
// on the issue, both below. Three properties are load-bearing here and each is pinned by a test:
//   - OPTIONAL, AND SKIPPED WHOLE. Without `feature.json.ticket` this file resolves no config,
//     reads no org.json, composes no line and makes no `issue` call: a ticket-less finalize's glab
//     call sequence, MR body and output are unchanged from a feature with no ticket. The whole track is additive
//     and must not be able to move the behaviour of a feature that has no ticket.
//   - RESOLVED AT READ TIME, PINNED NOWHERE. The rendering config (project + closing style) is
//     resolved HERE, on this run, by kernel/ticket.mjs's resolver — never copied out of
//     feature.json, because a ticket format is not evidence-bearing and pinning it would only cost
//     the operator the ability to fix a wrong closing keyword without restarting the feature
//     (contrast the gate policy pin, which IS evidence-bearing and therefore IS pinned).
//   - RESOLVED BEFORE THE REMOTE, NOT DURING IT. Resolution can REFUSE — a garbage ref in a
//     hand-edited manifest, a present-but-unreadable org.json — and a refusal discovered after the
//     push would be a refusal that cannot un-push. So it runs with the chain, before the
//     idempotence exit and before the first io call, and the call log is what pins that ordering.
//
// THE GIT SEAM IS FIRST-CLASS HERE, NOT AN AFTERTHOUGHT. Ambient GIT_DIR/GIT_WORK_TREE
// repoint git at a DIFFERENT repository and no `-c` can undo them (kernel/git.mjs header B).
// In every other command that mis-resolves a local read; HERE it would verify repo A and
// PUSH REPO B. So: every read is git()/gitTry() (hardened — pinned config, purged GIT_*), and
// the ONE mutation is gitUserRepo(), which keeps the operator's config but STILL strips the
// redirection vars. That split is deliberate and it is the subtle part of this file:
//   - reads must be hardened, because they are evidence;
//   - the PUSH must NOT be, because hardened env points GIT_CONFIG_GLOBAL at /dev/null, which
//     removes the credential helper and url.insteadOf — a legitimate push would then fail to
//     authenticate or hang on a prompt. It is a MUTATION of the user's repo, which is exactly
//     what gitUserRepo is for, and it is allowlisted in test/kernel/git-seam.audit.test.mjs.
// THAT PUSH ALSO CARRIES A MARKER: running under the user's config
// means running the user's HOOKS, and the pre-push guard legion installs into every managed
// repository (src/kernel/githooks.mjs) would otherwise block the push out of a feature worktree
// that is the one sanctioned way a branch leaves the machine — so LEGION_FINALIZE_PUSH=1 is set
// on the push SUBPROCESS's environment (pushEnv below), never on this process, so that nothing
// else finalize shells out to can claim to be the push. The marker is SPOOFABLE by construction
// and that costs nothing: anything able to export a variable is equally able to pass
// `--no-verify`, so it grants no capability that was not already there — it is a coordination
// token between two halves of legion, not an authentication of one, and the server remains the
// only guarantee.
// glab inherits the same hazard by a different route: it resolves the GitLab project from the
// git remote of its cwd, so an ambient GIT_DIR would open the MR against another repository.
// Its environment is therefore stripped of GIT_REDIRECT_VARS too (and nothing else — GITLAB_
// TOKEN/PATH must survive). BEST-EFFORT, stated: glab's own host/config resolution is outside
// this kernel's control. That stripping now lives in kernel/runner.mjs — the ONE non-git
// process seam, shared with `legion doctor` so the two glab callers cannot drift apart on
// the two properties that matter: no shell, and no repo redirection.
//
// (Both comments obey this identically: the ticket comment is composed and posted in its own try,
// its failure prints its own composed text, and it can no more fail a finalize than the MR comment
// can. The issue is even further from the two facts that matter — an issue nobody commented on is
// still an issue, and the MR is where the merge happens.)
//
// THE INJECTABLE SEAM. finalizeCore(argv, io) takes the runner; run(argv) wires realIo(). The
// two primitives are LOW-LEVEL on purpose — gitPush() and a glab argv passthrough, not
// openMr()/viewMr(): the glab argv IS part of the contract under test ("the MR targets the
// PINNED base"), so the core must compose it and a fake must be able to record it. node:test
// never pushes and never runs glab for real.
//
// ORDERING IS THE CONTRACT: verify → push → LOOK UP → create only if absent → READ BACK →
// RE-READ feature.json (it must not have moved under us) → record → COMMENT (the MR's, then the
// ticket's, each in its own try). The MR record is
// written only from what the SERVER returned, re-read after creation, and validated (iid,
// url, target_branch === pinned base, source_branch === our branch, and the head sha when the
// payload carries one). A read-back or validation failure AFTER a successful push is a LOUD
// nonzero exit that still reports what DID happen — never a silent success, never a fabricated
// or partial `mr` object in feature.json.
//
// THE MR IS A HUMAN DOCUMENT; THE PROCESS METADATA IS A COMMENT. Two surfaces, two audiences:
//   BODY = PROSE, authored by the session and passed as `--description-file <path>`: what
//     changed, why, how to review it. The kernel appends exactly ONE trailing line (BODY_TRAILER)
//     and NOTHING else — no hashes, no receipt fields, no review counts. Absent the flag the body
//     is the feature id plus that line: a deterministic fallback, because a kernel that invents
//     prose is a kernel that lies fluently. FOR A TICKETED FEATURE THE CLOSING-REFERENCE LINE JOINS
//     THAT TAIL: `<keyword> <reference>` immediately above BODY_TRAILER, still one
//     kernel-appended block and still no hashes. The KEYWORD is the resolved closing style and the
//     REFERENCE is `group/project#123` whenever a ticket project is resolved — GitLab's auto-close
//     fires cross-project only on the full path — or `#123` when none is, which is the case where
//     the issues live in the code repo's own project and glab already knows which that is (the
//     kernel never derives a project path the forge owns). CLAIM NOTHING MORE THAN THIS: the kernel
//     renders a line; GITLAB does the linking and the auto-close on merge, under whatever closing
//     pattern that server is configured with. WHY NO HASHES ANYWHERE IN THE MR: they enforce
//     nothing. Everything a hash could prove was already verified HERE (C3–C6) and is verified
//     again by `close delivered`; in the MR they are an EDITABLE PROJECTION that no colleague can
//     check without the machine-local dossier. Their durable home is `legion report`,
//     not a text field anyone with write access can rewrite.
//   COMMENTS = PROCESS METADATA, one posted per SUCCESSFUL FINALIZE EVENT (create AND
//     re-finalize), never edited, never deleted. This retires a stale-body limitation: the body
//     was written once, at create, so after the ordinary pre-merge-rejection → fixup loop it
//     described the FIRST head forever. An append-only comment per event is the fix that also
//     matches the facts-not-conclusions rule — each comment is a fact about one event, and the
//     sequence is the trail — and it reaches the merging human where a body edit notifies nobody.
//     A TICKETED FEATURE POSTS A SECOND COMMENT, ON THE ISSUE, under the SAME mechanics: one
//     per successful finalize event, append-only, never edited and never deleted. Its content is
//     deliberately NOT the MR comment's: a couple of lines carrying the MR link and what happened,
//     because the gates trail belongs on the merge request where the reviewer is, and duplicating
//     it onto the issue would put a second copy of the evidence in front of a different audience
//     that cannot act on it. THE TWO COMMENTS ARE INDEPENDENT IN BOTH DIRECTIONS: two separate
//     trys, in the order MR-comment then ticket-comment, so a lost MR comment still attempts the
//     issue comment and a failing issue comment costs nothing that came before it. Nothing outside
//     this file gains a remote write for either: both go through the SAME injected io.glab seam
//     that the push and the MR already use — finalize is the one path.
// A COMMENT-POST FAILURE IS REPORTED, NOT FATAL, and the semantics are stated exactly because
// "loud" and "failed" are not the same word: the push happened, the MR exists, the MR is RECORDED
// in feature.json, `close delivered` will find it, and finalize therefore EXITS 0. What is lost is
// the human-facing note for this event, so the composed text is printed for the operator to paste.
// Rolling back is not available (nothing can un-push) and failing would be a lie about the two
// facts that matter. Honest consequence, stated rather than glossed: an idempotent re-run at the
// SAME head exits early by design and posts NOTHING, so a lost comment is not recovered by
// re-running — only a real later finalize event carries its own.
//
// IDEMPOTENCE. An agent re-running finalize is ordinary, and a SECOND `mr create` is the
// failure mode worth preventing — GitLab rejects a duplicate MR for the same source branch, so
// a feature that created one and then failed before recording it would be stranded with no
// kernel path to bind the MR that exists. What this file guarantees: finalize never opens a
// SECOND MR for a branch. With an `mr` recorded at the CURRENT head it prints it and exits 0
// having called nothing and written nothing; otherwise it pushes (the MR tracks the branch),
// then RESOLVES the MR that already exists — BY IID when one is recorded, BY SOURCE BRANCH
// otherwise — and creates only when that lookup finds none. A create that succeeds and a
// read-back that fails is therefore RECOVERABLE: the next run finds that MR and records it.
//
// FEATURE RESOLUTION is by WORKTREE via resolveDossier (shared with `legion state`/`plan
// check`/`gate`). DEVIATION from the chunk brief, stated: feature.mjs's resolveProject is NOT
// exported/reused here. It answers "which PROJECT", and by default by MAIN REPO ROOT — inside
// a linked worktree `rev-parse --show-toplevel` returns the worktree, so it would refuse every
// real finalize invocation (gate.mjs records the same finding). Its
// {fromAnyWorktree} mode, added for `legion doctor`, resolves the repository from any checkout
// — but it still yields a PROJECT, and finalize needs THE FEATURE (dossier, branch, worktree),
// which only resolveDossier identifies. Unchanged here.
//
// THE RECORD IS LOAD-BEARING DOWNSTREAM: kernel/state.mjs close() requires this `mr` at the
// CURRENT HEAD before it will close a feature 'delivered'.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from '../kernel/args.mjs';
import { readJson } from '../kernel/fsatomic.mjs';
import { git, gitTry, gitUserRepo, worktreeDirt } from '../kernel/git.mjs';
import { FINALIZE_PUSH_ENV } from '../kernel/githooks.mjs';
import { runCapture } from '../kernel/runner.mjs';
import { approvalValid, bumpWrite, receiptProvenance, reviewBindingHolds, unsatisfiedPrefix } from '../kernel/state.mjs';
// THE shared ticket surface (kernel/ticket.mjs): the same validator `feature start --ticket` and
// `legion state ticket-record` write through, and the same resolver `legion doctor` reports — so
// what the operator was shown at start, what doctor says today, and what lands in the MR body and
// on the issue cannot disagree. Never a second copy of either here.
import { closingKeyword, resolveTicketConfig, validateTicketRef } from '../kernel/ticket.mjs';
import { resolveDossier } from './state.mjs';

const USAGE = 'legion finalize [--description-file <path>] [--now <iso>] [--org <org>] [--feature <name>]';

/** The ONE machine-generated line in the MR body (header: BODY = PROSE). Everything else in the
 * body is the session's prose or, absent it, the feature id. Kept as a constant so the "exactly
 * one trailing line" invariant is a single token a test can bind to. */
const BODY_TRAILER = 'Opened by legion finalize · evidence trail in the feature dossier.';

// origin is the only remote legion records (project init stores origin's URL), and the MR
// target is the PINNED base — neither is a flag, so neither can be steered by a caller.
const REMOTE = 'origin';
// A glab call that hangs is a workflow that hangs; 2 minutes is generous for create/view.
const GLAB_TIMEOUT_MS = 120_000;
const GLAB_MAX_BUFFER = 64 * 1024 * 1024;

// --- the injectable seam (all remote effects live behind these two functions) ---------------

/** THE PUSH SUBPROCESS'S ENVIRONMENT, and the only place either variable is set (header: the
 * marker). A pure builder over a base env rather than an inline object literal so the two
 * properties that matter are assertable without pushing anything: the marker IS on the push, and
 * it is NOT on this process (nothing here writes process.env).
 *   GIT_TERMINAL_PROMPT=0 — a missing credential must fail loudly, never hang a headless run.
 *                          Not a redirection var, so gitUserRepo's env keeps it.
 *   LEGION_FINALIZE_PUSH=1 — tells legion's own pre-push guard that this IS the sanctioned push
 *                          (hooks/pre-push.mjs rule 1). Spoofable, deliberately; see the header. */
export function pushEnv(base = process.env) {
  return { ...base, GIT_TERMINAL_PROMPT: '0', [FINALIZE_PUSH_ENV]: '1' };
}

/** The REAL runner: the only place in the kernel that talks to a remote. */
export function realIo() {
  return {
    /** Push `branch` to `remote`. THE one remote write in legion3.
     * FULLY-QUALIFIED REFSPEC so no `push.default`/HEAD ambiguity in the operator's config can
     * push something other than the branch we just verified; NEVER --force (a force-push can
     * destroy review history and is not finalize's business); the environment is pushEnv's — see
     * its docblock for both variables and why the marker is set HERE and nowhere else. */
    gitPush(worktree, remote, branch) {
      // MUTATION under the user's git config (kernel/git.mjs header E): the push needs their
      // credential helper / url.insteadOf, which hardened config (GIT_CONFIG_GLOBAL=/dev/null)
      // strips. Repo/index REDIRECTION is still removed, which is the hazard that matters.
      // Running under the user's config also means running their HOOKS — including legion's own
      // pre-push guard, which pushEnv's marker is what this push identifies itself to.
      return gitUserRepo(['push', '--set-upstream', remote, `refs/heads/${branch}:refs/heads/${branch}`], worktree,
        { env: pushEnv(process.env) });
    },
    /** Run `glab` with an explicit argv (no shell, ever) in `cwd`. glab derives the GitLab
     * project from cwd's git remote, so an ambient GIT_DIR would aim it at another repository:
     * the redirection vars are stripped and nothing else is (GITLAB_TOKEN, PATH must survive). */
    glab(args, cwd) {
      // The spawn (no shell, redirection-vars purged) lives in kernel/runner.mjs; the
      // CLASSIFICATION stays here, because finalize's contract is "any glab failure is a loud
      // throw" while doctor's is "an API failure is a warn". The message shape is unchanged.
      const r = runCapture('glab', args, { cwd, timeoutMs: GLAB_TIMEOUT_MS, maxBuffer: GLAB_MAX_BUFFER });
      if (!r.ok) {
        const detail = `${r.stdout}${r.stderr}`.trim() || r.spawnError || `exit ${r.code}`;
        throw new Error(`glab ${args.join(' ')} (in ${cwd}) failed: ${detail}`);
      }
      return r.stdout;
    },
  };
}

// --- manifests -------------------------------------------------------------------------------

/** Read a dossier manifest, asserting schemaVersion 1 — the same four lines gate.mjs carries,
 * duplicated rather than widening the kernel's private readManifest into an export. */
function readManifest(path, hint) {
  if (!existsSync(path)) throw new Error(`no ${basename(path)} at ${path} — run \`${hint}\` first`);
  const doc = readJson(path); // corrupt JSON dies loudly naming the path
  if (doc.schemaVersion !== 1) {
    throw new Error(`unknown schemaVersion ${JSON.stringify(doc.schemaVersion)} in ${path} — this kernel reads/writes schemaVersion 1 only`);
  }
  return doc;
}

/** worktreeDirt()'s best-effort path report — it can legitimately be EMPTY on a dirty tree
 * (kernel/git.mjs header F(f)), so say what that means instead of printing nothing. */
const dirtyList = (paths) =>
  paths.length === 0
    ? 'git status reported nothing — a config knob is silencing it, or a submodule directory is ' +
      'empty (uninitialised): run `git submodule update --init` in the worktree'
    : `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ''}`;

// --- MR read-back -----------------------------------------------------------------------------

/** Parse a glab JSON payload, naming the command and the head of the output on failure — an
 * unparseable read-back must never be mistaken for an absent field. */
function parseMrJson(raw, argv) {
  try {
    const doc = JSON.parse(raw);
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error('payload is not a JSON object');
    }
    return doc;
  } catch (e) {
    const head = String(raw ?? '').slice(0, 200);
    throw new Error(`could not parse \`glab ${argv.join(' ')}\` output as MR JSON: ${e.message}; output began: ${JSON.stringify(head)}`);
  }
}

/** Is an MR ALREADY OPEN for this source branch? `mr create` is NOT retryable — GitLab rejects
 * a second MR for the same source branch — so a run that created one and then failed before
 * recording it would strand the feature with no kernel path to bind the MR that exists. Look
 * first, create only when there is demonstrably none.
 * DECIDED: this reuses `glab mr view <source-branch>` — glab's OWN branch→MR resolution, the
 * SAME argv the read-back already uses — rather than adding an `mr list --source-branch`
 * surface: one glab surface, one parser.
 * A NONZERO glab exit reads as "none open" (that is glab's behaviour for a branch with no MR).
 * Reading a transient glab outage as "none" is safe BY CONSTRUCTION: the create that follows
 * then fails closed on GitLab's duplicate rejection. A ZERO exit whose payload will not parse
 * still throws — that is an anomaly, not an absence. */
function probeOpenMr(io, f) {
  const argv = ['mr', 'view', f.branch, '--output', 'json'];
  let raw;
  try { raw = io.glab(argv, f.worktree); } catch { return null; }
  return parseMrJson(raw, argv);
}

/** Fail-closed validation of the MR the SERVER reported. A fabricated or mismatched record is
 * worse than no record: it would let `close delivered` (and any reader) believe a verified MR
 * exists against the pinned base when it does not. */
function validateMr(mr, { branch, baseBranch }, head) {
  const bad = [];
  if (!Number.isInteger(mr.iid)) bad.push(`iid must be an integer, got ${JSON.stringify(mr.iid)}`);
  if (typeof mr.web_url !== 'string' || mr.web_url.length === 0) bad.push(`web_url must be a non-empty string, got ${JSON.stringify(mr.web_url)}`);
  if (mr.target_branch !== baseBranch) bad.push(`target_branch is ${JSON.stringify(mr.target_branch)}, expected the PINNED base ${JSON.stringify(baseBranch)}`);
  if (mr.source_branch !== branch) bad.push(`source_branch is ${JSON.stringify(mr.source_branch)}, expected ${JSON.stringify(branch)}`);
  // `sha` is optional across glab versions — checked only when present, never invented.
  if (mr.sha != null && mr.sha !== head) bad.push(`sha is ${JSON.stringify(mr.sha)}, expected the pushed HEAD ${head}`);
  if (bad.length > 0) throw new Error(`the MR read back from GitLab does not match this feature: ${bad.join('; ')}`);
  return mr;
}

/** THE MR BODY (header: BODY = PROSE). `description` is the session-authored text read from
 * `--description-file`, or null. The kernel contributes EXACTLY the trailing line and nothing
 * else: no hash, no receipt field, no review count. Absent prose the body is the feature id plus
 * that line — deterministic, never invented, so an operator who forgot the flag gets an obviously
 * bare MR rather than a machine-written one that reads like it was authored.
 * The prose is right-trimmed so the trailer sits one blank line below it whatever the file ends
 * with; nothing else about the author's bytes is touched. */
function mrBody(f, description, ticket = null) {
  const prose = description === null ? `legion feature ${f.featureId}` : description.replace(/\s+$/, '');
  // The closing reference JOINS the kernel tail rather than forming a third block: the body's
  // contract is prose plus ONE machine-generated tail, and a ticketed feature does not get a
  // looser one. `null` ⇒ the tail is BODY_TRAILER alone, byte-for-byte what it has always been.
  const tail = ticket === null ? BODY_TRAILER : `${ticket.closingLine}\n${BODY_TRAILER}`;
  return `${prose}\n\n${tail}`;
}

/**
 * THE TICKET, RESOLVED AT THE MOMENT OF USE (header: the ticket is DATA, resolved at read time and
 * pinned nowhere). `null` for a ticket-less feature — and that path reads NO config file at all,
 * which is what makes a ticket-less finalize's determinism a property of the code rather than a
 * claim about it.
 * THROWS on garbage, and the caller turns that into a refusal BEFORE the push. Two things can be
 * wrong here and both must be loud: a `ticket` field that is not a reference (only a hand-edit can
 * produce one — `feature start --ticket` and `legion state ticket-record` share this validator —
 * but composing a link out of garbage is not a thing this kernel does), and a present-but-
 * unreadable org.json, which the resolver refuses rather than reading as absent.
 * THE EFFECTIVE PROJECT: the ref's OWN project wins over the configured one. A `group/project#123`
 * names the issue explicitly and completely, so honouring config over it would post the comment
 * somewhere the operator did not point at. Absent one, the resolved `ticketProject` decides, and
 * `null` there means "the issues live in the code repo's own GitLab project" — rendered as a bare
 * `#123` and posted with no repo flag, letting glab resolve the project from the worktree's remote
 * exactly as it does for the MR. The kernel never derives that path itself — glab is
 * the forge — which is also why "differs from the code repo's own project" is expressed as "a
 * project is configured at all": a configured value equal to the code repo's own is harmless — it
 * renders the long form of the same reference and GitLab resolves it identically.
 */
function resolveFeatureTicket(f, featurePath) {
  if (f.ticket == null) return null;
  const parsed = validateTicketRef(f.ticket, `the \`ticket\` field of ${featurePath}`);
  const config = resolveTicketConfig(f.org, f.project);
  const project = parsed.project ?? config.ticketProject.value;
  const reference = project === null ? `#${parsed.iid}` : `${project}#${parsed.iid}`;
  return {
    // The ISSUE NUMBER, not the operator's bytes: `glab issue note` takes the iid. The verbatim
    // ref stays in the manifest (kernel/ticket.mjs never normalises what was typed); rendering is
    // where it must become a reference GitLab can resolve, since a bare `123` in an MR body links
    // nothing at all.
    iid: parsed.iid,
    project,
    reference,
    closingLine: `${closingKeyword(config.ticketClosingStyle.value)} ${reference}`,
  };
}

/** THE TICKET COMMENT (header: the second comment, same mechanics, different audience). Composed
 * from THE EVENT and nothing else: where the merge request is, and what just happened to it. The
 * gates-green claim, the policy re-pin trail and the tier-0 warning are deliberately ABSENT — they
 * are for the human who is about to merge, they live on the MR, and a second copy on the issue
 * would be evidence shown to readers who cannot act on it and who would then have two places to
 * check. What the issue's readers want from legion is a link and a date. */
function ticketComment(f, mr, head, at) {
  return [
    `**legion finalize** — merge request ${mr.web_url} updated at ${at}.`,
    '',
    `Feature \`${f.featureId}\`: \`${f.branch}\` → \`${f.baseBranch}\`, head \`${head}\`.`,
    'The gate and review trail for this event is on the merge request.',
  ].join('\n');
}

/** The names of a PINNED tier's commands, in execution order, for a human (never hashes).
 * Defensive about shape because feature.json's `commandPolicy` can be hand-edited and this text is
 * composed for the TASK tier too, which C3 never validated — receiptProvenance checks the tier
 * being consumed, not both. */
function policyWords(f, tier) {
  const triples = f.commandPolicy?.[tier];
  if (!Array.isArray(triples)) return 'not recorded';
  const names = triples.filter((t) => Array.isArray(t) && typeof t[0] === 'string').map((t) => t[0]);
  return names.length === 0 ? 'no declared commands (tier-0 only)' : names.join(', ');
}

/** THE FINALIZE-EVENT COMMENT (header: COMMENTS = PROCESS METADATA). One per successful finalize
 * event, append-only, composed from the evidence AS IT STANDS NOW — which is precisely why a
 * re-finalize after a fixup tells the truth where a body written once could not.
 * WHAT IT MUST CARRY, and none of it is cosmetic:
 *   - the GATES-GREEN CLAIM IN WORDS: tier, the commands that ran, that they exited green, and the
 *     HEAD they certify. C3 has already passed when this is composed, so every `results[i].name` is
 *     a non-empty string and every `exitCode` is 0 (kernel/state.mjs receiptProvenance) — the text
 *     states what the kernel verified, not what the receipt claims.
 *   - `declaredCommands: 0` said as TIER-0 ONLY. A green certificate that means "no secrets
 *     committed" must never read like a full one — the same rule `gate run`'s GREEN line and
 *     the SessionStart digest obey.
 *   - the `--allow-config` waiver when it was used: an explicit operator waiver of tier-0's config
 *     protection, and the reviewer is the one person who can judge whether it was warranted.
 *   - EVERY gate-policy re-pin, read from `feature.json`'s `commandPolicyHistory` and NOT from the
 *     receipt. A re-pin cannot be prevented (an agent with Bash can edit the project config and
 *     re-pin in one command), so the whole guarantee is that it cannot happen QUIETLY, and this is
 *     where the trail reaches a human. Reading it off the receipt was the first version and it
 *     missed two cases: a re-pinning run that goes RED mints no receipt at all, and a re-pin moves
 *     BOTH tiers while only the running tier's receipt is stamped, so a weakened TASK gate arrived
 *     invisible. The receipt's `repinnedFrom` is still rendered, as the narrower fact ("this
 *     certificate was earned across a policy change") — neither is duplication of the other.
 * DELIBERATE SHORTFALL, stated because a `<from> → <to>` rendering is what would be wanted and the
 * data cannot honestly supply it: `commandPolicyHistory` records both sides as POLICY HASHES ONLY, and hashes
 * are exactly what this MR no longer carries. The superseded command LISTS are retained nowhere,
 * so no rendering could name them. What is rendered instead is every fact that survives: which
 * TIER moved, WHEN, and — in words — what the policy this MR is certified by runs TODAY. The gap
 * is named in the text rather than papered over. */
function finalizeComment(f, tasks, head, at) {
  const b = tasks.receipts.boundary;
  const L = [`**legion finalize** — merge request updated at ${at}.`, ''];

  L.push(`**Gates: GREEN.** The boundary gate certifies commit \`${head}\`.`);
  if (b.declaredCommands === 0) {
    L.push(
      '',
      'TIER-0 ONLY — a real but WEAK certificate: this project declares no boundary gate commands,',
      'so the gate checked only "no secrets committed, no protected config edited". It says NOTHING',
      'about tests, lint or types. Declare `gates.commands` + `gates.boundary` in the project config.',
    );
  } else {
    L.push('', `${b.declaredCommands} declared boundary command(s) ran and every one exited 0: ${b.results.map((r) => r.name).join(', ')}.`);
  }
  if (b.allowConfig === true) {
    L.push(
      '',
      '**`--allow-config` waiver used.** Tier-0\'s protected-config guard was deliberately waived for',
      'this certificate. Check what configuration the diff touches.',
    );
  }

  // Malformed entries are FILTERED, not trusted: only a hand-edit can produce one (every entry
  // repinCommandPolicy writes has object from/to and a string at), and this text is composed after
  // the MR is recorded, where a TypeError would cost the comment for no reason.
  const hist = (Array.isArray(f.commandPolicyHistory) ? f.commandPolicyHistory : [])
    .filter((h) => h !== null && typeof h === 'object');
  if (hist.length > 0) {
    L.push('', `**This tree was certified under a gate policy that changed mid-feature** (${hist.length} change(s)):`);
    for (const h of hist) {
      const when = typeof h.at === 'string' ? h.at : 'an unrecorded time';
      for (const tier of ['task', 'boundary']) {
        // ONE WORDING FOR BOTH SIDES OF THE MOVE. `from` is null only for a dossier that never
        // carried a pin at all (`feature start` writes both tiers, even for the empty `gates: {}`
        // policy), so a "was previously unpinned" variant would be a branch no reachable state
        // renders — and "changed" is true of that state too.
        if ((h.from?.[tier] ?? null) === (h.to?.[tier] ?? null)) continue;
        L.push(`- the ${tier} gate policy changed at ${when}`);
      }
    }
    L.push(
      '',
      `The policy this merge request is certified by runs — boundary: ${policyWords(f, 'boundary')}; task: ${policyWords(f, 'task')}.`,
      'The superseded policies are retained in the feature dossier as fingerprints only, so their',
      'command lists cannot be shown here. `legion gate run --repin` is audited, not prevented:',
      'confirm the policy above is the one you expect before merging.',
    );
  }
  if (typeof b.repinnedFrom === 'string') {
    L.push('', 'This boundary certificate was itself earned across a policy re-pin.');
  }
  return L.join('\n');
}

// --- the command --------------------------------------------------------------------------------

/** The testable core. `io` is the injected runner (realIo() in production, a recording fake in
 * tests). Returns a numeric exit code; refusals are nonzero and reach `io` never. */
export async function finalizeCore(argv, io) {
  // argv UNSPLIT (parseArgs binds `--feature=x` inline itself — mirrors state.mjs/gate.mjs).
  const { flags, positional } = parseArgs(argv, { bools: [] });
  if (positional.length > 0) {
    throw new Error(`legion finalize takes no positional arguments (got '${positional.join(' ')}'). usage:\n${USAGE}`);
  }
  const now = flags.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error(`invalid --now '${flags.now}' — must be a parseable timestamp`);

  const refuse = (msg) => {
    process.stderr.write(`finalize REFUSED — nothing was pushed: ${msg}\n`);
    return 1;
  };

  // --- the MR body's prose, resolved BEFORE the dossier and long before the remote --------------
  // An unreadable description file must never be discovered after a push. REALPATH-CHECKED like
  // every other caller-supplied path in the kernel (state.mjs artifactRecord), and the REAL path is
  // what every refusal names, so a symlink cannot make the message describe a different file.
  let description = null;
  if (flags['description-file'] != null) {
    const given = flags['description-file'];
    let real;
    try { real = realpathSync(given); } catch (e) {
      return refuse(
        `--description-file ${given} does not exist (${e.code ?? e.message}) — write the MR overview ` +
        `first (what changed, why, how to review it); the kernel never invents prose`,
      );
    }
    let text;
    try { text = readFileSync(real, 'utf8'); } catch (e) {
      return refuse(`--description-file ${real} could not be read as UTF-8 text: ${e.message}`);
    }
    // AN EMPTY FILE IS A REFUSAL, not a silent fallback: passing the flag is a claim that an
    // overview was authored, and honouring it with the id-only fallback would publish an MR that
    // says nothing while the session believes it said something.
    if (text.trim().length === 0) {
      return refuse(
        `--description-file ${real} is empty — an empty overview is not an overview; write what ` +
        `changed, why, and how to review it, or omit the flag for the deterministic fallback body`,
      );
    }
    description = text;
  }

  const dossier = resolveDossier(flags);
  const featurePath = join(dossier, 'feature.json');
  const f = readManifest(featurePath, 'legion feature start');
  const tasks = readManifest(join(dossier, 'tasks.json'), 'legion state init');

  // --- C0: the feature is finalizable at all -------------------------------------------------
  if (f.status !== 'active') {
    return refuse(`feature ${f.featureId} is '${f.status}' — finalize acts only on an active feature`);
  }
  if (typeof f.branch !== 'string' || typeof f.baseBranch !== 'string') {
    return refuse(`feature.json at ${featurePath} is missing branch/baseBranch — the MR target is the PINNED base and cannot be supplied by a caller`);
  }
  if (!existsSync(f.worktree)) {
    return refuse(`worktree ${f.worktree} for feature ${f.featureId} does not exist — re-create the feature or \`legion feature abandon\` it`);
  }

  // --- C1: branch (hardened read — an ambient GIT_DIR here would verify another repo) --------
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], f.worktree);
  if (branch !== f.branch) {
    return refuse(
      branch === 'HEAD'
        ? `worktree ${f.worktree} has a DETACHED HEAD — check out ${f.branch} before finalizing`
        : `worktree ${f.worktree} is on '${branch}', not the feature branch '${f.branch}'`,
    );
  }

  // --- C2: clean worktree (DERIVED tree comparison, never absence of status output) ----------
  const dirt = worktreeDirt(f.worktree);
  if (!dirt.clean) {
    return refuse(`worktree ${f.worktree} is dirty (${dirtyList(dirt.paths)}) — commit or clean it, re-gate, then finalize`);
  }

  // --- C3: a boundary receipt for the CURRENT HEAD ------------------------------------------
  const head = git(['rev-parse', 'HEAD'], f.worktree);
  const boundary = tasks.receipts?.boundary;
  if (!boundary) {
    return refuse('no boundary receipt recorded — run `legion gate run --boundary` on this commit first');
  }
  if (boundary.head !== head) {
    return refuse(
      `boundary receipt is for ${boundary.head}, current HEAD is ${head} — stale, re-gate: \`legion gate run --boundary\``,
    );
  }
  const prov = receiptProvenance(boundary, {
    tier: 'boundary',
    pinnedHash: f.commandPolicyHash?.boundary,
    pinnedTriples: f.commandPolicy?.boundary,
  });
  if (!prov.ok) {
    return refuse(
      `the boundary receipt fails GATE PROVENANCE: ${prov.why} — re-gate: \`legion gate run --boundary\``,
    );
  }

  // --- C4: a HASH-VALID pre-merge approval (the kernel's own recomputation, not a copy) ------
  if (!approvalValid('pre-merge', tasks, f)) {
    return refuse(
      'no hash-valid pre-merge approval — record it with `legion state decision-record pre-merge` ' +
      'AFTER the boundary receipt and the reviews (a review recorded afterwards drifts the subject and invalidates it)',
    );
  }

  // --- C5: a passing product/milestone review, BOUND to the tree being finalized -------------
  // reviewBindingHolds is the kernel's one definition of "this verdict still describes the live
  // subject" — a pass earned on an older tree (the ordinary fixup loop moves HEAD) is a FACT that
  // stays recorded but no longer satisfies C5; the fixup loop's own protocol is fixup → re-gate →
  // NEW review → re-approve.
  const productReview = tasks.reviews.some(
    (r) => r.verdict === 'pass'
      && (r.subject === 'feature' || String(r.subject).startsWith('milestone:'))
      && reviewBindingHolds(r, tasks, f),
  );
  if (!productReview) {
    return refuse(
      'no passing product/milestone review bound to the CURRENT tree — record one with `legion state ' +
      'review-record --role <role> --verdict pass --subject feature` after the final commit (a ' +
      '`task:<id>` review is per-task sign-off and does not count; a pass recorded on an older tree ' +
      'died with the tree it judged)',
    );
  }

  // --- C6: the finalize STAGE + the whole lifecycle prefix, re-derived NOW (header — after the
  // evidence chain, before the idempotent exit) ------------------------------------------------
  if (f.stage !== 'finalize') {
    return refuse(
      `feature ${f.featureId} is in stage '${f.stage}', not 'finalize' — finalize is the end of a ` +
      `lifecycle, not a command that happens to find valid receipts; walk the remaining stages first`,
    );
  }
  const stale = unsatisfiedPrefix('finalize', tasks, f);
  if (stale) {
    return refuse(`lifecycle stage '${stale.stage}' no longer re-derives satisfied: ${stale.why}`);
  }

  // --- the ticket: NOT a condition, but resolved HERE (header) --------------------------------
  // It gates nothing — a ticket-less feature is finalizable and always was. What this placement
  // buys is that its two ways of failing (a garbage `ticket` field, a present-but-unreadable
  // org.json) land as ORDINARY REFUSALS with nothing pushed, instead of surfacing after the push
  // where no refusal can undo anything. It sits before the idempotence exit as well, so a broken
  // ticket config reads the same on every run rather than only when HEAD has moved.
  let ticket;
  try {
    ticket = resolveFeatureTicket(f, featurePath);
  } catch (e) {
    return refuse(`the feature's ticket could not be resolved: ${e.message}`);
  }

  // --- idempotence: decided BEFORE any remote call -------------------------------------------
  const priorMr = f.mr ?? null;
  if (priorMr && priorMr.headSha === head) {
    process.stdout.write(
      `finalize: MR !${priorMr.iid} already recorded for HEAD ${head} → ${priorMr.url}\n` +
      `nothing to do (idempotent re-run: no push, no MR, no write)\n`,
    );
    return 0;
  }

  // Optional, cheap, hardened precheck. NOTE it is a REPORT, not authority: url.insteadOf lives
  // in global config, which the hardened read neutralises, so the URL shown here may not be the
  // one the push resolves. Its job is to refuse EARLY when there is no origin at all.
  if (gitTry(['remote', 'get-url', REMOTE], f.worktree) === null) {
    return refuse(`no \`${REMOTE}\` remote in ${f.worktree} — nothing to finalize against`);
  }

  // --- verify → push → look up → create only if absent → read back → re-read → record --------
  let pushed = false;
  let created = false;
  let recorded = false;
  try {
    io.gitPush(f.worktree, REMOTE, f.branch);
    pushed = true;
    process.stdout.write(`finalize: pushed ${f.branch} → ${REMOTE} (HEAD ${head})\n`);

    let mr;
    if (priorMr) {
      // The MR already exists and tracks the branch — the push above updated it. Never a
      // second `mr create`; read back BY IID so we re-record the SAME MR. A RECORDED MR must
      // read back: a failure here is LOUD, never "assume it is gone".
      const argv = ['mr', 'view', String(priorMr.iid), '--output', 'json'];
      mr = parseMrJson(io.glab(argv, f.worktree), argv);
      process.stdout.write(`finalize: MR !${priorMr.iid} already open — skipping create, re-reading it\n`);
    } else {
      mr = probeOpenMr(io, f);
      if (mr) process.stdout.write(`finalize: an MR is already open for ${f.branch} — skipping create, recording it\n`);
    }
    if (!mr) {
      io.glab(
        ['mr', 'create', '--source-branch', f.branch, '--target-branch', f.baseBranch,
          '--title', f.name, '--description', mrBody(f, description, ticket), '--yes'],
        f.worktree,
      );
      created = true;
      process.stdout.write(`finalize: opened an MR ${f.branch} → ${f.baseBranch} (the PINNED base)\n`);
      const argv = ['mr', 'view', f.branch, '--output', 'json'];
      mr = parseMrJson(io.glab(argv, f.worktree), argv);
    }
    validateMr(mr, f, head); // fail-closed field validation of what the SERVER said

    // The window between reading feature.json and this write contains a push and two glab round
    // trips — long enough for the SessionStart `session-record` hook (covers
    // startup|resume|clear|compact) or a second session in this worktree to have written the
    // manifest. Writing {...f} would silently REVERT that write and reuse the revision it
    // consumed, breaking the monotonic-revision invariant kernel/state.mjs's header states.
    // Re-read and refuse loudly if it moved. (Structurally the same read-modify-write every
    // typed op does; finalize is only the one whose window holds network I/O — closed here,
    // without touching the op model.)
    const fresh = readManifest(featurePath, 'legion feature start');
    if (fresh.revision !== f.revision) {
      throw new Error(
        `feature.json changed while finalize was talking to the remote (revision ${f.revision} → ${fresh.revision}) — ` +
        `refusing to overwrite it. THE MR IS OPEN: !${mr.iid} ${mr.web_url}. Re-run \`legion finalize\`: it resolves that ` +
        `MR by source branch and records it without opening a second one.`);
    }
    bumpWrite(featurePath, {
      ...fresh,
      mr: { iid: mr.iid, url: mr.web_url, targetBranch: f.baseBranch, headSha: head, at: now },
    }, now);
    recorded = true;
    process.stdout.write(`finalize: recorded MR !${mr.iid} → ${mr.web_url} (target ${f.baseBranch}, head ${head})\n`);

    // --- the append-only finalize-event comment (header: COMMENTS = PROCESS METADATA) -----------
    // LAST, and in its OWN try: everything above is the finalize the operator asked for, and it has
    // succeeded. COMPOSITION sits inside that try as well as the post, so a hand-edited manifest
    // costs the note and nothing else. Exit stays 0 — the header says why that is honesty, not
    // leniency: the push happened, the MR exists, feature.json records it.
    let comment = null;
    try {
      comment = finalizeComment(f, tasks, head, now);
      io.glab(['mr', 'note', String(mr.iid), '--message', comment], f.worktree);
      process.stdout.write(`finalize: posted the gates-green comment on MR !${mr.iid}\n`);
    } catch (err) {
      process.stderr.write(
        `finalize: THE MR COMMENT COULD NOT BE POSTED: ${err?.message ?? err}\n` +
        `  THE MR EXISTS AND IS RECORDED: !${mr.iid} ${mr.web_url} — the push, the merge request and ` +
        `feature.json are all done, so finalize SUCCEEDED and nothing is rolled back.\n` +
        `  What is missing is this event's process-metadata comment. An idempotent re-run at the same ` +
        `HEAD does nothing at all, so it will NOT post it: paste the text below by hand, or let the ` +
        `next real finalize event carry its own (comments are append-only).\n` +
        // Never recomposed in the handler: if COMPOSITION is what threw, calling it again here
        // would throw again, out of a catch block, and turn a lost comment into a failed process.
        `${comment === null ? '  (the comment could not even be composed — feature.json or tasks.json has been hand-edited)\n' : `--- 8< ---\n${comment}\n--- >8 ---\n`}`,
      );
    }

    // --- the append-only TICKET comment (header: two comments, two independent trys) -----------
    // A SEPARATE try, deliberately, and it is the whole reason this is not one block with the MR
    // comment above: the two posts hit different objects with different permissions, and either
    // can fail on its own. Sharing a try would make a lost MR comment silently cost the issue
    // comment too — one failure, two missing notes, and the operator told about one of them.
    // SKIPPED WHOLE for a ticket-less feature: no composition, no call, nothing printed.
    // Append-only, exactly as above: `issue note` ADDS. There is no update/edit/delete argv here
    // and there is never going to be one — the sequence of comments IS the trail (the
    // facts-not-conclusions rule), and an edited note rewrites a fact somebody already read.
    if (ticket !== null) {
      let note = null;
      try {
        note = ticketComment(f, mr, head, now);
        io.glab(
          // `--repo` is glab's own project selector, and it is OMITTED when no ticket project is
          // resolved so that glab falls back to the worktree's remote — the same resolution every
          // other glab call in this file relies on. Passing a derived path there instead would be
          // the kernel guessing at something the forge already knows.
          ['issue', 'note', ticket.iid, '--message', note, ...(ticket.project === null ? [] : ['--repo', ticket.project])],
          f.worktree,
        );
        process.stdout.write(`finalize: posted the finalize-event comment on issue ${ticket.reference}\n`);
      } catch (err) {
        process.stderr.write(
          `finalize: THE TICKET COMMENT COULD NOT BE POSTED on issue ${ticket.reference}: ${err?.message ?? err}\n` +
          `  THE MR EXISTS AND IS RECORDED: !${mr.iid} ${mr.web_url} — the push, the merge request and ` +
          `feature.json are all done, so finalize SUCCEEDED and nothing is rolled back.\n` +
          `  What is missing is this event's note on the issue. An idempotent re-run at the same HEAD ` +
          `does nothing at all, so it will NOT post it: paste the text below by hand, or let the next ` +
          `real finalize event carry its own (comments are append-only).\n` +
          // Never recomposed in the handler, for the reason the MR comment's handler states: a
          // composition failure would throw again, out of a catch, and cost the process.
          `${note === null ? '  (the comment could not even be composed — feature.json has been hand-edited)\n' : `--- 8< ---\n${note}\n--- >8 ---\n`}`,
        );
      }
    }
    return 0;
  } catch (err) {
    // LOUD, and honest about the remote state: the push/MR that DID happen is reported, and no
    // partial or fabricated `mr` object is ever written.
    process.stderr.write(
      `finalize FAILED AFTER THE REMOTE WRITE: ${err?.message ?? err}\n` +
      `  branch pushed to ${REMOTE}: ${pushed ? `YES — ${f.branch} @ ${head}` : 'no'}\n` +
      `  merge request opened:      ${created ? `YES — ${f.branch} → ${f.baseBranch}` : (priorMr ? `pre-existing !${priorMr.iid}` : 'no')}\n` +
      `  recorded in feature.json:  ${recorded ? 'yes' : 'NO'}\n` +
      `CHECK GITLAB BY HAND: an MR may exist that legion does not know about. Re-run ` +
      `\`legion finalize\` once glab works — it never opens a SECOND MR for this branch: it resolves ` +
      `the one that already exists (by iid when recorded, by source branch otherwise) and records it.\n`,
    );
    return 1;
  }
}

/** The router entry point: the real runner, wired. */
export async function run(argv) {
  return finalizeCore(argv, realIo());
}
