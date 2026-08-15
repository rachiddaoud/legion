// gate.mjs — `legion gate run|verify-receipt`. Runs tier-0 self-protection plus tiered
// project-owned commands, cheap → expensive, stopping at the first failure. Locking,
// paths and events are kernel concerns, not this file's.
//
// PROTOCOL: edit → self-test → COMMIT → `legion gate run`.
//
// WHAT A RECEIPT ACTUALLY MEANS. `legion state receipt-record`, a lower-level typed
// primitive, is GONE: with a fixture whose only gate command was `exit 1`, the old
// `receipt-record` → `task-done` → `verify-receipt` chain all passed, which is why "a
// receipt exists" can no longer mean "some caller recorded one, on a clean tree, at that
// tree hash". THIS COMMAND IS NOW THE ONLY MINTER: kernel/state.mjs exports
// recordGateReceipt for this file alone, it is absent from the OPS table, and nothing else in the
// tree calls it.
// THE CONSEQUENCE, STATED NARROWLY. Two claims, both true:
//   (i)  NO typed op and NO gate-less code path mints a receipt. That is a property of the tree, and
//        it is test-backed at both surfaces (the advertised op list and dispatchability).
//   (ii) A receipt THAT PASSES receiptProvenance AGAINST THE PIN means "`legion gate run` found
//        tier-0 and every declared command of that tier green on this tree, under the PINNED
//        policy" — because provenance now requires the receipt's results[] to REPRODUCE the pinned
//        command list (names, tier order, byte-equal argv), `declaredCommands` to EQUAL the pinned
//        count, every recorded exitCode to be 0, and the pinned list itself to hash to the pinned
//        hash (kernel/state.mjs header RECEIPT PROVENANCE enumerates all of it).
// "A RECEIPT EXISTS" ON ITS OWN MEANS NOTHING, because a dossier is a plain file: the verdict comes
// from the verifier, never from the artifact's presence. Which is also why the SubagentStop hook
// runs `legion gate verify-receipt` rather than checking that a receipt is there.
// WHAT REMAINS OPEN — the residual, stated plainly rather than papered over:
//   - A caller with Bash can WRITE tasks.json AND feature.json — both, not one. A forger who
//     copies the pinned tier's command names, their exact argv and their
//     order into `results[]` (exitCode 0, plausible ms), with the real HEAD and the real tree, still
//     produces a receipt that passes provenance. That is not closed and is not claimed to be.
//   - IT CANNOT BE CLOSED FROM INSIDE THE DOSSIER. Every input the check has — the pinned hash, the
//     pinned command list, the tree, the head — is readable and writable in the same directory by
//     the same shell. A check whose entire input the adversary controls cannot distinguish evidence
//     from a copy of evidence.
//   - AN HMAC KEYED ON A FILE IN ~/.legion IS NOT A FIX: that key file is readable by the same Bash,
//     so it would be a FALSE CLAIM OF PREVENTION — worse than an honest audit trail.
//   - THE CHEAPEST FORGERY IS A THREE-FIELD COPY, NOT A RECONSTRUCTION of the whole policy:
//     `commandPolicy[tier]` IS the pinned triple list, in the same file the forger
//     already reads, so a passing `results[]` is a one-expression map over it.
//   - THE CHEAPEST VARIANT NEEDS NO KNOWLEDGE OF THE REAL POLICY AT ALL. feature.json is as
//     writable as tasks.json, and the provenance check only requires the pin's two halves to AGREE.
//     Rewrite both to the EMPTY policy — `commandPolicy[tier]: []` with the hash `commandPolicyPin({})`
//     yields — then `declaredCommands: 0, results: []` verifies. That hash is a project-independent
//     CONSTANT: `project init` scaffolds `gates: {}`, so every such feature already pins it, and the
//     boundary one is published as a golden literal in test/kernel/state.test.mjs. The PIN
//     SELF-CONSISTENCY check cannot stop this — both halves move together, so the pin is
//     self-consistent by construction. It stops the pin being edited by HALVES, which is all it
//     claims here.
//   - AND THAT VARIANT IS OUTSIDE THE `commandPolicyHistory` TRAIL, so the "policy changed
//     mid-feature" block in finalize's MR comment renders nothing for it: the trail is written by
//     repinCommandPolicy, and a direct edit never calls it. One mitigation does survive and is
//     worth naming — that comment still prints the TIER-0 ONLY banner for `declaredCommands: 0`, so
//     the empty-pin variant is not fully silent at the human gate, though that banner's text is
//     then false about what the project declares.
//   - WHAT THIS DELIVERS: a receipt must REPRODUCE the pinned policy rather than merely name
//     its hash. The forgery costs three fields instead of two, all from the same file, and every
//     claim in this tree is narrowed to exactly that (acceptance case 1b is the reproduction, and
//     case 1's comment says what it does and does not cover).
//   - WHAT GENUINE CLOSURE WOULD REQUIRE: a binding OUTSIDE the dossier and outside the agent's
//     reach — the gate's result countersigned by something the agent cannot read, or receipt state
//     held server-side beside the protected-branch boundary. Not attempted here, not claimed
//     anywhere.
// EVERY RECEIPT CARRIES ITS OWN PROVENANCE:
//   {tier, commandPolicyHash, results:[{name, argv, exitCode, ms}], declaredCommands, head,
//    treeHash, at}  (+ allowConfig when the waiver was used, + repinnedFrom when this run
//    re-pinned the policy)
// and `declaredCommands: 0` marks a TIER-0-ONLY receipt — a real but WEAK certificate that must
// never read as a full one, so it is labelled in this command's own GREEN line, in
// verify-receipt's OK line, in `feature start`'s summary, in the SessionStart rendering and in
// the comment finalize posts on the MR. It is enforced NOWHERE: `project init` scaffolds `gates: {}`, and a fresh
// project must still be able to gate.
// The invariant that carries weight is still downstream and is now stronger: `task-done`,
// `close delivered`, `legion finalize` and `verify-receipt` re-derive the tree/HEAD THEMSELVES
// **and** require receiptProvenance() against the PINNED policy — the receipt is evidence, never
// authority, and no flag can inject one.
//
// --- GATE DESIGN NOTES -------------------------------------------
// 1. COMMIT-THEN-GATE. The gate REFUSES a dirty worktree — "dirty" meaning the tree the
//    worktree WOULD produce if committed differs from HEAD's tree (kernel/git.mjs
//    worktreeDirt, header F), the same rule kernel state.mjs recordGateReceipt re-asserts — staged/untracked
//    content must not dodge the gate. Consequently tier-0 scans the COMMITTED feature range
//    `git diff <feature.baseSha>..HEAD`, so an uncommitted `git diff HEAD` (which is EMPTY
//    here and would scan nothing) is never used — that would be a silent fail-open. A file
//    ADDED in the range appears as an all-`+` hunk, so new-file content is still scanned;
//    there is no separate untracked-file scan to maintain. Endpoint (`..`) semantics are
//    deliberate: baseSha is pinned at `feature start`, so `..` is exactly "everything this
//    feature added"; `...`/--merge-base would silently re-anchor if the base branch moved.
// 2. NO RAW SHELL STRINGS, mirroring validateBootstrap. Gate tier
//    commands in project.json are STRUCTURED:
//      gates: { commands: { <name>: { argv: [..], timeoutMs: int>0 } }, task: [names], boundary: [names] }
//    run via execFileSync (never a shell) with cwd = the worktree. validateGatesConfig is
//    strict and exported for direct unit testing.
// 3. EMPTY-BY-SCAFFOLD vs MALFORMED, explicitly distinguished. `legion project init` writes
//    `gates: {}`, so an ABSENT gates block, an absent tier key, or an EMPTY tier array is
//    USABLE: tier-0 still runs and a loud `warning: no project-owned <tier> commands
//    declared` line is printed. A DECLARED-but-broken config is FATAL, naming the offending
//    key: a tier naming an unknown command, a non-array tier, an unknown top-level key, a
//    command that is not exactly {argv, timeoutMs}, a non-string/empty argv, a
//    non-positive/non-integer timeoutMs. A declared command is NEVER silently skipped.
// 4. verify-receipt is the SubagentStop-hook path — the hook never executes the expensive
//    gate. It runs NO tier, spawns NO gate command, dispatches nothing and
//    writes NO legion state; it compares the recorded receipt against evidence it derives now,
//    plus receiptProvenance() against the PIN. It is NOT read-only against the repository:
//    the dirty check DERIVES the worktree's tree, which walks the worktree and writes
//    unreferenced loose objects into the ODB (kernel/git.mjs header F(g),(h)). Measured
//    0.10–0.22s on 34- and 249-file repos — acceptable on a hook path, and stated rather than
//    left as a false "READ-ONLY" claim. Hook wiring is not added here.
//    It also READS project.json, to recompute the LIVE policy
//    hash. That read is BEST-EFFORT and INFORMATIONAL ONLY (a try/catch that yields a "the live
//    policy has drifted, re-pin with …" note): the VERDICT is always against the PIN in
//    feature.json, so an unreadable, missing or newer-schema project.json can never change
//    verify-receipt's answer. It also must NOT short-circuit on a task's `done` status — a done
//    task whose receipt was earned under a superseded policy must still be reported as such,
//    which is precisely what a `done`-means-OK shortcut would hide.
// 5. Lane-aware gating does not exist yet (fan-out is a future milestone). There is
//    likewise no per-project gate MUTEX: legion3 has no lock primitive beyond
//    casfile's CAS, and concurrent gates only arise with fan-out. KNOWN DEFERRAL —
//    concurrent gates over shared node_modules/build caches corrupt them, so the mutex must
//    come back together WITH lane-aware gating.
// 6. ORDERING. "Tier-0 always runs first" governs the CHECKS. Config validation, the
//    dirty-worktree refusal, task existence and the POLICY-PIN comparison are PRECONDITIONS and
//    run before tier-0: they decide whether a gate run is meaningful at all, and a green run
//    that then cannot record its receipt (unknown --task) is strictly worse than a fast, loud
//    refusal. The exact order is chosen so every pre-existing refusal still fires first:
//      task exists → DIRTY → read+validate project.json → live-vs-pinned policy → tier-0 → queue.
//    Dirty before the config read, because a dirty tree is the outermost guarantee; validation
//    before the hash, because a malformed block must die on the offending KEY, not on a hash.
// 7. FEATURE/PROJECT RESOLUTION is by WORKTREE via resolveDossier (shared with `legion
//    state` / `legion plan check`). feature.mjs's resolveProject is deliberately NOT reused
//    (and deliberately not exported): it resolves by MAIN REPO ROOT, and `git rev-parse
//    --show-toplevel` inside a linked worktree returns the worktree — it would refuse every
//    real gate invocation. org/project come from feature.json; the project's configPath
//    comes from the projects index (authoritative, not re-derived).
// 8. A `{script,sha256}` validate carries NO timeoutMs (plan check's frozen shape), so the
//    gate imposes DEFAULT_TIMEOUT_MS = 10min — a hung check must fail the gate, never hang
//    the run. Its script path resolves against the DOSSIER, matching plan.mjs checkValidate
//    (that is the path whose sha256 `plan check` validated); feature.mjs resolves BOOTSTRAP
//    scripts against the worktree — a different artifact with a different owner.
// 9. AN UNRUNNABLE VALIDATE IS A PLAN DEFECT, NOT A CODE FAILURE: a spawn that fails
//    ENOENT/EACCES on a DECLARED validate is reported as a plan defect (no code change can
//    pass it) and still fails the gate.
// 10. EVERY GATE GIT CALL IS PINNED, NEVER INHERITED, AND THE PARSE IS CHECKED. An
//    UNHARDENED git inherits ~/.gitconfig, the repo config, .gitattributes the FEATURE
//    ITSELF commits, and the GIT_* environment — all of which redefine the `+++ b/<path>`
//    headers this scanner keys on. The pin now lives in ONE place for the whole kernel
//    (kernel/git.mjs GIT_PIN_ARGS + hardenedGitEnv, applied by the DEFAULT git() helper —
//    hardening is what any caller gets unless it types the named
//    opt-out gitUserRepo(), which this module never does) rather than a
//    gate-local DIFF_PIN, because two divergent pin lists is exactly how the STATUS path
//    was left fail-open while the DIFF path was hardened. DIFF_FORMAT below
//    keeps only the flags that are specific to the tier-0 CORPUS. A scanner whose input
//    vanishes must never print OK, so every path `--name-only` reports must also appear as
//    a parsed `diff --git` section or tier-0 dies.
// 11. THE DIRTY VERDICT IS DERIVED, NOT INFERRED FROM ABSENCE OF OUTPUT. The
//    dirty-worktree refusal is the gate's OUTERMOST guarantee (nothing uncommitted dodges the
//    scan); checking only that "`git status --porcelain` is empty" is fail-OPEN BY SHAPE:
//    every knob that silences status output read as clean, and three review rounds found
//    three of them (status.showUntrackedFiles=no — the untracked `sk-…` key that rode a GREEN
//    receipt; core.excludesFile / info/exclude; submodule.<name>.ignore=all and
//    diff.ignoreSubmodules=all, verified on git 2.50.1 to hide a modified submodule file, an
//    untracked secret inside it and a MOVED GITLINK). Pinning knob #4 when a reviewer finds
//    it is not a strategy. The check now WRITES THE WORKTREE INTO A TEMPORARY INDEX AND
//    COMPARES THE RESULTING TREE OBJECT TO HEAD'S (kernel/git.mjs worktreeDirt, header F):
//    all four knobs leave that derived tree exactly as it was, so the whole class is closed
//    BY CONSTRUCTION — forging equality would take a hash collision — and the check now tests
//    the very property the receipt certifies instead of a proxy for it. STATUS_ARGV survives
//    as the human-readable REPORT of which paths are dirty and decides nothing (it stays
//    pinned so the MESSAGE is not blinded either; when it comes back empty the trees
//    themselves name the paths). Hardening still matters and is unchanged: GIT_DIR/
//    GIT_WORK_TREE/GIT_INDEX_FILE are not config, no `-c` can undo them, and they would
//    repoint the derivation at another repository. The same helper is the kernel's isClean(),
//    so this gate, recordGateReceipt (the kernel-side writer it calls) and `feature abandon`'s
//    destructive guard all mean the same thing by "dirty".
// 12. IGNORED FILES DO NOT COUNT AS DIRTY, decided explicitly: `add
//    -A` honours .gitignore exactly as `--ignored=no` did, so the line between clean and
//    dirty does not move. (a) The gate
//    certifies a git TREE; an ignored, untracked file is not in the tree and never reaches
//    the MR, so it cannot be smuggled through a receipt it is absent from. (b) Blocking on
//    ignored build output would make the gate unusable on any real project. (c) The hiding
//    risk is bounded but NOT nil, and the sources are exactly two: the repo's COMMITTED
//    `.gitignore` files, PLUS the repo-local `$GIT_COMMON_DIR/info/exclude` that (d) below
//    documents as an uncloseable residual. A THIRD residual of the same shape sits beside them: a COMMITTED
//    `.gitattributes` clean filter transforms content on its way into the index, so an edit
//    the filter erases produces a tree equal to HEAD's and reads clean (kernel/git.mjs header
//    F(d)) — not a regression, since `git status` applied the identical filters. All three
//    share one property, which is why the DECISION does not depend on any of them: content
//    they hide is not in the tree the receipt certifies. A rule the FEATURE adds is inside the gated `base..HEAD`
//    diff and reviewable there; a broad rule that already existed on the base branch (e.g.
//    `*.env`) is NOT in that range — it was reviewed when it entered the base branch, not by
//    this gate: an ignored untracked file is not in
//    the tree the receipt certifies. `core.excludesFile` from ~/.gitconfig or system config
//    is neutralised twice over (GIT_CONFIG_GLOBAL=/dev/null and `-c core.excludesFile=`).
//    (d) DOCUMENTED
//    RESIDUAL, not closed: `$GIT_COMMON_DIR/info/exclude` is repo-local, uncommitted,
//    unreviewable and has NO config knob to disable — it can still hide an untracked file
//    from the dirty check. Stated plainly rather than papered over.
// 13. THE RECEIPT CERTIFIES THE TREE THAT WAS ACTUALLY GATED. recordGateReceipt re-derives
//    HEAD/tree ITSELF at write time (correctly — the kernel never takes a caller-supplied
//    identifier). Nothing made that the same tree tier-0 scanned: any tier command that
//    commits (a formatter with a commit step, a test that commits a fixture, a `git commit`
//    inside a declared argv) moves HEAD between the scan and the record, and the receipt then
//    certifies a tree the gate never saw. So: capture HEAD **and** tree BEFORE tier-0,
//    re-derive both (plus the dirty check) immediately before recording, and if anything
//    moved, REFUSE loudly naming both HEADs and record NOTHING. This introduces NO
//    caller-supplied sha — it is a refuse-or-proceed guard AROUND a derivation the kernel
//    still performs itself. Residual: a tier command that commits and then resets back to
//    the identical commit is invisible to this check (and to any check short of process
//    supervision); the dirty-after-tiers arm catches the ordinary variants.
//    DELIBERATELY STATED TWICE: recordGateReceipt carries the same refuse-or-proceed guard on the
//    kernel side (it throws when the head/tree this command SCANNED disagree with what it derives
//    itself). The duplication is not an oversight — this file keeps the richer ABORTED message
//    because it knows which tier ran and what a `git commit` inside a declared argv looks like,
//    while the kernel-side copy is what makes the invariant true for ANY caller of the writer.
// 15. THE POLICY IS PINNED PER FEATURE, LIKE THE BASE SHA.
//    `feature start` records the per-tier commandPolicyHash into feature.json; this command
//    REFUSES TO RUN when the live project policy differs from the pinned one for THE TIER BEING
//    RUN, naming the drift, printing the old→new command list, and printing the literal re-pin
//    command. Receipt verification at consumption compares against the PINNED hash.
//    WHY PINNED AND NOT "COMPARE AGAINST THE LIVE POLICY" — the reasoning is load-bearing and
//    recorded here because a future reader will otherwise "simplify" it back. Comparing against the LIVE policy
//    stops a receipt earned under policy A being REUSED under policy B, but it does NOT stop an
//    agent from weakening the policy and re-gating: everything then agrees, consistently, under
//    the weaker policy. And the tempting answer — "project.json is protected config, so tier-0
//    catches the edit" — is FALSE: the project config lives in ~/.legion, OUTSIDE the target
//    repository, so it never appears in `baseSha..HEAD` and no diff scan can ever see it.
//    --allow-config covers protected config INSIDE the target repo and nothing else. Pinning is
//    what closes it, because the comparison is then against a value the feature cannot quietly
//    move. There is deliberately NO `policy-change` approval kind (specified and CUT on
//    2026-07-25 as ceremony: the operator of this tool is the human who edited the config, so an
//    approval gating their own edit buys nothing an honest refusal does not).
//    A `done` TASK IS NEVER RETROACTIVELY REOPENED BY A RE-PIN, and there is deliberately NO
//    RETROACTIVE SWEEP: nothing here or in the kernel iterates task receipts, so a re-pin cannot
//    strand finished work. The only writes a `--repin` run makes are the pin itself and the
//    receipt that run then earns.
// 16. `--repin` MUST BE AUDITABLE, BECAUSE IT CANNOT BE PREVENTED — and this is DETECTION, NOT
//    PREVENTION. A builder agent has Bash, so it can edit project.json in the legion home and
//    re-pin in one command; that is the "edits a lint config to make a check pass" failure the
//    threat model names, not a hypothetical. Prevention is REJECTED because there is no honest
//    way to tell an operator shell from an agent shell, and a FALSE CLAIM OF PREVENTION IS WORSE
//    THAN AN HONEST AUDIT TRAIL. So a re-pin is made impossible to do QUIETLY, on three surfaces
//    that only work together:
//      (a) THE PIN'S OWN WRITER RECORDS THE MOVE — repinCommandPolicy appends a
//          `commandPolicyHistory` entry {from:{task,boundary}, to:{task,boundary}, at} to
//          feature.json whenever THE POLICY MOVES. THIS IS THE TRAIL, and it is UNCONDITIONAL IN
//          THE ONE WAY THAT MATTERS: it is written before a single tier runs and does not care what
//          the gate then does. It is NOT unconditional on every write to the pin — see ORDERING
//          below for the third outcome, a REPAIR, which rewrites the pin's list half and
//          deliberately records nothing here, because nothing was superseded.
//          THE FIRST ANSWER — deriving the trail from the receipt's `repinnedFrom` — WAS WRONG
//          TWICE OVER, and both cases were reproduced, so they are named here rather than left to
//          be rediscovered: (1) a re-pinning run that goes RED, or aborts under item 13 above, mints
//          NO RECEIPT AT ALL, so the pin moved with nothing but stdout to show for it and the next
//          ordinary green run looked un-re-pinned; (2) a re-pin moves BOTH TIERS but a receipt is
//          per tier, so `gate run --task <id> --repin` weakening the task gate left the BOUNDARY
//          receipt — the one `legion finalize` reads — with no indication at all. The receipt's
//          `repinnedFrom` REMAINS as convenience evidence bound to the certified tree; it is NOT
//          the trail, and neither field may be removed as "duplication" of the other.
//      (b) THIS COMMAND PRINTS THE FULL old→new COMMAND DIFF, not two hashes — hash-only output
//          would be technically honest and practically unreadable, which is one of the two reasons
//          feature.json stores the pinned command LISTS beside the hashes. The other is that
//          receiptProvenance READS the list; what each half of the pin is for and what compares it
//          is stated once, in kernel/state.mjs commandPolicyPin's docblock, and this line
//          deliberately does not restate it.
//      (c) FINALIZE SURFACES IT AT THE HUMAN GATE — that surface is an MR COMMENT, not
//          the MR body: `legion finalize` posts one comment per successful finalize event carrying
//          the gates-green summary and, whenever `commandPolicyHistory` is non-empty, "this tree was
//          certified under a gate policy that changed mid-feature" — for a task-tier re-pin as much
//          as a boundary-tier one, and for a red run as much as a green one. Comments moved it
//          because a body is written once at create and then describes the first HEAD forever. The
//          re-pin TIMES and TIERS reach the human; the superseded policy HASHES no longer appear in
//          the MR at all (they proved nothing there — finalize.mjs's header owns that decision).
//          That is the enforcement point, which is why (c) is not "just cosmetic" and why (a) had to
//          stop depending on an artifact that may not exist.
//    ORDERING, A JUDGEMENT CALL, recorded so it is visibly a choice: `--repin` moves the pin
//    BEFORE running, so a run that then goes RED (or aborts under item 13 above) has still adopted
//    the live policy. Chosen because the pin is a declaration about CONFIGURATION rather than
//    about a result, and because it is printed loudly with the full diff either way. The
//    alternative — pin only after a green run — was considered and is a one-line move, not a
//    redesign.
//    `--repin` HAS THREE OUTCOMES, NOT TWO, enumerated here because gate.mjs's own code sends
//    the reader to this item for the summary:
//      RE-PIN   (the policy moved): writes the pin, appends the history entry, restamps
//               commandPolicyPinnedAt, stamps `repinnedFrom` on any receipt the run then earns, and
//               prints the full old→new diff.
//      REPAIR   (the policy stood still, the pinned command LIST is absent or hand-edited): writes
//               the pin, bumps `revision`, and records NOTHING ELSE — no history entry, no restamp,
//               no `repinnedFrom`. A repair is NOT a policy change, and an entry whose `from` and
//               `to` are equal would put a mid-feature change that never happened in front of the
//               pre-merge human at (c). This is the outcome that makes receiptProvenance's
//               "re-pin the live policy with `legion gate run --repin`" a remedy that works; before
//               it, that refusal named a command that provably wrote nothing.
//      NO-OP    (the policy stood still and the pin is intact): prints "pin unchanged", writes
//               NOTHING — no revision bump, no history entry, no `repinnedFrom` — and proceeds.
//    None of the three is a refusal and none is ceremony.
//    A MISSING pin is NOT the no-op path: with no pin
//    recorded, `from` is null per tier, so `moved` is TRUE, the run takes the loud RE-PIN branch,
//    and the history entry it writes carries `from: {task: null, boundary: null}` — deliberately,
//    because moving from "nothing was ever declared" to a policy is a change the human should see.
//    NOTE the vocabulary trap here: a stale LIST is not "drift". Drift is a
//    HASH comparison (see item 15 above, and the refusal at the live-vs-pinned check below), so a repair
//    happens on a dossier that has no drift at all.
// 14. RELOCATED CONTENT IS NOT AUTHORED CONTENT. With --no-renames a pure file MOVE is a
//    delete plus an all-`+` add, so relocating a pre-existing file re-scanned its whole
//    content and could fail tier-0 on a secret the feature never authored. Tier-0 therefore
//    exempts any added line whose exact bytes also appear as a REMOVED line anywhere in the
//    same corpus. SOUNDNESS depends on the RANGE: the corpus is `<baseSha>..HEAD`, so every
//    `-` line existed in the tree at baseSha — a byte-identical `+` line is pre-existing
//    content relocated, not content this feature introduced. Anyone changing that range
//    (e.g. to `HEAD~1..HEAD`) invalidates the exemption and must revisit it. The exemption
//    covers ONLY the SECRETS/DEBUGGER scan; the PROTECTED path list still reads the
//    --no-renames `--name-only` output, which is why --no-renames stays (see DIFF_FORMAT).
//    Residual + escape hatch: a secret whose line is reformatted while moving is still
//    flagged, and the remedy is the correct one — remove the secret from the repository;
//    --allow-config deliberately does not cover secrets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from '../kernel/args.mjs';
import { git, worktreeDirt } from '../kernel/git.mjs';
import { readJson } from '../kernel/fsatomic.mjs';
import { projectsIndexPath, safeSegment } from '../kernel/paths.mjs';
import {
  commandPolicyHash, commandPolicyPin, receiptProvenance, recordGateReceipt, repinCommandPolicy,
} from '../kernel/state.mjs';
import { resolveDossier } from './state.mjs';

