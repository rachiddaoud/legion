// git.mjs — the kernel's only door to git. The kernel DERIVES evidence itself (repo
// root, remote URL, branches, hashes) — callers never supply authoritative identifiers
// (a model handed an identifier could bless anything).
// SURFACE: git() — HARDENED spawnSync, throws loudly on non-zero/spawn failure with the
// full command, cwd and stderr in the message (fail closed, die loudly). gitTry() — the
// same, null on ANY failure, for optional facts only (a repo with no remote), never for
// required evidence. gitUserRepo() — the NAMED OPT-OUT (header E), for the three calls
// that MUTATE the user's repository. The raw spawn primitive (spawnGit) is module-private
// on purpose: an unhardened helper that ordinary code can import is the bug, not the
// individual call sites that imported it.
// Output is trimmed: every porcelain fact we read is single-line — EXCEPT the multi-line
// corpora the gate scans, which is why the helpers take an optional {maxBuffer}: spawnSync's
// default is 1 MiB and a feature-sized `git diff base..HEAD -U0` blows past it, surfacing
// as an opaque ENOBUFS spawn error — i.e. a scanner that dies looks like a gate that never
// ran (fail-open in appearance). The kernel is the only door to git, so the knob belongs
// here rather than in a private spawnSync somewhere in src/cli. Omitting it is unchanged
// behaviour: undefined leaves spawnSync's own default in place.
//
// --- HARDENED INVOCATION, INVERTED BY DEFAULT ----------------------------------------
// A. WHY IT EXISTS. `git` is configured from FOUR layers that a plain spawnSync inherits
//    wholesale: system config, ~/.gitconfig, the repo's .git/config (which LINKED
//    WORKTREES SHARE with the main checkout), and the GIT_* ENVIRONMENT. Every one of
//    them can rewrite the porcelain the kernel reads as EVIDENCE. The proven fail-open
//    that motivated this: `status.showUntrackedFiles=no` empties `git status --porcelain`,
//    so an untracked file holding an `sk-…` key looks like a clean tree, is never scanned
//    by tier-0, and the tree receives a GREEN receipt. Evidence derivation must not depend
//    on the operator's preferences. PINNING THAT ONE KNOB WAS NEVER THE FIX, though — it
//    was one knob out of a class (see F): several different configs, found independently,
//    each empty status output. The dirty VERDICT no longer reads status at all.
// B. TWO LAYERS, BECAUSE THEY CLOSE DIFFERENT HOLES — this is not belt-and-braces.
//    Measured on git 2.50.1 (macOS): precedence is config files < GIT_CONFIG_COUNT/KEY/VALUE
//    env < command-line `-c` < an explicit command FLAG. So GIT_PIN_ARGS alone does beat
//    hostile *config*, including the env-injected kind. It does NOT beat GIT_DIR /
//    GIT_WORK_TREE / GIT_INDEX_FILE, which are not config at all: they repoint git at a
//    DIFFERENT repository/index, and `git status --porcelain` in a dirty worktree then
//    prints nothing (verified). No `-c` can undo that — only removing the variable can.
//    hardenedGitEnv() therefore exists for repo/index redirection first and config
//    neutralisation second; GIT_PIN_ARGS exists because an explicit `-c` is the layer that
//    survives whatever a future git version does with env-config precedence.
//    (Precedence is a git implementation detail we measured, not a contract — pinning both
//    layers means a reordering in some later git cannot silently reopen the hole.)
// C. ALLOWLIST, NOT BLOCKLIST. Every GIT_* variable is DELETED except GIT_EXEC_PATH
//    (relocatable git installs need it to find their own subcommands). Anything else a
//    caller relied on now fails LOUDLY at spawn time rather than silently changing what
//    git reports — the correct trade for an evidence path.
// D. POSIX ASSUMPTION, STATED: GIT_CONFIG_GLOBAL/SYSTEM are pointed at /dev/null. legion3
//    targets macOS/Linux, Node >= 22; this would need NUL on Windows.
// E. SAFE BY DEFAULT, NAMED OPT-OUT, AUDIT-ENFORCED. Leaving call sites unpinned and
//    hardening opt-in per call site cannot hold in a fail-closed kernel: an unpinned read
//    once let `legion feature abandon` run in repo A delete repo B's worktree and branch
//    under an ambient GIT_DIR.
//    - THE DEFAULT IS INVERTED. git()/gitTry() apply BOTH layers — GIT_PIN_ARGS and
//      hardenedGitEnv — to every call. The ordinary helper is the safe one.
//    - THE DANGEROUS CHOICE MUST BE TYPED. Ambient config is reachable only through
//      gitUserRepo(), whose name reads at the call site as "this deliberately acts on the
//      user's repo". NAMING RATIONALE: the alternative (keep the short `git()` raw and rely
//      on modules importing only wrappers) leaves the raw name one import away and depends
//      on discipline alone to keep it unused. Here the raw primitive is
//      module-private, so there is no unhardened helper importable by ordinary code at all.
//    - THE ONLY CALLERS of gitUserRepo are the three genuinely MUTATING calls in
//      src/cli/feature.mjs (`worktree add`, `worktree remove`, `branch -D`), each carrying a
//      one-line reason at the call site. They act on the user's repo rather than deriving
//      evidence from it, so their hooks/signing/identity/worktree settings legitimately apply.
//      Anything READ to decide something — very much including `feature abandon`'s
//      clean/dirty guard, which gates the destruction of a worktree — is evidence and is
//      hardened.
//    - gitUserRepo STILL STRIPS GIT_REDIRECT_VARS. Keeping the user's CONFIG for a mutation
//      on their repo is legitimate; letting GIT_DIR/GIT_WORK_TREE silently retarget that
//      mutation at a DIFFERENT repository is not. The kernel already determined the target
//      repo and passes it as `cwd`; env redirection overrides `cwd`, and that is precisely
//      the destructive arm of the reproduced bug. User config YES, repo/index/object
//      redirection NO.
//    - BEHAVIOUR CHANGE, deliberate: seven reads that were previously unpinned (project
//      init's repoRoot/remoteUrl/originHead/defaultBranch, feature start's project
//      resolution/baseSha/leftover-branch guard) now ignore the operator's config and
//      environment. That is the fix — those values are written into the authoritative
//      projects index, project.json and feature.json, i.e. they are evidence by definition.
//      Repo-local .git/config is still read (only global/system config and GIT_* are
//      neutralised), so `remote get-url origin` and friends keep working — with ONE
//      qualification, stated rather than implied:
//    - RESIDUAL, DECIDED AND NOT CLOSED (carried the way (D) carries the POSIX assumption):
//      `safe.directory` is honoured ONLY from PROTECTED scopes (system/global), and
//      hardened-by-default points both at /dev/null, so it is discarded. On a bind-mounted
//      volume, a shared CI runner, an NFS checkout or under sudo — anywhere the checkout is
//      owned by another uid — EVERY legion command now dies with git's "detected dubious
//      ownership". That fails CLOSED and LOUDLY, so it is a residual, not a hole. Why not
//      closed: git() takes a `cwd` that is frequently a SUBDIRECTORY rather than the repo
//      root, so a derived `-c safe.directory=<root>` is not available at the call site
//      without an extra derivation that itself needs a working git in that repo; and
//      `safe.directory=*` would switch off a real protection for every call in the tree.
//      Closing it properly means changing how git() learns the repoRoot — a separate change.
//    - ENFORCEMENT AND ITS LIMITS. test/kernel/git-seam.audit.test.mjs pins the export set
//      (so the raw primitive cannot be re-exported) and scans src/ for gitUserRepo call
//      sites against an explicit allowlist of those three mutations. It is a SOURCE SCAN: it
//      catches the ordinary regression — a new unhardened call typed by hand — and it CANNOT
//      see an aliased import (`import { gitUserRepo as g }`), a dynamic import, a computed
//      callee, or a child_process spawn built from a variable. A tripwire, not a proof of
//      hardening.
//
// --- F. THE DIRTY VERDICT IS DERIVED, NOT INFERRED FROM ABSENCE ---------------------
// WHY THE SHAPE CHANGED. "Nothing uncommitted dodges the gate" was implemented as `git
// status --porcelain` returning the EMPTY STRING — reading ABSENCE OF OUTPUT as proof of
// cleanliness, which is fail-OPEN by construction: every config knob that silences status
// reads as clean. Several distinct ones do (status.showUntrackedFiles=no;
// core.excludesFile / $GIT_COMMON_DIR/info/exclude; and, verified on git 2.50.1,
// submodule.<name>.ignore=all / diff.ignoreSubmodules=all, which hide a modified submodule
// file, an untracked secret inside it AND a moved gitlink). Repo-local .git/config carries
// them and LINKED WORKTREES SHARE it, and no `-c` can pre-empt submodule.<name>.ignore
// without knowing the submodule's name. Pinning one knob at a time as it is found is not a
// strategy, so worktreeDirt() DERIVES the answer instead: write the worktree into a
// temporary index, compare the resulting TREE OBJECT to HEAD's tree. Equal ⇒ clean. No
// output-silencing config can forge that equality — it would take a hash collision — and it
// is the SAME property the receipt certifies rather than a proxy for it. STATUS_ARGV
// survives, demoted to REPORTING: it names the dirty paths in the message and decides
// nothing.
// (a) GIT_INDEX_FILE, INTERNAL ALLOWANCE. It is in GIT_REDIRECT_VARS and hardenedGitEnv
//     STRIPS it — correctly: an AMBIENT one is a caller repointing us at someone else's
//     index, i.e. the same class as GIT_DIR. This helper sets it AFTER hardening, on a
//     per-call COPY of the env, to a path WE chose (tmpdir, unique per call, deleted in a
//     finally). We are not trusting a caller's index; we are creating our own scratch one.
//     The strip stays and GIT_REDIRECT_VARS is not weakened.
// (b) THE TEMP INDEX lives outside the repo, is unique per call (pid + uuid) and is removed
//     with its .lock afterwards. The REAL .git/index and the working tree are untouched —
//     asserted byte-for-byte in test/kernel/git-tree-dirty.test.mjs. Starting from an EMPTY
//     index is a BONUS, not a cost: assume-unchanged / skip-worktree bits set in the real
//     index cannot hide a modification from a tree built from scratch.
// (c) NO HEAD (unborn branch / empty repo) is DECIDED, never a crash: HEAD's tree reads as
//     the EMPTY tree (derived from git itself via `hash-object -t tree /dev/null` so it is
//     right for a SHA-256 repo too, with git's SHA-1 constant only as the fallback). So an
//     unborn repo holding files is DIRTY and a genuinely empty one is clean.
// (d) RESIDUAL, HONEST: a COMMITTED .gitattributes clean filter transforms content on its
//     way INTO the index, so a worktree edit the filter erases yields a tree equal to HEAD's
//     and reads clean. Not closed, and not claimed closed. It is the SAME class as the
//     ignored-file residual — content the filter erases cannot reach ANY tree a receipt
//     certifies — and it is not a regression: `git status` applies the identical filters, so
//     the old check was blind to exactly the same edits.
// (e) IGNORED FILES REMAIN EXCLUDED (`add -A` honours .gitignore) — the SAME accepted
//     residual gate.mjs decision 12 already documents, neither widened nor narrowed: an
//     ignored untracked file is not in the tree the receipt certifies.
// (f) SUBMODULES, PLAINLY: the GITLINK is in the superproject tree, so a MOVED submodule
//     HEAD is now DETECTED (the case both submodule knobs hid). Content changes INSIDE a
//     submodule are not in the superproject tree at all — and neither is the receipt's — so
//     this is NOT full submodule coverage. Corollary, deliberate: an EMPTY (uninitialised)
//     submodule directory makes `add -A` drop the gitlink, so a fresh `git worktree add`
//     (which does NOT populate submodules) reads DIRTY while status says nothing. That is
//     fail-closed, and gate.mjs's message says how to fix it (`git submodule update --init`,
//     or put it in the project's bootstrap).
// (g) COST: `add -A` re-hashes the tracked+untracked set. Measured here (macOS, git 2.50.1,
//     warm cache): 0.10s over 34 tracked files, 0.22s over 249. Negligible against a gate
//     that runs the project's test suite; it does put a
//     worktree walk on the SubagentStop verify-receipt path, which is why decision 4 in
//     gate.mjs no longer claims that path is free.
// (h) SIDE EFFECT, STATED: `add -A` writes unreferenced loose objects into the repo's ODB
//     (ordinary `git gc` reclaims them). Nothing else in the repo is touched.
// (i) SPARSE CHECKOUT, STATED: files outside the sparse cone are absent from disk, so a tree
//     built from scratch omits them and the worktree reads DIRTY. Fail-closed and loud
//     rather than silently certifying a partial tree; legion worktrees are full checkouts.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Config pins for evidence-deriving git calls, one list for DIFF and STATUS alike (a
 * second, divergent list is how the status path was left fail-open while diff was pinned).
 * Each entry neutralises something that rewrites the bytes we parse:
 *   core.quotePath      → C-quoted, unmatchable paths
 *   core.excludesFile   → a global ignore file hiding an untracked secret
 *   core.attributesFile → a global attributes file marking code binary (`-diff`)
 *   diff.noprefix / diff.external / color.ui → the `+++ b/<path>` headers tier-0 keys on
 *   status.showUntrackedFiles → THE proven fail-open (see header A)
 *   status.relativePaths → paths reported relative to cwd instead of the worktree root
 *   status.renames       → rename compaction hiding a source path
 *   core.fsmonitor / core.untrackedCache → a stale cache answering instead of the filesystem
 * A command-line FLAG still beats these, so STATUS_ARGV also passes --untracked-files=normal
 * explicitly; the `-c` is what protects the knobs that have no flag. */
