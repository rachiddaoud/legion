// forge.mjs — WHICH FORGE a project's remote lives on: 'gitlab' (driven by glab) or 'github'
// (driven by gh). Until 2026-08-15 the answer was hardwired — "glab is the forge" was a stated
// decision in kernel/ticket.mjs — and this module is the deliberate reversal: two forges exist,
// and the selector is ORDINARY OPERATOR CONFIG, not evidence. Nothing here is pinned into a
// feature, nothing here certifies anything, and a wrong value fails loudly at the moment of use
// (the forge CLI refuses), never silently.
//
// DETECTION IS A CONVENIENCE OVER THE TWO PUBLIC HOSTS, NOT AN ORACLE. github.com and *.ghe.com
// (GitHub's data-residency tenants) are structurally GitHub; every OTHER resolvable host reads
// as GitLab because that is the pre-existing world this module must not move: a self-managed
// GitLab on any domain keeps working with no config at all. The cost, stated: a self-hosted
// GitHub Enterprise Server on its own domain is indistinguishable from a self-managed GitLab by
// URL alone, and the kernel never asks the network which forge a host is — the explicit
// override (`legion project init --forge github`, or a `forge` field in org.json/project.json)
// is the escape hatch, and detection returning 'gitlab' for such a host is the documented
// wrong-by-default that the override exists for.
//
// PURE FUNCTIONS ONLY: no file reads, no subprocess, no imports from the resolver family —
// kernel/ticket.mjs imports THIS module (resolveForge lives there, beside resolveTicketConfig,
// so config levels are read by exactly one reader), never the other way around.

export const FORGES = ['gitlab', 'github'];
export const DEFAULT_FORGE = 'gitlab';

/** THE IDENTITY FACTS, in ONE place. Which id, which CLI binary, what a human calls it — the
 * three things every forge-aware call site needs and none of them should re-state. They lived
 * duplicated in doctor's FORGE_PROBES and finalize's FORGE_OPS until 2026-08-15; two tables
 * keyed by an enum in a third file is three edits to add a forge, with nothing failing if one is
 * missed. `id` is the value written into feature.json's `mr` record and compared against it, so
 * it is never re-derived from `cli` — a renamed binary would silently misclassify the record. */
export const FORGE_IDENTITY = Object.freeze({
  gitlab: Object.freeze({ id: 'gitlab', cli: 'glab', forgeName: 'GitLab' }),
  github: Object.freeze({ id: 'github', cli: 'gh', forgeName: 'GitHub' }),
});

/**
 * BUILD A PER-FORGE TABLE THAT CANNOT BE HALF-WRITTEN. Each call site passes only what is ITS
 * OWN (doctor: the install/login remedies; finalize: the nouns, argv builders and payload
 * mapping) keyed by forge id, and gets back a frozen table carrying those merged over
 * FORGE_IDENTITY — one entry per member of FORGES, by construction rather than by discipline.
 * IT THROWS AT IMPORT TIME on a gap in either direction: a forge in FORGES with no extras, or
 * extras for an id that is not a forge (the typo case). That is deliberately fatal rather than a
 * warning — a kernel that half-knows a forge is one that can drive the wrong CLI at a remote,
 * and the failure surfaces the first time anything imports the module, the test suite included.
 * @param {Record<string, object>} extrasById the call site's own per-forge fields
 * @param {string} where the table's name, quoted in the refusal
 */
export function forgeTable(extrasById, where) {
  const unknown = Object.keys(extrasById).filter((k) => !FORGES.includes(k));
  if (unknown.length > 0) {
    throw new Error(`${where}: entries for unknown forge(s) ${unknown.join(', ')} — one of ${FORGES.join('|')}`);
  }
  const table = {};
  for (const id of FORGES) {
    const extras = extrasById[id];
    if (extras === undefined) {
      throw new Error(`${where}: no entry for forge '${id}' — every forge in FORGES must be covered here`);
    }
    table[id] = Object.freeze({ ...FORGE_IDENTITY[id], ...extras });
  }
  return Object.freeze(table);
}

/** THE HOST a recorded remote URL names. Moved VERBATIM from doctor.mjs's glabHost on
 * 2026-08-15 — it was always forge-neutral; only its name said glab. Handles the three forms a
 * recorded `git remote get-url origin` actually takes: scheme URLs with an optional port and
 * userinfo (`ssh://git@host:2222/a/b.git`, `https://host/a/b.git`) and the scp-like form
 * (`git@host:a/b.git`). Anything without an unambiguous authority ⇒ null ⇒ the caller falls
 * back and SAYS it could not scope: a guessed host would be a verdict about a server nobody
 * asked about. Deliberately NOT dot-requiring — a single-label internal host
 * (`https://gitlab/a/b.git`) is structurally unambiguous here. */
export function remoteHost(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') return null;
  const url = remoteUrl.trim();
  let authority = null;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]+)(?:\/|$)/.exec(url);
  if (scheme) authority = scheme[1];
  // A `://` that the pattern above REFUSED (file:///path) must never fall through to the scp
  // form, which would read a local path's first segment as a host.
  else if (!url.includes('://')) {
    const scp = /^(?:[^@/]+@)?([^@/:]+):/.exec(url);
    if (scp) authority = scp[1];
  }
  if (authority == null) return null;
  const at = authority.lastIndexOf('@'); // userinfo (user:pass@host) — the LAST @ starts the host
  const host = (at === -1 ? authority : authority.slice(at + 1)).replace(/:\d+$/, '').toLowerCase();
  return /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) ? host : null;
}

/** 'github' | 'gitlab' | null from a remote URL (header: detection is a convenience over the
 * two public hosts). null — no resolvable host at all — means the caller falls to
 * DEFAULT_FORGE and says so; it is never guessed into either forge. */
export function detectForge(remoteUrl) {
  const host = remoteHost(remoteUrl);
  if (host === null) return null;
  if (host === 'github.com' || host.endsWith('.ghe.com')) return 'github';
  return 'gitlab';
}

/** ONE definition of a valid forge — the `--forge` flag, org.json and project.json are judged
 * identically (the same rule as validateClosingStyle). Throws naming `where`, never defaults:
 * a silent fallback would point finalize's remote writes at a forge the operator did not pick. */
export function validateForge(value, where) {
  if (typeof value !== 'string' || !FORGES.includes(value)) {
    throw new Error(
      `${where}: invalid forge ${JSON.stringify(value)} — one of ${FORGES.join('|')} `
      + '(which CLI legion drives for the merge request / pull request: glab or gh)',
    );
  }
  return value;
}