const USAGE =
  'legion gate run [--task <id> | --boundary] [--allow-config] [--repin] [--org <org>] [--feature <name>] [--now <iso>]\n' +
  '       legion gate verify-receipt [--task <id> | --boundary] [--org <org>] [--feature <name>]';

// --- tier-0 policy -----------------------------------------------------------------------
// Lint/format/type configs are the gate's own definition: a builder must fix the code, not
// the gate. --allow-config is an EXPLICIT OPERATOR WAIVER of that protection — no approval
// artifact is read or required (there is deliberately no `config-change` approval kind). The
// waiver's use rides the receipt's provenance (`allowConfig: true`), so the pre-merge reviewer sees it.
const PROTECTED = /(^|\/)(\.eslintrc[^/]*|eslint\.config\.[^/]+|\.prettierrc[^/]*|prettier\.config\.[^/]+|biome\.jsonc?|tsconfig[^/]*\.json|vitest\.config\.[^/]+|jest\.config\.[^/]+|\.stylelintrc[^/]*|sonar-project\.properties)$/;
/** @type {[RegExp, string][]} */
const SECRETS = [
  [/sk-[A-Za-z0-9]{20,}/, 'API key (sk-…)'],
  [/ghp_[A-Za-z0-9]{36}/, 'GitHub token (ghp_…)'],
  // The fine-grained PAT format GitHub issues today, alongside the classic ghp_ one above.
  [/github_pat_[A-Za-z0-9_]{22,}/, 'GitHub fine-grained token (github_pat_…)'],
  [/glpat-[A-Za-z0-9_-]{20,}/, 'GitLab token (glpat-…)'],
  [/AKIA[A-Z0-9]{16}/, 'AWS access key (AKIA…)'],
  [/api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i, 'hardcoded api key'],
];
const DEBUGGER = /(^|[;{}\s])debugger\s*(;|$)/m;
const CODE_EXT = /\.(m?[jt]sx?|cjs)$/;