export const GIT_PIN_ARGS = [
  '-c', 'core.quotePath=false',
  '-c', 'core.excludesFile=',
  '-c', 'core.attributesFile=',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.external=',
  '-c', 'color.ui=false',
  '-c', 'status.showUntrackedFiles=normal',
  '-c', 'status.relativePaths=false',
  '-c', 'status.renames=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'core.untrackedCache=false',
];

/** THE dirty-path REPORT — no longer a decision (header F). worktreeDirt() has already
 * decided clean/dirty by comparing tree objects; this produces the human-readable list of
 * offending paths for the refusal message, and is BEST-EFFORT: it can be silenced by config
 * (which is precisely why it stopped deciding), and a caller must never flip a verdict on
 * its output. ONE list because three hand-typed copies had already drifted apart — the same
 * copy-divergence class as the seam itself. The flags stay pinned so the MESSAGE is not
 * blinded either: --porcelain=v1 pins the output format version, --untracked-files=normal
 * un-blinds status.showUntrackedFiles, --ignored=no is the documented ignored-file decision
 * (gate.mjs header 12, header F(e)), --no-renames keeps one path per line so the list is
 * unambiguous, and --ignore-submodules=none un-blinds submodule.<name>.ignore /
 * diff.ignoreSubmodules (defense in depth: those knobs can no longer change the VERDICT, and
 * they must not be allowed to empty the explanation of it either).
 * NOTE the un-steerable property lives in the TREE COMPARISON, not here. */
