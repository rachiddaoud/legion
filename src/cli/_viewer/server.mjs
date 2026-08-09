// server.mjs — the viewer's GET/HEAD-only loopback HTTP surface over the projection. node:http,
// no dependencies, no daemon: it dies with the process, owns no state, and legion works
// identically with it closed.
//
// THIS SURFACE HAS NO MUTATION PATH, STRUCTURALLY: there is no commands table and nothing like
// `execFile(bin/legion.mjs …)` behind it, no /api/answer, /api/command or /api/watchdog/start, no
// per-process CSRF token, no `rejectMutation`, no `actionsOf`/`recoveryOf` workflow affordances, no
// SSE /api/events stream, no run registry and no PID liveness. There is no POST route to guard,
// and the method guard below refuses one anyway.
//
// THE METHOD GUARD IS THE FIRST STATEMENT OF THE HANDLER, BEFORE ANY ROUTING, and that ordering is
// the invariant rather than an implementation detail: a future route added carelessly cannot
// become writable, because nothing but GET and HEAD ever reaches the router. Anything else is 405
// with `Allow: GET, HEAD`. test/cli/viewer.test.mjs walks EVERY route in ROUTES with
// POST/PUT/DELETE/PATCH and pins that.
//
// THE SERVER DERIVES NOTHING. Every JSON body below is a projection call rendered verbatim
// (featureSummaries / featureView / activityFeed / insights). There is no status vocabulary here,
// no attention rule, no statistic, no cache and no cross-request memory: the process is STATELESS
// and recomputes per request, so freshness is the client's polling interval and nothing else.
// The two things the server DOES own are the two the projection deliberately refuses: HTTP, and
// the hardened git reads (the projection never spawns — activity.mjs's header says why), which
// travel back INTO the projection through its `readCommits` injection so even the git verdict is
// rendered by the one module that owns the DTO shape.
//
// EVERY GIT INVOCATION GOES THROUGH src/kernel/git.mjs. Nothing here imports node:child_process.
// `git()` inside a try (readGit below) rather than gitTry() wherever the FAILURE TEXT is part of
// the honest answer — gitTry swallows it, and "unavailable" without a reason would be exactly the
// kind of guessed-into-valid-looking-state this file avoids. A missing/pruned worktree, an
// unparseable baseSha and a failed range read are all HTTP 200 with `{available:false, reason}`: a
// typed degraded read is not a server error, and rendering it as one would make an ordinary
// `legion feature clean` look like a broken viewer.
//
// SECURITY POSTURE, single-operator loopback tool (threat model: agent error and drift, not a
// hostile operator):
//   - LOOPBACK HOST CHECK, load-bearing FOR READS here. Loopback is not a trust
//     boundary for browsers: a hostile page cannot READ a no-CORS response, but DNS rebinding
//     makes it same-origin and then it can. On a loopback bind every request must NAME a loopback
//     host or it is refused 403. On an explicit non-loopback bind the check is off (the operator
//     asked for reachability, and `legion viewer` warned them in words).
//   - TRAVERSAL: the artifact and static readers both resolve realpath on BOTH sides and require
//     containment under their root with a separator, so a symlink inside a dossier pointing at
//     ~/.ssh is refused rather than served. Absolute paths, `..` segments, dotfiles and NUL bytes
//     die at the parse, before any filesystem call.
//   - EXTENSION ALLOWLIST + SIZE CAPS on artifacts. `.svg` is deliberately NOT servable as an
//     artifact (an SVG is a script container and artifacts are model-authored), while dist may
//     legitimately contain build-emitted SVG — two different trust levels, two different tables.
//     `.html` (dossier mocks, mockups/ only) IS servable, but only under SANDBOX_CSP: the
//     `sandbox` directive without allow-same-origin gives the document an opaque origin (cannot
//     READ this API) and its fetch directives deny egress (cannot SEND anything anywhere) — a
//     third trust level between the two, with the mono-file mock rule enforced, not just stated.
//   - CSP + nosniff on everything. `form-action` is 'none': there is no form and no endpoint that
//     could accept one, so the header should say so.
import { createServer } from 'node:http';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, normalize, sep } from 'node:path';
import { git, gitTry } from '../../kernel/git.mjs';
import { featureDir, legionHome, safeSegment } from '../../kernel/paths.mjs';
import {
  ACTIVITY_FEED_LIMIT, activityFeed, featureSummaries, featureView, insights,
} from './projection.mjs';

