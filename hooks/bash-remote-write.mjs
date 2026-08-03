#!/usr/bin/env node
// bash-remote-write.mjs — THE PreToolUse GUARD OVER THE Bash TOOL (PLAN-V3 §Remote safety
// layer 3, the plugin half). Claude Code runs it before every Bash tool call in a session that
// has this plugin loaded; hooks/hooks.json's PreToolUse entry is what dispatches it.
//
// WHAT IT IS, AND THE SENTENCE THAT GOVERNS EVERY MESSAGE BELOW. Layer 1 (GitLab protected
// branches + the agent identity's permissions) is the hard boundary and the ONLY guarantee;
// layer 2 is `legion finalize`, the intended path; this is layer 3, DEPTH. In src/cli/finalize.mjs's
// words: "it can refuse a push the server would have accepted, it can never make a push the
// server accepts safe." So this file BLOCKS THE ORDINARY PATH — the `git push` or
// `glab mr create` an erring or over-helpful agent TYPES after finalize refused. It PREVENTS
// nothing, and the list of ways past it is short and obvious:
//   - `bash -c 'git push'`, `$(echo git) push`, a one-line shell script, an alias, a base64 blob
//     decoded into `sh`: this is a TOKEN SCAN, not a shell parser (decision B), so all of them
//     read as ordinary commands;
//   - any tool that is not Bash. A push through an MCP server, a library, or the model's own
//     file-writing of a git hook is not a Bash call and this hook never sees it;
//   - the operator, who can disable hooks outright.
// Every one of those is documented depth, not a defect. THE SERVER refuses what it refuses, and
// `legion doctor`'s branch-protection check is where that is verified. hooks/pre-push.mjs is the
// SECOND net under this one — it catches the push this scan missed, as long as git runs hooks.
//
// THE CONTRACT, VALIDATED AGAINST CLAUDE CODE 2.1.219 (binary at
// ~/.local/share/claude/versions/2.1.219), read out of that build rather than out of docs — the
// same standard hooks/_common.mjs and hooks/hooks.json set for the other three events:
//   - MATCHER FIELD. The dispatcher's event->field switch reads `tool_name` for PreToolUse
//     (`case"PreToolUse":case"PostToolUse":…a=n.tool_name;break;`), and a matcher of
//     ^[a-zA-Z0-9_|]+$ is compared as an EXACT STRING. hooks.json therefore matches `Bash`.
//   - STDIN PAYLOAD. The build's own zod schema is
//     `{hook_event_name:"PreToolUse", tool_name:string, tool_input:unknown, tool_use_id:string}`
//     on top of the common fields (session_id, transcript_path, cwd, permission_mode, agent_id,
//     agent_type). `tool_input` is UNKNOWN in the schema — for the Bash tool it carries
//     `{command, description, …}`, which is why `tool_input.command` is read defensively below.
//     `cwd` is Claude Code's OWN process cwd (`cwd:xt()` in the payload builder), i.e. the
//     directory the session was launched in — NOT the Bash tool's shell cwd. A `cd` inside a
//     Bash call therefore does not move it, and THAT is precisely why decision C parses the
//     command's own `cd`/`-C`: the payload's cwd answers "where was this session launched",
//     never "which repository is this command about".
//   - THE DENY MECHANISM. BOTH forms this build honours are used, deliberately (decision E):
//     * exit code 2 with the message on stderr. The build's own event help says "Exit code 2 -
//       show stderr to model and block tool call", and the runner turns it into
//       `blockingError` -> `{behavior:"deny"}` for PreToolUse. The "hook script appears to be
//       missing" softening of exit 2 into a non-blocking error is scoped to
//       Stop/SubagentStop/TaskCompleted/TeammateIdle/UserPromptSubmit — PreToolUse is NOT in
//       that list, so exit 2 here is always a block;
//     * `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny",
//       "permissionDecisionReason":"…"}}` on stdout, which the same build maps to
//       `{behavior:"deny", message:<reason>}`. `hookEventName` is REQUIRED and is checked
//       against the fired event ("Hook returned incorrect event name: expected 'X' but got
//       'Y'"), and `decision:"block"` is DEPRECATED for PreToolUse in this build — hence this
//       shape and not that one.
//     The two compose rather than conflict: the runner parses stdout first and then, on status
//     2, sets blockingError anyway, so a JSON schema drift still denies via the exit code and a
//     changed exit-code meaning still denies via the JSON. It also tolerates an unparseable
//     stdout when the status is 2 (`if(ve&&Ce.status!==2)`), so belt-and-braces costs nothing.
//   - ALLOW IS SILENCE: exit 0 prints nothing anywhere ("Exit code 0 - stdout/stderr not
//     shown"), which is what a guard that fires on EVERY Bash call must do.
//
// FIVE DECISIONS, each with the failure it avoids:
//
// A. THE ONE DELIBERATE FAIL-OPEN IN LEGION, and it is stated here rather than discovered.
//    Everywhere else the house rule is fail-closed: "cannot answer" ⇒ refuse. Here an
//    unparseable payload, a missing `tool_name`, or a `tool_input` without a string `command`
//    ⇒ ALLOW, silently. The reason is the failure mode, not squeamishness: this hook gates the
//    Bash tool ITSELF, so a guard that refuses whenever the payload surprises it does not
//    degrade — it bricks every Bash call in every session on this machine until a human finds
//    it, and a Claude Code schema change is a thing that happens on upgrade. The cost of the
//    fail-open is bounded and covered twice over: layer 3 is DEPTH, hooks/pre-push.mjs still
//    fires on the push itself, and the server still refuses. That trade is only sound BECAUSE
//    this layer is not the guarantee — do not copy this direction into anything that is.
//
// B. A CONSERVATIVE TOKEN SCAN, NOT A SHELL PARSER. The command is split at shell control
//    operators into SEGMENTS, quotes are STRIPPED rather than interpreted, and each segment's
//    whitespace tokens are compared by BASENAME. Both failure directions are accepted openly:
//      - FALSE POSITIVES ARE FINE. `echo "git push"` and `git log --grep push` are denied. The
//        cost is one rephrase by an agent that was not pushing anyway; the cost of the opposite
//        mistake is a published branch nobody gated;
//      - FALSE NEGATIVES ARE INEVITABLE. Anything that hides the tokens — `bash -c`, a script,
//        `$(printf %s git) push`, base64 — walks through. A shell parser would narrow the gap
//        and would still not close it, so the complexity buys a better-looking guard rather
//        than a safer one. The server backstops; that is the whole design.
//    `git push --dry-run` IS DENIED, deliberately: it is a raw remote-write invocation shaped
//    exactly like the one this exists to stop, and teaching the scan to read git's flag grammar
//    is the cleverness decision B rejects. The refusal names it as blocked, not as dangerous.
//
// C. SCOPED TO THE REPOSITORY THE COMMAND TARGETS — widened from launch-cwd scoping by T29, and
//    the widening is the point rather than a refinement.
//    WHY THE OLD RULE DIED. T26 scoped by asking "is the SESSION'S LAUNCH CWD a registered legion
//    feature worktree" (a deviation from T26's own spec, reported and then adjudicated). PLAN-V3
//    §Startup's S-007 amendment made that rule wrong: a feature session may now be STARTED from
//    the main repository root by `/legion:start` and CONTINUE as the feature session — one session,
//    no hand-off. Claude Code freezes the payload's `cwd` at launch, so that session's launch cwd
//    is the main checkout forever, and the old rule handed it NO plugin-layer deny at all: exactly
//    the session most likely to type a raw `git push`. §Startup schedules this widening as the
//    PREREQUISITE of the one-session flow, and PLAN-V3 §Remote safety names it the ONE sanctioned
//    exception to layer 3 being closed as landed. It is not extra depth; it is the same depth,
//    aimed at the repository instead of at a directory.
//    THE NEW RULE. The scan (decision B) is unchanged and still runs FIRST. When it matches, the
//    guard resolves WHICH REPOSITORY the command is about:
//      1. an EXPLICIT PATH wins — the `-C <path>` value(s) of the matching git segment, else the
//         last `cd <path>` in a segment BEFORE the matching one. `-C` beats `cd` because it applies
//         to the git invocation itself; relative values fold against the payload cwd, in order,
//         which is git's own `-C` semantics;
//      2. else the payload cwd (see THE CONTRACT: the launch directory, which is the right answer
//         for the ordinary `git push` typed with no path at all);
//      3. that path is resolved to its MAIN WORKTREE ROOT through the hardened seam
//         (kernel/git.mjs mainWorktreeRoot — never a naive `rev-parse` under the inherited GIT_*
//         environment, never _common.mjs's chdir-based resolveFeature, which answers the different
//         question "which feature is this cwd") and matched against the registered projects'
//         repoRoot values by kernel/projectindex.mjs — the SAME match hooks/pre-push.mjs performs,
//         imported rather than copied so the two guards cannot disagree about what is registered.
//    THE DECISION, once a repository is named:
//      - REGISTERED (the main checkout or ANY worktree of a registered repoRoot) ⇒ DENY, naming the
//        project org/name. Feature-worktree denies are SUBSUMED, not lost: a worktree's main root
//        IS the registered repoRoot, so every T26 deny is still a deny;
//      - NOT REGISTERED ⇒ ALLOW, silently. The operator's own repositories are none of legion's
//        business, and a guard that taxes every unrelated push is a guard that gets uninstalled;
//      - NO REPOSITORY THERE AT ALL (git itself answers "not a git repository") ⇒ ALLOW. That is an
//        ANSWER, not an unknown: every registered project is a repository, so a path in none
//        cannot be one. (Contrast hooks/pre-push.mjs, which BLOCKS the same failure — git invoked
//        IT from inside a repository, so there the failure is anomalous rather than ordinary.)
//      - UNRESOLVABLE AFTER A MATCH ⇒ DENY, naming the cause. A `cd "$DIR"` a token scan cannot
//        evaluate, a `-C` path that does not exist, `glab -R/--repo` naming a project by SLUG
//        rather than by path, a payload with no usable `cwd`, git failing for any reason other
//        than "not a repository". The scan already matched, so this is not decision A's fail-open:
//        the question is no longer "is anything wrong" but "is this the one place we may not
//        allow", and unknown ⇒ refuse;
//      - projects.json ABSENT ⇒ ALLOW (nothing is registered anywhere); PRESENT but unreadable or
//        malformed, or the root registered as more than one project ⇒ DENY naming the file. Same
//        absent-vs-corrupt line hooks/_common.mjs and hooks/pre-push.mjs draw.
//    THE SCOPE RESOLUTION IS THE SAME TOKEN SCAN, with the same honest limits: `pushd`, a shell
//    function, `--git-dir=`/`--work-tree=`, `GIT_DIR=… git push` and anything else that moves the
//    target without a `cd` or a `-C` all fall back to the payload cwd, so they can decide WRONG in
//    either direction. Teaching this file git's full flag grammar is the cleverness decision B
//    rejects; hooks/pre-push.mjs (keyed on the pushed ref, from any checkout) and the server are
//    what stand behind the miss.
//    THE NEW RESIDUAL, STATED RATHER THAN HIDDEN, because it is the cost the operator accepted and
//    the next maintainer must know it was CHOSEN. Every Claude Code session on this machine now
//    gets this deny for a raw remote write that targets a REGISTERED repository — including the
//    operator's own daily-driver session standing in one, with no legion feature anywhere in sight.
//    That is deliberately COARSER than hooks/pre-push.mjs's rule 4, which still lets an unrelated
//    branch push out of a managed repository: pre-push is handed the actual refs, and a token scan
//    cannot see refs, so "which branch" is a question this layer is structurally unable to ask.
//    The remedy is not a narrower guard, it is the sanctioned route: inside legion's scope a branch
//    leaves through `legion finalize`; outside it, a push belongs in a terminal rather than in a
//    Claude Code Bash call. If that trade ever stops being acceptable, the honest fix is to drop
//    this hook, not to teach the scan a ref grammar it cannot have.
//    COST: on the matched path, ONE git subprocess (`worktree list`) plus a handful of small JSON
//    reads. No chdir anywhere — the widened rule needs a path, not a working directory. The
//    unmatched path — every ordinary Bash call — is node startup plus one pass of regex splitting.
//
// D. THIS HOOK NEVER WRITES ANYWHERE — no remote, no manifest, no dossier, no state op. It reads
//    a payload, reads the project index, and prints a decision. PLAN-V3 §Remote safety: `legion
//    finalize` is the only remote-write path, and a guard layer that itself acquired one would
//    be the worst defect available in this chunk.
//
// E. `legion finalize` IS NEVER MATCHED, and needs no exception. At this layer it is not a git
//    or glab invocation — it is `legion`, and the scan only knows `git` and `glab` tokens. The
//    real `git push` finalize performs happens INSIDE that process, not as a Bash tool call, so
//    it never reaches this hook at all; hooks/pre-push.mjs is where finalize's own push needs
//    the LEGION_FINALIZE_PUSH marker, and nothing analogous is needed here.
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { readHookInput } from './_common.mjs';
import { mainWorktreeRoot } from '../src/kernel/git.mjs';
import { matchProjectByRepoRoot, realish } from '../src/kernel/projectindex.mjs';