export const STATUS_ARGV = [
  'status', '--porcelain=v1', '--untracked-files=normal', '--ignored=no', '--no-renames',
  '--ignore-submodules=none',
];

/** The GIT_* variables that repoint git at a DIFFERENT repository/index/object store —
 * not config, so no `-c` can undo them. Stripped even by the mutating opt-out (header E). */
export const GIT_REDIRECT_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE',
];

/** GIT_* variables kept when hardening an environment — see header C. */
const GIT_ENV_ALLOW = new Set(['GIT_EXEC_PATH']);

/** The GIT_* variables a hardened environment SETS (after the allowlist purge). */
function hardenedGitVars(identity) {
  const vars = {
    GIT_CONFIG_GLOBAL: '/dev/null',   // ~/.gitconfig cannot reach us (header D)
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',          // a read must never take the index.lock
    GIT_TERMINAL_PROMPT: '0',         // never block a gate on a credential prompt
    GIT_PAGER: 'cat',
  };
  if (identity) {
    vars.GIT_AUTHOR_NAME = identity.name;
    vars.GIT_AUTHOR_EMAIL = identity.email;
    vars.GIT_COMMITTER_NAME = identity.name;
    vars.GIT_COMMITTER_EMAIL = identity.email;
  }
  return vars;
}