/** THE route table, exhaustive and EXPORTED so the prohibition test can walk it programmatically
 * rather than re-typing a list that would drift. Order is irrelevant (exact-match dispatch); the
 * static handler is not a route and is reached only when none of these matched. */
export const ROUTES = [
  '/api/health', '/api/features', '/api/feature', '/api/activity',
  '/api/commits', '/api/diff', '/api/artifact', '/api/insights',
];

/** The only methods that reach the router. HEAD is here because node's ServerResponse suppresses
 * the body for it automatically, so every handler below stays single-path. */
export const ALLOWED_METHODS = ['GET', 'HEAD'];

/** `form-action` is 'none' (header). 'unsafe-inline' styles are required by mermaid's generated
 * SVG and by nothing else. */
export const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; "
  + "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** The CSP for a `.html` artifact (a dossier mock), TWO defenses that fail independently:
 * `sandbox` WITHOUT allow-same-origin puts the document in an opaque origin — its scripts run
 * (mocks are interactive; forms/popups/modals allowed, all safe without same-origin — but note
 * storage APIs THROW there) so it cannot READ this API; and the fetch directives deny egress
 * outright (`default-src 'none'`, inline script/style and data: assets only), so a mock built
 * from injected text cannot SEND dossier content anywhere either. This is the mono-file mock
 * rule (skills/feature SKILL.md) made mechanical. `frame-ancestors 'self'` (not 'none') so the
 * viewer's own iframe may embed it. */
export const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline'; "
  + "style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; "
  + "connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; "
  + "frame-ancestors 'self'; sandbox allow-scripts allow-forms allow-popups allow-modals";

const LOOPBACK = /^(127(\.\d{1,3}){3}|localhost|\[::1\]|::1|\[::ffff:127(\.\d{1,3}){3}\])$/i;
const hostnameOf = (hostHeader) => String(hostHeader || '').replace(/:\d+$/, '');

/** THE artifact allowlist — model- and operator-authored dossier files. No `.svg` (header).
 * The per-extension TRUST decision lives here and nowhere else: an entry without `csp` is served
 * under the viewer's own CSP; `.html` carries SANDBOX_CSP and an `under` prefix (dossier mocks
 * live in mockups/ — an .html that lands anywhere else in a dossier is refused, so this change
 * never widens what the rest of the dossier may execute). The client mirrors the extension set
 * in viewer/src/lib/artifact-url.mjs (isHtml/IMAGE_EXTENSIONS), pinned by its tests. */
const ARTIFACT_TYPES = {
  '.md': { type: 'text/markdown; charset=utf-8' },
  '.txt': { type: 'text/plain; charset=utf-8' },
  '.json': { type: 'application/json; charset=utf-8' },
  '.html': { type: 'text/html; charset=utf-8', csp: SANDBOX_CSP, under: 'mockups/' },
  '.png': { type: 'image/png' },
  '.jpg': { type: 'image/jpeg' },
  '.jpeg': { type: 'image/jpeg' },
  '.webp': { type: 'image/webp' },
};
const TEXT_CAP = 2 * 1024 * 1024;
const IMAGE_CAP = 10 * 1024 * 1024;
const isImage = (type) => type.startsWith('image/');

/** Static asset types — OUR OWN build output, a different trust level from an artifact. */
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
};

/** The ceiling for a feature-sized `git diff`, mirroring gate.mjs's DIFF_MAX_BUFFER: spawnSync's
 * 1 MiB default surfaces as an opaque ENOBUFS, i.e. a read that DIED looking like a repository
 * with no changes. Same number, same reason. */
const DIFF_MAX_BUFFER = 64 * 1024 * 1024;

/** A recorded base sha, shape-checked before it is ever passed to git as a revision. The manifest
 * is kernel-written, so this is not a distrust of the operator (there is no hostile one) — it is
 * the fail-closed rule: a hand-edited `baseSha` that happens to read as an option must become an
 * honest `{available:false, reason}` rather than an argument to `git log`. */
const SHA_RE = /^[0-9a-fA-F]{7,64}$/;