/** Who is speaking. A CONSTANT rather than inline, for the reason hooks/pre-push.mjs states:
 * test/plugin-manifest.test.mjs reads every backtick-delimited legion invocation in a shipped
 * component as a router command, and a template literal that OPENED with this prefix would be
 * read as an invocation of a command that does not exist. Interpolating keeps the prose identical
 * and the span un-invocation-shaped. */
const SPEAKER = 'legion PreToolUse guard';

/** The honest limit, appended to EVERY refusal. A refusal that states only the rule teaches an
 * agent to work around it; one that states the bypass AND names the real boundary teaches it to
 * go through the sanctioned path instead. */
const DEPTH =
  'DEFENSE IN DEPTH, never the guarantee: this is a conservative token scan over the Bash tool '
  + 'only, so it blocks the ordinary path and nothing more — a subshell, a script, an alias or an '
  + 'encoded string walks straight past it. The GitLab server is the boundary that actually '
  + 'refuses a write to a protected branch, and `legion doctor` is what verifies that it does.';

/** WHY the sanctioned path is the sanctioned path — one text per kind of remote write, because
 * an agent that reads the push refusal must not infer that the MR refusal is a different rule
 * with a different remedy. */
const WHY = {
  push:
    'A feature branch leaves this machine through `legion finalize` and nothing else: it verifies '
    + 'the gate receipt, the approvals and the reviews against THIS commit, opens the merge request '
    + 'against the pinned base and records what the server returned. A raw push publishes the '
    + 'branch with none of that recorded. If finalize refused, its refusal named what is missing — '
    + 'fix that, do not push around it.',
  mr:
    'legion opens the merge request from `legion finalize` and from nowhere else — the one command '
    + 'that checks the whole evidence chain first, targets the base pinned at feature start, and '
    + 'reads the created merge request back into the dossier. An MR opened by hand is an MR no '
    + 'record describes.',
};

