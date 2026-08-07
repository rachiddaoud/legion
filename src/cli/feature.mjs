// feature.mjs — `legion feature start|status|abandon|clean`: the
// deterministic, one-shot feature lifecycle. Evidence is DERIVED, never supplied: the
// project is resolved by matching realpath(git rev-parse --show-toplevel of cwd) against
// ~/.legion/projects.json (refuses without `legion project init`; --org disambiguates),
// and baseSha is pinned via `git rev-parse --verify <base>^{commit}` BEFORE any work.
// ONE SUBCOMMAND RESOLVES BY REPOSITORY RATHER THAN BY CHECKOUT: `status` is READ-ONLY and is
// the first thing a resumed session reaches for, so it takes resolveProject's
// {fromAnyWorktree:true} mode. Every session launches INSIDE the feature
// worktree, and a linked worktree's `rev-parse --show-toplevel` is the WORKTREE, which matches no
// registered project — so under the default mode the one read-only command answered `repo … is
// not a registered project` exactly where it was most needed. `legion doctor` already takes the
// mode for the same reason. start/abandon/clean KEEP the default mode DELIBERATELY: they are
// write paths, and refusing from inside a worktree is itself the guard (`feature abandon f1` run
// in f1's own checkout must not destroy the ground under it; `feature start` must branch off the
// main repo, never off another feature's checkout). The mode's criterion is "read-only, and run
// from the cwd sessions actually stand in" — never convenience.
// TWO THINGS ARE PINNED HERE, FOR THE SAME REASON: the base
// SHA, and the per-tier GATE COMMAND POLICY HASH. A feature must not be able to quietly weaken
// the gate it will be certified by, and comparing a receipt against the LIVE project policy
// cannot stop that — an agent may edit project.json in ~/.legion (which is OUTSIDE the target
// repo, so no tier-0 diff scan can ever see it) and re-gate, after which everything agrees
// consistently under the weaker policy. Pinning makes the comparison against a value the feature
// cannot move without saying so (`legion gate run --repin`, which is audited three ways).
// TWO DELIBERATE CONSEQUENCES: (1) a MALFORMED `gates` block now fails `feature start` — strictly
// earlier and louder than failing at the first gate run; (2) `--repair` re-writes the manifest by
// SPREAD, so the pin carries through untouched (repair re-runs bootstrap only, never a re-pin).
// start order is fixed so every failure leaves a recoverable, discoverable state:
//   pin baseSha + gate policy → write feature.json (status active) → git worktree add -b feat/<name>
//   at <repo-parent>/.legion-worktrees/<project>/<name>/checkout → register the feature
//   in projects.json (lock+CAS, BEFORE bootstrap so failed features stay discoverable)
//   → run bootstrap → print the exact launch command for --launch=interactive(default)
//   |background|remote.
// THE LAUNCH LINE CARRIES --plugin-dir IN DEVELOPMENT.
// The CLI's OWN FILE LOCATION is the evidence of how legion is installed — never cwd, which
// belongs to the target repo — and Claude Code keeps marketplace installs under its config dir's
// `plugins/` (~/.claude/plugins, or CLAUDE_CONFIG_DIR's; validated against 2.1.219/2.1.220). A
// root outside that tree is therefore a development install, whose session would otherwise load
// NO legion plugin at all — no skill, no agents, no hooks — so the printed command names the root
// explicitly, shell-escaped like every other interpolated path.
// Bootstrap entries are structured ONLY ({cwd,argv,timeoutMs} exec'd via execFileSync —
// no shell, ever; {script,sha256} sha256-verified against the WORKTREE copy before
// exec). Bootstrap failure records status 'initialization_failed' (recoverable:
// `start --repair` re-runs bootstrap ONLY — never worktree creation; `abandon` cleans
// up); a fresh start over an existing feature.json refuses UNLESS status is 'abandoned'
// — abandon is the documented restart path, so abandoned names must be startable again.
// Worktree creation failure NEVER strands an 'active' manifest with no worktree: the
// dossier is rolled back (prior abandoned manifest restored, or the fresh one removed)
// and start dies loudly; leftover checkout dirs / feat/<name> branches are detected
// UPFRONT with the exact recovery commands, before any state is written. abandon closes
// the manifest (status abandoned + closedAt) but removes the worktree ONLY when it is
// clean AND holds no commits unreachable from baseSha/remotes — on ANY doubt (dirty,
// unpushed, git unreadable) it retains and reports (fail closed: never destroy work);
// on removal it ALSO deletes feat/<name> (fully reachable by the same checks), so the
// name is genuinely reusable instead of leaking a branch that blocks every restart.
// All paths absolute; feature.json writes are atomic-rename via writeJson.
// `clean` IS THAT SAME GUARDED REMOVAL, DETACHED FROM CLOSING: after
// `legion state close delivered` nothing removes the worktree or feat/<name>. Four properties,
// each load-bearing:
//   - IT REFUSES ON A LIVE FEATURE (status must be delivered|abandoned, and the refusal names
//     the current one). Removing the checkout of a feature still in its lifecycle is exactly
//     the kind of improvised state destruction this command exists to prevent.
//   - IT NEVER TOUCHES THE REMOTE. `legion finalize` is the ONLY remote-write path in this
//     tree and cleanup does not become the second one: no `push
//     --delete`, no `glab`, no fetch. Deleting the remote branch stays a HUMAN act (GitLab's
//     merge/close UI offers it), because the local view of what is pushed is exactly the
//     evidence this command uses to decide it may delete — using it to also destroy the
//     remote copy would remove the only thing that made the deletion safe. Every git call
//     below is local-only: rev-list, show-ref, the derived dirt check, worktree remove,
//     branch -D.
//   - IT NEVER TOUCHES THE DOSSIER OR THE MANIFEST (abandon never deletes
//     the dossier; clean inherits the rule — the dossier is the audit trail, and an
//     initiative sibling may reference it by path+hash). It writes NOTHING:
//     "is it clean" is re-derived from the filesystem and git on every run, which is what
//     makes it idempotent without a flag in the manifest to get out of sync.
//   - THE TWO REMOVALS ARE GUARDED SEPARATELY AND ORDERED. The worktree goes only when
//     worktreeBlocker() says nothing is at risk; feat/<name> goes only AFTER the worktree is
//     gone (git itself refuses to delete a checked-out branch) and only when branchBlocker()
//     finds every commit contained in the pinned base or a remote-tracking ref. Either half
//     may retain while the other proceeds, and a retention always names what blocks it.
// EXIT CODE IS THE MACHINE-READABLE VERDICT: 0 means NOTHING LEGION-OWNED REMAINS LOCALLY
// (removed now, or already gone — the idempotent second run), 1 means something was retained
// and the text says what. A retention is not a crash, but it is not success either: an agent
// that reads only the exit code must never record "cleaned" for a worktree still on disk.
// abandon and close print the clean command as a hint (close from kernel/state.mjs, which
// holds repoRoot+name in the manifest) — abandon only when something actually remains, so the
// hint is never advice to clean what it just removed.
// ADDITIONAL INTAKE REPOSITORIES: `start`
// takes a repeatable `--add-repo <path>`, records the resolved roots as `intakeRepos`, and the
// launch line puts each one in the session's reach with its own `--add-dir`. THIS IS TRANSPORT
// ONLY — one feature is still one repo, one worktree, one pin set, one MR; the attached repos are
// READ by a code-informed intake and nothing else. No initiative id, no sibling link, no contract:
// those layer on top of this mechanism rather than being part of it.
// WHAT IS ATTACHABLE IS THE MAIN WORKTREE ROOT, and nothing else — the same identity a project is
// registered under (resolveProject's docblock). A linked worktree, a subdirectory or a plain
// directory is refused NAMING what it actually is and naming the main root to use instead: attach
// roots, not corners. Two more refusals close the ways an attachment could mean nothing — the
// feature's OWN repository (the session already stands in its worktree) and a duplicate (after
// realpath, so two spellings of one repo cannot both be recorded).
// The list is OPTIONAL AND OMITTED WHEN EMPTY. Every manifest written before this existed has no
// such key, so absence is both the common case and the compatibility story, and no reader may
// treat it as an error. It is validated with the other start refusals, STRICTLY BEFORE the
// manifest is written and the worktree created (a refused start must leave no
// trace), and `--repair` carries it through by spread untouched — repair re-runs bootstrap, it
// never re-derives, which is why combining `--repair` with `--add-repo` REFUSES rather than
// silently ignoring the flag.
// INITIATIVES: `start` takes an optional `--initiative <id>` and the
// manifest gains the optional `initiative` block. Cross-repo lives ENTIRELY ABOVE the kernel — one
// shared intake over N repos producing N ORDINARY single-repo features linked by DATA — so this is
// the whole of the CLI's part in it and nothing here changes what a feature IS.
// THE ROLE IS DERIVED, NEVER SUPPLIED, for the same reason no caller supplies a hash: a
// `--role primary` flag would let a second session declare itself the host of artifacts it does
// not have. The derivation is a SCAN of the registered feature manifests: no feature
// carries the id ⇒ this one is the PRIMARY; exactly one PRIMARY carries it ⇒ this one is a
// SECONDARY of it. Anything else (several primaries, carriers with no primary) is refused naming
// the cause, and so is a manifest the scan cannot read — an unreadable manifest is precisely the
// one that might BE the primary, so "skip it" would decide the role out of ignorance.
// THE SCAN SPANS EVERY REGISTERED PROJECT OF ONE ORG, AND STOPS AT THE ORG — the initiative id is
// an ORG-SCOPED namespace.
// IT MUST CROSS PROJECTS: a legion project is EXACTLY ONE REPOSITORY
// (resolveProject keys the index by main repo root, and re-registering a second root under one
// name RECONCILES the entry onto it rather than adding a repo), so a scan bounded by the project
// could only ever link two features in the SAME repo — which is not the cross-repo case this
// exists for ("projects split into frontend and backend repositories, where one change spans
// both"). Bounded that way, `--initiative x` typed in the FE repo would silently derive a SECOND
// PRIMARY and print success, leaving the secondary role, the references and the whole contract
// cascade unreachable for every real initiative.
// IT MUST NOT CROSS ORGS. The driving case spans projects, never orgs. A machine-wide scan would
// make EVERY past initiative anywhere on the machine a link target for a reused id — and that
// namespace never frees, because abandoned and closed primaries keep their dossiers and their
// index entries forever, so `--initiative api-v2` typed years apart in unrelated tenancies would
// link new work onto a dead primary's artifacts. Org is not a mere registration detail (it
// defaults; `--org` only disambiguates) — it is the tenancy work is registered under, and one id
// namespace per tenancy is the point: a cross-org id reuse must be refused loudly (two primaries),
// never silently found as ONE primary carrier and LINKED to it as a secondary, exit 0 — that would
// be a silent mislink, not the loud refusal the guarantee promises.
// THE RESIDUAL THE ORG BOUNDARY OPENS IS CLOSED LOUDLY, NOT SILENTLY: FE and BE accidentally
// registered under DIFFERENT orgs would otherwise fork into two unlinked primaries, each printing
// success. So a PRIMARY derivation — only a primary derivation, i.e. only when nothing in this org
// carried the id — additionally reads the OTHER orgs for carriers and WARNS, naming the id, this
// org and each foreign carrier (scanOtherOrgCarriers). That read is the machine-wide scan's ONLY
// surviving trace and it feeds the warning ONLY: it never moves the role, never refuses, and never
// contributes to the unreadable-manifest veto. A warning rather than a refusal because reusing one
// id across orgs is legitimate — two tenancies, two unrelated pieces of work.
// THE LOSS IS ACCEPTED, NOT OVERLOOKED: a DELIBERATE cross-org initiative is now UNSTARTABLE — a
// sibling that should join must be registered under the primary's org. It stays unstartable until
// a real one demands it (no speculative machinery), and the honest shape then is an
// explicit opt-in at the call, never a wider default scan.
// THE UNREADABLE-MANIFEST VETO SHRINKS WITH THE BOUNDARY: only a manifest in THIS org can refuse
// this org's `--initiative` start, because only a manifest in this org could have been its primary.
// The block's paths are absolute and machine-global, so nothing else had to change.
// A SECONDARY IS REFUSED UNLESS THE PRIMARY'S OWN INTAKE APPROVAL IS HASH-VALID. The
// by-reference intake clause replaces the SECOND recap conversation, never the FIRST: without this
// refusal a sibling started before the human answered the primary's recap could complete intake
// with no human agreement recorded anywhere, deleting the single gate for the whole
// initiative. Derived at link time exactly like the hashes, stored nowhere.
// THE FEATURE BEING STARTED IS EXCLUDED FROM ITS OWN SCAN: `start` over an ABANDONED name is the
// documented restart path, and a restarted primary that found its own prior manifest would become
// a secondary of itself.
// A SECONDARY'S REFERENCES ARE DERIVED BY READING THE PRIMARY'S FILES AT START TIME — the paths
// come from the primary's tasks.json (its recorded `intent` artifact, which is where intake
// records the recap, and its recorded `contract` artifact), and BOTH HASHES ARE COMPUTED HERE from
// the bytes on disk. Copying the primary's recorded hash would record what the primary once
// believed instead of what is actually there. A primary with no such artifact yet is REFUSED
// naming which one is missing and the op that records it: a secondary referencing artifacts that
// do not exist yet is the stale-reference defect built in at birth.
// NOTHING HERE WRITES ANOTHER FEATURE'S MANIFEST. Sibling enumeration is DERIVED BY SCAN wherever
// it is needed (`status` renders it read-only) and never stored: a `siblings[]` array would be a
// stored conclusion, and maintaining one from a secondary's start would be a cross-manifest
// read-modify-write on a file with no CAS. The block is OPTIONAL — without `--initiative` the
// manifest is byte-identical to what it always was, and `--repair` (which re-derives NOTHING)
// refuses the flag rather than silently ignoring it, exactly as it does for `--add-repo`.
// TICKETS: `start` takes an optional `--ticket <ref>`
// and the manifest gains the optional `ticket` field. IT IS THE ONE PIECE OF OPERATOR-SUPPLIED
// DATA THIS COMMAND RECORDS, and that is deliberate rather than an exception being smuggled in:
// every other field here is DERIVED (baseSha, the policy pin, the initiative role and its hashes)
// because every other field is EVIDENCE, and a ticket reference is not — no approval binds it, no
// hash pins it, no gate reads it (kernel/ticket.mjs header). So the kernel's only judgment is
// refusing garbage, through the SHARED validator that `legion state ticket-record` also uses, and
// it NEVER derives a ref from the branch name or anything else. The field is OPTIONAL and OMITTED
// when absent: a ticket-less feature's manifest, output and downstream behaviour are byte-identical
// to a feature with no ticket recorded at all. `--ticket` with `--repair` REFUSES, exactly as
// `--add-repo`/`--initiative` do — naming `ticket-record`, since unlike those two this one has a
// typed op to land it later.
// NOTHING about tickets reaches a remote from this file: the closing reference and the issue
// comment are `legion finalize`'s, the ONE remote-write path.
// GIT SEAM (kernel/git.mjs header E): every READ here — project resolution, baseSha, the
// leftover-branch guard, the intake-repo root checks, the abandon clean/unpushed probes — goes
// through the hardened git()/gitTry() and therefore ignores the operator's config and GIT_*
// environment. The abandon guard's clean/dirty verdict is DERIVED (worktreeDirt, kernel/git.mjs
// header F): the worktree is written into a temp index and its tree compared to HEAD's, so no config
// that silences `git status` can talk this destructive branch into firing. Ignored files
// still do not count as dirt — unchanged, and the same meaning `legion gate` and its
// kernel-side receipt writer carry.
// three MUTATIONS (`worktree add`, `worktree remove`, `branch -D`) are the only calls in
// the whole tree that take the named opt-out gitUserRepo(), each with a reason at the call
// site; test/kernel/git-seam.audit.test.mjs allowlists exactly those three.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, requireFlags } from '../kernel/args.mjs';
import { git, gitTry, gitUserRepo, mainWorktreeRoot, worktreeDirt } from '../kernel/git.mjs';
import { removePrePushStub, removalReportLine } from '../kernel/githooks.mjs';
import { updateJsonCas } from '../kernel/casfile.mjs';
import { readJson, writeJson } from '../kernel/fsatomic.mjs';
import { ensureDir, featureDir, featuresDir, projectsIndexPath, safeSegment } from '../kernel/paths.mjs';
// cleanHint is the KERNEL's (kernel/state.mjs, beside `close`, which prints the same hint): one
// definition, so `close` and `abandon` can never advertise two different cleanups.
// approvalValid is the KERNEL's too, and imported rather than re-derived for the reason its own
// docblock gives: the recorder and every verifier must recompute the subject byte-identically.
// `feature start` is a verifier here — it asks whether the PRIMARY's intake approval still holds
// before it will link a secondary that would complete intake by reference to it.
import { UNCLASSIFIED_PROFILE, approvalValid, cleanHint, commandPolicyPin, sha256 } from '../kernel/state.mjs';
// THE shared ticket-ref validator — the same one `legion state ticket-record` uses (kernel/
// ticket.mjs). Two copies would drift, and the drift would be a flag accepting what the op
// refuses (or the reverse) on ONE manifest field.
import { validateTicketRef } from '../kernel/ticket.mjs';
import { validateGatesConfig } from './gate.mjs';
import { validateBootstrap } from './project.mjs';