/** THE diff flags, and `--no-ext-diff` is LOAD-BEARING rather than defensive: the kernel seam pins
 * `-c diff.external=` (GIT_PIN_ARGS), and an EMPTY diff.external makes plain `git diff` try to run
 * a command named '' — measured here as `error: cannot run : No such file or directory / fatal:
 * external diff died`, i.e. a read that DIES looking like a repository with no changes. gate.mjs's
 * DIFF_FORMAT carries the same flag for the same reason; this is that list minus `--text`, which
 * gate needs (its scanner must see inside a file marked binary) and a viewer must not (dumping a
 * PNG into a diff pane as text is not a rendering, it is a hang). `--no-renames` + the explicit
 * a/ b/ prefixes keep one path per section, which is what the ported client diff view parses. */
const DIFF_FORMAT = [
  '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/',
];

// --- response helpers ---------------------------------------------------------------------------

const BASE_HEADERS = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' };

function json(res, code, body) {
  res.writeHead(code, { ...BASE_HEADERS, 'content-type': 'application/json; charset=utf-8' });
  res.end(`${JSON.stringify(body)}\n`);
}

// --- the hardened git reads (the ONLY thing here the projection cannot do) -------------------------

/** git() inside a try so the MESSAGE survives (header). `{ok:true,out}` / `{ok:false,why}`. */
function readGit(args, cwd, opts) {
  try { return { ok: true, out: git(args, cwd, opts) }; }
  catch (err) { return { ok: false, why: err.message }; }
}

/** THE range read: the commits on this feature's worktree since its recorded base. Returns the
 * seam's typed result — `{available, reason?, commits, head?, baseSha?}` — and is handed straight
 * to featureView's `readCommits` injection, so the DTO's `git` block is this verdict verbatim.
 * EVERY unavailable branch NAMES ITS REASON: an absent worktree is the ordinary aftermath of
 * `legion feature clean`, a missing baseSha is a pre-start manifest, and a failed range is usually
 * a base commit that no longer exists after a rebase. Guessing "no commits" for any of them would
 * render an empty Changes tab that looks like a feature which changed nothing. */
export function readFeatureCommits({ worktree, baseSha } = {}) {
  const none = (reason) => ({ available: false, reason, commits: [] });
  if (typeof worktree !== 'string' || worktree.length === 0) {
    return none('feature.json records no worktree path, so there is no checkout to read git in');
  }
  if (!existsSync(worktree)) {
    return none(`the recorded worktree ${worktree} is absent — pruned by \`legion feature clean\`, or removed by hand`);
  }
  if (typeof baseSha !== 'string' || !SHA_RE.test(baseSha)) {
    return none(`feature.json records no usable baseSha (${JSON.stringify(baseSha ?? null)}), so there is no range to read`);
  }
  const head = gitTry(['rev-parse', 'HEAD'], worktree);
  if (head === null) {
    return none(`\`git rev-parse HEAD\` found no HEAD in ${worktree} — not a checkout, or an unborn branch`);
  }
  // %x1f (unit separator) cannot occur in a sha or an ISO date and is vanishingly unlikely in a
  // subject; a subject that did contain one loses only the tail of its own row.
  const r = readGit(['log', '--format=%H%x1f%aI%x1f%s', `${baseSha}..HEAD`], worktree, { maxBuffer: DIFF_MAX_BUFFER });
  if (!r.ok) return { ...none(`the range ${baseSha}..HEAD could not be read: ${r.why}`), head };
  const commits = r.out.split('\n').filter(Boolean).map((line) => {
    const [sha, at, ...rest] = line.split('\x1f');
    return { sha, at, subject: rest.join('\x1f') };
  });
  return { available: true, commits, head, baseSha };
}

/** The per-file (or whole-range) diff, same seam and same typed degradation. `file` is passed
 * AFTER `--` so a path can never be read as an option. */
function readFeatureDiff({ worktree, baseSha }, file) {
  const base = readFeatureCommits({ worktree, baseSha });
  if (!base.available) return { available: false, reason: base.reason, files: [], diff: null, file: file ?? null };
  const range = `${baseSha}..HEAD`;
  const names = readGit(['diff', ...DIFF_FORMAT, '--name-status', range], worktree, { maxBuffer: DIFF_MAX_BUFFER });
  if (!names.ok) return { available: false, reason: `\`git diff --name-status ${range}\` failed: ${names.why}`, files: [], diff: null, file: file ?? null };
  const files = names.out.split('\n').filter(Boolean).map((line) => {
    const [status, ...rest] = line.split('\t');
    return { status, path: rest.join('\t') };
  });
  const argv = ['diff', ...DIFF_FORMAT, range, ...(file == null ? [] : ['--', file])];
  const body = readGit(argv, worktree, { maxBuffer: DIFF_MAX_BUFFER });
  if (!body.ok) return { available: false, reason: `\`git ${argv.join(' ')}\` failed: ${body.why}`, files, diff: null, file: file ?? null };
  return { available: true, baseSha, head: base.head, files, file: file ?? null, diff: body.out };
}