/** The refusal for "the scan matched, and WHICH REPOSITORY the command targets could not be
 * determined". `cause` is always concrete — a refusal that says only "could not decide" is one
 * nobody can act on. */
const undecided = (cause) =>
  'The scan matched a raw remote-write command and which repository it targets could not be '
  + `determined (${cause}), so the guard did not allow — past the match, unknown means refuse. `
  + 'The sanctioned path for any remote write remains `legion finalize`.';

/** DENY, on BOTH mechanisms this build honours (header, THE DENY MECHANISM). One line: the
 * message is read by a model in a transcript, and a wrapped block reads as several findings. */
function deny(what, why) {
  const reason = `${SPEAKER}: BLOCKED ${what}. ${why} ${DEPTH}`;
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })}\n`);
  process.stderr.write(`${reason}\n`);
  process.exit(2);
}

/** ALLOW: exit 0, print nothing at all (header: allow is silence). */
const allow = () => process.exit(0);

// --- the scan ---------------------------------------------------------------------------------

/** The command split into SEGMENTS at shell control operators. Quotes and backslash-newlines are
 * removed rather than interpreted — that is decision B, and it is what makes `echo "git push"` a
 * false positive and `bash -c 'git push'` a false negative. Both are accepted. */
function segments(command) {
  return command
    .replace(/\\\r?\n/g, ' ')
    .replace(/['"]/g, ' ')
    .split(/&&|\|\||[;&|\n(){}`<>]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** A segment's whitespace tokens, RAW — paths intact, because decision C's scope resolution reads
 * `-C <path>` and `cd <path>` values out of exactly these positions. */