// A feature-sized `git diff base..HEAD -U0` routinely exceeds spawnSync's 1 MiB default
// maxBuffer, which surfaces as an opaque ENOBUFS — a scanner that dies looks like a gate
// that never ran.
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;
// The SAME hazard, far likelier, on the tier commands themselves: a GREEN `npm test`/`tsc`/
// `eslint` on any real project can print more than 1 MiB, and overflow kills the child with
// killSignal and throws ENOBUFS — which the old signal-only heuristic below misread as
// `timeout after 60000ms (elapsed 100ms)`, i.e. a passing command reported RED for a reason
// that never happened and that no code change could fix. Generous ceiling, and ENOBUFS is
// now reported as itself.
const CMD_MAX_BUFFER = 64 * 1024 * 1024;

// --- tier-0 diff invocation ----------------------------------------------------------------
// Config that silently empties the corpus, each PROVEN to gate a committed `sk-…` key GREEN
// or to be a live escape:
//   diff.noprefix / diff.srcPrefix / diff.dstPrefix / diff.mnemonicPrefix → no `b/` prefix
//   color.diff=always                                                    → ANSI bytes before `+++`
//   diff.external, a textconv driver                                     → output replaced wholesale
//   a committed `.gitattributes` saying `*.mjs -diff`                    → `Binary files … differ`
// `-c` overrides any config file, and the explicit --src-prefix/--dst-prefix override EVERY
// prefix knob at once (present or future) rather than enumerating them; --text overrides the
// attribute. Belt and braces on purpose: this is the gate's own self-protection.
// The `-c` pins themselves live in kernel/git.mjs GIT_PIN_ARGS — the default
// git() helper applies them, and the neutralised environment, to diff and status alike.
// --no-renames is LOAD-BEARING FOR PROTECTED, not formatting: with git's default rename
// detection `--name-only` prints only a rename's DESTINATION, so `git mv .eslintrc.json
// eslint-old.txt` deletes the lint config while showing the gate nothing but a new .txt.
// Off, a rename is a delete + an add and the source path is screened like any other path.
const DIFF_FORMAT = [
  '--no-ext-diff', '--no-textconv', '--text', '--no-color', '--no-renames',
  '--src-prefix=a/', '--dst-prefix=b/',
];
const diffArgv = (extra, range) => ['diff', ...DIFF_FORMAT, ...extra, range];
// With --no-renames both sides are ALWAYS the same path, so the backreference does double
// duty: it asserts the pinned prefixes really took effect, and it disambiguates the split for
// a path that itself contains ' b/'. A line that fails it leaves the path out of `sections`,
// which the audit below turns into a loud death rather than a silent skip.
const SECTION_RE = /^diff --git a\/(.+) b\/\1$/;
/** First few dirty entries, for a refusal that NAMES the offending file. `paths` is
 * worktreeDirt()'s best-effort report, so it can legitimately be EMPTY on a dirty tree —
 * say what that means and how to fix it instead of printing an empty parenthesis
 * (kernel/git.mjs header F(f); decisions 11 + 12 below). */
