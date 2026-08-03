// branches.mjs — ONE definition of "does this protected-branch PATTERN cover this branch".
// A kernel leaf (no imports at all) because it has two consumers that must never import each
// other: `legion doctor`'s server-side protection check (src/cli/doctor.mjs, which owns the
// whole GitLab-facing verdict) and the local pre-push guard (hooks/pre-push.mjs, remote-safety
// layer 3), which runs on every push and therefore must not drag the CLI's import graph —
// feature/gate/state — into a git hook. It lived in doctor.mjs until T25; doctor still exports
// it, so nothing that imported it from there changed.
// WHY A SHARED DEFINITION AND NOT A SECOND COPY: the two consumers answer the same question
// about the same recorded set (`project.json`'s protectedBranches), and a guard whose matching
// is LOOSER than doctor's would refuse pushes doctor calls fine, while a guard that is TIGHTER
// would wave through exactly the branch doctor reports as protected. Either divergence turns
// a layered story into two contradictory ones.

/** GitLab protected-branch names may be wildcards (`release/*`). Everything except `*` is
 * escaped and the match is anchored, so `release/*` matches `release/1.0` and `mainX` never
 * matches `main`. */
export function branchPatternMatches(pattern, branch) {
  const rx = String(pattern).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${rx}$`).test(branch);
}
