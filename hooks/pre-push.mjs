#!/usr/bin/env node
// pre-push.mjs — THE LOCAL PRE-PUSH GUARD (PLAN-V3 §Remote safety layer 3, the git-hook half).
// Not a Claude Code hook: git runs it, through the stub src/kernel/githooks.mjs installs into
// `<git common dir>/hooks/pre-push`. It is listed nowhere in hooks/hooks.json and no event
// dispatches it.
//
// WHAT IT IS, AND THE SENTENCE THAT GOVERNS EVERY MESSAGE BELOW. Layer 1 (GitLab protected
// branches + the agent identity's permissions) is the hard boundary and the ONLY guarantee;
// layer 2 is `legion finalize`, the intended path; this is layer 3, DEPTH. In finalize.mjs's
// words: "it can refuse a push the server would have accepted, it can never make a push the
// server accepts safe." So this file BLOCKS THE ORDINARY PATH to a raw push — the `git push`
// an erring or over-helpful agent types when finalize refused. It PREVENTS nothing:
//   - `git push --no-verify` skips every pre-push hook. That is git's own switch, it is the
//     operator's documented escape hatch, and every refusal below names it;
//   - the LEGION_FINALIZE_PUSH marker (rule 1) is an environment variable, so anything that can
//     set an environment variable can claim to be finalize. It is a COORDINATION token between
//     two parts of legion, never an authentication of one — see rule 1;
//   - a `core.hooksPath` outside this repository's config, another git implementation, a
//     library, an MCP server: none of them run this file at all.
// Every one of those is documented depth, not a defect. THE SERVER refuses what it refuses, and
// `legion doctor`'s branch-protection check is where that is verified.
//
// THE CONTRACT GIT GIVES US (git 2.50.1, `githooks(5)`): argv is `<remote name> <remote URL>`,
// stdin carries one line per pushed ref — `<local ref> <local sha> <remote ref> <remote sha>` —
// and a NON-ZERO exit aborts the whole push. cwd is the root of the working tree the push came
// from. A zero exit must be SILENT: this hook runs on every push in every managed repository,
// and a chatty allow is noise an operator learns to scroll past, which is how the one line that
// mattered gets missed.
//
// RESOLUTION IS DERIVED FROM cwd, NEVER FROM THE ENVIRONMENT — and here that is not paranoia,
// it is the documented in-scope case: GIT ITSELF exports GIT_DIR (and often GIT_WORK_TREE) into
// a hook's environment. Ambient redirection is therefore GUARANTEED to be present rather than
// merely possible, and a naive `git rev-parse` inside this process would answer about whatever
// those variables point at. Every git read below goes through the kernel's hardened seam
// (kernel/git.mjs header B/E), which deletes every GIT_* variable before spawning, so the
// question "which repository is this push leaving?" is answered by cwd alone.
//
// THE DECISION RULE, in order, evaluated over the pushed refs (T25 spec A):
//   1. the LEGION_FINALIZE_PUSH marker is set ⇒ ALLOW — this is `legion finalize`'s own push.
//      IT EXISTS BECAUSE finalize's push is a REAL `git push` under the operator's git config
//      (src/cli/finalize.mjs realIo), so this hook fires on it, and rule 3 would otherwise block
//      the one sanctioned way a feature branch leaves the machine. SPOOFABLE BY CONSTRUCTION,
//      and that is fine: an agent that can export a variable can also pass `--no-verify`, so the
//      marker adds no capability anyone lacked. It is not a lock; it is how two halves of legion
//      avoid tripping over each other.
//   2. the pushed ref targets a branch in the registered project's `protectedBranches` ⇒ BLOCK.
//      Matching is branchPatternMatches from kernel/branches.mjs — THE definition `legion
//      doctor` uses, imported rather than copied, so the guard and the server-side report cannot
//      disagree about what `release/*` covers.
//   3. a REGISTERED FEATURE is involved ⇒ BLOCK: a feature branch leaves this machine through
//      `legion finalize`. TWO LIMBS, because one of them alone leaves the hole this rule exists
//      to close:
//        3a. the pushed remote ref NAMES a branch recorded in the project's feature index
//            (`entry.features[].branch`, written by `legion feature start`). Keyed on the REF, so
//            it fires from ANY checkout of the repository — the main one included. Without this
//            limb `cd ..` inside the same repository publishes the feature branch, which is not
//            a documented bypass but a plain miss: the guard would print "no other way" in the
//            worktree and wave the identical push through one directory up.
//        3b. cwd is a REGISTERED FEATURE WORKTREE. Keyed on WHERE the push came from, so it also
//            catches a push of some other ref out of a feature checkout, and it still decides
//            when git hands us no parseable ref lines at all.
//      Neither limb is narrowed to active features — a delivered or abandoned feature's branch is
//      still a legion branch, and fail-closed is the house rule when the distinction buys nothing.
//      3a CANNOT over-block the operator's own work: `branch` only ever holds a name `legion
//      feature start` itself created, so matching it never names a branch legion did not make.
//   4. otherwise ⇒ ALLOW, silently. The operator's ordinary work in their own repositories is
//      none of legion's business, and a guard that taxes every unrelated push is a guard that
//      gets uninstalled.
//
// FAIL-CLOSED, AND WHERE THE LINE IS. "Cannot answer" ⇒ BLOCK, naming the cause. "Answered:
// nothing here is legion-managed" ⇒ ALLOW. The distinction is exactly hooks/_common.mjs's
// ABSENT-vs-CORRUPT rule and it is drawn with existsSync for the same reason:
//   - NO projects.json at all ⇒ nothing on this machine is registered ⇒ allow. Blocking would
//     mean that removing ~/.legion makes every repository that still carries the stub unpushable
//     until a human deletes the hook — a bricked repo, in the one direction that buys no safety
//     (an unregistered repository has no protected set and no feature worktrees to protect);
//   - projects.json PRESENT but unparseable / wrong-shaped, project.json unreadable, a repo
//     matching MORE THAN ONE registered project (the ambiguity resolveProject refuses with
//     --org, which a hook has no way to supply) ⇒ BLOCK naming the cause. There the answer is
//     unknown, not "no".
//
// COST: two `git` subprocesses (toplevel + worktree list) plus at most a handful of small JSON
// reads, on every push in a managed repository. Measured well under the round trip of the push
// it precedes.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, mainWorktreeRoot } from '../src/kernel/git.mjs';
import { branchPatternMatches } from '../src/kernel/branches.mjs';
import { FINALIZE_PUSH_ENV } from '../src/kernel/githooks.mjs';
import { readJson } from '../src/kernel/fsatomic.mjs';
// The registry match and the canonical path compare, SHARED with hooks/bash-remote-write.mjs since
// T29 widened it to target-repo scoping and it began asking this same question. A kernel module,
// not hooks/_common.mjs: see the note at the top of this file about _common's chdir.
import { matchProjectByRepoRoot, projectId as labelOf, realish } from '../src/kernel/projectindex.mjs';

