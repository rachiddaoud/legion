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
// NO IMPORTS BEYOND node:path, DELIBERATELY. viewer.mjs is sealed by test/cli/viewer.test.mjs's
// PROHIBITION scan and `legion setup` reaches this file through viewer-build.mjs, so a leaf with
// nothing behind it is the only shape that both can share: viewer.mjs cannot import viewer-build.mjs
// (that would pull kernel/runner.mjs behind the seal) and viewer-build.mjs must not import
// viewer.mjs (that would pull the whole viewer server into every `legion setup`).
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
