// githooks.mjs — THE REMOVER for legion's retired local git hook. Until 2026-08-07 this module
// INSTALLED a `pre-push` guard stub into every repository legion manages; on that date BOTH local
// remote-write guards — the pre-push guard (hooks/pre-push.mjs) and the PreToolUse Bash scan
// (hooks/bash-remote-write.mjs) — were REMOVED, by owner decision: a developer who uses legion is
// free to push, open and merge MRs by hand, and the GitLab server's branch protection (verified by
// `legion doctor`'s branch-protection check) is the ONLY barrier. `legion finalize` remains the
// intended path for feature branches; it is no longer locally enforced.
//
// WHY THE MODULE SURVIVES THE LAYER IT INSTALLED: the installed stub was FAIL-CLOSED — three
// lines of node that `import()` <plugin root>/hooks/pre-push.mjs by absolute file URL and exit 1
// when the load fails. With the guard file deleted from this checkout, every such stub now blocks
// EVERY push in its repository, `legion finalize`'s included. Deleting the guard without removing
// the fleet's stubs would therefore brick pushes in every previously-registered repository — the
// one direction fail-closed must never fail. So this module's single remaining job is to NEUTER
// LEFTOVER STUBS, and it can be deleted once no managed repository carries one.
//
// NO NEW COMMAND SURFACE, same as installation: removal rides the commands that already touch a
// repository — `legion project init` and `legion feature start` both call removePrePushStub().
// `legion doctor`'s remote-guards check reports leftovers it cannot reach (read-only, always).
//
// THREE DECISIONS, each with the failure it avoids:
//
// A. RECOGNITION STAYS THE MARKER, NEVER A HEURISTIC — the install-era rule, now in reverse. A
//    pre-push file containing HOOK_MARKER is legion's stub and is deleted; a file without it is
//    the operator's hook and is NEVER touched (no-clobber reversed: deleting a hook we did not
//    write would be the same data loss installing over one would have been). The marker string is
//    kept BYTE-IDENTICAL to the one every installed stub carries — recognition of the fleet keys
//    on it, and changing it by a character orphans every stub in the field.
//
// B. REMOVAL TOUCHES ONLY THE PATH THE INSTALLER EVER WROTE: `<git common dir>/hooks/pre-push`,
//    derived via hookPaths() exactly as the installer derived it (worktrees share one hooks
//    directory, so `--git-common-dir` decides, never `.git` under the caller's checkout). A
//    core.hooksPath redirect does NOT skip removal — the installer refused to write into a
//    redirected directory, so a marked stub at the DEFAULT path under a redirect is inert litter
//    git ignores, and it is ours to collect. What removal never does is write into, or delete
//    from, the REDIRECTED directory: if an operator hand-copied the stub there, that copy is
//    theirs to delete, and doctor's report names it rather than this module reaching for it.
//
// C. NEVER THROWS, AND SILENCE IS THE STEADY STATE. Every branch returns a RESULT; a removal that
//    fails must not fail `project init` or `feature start` (the repository works either way — at
//    worst its pushes stay blocked by the stub until a human deletes it, and the report line says
//    exactly that). removalReportLine() renders NOTHING for 'none' and 'kept-foreign' — the
//    install-era rule ("every status renders") is deliberately reversed, because a permanent
//    "no stub present" line on every feature start is noise about a retired layer, where the old
//    install line was a claim about a live one. Only an actual removal, or an actual failure to
//    remove, is news.
import { existsSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { git } from './git.mjs';

/** The one hook legion ever installed. */
export const HOOK_NAME = 'pre-push';

/** THE RECOGNITION MARKER (decision A). Its presence anywhere in an existing pre-push file means
 * "legion wrote this, it is ours to remove"; its absence means "the operator's, never touch it".
 * BYTE-IDENTICAL to the marker every install-era stub carries — do not edit it. */
export const HOOK_MARKER = 'legion-managed-git-hook:pre-push:v1';

/** Absolute path out of a `git rev-parse` answer, which may be relative to the cwd git ran in. */
const abs = (p, cwd) => (isAbsolute(p) ? p : resolve(cwd, p));

/** WHERE the installer put the hook, decided ONCE for the remover and the reporter alike (the
 * install-era decision F, still load-bearing: two derivations that disagree fail in the worst
 * direction — doctor reporting a leftover on a path the remover never looks at).
 * Hardened reads (kernel/git.mjs header E): WHICH directory git runs hooks from is derived, never
 * inherited — an ambient GIT_DIR would otherwise answer about another repository entirely.
 * Throws whatever git() throws; both callers catch.
 * @returns {{defaultDir: string, effectiveDir: string, target: string, redirected: boolean}}
 */
function hookPaths(repoRoot) {
  const commonDir = abs(git(['rev-parse', '--git-common-dir'], repoRoot), repoRoot);
  const defaultDir = join(commonDir, 'hooks');
  // `--git-path hooks` is git's OWN answer to "where do hooks live", core.hooksPath included.
  // The redirect matters to the REPORTER (a stub in the effective dir is one git actually runs);
  // the REMOVER acts on the default path regardless (decision B).
  const effectiveDir = abs(git(['rev-parse', '--git-path', 'hooks'], repoRoot), repoRoot);
  return {
    defaultDir,
    effectiveDir,
    target: join(defaultDir, HOOK_NAME),
    redirected: resolve(effectiveDir) !== resolve(defaultDir),
  };
}

/**
 * READ-ONLY: does the repository whose MAIN ROOT is `repoRoot` still route pushes through a
 * leftover legion stub? This is `legion doctor`'s question, and the answer is a fact, not an
 * action — it writes nothing, removes nothing (doctor is read-only absolutely; removal belongs
 * to `legion project init` / `legion feature start`).
 * It inspects the EFFECTIVE hooks directory — the one git actually reads, core.hooksPath
 * included — because the question that matters post-removal is "will the next push in this
 * repository die inside a stub whose guard file no longer exists".
 * `redirected` rides along on every answer because the REMEDY depends on it: removePrePushStub
 * acts on the DEFAULT path only (decision B), so a leftover found under a core.hooksPath
 * redirect is one no legion command will ever delete — a report that prescribed
 * `legion project init` for that state would send the operator down the one path guaranteed to
 * change nothing, silently ('none' renders no line).
 * NEVER THROWS: a report that dies is a report doctor cannot print.
 * @returns {{status: 'clean'|'leftover'|'leftover-inert'|'foreign'|'unknown',
 *            path: string|null, detail: string|null, redirected: boolean}}
 */
export function inspectPrePushHook(repoRoot) {
  try {
    const { effectiveDir, redirected } = hookPaths(repoRoot);
    const hook = join(effectiveDir, HOOK_NAME);
    if (!existsSync(hook)) return { status: 'clean', path: hook, detail: null, redirected };
    let current;
    try { current = readFileSync(hook, 'utf8'); }
    catch (e) {
      return { status: 'unknown', path: hook, detail: `the existing hook is unreadable: ${e.message}`, redirected };
    }
    if (!current.includes(HOOK_MARKER)) return { status: 'foreign', path: hook, detail: null, redirected };
    if ((statSync(hook).mode & 0o111) === 0) {
      // git silently ignores a hook without the exec bit: this stub blocks nothing, it is litter.
      return {
        status: 'leftover-inert', path: hook,
        detail: 'present but not executable, so git ignores it', redirected,
      };
    }
    return { status: 'leftover', path: hook, detail: null, redirected };
  } catch (e) {
    return { status: 'unknown', path: null, detail: e?.message ?? String(e), redirected: false };
  }
}

/**
 * Remove a leftover legion pre-push stub from the repository whose MAIN ROOT is `repoRoot`.
 * Acts ONLY on `<git common dir>/hooks/pre-push` — the one path the installer ever wrote
 * (decision B). NEVER THROWS — every failure is a returned status (decision C).
 * @returns {{status: 'removed'|'none'|'kept-foreign'|'failed', path: string|null, detail: string|null}}
 */
export function removePrePushStub(repoRoot) {
  let target = null; // hoisted so a throwing unlink still reports WHICH file needs the hand-delete
  try {
    ({ target } = hookPaths(repoRoot));
    if (!existsSync(target)) return { status: 'none', path: target, detail: null };
    let current;
    try { current = readFileSync(target, 'utf8'); }
    catch (e) { return { status: 'failed', path: target, detail: `the existing hook is unreadable: ${e.message}` }; }
    if (!current.includes(HOOK_MARKER)) {
      return {
        status: 'kept-foreign',
        path: target,
        detail: 'the pre-push hook there is not legion\'s and was left exactly as it is',
      };
    }
    unlinkSync(target);
    return { status: 'removed', path: target, detail: null };
  } catch (e) {
    return { status: 'failed', path: target, detail: e?.message ?? String(e) };
  }
}

/** ONE line about the removal, for `project init` / `feature start` stdout — or NO line: 'none'
 * and 'kept-foreign' render '' (decision C: the steady state of a retired layer is not news).
 * Non-empty lines always end in '\n'. */
export function removalReportLine(r) {
  switch (r.status) {
    case 'removed':
      return `  pre-push stub: removed leftover at ${r.path} — legion's local push guards were `
        + 'retired; the server-side branch protection `legion doctor` verifies is the only push '
        + 'barrier\n';
    case 'failed':
      return `  pre-push stub: could NOT remove the leftover guard stub (${r.detail ?? 'unknown cause'})`
        + `${r.path ? ` at ${r.path}` : ''} — until it is deleted by hand, EVERY ordinary push in `
        + 'this repository fails inside it (the guard file it loads no longer ships)\n';
    default:
      return '';
  }
}
