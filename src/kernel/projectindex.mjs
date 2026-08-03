// projectindex.mjs — ONE answer to "which registered legion project owns this repository root",
// for the two GUARDS that must answer it identically: hooks/pre-push.mjs (git's half of
// remote-safety layer 3) and hooks/bash-remote-write.mjs (the Claude Code half, once T29 widened
// it from launch-cwd scoping to TARGET-REPO scoping and therefore had to ask the same question).
//
// WHY IT IS A KERNEL MODULE AND NOT A HOOK HELPER. hooks/pre-push.mjs must not import
// hooks/_common.mjs — _common's resolveFeature chdir()s to a payload cwd, which is the opposite of
// what a git hook needs (its own header says so). A kernel module has no such affordance: this
// file reads a path and the index, chdir()s nowhere, spawns nothing, and writes nothing.
//
// WHAT IT DELIBERATELY IS NOT:
//   - NOT a repository resolver. The caller derives the MAIN WORKTREE ROOT itself, through
//     kernel/git.mjs's hardened seam (mainWorktreeRoot), because WHICH REPOSITORY WE ARE LOOKING
//     AT is evidence and each guard has its own rule for where the path comes from (pre-push:
//     git's cwd; the PreToolUse guard: the command's own `-C`/`cd`, else the payload cwd). Handing
//     that derivation to a shared helper would hide the one thing the two guards must not share.
//   - NOT a message writer. Each guard renders its own refusal in its own voice and on its own
//     channel (git's stderr in a multi-line block; a one-line permissionDecisionReason). The
//     SHARED part is the DECISION — absent vs unreadable vs malformed vs unregistered vs
//     ambiguous vs matched — because that is where two hand-written copies drifted apart before.
//   - NOT the index validation hooks/_common.mjs performs. That one is STRICTER (it also demands
//     casfile's `version` and schemaVersion 1) because it answers a different question for a
//     different audience: "can any feature on this machine be resolved at all", rendered LOUDLY
//     into a session's context. Collapsing the two would change SessionStart's corrupt-vs-absent
//     behaviour, which test/hooks.test.mjs pins. Both are in the same direction — present-but-wrong
//     is never silence — and that is the invariant, not the field list.
//
// THE DECISION, and why each outcome is the one it is (hooks/pre-push.mjs's FAIL-CLOSED section is
// the long form; this is the table both guards read):
//   absent       — no projects.json at all ⇒ nothing on this machine is registered. An ANSWER, not
//                  an unknown: callers ALLOW. Refusing here would brick every repository that
//                  still carries a guard after ~/.legion is removed, in the one direction that
//                  buys no safety.
//   unreadable   — present but not parseable JSON ⇒ UNKNOWN. Callers refuse, naming the file.
//   malformed    — parseable but not index-shaped ⇒ UNKNOWN, same direction. Parsing is not
//                  validation: `{}` must not read as "nothing is registered".
//   unregistered — the index was read and this root is in none of its entries ⇒ an ANSWER: not
//                  legion's business. Callers ALLOW.
//   ambiguous    — the same root registered as MORE THAN ONE project. `resolveProject` refuses this
//                  with `--org`, and a guard has no `--org` to supply, so which project's rules
//                  apply is UNKNOWN ⇒ refuse.
//   match        — exactly one entry. `entry` is the raw index entry (configPath, features, …) and
//                  `projectId` is the org/name label every refusal names.
// PATHS ARE COMPARED CANONICALLY ON BOTH SIDES (realish): entries store realpath'd roots, but
// macOS /tmp is a symlink to /private/tmp and half the recorded paths in a fixture go through it,
// so comparing raw strings silently fails to match a repository that IS registered — a guard that
// allows what it exists to refuse.
import { existsSync, realpathSync } from 'node:fs';
import { readJson } from './fsatomic.mjs';
import { projectsIndexPath } from './paths.mjs';

/** Best-effort realpath — a recorded path that no longer exists compares verbatim rather than
 * throwing. Exported because both guards compare OTHER recorded paths (feature worktrees) the
 * same way, and two spellings of "best effort" is exactly the drift this module removes. */
export const realish = (p) => { try { return realpathSync(String(p)); } catch { return String(p); } };

/** `org/name` for an index entry — the label a refusal names the matched project by. */
export const projectId = (p) => `${p?.org}/${p?.name}`;

/** Match one MAIN REPOSITORY ROOT against the registered projects.
 * `repoRoot` must already be the main worktree root (see header: the caller derives it through the
 * hardened git seam); it is realpath'd here anyway, so a caller that passes a symlinked spelling
 * cannot silently miss.
 * Returns {kind, indexPath, …} per the header table. NEVER throws for anything the index can do to
 * us: every failure is a `kind` the caller must decide about, because a guard that dies with a
 * stack trace decides nothing. */
export function matchProjectByRepoRoot(repoRoot) {
  const indexPath = projectsIndexPath();
  if (!existsSync(indexPath)) return { kind: 'absent', indexPath };

  let idx;
  try { idx = readJson(indexPath); } catch (e) {
    return { kind: 'unreadable', indexPath, detail: String(e?.message ?? e) };
  }
  if (idx === null || typeof idx !== 'object' || Array.isArray(idx) || !Array.isArray(idx.projects)) {
    return { kind: 'malformed', indexPath, detail: '`projects` is not an array' };
  }

  const target = realish(repoRoot);
  const matches = idx.projects.filter((p) => realish(p?.repoRoot) === target);
  if (matches.length === 0) return { kind: 'unregistered', indexPath };
  if (matches.length > 1) {
    return { kind: 'ambiguous', indexPath, matches, ids: matches.map(projectId).join(', ') };
  }
  return { kind: 'match', indexPath, entry: matches[0], projectId: projectId(matches[0]) };
}