/** The escape hatch and the honest limit, appended to EVERY refusal. Two sentences, because a
 * refusal that states only the rule teaches an agent to work around it, while one that states
 * the bypass AND who the real boundary is teaches it to go through `legion finalize`. */
const DEPTH =
  '  This is a LOCAL git hook: DEFENSE IN DEPTH, not the guarantee. It blocks the ordinary path\n'
  + '  and nothing more — `git push --no-verify` skips it outright, and so does any client that\n'
  + '  does not run git hooks. The GitLab server is the boundary that actually refuses a push to a\n'
  + '  protected branch; `legion doctor` is what verifies that it does.\n';

/** Who is speaking, as a CONSTANT rather than inline in the template below. Not style:
 * test/plugin-manifest.test.mjs reads every backtick-delimited legion invocation in a shipped
 * component as a router command and checks it against the real command surface, and a template
 * literal that OPENS with this speaker prefix is read as an invocation of a command called
 * `pre-push`, which does not exist. Interpolating the name keeps the prose identical and the
 * span un-invocation-shaped. */
const SPEAKER = 'legion pre-push guard';

/** BLOCK: one message on stderr, exit non-zero. Every caller passes a `why` that names the
 * subject (branch, feature, or the exact thing that could not be read) — a refusal that does not
 * say which of the four rules fired is a refusal nobody can act on. */
function block(why) {
  process.stderr.write(`${SPEAKER}: PUSH BLOCKED.\n${why}${DEPTH}`);
  process.exit(1);
}

/** ALLOW: silence, exit 0 (header: a chatty allow is noise). */
const allow = () => process.exit(0);

// --- git's stdin, drained FIRST -------------------------------------------------------------
// Before rule 1, deliberately: git writes the ref list into this process's stdin, and exiting
// without reading it leaves git writing into a closed pipe. Draining costs nothing and keeps the
// allow paths indistinguishable from git's point of view. The DECISION order is unaffected —
// rule 1 is still evaluated before anything else is inspected.
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch { stdin = ''; }

