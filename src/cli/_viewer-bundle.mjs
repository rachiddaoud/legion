// _viewer-bundle.mjs — THE ONE ANSWER to "is the frontend bundle built?", shared by the command
// that BUILDS it (viewer-build.mjs) and the command that SERVES it (viewer.mjs).
//
// WHY THIS IS A MODULE AND NOT A ONE-LINER IN EACH. The two commands answering that question
// differently is a silent trap with no floor: `viewer/dist` existing is NOT the same fact as the
// bundle being usable. vite's build leaves `emptyOutDir` at its default (true), so it DELETES
// dist/ and then refills it — and anything landing in that window (Ctrl-C on a build the terminal
// makes look frozen, the build timeout's SIGKILL, a full disk) leaves the directory present and
// empty. Under a directory-existence predicate that state reads as "built" to both commands at
// once: `legion viewer` starts and serves a blank page, and `legion viewer-build` — the exact
// remedy the refusal names — reports "already built" and exits 0 having done nothing. The
// operator's only escape would be a flag neither message mentions.
//
// index.html IS the right question because it is what _viewer/server.mjs actually serves (its
// static branch joins it by name), and because vite writes it LAST — it is the build's own
// completion marker. test/viewer/browser.test.mjs and test/viewer/budgets.test.mjs already gated
// on exactly this file before either command existed; this module is that predicate given a name
// rather than a third copy of it.
//
// READ-ONLY IMPORTS ONLY, DELIBERATELY. viewer.mjs is sealed by test/cli/viewer.test.mjs's
// PROHIBITION scan (which scans THIS file too) and `legion setup` reaches this file through
// viewer-build.mjs, so a leaf with nothing mutating behind it is the only shape that both can
// share: viewer.mjs cannot import viewer-build.mjs (that would pull kernel/runner.mjs behind the
// seal) and viewer-build.mjs must not import viewer.mjs (that would pull the whole viewer server
// into every `legion setup`). node:fs appears here for READS alone (readdirSync/readFileSync)
// and node:crypto for hashing — the scan's write-call tripwire holds.
//
// THE STALENESS QUESTION LIVES HERE FOR THE SAME REASON THE BUILT QUESTION DOES: `legion viewer`
// must be able to ANSWER "was this bundle built from these sources?" (to warn before serving a
// stale one) with exactly the machinery `legion viewer-build` uses to DECIDE it — two definitions
// of "stale" would be the same silent trap as two definitions of "built". Writing the stamp stays
// in viewer-build.mjs, behind the seal.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** vite's entry point, and the build's completion marker (header). */
export const BUNDLE_ENTRY = 'index.html';

/** The file whose presence means "built". */
export function bundleEntry(distDir) {
  return join(distDir, BUNDLE_ENTRY);
}

/** The predicate itself. `exists` is injected so both callers stay testable without a real build. */
export function bundleBuilt(exists, distDir) {
  return exists(bundleEntry(distDir));
}

/** The build stamp, IN dist (viewer-build.mjs header: STALENESS). One line: the source digest
 * the bundle was built from. In dist because vite empties dist before refilling it — an
 * interrupted rebuild destroys the stale stamp along with the stale bundle. */
export const STAMP_FILE = '.legion-build-stamp';

/** Names excluded from the digest walk at any depth: filesystem litter no build reads. */
const DIGEST_EXCLUDES_ANY = new Set(['.DS_Store']);
/** Top-level exclusions: outputs and other package managers' litter, not bundle inputs. dist/ is
 * what the build writes; node_modules/ is what `npm ci` materializes from the lockfile (which IS
 * hashed); the pnpm files are the local-convenience artifacts the repo .gitignore anticipates —
 * hashing any of these would be either a 200MB walk or a spurious multi-minute rebuild. */
const DIGEST_EXCLUDES_TOP = new Set(['dist', 'node_modules', 'pnpm-lock.yaml', 'pnpm-workspace.yaml']);

/** The bundle's INPUTS: every file under viewer/, sorted, as relative paths — minus the
 * exclusions above. THROWS on a symlink, deliberately: Dirent cannot see through it, vite can,
 * so a digest that silently skipped it could report "up to date" over changed content — the one
 * failure direction the staleness machinery promises never to take. The caller maps the throw to
 * digest:null, the honest "unanswerable" fallback. EXPORTED for its own determinism test. */
export function listViewerSources(viewerDir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(rel === '' ? viewerDir : join(viewerDir, rel), { withFileTypes: true })) {
      if (DIGEST_EXCLUDES_ANY.has(entry.name)) continue;
      if (rel === '' && DIGEST_EXCLUDES_TOP.has(entry.name)) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new Error(`symlink at ${childRel} — the source digest cannot see through symlinks`);
      }
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out.sort();
}

/** sha256 over `relPath NUL bytes NUL` in sorted order. The path is part of the hash input on
 * purpose: a rename with identical bytes IS a different bundle input (vite resolves by path).
 * Throws on any unreadable entry — the CALLER maps that to digest:null and the fallback semantics. */
export function computeSourceDigest(viewerDir, { listSources = listViewerSources, readFile = readFileSync } = {}) {
  const hash = createHash('sha256');
  for (const rel of listSources(viewerDir)) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFile(join(viewerDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}
