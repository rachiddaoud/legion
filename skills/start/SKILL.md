---
name: start
description: Start a NEW legion feature from inside this session — a brief naming interview, then the one-shot deterministic `legion feature start` (onboarding an unregistered repository with `legion project init` first, when that is what it refuses on), then THIS session continues as the feature session with no hand-off. Use when the user runs /legion:start, or asks to start, create or open a new legion feature from the session they are already in, including in a repository legion does not know yet.
argument-hint: [one line describing the feature]
allowed-tools: [Bash, Read, Glob, Grep, AskUserQuestion, Skill]
---

<!-- Skill format validated against Claude Code 2.1.219/2.1.220: a plugin skill lives at
     skills/<name>/SKILL.md and is invoked as /<plugin>:<name>, i.e. /legion:start. plugin.json
     declares no `skills` path, because declaring one DISABLES the default folder — so this file
     is discovered by being here, and adding a `skills` field to ship it would unship the other.
     NO Edit/Write/Agent/Workflow in allowed-tools, deliberately: everything this skill does is a
     question, a read, or one CLI call, and the lifecycle work belongs to /legion:feature, whose
     own frontmatter grants the tools it needs. If a future build turns out to carry this list
     THROUGH the hand-over and the feature skill then cannot write, that is not a reason to widen
     this list — it is the moment to fall back to the printed launch command (step 6). -->

# /legion:start

You are standing in a **main repository root** and the user wants a feature that does not exist
yet. You will name it, let the deterministic CLI create it, and then **become its feature
session** — one session, no hand-off.

## Rule 0 — the CLI creates infrastructure; you only NAME it and INVOKE it

This skill is a **naming-and-invocation wrapper, never a second creation path**: the dossier,
the worktree, the branch, the pinned base SHA and the pinned gate
policy are created by **one** deterministic command, and nothing else may create them.

So, absolutely: **never write a manifest**, never create a dossier directory, never `git worktree
add`, never create the `feat/<name>` branch, never seed `tasks.json` with an editor. You have no
Write or Edit tool here and that is the design, not an oversight.

And when the CLI refuses: **read the refusal out to the user and fix the cause.** Do not
improvise around it, do not retry with different arguments hunting for one it accepts, do not
build by hand the thing it declined to build. A refusal here is the design working — the same
rule the feature skill states, applying to the one command this skill runs. Fixing the cause is
sometimes running *another* deterministic command — `legion project init` for an unregistered
repository (step 3a) — and that is inside this rule, not an exception to it: what Rule 0 forbids
is a second **creation** path, never a second CLI call.

## Precondition — the MAIN REPO ROOT of a registered project

Check `pwd` and the git toplevel **before** anything else. The write-path lifecycle commands
(`legion feature start`, `legion feature abandon`, `legion feature clean`) resolve by the checkout
you stand in and therefore **refuse from inside a worktree, by design**: a new worktree must be
created off the main repository, never off another feature's checkout.

If `legion feature start` refuses because the repository is unregistered — it says either
**`is not a registered project`** or **`no project index at`**, and step 3a tells the two apart —
check your cwd **first**, before you check the registration: the commonest cause is standing in
some other feature's worktree under the worktree root, not a missing project.

Only when the cwd is genuinely the main repo root and the repository is genuinely unregistered is
`legion project init` the answer — and then **you run it yourself and carry on** (step 3a). A
brand-new repository is the ordinary case for this skill, not an exception to it, and making the
user break off to type one deterministic command they were always going to type is friction, not
safety. Rule 0 is untouched by that: `project init` **is** the deterministic CLI, it is the exact
command the refusal names, and onboarding through it is not a second creation path.

**Never run `legion project init` on a worktree path to make the message go away**: that rewrites
the real project entry onto the worktree and breaks every feature of that project. The cwd check
above is what stands between the two cases, so it is not optional and it comes first.

## Step 1 — the brief interview. This is NOT intake