// --- rule 1: finalize's own push ------------------------------------------------------------
// PRESENT AND NON-EMPTY. A set-but-empty value is almost always a broken export (paths.mjs makes
// the same judgement about LEGION_HOME), and treating it as "present" would let `export
// LEGION_FINALIZE_PUSH=` — a typo — silently disable the guard for a whole shell session.
const marker = process.env[FINALIZE_PUSH_ENV];
if (typeof marker === 'string' && marker.trim() !== '') allow();

/** The pushed refs, as {localRef, localSha, remoteRef, remoteSha}. Malformed lines are DROPPED
 * rather than guessed at: the fields are positional and a line that does not have four of them
 * is not something to interpret.
 * AN EMPTY LIST IS NOT AN EARLY ALLOW, and that is deliberate: rule 3 does not depend on the
 * refs at all, so returning early on "no ref lines" would hand a bypass to anything that can
 * make git's stdin unreadable, and would also let an "everything up to date" push out of a
 * feature worktree read as sanctioned when it is simply a push that moved nothing. Rules 2, 3
 * and 4 are all still evaluated below; with no refs, rule 2 has nothing to match and rule 3 —
 * which is about WHERE the push came from — decides. */
const refs = stdin.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const parts = l.split(/\s+/);
  return parts.length === 4
    ? { localRef: parts[0], localSha: parts[1], remoteRef: parts[2], remoteSha: parts[3] }
    : null;
}).filter(Boolean);

// --- which repository, and which checkout, DERIVED (header: resolution is from cwd) ----------
let checkout;
let repoRoot;
try {
  checkout = realish(git(['rev-parse', '--show-toplevel'], process.cwd()));
  repoRoot = realish(mainWorktreeRoot(process.cwd()));
} catch (e) {
  block(
    `  Which repository this push comes from could not be determined: ${e?.message ?? e}\n`
    + '  Fail-closed: the guard could not decide, so it did not allow.\n',
  );
}

// --- the registration ------------------------------------------------------------------------
// The DECISION table is kernel/projectindex.mjs's (absent ⇒ allow, present-but-broken ⇒ block,
// unregistered ⇒ allow, ambiguous ⇒ block); the WORDS are this guard's, on git's stderr, in the
// multi-line block shape every refusal here uses. Rules 1–4 are byte-unchanged in meaning.
const match = matchProjectByRepoRoot(repoRoot);
const idxPath = match.indexPath;
if (match.kind === 'absent') allow(); // nothing is registered anywhere (header FAIL-CLOSED)
if (match.kind === 'unreadable') {
  block(
    `  The legion project index ${idxPath} is present but unreadable: ${match.detail}\n`
    + '  Whether this repository is legion-managed cannot be decided, so the guard did not allow.\n',
  );
}
if (match.kind === 'malformed') {
  block(
    `  The legion project index ${idxPath} is present but malformed (${match.detail}).\n`
    + '  Whether this repository is legion-managed cannot be decided, so the guard did not allow.\n',
  );
}
if (match.kind === 'unregistered') allow(); // rule 4: not a legion-managed repository
if (match.kind === 'ambiguous') {
  block(
    `  ${repoRoot} is registered as MORE THAN ONE legion project (${match.ids}), so which project's\n`
    + '  protected branches apply here is ambiguous. A git hook has no `--org` to disambiguate\n'
    + `  with, so it did not allow. Fix the registration in ${idxPath}.\n`,
  );
}
const entry = match.entry;
const projectId = labelOf(entry);

let cfg;
try { cfg = readJson(entry.configPath); } catch (e) {
  block(
    `  Project ${projectId} is registered here, but its config ${entry.configPath} could not be\n`
    + `  read: ${e?.message ?? e}\n`
    + '  Its protected branches are therefore unknown, so the guard did not allow.\n',
  );
}
if (!Array.isArray(cfg?.protectedBranches)) {
  block(
    `  Project ${projectId}'s config ${entry.configPath} records no \`protectedBranches\` array,\n`
    + '  so which branches are protected here is unknown and the guard did not allow.\n'
    + '  Re-record it: `legion project init` (or `--no-protected` for an explicitly empty set).\n',
  );
}

// --- rule 2: a protected branch ---------------------------------------------------------------
/** refs/heads/x ⇒ x; anything else (a tag, a note, a raw sha) ⇒ null. Rule 2 is about BRANCHES,
 * and `protectedBranches` is a list of branch names — matching a tag against them would refuse
 * on a coincidence of spelling. */