const USAGE =
  'legion feature start <name> --base <branch> [--add-repo <path>]... [--initiative <id>] [--ticket <ref>] [--launch=interactive|background|remote] [--repair] [--now <iso>] [--org <org>]\n' +
  '       legion feature status [<name>] [--org <org>]\n' +
  '       legion feature abandon <name> [--org <org>]\n' +
  '       legion feature clean <name> [--org <org>]   (closed features only; local only)';

const LAUNCH_MODES = ['interactive', 'background', 'remote'];

/** Resolve the registered project for cwd's repo. Refuses without `legion project init`.
 * EXPORTED for `legion doctor`, which needs project.json's protectedBranches + remoteUrl to
 * verify server-side protection — reused rather than copied so there is ONE definition of
 * "which project is this cwd", and one place where the hardened `git()` read of the repo root
 * lives (an ambient GIT_DIR resolving doctor to another repo would make it audit the wrong
 * remote and report a false pass).
 * PROJECTS ARE REGISTERED BY MAIN REPO ROOT, and `rev-parse --show-toplevel` inside a linked
 * feature worktree returns THE WORKTREE, which matches no entry. Two behaviours, both
 * deliberate:
 *   default — resolve by the CHECKOUT the caller stands in, so the feature commands keep
 *     refusing from inside a worktree (`feature abandon f1` run in f1's own checkout must not
 *     destroy the ground under it, and `feature start` must create worktrees off the main
 *     repo, never off another feature's checkout);
 *   {fromAnyWorktree:true} — resolve by the REPOSITORY, via mainWorktreeRoot(), for READ-ONLY
 *     callers that must work in the cwd sessions actually run in. TWO callers, both meeting that
 *     exact criterion — read-only AND run from the session's cwd, never merely convenient:
 *       `legion doctor` — every session launches inside a worktree, and a
 *         branch-protection check that answers "unverified" exactly there verifies nothing in
 *         production;
 *       `legion feature status` — read-only, and the first command a resumed session runs;
 *         under the default mode it answered "is not a registered project" from the worktree,
 *         exactly where it is most needed (test/acceptance/M0-FIXTURE-LEDGER.md row 5).
 *     Adding a WRITE path to this list would delete the guard the default mode exists to be.
 * Either way the root is DERIVED here through the hardened seam — no caller supplies it. */