Ask only what you need to **name the feature and pick its base branch**. Two or three questions,
one round of `AskUserQuestion`. You are not eliciting requirements here: the real interview,
the repository read, the recap and the intake approval all happen in the feature lifecycle, in a
dossier that does not exist yet, and duplicating them now means the user answers everything twice
and the approved `intent.md` binds to the second answer.

What you actually need:

- **What is it, in one line** — enough to name it.
- **Which branch it builds on** — propose the repository's integration branch (read it, e.g.
  `git symbolic-ref --short refs/remotes/origin/HEAD | sed 's|^origin/||'`), never guess silently.
  **Strip the remote prefix**: the value is `main`, never `origin/main`. `feature start` accepts
  either — it only resolves the base to a commit — and then pins verbatim into the manifest what
  you handed it; but that pinned string is also the **target branch** of the merge request
  `legion finalize` opens, and `origin/main` is not a branch that exists on the server. A remote-
  prefixed base is therefore not a typo you fix later: the feature specs, builds, gates and passes
  review, and only finalize refuses, with abandon-and-start-again the only way out.
- **The ticket, if there is one** — the issue reference this work tracks (`123`, `#123` or
  `group/project#123`). Ask once, accept "none" and move on **silently**: most features have no
  ticket, legion never derives one, and one that surfaces later is recorded in the lifecycle with
  `legion state ticket-record <ref>`.
- **Any additional repositories** the work touches, only if the user volunteers them (step 3).

## Step 2 — derive a kernel-safe name, then CONFIRM name and base explicitly

The feature name becomes a **filesystem path segment** (the dossier directory), a **git branch**
(`feat/<name>`), and the identity every later command resolves by. The kernel enforces the shape
with the same path-segment rule `legion plan check` applies to task ids:

```
^[A-Za-z0-9_][A-Za-z0-9._-]*$
```

First character a letter, digit or underscore; after that letters, digits, dot, dash, underscore.
**No slashes, no spaces, no leading dot** — which is what keeps `..` and `../x` out of every
derived path. House guidance on top of the rule: **lowercase-kebab**, descriptive of the change
and not of the ticket, two to four words, no dates, no `feat-` prefix (the branch adds one).

Derive a candidate, then **confirm the name AND the base with the user explicitly before you
create anything** — a rename afterwards is not an edit, it is an abandon plus a fresh start,
because the name is baked into the dossier path, the branch and the manifest.

## Step 3 — the one-shot

One command, run from the main repo root, with the confirmed values:

```
legion feature start <name> --base <branch>
```

Add one `--add-repo <path>` **per additional repository** the user named, pointing at each one's
main repository root. Those become the manifest's `intakeRepos`, and the intake stage reads
**every** one of them and writes a per-repo spec draft. **Their reachability is yours to arrange:**
an ordinarily launched session receives one `--add-dir` per attached repository from the launch
command, and no launch happens here — so this session holds them in the manifest and not in its
allowed directories until step 4(d) fixes that. **Initiative starts are live**: add
`--initiative <id>` when this feature is one repo's half of a cross-repo initiative, and see the
`/legion:feature` intake stage for the mechanics (who hosts the contract, who starts the
siblings). The **attended proving run is deferred and the layer ships dark** — do not manufacture
a cross-repo initiative to try it.

Add `--ticket <ref>` when the user gave one at step 1, **verbatim as they said it** — it is
operator data the kernel stores and never derives, so pass it through and never reconstruct one
from the name or the branch. No ticket means no flag: omitted, everything downstream behaves
exactly as it always has. It cannot be combined with `--repair` (the command says so and names
`legion state ticket-record <ref>` as the way to land one on an already-created feature).