const dirtyList = (paths) =>
  paths.length === 0
    ? 'git status reported nothing — a config knob is silencing it, or a submodule directory ' +
      'is empty (uninitialised): run `git submodule update --init` in the worktree, or add it ' +
      'to the project\'s bootstrap'
    : `${paths.slice(0, 5).join(', ')}${paths.length > 5 ? ` (+${paths.length - 5} more)` : ''}`;

// Ceiling for a {script,sha256} validate (that shape carries no timeoutMs) — see header 8.
const DEFAULT_TIMEOUT_MS = 10 * 60_000;
// Gate command names are kebab identifiers: keeps error text unambiguous and stops a config
// key from smuggling shell/pathish bytes into a report.
const CMD_NAME_RE = /^[a-z][a-z0-9-]*$/;
const GATE_KEYS = ['commands', 'task', 'boundary'];
const TAIL_LINES = 25;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Strict validator for project.json's `gates` block. Returns the normalized
 * {commands, task, boundary} triple; throws loudly naming the offending key on ANY
 * malformed or dangling declaration (header decisions 2 + 3). `gates == null` (the
 * `project init` scaffold, or an absent block) is the usable empty config, NOT an error. */
export function validateGatesConfig(gates, configPath) {
  const empty = { commands: {}, task: [], boundary: [] };
  if (gates == null) return empty;
  if (!isObject(gates)) {
    throw new Error(`invalid gates config in ${configPath}: gates must be an object (allowed keys: ${GATE_KEYS.join(', ')})`);
  }
  for (const k of Object.keys(gates)) {
    if (!GATE_KEYS.includes(k)) {
      throw new Error(`invalid gates config in ${configPath}: unknown key 'gates.${k}' (allowed: ${GATE_KEYS.join(', ')})`);
    }
  }
  const commands = {};
  if (gates.commands !== undefined) {
    if (!isObject(gates.commands)) {
      throw new Error(`invalid gates config in ${configPath}: gates.commands must be an object of {name: {argv, timeoutMs}}`);
    }
    for (const [name, cmd] of Object.entries(gates.commands)) {
      if (!CMD_NAME_RE.test(name)) {
        throw new Error(`invalid gates config in ${configPath}: command name '${name}' must match ${CMD_NAME_RE} (lowercase kebab)`);
      }
      const keys = isObject(cmd) ? JSON.stringify(Object.keys(cmd).sort()) : null;
      if (keys !== '["argv","timeoutMs"]') {
        throw new Error(
          `invalid gates config in ${configPath}: gates.commands.${name} must be exactly ` +
          `{argv: [string,...], timeoutMs: <positive int>} — no extra fields; raw shell strings are forbidden`,
        );
      }
      if (!Array.isArray(cmd.argv) || cmd.argv.length === 0 || !cmd.argv.every((a) => typeof a === 'string')) {
        throw new Error(`invalid gates config in ${configPath}: gates.commands.${name}.argv must be a non-empty array of strings`);
      }
      if (!Number.isInteger(cmd.timeoutMs) || cmd.timeoutMs <= 0) {
        throw new Error(`invalid gates config in ${configPath}: gates.commands.${name}.timeoutMs must be a positive integer`);
      }
      commands[name] = { argv: [...cmd.argv], timeoutMs: cmd.timeoutMs };
    }
  }
  const tiers = {};
  for (const tier of ['task', 'boundary']) {
    const list = gates[tier];
    if (list === undefined) { tiers[tier] = []; continue; }
    if (!Array.isArray(list)) {
      throw new Error(`invalid gates config in ${configPath}: gates.${tier} must be an array of command names`);
    }
    list.forEach((n, i) => {
      if (typeof n !== 'string') {
        throw new Error(`invalid gates config in ${configPath}: gates.${tier}[${i}] must be a command-name string`);
      }
      if (!Object.hasOwn(commands, n)) {
        throw new Error(
          `invalid gates config in ${configPath}: gates.${tier}[${i}] references unknown command '${n}' — ` +
          `declare it under gates.commands`,
        );
      }
    });
    tiers[tier] = [...list];
  }
  return { commands, task: tiers.task, boundary: tiers.boundary };
}

