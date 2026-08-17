# legion

Legion runs a software feature end-to-end inside Claude Code — interview, spec, plan, build,
review, and finalize — with a human approving at every gate. It provides a small, zero-dependency
CLI (`legion`) that enforces typed operations and records evidence so operations are auditable
and fail closed when needed.

Requirements: Node >= 22.

## Install (recommended — GitHub)

```sh
claude plugin marketplace add rachiddaoud/legion
claude plugin install legion@legion
node ~/.claude/plugins/marketplaces/legion/bin/legion.mjs setup
```

These commands register the marketplace and install the plugin. Claude Code keeps a git clone at
`~/.claude/plugins/marketplaces/legion` (or `$CLAUDE_CONFIG_DIR/plugins/marketplaces/legion`), and
will pull updates when auto-update is enabled.

To run from a local checkout:

```sh
cd <this repo> && ./bin/legion setup
```

## Update

Enable automatic updates once via `/plugin` → Marketplaces → *legion* or add to
`~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "legion": {
      "source": { "source": "github", "repo": "rachiddaoud/legion" },
      "autoUpdate": true
    }
  }
}
```

Manual update:

```sh
claude plugin marketplace update legion && claude plugin update legion
```

## Start a feature

From a Claude Code session, in any repo:

```
/legion:start
```

This creates the worktree, branch and dossier and runs the feature session. To resume:

```
/legion:feature resume <feature-id>
```

## How it works (overview)

Legion drives features through a small typed kernel across seven stages. High-level flow:

```mermaid
flowchart TD
    I[intake<br/><i>interview + repo read</i>]
    S[spec<br/><i>rules, states, acceptance</i>]
    P[plan<br/><i>plan.md + tasks</i>]
    B[build<br/><i>milestone by milestone</i>]
    R[review<br/><i>feature-level settlement</i>]
    M[pre-merge<br/><i>all evidence, shown</i>]
    F[finalize<br/><i>opens the MR/PR</i>]

    I -->|human agrees the recap| S
    S -->|human agrees the digest| P
    P -->|critic passes + human approves| B
    B -->|every milestone closed| R
    R -->|verdicts recorded| M
    M -->|human approves| F
    F --> H([human merges])
```

Agents propose; the kernel records evidence and enforces safety gates. The intent is to keep operations auditable and fail closed rather than guessing.

## Day to day

- Add common read-only kernel commands to `~/.claude/settings.json` to reduce prompts.
- Use `gh` or `glab` configured for your forge; some doctor checks and finalize operations require them.
- Run `legion doctor` to validate environment and get actionable remedies for common issues.

## Quick reference

- Install: use the three commands in Install (recommended).
- Update: enable auto-update or run the manual update command.
- Start: run `/legion:start` in a Claude Code session.

For developer details and migration steps, see the repository history and PRs.