Read the command's output rather than assuming it: it prints the feature id, the base branch and
the **base SHA** it pinned, the **worktree** path and branch, the **dossier** path, any attached
repositories, the pinned gate policy — including a loud warning when a tier has **no** declared
gate commands, which the user needs to see — and finally the launch command. If it reports
`initialization_failed`, bootstrap failed: report exactly what it said and let the user choose
between `legion feature start <name> --base <branch> --repair` and `legion feature abandon <name>`.
Do not "finish" a failed bootstrap by hand.

## Step 3a — the unregistered repository: onboard it and re-run, once

There are **two** unregistered-repository refusals, and both land here:

- **`is not a registered project`** — the index exists and holds no entry for this repository. The
  refusal names its own remedy, `--root` and all, resolved to the main root.
- **`no project index at`** … — there is no index at all, i.e. this is the **first** project on
  this machine. That one names a **bare** init, because at that point there is no resolution to
  report a root from. Do not copy it literally: supply `--root` yourself, from the check below.

Anything else is not this step. And only after the cwd check in the precondition has confirmed you
are standing in the main repo root:

```
git rev-parse --show-toplevel
git worktree list
```

The first line of `git worktree list` is the **main** repo root. If it is not the toplevel you just
printed, you are inside a linked worktree — say so and stop; registering that path is the
destructive mistake the precondition names, and no amount of it being convenient makes it not that.

When the two agree, run the remedy against **that** root, `--root` always explicit:

```
legion project init --root <main repo root>
```

then re-run the step 3 one-shot **unchanged** — same name, same base, same flags. That is a retry
of a fixed cause, not a hunt for arguments the CLI accepts, and it is the only retry this skill
has. `feature start` resolves the project before it writes anything, so the refused first attempt
left no dossier, no branch and no worktree behind.

Two things to say out loud rather than paper over:

- **A repository onboarded this way has an EMPTY gate policy.** `project init` scaffolds `gates`
  to `{}`, so the one-shot's warning about a tier with no declared gate commands is not noise —
  it is the accurate description of this project until the operator declares gates
  (`legion project init --gates <path.json>`, whose file shape the README documents). Report the
  warning verbatim; do not reassure past it. Registration also pins `protectedBranches` to the
  derived default branch and installs the `pre-push` guard — read those lines out too.
- **`project init` is the answer to exactly one refusal.** Not a git repository at all, a
  repository with no commits, a base branch that resolves to no commit, a name already taken,
  `initialization_failed` — none of those are fixed by registering a project. Read them out and
  stop; each is the user's call, and `git init` in particular is a repository-shaping decision
  this skill does not make.

If the second attempt refuses too, **stop there.** Report both refusals and let the user decide.

## Step 4 — become the feature session: do the three things the launch would have done

A normally launched feature session starts **inside the worktree**, and the `SessionStart` hook
resolves that cwd against the project index, records the session id, and injects the manifests.
None of that happened for you: at your startup this feature did not exist, and your cwd is the
main root, which that hook deliberately treats as "not a legion worktree" and exits silently on.
So do its work yourself, in this order.

**(a) Record this session, explicitly.** From the worktree, with **this session's own id**:

```
cd <worktree> && legion state session-record --session-id <id>
```

The id is in the Bash environment as `$CLAUDE_CODE_SESSION_ID` (present in the 2.1.219/2.1.220
builds; re-verify after a Claude Code upgrade). If it is empty, **do not invent one and do not
substitute a transcript filename or a timestamp** — say so and move on: session history is
bookkeeping and nothing in the kernel gates on it, whereas a fabricated id is a false record.
This op needs only `feature.json`, so it works before `legion state init` — which is why it comes
first, while you are still thinking about it.

**(b) Read the manifests yourself.** There is no injected stage block in your context and there
will not be one until this session restarts. Open `feature.json` and `tasks.json` from the dossier
with Read. `legion feature status <name>` is the convenient cross-check and works from **any**
checkout of the repository, this main root included, because it is read-only; it reprints the
worktree and dossier paths whenever you need them again.