// --- manifests + config -------------------------------------------------------------------

/** Read a dossier manifest, asserting schemaVersion 1 (identical contract to the kernel's
 * module-private readManifest — duplicated in four lines rather than exporting kernel
 * internals just to widen their blast radius). */
function readManifest(path, hint) {
  if (!existsSync(path)) throw new Error(`no ${basename(path)} at ${path} — run \`${hint}\` first`);
  const doc = readJson(path); // corrupt JSON dies loudly naming the path
  if (doc.schemaVersion !== 1) {
    throw new Error(`unknown schemaVersion ${JSON.stringify(doc.schemaVersion)} in ${path} — this kernel reads/writes schemaVersion 1 only`);
  }
  return doc;
}

/** project.json, under the SAME schemaVersion assertion every other manifest read carries —
 * it was the one manifest read raw, so a future schema bump would have been interpreted
 * under v1 rules instead of refused. */
function readProjectConfig(configPath) {
  if (!existsSync(configPath)) {
    throw new Error(`no project.json at ${configPath} — run \`legion project init\` in the target repo first`);
  }
  const doc = readJson(configPath);
  if (doc.schemaVersion !== 1) {
    throw new Error(`unknown schemaVersion ${JSON.stringify(doc.schemaVersion)} in ${configPath} — this kernel reads/writes schemaVersion 1 only`);
  }
  return doc;
}

/** The project.json path for this feature's project, via the machine-local index. */
function configPathFor(f) {
  const idxPath = projectsIndexPath();
  if (!existsSync(idxPath)) throw new Error(`no project index at ${idxPath} — run \`legion project init\` first`);
  const idx = readJson(idxPath);
  const p = (idx.projects ?? []).find((x) => x.org === f.org && x.name === f.project);
  if (!p) throw new Error(`project ${f.org}/${f.project} is not registered in ${idxPath} — re-run \`legion project init\``);
  return p.configPath;
}

// --- tier-0 -------------------------------------------------------------------------------

/** Tier-0 self-protection over the COMMITTED feature range. Returns null when clean, else
 * {name, summary} for the failing tier-0 check. */
function tier0(f, allowConfig) {
  const range = `${f.baseSha}..HEAD`;
  const changed = git(diffArgv(['--name-only'], range), f.worktree, { maxBuffer: DIFF_MAX_BUFFER })
    .split('\n').filter(Boolean);

  const touched = changed.filter((p) => PROTECTED.test(p));
  if (touched.length > 0) {
    if (!allowConfig) {
      // THE MESSAGE IS THE CONTRACT: --allow-config is an explicit operator waiver and
      // NOTHING here reads any recorded approval. Say what the flag
      // actually is, and that its use is visible downstream.
      return {
        name: 'tier-0 protect',
        summary: `protected config modified: ${touched.join(', ')} — fix the code to satisfy the gate, ` +
          `don't weaken the gate. If changing this config IS the task, the operator may waive tier-0 ` +
          `config protection for this run with --allow-config (an explicit waiver, not an approval: ` +
          `nothing is read from state, and the waiver is recorded in the receipt's provenance for the ` +
          `pre-merge reviewer)`,
      };
    }
    process.stdout.write(
      `gate: --allow-config: ${touched.join(', ')} — tier-0 config protection WAIVED for these ` +
      `file(s) by explicit operator flag; recorded in the receipt's provenance\n`,
    );
  }

  // -U0 keeps the corpus to ADDED lines only: a secret that was already in the base is not
  // this feature's failure, and context lines would re-flag it on every subsequent gate.
  const corpus = git(diffArgv(['-U0'], range), f.worktree, { maxBuffer: DIFF_MAX_BUFFER });
  const byFile = new Map();
  // Every line REMOVED anywhere in the range — i.e. content that existed at baseSha. Added
  // lines byte-identical to one of these are relocated, not authored (see the relocated-content
  // note in the header above).
  const removed = new Set();
  const sections = new Set(); // every path git emitted a diff section for — the parse audit
  let cur = null;             // file the current hunk's added lines belong to
  let inHunk = false;         // header region vs hunk body: content is only trusted in a hunk
  for (const l of corpus.split('\n')) {
    const g = l.match(SECTION_RE);
    if (g) { sections.add(g[1]); cur = null; inHunk = false; continue; }
    if (l.startsWith('@@ ')) { inHunk = true; continue; }
    if (!inHunk) {
      // Header region only: an ADDED line reading `++ b/x` would otherwise become a forged
      // `+++ b/x` header and re-attribute the real file's secrets to a path of its choosing.
      const m = l.match(/^\+\+\+ b\/(.+)$/); // '+++ /dev/null' (a deletion) never matches
      if (m) { cur = m[1]; byFile.set(cur, []); }
      continue;
    }
    if (l.startsWith('-')) { removed.add(l.slice(1)); continue; } // in-hunk only: `--- a/x` is header-region
    if (cur && l.startsWith('+')) byFile.get(cur).push(l.slice(1));
  }
  // A check that ran on zero bytes must never be indistinguishable from a check that passed.
  // (A path with a section but no `+++` is legitimate: pure deletion, empty new file, mode
  // change — none of which add scannable bytes.)
  const unread = changed.filter((p) => !sections.has(p));
  if (unread.length > 0) {
    throw new Error(
      `tier-0 could not read the diff for ${range} in ${f.worktree}: git emitted no parseable ` +
      `diff section for ${unread.slice(0, 5).join(', ')}${unread.length > 5 ? ` (+${unread.length - 5} more)` : ''} — ` +
      `refusing to report a secret/debugger scan that read nothing ` +
      `(most likely a path git had to C-quote — rename it to plain printable ASCII)`,
    );
  }
  const hits = [];
  for (const [path, lines] of byFile) {
    // A moved file's own lines are in `removed`, so a pure relocation scans empty.
    const text = lines.filter((l) => !removed.has(l)).join('\n');
    for (const [re, what] of SECRETS) if (re.test(text)) hits.push(`${what} in ${path}`);
    if (CODE_EXT.test(path) && DEBUGGER.test(text)) hits.push(`debugger statement in ${path}`);
  }
  if (hits.length > 0) return { name: 'tier-0 secrets', summary: [...new Set(hits)].join('\n') };
  return null;
}

