# legion

Legion runs a software feature end-to-end inside Claude Code — interview, spec, plan, build,
review, and finalize — with a human approving at every gate. It provides a small, zero-dependency
CLI (`legion`) that enforces typed operations and records evidence so operations are auditable
and fail closed when needed.

Requirements: Node >= 22.

## Install

```sh
claude plugin marketplace add rachiddaoud/legion
claude plugin install legion@legion
node ~/.claude/plugins/marketplaces/legion/bin/legion.mjs setup
```

(or `node  $CLAUDE_CONFIG_DIR/plugins/marketplaces/legion/bin/legion.mjs setup` if
you set `CLAUDE_CONFIG_DIR`)

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
claude plugin marketplace update legion && claude plugin update legion@legion
```

## Consult backend

The second-opinion review lens defaults to the `codex` CLI. Configure globally via
`/plugin` → *legion* → configure, or in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "legion@legion": {
      "options": {
        "consult_backend": "xai",
        "consult_model": "grok-4",
        "consult_token_env": "XAI_API_KEY"
      }
    }
  }
}
```

- `consult_backend` — `codex` | `agy` (CLIs; `agy` is Google's Antigravity CLI) · `openai` | `google` | `xai` | `deepseek` | `mistral` (hosted APIs) · `api` (custom OpenAI-compatible endpoint).
- `consult_model` — optional for the CLIs, required for API backends. Unset on `agy` pins `gemini-3.7-flash-medium`.
- `consult_base_url`, `consult_token_env` — required for `api`; optional overrides for named providers (each has a default endpoint and token env var, e.g. `xai` → `XAI_API_KEY`).

`consult_token_env` is the **name** of an env var — export the token itself in your shell
(`export XAI_API_KEY=...`); legion never stores or prints the value. A missing CLI, token or
model degrades the review (single lens, reported as such), never blocks it.

## Start a feature

From a Claude Code session, in any repo:

```
/legion:start
```

This creates the worktree, branch and dossier and runs the feature session. To resume:

```
/legion:feature resume <feature-id>
```

## Viewer

A read-only UI over the manifests, dossiers and feature history. From a Claude Code session:

```
/legion:viewer
```

Or from a shell:

```sh
legion viewer-build   # builds the bundle; skips when already current, --force to rebuild
legion viewer [--port <n>] [--host <addr>] [--api-only] [--org <org>]
```

Serves `http://127.0.0.1:4600` by default. `legion setup` already builds the bundle, so
`legion viewer` normally works straight away; run `viewer-build` again after a plugin update. The
viewer writes nothing — killing it changes nothing about any feature.

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

- Reduce interactive prompts by allow-listing Claude commands you trust. Add common read-only `legion` commands to `~/.claude/settings.json` so Claude Code can run them without asking each time. Example:

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

Keep any write or destructive commands off the allow-list for safety.

- Install and authenticate your forge CLI. Legion uses the platform CLI for some operations (creating PRs, checking branch protection). For GitHub:

```sh
gh auth login
```

For GitLab:

```sh
glab auth login
```

Ensure the CLI is on your PATH so `legion` can call it.

- Run `legion doctor` to validate your environment. It checks common failure points (git, Node, PATH links, and forge CLI auth) and prints actionable remedies (for example: “install gh”, “run gh auth login”, or “npm rm -g legion if PATH links to the clone”).
