# legion

Legion runs a software feature end to end inside Claude Code. A small zero-dependency CLI
kernel (`legion`) owns every state change, evidence pin and gate — deterministic, fail-closed,
never guesses. On top of it, Claude Code skills drive one feature session through its
lifecycle, dispatching subagent roles (architect, critic, builder, reviewers) and calling the
kernel for every transition. Distributed as a Claude Code plugin.

Plain ESM, Node >= 22, zero runtime dependencies.

## Install

One command, from the checkout:

```sh
cd <this repo> && ./bin/legion setup
```

Registers this checkout as a Claude Code plugin marketplace, installs (or refreshes) the
plugin from it, links `legion` onto your PATH, then runs `legion doctor` as its exit code.
**Re-run it after upgrading the checkout** — the installed plugin is a snapshot, not a symlink.

Manual pieces, if you prefer them separately:

```sh
cd <this repo> && npm link          # or: export PATH="<this repo>/bin:$PATH"
claude plugin marketplace add <this repo>
claude plugin install legion@legion
```

Verify with `command -v legion`, then run `legion doctor`.

## Quickstart

Register the repo once (config lives in `~/.legion`, not in the repo):

```sh
cd /path/to/your/repo
legion project init
```

Then, from inside a Claude Code session in that repo:

```
/legion:start
```

That's the front door for a new feature. It asks two or three questions (what the feature is,
which branch it builds on, an optional ticket), derives a safe name, runs the equivalent of
`legion feature start` for you, and **keeps going as the feature session** — no separate
launch command to copy, no second window. To resume a feature later, use the launch command
`feature start` printed the first time, or `/legion:feature resume <name>` from the worktree.

### Reduce permission prompts