// --- command execution --------------------------------------------------------------------

/** Run one gate command. No shell, ever. Returns {ok, ms, exitCode} or
 * {ok:false, ms, exitCode, summary}. `exitCode` is what the receipt's `results[]` records: 0 on
 * success, the child's status when it exited, and null when it never ran or was killed (a spawn
 * failure, a timeout, a maxBuffer kill) — never invented, because a receipt is only minted on a
 * GREEN run and a fabricated exit code there would be a claim of a result nobody observed. */
function runCommand({ name, file, args, cwd, timeoutMs }) {
  process.stdout.write(`gate: running ${name} (${[file, ...args].join(' ')})\n`);
  const t0 = Date.now();
  try {
    execFileSync(file, args, {
      cwd, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: CMD_MAX_BUFFER,
    });
    return { ok: true, ms: Date.now() - t0, exitCode: 0 };
  } catch (e) {
    const ms = Date.now() - t0;
    const exitCode = typeof e.status === 'number' ? e.status : null;
    // execFileSync surfaces a SPAWN failure with an errno code and no exit status.
    const spawnFailed = e.code === 'ENOENT' || e.code === 'EACCES';
    if (name === 'validate' && spawnFailed) {
      return {
        ok: false, ms, exitCode,
        summary: `validate is not runnable: '${file}' is missing or not executable — PLAN DEFECT: ` +
          `fix the task \`validate\` in the plan (assertion prose belongs in \`gotcha\`); ` +
          `no code change can pass this gate`,
      };
    }
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
    const tail = out.split('\n').slice(-TAIL_LINES).join('\n').trim();
    // Classification is CODE-first, never signal-first: node kills BOTH a timeout and a
    // maxBuffer overflow with our killSignal, so `e.signal === 'SIGKILL'` alone cannot tell
    // them apart and reporting it as a timeout is how a passing-but-verbose command got a
    // fabricated `timeout after 60000ms (elapsed 100ms)`. e.code is crisp (ETIMEDOUT /
    // ENOBUFS); elapsed >= timeoutMs stays only as a secondary for a timeout whose measured
    // elapsed rounds just under the ceiling. Any other signal is reported as itself.
    let head;
    if (spawnFailed) head = `cannot execute '${file}': ${e.code}`;
    else if (e.code === 'ENOBUFS') {
      head = `output exceeded ${CMD_MAX_BUFFER} bytes after ${ms}ms and was killed — ` +
        `make ${name} quieter; this is NOT a timeout and NOT a test failure, and any excerpt ` +
        `below is truncated output, not the end of the run`;
    } else if (e.code === 'ETIMEDOUT' || ms >= timeoutMs) head = `timeout after ${timeoutMs}ms (elapsed ${ms}ms)`;
    else if (e.signal != null) head = `killed by signal ${e.signal} after ${ms}ms`;
    else head = `exit ${e.status} after ${ms}ms`;
    return { ok: false, ms, exitCode, summary: tail ? `${head}\n${tail}` : head };
  }
}

/** Resolve a task's `validate` into a runnable command, or null when absent. Shapes match
 * plan.mjs checkValidate exactly — a plan that passed `plan check` must run here. */
function resolveValidate(task, dossier, worktree) {
  const v = task.validate;
  if (v === undefined) return null;
  const keys = isObject(v) ? JSON.stringify(Object.keys(v).sort()) : null;
  if (keys === '["argv","cwd","timeoutMs"]') {
    return { name: 'validate', file: v.argv[0], args: v.argv.slice(1), cwd: resolve(worktree, v.cwd), timeoutMs: v.timeoutMs };
  }
  if (keys === '["script","sha256"]') {
    const scriptPath = join(dossier, v.script); // dossier-relative: see item 8 above
    let bytes;
    try { bytes = readFileSync(scriptPath); }
    catch (err) { throw new Error(`task '${task.id}' validate.script ${scriptPath} cannot be read: ${err.message}`); }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== v.sha256) {
      throw new Error(
        `task '${task.id}' validate.script sha256 mismatch for ${scriptPath} — ` +
        `expected ${v.sha256}, got ${digest}; refusing to execute`,
      );
    }
    return { name: 'validate', file: scriptPath, args: [], cwd: worktree, timeoutMs: DEFAULT_TIMEOUT_MS };
  }
  throw new Error(
    `task '${task.id}' validate is malformed — must be exactly {cwd,argv,timeoutMs} or exactly ` +
    `{script,sha256} (\`legion plan check\` should have caught this)`,
  );
}

// --- the policy pin (header decisions 15 + 16) -----------------------------------------------

/** One command triple rendered for a human: `<name> <argv…>  (timeout <ms>ms)`. This is what
 * makes the drift refusal READABLE rather than merely honest — two hashes tell an operator that
 * something changed, this tells them what. */
const renderPolicy = (triples) =>
  (triples ?? []).length === 0
    ? '    (none declared — tier-0 only)\n'
    : triples.map(([name, argv, timeoutMs]) => `    ${name}: ${argv.join(' ')}  (timeout ${timeoutMs}ms)\n`).join('');

/** The old→new command diff for one tier. `pinned` may be undefined on a feature.json written
 * before the pin existed, or hand-edited — say so instead of printing an empty list, because the
 * PIN THAT DECIDES is the hash and this list exists purely to be read. */
function policyDiff(tier, pinnedTriples, liveTriples) {
  return (
    `  ${tier} tier — PINNED policy:\n` +
    (pinnedTriples === undefined ? '    (not recorded in feature.json)\n' : renderPolicy(pinnedTriples)) +
    `  ${tier} tier — LIVE policy:\n${renderPolicy(liveTriples)}`
  );
}

// --- subcommands --------------------------------------------------------------------------