/** A COPY of `base` with every GIT_* variable removed except the allowlist, then the
 * hardened set applied. Pure: `base` is not mutated. `{identity:{name,email}}` also pins
 * author/committer — that option exists for the TEST seam (a hermetic env has no
 * ~/.gitconfig, so a fixture commit would otherwise fail for want of a user.name); the
 * gate never commits and never passes one. */
export function hardenedGitEnv(base = process.env, { identity } = {}) {
  const env = { ...base };
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_') && !GIT_ENV_ALLOW.has(k)) delete env[k];
  }
  return Object.assign(env, hardenedGitVars(identity));
}

/** The same neutralisation applied IN PLACE (returns the same object). Used to make a
 * whole process hermetic — notably the test suite, whose child spawns all derive from
 * process.env, so one mutation covers every fixture and every CLI child. A future caller
 * that builds an env object from scratch instead of spreading process.env silently opts
 * out; that is the one way this seam can be defeated. */
export function applyHardenedGitEnv(env = process.env, opts) {
  for (const k of Object.keys(env)) {
    if (k.startsWith('GIT_') && !GIT_ENV_ALLOW.has(k)) delete env[k];
  }
  return Object.assign(env, hardenedGitVars(opts?.identity));
}

/** A COPY of `base` with ONLY the repo/index/object redirection removed — the user's git
 * CONFIG (and identity, signing, hooks) survives. See header E. Pure. */