export function resolveProject(flags, { fromAnyWorktree = false } = {}) {
  const idxPath = projectsIndexPath();
  if (!existsSync(idxPath)) {
    throw new Error(`no project index at ${idxPath} — run \`legion project init\` in the target repo first`);
  }
  const idx = readJson(idxPath); // corrupt index dies loudly
  // git() is HARDENED (kernel/git.mjs header E). Unpinned, this read was the top of the
  // reproduced cross-repo bug: with GIT_DIR/GIT_WORK_TREE exported, `feature abandon f1`
  // run in repo A resolved repo B's project and DESTROYED B's worktree and branch while A
  // was untouched and still reported active. Resolution is evidence — cwd decides, not env.
  const cwd = process.cwd();
  const repoRoot = realpathSync(fromAnyWorktree ? mainWorktreeRoot(cwd) : git(['rev-parse', '--show-toplevel'], cwd));
  // Entries store realpath'd roots, but realpath both sides anyway (macOS /tmp symlinks).
  let matches = (idx.projects ?? []).filter((p) => {
    try { return realpathSync(p.repoRoot) === repoRoot; } catch { return false; }
  });
  if (flags.org != null) matches = matches.filter((p) => p.org === flags.org);
  if (matches.length === 0) {
    // The remediation names --root EXPLICITLY: `legion project init` defaults to cwd, and cwd
    // is a linked worktree whenever a session runs one of these commands. Registering a
    // worktree path RECONCILES the real entry onto it (repoRoot and defaultBranch rewritten to
    // the feature checkout), so a bare `legion project init` is destructive advice precisely
    // where it would be typed.
    // WHICH ROOT TO NAME IS MODE-DEPENDENT, and getting it wrong inverts the point: repoRoot is
    // the main root ONLY under {fromAnyWorktree}. On the default branch it is the CHECKOUT, so
    // naming it printed verbatim the command that corrupts the registration — worst exactly
    // inside a worktree, where these commands are typed. Derive the main root for the ADVICE in
    // both modes. Advice is not evidence: a main root we cannot derive degrades the message to a
    // bare `legion project init --root <main repo root>` placeholder, never the refusal itself.
    let advise = repoRoot;
    if (!fromAnyWorktree) {
      try { advise = realpathSync(mainWorktreeRoot(cwd)); } catch { advise = null; }
    }
    throw new Error(
      `repo ${repoRoot} is not a registered project — run `
      + `\`legion project init --root ${advise ?? '<main repo root>'}\` first`,
    );
  }
  if (matches.length > 1) {
    const ids = matches.map((p) => `${p.org}/${p.name}`).join(', ');
    throw new Error(`repo ${repoRoot} matches multiple projects (${ids}) — disambiguate with --org`);
  }
  const entry = matches[0];
  return { entry, cfg: readJson(entry.configPath), repoRoot };
}

/** Resolve every `--add-repo <path>` into the absolute realpath'd MAIN WORKTREE ROOT it names, in
 * argv order — or throw, naming what the given path actually is (header: attach roots, not
 * corners). Called from `start` BEFORE the manifest is written and before the worktree exists, so
 * every throw here leaves no trace.
 * WHY THE MAIN ROOT AND NOTHING ELSE: it is the identity a repository has in this tree (projects
 * are registered under it — resolveProject's docblock), it is the only path from which the whole
 * repository is readable, and it is stable across the feature's life. The three near-misses are
 * distinguished rather than lumped together, because "attach the root instead" is only actionable
 * if the message says which root: a LINKED WORKTREE (its own toplevel, but not the main one — the
 * likeliest mistake, since sessions run inside one), a SUBDIRECTORY of some checkout, and a
 * directory in no repository at all. A BARE repository is refused too: `git worktree list` names
 * it as its own root, so it would otherwise pass while having no working tree for the session to
 * read — an attachment that means nothing is worse than none, because the launch line still
 * carries it.
 * EVERY GIT READ IS EVIDENCE and goes through the hardened seam: an ambient GIT_DIR that made a
 * plain directory answer as a repository root would record an intake repo that is not the one on
 * disk. gitTry is used for the bare probe alone — an OPTIONAL fact, asked of a path whose
 * repository has already been established by the required read above it. */
function resolveIntakeRepos(values, repoRoot) {
  const attached = [];
  for (const raw of values) {
    const given = resolve(raw); // relative to cwd, like every other path a caller types
    let real;
    try { real = realpathSync(given); }
    catch { throw new Error(`--add-repo ${raw}: ${given} does not exist`); }
    if (!statSync(real).isDirectory()) {
      throw new Error(`--add-repo ${raw}: ${real} is a file, not a directory — attach a repository root`);
    }
    let main;
    try { main = realpathSync(mainWorktreeRoot(real)); }
    catch (err) {
      throw new Error(
        `--add-repo ${raw}: ${real} is not inside a git repository (${err.message}) — ` +
        `--add-repo attaches repositories the intake session reads, not arbitrary directories`,
      );
    }
    if (real !== main) {
      // Which near-miss it is: its own checkout root ⇒ a linked worktree; otherwise a corner of one.
      let top = null;
      try { top = realpathSync(git(['rev-parse', '--show-toplevel'], real)); } catch { /* keep null */ }
      const what = top === real
        ? `is a LINKED WORKTREE of ${main}`
        : `is a subdirectory of ${top ?? main}`;
      throw new Error(`--add-repo ${raw}: ${real} ${what} — attach the main repository root instead: --add-repo ${main}`);
    }
    if (gitTry(['rev-parse', '--is-bare-repository'], real) === 'true') {
      throw new Error(
        `--add-repo ${raw}: ${real} is a BARE repository — it has no working tree for the intake ` +
        `session to read; attach a checkout of it instead`,
      );
    }
    if (real === repoRoot) {
      throw new Error(
        `--add-repo ${raw}: ${real} is this feature's OWN repository — the session already stands ` +
        `in its worktree. --add-repo attaches ADDITIONAL repositories.`,
      );
    }
    if (attached.includes(real)) {
      throw new Error(`--add-repo ${raw}: ${real} is already attached — each repository may be attached once`);
    }
    attached.push(real);
  }
  return attached;
}

// --- initiatives: the block is DERIVED here, from the project's own manifests (header) ---------

/** Read every REGISTERED feature manifest of every registered project IN ONE ORG, minus `exclude`
 * (a `{org, project, name}` triple — a bare name is not an identity once the scan spans
 * projects). Returns `{rows:[{org, project, name, label, f}], unreadable:[{label, path, why}]}`,
 * where `label` is the org/project/name a feature is known by everywhere else (its featureId
 * shape) — a bare `f2` in a refusal would name any number of features once repositories are in
 * play.
 * THE SCAN CROSSES PROJECTS BECAUSE ONE PROJECT IS ONE REPOSITORY, AND STOPS AT `org` BECAUSE THE
 * INITIATIVE ID NAMESPACE IS ORG-SCOPED (header). `org`
 * is REQUIRED and unfiltered scanning is not reachable through this door: an omitted option that
 * quietly meant "the whole machine" would let the wider, rejected boundary back in by default. Both callers pass
 * the org of the feature they are deciding or rendering for.
 * The unreadable ones are HANDED BACK rather than skipped or thrown on, because the two callers
 * need opposite things from them: `start` REFUSES (it is about to decide a role, and the manifest
 * it could not read is exactly the one that might carry the initiative), while `status` is
 * read-only and NAMES them instead of dying, so a corrupt dossier somewhere cannot make the one
 * command a resumed session reaches for unusable. Both of those shrink with the boundary: a corrupt
 * dossier in ANOTHER org is neither a candidate primary nor a sibling, so it is not this org's
 * problem to refuse or to report.
 * THE DOSSIER PATH IS COMPOSED, NOT TRUSTED: featureDir() re-derives it from org/project/name
 * (each safeSegment-guarded) rather than reading the `dossier` field the index happens to store,
 * so a hand-edited index cannot point this scan at a path of its choosing — and an index entry
 * whose identity segments do not compose is UNREADABLE, not skipped, for the same fail-closed
 * reason an unparseable manifest is. THE ORG FILTER RUNS AFTER THAT RULE, NEVER AHEAD OF IT (loop
 * comment): an entry with no usable `org` matches no org at all, so filtering first would turn the
 * one fail-closed case into a silent skip. */
export function scanRegisteredFeatures({ org, exclude = null }) {
  if (typeof org !== 'string' || org.length === 0) {
    throw new Error('scanRegisteredFeatures: an org is required — the initiative id namespace is org-scoped');
  }
  const rows = [];
  const unreadable = [];
  const idx = readJson(projectsIndexPath()); // corrupt index dies loudly, as in resolveProject
  for (const p of idx.projects ?? []) {
    // THE BOUNDARY (header): another org's features are not candidates. IT IS APPLIED ONLY TO AN
    // ENTRY THAT HAS AN ORG. An absent/non-string `org` compares unequal to EVERY real org, so
    // filtering first would drop that entry from rows AND unreadable — silently, and the entry
    // that cannot be placed in an org is exactly the one that might be THIS org's primary. It
    // falls through to featureDir() below, which refuses to compose it, i.e. UNREADABLE, per the
    // docblock's fail-closed rule. A weird but non-empty org STRING is a different matter: it is
    // definitively some other org's name, so equality decides it and the filter is correct.
    const placeable = typeof p?.org === 'string' && p.org.length > 0;
    if (placeable && p.org !== org) continue;
    for (const fe of p?.features ?? []) {
      const name = fe?.name;
      const label = `${p?.org}/${p?.name}/${name}`;
      if (exclude !== null && p?.org === exclude.org && p?.name === exclude.project && name === exclude.name) {
        continue;
      }
      let path;
      try { path = join(featureDir(p?.org, p?.name, name), 'feature.json'); }
      catch (err) { unreadable.push({ label, path: '(no dossier path)', why: err.message }); continue; }
      try { rows.push({ org: p.org, project: p.name, name, label, f: readJson(path) }); }
      catch (err) { unreadable.push({ label, path, why: err.message }); }
    }
  }
  return { rows, unreadable };
}