function gateRun({ dossier, f, tasks, tier, taskId, allowConfig, repin, now }) {
  const reGate = `legion gate run ${taskId ? `--task ${taskId}` : '--boundary'}`;

  // --- preconditions (see item 6 above) ---
  let task = null;
  if (taskId) {
    task = tasks.tasks.find((x) => x.id === taskId);
    if (!task) throw new Error(`unknown task '${taskId}' — not in tasks.json (import a plan via \`legion plan check --import\`)`);
  }
  const dirtyBefore = worktreeDirt(f.worktree);
  if (!dirtyBefore.clean) {
    throw new Error(
      `worktree ${f.worktree} is dirty (${dirtyList(dirtyBefore.paths)}) — commit-then-gate: ` +
      `commit your work, then re-run \`${reGate}\``,
    );
  }
  const configPath = configPathFor(f);
  const gates = validateGatesConfig(readProjectConfig(configPath).gates, configPath);

  // --- the POLICY PIN, above tier-0 and above the queue (see items 15 + 16 above) ---
  // NOTHING is written and NOTHING is spawned below this point on the refusal path: the whole
  // reason the pin sits here is that a drifted policy must not get to run a single command.
  const live = commandPolicyPin(gates);
  const pinnedHash = f.commandPolicyHash?.[tier];
  const liveHash = live.commandPolicyHash[tier];
  let repinnedFrom = null;
  if (repin) {
    // THE DURABLE RECORD IS WRITTEN HERE, BY THE PIN'S OWN WRITER, AND IT IS UNCONDITIONAL.
    // repinCommandPolicy appends the {from, to, at} commandPolicyHistory entry whenever the pin
    // actually moves, and it is the single definition of "moved" — so what is PRINTED below is
    // the same verdict that was WRITTEN, and everything after this line (a RED tier, an abort
    // under item 13 above, a process that dies) is irrelevant to whether the change was recorded.
    // The trail cannot be derived from the receipt instead, because a red run never mints one
    // and a receipt only ever covers the tier being run (kernel/state.mjs repinCommandPolicy
    // documents both failures; see item 16 above).
    const res = repinCommandPolicy(dossier, live, now);
    if (res.repaired) {
      // THE LIST HALF WAS REBUILT AND THE POLICY DID NOT CHANGE. Printed as its own outcome rather
      // than folded into either branch, because both of the others would be a lie here: "nothing
      // written" is false (feature.json was rewritten) and "re-pinned" is false (the policy stood
      // still, and nothing went into commandPolicyHistory). This is the path that makes the
      // verifier's "re-pin the live policy with `legion gate run --repin`" a remedy that works.
      process.stdout.write(`gate: --repin: ${res.summary}\n`);
    } else if (!res.moved) {
      // THE NO-OP OUTCOME (see item 16 above, ORDERING). Reached only when the
      // policy stood still AND the pin is intact — the repair branch above already took the case
      // where the list half was stale, so "no drift" alone does not describe this branch. Never a
      // refusal and never ceremony: repinCommandPolicy writes NOTHING here, so `revision` does not
      // bump and commandPolicyPinnedAt keeps naming the moment the pin was actually set.
      // NOTE this is NOT the missing-pin path: with no pin recorded, `from` is null per tier, so
      // `moved` is TRUE and the run takes the loud RECORDING branch below and writes a history
      // entry with `from: null`.
      // res.summary already says "unchanged"; wrapping it in a second "unchanged" stuttered.
      process.stdout.write(`gate: --repin: ${res.summary} — nothing written, proceeding\n`);
    } else {
      // The pin is a SNAPSHOT of the project's gate policy, exactly as baseSha is a snapshot of
      // the base, so both tiers move together: a mixed-generation pin would be less legible than
      // either generation. The full diff is printed for every tier that moved (surface (b)).
      const movedTiers = ['task', 'boundary'].filter((t) => res.from[t] !== res.to[t]);
      process.stdout.write(
        `gate: --repin: RECORDING THE LIVE GATE POLICY AS THE NEW PIN for ${f.featureId}.\n` +
        `THIS IS DETECTION, NOT PREVENTION: a re-pin cannot be blocked (an agent with Bash can edit\n` +
        `${configPath} and re-pin in one command), so it is made impossible to do quietly — the diff\n` +
        `below, the commandPolicyHistory entry just written to feature.json, and that history\n` +
        `rendered in the comment \`legion finalize\` posts on the MR for the pre-merge human.\n` +
        movedTiers.map((t) => policyDiff(t, f.commandPolicy?.[t], live.commandPolicy[t])).join('') +
        `${res.summary}\n`,
      );
      // CONVENIENCE EVIDENCE ONLY, bound to the certified tree — the trail is the history above.
      // Only THIS tier's superseded hash rides the receipt, and only when there was one to
      // supersede: the field's mere PRESENCE is a signal, so it must never be a placeholder for
      // "there was no pin".
      if (typeof res.from[tier] === 'string' && res.from[tier] !== liveHash) repinnedFrom = res.from[tier];
    }
  } else if (pinnedHash !== liveHash) {
    process.stderr.write(
      `gate REFUSED — GATE POLICY DRIFT, nothing was run and no receipt was recorded.\n` +
      `The ${tier} gate policy PINNED for ${f.featureId} at \`feature start\` is not the policy\n` +
      `declared in ${configPath} today:\n` +
      `  pinned ${tier} policy: ${pinnedHash ?? '(NONE PINNED)'}\n` +
      `  live   ${tier} policy: ${liveHash}\n` +
      policyDiff(tier, f.commandPolicy?.[tier], live.commandPolicy[tier]) +
      `A receipt is only worth the policy it was earned under, and comparing against the LIVE\n` +
      `policy would not help: project.json lives outside the target repo, so no tier-0 diff can\n` +
      `see an edit to it. Restore the pinned policy, or adopt the live one deliberately:\n` +
      `  ${reGate} --repin\n`,
    );
    return 1;
  }

  const names = gates[tier];
  if (names.length === 0) {
    process.stdout.write(`warning: no project-owned ${tier} commands declared in ${configPath} — tier-0 only\n`);
  }

  // the tree the gate is ABOUT to scan, captured before a single check runs (see item 13 above).
  const gatedHead = git(['rev-parse', 'HEAD'], f.worktree);
  const gatedTree = git(['rev-parse', 'HEAD^{tree}'], f.worktree);
  process.stdout.write(`gate: ${tier} tier on ${f.branch} @ ${gatedHead} (base ${f.baseSha})\n`);

  const fail = (name, summary) => {
    process.stderr.write(
      `gate RED (${tier} tier) at \`${name}\`:\n${summary}\n` +
      `no receipt recorded — fix forward (fixup commit), then re-run \`${reGate}\`\n`,
    );
    return 1;
  };

  // --- tier-0 ALWAYS first ---
  const t0 = tier0(f, allowConfig);
  if (t0) return fail(t0.name, t0.summary);
  process.stdout.write(`gate: tier-0 OK (protect${allowConfig ? ' [--allow-config]' : ''}, secrets)\n`);

  // --- declared tier commands, in order, then the task's own validate LAST ---
  const queue = names.map((n) => ({ name: n, file: gates.commands[n].argv[0], args: gates.commands[n].argv.slice(1), cwd: f.worktree, timeoutMs: gates.commands[n].timeoutMs }));
  if (task) {
    const v = resolveValidate(task, dossier, f.worktree); // sha256 mismatch / malformed shape throw
    if (v) queue.push(v);
    else process.stdout.write(`warning: task ${taskId} declares no validate command — nothing task-specific was run\n`);
  }
  // `results` records every command actually SPAWNED, in execution order — the declared tier
  // commands plus the task's own `validate` when there is one. `declaredCommands` counts only the
  // PROJECT-declared tier list, so the two differ by exactly the validate, and 0 declared is what
  // marks a receipt tier-0-only. validate is plan-owned and outside commandPolicyHash by design
  // (kernel/state.mjs header), which is why it can appear in results without moving the policy.
  const results = [];
  for (const cmd of queue) {
    const r = runCommand(cmd);
    if (!r.ok) return fail(cmd.name, r.summary); // cheap → expensive: stop at the first failure
    results.push({ name: cmd.name, argv: [cmd.file, ...cmd.args], exitCode: r.exitCode, ms: r.ms });
    process.stdout.write(`gate: ${cmd.name} OK (${r.ms}ms)\n`);
  }

  // --- the receipt may only certify the tree that was actually gated (see item 13 above) ---
  const headNow = git(['rev-parse', 'HEAD'], f.worktree);
  const treeNow = git(['rev-parse', 'HEAD^{tree}'], f.worktree);
  const dirtyNow = worktreeDirt(f.worktree);
  if (headNow !== gatedHead || treeNow !== gatedTree || !dirtyNow.clean) {
    process.stderr.write(
      `gate ABORTED — no receipt recorded: the repository CHANGED during the ${tier} tier.\n` +
      `gated HEAD ${gatedHead} (tree ${gatedTree}); now HEAD ${headNow} (tree ${treeNow})` +
      `${dirtyNow.clean ? '' : `; worktree dirty: ${dirtyList(dirtyNow.paths)}`}\n` +
      `a gate command that commits or writes (a formatter with a commit step, a test that ` +
      `commits a fixture) invalidates the scan — the receipt may only certify the tree the ` +
      `gate actually scanned. Make the ${tier} commands read-only, then re-run \`${reGate}\`\n`,
    );
    return 1;
  }

  // --- GREEN: the receipt, minted through the kernel's writer and nowhere else ---
  // recordGateReceipt re-derives HEAD/tree itself and refuses if they disagree with what THIS run
  // scanned (the same check as item 13 above, stated twice on purpose). No identifier below is authoritative: the
  // gate supplies what it OBSERVED and the kernel decides whether that is still true.
  const msg = recordGateReceipt(dossier, {
    tier,
    taskId,
    expectHead: gatedHead,
    expectTree: gatedTree,
    commandPolicyHash: liveHash,
    declaredCommands: names.length,
    results,
    allowConfig,
    repinnedFrom,
  }, now);
  // `gate GREEN (<tier> tier)` is kept verbatim as the leading token — it is what the suite and
  // any operator grep on — with the provenance appended after the parenthesis rather than inside.
  process.stdout.write(
    `gate GREEN (${tier} tier) — policy ${liveHash}, ${names.length} declared ${tier} command(s)` +
    `${names.length === 0 ? ' [TIER-0 ONLY: a real but WEAK certificate]' : ''}` +
    `${repinnedFrom ? ` [GATE POLICY RE-PINNED, superseding ${repinnedFrom}]` : ''}\n${msg}\n`,
  );
  return 0;
}