**(c) Adopt the cwd discipline, permanently.** You are standing in the main root; the kernel
resolves which feature you mean **from the worktree**. So every kernel op from here to the end of
this feature runs as:

```
cd <worktree> && legion state init
```

— the `cd` on every single call, for `legion state`, `legion plan check`, `legion gate` and
`legion finalize` alike. `legion feature status` is the only one that does not need it. Forget the
`cd` once and the command refuses (unresolved cwd, fail-closed) — which is the good outcome; the
bad one is running it in a directory that resolves to some **other** feature.

**(d) Make the paths reachable.** Name the worktree, the dossier and every attached repository
**absolutely**, exactly as `feature start` printed them, in every command and every tool call. If a
Read or a Bash call is refused for being outside this session's allowed directories, that is a
directory-access refusal and not a kernel refusal: tell the user to `/add-dir <worktree>`,
`/add-dir <dossier>` and one `/add-dir` **per attached repository**, and wait. Never work around it
by copying dossier files into the main checkout.

Ask for the attached repositories **before intake reads them**, not when a read fails: a
directory-access refusal is at least loud, but the likelier failure is quiet — intake sees one
repository, writes one spec draft, and the plan is approved without the per-repo drafts the
attached repositories were declared for.

## Step 5 — enter the lifecycle

Hand over to the feature skill in this same session — invoke **`/legion:feature`** with the
Skill tool and follow **its** stage table from the top. The feature is at stage `intake`, and its
intake **step 0** is the first thing you owe it: `legion state init`, before any other op, because
`legion feature start` writes only `feature.json` and every recording op refuses until
`tasks.json` exists. Everything after that — the interview, the profile classification, the
repository read, the recap and the approval — is that skill's, under its rules, with the `cd
<worktree> &&` prefix from step 4(c) on every op.

Your job ends there. Do not re-interview, do not pre-classify the profile, and do not start
writing `intent.md` from this skill's context.

## Step 6 — the accepted residual, recorded rather than hidden

**A main-root session loses the worktree's soft isolation.** A session launched in the worktree
can only casually touch that worktree's files; you are standing in the main checkout and **can**
edit files there — files that belong to no feature, are covered by no gate, and would land in no
merge request. Nothing in the plugin layer prevents that, and this skill does not pretend
otherwise. What holds:

- **The server is the guarantee** — protected branches and the agent identity's permissions.
- **`legion finalize` remains the only remote-write path**, and the `pre-push` hook still refuses
  a hand-rolled push from either checkout.
- The **PreToolUse guard now scopes by the command's TARGET repository** rather than by the
  session's launch cwd, which is precisely what keeps the plugin-layer deny alive for this session
  shape — before that widening a main-root session got no deny at all.
- **You** keep the discipline the isolation used to keep for you: edits belong in the worktree.

None of this is new safety, and it is layer 3 — depth over the ordinary path, not a boundary.
`legion doctor` is where the real boundary is verified.

**Resumes are unaffected.** This skill is for the moment a feature is *created*. Later sessions
resume the ordinary way, from the launch command `feature start` printed —
`cd <worktree> && claude --add-dir <dossier> "/legion:feature resume <id>"` — where the cwd is the
worktree, the `SessionStart` hook fires, records the session and injects the stage, and none of
step 4 applies.

## When something is wrong

- **The CLI refused.** Read it out to the user and fix the cause. Never hand-build what it
  declined to build, and never edit a manifest. The **one** cause you fix without asking is an
  unregistered repository (step 3a) — one `legion project init --root <main repo root>`, one
  re-run, and then you are back under this rule.
- **You are not in the main repo root.** Say so and stop. Do not `cd` around looking for a
  directory the command accepts.
- **A feature of that name already exists.** Stop and ask. Reusing a name is not a merge, and
  `legion feature status <name>` will tell you what state the existing one is in.
- **Environment doubt** — hooks not firing, `glab` unauthenticated, branch protection unverified:
  `legion doctor`, and report what it says rather than proceeding past it.