const rawTokens = (seg) => seg.split(/\s+/).filter(Boolean);

/** The same tokens reduced to their BASENAME so `/usr/bin/git push` and `git push` read alike,
 * INDEX-ALIGNED with the raw list (detection reads these, path extraction reads those). Splitting
 * on '/' is not path resolution and is not meant to be; it is the cheapest thing that keeps an
 * absolute path from hiding the program name. */
const basenames = (raw) => raw.map((t) => t.split('/').pop());

/** `{what, why, kind, at, raw}` for the first raw remote-write invocation in `segs`, or null —
 * `at` is the index of the matching SEGMENT and `raw` its raw tokens, both of which decision C's
 * scope resolution needs (the `-C` lives in this segment; a `cd` only counts before it).
 * ORDER WITHIN A SEGMENT IS REQUIRED — `push` must come after `git`, `create` after `mr` after
 * `glab` — so that `git -C /x push`, `glab -R o/p mr create` and any flag ordering match, while a
 * bare `push` (a branch called push, a script named push) does not. */
function scan(segs) {
  for (let at = 0; at < segs.length; at++) {
    const raw = rawTokens(segs[at]);
    const t = basenames(raw);

    // `git … push …` in any argv position. Deliberately not narrowed further: see decision B.
    const gi = t.indexOf('git');
    if (gi >= 0 && t.indexOf('push', gi + 1) > gi) {
      return { what: 'a raw `git push`', why: WHY.push, kind: 'git', at, raw };
    }

    const li = t.indexOf('glab');
    if (li < 0) continue;

    // `glab … mr create|merge …` — the two glab verbs that write a merge request.
    const mi = t.indexOf('mr', li + 1);
    if (mi > li) {
      for (const verb of ['create', 'merge']) {
        if (t.indexOf(verb, mi + 1) > mi) {
          return { what: `\`glab mr ${verb}\``, why: WHY.mr, kind: 'glab', at, raw };
        }
      }
    }

    // `glab api -X POST …/merge_requests…` — the same write one layer down. TRIVIAL detection
    // only (a POST/PUT token, an api token, a merge_requests path token, in one segment); a real
    // model of glab's api surface is the gold-plating T26 declines.
    const ai = t.indexOf('api', li + 1);
    if (ai > li
      && t.some((x) => x.includes('merge_requests'))
      && t.some((x) => /^(POST|PUT)$/i.test(x))) {
      return { what: 'a `glab api` write to a merge_requests path', why: WHY.mr, kind: 'glab', at, raw };
    }
  }
  return null;
}