function userRepoEnv(base) {
  const env = { ...base };
  for (const k of GIT_REDIRECT_VARS) delete env[k];
  return env;
}

/** The raw spawn. MODULE-PRIVATE and staying that way (header E): exporting it would put a
 * short, inviting, unhardened helper back within one import of every module, which is the
 * affordance this design removes. The audit test pins the export set so this cannot drift. */
function spawnGit(args, cwd, { maxBuffer, env } = {}) {
  // Set each key ONLY when asked: spawnSync distinguishes "absent" (its own 1 MiB default,
  // and for env: inherit process.env) from an explicit `undefined` (which reaches the C++
  // runner as "unlimited" / an EMPTY environment), so passing them through unconditionally
  // would silently change every existing call site.
  const opts = { cwd, encoding: 'utf8' };
  if (maxBuffer !== undefined) opts.maxBuffer = maxBuffer;
  if (env !== undefined) opts.env = env;
  const r = spawnSync('git', args, opts);
  if (r.error) throw new Error(`git ${args.join(' ')} (in ${cwd}): ${r.error.message}`);
  if (r.status !== 0) {
    const detail = (r.stderr || r.stdout || `exit ${r.status}`).trim();
    throw new Error(`git ${args.join(' ')} (in ${cwd}) failed: ${detail}`);
  }
  return r.stdout.trim();
}

