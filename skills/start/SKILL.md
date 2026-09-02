---
name: start
description: Start a NEW legion feature from inside this session — a brief naming interview, then the one-shot deterministic `legion feature start` (onboarding an unregistered repository with `legion project init` first, when that is what it refuses on), then THIS session continues as the feature session with no hand-off. Use when the user runs /legion:start, or asks to start, create or open a new legion feature from the session they are already in, including in a repository legion does not know yet.
argument-hint: [one line describing the feature]
allowed-tools: [Bash, Read, Glob, Grep, AskUserQuestion, Skill]
---
<!-- No Write/Edit/NotebookEdit/Agent in allowed-tools: the withholding is Rule 0's mechanism. -->

# /legion:start

## Rule 0 — the CLI creates infrastructure; you only NAME it and INVOKE it

This skill is a **naming-and-invocation wrapper, never a second creation path**: the dossier, the
worktree, the branch, the pinned base SHA and the pinned gate policy come from **one** deterministic
command. Never write a manifest, create a dossier, `git worktree add`, create the `feat/<name>`
branch or seed `tasks.json` — you have no Write or Edit tool, by design. When the CLI refuses, read
it out to the user and fix its cause; never improvise around it, never hunt for arguments it
accepts. Fixing a cause is sometimes another deterministic command (`legion project init`, step 3a):
what this rule forbids is a second **creation** path, never a second CLI call.

## Precondition — the MAIN REPO ROOT of a registered project

Check `pwd` and the git toplevel **first**: the write-path commands (`legion feature start`, `legion
feature abandon`, `legion feature clean`) resolve by the checkout you stand in and therefore
**refuse from inside a worktree, by design**. When the one-shot refuses the repository as
unregistered — **`is not a registered project`** or **`no project index at`**, told apart in step
3a — check your cwd first: the commonest cause is standing in another feature's worktree. **Never
run `legion project init` on a worktree path**: it rewrites the project entry onto that worktree.

## Step 1 — the brief interview. This is NOT intake

Two or three questions, one round of `AskUserQuestion`, enough to **name the feature and pick its
base branch**; the real interview, the repository read and the recap belong to the lifecycle.

- **What it is, in one line.**
- **The base branch** — the integration branch, read and not guessed (`git symbolic-ref --short
  refs/remotes/origin/HEAD | sed 's|^origin/||'`), **stripped of its remote prefix**: `main`, never
  `origin/main` — that pinned string is also the **target branch** `legion finalize` aims the MR at.
- **The ticket, if there is one** (`123`, `#123`, `group/project#123`) — asked once, taken
  **verbatim**, "none" accepted silently; one surfacing later takes `legion state ticket-record`.

## Step 2 — derive a kernel-safe name, then CONFIRM name and base explicitly

The name becomes a **path segment** (the dossier), a **git branch** (`feat/<name>`) and the identity
every later command resolves by; the kernel's shape is `^[A-Za-z0-9_][A-Za-z0-9._-]*$` — a letter,
digit or underscore first, then letters, digits, dot, dash, underscore, so no slashes, no spaces and
no leading dot. House rule on top: **lowercase-kebab**, two to four words, describing the change and
not the ticket. Derive a candidate, then **confirm the name AND the base with the user explicitly
before you create anything** — a rename afterwards is an abandon plus a fresh start.

## Step 3 — the one-shot

From the main repo root, with the confirmed values, one command:
`legion feature start <name> --base <branch>`, plus `--ticket <ref>` when the user gave one,
**verbatim as they said it** (it cannot be combined with `--repair`). Read the output: the pinned
**base SHA**, the **worktree** path and branch, the **dossier** path, the pinned gate policy —
including the loud warning when a tier has **no** declared gate commands — and the launch command.
On `initialization_failed` the bootstrap failed: report it exactly, let the user choose between the
same command with `--repair` and `legion feature abandon <name>`, and never finish it by hand.

## Step 3a — the unregistered repository: onboard it and re-run, once

Two refusals land here and nothing else does. **`is not a registered project`** — the index exists
and holds no entry for this repository; the refusal names its own remedy, `--root` and all. **`no
project index at`** — no index at all, the **first** project on this machine; that one names a
*bare* init, having no root to report from, so supply `--root` yourself.