// --- request parsing ------------------------------------------------------------------------------

/** org/project/name off the query string, shape-checked with the kernel's OWN segment guard so a
 * bad identity is a 400 that NAMES what was wrong rather than an unreadable row or a stack trace.
 * Returns `{ok:true, org, project, name}` or `{ok:false, code, error}`. */
function identity(q) {
  const org = q.get('org');
  const project = q.get('project');
  const name = q.get('name');
  for (const [what, v] of [['org', org], ['project', project], ['name', name]]) {
    if (v == null || v === '') return { ok: false, code: 400, error: `missing required query parameter '${what}' — /api/… needs org, project and name` };
    try { safeSegment(v, what); }
    catch (err) { return { ok: false, code: 400, error: err.message }; }
  }
  return { ok: true, org, project, name };
}

/** A dossier-relative artifact path, refused BEFORE any filesystem call. Every rule here is a
 * parse rule, not a probe: absolute paths, `..` anywhere, a leading dot on any segment (dotfiles),
 * and NUL bytes. `path` arrives already percent-decoded by URLSearchParams, so `..%2f` is `../`
 * by the time it is seen here — the check must therefore be on segments, never on the raw text. */
function artifactRelPath(raw) {
  if (raw == null || raw === '') return { ok: false, code: 400, error: "missing required query parameter 'path' (dossier-relative)" };
  if (raw.includes('\0')) return { ok: false, code: 400, error: 'path contains a NUL byte' };
  if (isAbsolute(raw)) return { ok: false, code: 400, error: `path must be dossier-relative, got the absolute path ${raw}` };
  const segments = raw.split(/[/\\]+/).filter((s) => s !== '' && s !== '.');
  if (segments.length === 0) return { ok: false, code: 400, error: 'path names no file' };
  for (const s of segments) {
    if (s === '..') return { ok: false, code: 400, error: `path escapes the dossier ('..' segment in ${raw})` };
    if (s.startsWith('.')) return { ok: false, code: 400, error: `dotfiles are not served (segment '${s}')` };
  }
  return { ok: true, rel: segments.join(sep) };
}

/** realpath BOTH sides, containment with a separator. The one containment rule in this file, used
 * by the artifact reader and the static reader alike — two copies of a traversal guard is how one
 * of them ends up subtly weaker. `null` when it escapes or cannot be resolved. */
function containedRealpath(root, abs) {
  let realRoot;
  let real;
  try { realRoot = realpathSync(root); real = realpathSync(abs); }
  catch { return null; }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) return null;
  return real;
}

// --- the server -----------------------------------------------------------------------------------

/**
 * The whole HTTP surface. `distDir` null ⇒ `--api-only` (no static handler exists at all, so an
 * asset request 404s honestly instead of falling through to something). `org` is the CLI's pinned
 * scope: when set it WINS over `?org=`, because that is what asking for a scope means; when unset
 * the query decides and absent means every org (the display-only cross-org read).
 * `host` is the BIND address, and is only used to decide whether the loopback Host check applies.
 */