/** THE ordinary helper: BOTH hardening layers, pinned config and a neutralised
 * environment. Use it for every call whose output is read as EVIDENCE (hashes, tree ids,
 * status, diffs) — i.e. everything the kernel derives.
 * An explicit {env} is HARDENED, not discarded: the base to neutralise is the caller's when
 * one is supplied and process.env otherwise. Silently overwriting it would make the seam
 * untestable with a supplied hostile environment (the only way to exercise it would be
 * mutating global process.env, i.e. testing the ambient process instead of the wrapper). */
export function git(args, cwd, opts = {}) {
  return spawnGit([...GIT_PIN_ARGS, ...args], cwd, { ...opts, env: hardenedGitEnv(opts.env ?? process.env) });
}

/** git() with null on ANY failure. Hardened exactly like git() — for OPTIONAL facts only
 * (a repo with no remote), never for required evidence. */
export function gitTry(args, cwd, opts) {
  try { return git(args, cwd, opts); } catch { return null; }
}

/** THE NAMED OPT-OUT (header E). Runs under the user's own git config — no `-c` pins, no
 * config neutralisation — because the call MUTATES their repository and their hooks,
 * signing and worktree settings must apply. Repo/index redirection is still stripped
 * (GIT_REDIRECT_VARS): the kernel already decided WHICH repo via `cwd`, and an ambient
 * GIT_DIR silently retargeting a destructive command at another repository is the bug this
 * seam exists to prevent. Every use is allowlisted in test/kernel/git-seam.audit.test.mjs
 * and must carry a one-line reason at the call site. */
export function gitUserRepo(args, cwd, opts = {}) {
  return spawnGit(args, cwd, { ...opts, env: userRepoEnv(opts.env ?? process.env) });
}

/** The MAIN worktree's root for the repository containing `cwd` — the identity a project is
 * REGISTERED under, seen from ANY of that repository's checkouts.
 * WHY NOT `rev-parse --show-toplevel`: that answers "which CHECKOUT am I in", which is a
 * DIFFERENT question. Every feature session launches as `cd <worktree> &&
 * claude …`, so the ordinary cwd is a LINKED worktree, where --show-toplevel returns the
 * worktree path and no registered repoRoot matches it — a caller that must recognise the
 * repository (rather than the checkout) needs this instead.
 * WHY `worktree list` AND NOT dirname(`--git-common-dir`): git lists the MAIN worktree FIRST
 * and reports the recorded worktree PATH, so a `--separate-git-dir` / `.git`-file layout —
 * where the common dir's parent is not a checkout at all — still resolves to the real main
 * checkout instead of to a directory that merely sits next to the git dir.
 * Hardened like every other read: WHICH REPOSITORY WE ARE IN is evidence (an ambient GIT_DIR
 * answering this question is the reproduced cross-repo bug of header E). Throws loudly. */
export function mainWorktreeRoot(cwd) {
  const out = git(['worktree', 'list', '--porcelain'], cwd);
  const m = /^worktree (.+)$/m.exec(out);
  if (m === null) {
    throw new Error(`\`git worktree list\` in ${cwd} named no worktree, so the main repository root is unknown`);
  }
  return m[1];
}

// --- the derived dirty verdict (header F) --------------------------------------------------

// git's canonical empty tree, SHA-1 flavour. Only a fallback: the live value is derived from
// git itself so a SHA-256 repository gets its own (header F(c)).
const EMPTY_TREE_SHA1 = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
// A worktree walk can produce a long path list (status/diff-tree) on a real project; 1 MiB
// (spawnSync's default) would surface as an opaque ENOBUFS, i.e. a check that DIED looking
// like a check that passed. Same ceiling the gate uses for its diffs.
const EVIDENCE_MAX_BUFFER = 64 * 1024 * 1024;