// --- the scope: WHICH REPOSITORY does the matched command target (decision C) ------------------

/** A path token this token scan CANNOT evaluate. Quotes are already stripped (decision B), so a
 * `cd "$DIR"` arrives here as the literal `$DIR`: an unexpanded variable, a `~`, a glob, a command
 * substitution or `cd -` all name a directory only a shell knows. Past the match, unknown means
 * refuse — so these are detected and NAMED rather than resolved into a wrong answer. */
const unevaluable = (v) => v === '-' || /[$~*?[\]]/.test(v);

/** The `-C` target of the MATCHING segment, or null when it has none.
 * Every `-C` is folded in argv order, each relative value against the previous result — git's own
 * semantics (`git -C /a -C b` operates in /a/b) — starting from the payload cwd so a lone relative
 * `-C sub` means what the shell would have meant. Returns {undecided} for a value this scan cannot
 * evaluate: a `-C` we get WRONG points the whole decision at another repository. */
function dashC(hit, cwd) {
  let base = cwd;
  let seen = false;
  for (let i = 0; i < hit.raw.length - 1; i++) {
    if (hit.raw[i] !== '-C') continue;
    const v = hit.raw[i + 1];
    if (unevaluable(v)) return { undecided: `the \`-C ${v}\` in the matched command names a directory a token scan cannot evaluate` };
    base = resolve(base, v);
    seen = true;
  }
  return seen ? { path: base } : null;
}

/** The directory the shell would be in when the matching segment runs, from the `cd`s before it.
 * Folded in order from the payload cwd, exactly as a shell would: a later ABSOLUTE `cd` makes an
 * earlier unevaluable one irrelevant (`cd $X && cd /repo && git push` targets /repo), while a
 * relative `cd` after an unevaluable one leaves the destination unknown. Returns null when no `cd`
 * precedes the match at all — then the payload cwd stands. */
function afterCds(segs, hit, cwd) {
  let base = cwd;
  let bad = null;
  let seen = false;
  for (let i = 0; i < hit.at; i++) {
    const raw = rawTokens(segs[i]);
    if (raw.length === 0 || raw[0].split('/').pop() !== 'cd') continue;
    seen = true;
    // A bare `cd` means $HOME, which is a directory this scan has no business guessing at.
    const v = raw.length > 1 ? raw[1] : null;
    if (v === null) { bad = 'a bare `cd`'; base = null; continue; }
    if (unevaluable(v)) { bad = `\`cd ${v}\``; base = null; continue; }
    if (isAbsolute(v)) { base = v; bad = null; continue; }
    if (base !== null) base = resolve(base, v);
  }
  if (!seen) return null;
  if (base === null) return { undecided: `${bad} in the matched command names a directory a token scan cannot evaluate` };
  return { path: base };
}