const branchOf = (ref) => (ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null);

for (const r of refs) {
  const branch = branchOf(r.remoteRef);
  if (branch === null) continue;
  const pattern = cfg.protectedBranches.find((p) => branchPatternMatches(p, branch));
  if (pattern === undefined) continue;
  // A deletion (`git push origin :main`) lands here too, and correctly so: it targets the
  // protected branch, and removing it is at least as consequential as writing to it.
  block(
    `  '${branch}' is a PROTECTED branch of project ${projectId}\n`
    + `  (recorded by \`legion project init\`: ${cfg.protectedBranches.join(', ')} — matched by '${pattern}').\n`
    + '  Work reaches a protected branch through a merge request, and legion opens that merge\n'
    + '  request from `legion finalize` — the one command that checks the evidence chain first.\n',
  );
}

// --- rule 3: a registered feature -----------------------------------------------------------
/** The shared tail of both limbs' refusal: WHY finalize and not a raw push. One text, because the
 * two limbs describe the same mistake seen from two angles and an operator who reads one must not
 * be able to infer that the other is a different rule with a different remedy. */
const FEATURE_WHY =
  '  A feature branch is published by `legion finalize` and by nothing else: it is what verifies\n'
  + '  the gate receipt, the approvals and the reviews against THIS commit, opens the merge request\n'
  + '  against the pinned base and records what the server returned. A raw push publishes the\n'
  + '  branch with none of that recorded.\n'
  + '  If finalize refused, the refusal named what is missing — fix that, do not push around it.\n';

/** A feature entry's human name, for the refusal. `featureId` is the org/project/feature triple
 * `legion feature start` records; `name` is the fallback for an entry written before it. */
const featureLabel = (f) => f?.featureId ?? f?.name ?? 'unknown';

/** LIMB 3a — the pushed REF names a registered feature branch of this project.
 * Evaluated over the refs and therefore INDEPENDENT OF cwd: the same `git push origin feat/x`
 * is refused from the feature worktree, from the repository's main checkout, and from any other
 * linked worktree of it. `branch` is written into the index by `legion feature start` in the same
 * run that creates the branch (src/cli/feature.mjs), so this only ever matches branches legion
 * itself made — the operator's own branches cannot collide into it.
 * AFTER rule 2's loop, deliberately: a ref that is BOTH protected and a feature branch is a
 * protected-branch push first, and that is the more consequential thing to say about it. */
for (const r of refs) {
  const branch = branchOf(r.remoteRef);
  if (branch === null) continue;
  const f = (entry.features ?? []).find((x) => typeof x?.branch === 'string' && x.branch === branch);
  if (f === undefined) continue;
  block(
    `  '${branch}' is the branch of legion feature ${featureLabel(f)}\n`
    + `  (worktree ${f.worktree ?? 'unknown'}), and this push would publish it from ${checkout}.\n`
    + FEATURE_WHY,
  );
}

/** LIMB 3b — the feature registered for THIS checkout, or null.
 * THE AUTHORITY IS feature.json's recorded `worktree` (T25 spec A). The index entry's copy is the
 * FALLBACK for a feature whose manifest is missing or unreadable, and it is a faithful one: both
 * are written by the same `legion feature start`, in the same run, and nothing updates one
 * without the other. That fallback is what keeps one corrupt dossier from blocking every push in
 * the repository — while still leaving no gap, since escaping rule 3 would mean hand-editing the
 * manifest AND the index. */
function featureForCheckout() {
  for (const f of entry.features ?? []) {
    const candidates = new Set();
    if (typeof f?.worktree === 'string') candidates.add(realish(f.worktree));
    if (typeof f?.dossier === 'string') {
      const manifest = join(f.dossier, 'feature.json');
      if (existsSync(manifest)) {
        try {
          const doc = readJson(manifest);
          if (typeof doc?.worktree === 'string') candidates.add(realish(doc.worktree));
        } catch { /* unreadable manifest ⇒ the index's copy stands (docblock) */ }
      }
    }
    if (candidates.has(checkout)) return f;
  }
  return null;
}

const feature = featureForCheckout();
if (feature !== null) {
  block(
    `  ${checkout} is the worktree of legion feature ${featureLabel(feature)}\n`
    + `  (branch ${feature.branch ?? 'unknown'}).\n`
    + FEATURE_WHY,
  );
}

// --- rule 4 ------------------------------------------------------------------------------------
allow();