/** The tree object the CURRENT WORKING TREE would produce if committed as-is — derived, so
 * no config can silence it (header F). Uses a scratch index in tmpdir: the real .git/index
 * and the worktree are untouched. Throws loudly like any other evidence read (an unreadable
 * file in the worktree now KILLS the check where `git status` merely listed it — fail
 * closed, deliberately). */
export function worktreeTreeHash(worktree) {
  const idx = join(tmpdir(), `legion-index-${process.pid}-${randomUUID()}`);
  // THE ONE INTERNAL GIT_INDEX_FILE ALLOWANCE (header F(a)): set AFTER hardening, on a copy,
  // to a path this function chose. hardenedGitEnv still strips whatever the caller had.
  const env = { ...hardenedGitEnv(process.env), GIT_INDEX_FILE: idx };
  try {
    // advice.addEmbeddedRepo: a submodule reached through a from-scratch index draws git's
    // "adding embedded git repository" hint on stderr. It is noise here (the gitlink is
    // recorded correctly either way, verified) and stderr is what a FAILURE message quotes.
    spawnGit([...GIT_PIN_ARGS, '-c', 'advice.addEmbeddedRepo=false', 'add', '-A'], worktree,
      { env, maxBuffer: EVIDENCE_MAX_BUFFER });
    return spawnGit([...GIT_PIN_ARGS, 'write-tree'], worktree, { env });
  } finally {
    rmSync(idx, { force: true });
    rmSync(`${idx}.lock`, { force: true });
  }
}

/** THE dirty check, for every caller that has one (gate.mjs, kernel/state.mjs isClean,
 * feature.mjs's abandon guard): {clean, headTree, treeHash, paths}. `clean` is the tree
 * comparison and nothing else; `paths` is a BEST-EFFORT explanation and never a verdict —
 * an empty `paths` on a dirty tree means status was silenced by config or a submodule
 * directory is empty, which is why the diff-tree fallback exists (header F(f)). */
export function worktreeDirt(worktree) {
  // No HEAD (unborn branch) ⇒ the empty tree: an unborn repo holding files is DIRTY, an
  // empty one is clean. Decided, never a crash (header F(c)).
  const headTree = gitTry(['rev-parse', '--verify', 'HEAD^{tree}'], worktree)
    ?? gitTry(['hash-object', '-t', 'tree', '/dev/null'], worktree)
    ?? EMPTY_TREE_SHA1;
  const treeHash = worktreeTreeHash(worktree);
  if (treeHash === headTree) return { clean: true, headTree, treeHash, paths: [] };
  // REPORTING ONLY from here: a failure below must never flip the verdict back to clean.
  let paths = [];
  try {
    paths = git(STATUS_ARGV, worktree, { maxBuffer: EVIDENCE_MAX_BUFFER }).split('\n').filter(Boolean);
  } catch { paths = []; }
  if (paths.length === 0) {
    // status said nothing about a tree that demonstrably differs — silenced by config, or an
    // uninitialised submodule whose gitlink `add -A` dropped. Name the paths from the trees
    // themselves, which cannot be silenced — except that diff-tree TOO obeys
    // submodule.<name>.ignore, so --ignore-submodules=none is load-bearing here (measured on
    // git 2.50.1: without it a moved gitlink prints NOTHING, and `-c diff.ignoreSubmodules=
    // none` does not override the per-submodule key — only the flag does).
    try {
      paths = git(['diff-tree', '-r', '--name-status', '--no-renames', '--ignore-submodules=none',
        headTree, treeHash], worktree, { maxBuffer: EVIDENCE_MAX_BUFFER }).split('\n').filter(Boolean);
    } catch { paths = []; }
  }
  return { clean: false, headTree, treeHash, paths };
}

/** worktreeDirt()'s verdict alone, for the callers that only branch on it. */
export const isWorktreeClean = (worktree) => worktreeDirt(worktree).clean;