/** Every registered feature OUTSIDE `org` that carries initiative `id`, as a list of featureId
 * labels. THE ONLY MACHINE-WIDE READ LEFT IN THIS FILE, and it exists to close ONE residual: the
 * org boundary would otherwise let FE and BE accidentally registered under different orgs fork
 * into two unlinked primaries, each printing success (header).
 * ITS OUTPUT IS A WARNING'S INPUT AND NOTHING ELSE. It is called only on a PRIMARY derivation,
 * after the org-scoped scan has already decided the role, and the caller may not branch on it: the
 * decision path is org-scoped by construction, and a "just this once" read of another org's state
 * is how the rejected boundary would grow back.
 * SO IT SKIPS WHAT IT CANNOT READ, deliberately inverting the fail-closed rule the decision scan
 * obeys. An unreadable manifest in another org cannot change a role here, so refusing on it would
 * hand a corrupt dossier in an unrelated tenancy a veto over this org's starts — the exact
 * over-reach this boundary was drawn to remove. Missing a line of advisory text is the correct
 * cost. Nothing else in this file may adopt this rule. */
function scanOtherOrgCarriers(org, id) {
  const found = [];
  const idx = readJson(projectsIndexPath()); // corrupt index dies loudly, as everywhere else
  for (const p of idx.projects ?? []) {
    if (p?.org === org) continue;
    for (const fe of p?.features ?? []) {
      const label = `${p?.org}/${p?.name}/${fe?.name}`;
      let f;
      try { f = readJson(join(featureDir(p?.org, p?.name, fe?.name), 'feature.json')); }
      catch { continue; } // advisory only (docblock): unreadable elsewhere is not this org's veto
      if (f?.initiative?.id !== id) continue;
      // The manifest's OWN featureId when it has one, so the warning names the feature the way
      // every other surface names it; the composed label otherwise, since a hand-edited manifest
      // missing the field must still be nameable in the text that exists to point at it.
      found.push(typeof f.featureId === 'string' && f.featureId.length > 0 ? f.featureId : label);
    }
  }
  return found;
}

/** One `{path, hash}` reference to a shared artifact of the primary, DERIVED by reading the file
 * (header). `kind` is the ARTIFACT kind as the kernel records it; `what` is what §Initiatives
 * calls it, which is not always the same word — the shared RECAP is recorded as the `intent`
 * artifact (skills/feature/SKILL.md intake step 8), and a refusal that named only `intent` would
 * send the operator looking for a file the plan calls something else.
 * Returns `{ref, drifted}` where `drifted` is the primary's RECORDED hash when it differs from the
 * live bytes — not an error (the live bytes are what this reference must bind to; recording the
 * primary's stale belief instead would be the caller-supplied hash rule broken from the inside),
 * but the operator is told, because "the primary's own approval no longer covers this file" is the
 * first thing they would want to know before building a sibling against it. */
function deriveInitiativeRef(tasks, kind, what, { id, primaryLabel }) {
  const a = tasks.artifacts?.[kind];
  if (a == null || typeof a.path !== 'string' || a.path.length === 0) {
    throw new Error(
      `--initiative ${id}: the primary '${primaryLabel}' has recorded no ${what} (${kind} artifact) — ` +
      `a secondary that references an artifact which does not exist yet is a stale reference built in at birth. ` +
      `In the primary's session: \`legion state artifact-record ${kind} <path>\`, then start this feature again.`,
    );
  }
  let bytes;
  try { bytes = readFileSync(a.path); }
  catch (err) {
    throw new Error(
      `--initiative ${id}: the primary '${primaryLabel}' records its ${what} (${kind} artifact) at ${a.path}, ` +
      `which cannot be read (${err.message}) — restore it, or re-record it in the primary's session, then start this feature again.`,
    );
  }
  const hash = sha256(bytes);
  return { ref: { path: a.path, hash }, drifted: a.hash !== hash ? a.hash : null };
}

/** Derive the `initiative` block for a feature about to be started (header). Returns
 * `{block, warnings}`; `warnings` are operator-facing lines, never a refusal — the cross-org fork
 * warning on a primary, artifact drift on a secondary. Every failure throws BEFORE the manifest is
 * written and before the worktree exists (a refused start must leave no trace).
 * THE ORG IS THE SCAN BOUNDARY (header): the org passed here is the org of the project being
 * started, and it is the whole of what the derivation may see. */
function resolveInitiative(id, { org, project, name }) {
  safeSegment(id, 'initiative id'); // it becomes data in manifests and in refusal text
  const { rows, unreadable } = scanRegisteredFeatures({ org, exclude: { org, project, name } });
  if (unreadable.length > 0) {
    const list = unreadable.map((u) => `${u.label} (${u.path}: ${u.why})`).join('; ');
    throw new Error(
      `--initiative ${id}: cannot read the manifest of ${unreadable.length} registered feature(s) in org ${org} — ${list}. ` +
      `The role is DERIVED by scanning org ${org}'s registered features for the initiative id, and a manifest that ` +
      `cannot be read is exactly the one that might carry it; repair or remove those dossiers first.`,
    );
  }
  const carriers = rows.filter((r) => r.f.initiative?.id === id);
  if (carriers.length === 0) {
    // Nobody in this org carries the id: this feature is where the shared intake ran. The primary
    // holds the FILES, so its block carries no references — there is nothing to reference yet.
    // THE FORK WARNING, and the one place another org is read at all (header): the role above is
    // already decided and this cannot change it. Carriers elsewhere mean either a deliberate reuse
    // of the id in another tenancy (fine) or the accident the org boundary would otherwise hide —
    // FE and BE registered under different orgs, forking into two silent primaries.
    const foreign = scanOtherOrgCarriers(org, id);
    const warnings = foreign.length === 0 ? [] : [
      `warning: initiative ${id} is ALSO carried outside org ${org}, by ${foreign.join(', ')} — ` +
      `this feature is a fresh PRIMARY in org ${org} and is NOT linked to them. The initiative id ` +
      `namespace is scoped to the org: ORGS DO NOT LINK. If that is a sibling which should join ` +
      `this initiative, it must be registered under the same org (${org}); if the ids merely ` +
      `collide across unrelated work, nothing is wrong and this line is the whole of it.`,
    ];
    return { block: { id, role: 'primary' }, warnings };
  }
  const primaries = carriers.filter((r) => r.f.initiative.role === 'primary');
  if (primaries.length === 0) {
    throw new Error(
      `--initiative ${id}: ${carriers.length} feature(s) carry this initiative (${carriers.map((c) => c.label).join(', ')}) ` +
      `but NONE of them is the primary — the primary is the feature the shared intake ran under, and it hosts the recap ` +
      `and the contract. The manifests have been hand-edited; repair them before linking another sibling.`,
    );
  }
  if (primaries.length > 1) {
    throw new Error(
      `--initiative ${id}: ${primaries.length} features already claim to be the PRIMARY ` +
      `(${primaries.map((p) => p.label).join(', ')}) — an initiative has exactly one, whose dossier hosts the shared ` +
      `recap and contract. Repair those manifests (or use a different initiative id) before linking another sibling.`,
    );
  }
  const primary = primaries[0];
  // The primary's OWN org/project, never this feature's: the whole point of scanning every project
  // in the org (the scan is ORG-SCOPED, not machine-wide) is that the primary lives in
  // another repository, and composing its dossier from the caller's identity would read a path
  // that does not exist (or, worse, another feature's).
  const tasksPath = join(featureDir(primary.org, primary.project, primary.name), 'tasks.json');
  if (!existsSync(tasksPath)) {
    throw new Error(
      `--initiative ${id}: the primary '${primary.label}' has no tasks.json (${tasksPath}) — it has recorded no ` +
      `artifacts at all, so there is no recap and no contract to reference. In the primary's session: ` +
      `\`legion state init\`, then record the shared artifacts, then start this feature again.`,
    );
  }
  const tasks = readJson(tasksPath); // corrupt manifest dies loudly, as everywhere else
  const ctx = { id, primaryLabel: primary.label };
  const recap = deriveInitiativeRef(tasks, 'intent', 'recap', ctx);
  const contract = deriveInitiativeRef(tasks, 'contract', 'interface contract', ctx);
  // THE AGREEMENT HALF, checked LAST (header): every "the shared file is not there yet"
  // refusal above is about a missing artifact and names the op that records it, so asking about the
  // agreement first would answer "record the recap" with a message about an approval over a file
  // that does not exist. The by-reference intake clause says the recap conversation happened ONCE,
  // with the human, in the primary's session — so a link is only meaningful if that conversation
  // actually concluded. approvalValid is the SAME predicate the stage machine uses (one
  // definition), asked of the PRIMARY's manifests: it covers both "never agreed" and "agreed, then
  // the recap drifted", because a stale approval is exactly a recap nobody has said yes to in its
  // current form. Refused at link time rather than re-asked on every stageSatisfied call — that
  // would couple the kernel's hot path to another feature's tasks.json, and the reachable hole
  // (a sibling started before the human answered) closes here.
  if (!approvalValid('intake', tasks, primary.f)) {
    throw new Error(
      `--initiative ${id}: the primary '${primary.label}' holds no hash-valid intake approval over its recap ` +
      `(${recap.ref.path}) — a secondary completes intake BY REFERENCE to that recap, so linking one now ` +
      `would let this feature pass intake with no human agreement recorded anywhere in the initiative. ` +
      `In the primary's session: \`legion state decision-record intake\` once the human has answered the recap ` +
      `(re-record it if the recap has changed since), then start this feature again.`,
    );
  }
  const warnings = [recap, contract]
    .filter((x) => x.drifted !== null)
    .map((x) => `warning: the primary's ${x.ref.path} has CHANGED since it was recorded there ` +
      `(recorded sha256 ${x.drifted}, live ${x.ref.hash}) — this feature references the LIVE bytes; ` +
      `the primary's own approvals over that artifact no longer validate until it re-records it`);
  // NO fork warning on this branch, deliberately: a carrier in this org was found, so the id is
  // doing its job here, and another org's reuse of the same string is not news about this link.
  return {
    block: {
      id,
      role: 'secondary',
      primary: primary.f.featureId,
      recap: recap.ref,
      contract: contract.ref,
    },
    warnings,
  };
}