/** Does the matched glab segment name its project by SLUG? `-R o/p` / `--repo o/p` points glab at a
 * repository that has no path on this machine at all, so no filesystem answer exists — and the
 * command still writes a merge request. Undecided ⇒ refuse (decision C). */
const glabSlug = (raw) => raw.some(
  (t) => t === '-R' || t === '--repo' || t.startsWith('--repo=') || (t.startsWith('-R') && t.length > 2),
);

// --- the decision -----------------------------------------------------------------------------

// FAIL-OPEN, and only here (decision A): a payload this hook cannot read is a payload it must not
// act on, because acting means denying every Bash call in the session.
const input = readHookInput();
if (input === null) allow();
if (input.tool_name !== 'Bash') allow();
const command = input.tool_input?.command;
if (typeof command !== 'string' || command.trim() === '') allow();

const segs = segments(command);
const hit = scan(segs);
if (hit === null) allow();

// MATCHED. From here the direction inverts (decision C): fail-CLOSED, and the scope test decides
// which repository the command is about and whether legion has any business guarding it.

// The payload cwd is the BASE for every relative path below and the target when the command names
// none, so it is required even when a `-C` is present: without it "relative to what" has no answer.
const cwd = typeof input.cwd === 'string' ? input.cwd : '';
if (!cwd) deny(hit.what, undecided('the hook payload carries no `cwd`'));
if (!existsSync(cwd)) deny(hit.what, undecided(`the hook payload's cwd ${cwd} does not exist`));

// A glab write aimed at a SLUG has no path to resolve at all — checked before the path rules,
// because `-R o/p` overrides whatever directory the command runs in.
if (hit.kind === 'glab' && glabSlug(hit.raw)) {
  deny(hit.what, undecided('it names its project with `-R`/`--repo`, i.e. by slug rather than by a path on this machine'));
}

// STEP 1/2 of decision C: an explicit `-C` beats a preceding `cd`, which beats the payload cwd.
const scoped = dashC(hit, cwd) ?? afterCds(segs, hit, cwd) ?? { path: cwd };
if (scoped.undecided) deny(hit.what, undecided(scoped.undecided));
const target = scoped.path;
if (!existsSync(target)) {
  deny(hit.what, undecided(`the directory ${target} the command targets does not exist`));
}

// STEP 3: the MAIN worktree root of whatever repository holds that path — the identity a project is
// registered under, so a linked feature worktree resolves to the same root as the main checkout
// (the subsumption decision C describes). Hardened seam only: an ambient GIT_DIR must not be able
// to answer this question (kernel/git.mjs header E).
let repoRoot;
try {
  repoRoot = realish(mainWorktreeRoot(target));
} catch (e) {
  const detail = String(e?.message ?? e);
  // git ANSWERED "there is no repository here". Every registered project is a repository, so this
  // path cannot be one ⇒ allow (decision C). Any OTHER failure is an unknown ⇒ refuse.
  if (/not a git repository/i.test(detail)) allow();
  deny(hit.what, undecided(`git could not say which repository holds ${target}: ${detail}`));
}

// THE REGISTRATION — the same match hooks/pre-push.mjs performs, from the same module.
const m = matchProjectByRepoRoot(repoRoot);
if (m.kind === 'absent') allow(); // nothing is registered anywhere on this machine
if (m.kind === 'unregistered') allow(); // answered: not a repository legion manages
if (m.kind === 'unreadable') {
  deny(hit.what, undecided(`the legion project index ${m.indexPath} is present but unreadable: ${m.detail}`));
}
if (m.kind === 'malformed') {
  deny(hit.what, undecided(`the legion project index ${m.indexPath} is present but malformed (${m.detail})`));
}
if (m.kind === 'ambiguous') {
  deny(hit.what, undecided(`${repoRoot} is registered as MORE THAN ONE legion project (${m.ids}), and a hook has no \`--org\` to disambiguate with`));
}

// THE DENY, naming the matched project and the coarseness (decision C's residual): this guard is
// scoped to the REPOSITORY, so it refuses every raw remote write aimed at a legion-managed repo and
// not only a feature branch — which is why the last clause names the route for a write that is
// none of legion's business, instead of leaving the operator to conclude the guard is broken.
deny(
  hit.what,
  `It targets ${repoRoot}, the repository registered as legion project ${m.projectId}, and this `
  + 'guard is scoped to the REPOSITORY (a token scan cannot see refs, so it cannot ask which '
  + `branch). ${hit.why} If this write is nothing to do with legion, run it from a terminal `
  + 'outside this session.',
);