A feature session calls `legion state`/`gate`/`plan check`/`doctor`/`feature status` dozens of
times per stage. Allowlist the frequent, read-or-validate-only ones in `settings.json` (global
`~/.claude/settings.json`, or a project's own):

```json
{
  "permissions": {
    "allow": [
      "Bash(legion state *)",
      "Bash(legion gate *)",
      "Bash(legion plan *)",
      "Bash(legion feature status*)",
      "Bash(legion doctor*)"
    ]
  }
}
```

Deliberately **not** allowlisted: `legion feature start|abandon|clean` (creates or destroys a
worktree/branch) and `legion finalize` (the only remote-write path) — both stay infrequent
enough, and consequential enough, to keep prompting.

## How legion is layered

- **The kernel (`legion` CLI)** — the only thing allowed to create a worktree/branch, change a
  feature's stage, mint a gate receipt, or open a merge request. It pins the base commit and the
  gate command policy at feature start, binds every approval to a content hash (edit the
  approved file and the approval drops — that's the safety net, not a bug), and fails closed on
  anything ambiguous rather than guessing.
- **Skills** — the Claude Code commands that drive a session and call the kernel for every step:
  - `/legion:start` — create a feature and become its session (replaces manually running
    `legion feature start` + relaunching).
  - `/legion:feature` — resume or drive the lifecycle, one stage at a time, forever the way a
    long-running feature gets worked.
  - `/legion:viewer` — read-only dashboard over everything recorded (see below).
- **Subagent roles**, dispatched as the lifecycle needs them: `architect` (writes the plan),
  `plan-critic` (challenges it before any code is written), `builder` (implements one task),
  `code-reviewer` / `product-reviewer` / `visual-reviewer` (verify a milestone from different
  angles), `codex-consult` (optional external second opinion, `full` profile only, advisory —
  never the sole reason something blocks).

## The lifecycle

`intake → spec → plan → build → review → pre-merge → finalize → (human merges)`

| Stage | What happens | Gate to move on |
|---|---|---|
| intake | Interview, profile classification, read the target repo, recap | Human agrees the recap |
| spec | Functional spec: rules, states, acceptance rows, out-of-scope | Human agrees the digest |
| plan | Architect writes `plan.md` + tasks; plan-critic reviews | Critic passes + human approves |
| build | Per milestone: build → review → fix round → milestone close | All milestones closed |
| review | Feature-level settlement of what the build stage recorded | Review artifact recorded |
| pre-merge | Full evidence shown to the human: diff, receipts, verdicts | Human approves |
| finalize | `legion finalize` opens the MR — the only remote-write path | MR recorded, human merges |

Every arrow is a typed kernel op, not a convention — reopening a spec or plan drops the
approvals downstream of it automatically, so nothing stale ships silently.

## Profiles

Chosen at intake, escalated (never de-escalated) the moment evidence says so:

| Profile | Plan critic | Per-task review | Milestone product review | Codex consult |
|---|---|---|---|---|
| **express** | skipped (a recorded fail still blocks) | yes | no | no |
| **standard** (default) | yes | yes | yes | no |
| **full** | yes | yes | yes | yes, advisory |

## Subtleties worth knowing

- **One worktree, one branch, one dossier per feature** — created by the kernel alone, never by
  a skill or an agent by hand.
- **Approvals are content-bound, not stage-bound.** The plan approval covers `plan.md` bytes
  *and* the task list together; the spec approval on a cross-repo feature covers the spec *and*
  the shared interface contract. Change the bytes, lose the approval — re-approve, don't
  work around it.
- **A ticket is optional operator data** (`--ticket`, or `legion state ticket-record` later) —
  legion never derives one, only renders the closing line and posts issue comments at finalize.
- **Cross-repo initiatives exist but ship dark**: the mechanics (`--initiative <id>`, shared
  interface contract, by-reference intake) are built and tested, but the attended proving run on
  a real cross-repo feature is still pending — don't manufacture one just to try it.
- **`lessons.md`** is a small per-project memory file (`~/.legion/orgs/<org>/projects/<project>/`)
  that intake and the architect read and the session writes at a handful of trigger moments —
  the cheap alternative to a knowledge base nobody would keep curated.
- **Everything fails closed.** A missing receipt, an unreadable manifest, a disagreement between
  two reviewers — all of it stops and asks rather than proceeding on a best guess.

## Gate configuration

`project init` scaffolds `gates: {}` — tier-0 self-protection (secrets, protected paths) always
runs, and the kernel warns loudly that no project-owned commands are declared. Declare the real
gate by writing it to a file and passing it to `init`: structured argv arrays only, never shell
strings.

`gates.json`:

```json
{
  "commands": {
    "test": { "argv": ["node", "--test"], "timeoutMs": 300000 },
    "lint": { "argv": ["npx", "eslint", "."], "timeoutMs": 120000 }
  },
  "task":     ["test"],
  "boundary": ["lint", "test"]
}
```

```sh
legion project init --gates ./gates.json --bootstrap ./bootstrap.json
```

Both flags read a JSON file, validate it, and write it into
`~/.legion/orgs/<org>/projects/<project>/project.json`. A violation dies naming the offending
key and the file it came from, and writes nothing. Re-running `init` without a flag leaves that
block untouched; with one, it replaces the block and bumps the config revision.

`bootstrap.json` is an array run in the worktree at `feature start` — either
`{"cwd": ".", "argv": ["npm", "ci"], "timeoutMs": 300000}` or a repo-owned script pinned by hash,
`{"script": "scripts/setup.sh", "sha256": "<64 hex>"}`. Raw shell strings are refused.

`task` names the commands `legion gate run` executes after every build task; `boundary` is the
fuller pre-merge tier. The gate command policy is **pinned at `feature start`**; editing it
mid-feature requires an explicit `legion gate run --repin`.

## Environment check

```sh
legion doctor
```

Checks the environment the kernel depends on (git, node, glab, home layout, server-side branch
protection where verifiable) and reports each probe with a remedy. Run it after install and
whenever something refuses.

## Observation — `legion viewer`

A **read-only** UI over what legion already recorded: manifests, dossier artifacts, and the
feature worktree's git history. GET/HEAD only, loopback by default, fully disposable — legion
behaves identically with it closed or deleted, and nothing in the kernel or the skills knows
whether it's running.

```
/legion:viewer          # from a Claude Code session — builds on first use, launches, hands back the URL
```

Or run it directly:

```sh
cd <this repo>/viewer && npm install && npm run build   # once, or after an upgrade
legion viewer                                            # http://127.0.0.1:4600/
```

No POST/PUT/DELETE/PATCH route exists — the method guard refuses one before any routing. It
writes nothing under `~/.legion`, calls no `legion state` op, and renders no start/resume/
retry/approve affordance. Approvals show as *recorded*, never as *valid* (that's the kernel's
call, made fresh each time it matters); missing data renders as unknown, never guessed.
Statistics have exactly one formula, computed server-side; the client only displays it. Its
own dependencies (React, Vite, …) live in `viewer/package.json` — a standalone package that adds
nothing to the root install.
