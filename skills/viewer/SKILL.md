---
name: viewer
description: Open the legion viewer — the read-only observation UI over the manifests, dossiers and feature git history. Builds the frontend bundle on first use, launches `legion viewer` in the background, and hands back the URL. Use when the user runs /legion:viewer, or asks to open, launch or see the legion viewer/dashboard/UI.
argument-hint: [optional flags, e.g. --port 4700 --org acme]
allowed-tools: [Bash, Read]
---

<!-- Plugin-skill format: skills/<name>/SKILL.md, invoked as /legion:viewer. plugin.json
     declares no `skills` path — declaring one would unship the sibling skills (see the
     header of skills/start/SKILL.md). Bash and Read only, deliberately: everything this
     skill does is a check, at most one build, and one background launch. It orchestrates
     nothing and mutates no legion state — the viewer it starts is GET/HEAD-only by
     construction, so the strongest thing this skill can do to a
     feature is look at it. -->

# /legion:viewer

The user wants the observation UI. Three steps, most of them usually skippable.

**1. Find the plugin checkout.** The viewer ships inside this plugin's repo. Resolve the
repo root from this skill's own location (the directory containing `bin/legion`), never
from cwd — the user may be standing in a feature worktree or anywhere else.

**2. Ensure the bundle exists.** If `<repo>/viewer/dist/index.html` is missing, this is
the ordinary first-run state, not an error: tell the user you are building it once, then
run `npm install && npm run build` in `<repo>/viewer` (this is the one step that touches
the network; it can take a minute or two). If the build fails, show the real error and
stop — do not fall back to `--api-only` silently; the user asked for the UI.

**3. Launch and report.** Run `legion viewer` in the background, passing through any flags
the user gave (`--port`, `--org`, `--host`, `--api-only`). Read its first line of output —
the CLI prints the URL on stdout when it is listening, and refuses loudly on stderr if the
port is taken (suggest `--port <other>` in that case, do not kill anything to free one).
Give the user the URL as the deliverable.

Worth saying once when you report, in your own words: the viewer is read-only and
disposable — closing the tab or killing the process changes nothing about any feature, and
approvals it shows are what was *recorded*, not a claim of current validity.

**When something is wrong:** the viewer refusing to start is a message with a remedy in it
(missing bundle names the build commands, a bad flag names the usage) — relay it and apply
the remedy rather than reinventing it. Never edit manifests, never run `legion state`
anything on the viewer's behalf; it needs nothing from the lifecycle to do its job.