/** NO GATE TIER IS EXECUTED HERE (see item 4 above): no gate command is spawned, nothing is
 * dispatched, and no legion state is written. It compares the recorded receipt against evidence
 * derived RIGHT NOW plus receiptProvenance() against the PIN. Two honesty notes, both kept rather
 * than quietly dropped: (1) it is NOT literally read-only against the REPOSITORY — deriving the
 * current tree walks the worktree and writes unreferenced loose objects into the ODB
 * (kernel/git.mjs header F(g),(h)); (2) it now READS project.json, but only BEST-EFFORT and only
 * to print an informational drift note. The VERDICT is against the PIN, so an unreadable or
 * newer-schema project.json cannot change the answer.
 * IT MUST NOT SHORT-CIRCUIT ON A TASK'S `done` STATUS: a done task whose receipt was earned under
 * a policy that has since been superseded must still be reported as such, and a `done`-means-OK
 * shortcut is exactly what would hide it. */
function verifyReceipt({ f, tasks, tier, taskId }) {
  const reGate = `legion gate run ${taskId ? `--task ${taskId}` : '--boundary'}`;
  // Fail closed on a dirty tree: uncommitted edits leave HEAD's tree hash unchanged, so a
  // receipt recorded before them would still "match" while ungated work sits in the worktree.
  const dirty = worktreeDirt(f.worktree);
  if (!dirty.clean) {
    process.stderr.write(
      `uncommitted changes in ${f.worktree} (${dirtyList(dirty.paths)}) — commit, then run \`${reGate}\`\n`,
    );
    return 1;
  }
  const pinnedHash = f.commandPolicyHash?.[tier];
  // The pinned command LIST travels with the pinned hash: provenance verifies the
  // receipt's results[] against it, so both halves of the pin reach the one verifier.
  const pinnedTriples = f.commandPolicy?.[tier];
  // BEST-EFFORT and INFORMATIONAL ONLY (see item 4 above). A live policy that has drifted is
  // worth telling the operator about, and is never a reason to change the verdict.
  let driftNote = '';
  try {
    const configPath = configPathFor(f);
    const liveHash = commandPolicyHash(validateGatesConfig(readProjectConfig(configPath).gates, configPath), tier);
    if (pinnedHash !== undefined && liveHash !== pinnedHash) {
      driftNote = `note: the live ${tier} gate policy in ${configPath} differs from the pin — ` +
        `\`${reGate} --repin\` adopts it deliberately (this note changed nothing above)\n`;
    }
  } catch { driftNote = ''; } // unreadable/newer-schema project.json: no note, same verdict

  let receipt;
  let subject;
  if (taskId) {
    const task = tasks.tasks.find((x) => x.id === taskId);
    if (!task) {
      process.stderr.write(`unknown task '${taskId}' — not in tasks.json; run \`${reGate}\` after importing the plan\n`);
      return 1;
    }
    receipt = task.receipt ?? null;
    subject = `task ${taskId}`;
  } else {
    receipt = tasks.receipts?.boundary ?? null;
    subject = 'boundary';
  }

  // PROVENANCE FIRST, then the tree. A forged receipt whose treeHash happens to equal the current
  // tree is a known bypass; refusing it on the TREE would be refusing it for the wrong reason, and
  // an operator told "stale" would re-gate and never learn that a receipt had been hand-written.
  const prov = receiptProvenance(receipt, { tier, pinnedHash, pinnedTriples });
  if (!prov.ok) {
    process.stderr.write(
      `no PROVENANCED ${subject} receipt: ${prov.why}.\n` +
      `A receipt is not evidence unless \`legion gate\` minted it — run \`${reGate}\`\n${driftNote}`,
    );
    return 1;
  }
  const weak = receipt.declaredCommands === 0
    ? ' — TIER-0 ONLY: 0 declared commands, a real but WEAK certificate'
    : '';
  const repinned = receipt.repinnedFrom ? `, RE-PINNED from ${receipt.repinnedFrom}` : '';
  if (taskId) {
    const tree = git(['rev-parse', 'HEAD^{tree}'], f.worktree);
    if (receipt.treeHash === tree) {
      process.stdout.write(
        `receipt OK for task ${taskId} (tree ${tree}, ${receipt.declaredCommands} declared task ` +
        `command(s)${weak}${repinned})\n${driftNote}`,
      );
      return 0;
    }
    process.stderr.write(
      `no valid receipt for task ${taskId} (receipt tree ${receipt.treeHash}, current tree ${tree}) — run \`${reGate}\`\n${driftNote}`,
    );
    return 1;
  }
  const head = git(['rev-parse', 'HEAD'], f.worktree);
  if (receipt.head === head) {
    process.stdout.write(
      `boundary receipt OK (HEAD ${head}, ${receipt.declaredCommands} declared boundary ` +
      `command(s)${weak}${repinned})\n${driftNote}`,
    );
    return 0;
  }
  process.stderr.write(
    `no valid boundary receipt (receipt HEAD ${receipt.head}, current HEAD ${head}) — run \`${reGate}\`\n${driftNote}`,
  );
  return 1;
}

export async function run(argv) {
  // argv UNSPLIT: parseArgs binds `--task=T1` inline itself (mirrors state.mjs).
  const { flags, positional } = parseArgs(argv, { bools: ['boundary', 'allow-config', 'repin'] });
  const sub = positional[0];
  if (positional.length !== 1 || (sub !== 'run' && sub !== 'verify-receipt')) {
    throw new Error(`unknown or malformed subcommand '${positional.join(' ')}'. usage:\n${USAGE}`);
  }
  // --repin MOVES THE PIN and is meaningless where nothing is recorded; verify-receipt writes no
  // state, so accepting it there would be advertising a re-pin that never happened.
  if (flags.repin === true && sub !== 'run') {
    throw new Error(`--repin is only valid on \`legion gate run\` (it records a new pin). usage:\n${USAGE}`);
  }
  const wantTask = flags.task != null;
  const wantBoundary = flags.boundary === true;
  if (wantTask === wantBoundary) {
    throw new Error(`gate ${sub} requires EXACTLY one of --task <id> | --boundary. usage:\n${USAGE}`);
  }
  const taskId = wantTask ? safeSegment(flags.task, 'task id') : null;
  const tier = taskId ? 'task' : 'boundary';

  const now = flags.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error(`invalid --now '${flags.now}' — must be a parseable timestamp`);

  const dossier = resolveDossier(flags);
  const f = readManifest(join(dossier, 'feature.json'), 'legion feature start');
  if (!existsSync(f.worktree)) {
    throw new Error(`worktree ${f.worktree} for feature ${f.featureId} does not exist — re-create the feature or \`legion feature abandon\` it`);
  }
  // Both subcommands need tasks.json: run RECORDS into it, verify-receipt READS from it.
  const tasks = readManifest(join(dossier, 'tasks.json'), 'legion state init');

  if (sub === 'verify-receipt') return verifyReceipt({ f, tasks, tier, taskId });
  return gateRun({
    dossier, f, tasks, tier, taskId, now,
    allowConfig: flags['allow-config'] === true,
    repin: flags.repin === true,
  });
}
