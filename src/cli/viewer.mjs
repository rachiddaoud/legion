// viewer.mjs — `legion viewer [--port n] [--host addr] [--api-only] [--org org]`. Starts the
// GET/HEAD-only loopback server in _viewer/server.mjs
// over the read-only projection in _viewer/projection.mjs, and does nothing else.
//
// THE VIEWER IS DISPOSABLE, AND THIS FILE IS THE PROOF OF IT: it opens a socket, prints a URL and
// waits. It writes no file, takes no lock, records no session, registers no PID and leaves nothing
// behind — legion works identically with it closed, killed or deleted. Nothing under LEGION_HOME
// is touched, by this command or by anything it reaches.
//
// SHAPE (doctor.mjs's pattern): viewerCore(argv, deps) resolves and VALIDATES everything, writes
// nothing and returns {port, host, org, apiOnly, distDir, warnings, refusal}; run(argv) is the thin
// shell that prints, listens and waits. Every refusal is therefore testable without a socket, and
// the pinned dist-missing text is asserted through an injected `exists` rather than by deleting a
// build directory out from under a parallel test run.
//
// THE DIST PATH COMES FROM import.meta.url, NEVER cwd. `legion viewer` is run from a feature
// worktree far more often than from this checkout, and a cwd-relative
// bundle path would either serve nothing or — worse — serve whatever `./viewer/dist` happened to
// be in the operator's project.
//
// NO SILENT DEGRADATION WHEN THE BUNDLE IS ABSENT. `viewer/dist` is gitignored and built on demand,
// so "missing" is the ordinary first-run state and not a defect — but answering it by quietly
// serving the JSON API and a blank page is how an operator spends ten minutes on a white screen.
// The refusal names the exact two commands that fix it, and `--api-only` is the explicit way to
// ask for the API alone. Exit 1: a viewer that did not start must never look like one that did.
//
// A NON-LOOPBACK --host IS HONOURED AND ANNOUNCED. It is the operator's machine and their call
// (single-operator threat model), but the thing being exposed is the read-only state of every
// feature registered on it, so it costs one loud stderr line. The bind address also switches OFF
// the server's loopback Host check (server.mjs header), which is the other half of the same choice.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../kernel/args.mjs';
import { safeSegment } from '../kernel/paths.mjs';
import { bundleBuilt, readBundleEvidence } from './_viewer-bundle.mjs';
import { createViewerServer } from './_viewer/server.mjs';

const USAGE = 'legion viewer [--port <n>] [--host <addr>] [--api-only] [--org <org>]';

/** Port kept: an operator who has run both should not have to remember two numbers. */
export const DEFAULT_PORT = 4600;
/** LOOPBACK BY DEFAULT, always. Everything this server serves is local state. */
export const DEFAULT_HOST = '127.0.0.1';

/** src/cli/viewer.mjs → the plugin root → viewer/dist. Derived from THIS file (header). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DEFAULT_DIST = join(REPO_ROOT, 'viewer', 'dist');

/** The flag surface, exhaustive. An unlisted flag is a typo or a flag from another command, and
 * either way starting a server that quietly ignored it is worse than refusing. */
const KNOWN_FLAGS = ['port', 'host', 'api-only', 'org'];

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|::1|\[::1\]|0:0:0:0:0:0:0:1)$/i;

/** THE dist-missing refusal, one definition, pinned by test/cli/viewer.test.mjs. It names the
 * directory that is missing, the ONE command that creates it, the by-hand form of that command,
 * and the flag that says "I meant the API alone" — a refusal an operator cannot act on is a
 * refusal that gets worked around. `legion viewer-build` leads because the remedy having a single
 * deterministic name is what keeps it out of prose: src/cli/viewer-build.mjs's header explains why
 * the build is a sibling command here and not a `--build` flag on this one. */
export function distRefusal(distDir) {
  return `legion viewer: the frontend bundle is missing at ${distDir}\n`
    + '  build it once:  legion viewer-build\n'
    + `  or by hand:     cd ${join(REPO_ROOT, 'viewer')} && npm ci && npm run build\n`
    + '  or serve the read-only JSON API alone:  legion viewer --api-only\n'
    + '(the bundle is gitignored and built on demand — nothing is broken, it has just never been built here)\n';
}

/** The stale-bundle warning: a WARNING and not a refusal, deliberately. A bundle built from
 * older sources still WORKS — refusing it would take the viewer away exactly when the operator
 * wants to look at something — but serving it silently is the degradation the marketplace
 * auto-pull makes routine (Claude Code pulls new viewer/ sources under a built dist and nothing
 * else would say so). Read-only: the CHECK is answered by _viewer-bundle.mjs's digest machinery,
 * behind this file's seal; the FIX stays `legion viewer-build`. */
export function staleWarning(distDir) {
  return `legion viewer: the bundle at ${distDir} was built from OLDER viewer/ sources — serving it anyway; `
    + 'run `legion viewer-build` to refresh it\n';
}

/** Is the built bundle at `distDir` stale against its own viewer/ sources? Answered with
 * viewer-build's definition (the _viewer-bundle.mjs digest vs the stamp in dist); viewer/ is
 * dist's parent by construction. Every UNANSWERABLE branch — unreadable tree, missing or
 * unreadable stamp (the pre-stamp install) — returns false, deliberately: an unknown is an
 * unknown, and a warning that fired on every pre-stamp install would teach operators to ignore
 * it. Called from run(), not viewerCore, so the pure core stays independent of the real
 * filesystem the digest must read. EXPORTED for its own test. */