/** What `feature start` prints about the block it just derived. A PRIMARY gets one line (it hosts
 * the files; there is nothing to reference), a SECONDARY gets its primary and both references with
 * the hashes THIS command derived. BOTH ROLES PRINT THEIR WARNINGS — the primary's cross-org fork
 * warning is the whole of how that residual is closed, so a `role !== 'secondary'` early return
 * that dropped it would make this layer silent again in exactly the case it was written for.
 * Warnings ride the ordinary start report on stdout, like the weak-gate-tier warning below: they
 * are facts about what was just derived, not refusals. */
function initiativeStartLines({ block, warnings }) {
  const head = `  initiative: ${block.id} (${block.role})\n`;
  const tail = warnings.map((w) => `${w}\n`).join('');
  if (block.role !== 'secondary') return head + tail;
  return head +
    `    primary:  ${block.primary}\n` +
    `    recap:    ${block.recap.path} (sha256 ${block.recap.hash})\n` +
    `    contract: ${block.contract.path} (sha256 ${block.contract.hash})\n` +
    tail;
}

/** POSIX single-quote shell escaping — THE escaping helper for the launch line, used by every
 * launch mode. The `'\''` idiom: close the quote, emit a literal
 * apostrophe, reopen. Everything else (spaces, semicolons, newlines, globs, $) is inert inside
 * single quotes. EXPORTED for the escaping table test. */
export const shellQuote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/** src/cli/feature.mjs → the plugin root that CONTAINS this CLI. Derived from THIS file's
 * location (the doctor.mjs DEFAULT_PLUGIN_ROOT pattern), never from cwd: the launch command is
 * printed for a session that will `cd` into a worktree, so cwd describes the target repo, never
 * legion's own installation. Node resolves symlinks when loading modules, so an `npm link`ed
 * install reports the real checkout — which is exactly the dev root a launch must carry. */
const DEFAULT_PLUGIN_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Where Claude Code keeps MARKETPLACE-installed plugins: `<config dir>/plugins`, the config dir
 * being `~/.claude` unless CLAUDE_CONFIG_DIR relocates it. Read at CALL time, never frozen at
 * import, so a relocated config dir is honoured (and so tests can exercise both layouts).
 * Validated against Claude Code 2.1.219/2.1.220 (the versions doctor pins). */
export const marketplacePluginsRoot = () =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins');

/** Best-effort realpath: the simulated/relocated roots compared below need not exist, and a
 * non-existent path is compared verbatim rather than treated as an error. */
const realish = (p) => { try { return realpathSync(p); } catch { return p; } };

/** THE RULE ("Development launches additionally carry `--plugin-dir <plugin root>` when the
 * plugin is not installed from the marketplace"): THE CLI'S OWN LOCATION
 * IS THE EVIDENCE OF HOW LEGION IS INSTALLED. A marketplace install lives under Claude Code's
 * `<config dir>/plugins` by its own layout, so a root anywhere else is a development install and
 * its session gets nothing — no skill, no agents, no hooks — unless the launch names the root.
 * Containment is compared on path SEGMENTS (realpath'd where
 * possible), never as a string prefix — `~/.claude/pluginsfoo` is not inside `~/.claude/plugins`.
 * FAILURE DIRECTIONS, deliberately asymmetric: misjudging a dev root as marketplace prints a
 * broken launch (a plugin-less session), while misjudging a marketplace root as dev prints a
 * redundant flag naming the directory the plugin already loads from. EXPORTED for the layout tests. */
export function isMarketplaceInstall(pluginRoot, base = marketplacePluginsRoot()) {
  const root = realish(resolve(pluginRoot));
  const mkt = realish(resolve(base));
  return root === mkt || root.startsWith(mkt + sep);
}

/** The exact launch command for a resumed feature session. EVERY interpolated path and identifier
 * is single-quote-shell-escaped through shellQuote — this string is *printed for a shell*, so a
 * worktree path containing a space merely breaks it, and one containing a semicolon CHANGES WHAT
 * THE OPERATOR RUNS when they paste it. The whole skill argument is one quoted word (the ids
 * inside it are safeSegment-shaped, but quoting the composition is the rule, not a per-byte
 * judgement). The `--plugin-dir` root is interpolated under the SAME rule — a development
 * checkout under `~/My Work/legion3` is an ordinary case, not an exotic one. `pluginRoot` is a
 * parameter purely so the layout tests can drive both installations; production never passes it.
 * EACH RECORDED intakeRepo GETS ITS OWN `--add-dir`, in the manifest's order, after the
 * dossier's: this is the whole point of recording them — a session that cannot reach a repository
 * cannot read it, and the launch line is the only place the reach is granted. They are quoted
 * under the same rule as every other path (an attached checkout with a space in its name is
 * ordinary), and they stay BEFORE the prompt, which must remain the last word on the line.
 * A manifest with no intakeRepos (every single-repo feature) produces exactly the line it always did.
 * EXPORTED for the escaping table test — the emitted line must parse back to exactly the argv the
 * operator meant. */
export function launchCommand(mode, f, pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const dossier = featureDir(f.org, f.project, f.name);
  const modeFlags = {
    interactive: '',
    background: '--bg ',
    remote: `--remote-control --name ${shellQuote(f.name)} `,
  }[mode];
  const pluginFlag = isMarketplaceInstall(pluginRoot)
    ? ''
    : `--plugin-dir ${shellQuote(resolve(pluginRoot))} `;
  const intakeFlags = (f.intakeRepos ?? []).map((r) => `--add-dir ${shellQuote(r)} `).join('');
  return `cd ${shellQuote(f.worktree)} && claude ${modeFlags}${pluginFlag}--add-dir ${shellQuote(dossier)} ${intakeFlags}${shellQuote(`/legion:feature resume ${f.featureId}`)}`;
}

/** Run structured bootstrap entries against the worktree. Shape-checked BEFORE any exec;
 * scripts sha256-verified against the worktree copy BEFORE exec (fail closed). Throws
 * naming the failing entry. No shell anywhere — execFileSync with argv arrays only. */
function runBootstrap(cfg, configPath, worktree) {
  const bootstrap = cfg.bootstrap ?? [];
  validateBootstrap(bootstrap, configPath);
  bootstrap.forEach((e, i) => {
    if (typeof e.script === 'string') {
      const scriptPath = isAbsolute(e.script) ? e.script : join(worktree, e.script);
      let bytes;
      try { bytes = readFileSync(scriptPath); }
      catch (err) { throw new Error(`bootstrap[${i}]: cannot read script ${scriptPath}: ${err.message}`); }
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== e.sha256) {
        throw new Error(
          `bootstrap[${i}]: sha256 mismatch for ${scriptPath} — expected ${e.sha256}, got ${digest}; refusing to execute`,
        );
      }
      exec(i, scriptPath, [], worktree, e.timeoutMs);
    } else {
      exec(i, e.argv[0], e.argv.slice(1), resolve(worktree, e.cwd), e.timeoutMs);
    }
  });
}

