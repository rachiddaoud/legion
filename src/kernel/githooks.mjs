// githooks.mjs — THE INSTALLER for legion's local git hooks (the git-hook half of remote
// safety). It installs ONE hook — `pre-push` — into the repositories legion manages,
// and it installs it as a STUB that execs this checkout's guard by absolute path.
//
// WHAT THIS LAYER IS: every message in this file and in
// hooks/pre-push.mjs keeps the direction: layer 3 is DEPTH. "It can refuse a push the server
// would have accepted, it can never make a push the server accepts safe" (src/cli/finalize.mjs
// header). The guard blocks the ORDINARY path to a raw push; it does not prevent one.
// `git push --no-verify`, a `core.hooksPath` this kernel cannot see, another git implementation,
// a library, an MCP server — all of them walk straight past it, BY DESIGN and on the record.
// The SERVER is the only guarantee (`legion doctor`'s branch-protection check verifies it).
// Anything printed from here that reads as "pushes are now prevented" is a false claim, which is
// why hookReportLine() carries the caveat rather than leaving it to a README nobody opens.
//
// NO NEW COMMAND SURFACE. Installation rides the commands that already touch a
// repository: `legion project init` installs it, `legion feature start` re-ensures it. There is
// no install/uninstall command, and REMOVAL STAYS A HUMAN ACT: delete the file. That is stated
// here because a guard with a one-command off switch is a guard an erring agent turns off, and
// because an uninstaller would have to decide what to do about a hook it did not write.
//
// FIVE DECISIONS, each with the failure it avoids:
//
// A. THE INSTALLED FILE IS A STUB, NOT A COPY. It carries three lines of node that
//    `import()` <plugin root>/hooks/pre-push.mjs by absolute file URL. Copying the guard in
//    would freeze it at install time: every repository would carry whatever version of the
//    rules was current the day `project init` ran, and upgrading legion would upgrade nothing.
//    With a stub, the guard is the one in THIS checkout, always.
//    WHY A NODE STUB AND NOT A `#!/bin/sh` ONE: an sh stub has to embed the plugin root INSIDE
//    SHELL SYNTAX, i.e. it needs POSIX single-quote escaping — and the only such helper in the
//    tree is src/cli/feature.mjs's shellQuote, which a kernel module must not import (the CLI
//    imports this file; the cycle would be real). A node stub embeds the path as a
//    JSON-encoded file URL instead, where escaping is total and comes from the runtime.
//    The interpreter assumption is the one the plugin already makes everywhere else
//    (hooks/hooks.json spawns `node`; bin/legion carries `#!/bin/sh` + `exec node`).
//    FAIL-CLOSED, STATED: no node on PATH ⇒ the stub cannot run ⇒ git sees a non-zero exit ⇒
//    THE PUSH IS BLOCKED, with the interpreter error on stderr. That is the house rule (fail
//    closed, die loudly) and `--no-verify` is the documented way past it.
//
// B. NO-CLOBBER, AND IT IS NOT A COURTESY. A pre-push hook that is not legion's is NEVER
//    overwritten — not backed up, not chained, not merged: reported, and left byte-identical.
//    Reasons in order of weight: the operator's hook may be the one enforcing something we know
//    nothing about; silently swallowing it would be a data loss legion has no mandate for; and
//    composing hooks correctly (ordering, stdin — pre-push's ref list is consumed from stdin, so
//    two readers cannot both have it) is a design problem, not a two-line fix. Recognition is a
//    MARKER LINE in the stub (HOOK_MARKER), never the filename and never a heuristic: a marked
//    file is ours and is rewritten idempotently (the upgrade path), an unmarked one is the
//    operator's, full stop. AND THE ABSENCE OF THE LAYER MUST NOT BRICK ONBOARDING: every branch
//    here returns a RESULT, `project init`/`feature start` print it and carry on. This layer is
//    depth; refusing to initialise a project because depth could not be added would be a worse
//    failure than not having it.
//
// C. WORKTREES SHARE ONE HOOKS DIRECTORY, so the target is derived from `--git-common-dir`, not
//    from `.git` under whatever checkout the caller stands in (a linked worktree's `.git` is a
//    FILE, and a `--separate-git-dir` layout has no `.git` directory at the root at all).
//
// D. core.hooksPath IS HONOURED BY REFUSING TO FIGHT IT. If git reports an effective hooks
//    directory that is not `<common dir>/hooks`, the operator (or their hook manager — husky and
//    friends do exactly this) has redirected hooks, and legion neither writes into that
//    directory nor rewrites the setting: it REPORTS and SKIPS. Writing into `<common dir>/hooks`
//    anyway would install a file git never runs while printing "installed" — the one outcome
//    this file must not produce.
//    DISCLOSED LIMIT, because it is a real hole and not a theoretical one: the probe goes through
//    the kernel's HARDENED git seam, which points GIT_CONFIG_GLOBAL/SYSTEM at /dev/null
//    (kernel/git.mjs header D). A core.hooksPath set in the REPO's config is therefore seen; one
//    set in the operator's GLOBAL or SYSTEM config is NOT, and in that configuration the stub is
//    written where git will never look. The kernel has no unhardened read to offer — reads are
//    evidence and gitUserRepo is for mutations — so the limit is not closed here. It is instead
//    made honest in two places: this paragraph, and the report line, which names a redirected
//    core.hooksPath among the bypasses rather than claiming coverage it does not have.
//
// E. ATOMIC WRITE, THEN chmod — AND THE MODE IS PART OF "INSTALLED", CHECKED ON EVERY RE-ENSURE.
//    writeAtomic renames a fresh temp file over the target, and the renamed file carries the
//    temp's mode, so the executable bit is set AFTER the rename. The window in between is a hook
//    that is present but not executable, which git simply does not run — i.e. the window fails
//    toward "no depth", never toward a half-written script. Closing the window itself would mean
//    a chmod-before-rename primitive that fsatomic.mjs deliberately does not have; what IS closed
//    is the state it can leave behind. A crash or a failing chmod in that window (also: an
//    archive/copy restore, a checkout onto a filesystem with no exec bit) leaves a BYTE-IDENTICAL
//    legion stub at 0644, and a content-only idempotence check would call that 'unchanged' —
//    i.e. `project init` / `feature start` would report an installed guard git is silently
//    ignoring, which is precisely the false claim decision D forbids. So the content-equal branch
//    also inspects the mode and RE-ARMS it. Only a fully absent exec bit is repaired: an operator
//    who tightened the stub to 0744 still has a hook git runs, and legion does not fight a mode
//    choice that works.
//
// F. THE INSTALLER AND THE REPORTER DERIVE THE SAME PATHS. `legion doctor`'s `remote-guards`
//    check answers "is the guard installed for this repository", and it must answer about the
//    EXACT file ensurePrePushHook would write. Two independent derivations would eventually
//    disagree, and the disagreement fails in the worst direction: doctor reporting a guard on a
//    path git never reads. So hookPaths() is the single derivation and both callers go through it,
//    and the read-only answer is inspectPrePushHook(), which writes NOTHING — doctor is read-only
//    absolutely (src/cli/doctor.mjs header) and must never be handed a function that installs as a
//    side effect of being asked a question. inspectPrePushHook reports the same five real states
//    the installer distinguishes, MODE INCLUDED (decision E): a present-but-unexecutable stub is
//    reported as such and never as "installed", because git does not run it.
import { chmodSync, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { git } from './git.mjs';
import { writeAtomic } from './fsatomic.mjs';
import { ensureDir } from './paths.mjs';

/** src/kernel/githooks.mjs → the plugin root that contains it. Derived from THIS file's
 * location (the doctor.mjs/feature.mjs DEFAULT_PLUGIN_ROOT pattern), never from cwd: the stub
 * must point at the checkout the installer is part of, not at whatever repo is being managed. */
const DEFAULT_PLUGIN_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** The one hook legion installs. */
export const HOOK_NAME = 'pre-push';

/** THE RECOGNITION MARKER (decision B). Its presence anywhere in an existing pre-push file
 * means "legion wrote this, rewriting it is an upgrade"; its absence means "the operator's,
 * never touch it". Versioned so a future guard with different semantics can be told apart from
 * this one in a support conversation — the recognition itself keys on the stable prefix. */
export const HOOK_MARKER = 'legion-managed-git-hook:pre-push:v1';

/** THE MARKER ENVIRONMENT VARIABLE that tells the guard "this push IS `legion finalize`'s"
 * (src/cli/finalize.mjs sets it on the push subprocess and nowhere else; hooks/pre-push.mjs
 * rule 1 reads it). Defined HERE, in one place, because a setter and a reader that disagree by
 * one character produce a guard that blocks the one push it must never block. */
export const FINALIZE_PUSH_ENV = 'LEGION_FINALIZE_PUSH';

/** The stub git actually executes (decision A). `import()` rather than a static import because
 * this file has NO extension — node treats an extensionless script as CommonJS — and a dynamic
 * import works under both module systems. A load failure is fail-closed: exit 1, i.e. blocked,
 * with the cause on stderr and the escape hatch named. */
export function stubSource(pluginRoot = DEFAULT_PLUGIN_ROOT) {
  const guard = JSON.stringify(pathToFileURL(join(pluginRoot, 'hooks', `${HOOK_NAME}.mjs`)).href);
  return [
    '#!/usr/bin/env node',
    `// ${HOOK_MARKER}`,
    '// INSTALLED BY legion (`legion project init` / `legion feature start`) — DEFENSE IN DEPTH.',
    '// It blocks the ORDINARY raw push out of a legion-managed',
    '// repository; it does not prevent one. `git push --no-verify` skips it, and only the GitLab',
    '// server refuses authoritatively (`legion doctor` verifies that).',
    '// This file is REWRITTEN by legion whenever it re-ensures the hook — edit the guard it names,',
    '// never this stub. Removing the layer is a human act: delete this file.',
    `const guard = ${guard};`,
    'import(guard).catch((err) => {',
    '  process.stderr.write(`legion pre-push guard: could not load ${guard}: ${err && err.message || err}\\n`',
    '    + \'  BLOCKED, fail-closed: the guard could not decide, so it did not allow. Re-install it with\\n\'',
    '    + \'  `legion project init` in this repository, or delete this hook file to remove the layer.\\n\'',
    '    + \'  git\\u2019s own `--no-verify` bypasses this hook; the server still refuses what it refuses.\\n\');',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
}

/** THE guard this checkout ships, by absolute path — what an operator must call from a foreign
 * hook to compose the layer in by hand. One constant because it appears in two reports now
 * (hookReportLine here, doctor's remote-guards check) and two spellings of one path is how the
 * advice starts pointing somewhere that does not exist. */
export const GUARD_SCRIPT = join(DEFAULT_PLUGIN_ROOT, 'hooks', `${HOOK_NAME}.mjs`);

/** Absolute path out of a `git rev-parse` answer, which may be relative to the cwd git ran in. */
const abs = (p, cwd) => (isAbsolute(p) ? p : resolve(cwd, p));

/** WHERE the hook goes, decided ONCE for the installer and the reporter alike (decision F).
 * Hardened reads (kernel/git.mjs header E): WHICH directory git runs hooks from is derived, never
 * inherited — an ambient GIT_DIR would otherwise answer about another repository entirely, which
 * for the installer means writing this repo's guard into that one and for doctor means reporting
 * that repo's state as this one's. Throws whatever git() throws; both callers catch.
 * @returns {{defaultDir: string, effectiveDir: string, target: string, redirected: boolean}}
 */
function hookPaths(repoRoot) {
  const commonDir = abs(git(['rev-parse', '--git-common-dir'], repoRoot), repoRoot);
  const defaultDir = join(commonDir, 'hooks');
  // `--git-path hooks` is git's OWN answer to "where do hooks live", core.hooksPath included.
  // Comparing it to <common dir>/hooks is how a redirect is detected without re-implementing
  // git's config precedence (decision D, and its disclosed global-config limit).
  const effectiveDir = abs(git(['rev-parse', '--git-path', 'hooks'], repoRoot), repoRoot);
  return {
    defaultDir,
    effectiveDir,
    target: join(defaultDir, HOOK_NAME),
    redirected: resolve(effectiveDir) !== resolve(defaultDir),
  };
}

/**
 * READ-ONLY: what state the pre-push guard is in for the repository whose MAIN ROOT is
 * `repoRoot`. Writes nothing, creates nothing, repairs nothing (decision F) — it is the question
 * `legion doctor` asks, and the answer is a fact, not an action.
 * NEVER THROWS: a report that dies is a report, and doctor's remote-guards check never fails.
 * `'not-executable'` is a state of its own rather than a flavour of installed for the reason
 * decision E gives: git silently ignores a hook without the exec bit, so calling it installed
 * would be exactly the "green while nothing runs" claim this layer must not make.
 * @returns {{status: 'installed'|'absent'|'foreign'|'not-executable'|'hookspath'|'unknown',
 *            path: string|null, detail: string|null}}
 */
export function inspectPrePushHook(repoRoot) {
  try {
    const { defaultDir, effectiveDir, target, redirected } = hookPaths(repoRoot);
    if (redirected) {
      return {
        status: 'hookspath',
        path: effectiveDir,
        detail: `core.hooksPath points git at ${effectiveDir} instead of ${defaultDir}`,
      };
    }
    if (!existsSync(target)) return { status: 'absent', path: target, detail: null };
    let current;
    try { current = readFileSync(target, 'utf8'); }
    catch (e) { return { status: 'unknown', path: target, detail: `the existing hook is unreadable: ${e.message}` }; }
    if (!current.includes(HOOK_MARKER)) return { status: 'foreign', path: target, detail: null };
    if ((statSync(target).mode & 0o111) === 0) return { status: 'not-executable', path: target, detail: null };
    return { status: 'installed', path: target, detail: null };
  } catch (e) {
    return { status: 'unknown', path: null, detail: e?.message ?? String(e) };
  }
}

/**
 * Ensure the pre-push guard is installed for the repository whose MAIN ROOT is `repoRoot`.
 * NEVER THROWS — every failure is a returned status, because this is depth and its absence must
 * not fail the command that called it (decision B).
 * @returns {{status: 'installed'|'updated'|'unchanged'|'skipped-foreign'|'skipped-hookspath'|'failed',
 *            path: string|null, detail: string|null}}
 */
export function ensurePrePushHook(repoRoot, { pluginRoot = DEFAULT_PLUGIN_ROOT } = {}) {
  try {
    const { defaultDir, effectiveDir, target, redirected } = hookPaths(repoRoot);
    if (redirected) {
      return {
        status: 'skipped-hookspath',
        path: effectiveDir,
        detail: `core.hooksPath points git at ${effectiveDir} instead of ${defaultDir}`,
      };
    }

    const desired = stubSource(pluginRoot);
    if (existsSync(target)) {
      let current;
      try { current = readFileSync(target, 'utf8'); }
      catch (e) { return { status: 'failed', path: target, detail: `existing hook is unreadable: ${e.message}` }; }
      if (!current.includes(HOOK_MARKER)) {
        return {
          status: 'skipped-foreign',
          path: target,
          detail: 'an existing pre-push hook is not legion\'s and was left exactly as it is',
        };
      }
      if (current === desired) {
        // The bytes are current — but a stub git will not execute is not an installed guard
        // (decision E). This is the ONLY repair path: there is no install command to run instead.
        if ((statSync(target).mode & 0o111) === 0) {
          chmodSync(target, 0o755);
          return {
            status: 'updated',
            path: target,
            detail: 'it was present but not executable, so git was ignoring it — the mode is restored',
          };
        }
        return { status: 'unchanged', path: target, detail: null };
      }
      writeAtomic(target, desired);
      chmodSync(target, 0o755);
      return { status: 'updated', path: target, detail: null };
    }
    ensureDir(defaultDir); // a repo cloned with a hook-less template has no hooks/ at all
    writeAtomic(target, desired);
    chmodSync(target, 0o755);
    return { status: 'installed', path: target, detail: null };
  } catch (e) {
    return { status: 'failed', path: null, detail: e?.message ?? String(e) };
  }
}

/** THE caveat every install line carries. It mirrors doctor's best-effort phrasing
 * deliberately: the two are the same claim about the same layering, and an operator who reads
 * one must not be able to infer something stronger from the other. It names the bypasses
 * CONCRETELY — a caveat that says "best-effort" without saying what walks past it teaches
 * nothing and gets skipped. */
const DEPTH =
  'DEFENSE IN DEPTH, not the guarantee: it blocks the ordinary raw push only — `git push '
  + '--no-verify`, a core.hooksPath outside this repo\'s config, or any other client walks past '
  + 'it; only the server refuses authoritatively (`legion doctor` verifies that).';

/** ONE line about the hook, for `project init` / `feature start` stdout. Every status renders,
 * including 'unchanged': a line that appears only sometimes is a line an operator reads as news
 * when it does appear. Always ends in '\n'. */
export function hookReportLine(r) {
  switch (r.status) {
    case 'installed':
      return `  pre-push guard: installed at ${r.path} — ${DEPTH}\n`;
    case 'updated':
      // The parenthetical says WHICH repair happened: a stale stub rewritten to point at this
      // checkout is a different event from a present-but-unexecutable one being re-armed, and an
      // operator who sees the second deserves to know their guard had been dormant.
      return `  pre-push guard: updated at ${r.path} `
        + `(${r.detail ?? 'it now runs this legion checkout'}) — ${DEPTH}\n`;
    case 'unchanged':
      return `  pre-push guard: already installed at ${r.path} — ${DEPTH}\n`;
    case 'skipped-foreign':
      return `  pre-push guard: NOT installed — ${r.path} already holds a pre-push hook that is not `
        + `legion's, and it was left untouched. Compose the two by hand if you want the layer `
        + `(call ${GUARD_SCRIPT} from your hook). Without `
        + `it this repository has no local guard — ${DEPTH}\n`;
    case 'skipped-hookspath':
      return `  pre-push guard: NOT installed — ${r.detail}, and legion does not rewrite your git `
        + `config. Add the guard to that directory by hand if you want the layer. Without it this `
        + `repository has no local guard — ${DEPTH}\n`;
    default:
      return `  pre-push guard: NOT installed (${r.detail}) — this repository has no local guard; `
        + `${DEPTH}\n`;
  }
}