export function createViewerServer({ distDir = null, org = null, host = '127.0.0.1' } = {}) {
  // Resolved ONCE, loudly: a dist directory that does not exist is a caller error, and resolving
  // it per request would let a mid-flight symlink swap change what "inside dist" means.
  const dist = distDir == null ? null : realpathSync(distDir);
  const loopbackBind = LOOPBACK.test(String(host));
  const scoped = (q) => org ?? (q.get('org') || null);

  const server = createServer((req, res) => {
    // THE METHOD GUARD, FIRST, BEFORE ANY ROUTING (header). Nothing below can mutate anything, and
    // this is what keeps that true of code nobody has written yet.
    if (!ALLOWED_METHODS.includes(req.method)) {
      res.writeHead(405, { ...BASE_HEADERS, allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' });
      res.end(`${JSON.stringify({
        error: `method ${req.method} is not allowed — the legion viewer is a read-only projection and serves GET and HEAD only`,
        allow: ALLOWED_METHODS,
      })}\n`);
      return;
    }

    const [rawPath, query] = String(req.url || '/').split('?');
    const q = new URLSearchParams(query || '');
    try {
      // DNS-rebinding defense on a loopback bind (header).
      if (loopbackBind && !LOOPBACK.test(hostnameOf(req.headers.host))) {
        json(res, 403, { error: `forbidden Host header ${JSON.stringify(req.headers.host ?? null)} — this viewer is bound to loopback and answers loopback names only` });
        return;
      }

      if (rawPath === '/api/health') {
        json(res, 200, { ok: true, v: 1, mode: 'legion3', legionHome: legionHome(), readOnly: true, methods: ALLOWED_METHODS });
        return;
      }

      if (rawPath === '/api/features') {
        json(res, 200, { v: 1, ...featureSummaries({ org: scoped(q) }) });
        return;
      }

      if (rawPath === '/api/insights') {
        json(res, 200, { v: 1, ...insights({ org: scoped(q) }) });
        return;
      }

      if (rawPath === '/api/activity') {
        const raw = q.get('limit');
        const limit = raw == null || raw === '' ? ACTIVITY_FEED_LIMIT : Number(raw);
        if (!Number.isInteger(limit) || limit < 0) {
          json(res, 400, { error: `limit must be a non-negative integer, got ${JSON.stringify(raw)}` });
          return;
        }
        json(res, 200, { v: 1, ...activityFeed({ org: scoped(q), limit }) });
        return;
      }

      if (rawPath === '/api/feature') {
        const id = identity(q);
        if (!id.ok) { json(res, id.code, { error: id.error }); return; }
        let view;
        try {
          // readCommits is the hardened seam handed INTO the projection (projection.mjs docblock):
          // one dossier read, and the git verdict rendered by the module that owns the DTO.
          view = featureView({ org: id.org, project: id.project, name: id.name, readCommits: readFeatureCommits });
        } catch (err) {
          // A feature that does not exist is a caller error — 404 naming what was asked. A feature
          // that exists but cannot be READ never reaches here: the projection returns the
          // unreadable ROW and it is served 200, which is the inventory contract.
          json(res, 404, { error: err.message, asked: { org: id.org, project: id.project, name: id.name } });
          return;
        }
        json(res, 200, { v: 1, feature: view });
        return;
      }

      if (rawPath === '/api/commits' || rawPath === '/api/diff') {
        const id = identity(q);
        if (!id.ok) { json(res, id.code, { error: id.error }); return; }
        let view;
        try {
          view = featureView({ org: id.org, project: id.project, name: id.name });
        } catch (err) {
          json(res, 404, { error: err.message, asked: { org: id.org, project: id.project, name: id.name } });
          return;
        }
        if (view.unreadable) { json(res, 200, { v: 1, ...view, available: false, reason: view.why }); return; }
        const where = { worktree: view.worktree.path, baseSha: view.baseSha };
        if (rawPath === '/api/commits') {
          json(res, 200, { v: 1, ...readFeatureCommits(where) });
          return;
        }
        const file = q.get('file');
        json(res, 200, { v: 1, ...readFeatureDiff(where, file == null || file === '' ? null : file) });
        return;
      }

      if (rawPath === '/api/artifact') {
        const id = identity(q);
        if (!id.ok) { json(res, id.code, { error: id.error }); return; }
        const rel = artifactRelPath(q.get('path'));
        if (!rel.ok) { json(res, rel.code, { error: rel.error }); return; }
        const dossier = featureDir(id.org, id.project, id.name); // segments already guarded
        if (!existsSync(dossier)) {
          json(res, 404, { error: `no dossier at ${dossier} — feature ${id.org}/${id.project}/${id.name} does not exist on this machine` });
          return;
        }
        const abs = normalize(join(dossier, rel.rel));
        if (!existsSync(abs) || statSync(abs).isDirectory()) {
          json(res, 404, { error: `no artifact '${rel.rel}' in the dossier of ${id.org}/${id.project}/${id.name}` });
          return;
        }
        const real = containedRealpath(dossier, abs);
        if (real === null) {
          json(res, 403, { error: `'${rel.rel}' resolves outside the dossier (a symlink out, or an unresolvable path) — refused` });
          return;
        }
        const entry = ARTIFACT_TYPES[extname(real).toLowerCase()];
        if (entry === undefined) {
          json(res, 415, { error: `'${extname(real) || '(no extension)'}' is not a servable artifact type — ${Object.keys(ARTIFACT_TYPES).join(' ')} only` });
          return;
        }
        if (entry.under !== undefined && !rel.rel.startsWith(entry.under)) {
          json(res, 415, { error: `'${extname(real)}' artifacts are served from ${entry.under} only — '${rel.rel}' is outside it` });
          return;
        }
        const cap = isImage(entry.type) ? IMAGE_CAP : TEXT_CAP;
        const size = statSync(real).size;
        if (size > cap) {
          json(res, 413, { error: `'${rel.rel}' is ${size} bytes, over the ${cap}-byte cap for ${isImage(entry.type) ? 'images' : 'text'} — open it from the dossier instead` });
          return;
        }
        // READ BEFORE writeHead — the ORDERING is the fault-isolation invariant (see the catch),
        // not a style choice. Everything above is a stat-based pre-check, so the read can still
        // fail: a dossier file chmod'd 000, or unlinked between statSync and readFileSync. Once
        // headers are out the catch cannot answer at all; reading first keeps a failed read an
        // honest 500 instead of an ERR_HTTP_HEADERS_SENT thrown from inside the catch.
        const bytes = readFileSync(real);
        res.writeHead(200, { ...BASE_HEADERS, 'content-type': entry.type, 'content-security-policy': entry.csp ?? CSP });
        res.end(bytes);
        return;
      }

      // Unknown /api/* is a 404 JSON — never the SPA fallback, which would answer a mistyped
      // endpoint with an HTML page and make a client's JSON.parse the error message.
      if (rawPath.startsWith('/api/')) {
        json(res, 404, { error: `no such endpoint '${rawPath}'`, routes: ROUTES });
        return;
      }

      if (dist === null) {
        json(res, 404, { error: `no such endpoint '${rawPath}' — this viewer was started with --api-only, so no frontend is served`, routes: ROUTES });
        return;
      }

      // --- static + SPA fallback, realpath-contained ------------------------------------------
      let decoded;
      try { decoded = decodeURIComponent(rawPath); }
      catch { json(res, 400, { error: 'malformed percent-encoding in the request path' }); return; }
      if (decoded.includes('\0')) { json(res, 400, { error: 'request path contains a NUL byte' }); return; }
      const indexHtml = join(dist, 'index.html');
      // join() normalises, so `/../../package.json` resolves OUT of dist here and is caught by the
      // containment check below rather than being silently rewritten into something servable.
      const wanted = normalize(join(dist, decoded === '/' ? 'index.html' : decoded));
      // Containment on the NORMALISED path first (the file may not exist, so realpath cannot speak
      // yet), then again on the resolved file below — a symlink inside dist is the second case.
      const insideDist = wanted === dist || wanted.startsWith(dist + sep);
      if (!insideDist) { json(res, 403, { error: 'path escapes the viewer bundle — refused' }); return; }
      let file = wanted;
      if (!existsSync(file) || statSync(file).isDirectory()) file = indexHtml; // SPA fallback
      const real = containedRealpath(dist, file);
      if (real === null) { json(res, 403, { error: 'path resolves outside the viewer bundle — refused' }); return; }
      const type = STATIC_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream';
      const headers = { ...BASE_HEADERS, 'content-type': type };
      if (type.startsWith('text/html')) headers['content-security-policy'] = CSP;
      // READ BEFORE writeHead, same invariant as the artifact branch and with a window that opens
      // during ORDINARY use: `cd viewer && npm run build` in a second terminal has vite unlink and
      // rewrite dist while this server is polled, so a path that existsSync/statSync'd a moment ago
      // can ENOENT at the read. That must be a 500, never a dead viewer.
      const bytes = readFileSync(real);
      res.writeHead(200, headers);
      res.end(bytes);
    } catch (err) {
      // Fault isolation: one bad request must never take the server down. The message is the
      // kernel's or node's own, verbatim — this server invents no explanations.
      // headersSent means a body was already committed; json() would then throw
      // ERR_HTTP_HEADERS_SENT *out of this catch*, i.e. uncaught, and the process would die — the
      // exact opposite of fault isolation. Every reader above reads before writeHead precisely so
      // this branch stays unreachable; if it is ever reached, destroying the socket (the client
      // sees a truncated response) is the only close that keeps the server alive.
      if (res.headersSent) { res.destroy(err); return; }
      json(res, 500, { error: String(err?.message ?? err) });
    }
  });
  return server;
}