export function bundleStale(distDir, { listSources = undefined, readFile = readFileSync } = {}) {
  // ONE measurement, shared with viewerBuildCore (readBundleEvidence) — this file only supplies
  // the POLICY: both nulls are unknowns, and an unknown is not a warning.
  const opts = listSources === undefined ? { readFile } : { listSources, readFile };
  const { digest, stampDigest } = readBundleEvidence(dirname(distDir), distDir, opts);
  return digest !== null && stampDigest !== null && digest !== stampDigest;
}

/** The exposure warning for a non-loopback bind, one definition (header). */
export function exposureWarning(host) {
  return `legion viewer: binding to ${host}, which is NOT loopback — the read-only state of every `
    + 'feature registered on this machine (manifests, artifacts, diffs) becomes reachable from the '
    + 'network, and the loopback Host check is off. Re-run without --host to stay on 127.0.0.1.\n';
}

/** A TCP port, or a refusal. 0 is legitimate and means "any free port" — the tests bind on it, and
 * so may an operator running two viewers. */
function parsePort(raw) {
  if (raw === undefined) return DEFAULT_PORT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    throw new Error(`--port must be an integer 0-65535, got '${raw}'. usage: ${USAGE}`);
  }
  return n;
}

/**
 * The testable core. Writes NOTHING, opens NOTHING, and returns everything run() needs.
 * @param {string[]} argv unsplit argv (kernel/args.mjs invariant)
 * @param {{exists?: Function, distDir?: string}} deps
 */
export function viewerCore(argv, { exists = existsSync, distDir = DEFAULT_DIST } = {}) {
  const { flags, positional } = parseArgs(argv, { bools: ['api-only'] });
  // Usage errors die BEFORE anything is resolved: a typo must not be answered with a server.
  if (positional.length > 0) {
    throw new Error(`unexpected argument '${positional[0]}'. usage: ${USAGE}`);
  }
  for (const name of Object.keys(flags)) {
    if (!KNOWN_FLAGS.includes(name)) throw new Error(`unknown flag '--${name}'. usage: ${USAGE}`);
  }
  const port = parsePort(flags.port);
  const host = flags.host ?? DEFAULT_HOST;
  if (typeof host !== 'string' || host.trim() === '') {
    throw new Error(`--host must be a non-empty address. usage: ${USAGE}`);
  }
  const apiOnly = flags['api-only'] === true;
  // A typo'd org would otherwise render as an empty inventory that looks like an empty machine —
  // the kernel's own segment guard says so instead.
  const org = flags.org === undefined ? null : safeSegment(flags.org, 'org');

  const warnings = LOOPBACK.test(host) ? [] : [exposureWarning(host)];
  // index.html, NOT the directory: an interrupted build leaves dist/ present and empty, and
  // starting on that serves a blank page — the exact silent degradation this file refuses
  // everywhere else. One predicate, shared with `legion viewer-build` (_viewer-bundle.mjs).
  const haveDist = bundleBuilt(exists, distDir);
  return {
    port,
    host,
    org,
    apiOnly,
    // --api-only serves NO frontend even when one is built: the flag means what it says.
    distDir: apiOnly ? null : distDir,
    haveDist,
    warnings,
    refusal: apiOnly || haveDist ? null : distRefusal(distDir),
  };
}

/** The URL line: an IPv6 literal needs brackets, and a wildcard bind is named as one rather than
 * printed as a link that does not resolve. */
function urlFor(host, port) {
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `http://${shown.includes(':') ? `[${shown}]` : shown}:${port}/`;
}

export async function run(argv) {
  const cfg = viewerCore(argv);
  for (const w of cfg.warnings) process.stderr.write(w);
  if (cfg.refusal !== null) {
    process.stderr.write(cfg.refusal);
    return 1;
  }
  // The stale check runs HERE, against the real tree (bundleStale's docblock): a bundle built
  // from older sources still serves, but never silently.
  if (cfg.distDir !== null && cfg.haveDist && bundleStale(cfg.distDir)) {
    process.stderr.write(staleWarning(cfg.distDir));
  }

  const server = createViewerServer({ distDir: cfg.distDir, org: cfg.org, host: cfg.host });
  await new Promise((resolve, reject) => {
    server.once('error', reject);            // EADDRINUSE dies loudly through the router
    server.listen(cfg.port, cfg.host, resolve);
  });
  const { port } = server.address();
  process.stdout.write(
    `${urlFor(cfg.host, port)}\n`
    + `legion viewer: read-only projection, GET/HEAD only, ${cfg.distDir === null ? 'JSON API only (--api-only)' : `bundle ${cfg.distDir}`}`
    + `${cfg.org === null ? ' (all orgs)' : ` (org ${cfg.org})`} — Ctrl-C to stop\n`,
  );

  // CLEAN SHUTDOWN. closeAllConnections first: a browser holds keep-alive sockets open, and
  // server.close() alone waits for them, which reads at the terminal as a hung Ctrl-C.
  await new Promise((resolve) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      server.closeAllConnections?.();
      server.close(() => resolve());
    };
    for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, stop);
    server.once('close', resolve);
  });
  return 0;
}