Act only after the precondition's cwd check, and only when `git rev-parse --show-toplevel` and the
first line of `git worktree list` — the **main** repo root — agree; disagreement means you are in a
linked worktree, so say so and stop. Then `legion project init --root <main repo root>`, and re-run
the step 3 one-shot **unchanged** — the only retry this skill has; if it refuses again, stop. Say
out loud that **a repository onboarded this way has an EMPTY gate policy** (`project init` scaffolds
`gates` to `{}`, so the no-gate warning is accurate until the operator declares gates), and that
**`project init` is the answer to exactly one refusal**: not a git repository, no commits, an
unresolvable base, a taken name, `initialization_failed` — none of those.

## Step 4 — become the feature session: do what the launch would have done

A normally launched session starts **inside the worktree**, where the `SessionStart` hook records
the session id and injects the manifests. None of that happened for you; do its work yourself.

1. **Record this session** from the worktree, with **this session's own id**: `cd <worktree> &&
   legion state session-record --session-id <id>`. The id is `$CLAUDE_CODE_SESSION_ID`; if it is
   empty, **do not invent one, and never substitute a transcript filename or a timestamp**. It is
   **load-bearing**: the `SubagentStop` receipt hooks find this feature by the recorded id whenever
   the cwd they are handed is not the worktree, your main root included, so skipping it costs every
   builder and reviewer its receipt. Run it first; it needs only `feature.json`.
2. **Read the manifests yourself** — there is no injected stage block until this session restarts.
   Open `feature.json` and `tasks.json` from the dossier with Read; `legion feature status <name>`
   cross-checks read-only from any checkout and reprints the worktree and dossier paths.
3. **Adopt the cwd discipline, permanently.** The kernel resolves which feature you mean from the
   worktree, so every kernel op runs as `cd <worktree> && legion state init` — that `cd` on every
   call, for `legion state`, `legion plan check`, `legion gate` and `legion finalize` alike, with
   `legion feature status` the only exception. Forget it and the command refuses, fail-closed.
4. **Make the paths reachable.** Name the worktree and the dossier **absolutely**, as the one-shot
   printed them. A Read or Bash call refused for being outside this session's allowed directories is
   a directory-access refusal, not a kernel one: tell the user to `/add-dir <worktree>` and
   `/add-dir <dossier>`, and wait. Never copy dossier files into the main checkout instead.

## Step 5 — enter the lifecycle

Invoke **`/legion:feature`** with the Skill tool in this same session and follow **its** stage table
from the top. The feature is at stage `intake`, whose **step 0** you owe it first: before any other
op, `legion state init`, because `legion feature start` writes only `feature.json` and every
recording op refuses until `tasks.json` exists. Do not re-interview or pre-classify the profile.

## Step 6 — the accepted residual, recorded rather than hidden

**A main-root session loses the worktree's soft isolation.** You stand in the main checkout and
**can** edit files there — files no feature owns and no gate covers; nothing in the plugin layer
prevents it. What holds: the **server** is the guarantee (protected branches and the agent
identity's permissions), and **`legion finalize` remains the only remote-write path legion itself
takes** — it verifies the evidence chain and opens the merge request (GitLab, `glab`) or pull
request (GitHub, `gh`) against the pinned base. The local guards were removed 2026-08-07, so the
server refusal `legion doctor` verifies is the only barrier and the discipline is yours.

**Resumes are unaffected.** Later sessions resume from the launch command the one-shot printed —
`cd <worktree> && claude --add-dir <dossier> "/legion:feature resume <id>"` — where the
`SessionStart` hook fires and none of step 4 applies.

## When something is wrong

- **The CLI refused.** Read it out and fix the cause; never hand-build what it declined to build,
  never edit a manifest. The **one** cause you fix without asking is an unregistered repository
  (step 3a) — one `legion project init --root <main repo root>`, one re-run.
- **You are not in the main repo root.** Say so and stop; do not `cd` around hunting for one.
- **A feature of that name already exists.** Stop and ask: reusing a name is not a merge, and
  `legion feature status <name>` tells you what state the existing one is in.
- **Environment doubt** — hooks not firing, `glab` unauthenticated, branch protection unverified:
  `legion doctor`, and report what it says rather than proceeding past it.