function exec(i, file, args, cwd, timeoutMs) {
  try {
    execFileSync(file, args, {
      cwd, timeout: timeoutMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail = [err.signal && `signal ${err.signal}`, err.status != null && `exit ${err.status}`, (err.stderr ?? '').trim()]
      .filter(Boolean).join('; ');
    throw new Error(`bootstrap[${i}] (${[file, ...args].join(' ')}) in ${cwd} failed: ${detail || err.message}`);
  }
}

function readFeature(org, project, name) {
  const path = join(featureDir(org, project, name), 'feature.json');
  if (!existsSync(path)) throw new Error(`feature '${name}' does not exist (no ${path})`);
  return { path, f: readJson(path) };
}

async function start(flags, positional) {
  const name = safeSegment(positional[1], 'feature name');
  requireFlags(flags, ['base'], USAGE);
  const launch = flags.launch ?? 'interactive';
  if (!LAUNCH_MODES.includes(launch)) {
    throw new Error(`invalid --launch '${launch}' — must be one of ${LAUNCH_MODES.join('|')}`);
  }
  const now = flags.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error(`invalid --now '${flags.now}' — must be a parseable timestamp`);

  const { entry, cfg, repoRoot } = resolveProject(flags);
  const { org, name: project } = entry;
  const dossier = featureDir(org, project, name);
  const manifestPath = join(dossier, 'feature.json');

  // --- repair: re-run bootstrap ONLY, on an initialization_failed feature ---
  if (flags.repair) {
    // REFUSED, NEVER IGNORED (header): repair rewrites the manifest by spread and re-derives
    // nothing, so an --add-repo here would be silently dropped — the operator would read a
    // successful repair as having attached a repository that is not in the manifest or the
    // launch line. Changing the attached set means restarting the feature.
    if (flags['add-repo'] !== undefined) {
      throw new Error(
        `--add-repo cannot be combined with --repair — repair re-runs bootstrap only and never ` +
        `re-derives the manifest; the recorded intakeRepos carry through untouched. To change them, ` +
        `\`legion feature abandon ${name}\` and start again.`,
      );
    }
    // SAME RULE, SAME REASON: repair re-derives nothing, and an initiative block is nothing
    // BUT derived evidence — the role from a scan, the recap/contract hashes from the primary's
    // files. Accepting the flag here would let a repair read as "linked" while the manifest says
    // otherwise; the recorded block carries through by spread, untouched.
    if (flags.initiative !== undefined) {
      throw new Error(
        `--initiative cannot be combined with --repair — repair re-runs bootstrap only and never ` +
        `re-derives the manifest; a recorded initiative block carries through untouched. To link or ` +
        `re-link this feature, \`legion feature abandon ${name}\` and start again.`,
      );
    }
    // SAME POSTURE, and here the alternative is BETTER than for the two flags above: repair
    // re-runs bootstrap and rewrites the manifest by SPREAD, so a `--ticket` handed to it would be
    // silently dropped while the command printed success — the operator would read a repaired
    // feature as carrying a ticket that is not in the manifest and will never reach an MR body or
    // an issue. Unlike --add-repo/--initiative, the recovery costs nothing: the ticket is DATA and
    // there is a typed op for exactly this, so the refusal names it rather than telling the
    // operator to abandon and restart.
    if (flags.ticket !== undefined) {
      throw new Error(
        `--ticket cannot be combined with --repair — repair re-runs bootstrap only and never ` +
        `re-writes manifest fields, so the flag would be silently dropped. Repair first, then ` +
        `record it: \`legion state ticket-record <ref>\` from inside the feature worktree.`,
      );
    }
    if (!existsSync(manifestPath)) throw new Error(`nothing to repair — feature '${name}' does not exist`);
    const f = readJson(manifestPath);
    if (f.status !== 'initialization_failed') {
      throw new Error(`--repair requires status 'initialization_failed' (current: '${f.status}')`);
    }
    try {
      runBootstrap(cfg, entry.configPath, f.worktree);
    } catch (err) {
      writeJson(manifestPath, { ...f, initError: err.message, revision: f.revision + 1, updatedAt: new Date().toISOString() });
      process.stderr.write(`bootstrap failed again: ${err.message}\nfix the bootstrap config, then re-run: legion feature start ${name} --base ${f.baseBranch} --repair\n`);
      return 1;
    }
    const { initError: _dropped, ...rest } = f;
    const repaired = { ...rest, status: 'active', revision: f.revision + 1, updatedAt: new Date().toISOString() };
    writeJson(manifestPath, repaired);
    process.stdout.write(`repaired feature ${repaired.featureId} — status active\n\nlaunch (${launch}):\n  ${launchCommand(launch, repaired)}\n`);
    return 0;
  }

  // --- fresh start: refuse over any existing manifest EXCEPT an abandoned one ---
  // abandon is the restart path we point users at, so an abandoned name MUST be
  // startable again (else the hint is circular and the name is dead forever).
  let prior = null; // restored verbatim if worktree creation fails mid-restart
  if (existsSync(manifestPath)) {
    const existing = readJson(manifestPath);
    if (existing.status === 'abandoned') {
      prior = existing;
    } else {
      const hint = existing.status === 'initialization_failed'
        ? `re-run with --repair to retry bootstrap, or \`legion feature abandon ${name}\``
        : `use \`legion feature abandon ${name}\` first if you mean to restart it`;
      throw new Error(`feature '${name}' already exists (status: ${existing.status}) — ${hint}`);
    }
  }

  // Pin the base BEFORE any work — everything downstream binds to this SHA (it is also the
  // endpoint of every tier-0 diff range), so it is derived through the hardened git().
  const baseBranch = flags.base;
  const baseSha = git(['rev-parse', '--verify', `${baseBranch}^{commit}`], repoRoot);

  // Pin the GATE COMMAND POLICY in the same breath, and BEFORE the worktree exists (header).
  // validateGatesConfig throws naming the offending key on a malformed block, which is the
  // deliberate consequence #1: a broken gate config is now a refused `feature start`, not a
  // surprise at the first gate run. commandPolicyPin is the kernel's ONE definition of the pin's
  // shape, and its docblock is the ONE statement of what each half is for — both halves are
  // load-bearing since T12b, and this comment deliberately does not restate which (it did, and the
  // restatement went stale where the definition could not).
  const pin = commandPolicyPin(validateGatesConfig(cfg.gates, entry.configPath));

  const worktree = join(dirname(repoRoot), '.legion-worktrees', project, name, 'checkout');
  const branch = `feat/${name}`;

  // Leftovers (a worktree retained by a prior abandon, a stray feat/<name> branch) would
  // fail `git worktree add` AFTER state is written — detect them upfront, refuse with the
  // exact recovery commands, and write nothing.
  if (existsSync(worktree)) {
    throw new Error(
      `worktree path ${worktree} already exists (retained by a prior abandon?) — ` +
      `inspect it, then remove it (\`git -C ${repoRoot} worktree remove --force ${worktree}\`) and retry`,
    );
  }
  if (gitTry(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repoRoot) !== null) {
    throw new Error(
      `branch ${branch} already exists in ${repoRoot} — ` +
      `inspect it (push anything you want to keep), then delete it (\`git -C ${repoRoot} branch -D ${branch}\`) and retry`,
    );
  }
  // Additional intake repositories are resolved HERE — with the other start refusals, after the
  // leftovers are cleared and still BEFORE the manifest is written and the worktree created
  // (header: a refused start must leave no trace). A bad --add-repo must cost the operator nothing to retry.
  const intakeRepos = resolveIntakeRepos(flags['add-repo'] ?? [], repoRoot);
  // The initiative block is derived HERE for the same reason and under the same rule: every
  // refusal above and below leaves no trace, and this one reads OTHER features' manifests, so it
  // must not be able to half-write this one.
  const initiative = flags.initiative === undefined
    ? null
    : resolveInitiative(flags.initiative, { org, project, name });
  // The ticket is validated HERE, under the same rule, for the same reason: a garbage ref must
  // cost the operator nothing to retry, so it is refused strictly before the manifest exists.
  // NOTHING is derived — the ref is stored exactly as supplied (kernel/ticket.mjs).
  const ticket = flags.ticket === undefined ? null : validateTicketRef(flags.ticket, '--ticket').ref;

  const featureId = `${org}/${project}/${name}`;
  const legionVersion = readJson(fileURLToPath(new URL('../../package.json', import.meta.url))).version;
  const manifest = {
    schemaVersion: 1,
    legionVersion,
    revision: 0,
    org,
    project,
    name,
    featureId,
    repoRoot,
    baseBranch,
    baseSha,
    ...pin, // commandPolicyHash {task, boundary} + commandPolicy {task, boundary} — beside baseSha
    commandPolicyPinnedAt: now,
    worktree,
    branch,
    // OMITTED ENTIRELY when nothing was attached (header): absence is the compatibility story for
    // every manifest written before this key existed, and the honest shape for the single-repo
    // case, which is most of them. An `intakeRepos: []` in every manifest would be noise that
    // readers must then learn to ignore.
    ...(intakeRepos.length > 0 ? { intakeRepos } : {}),
    // OMITTED ENTIRELY without `--initiative` (header, and asserted by the tests): the block is
    // optional, its absence is the ordinary single-repo case, and a manifest written without the
    // flag must be BYTE-IDENTICAL to what this command has always written — the initiatives track
    // is additive and must not be able to destabilize features that don't use it.
    ...(initiative !== null ? { initiative: initiative.block } : {}),
    // OMITTED ENTIRELY without `--ticket`, and for the same red line the block above states: a
    // ticket-less feature's manifest must be BYTE-IDENTICAL to what this command has always
    // written, because the whole tickets track is additive and must not be able to move the
    // behaviour of a feature that has no ticket. Recordable later by `legion state ticket-record`
    // (the field, not the flag, is the interface).
    ...(ticket !== null ? { ticket } : {}),
    // The kernel's own placeholder constant, IMPORTED so the manifest and the enum cannot
    // disagree. Intake-only: stage-complete intake refuses until escalate-profile sets a real member.
    profile: UNCLASSIFIED_PROFILE,
    stage: 'intake',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    sessionHistory: [],
  };
  ensureDir(dossier);
  writeJson(manifestPath, manifest);

  try {
    ensureDir(dirname(worktree));
    // MUTATION (kernel/git.mjs header E): creates a worktree IN THE USER'S REPO, so their
    // config — hooks, worktree settings, identity — must apply. Not an evidence read.
    gitUserRepo(['worktree', 'add', '-b', branch, worktree, baseSha], repoRoot);
  } catch (err) {
    // NEVER leave a manifest claiming 'active' with no worktree:
    // roll the dossier back to its pre-start state, then die loudly. Plain re-start works
    // again once the underlying cause is fixed.
    if (prior !== null) writeJson(manifestPath, prior);
    else rmSync(manifestPath, { force: true });
    throw new Error(
      `worktree creation failed: ${err.message}\n` +
      `no feature state was kept — fix the cause, then re-run \`legion feature start ${name} --base ${baseBranch}\``,
    );
  }

  // Register BEFORE bootstrap so a failed feature stays discoverable in the index.
  await updateJsonCas(projectsIndexPath(), (doc) => {
    if (doc === null) throw new Error(`${projectsIndexPath()} vanished mid-start — re-run \`legion project init\``);
    const projects = [...(doc.projects ?? [])];
    const i = projects.findIndex((p) => p.org === org && p.name === project);
    if (i < 0) throw new Error(`project ${org}/${project} vanished from ${projectsIndexPath()} — re-run \`legion project init\``);
    const fentry = { name, featureId, dossier, worktree, branch };
    const features = [...(projects[i].features ?? [])];
    const j = features.findIndex((x) => x.name === name);
    if (j >= 0 && JSON.stringify(features[j]) === JSON.stringify(fentry)) return null;
    if (j >= 0) features[j] = fentry; else features.push(fentry);
    projects[i] = { ...projects[i], features };
    return { ...doc, projects };
  });

  // REMOVE any leftover pre-push stub (src/kernel/githooks.mjs — the guards were retired
  // 2026-08-07, server-only decision). This is THE upgrade path for a repository registered by
  // an older legion: its installed stub is fail-closed and its guard file no longer ships, so
  // every push there — this feature's finalize included — fails inside it until removed. HERE,
  // after the worktree exists and the feature is registered, for the install-era reason in
  // reverse: every refusal above this point leaves no trace in the operator's repository, and a
  // deleted hook file would be one. It never throws: a repository whose stub cannot be removed
  // still gets its feature.
  const stub = removePrePushStub(repoRoot);

  try {
    runBootstrap(cfg, entry.configPath, worktree);
  } catch (err) {
    writeJson(manifestPath, {
      ...manifest, status: 'initialization_failed', initError: err.message,
      revision: manifest.revision + 1, updatedAt: new Date().toISOString(),
    });
    process.stderr.write(
      `bootstrap failed: ${err.message}\n` +
      `feature '${name}' recorded as initialization_failed — ` +
      `fix the bootstrap config, then: legion feature start ${name} --base ${baseBranch} --repair\n`,
    );
    return 1;
  }

  // The pin is PRINTED, not merely recorded: it is what every later gate run is compared against,
  // and a tier with 0 declared commands is a real but WEAK certificate (tier-0 self-protection
  // only) that must never read as a full one. Loud here, at the one moment
  // the operator is looking at this feature's configuration.
  const weakTiers = ['task', 'boundary'].filter((t) => pin.commandPolicy[t].length === 0);
  process.stdout.write(
    `started feature ${featureId}\n` +
    `  base:     ${baseBranch} @ ${baseSha}\n` +
    `  worktree: ${worktree} (branch ${branch})\n` +
    `  dossier:  ${dossier}\n` +
    // What was DERIVED is what gets printed: --add-repo values are realpath'd and normalised to
    // main roots, so the line the operator typed is not necessarily the line that was recorded.
    (intakeRepos.length > 0 ? `  add-repo: ${intakeRepos.join(', ')}\n` : '') +
    // The DERIVED role and the DERIVED references, printed at the one moment the operator is
    // looking at this feature's identity — a secondary silently linked to the wrong primary, or to
    // artifacts they did not expect, is the initiative layer's version of a wrong pin.
    (initiative !== null ? initiativeStartLines(initiative) : '') +
    // Printed at the one moment the operator is looking at this feature's identity, for the same
    // reason the pin and the initiative refs are: a ticket typed one digit wrong links an MR and
    // comments an issue that belongs to someone else's work, and nothing downstream can catch it —
    // it is DATA, so this line is the only review it will ever get.
    (ticket !== null ? `  ticket:   ${ticket}\n` : '') +
    removalReportLine(stub) +
    `  gate policy pinned: task ${pin.commandPolicyHash.task} (${pin.commandPolicy.task.length} cmd), ` +
    `boundary ${pin.commandPolicyHash.boundary} (${pin.commandPolicy.boundary.length} cmd)\n` +
    (weakTiers.length > 0
      ? `warning: no project-owned ${weakTiers.join('/')} gate commands declared in ${entry.configPath} — ` +
        `TIER-0 ONLY: every ${weakTiers.join('/')} receipt this feature earns certifies "no secrets, no ` +
        `protected-config edit" and nothing more. Declare gates.commands + gates.task/boundary.\n`
      : '') +
    `\nlaunch (${launch}):\n  ${launchCommand(launch, manifest)}\n`,
  );
  return 0;
}

/** The read-only initiative grouping `feature status <name>` renders: id, role, and the siblings
 * FOUND BY SCAN. Empty string for the ordinary feature that carries no block.
 * SIBLINGS ARE NAMED org/project/name, never by bare name: the scan spans every registered project
 * because an initiative spans repositories (scanRegisteredFeatures' docblock), so `f2` alone would
 * not say which repository's f2 — and "which repo is my sibling in" is the one thing this grouping
 * exists to answer.
 * IT SCANS THIS FEATURE'S OWN ORG, THE SAME BOUNDARY `start` DERIVED THE ROLE UNDER (header).
 * The two must agree or the grouping lies: a status that listed another org's carriers would show
 * a sibling that a `feature start` here refuses to link to, which is worse than showing nothing.
 * IT NAMES WHAT IT COULD NOT READ rather than dying (same docblock): this is a read-only
 * projection, and a corrupt dossier elsewhere must not take the one command a resumed session runs
 * first with it — but silence would be the "not a legion feature" mistake, so the unreadable
 * ones are printed. */
function initiativeStatusLines(f, org, project) {
  const init = f.initiative;
  if (init == null) return '';
  const { rows, unreadable } = scanRegisteredFeatures({ org, exclude: { org, project, name: f.name } });
  const siblings = rows
    .filter((r) => r.f.initiative?.id === init.id)
    .map((r) => `${r.label} (${r.f.initiative.role})`);
  const role = init.role === 'secondary' && init.primary ? `secondary of ${init.primary}` : init.role;
  return `  initiative: ${init.id} (${role})\n` +
    `  siblings: ${siblings.length > 0 ? siblings.join(', ') : '(none found)'}\n` +
    (unreadable.length > 0
      ? `  siblings UNREADABLE: ${unreadable.map((u) => `${u.label} (${u.why})`).join('; ')}\n`
      : '');
}

function status(flags, positional) {
  // READ-ONLY, so it resolves by REPOSITORY and not by checkout (header; resolveProject's mode
  // docblock): a resumed session stands in the feature worktree, and asking "what stage am I in"
  // must not be the one question that cannot be asked from there. Nothing below writes.
  const { entry } = resolveProject(flags, { fromAnyWorktree: true });
  const { org, name: project } = entry;
  if (positional[1] != null) {
    const name = safeSegment(positional[1], 'feature name');
    const { f } = readFeature(org, project, name);
    process.stdout.write(
      `feature ${f.featureId}\n` +
      `  status:   ${f.status}\n` +
      `  stage:    ${f.stage}\n` +
      `  profile:  ${f.profile}\n` +
      `  branch:   ${f.branch}\n` +
      `  base:     ${f.baseBranch} @ ${f.baseSha}\n` +
      `  worktree: ${f.worktree}\n` +
      `  dossier:  ${featureDir(org, project, name)}\n` +
      // Present ONLY when the feature has them: a manifest without the key is the ordinary
      // single-repo feature, and an `add-repo: (none)` line on every one of them teaches the reader
      // to skip the field exactly when it does appear.
      ((f.intakeRepos ?? []).length > 0 ? `  add-repo: ${f.intakeRepos.join(', ')}\n` : '') +
      // The initiative GROUPING, read-only and DERIVED: siblings are found by scanning the
      // registered manifests for the same id — every project OF THIS ORG, because siblings live in
      // other repositories but never in another org — and never read out of a stored list;
      // there is no stored list, by design (header). Present only when this feature carries a block.
      initiativeStatusLines(f, org, project) +
      `  created:  ${f.createdAt}\n` +
      `  sessions: ${(f.sessionHistory ?? []).length}\n` +
      (f.closedAt ? `  closed:   ${f.closedAt}\n` : '') +
      (f.initError ? `  error:    ${f.initError}\n` : ''),
    );
    return 0;
  }
  const dir = featuresDir(org, project);
  const names = existsSync(dir)
    ? readdirSync(dir).filter((n) => existsSync(join(dir, n, 'feature.json'))).sort()
    : [];
  if (names.length === 0) {
    process.stdout.write(`no features for ${org}/${project}\n`);
    return 0;
  }
  for (const n of names) {
    const f = readJson(join(dir, n, 'feature.json'));
    process.stdout.write(`${n}  ${f.status}  ${f.stage}  ${f.branch}\n`);
  }
  return 0;
}

// --- the guarded local removal, defined ONCE and shared by `abandon` and `clean` -------------
// Two commands destroy local git state and they must agree, byte for byte, about when that is
// safe: a second copy of "is it clean / is it pushed" is a second place for the answer to drift
// (and the drift is only ever discovered by destroying someone's work). So the verdicts live
// here, the two mutations live in one function each, and the commands only COMPOSE them.

/** Commits on feat/<name> reachable from NEITHER the pinned base NOR any remote-tracking ref —
 * i.e. work that exists nowhere but this machine. THE containment formula, used by both guards.
 * `--not --remotes` is what makes a DELIVERED feature cleanable at all: `legion finalize` pushed
 * the branch, so refs/remotes/<remote>/feat/<name> contains every commit and the count is 0. It
 * reads only local refs — no fetch, no network (see the remote-write invariant in the header),
 * which also means a remote branch deleted by the merge UI and then PRUNED locally reads as
 * unpushed and RETAINS. That is the correct direction to be wrong in.
 * NaN (a git that answered something unexpected) is returned as-is: callers treat it as UNKNOWN
 * and retain. `Number('') === 0` is exactly the fail-OPEN this guards against. */
function unpushedCount(f, cwd) {
  return Number(git(['rev-list', '--count', `${f.baseSha}..${f.branch}`, '--not', '--remotes'], cwd));
}

/** Why the worktree must be RETAINED, or null when removing it destroys nothing.
 * Retain on ANY doubt: dirty tree, commits unreachable from baseSha/remotes, or an unreadable
 * worktree all mean possible work — never destroy it.
 * BOTH probes go through the hardened git(): this is the sole EVIDENCE a DESTRUCTIVE branch is
 * gated on, so it must not be read under the operator's config — git's own `worktree remove`
 * clean check shells out to an equally steerable status and does not save us. This goes further:
 * the verdict no longer READS status at all. worktreeDirt() writes the worktree into a temp index
 * and compares the resulting TREE to HEAD's (kernel/git.mjs header F), so the whole class of
 * output-silencing knobs — status.showUntrackedFiles, core.excludesFile, submodule.<name>.ignore,
 * diff.ignoreSubmodules — cannot talk this branch into firing. `paths` is a best-effort report and
 * may be EMPTY on a dirty tree, which is why `clean` is the verdict.
 * IGNORED FILES STILL DO NOT COUNT AS DIRT (`add -A` honours .gitignore exactly as `--ignored=no`
 * did) — unchanged, and the same meaning `legion gate` and its kernel-side receipt writer carry. */
function worktreeBlocker(f) {
  try {
    const d = worktreeDirt(f.worktree);
    if (!d.clean) {
      return `uncommitted changes (${d.paths.slice(0, 5).join(', ') || 'derived tree differs from HEAD'})`;
    }
    const unpushed = unpushedCount(f, f.worktree);
    if (!Number.isInteger(unpushed)) return 'cannot count unpushed commits (git answered no number)';
    if (unpushed > 0) return `${unpushed} unpushed commit(s)`;
    return null;
  } catch (err) {
    return `cannot verify worktree state (${err.message})`;
  }
}

/** Does feat/<name> still exist as a local branch? An OPTIONAL fact (gitTry), read from the main
 * repo because `clean` asks it after the worktree is gone. */
const branchPresent = (f, cwd) =>
  gitTry(['show-ref', '--verify', '--quiet', `refs/heads/${f.branch}`], cwd) !== null;

/** Why feat/<name> must be RETAINED, or null when deleting it loses nothing. Same containment
 * formula as the worktree guard, asked from the main repo (the worktree it used to live in is
 * gone by the time this is called). The caller must have established the worktree is gone: git
 * refuses to delete a checked-out branch, and asking this question of a live checkout would be
 * answering the wrong one. */
function branchBlocker(f, cwd) {
  try {
    const unpushed = unpushedCount(f, cwd);
    if (!Number.isInteger(unpushed)) return 'cannot count unpushed commits (git answered no number)';
    if (unpushed > 0) return `${unpushed} commit(s) reachable from neither ${f.baseBranch}@${f.baseSha.slice(0, 12)} nor any remote-tracking ref`;
    return null;
  } catch (err) {
    return `cannot verify branch containment (${err.message})`;
  }
}

/** MUTATION (kernel/git.mjs header E): removes a worktree FROM THE USER'S REPO — their hooks and
 * worktree settings must apply. THE only such call in the tree; both commands route through it. */
const removeWorktree = (f) => gitUserRepo(['worktree', 'remove', f.worktree], f.repoRoot);

/** MUTATION (kernel/git.mjs header E): deletes feat/<name> IN THE USER'S REPO. Callers delete only
 * a branch a blocker has cleared — fully contained in the pinned base or a remote — so nothing is
 * lost, and leaving it would block every future `feature start <name>` at `worktree add -b`
 * (leaked-branch dead-end). THE only such call in the tree. Throws on git's refusal; `clean`
 * catches and reports it, `abandon` lets it die loudly, exactly as before. */
const deleteBranch = (f) => gitUserRepo(['branch', '-D', f.branch], f.repoRoot);

function abandon(flags, positional) {
  const name = safeSegment(positional[1], 'feature name');
  const { entry } = resolveProject(flags);
  const { org, name: project } = entry;
  const { path: manifestPath, f } = readFeature(org, project, name);
  if (f.status === 'abandoned') {
    process.stdout.write(`feature ${f.featureId} is already abandoned (closed ${f.closedAt})\n`);
    return 0;
  }

  if (existsSync(f.worktree)) {
    const retain = worktreeBlocker(f);
    if (retain !== null) {
      process.stdout.write(`worktree RETAINED (${retain}): ${f.worktree}\n  inspect or push, then remove it manually\n`);
    } else {
      removeWorktree(f);
      deleteBranch(f); // cleared by the same checks that cleared the worktree
      process.stdout.write(`worktree removed: ${f.worktree} (branch ${f.branch} deleted)\n`);
    }
  }

  const now = new Date().toISOString();
  writeJson(manifestPath, { ...f, status: 'abandoned', closedAt: now, revision: f.revision + 1, updatedAt: now });
  process.stdout.write(`feature ${f.featureId} abandoned\n`);
  // Only when something actually survives: after a clean abandon there is nothing left to clean,
  // and a hint pointing at an already-empty command is noise that teaches the operator to ignore
  // hints. Both facts are re-derived here rather than tracked through the branch above.
  if (existsSync(f.worktree) || branchPresent(f, f.repoRoot)) {
    process.stdout.write(cleanHint(f));
  }
  return 0;
}

/** `legion feature clean <name>` — guarded local cleanup of a CLOSED feature; the
 * header states the four invariants (closed-only, never remote, never the dossier/manifest,
 * ordered guards) and the exit-code contract. */
function clean(flags, positional) {
  const name = safeSegment(positional[1], 'feature name');
  const { entry } = resolveProject(flags);
  const { org, name: project } = entry;
  const { f } = readFeature(org, project, name); // READ only — clean writes no manifest
  const CLOSED = ['delivered', 'abandoned'];
  if (!CLOSED.includes(f.status)) {
    // Name the CURRENT status: "not closed" alone leaves the operator guessing which of the six
    // lifecycle states they are in and what closes it.
    throw new Error(
      `feature '${name}' is not closed (status: '${f.status}') — clean removes the worktree and ` +
      `branch of a ${CLOSED.join('/')} feature only. Close it first: \`legion state close delivered\` ` +
      `from inside the worktree (after \`legion finalize\`), or \`legion feature abandon ${name}\` here.`,
    );
  }

  const dossier = featureDir(org, project, name);
  let worktreeGone = !existsSync(f.worktree);
  let retained = false;
  const out = [];

  if (!worktreeGone) {
    const blocker = worktreeBlocker(f);
    if (blocker !== null) {
      out.push(`worktree RETAINED (${blocker}): ${f.worktree}`, '  inspect, commit and push (or discard), then re-run clean');
      retained = true;
    } else {
      try {
        removeWorktree(f);
        worktreeGone = true;
        out.push(`worktree removed: ${f.worktree}`);
      } catch (err) {
        // git refused (an unregistered path, a locked worktree). Nothing was destroyed; report and
        // retain rather than dying, so the branch half still gets its honest verdict.
        out.push(`worktree RETAINED (git refused to remove it: ${err.message}): ${f.worktree}`);
        retained = true;
      }
    }
  } else {
    out.push(`worktree already gone: ${f.worktree}`);
  }

  let branchGone = !branchPresent(f, f.repoRoot);
  if (branchGone) {
    out.push(`branch ${f.branch} already gone`);
  } else if (!worktreeGone) {
    // Ordering, not a second opinion: git itself refuses to delete a checked-out branch.
    out.push(`branch ${f.branch} RETAINED: its worktree is still present`);
    retained = true;
  } else {
    const blocker = branchBlocker(f, f.repoRoot);
    if (blocker !== null) {
      out.push(
        `branch ${f.branch} RETAINED (${blocker})`,
        `  push it, or delete it yourself: git -C ${f.repoRoot} branch -D ${f.branch}`,
      );
      retained = true;
    } else {
      try {
        deleteBranch(f);
        branchGone = true;
        out.push(`branch ${f.branch} deleted`);
      } catch (err) {
        // The realistic cause is a stale worktree admin record (the directory was removed by hand
        // rather than by git), which makes git call the branch checked out. Name the fix.
        out.push(
          `branch ${f.branch} RETAINED (git refused to delete it: ${err.message})`,
          `  if its worktree was removed by hand: git -C ${f.repoRoot} worktree prune, then re-run clean`,
        );
        retained = true;
      }
    }
  }

  if (worktreeGone && branchGone && !retained) {
    // Idempotent by DERIVATION, not by a flag: a second clean re-asks the filesystem and git.
    const already = out.every((l) => l.includes('already gone'));
    process.stdout.write(
      (already
        ? `feature ${f.featureId} is already clean\n`
        : `feature ${f.featureId} cleaned\n`) +
      `${out.map((l) => `  ${l}`).join('\n')}\n` +
      `  dossier RETAINED (the audit trail, always): ${dossier}\n` +
      `  the remote branch, if any, is yours to delete — legion never writes to the remote outside \`legion finalize\`\n`,
    );
    return 0;
  }
  process.stdout.write(
    `feature ${f.featureId} NOT fully cleaned\n` +
    `${out.map((l) => `  ${l}`).join('\n')}\n` +
    `  dossier RETAINED (the audit trail, always): ${dossier}\n`,
  );
  return 1;
}

export async function run(argv) {
  // NO PRE-SPLIT: callers must not flatten `--flag=value` tokens into two. parseArgs binds
  // the inline form itself, FIRST, and its docblock states that callers must not pre-split (a split
  // value beginning with `--` then trips the missing-value refusal, and an inline value on a bool
  // reaches the dispatch table as a stray positional instead of the parser's own `takes no value`).
  // `--add-repo` is declared `multi` here and nowhere else — the ONE flag on this command whose
  // repetition is meaningful; every other flag keeps last-wins.
  const { flags, positional } = parseArgs(argv, { bools: ['repair'], multi: ['add-repo'] });
  const sub = positional[0];
  if (sub === 'start' && positional.length === 2) return start(flags, positional);
  if (sub === 'status' && positional.length <= 2) return status(flags, positional);
  if (sub === 'abandon' && positional.length === 2) return abandon(flags, positional);
  if (sub === 'clean' && positional.length === 2) return clean(flags, positional);
  throw new Error(`unknown or malformed subcommand '${positional.join(' ')}'. usage:\n${USAGE}`);
}
