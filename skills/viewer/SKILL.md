---
name: viewer
description: Open the legion viewer — the read-only observation UI over the manifests, dossiers and feature git history. Builds the frontend bundle on first use, launches `legion viewer` in the background, and hands back the URL. Use when the user runs /legion:viewer, or asks to open, launch or see the legion viewer/dashboard/UI.
argument-hint: [optional flags, e.g. --port 4700 --org acme]
allowed-tools: [Bash, Read]
---

<!-- Plugin-skill format: skills/<name>/SKILL.md, invoked as /legion:viewer. plugin.json declares
     no `skills` path — declaring one would unship the sibling skills (see the header of
     skills/start/SKILL.md). Bash and Read only, deliberately.

     THIS FILE IS A TRIGGER, NOT A PROCEDURE, and it is short on purpose. Resolving the checkout
     and building the bundle used to live here as prose; both are now kernel commands with tests
     (src/cli/viewer-build.mjs), because a second copy of a command in a skill is a copy that
     drifts — this file once pinned `npm install` while the kernel had moved on. What a skill
     provides that the CLI cannot is the natural-language trigger in the description above; that
     is the whole job. Anything mechanical that grows back into this file belongs in the CLI. -->

# /legion:viewer

The user wants the observation UI.

1. **Bring the bundle up to date first**: `legion viewer-build`. Always run it, not only on a
   refusal — on a marketplace install, Claude Code auto-pulls new viewer sources under a
   previously built bundle, and this command is what notices (it skips in a second when the
   bundle already matches the sources, builds on first use, rebuilds when they drifted).
2. **A failed build usually does not take the viewer away — with one exception you must read the
   message for.** If step 1 fails, relay the failure and then:
   - **It refused because another build holds the lock** (the message names the lock file): do
     NOT launch. That other build is rewriting `viewer/dist` right now, and serving mid-rewrite is
     how a blank page gets blamed on the viewer. Wait for it and re-run step 1.
   - **Any other failure** (`npm ci` offline is the ordinary one, not a defect): launch anyway if
     a bundle is still there — `legion viewer` serves it and prints its own stale warning when it
     applies — and hand over the URL alongside the failure, so they know the UI may be one pull
     old. If `legion viewer` refuses instead, the bundle is gone: a build killed while vite was
     writing empties `dist` and takes the working bundle with it. Relay that refusal, which names
     `legion viewer-build` as its own remedy.
   When no bundle can be served at all, that is the end of the road: relay it, and offer
   `legion viewer --api-only`.
3. **Launch it in the background**, passing through any flags they gave (`--port`, `--host`,
   `--org`, `--api-only`): `legion viewer`. It prints the URL on stdout as soon as it is
   listening.
4. **Hand the user the URL.** That is the deliverable.

Worth saying once when you report, in your own words: the viewer is read-only and disposable —
closing the tab or killing the process changes nothing about any feature, and approvals it shows
are what was *recorded*, not a claim of current validity.

**When something is wrong:** every refusal here is a message with its own remedy in it (a missing
bundle names the build command, a taken port names `--port`, a bad flag names the usage). Relay it
and apply the remedy it names; do not reinvent one, do not kill a process to free a port, and
never edit a manifest or run `legion state` on the viewer's behalf — it needs nothing from the
lifecycle to do its job.
