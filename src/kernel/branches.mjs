// branches.mjs — ONE definition of "does this protected-branch PATTERN cover this branch".
// A kernel leaf (no imports at all). Its consumer is `legion doctor`'s server-side protection
// check (src/cli/doctor.mjs, which owns the whole GitLab-facing verdict and re-exports this for
// its importers). It lived in doctor.mjs until T25 and was split out because the local pre-push
// guard (remote-safety layer 3) was its second consumer, kept in lockstep by sharing the file;
// that guard was REMOVED 2026-08-07 (server-only decision — src/kernel/githooks.mjs header), and
// the server is now the only enforcement of these semantics. The leaf stays a leaf: the split
// costs nothing and the next consumer, if one appears, must not drag the CLI graph in either.

/** GitLab protected-branch names may be wildcards (`release/*`). Everything except `*` is
 * escaped and the match is anchored, so `release/*` matches `release/1.0` and `mainX` never
 * matches `main`. */
export function branchPatternMatches(pattern, branch) {
  const rx = String(pattern).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${rx}$`).test(branch);
}
