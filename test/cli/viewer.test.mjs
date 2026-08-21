// viewer.test.mjs — T40: `legion viewer`, its refusals, and the GET/HEAD-only server
// (src/cli/viewer.mjs + src/cli/_viewer/server.mjs). The projection's own arithmetic is pinned in
// test/cli/viewer-projection.test.mjs; what is under test HERE is the HTTP surface and, above
// everything else, THE PROHIBITIONS.
//
// HERMETIC. Every scenario builds a real sandbox through test/helpers/fixture.mjs (real
// `legion project init` / `feature start` / `state …` through bin/legion.mjs) and pins
// LEGION_HOME at it in THIS process for the duration; the server is bound on port 0 (any free
// port) so parallel test files never collide, and the static cases run against a TINY FAKE dist
// directory rather than the real frontend build — this suite must be green before `viewer/` exists
// at all, and must not go red the day someone deletes their bundle.
//
// THE FOUR PROHIBITION TESTS, and what each would catch:
//   1. THE 405 WALK. Every route in server.mjs's own exported ROUTES table (walked
//      programmatically, so a route added without a test is still covered) plus the static paths,
//      crossed with POST/PUT/DELETE/PATCH. A registered POST route fails this immediately —
//      verified by mutation: adding one made the walk fail 4 assertions.
//   2. LEGION_HOME IS BYTE-IDENTICAL AFTER A FULL CRAWL. Every GET endpoint is called with real
//      parameters, and the whole home tree is hashed file-by-file before and after. This is the
//      prohibition stated as a measurement rather than as an inspection: the viewer wrote nothing.
//   3. THE SOURCE SCAN. viewer.mjs and _viewer/*.mjs may not IMPORT the state-mutating kernel
//      machinery (matched on import specifiers, not on vibes) and may not name a filesystem write.
//      It is a tripwire, not a proof — an aliased or dynamic import walks past it, exactly as
//      test/kernel/git-seam.audit.test.mjs says of its own scan.
//   4. THE ROUTER GUARD, measured with V8 coverage: `legion doctor --json` is spawned with
//      NODE_V8_COVERAGE and the resulting script-url list must not contain viewer code. That is an
//      empirical module-load check (legion2's viewer test asserted the same property structurally;
//      coverage answers it for ESM, which NODE_DEBUG=module does not).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, planTask, NOW } from '../helpers/fixture.mjs';
import { DEFAULT_HOST, DEFAULT_PORT, bundleStale, distRefusal, staleWarning, viewerCore } from '../../src/cli/viewer.mjs';
import { STAMP_FILE, computeSourceDigest } from '../../src/cli/_viewer-bundle.mjs';
import { ALLOWED_METHODS, ROUTES, createViewerServer, readFeatureCommits } from '../../src/cli/_viewer/server.mjs';
import { featureSummaries, featureView } from '../../src/cli/_viewer/projection.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // test/cli/x -> repo root
const BIN = join(ROOT, 'bin', 'legion.mjs');

/** Start the server on a free loopback port; returns {base, close}. LEGION_HOME must already be
 * pinned by the caller — the projection reads it lazily on every request (kernel/paths.mjs). */
async function serve(opts = {}) {
  const server = createViewerServer(opts);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

/** Run `fn` with LEGION_HOME pinned, always restored — including across the awaits of a fetch. */
async function withHome(home, fn) {
  const saved = process.env.LEGION_HOME;
  process.env.LEGION_HOME = home;
  try { return await fn(); } finally {
    if (saved === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = saved;
  }
}

const getJson = async (base, path) => {
  const r = await fetch(base + path);
  return { status: r.status, headers: r.headers, body: await r.json() };
};

/** Every file under `dir` as [relpath, sha256], sorted — the "nothing moved" measurement. */
function hashTree(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push([relative(dir, p), createHash('sha256').update(readFileSync(p)).digest('hex')]);
    }
  };
  walk(dir);
  return out;
}

/** A minimal fake bundle: enough to exercise SPA fallback, content types and containment without
 * requiring the real frontend build (header). */
function fakeDist() {
  const dir = mkdtempSync(join(tmpdir(), 'legion3-viewer-dist-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><div id="root"></div>\n');
  writeFileSync(join(dir, 'assets', 'app.js'), 'export const app = 1;\n');
  writeFileSync(join(dir, 'assets', 'app.css'), ':root{color:red}\n');
  return dir;
}

// --- A. the CLI core: flags, refusals, warnings ---------------------------------------------------

test('viewerCore: defaults are loopback:4600, all orgs, bundle from import.meta.url', () => {
  const cfg = viewerCore([], { exists: () => true });
  assert.equal(cfg.port, DEFAULT_PORT);
  assert.equal(cfg.port, 4600);
  assert.equal(cfg.host, DEFAULT_HOST);
  assert.equal(cfg.host, '127.0.0.1');
  assert.equal(cfg.org, null);
  assert.equal(cfg.apiOnly, false);
  assert.equal(cfg.refusal, null);
  assert.deepEqual(cfg.warnings, []);
  // The bundle path is derived from THIS repository, never from cwd.
  assert.equal(cfg.distDir, join(ROOT, 'viewer', 'dist'));
});

test('viewerCore: every flag binds, and --api-only serves no bundle even when one exists', () => {
  const cfg = viewerCore(['--port', '5599', '--host', '0.0.0.0', '--api-only', '--org', 'acme'],
    { exists: () => true });
  assert.equal(cfg.port, 5599);
  assert.equal(cfg.host, '0.0.0.0');
  assert.equal(cfg.org, 'acme');
  assert.equal(cfg.apiOnly, true);
  assert.equal(cfg.distDir, null); // the flag means what it says
  assert.equal(cfg.refusal, null);
});

test('viewerCore: malformed input dies loudly with the usage line, never with a server', () => {
  // Refusals this command OWNS: each names the problem AND the usage line.
  const owned = [
    [['--verbose', 'x'], /unknown flag '--verbose'/],
    [['--verbose=1'], /unknown flag '--verbose'/],
    [['features'], /unexpected argument 'features'/],
    [['--port', 'abc'], /--port must be an integer 0-65535/],
    [['--port', '70000'], /--port must be an integer 0-65535/],
    [['--port', '1.5'], /--port must be an integer 0-65535/],
    [['--port', '-1'], /--port must be an integer 0-65535/],
    [['--host', ' '], /--host must be a non-empty address/],
  ];
  for (const [argv, re] of owned) {
    assert.throws(() => viewerCore(argv, { exists: () => true }), re, `argv ${argv.join(' ')}`);
    assert.throws(() => viewerCore(argv, { exists: () => true }), /usage: legion viewer/, `argv ${argv.join(' ')}`);
  }
  // Refusals the PARSER owns (kernel/args.mjs: a value-taking flag with no value is never
  // silently valueless) and the kernel's segment guard — loud, and quoted here rather than
  // re-worded, because a second wording of a kernel refusal is a second definition of it.
  assert.throws(() => viewerCore(['--port'], { exists: () => true }), /missing value for --port/);
  assert.throws(() => viewerCore(['--host', '--api-only'], { exists: () => true }), /missing value for --host/);
  assert.throws(() => viewerCore(['--org', '../evil'], { exists: () => true }), /invalid org/);
});

test('the dist-missing refusal is pinned: it names the directory, the build command and --api-only', () => {
  const cfg = viewerCore([], { exists: () => false, distDir: '/nowhere/viewer/dist' });
  assert.equal(cfg.haveDist, false);
  assert.equal(cfg.refusal, distRefusal('/nowhere/viewer/dist'));
  const text = cfg.refusal;
  assert.match(text, /^legion viewer: the frontend bundle is missing at \/nowhere\/viewer\/dist$/m);
  // The ONE-COMMAND remedy leads; the by-hand form is the same build, spelled out. `npm ci` and
  // not `npm install`: viewer/package-lock.json is committed as the reproducibility contract, so
  // a refusal teaching the unpinned form would teach the operator to break it.
  assert.match(text, /build it once: {2}legion viewer-build/);
  assert.match(text, new RegExp(`cd ${join(ROOT, 'viewer').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} && npm ci && npm run build`));
  assert.doesNotMatch(text, /npm install/, 'the unpinned install form must not reappear here');
  assert.match(text, /legion viewer --api-only/);
  // --api-only is the sanctioned way out, and it never refuses.
  assert.equal(viewerCore(['--api-only'], { exists: () => false, distDir: '/nowhere' }).refusal, null);
});

test('a non-loopback --host still starts, and costs exactly one stderr exposure line', () => {
  const cfg = viewerCore(['--host', '192.168.1.10', '--api-only'], { exists: () => false });
  assert.equal(cfg.refusal, null); // it STARTS
  assert.equal(cfg.warnings.length, 1);
  assert.match(cfg.warnings[0], /NOT loopback/);
  assert.match(cfg.warnings[0], /reachable from the network/);
  assert.match(cfg.warnings[0], /loopback Host check is off/);
  for (const host of ['127.0.0.1', 'localhost', '::1']) {
    assert.deepEqual(viewerCore(['--host', host, '--api-only'], { exists: () => false }).warnings, []);
  }
});

test('the real CLI starts on a free port, prints the URL to stdout, and stops on SIGINT', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    const child = spawn(process.execPath, [BIN, 'viewer', '--api-only', '--port', '0'], {
      env: { ...h.env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const url = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`viewer did not print a URL (stdout ${JSON.stringify(out)} stderr ${JSON.stringify(err)})`)), 10_000);
      child.stdout.on('data', () => {
        const m = /^(http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(out);
        if (m) { clearTimeout(t); resolve(m[1]); }
      });
      child.on('exit', (c) => { clearTimeout(t); reject(new Error(`viewer exited ${c}: ${err}`)); });
    });
    const health = await (await fetch(`${url}api/health`)).json();
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'legion3');
    assert.equal(health.legionHome, h.home); // the CHILD's home, proving LEGION_HOME is honoured
    assert.match(out, /read-only projection, GET\/HEAD only/);
    assert.match(out, /JSON API only \(--api-only\)/);
    const code = await new Promise((resolve) => {
      child.on('exit', (c) => resolve(c));
      child.kill('SIGINT');
    });
    assert.equal(code, 0, 'SIGINT must close the viewer cleanly');
  } finally { h.cleanup(); }
});

// --- A2. the stale-bundle warning (bundleStale — run()'s check, kept out of the pure core) --------

test('bundleStale: stale when digest and stamp disagree, quiet on every unanswerable branch', () => {
  const dist = '/fake/viewer/dist';
  const sources = () => ['src/App.tsx'];
  const readFor = (content, stamp) => (p) => {
    if (p === join(dist, STAMP_FILE)) {
      if (stamp === null) throw new Error('ENOENT');
      return `${stamp}\n`;
    }
    return content;
  };
  const digestOf = (content) => computeSourceDigest('/fake/viewer', { listSources: sources, readFile: () => content });

  // Disagreement ⇒ stale: the auto-pull left a bundle built from older sources.
  assert.equal(bundleStale(dist, { listSources: sources, readFile: readFor('v2', digestOf('v1')) }), true);
  // Agreement ⇒ fresh.
  assert.equal(bundleStale(dist, { listSources: sources, readFile: readFor('v1', digestOf('v1')) }), false);
  // No stamp (the pre-stamp install) ⇒ QUIET — a warning firing on every legacy install would
  // teach operators to ignore it; `legion viewer-build` is where that state self-heals.
  assert.equal(bundleStale(dist, { listSources: sources, readFile: readFor('v1', null) }), false);
  // Unreadable tree ⇒ quiet: an unknown is an unknown.
  assert.equal(bundleStale(dist, { listSources: () => { throw new Error('EACCES'); }, readFile: () => '' }), false);
  // The warning names the dist and the one remedy.
  assert.match(staleWarning(dist), /OLDER viewer\/ sources/);
  assert.match(staleWarning(dist), /legion viewer-build/);
});

// --- B. THE PROHIBITIONS --------------------------------------------------------------------------

test('PROHIBITION: every route refuses POST/PUT/DELETE/PATCH with 405 + Allow: GET, HEAD', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  await withHome(h.home, async () => {
    const dist = fakeDist();
    const s = await serve({ distDir: dist });
    try {
      // The route table is walked PROGRAMMATICALLY (server.mjs exports it), plus the static and
      // SPA-fallback paths, plus an endpoint that does not exist — nothing may be writable.
      const paths = [...ROUTES, '/', '/features/x', '/assets/app.js', '/api/nope'];
      assert.ok(ROUTES.length >= 8, 'the exported route table went thin — the walk would be vacuous');
      for (const p of paths) {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
          const r = await fetch(s.base + p, { method, body: method === 'OPTIONS' ? undefined : '{}' });
          assert.equal(r.status, 405, `${method} ${p} was not refused`);
          assert.equal(r.headers.get('allow'), 'GET, HEAD', `${method} ${p} carried no Allow`);
          const body = await r.json();
          assert.match(body.error, /read-only projection/);
          assert.deepEqual(body.allow, ALLOWED_METHODS);
        }
      }
      // And the two that ARE allowed still work, so the guard is not simply refusing everything.
      assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
      const head = await fetch(`${s.base}/api/health`, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
    } finally { await s.close(); rmSync(dist, { recursive: true, force: true }); }
  });
  h.cleanup();
});

test('PROHIBITION: a FULL crawl of every GET endpoint leaves LEGION_HOME byte-identical', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.seedPlan([planTask('T1', { milestone: 'M1' })]);
    const intent = h.writeArtifact('intent.md', '# intent\nthe agreed shape\n');
    assert.equal(h.legion('state', 'artifact-record', 'intent', intent).code, 0);
    assert.equal(h.legion('state', 'decision-record', 'intake').code, 0);
    assert.equal(h.legion('state', 'task-start', 'T1').code, 0);
    h.commit('work one');

    await withHome(h.home, async () => {
      const s = await serve({});
      try {
        const before = hashTree(h.home);
        assert.ok(before.length >= 3, 'the home tree looks empty — the measurement would be vacuous');
        const id = 'org=default&project=proj&name=f1';
        const crawl = [
          '/api/health',
          '/api/features', '/api/features?org=default',
          '/api/insights', '/api/insights?org=default',
          '/api/activity', '/api/activity?limit=5', '/api/activity?org=default',
          `/api/feature?${id}`,
          `/api/commits?${id}`,
          `/api/diff?${id}`, `/api/diff?${id}&file=src/index.mjs`,
          `/api/artifact?${id}&path=intent.md`,
          '/api/nope',
        ];
        for (const path of crawl) {
          const r = await fetch(s.base + path);
          assert.ok([200, 404].includes(r.status), `${path} answered ${r.status}`);
          await r.arrayBuffer(); // drain
        }
        const after = hashTree(h.home);
        assert.deepEqual(after, before, 'the viewer WROTE under LEGION_HOME during a read-only crawl');
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});

test('PROHIBITION: viewer code imports no state-mutating machinery and names no filesystem write', () => {
  const files = [
    join(ROOT, 'src', 'cli', 'viewer.mjs'),
    // The bundle predicate viewer.mjs shares with `legion viewer-build`. In the scan because it is
    // reachable from the sealed command: a leaf that grew an import or a write would carry both
    // straight past the four assertions below.
    join(ROOT, 'src', 'cli', '_viewer-bundle.mjs'),
    join(ROOT, 'src', 'cli', '_viewer', 'server.mjs'),
    join(ROOT, 'src', 'cli', '_viewer', 'projection.mjs'),
    join(ROOT, 'src', 'cli', '_viewer', 'activity.mjs'),
  ];
  for (const f of files) assert.ok(existsSync(f), `${f} is missing`);

  // The kernel entry points that MOVE state, and the modules that own them. Matched on the import
  // specifier list of each `import … from '…'` — never on a bare mention, so a docblock may name
  // `dispatch` without tripping the scan (and a real import cannot hide behind one).
  const FORBIDDEN_NAMES = [
    'dispatch', 'bumpWrite', 'seedTasks', 'recordGateReceipt', 'repinCommandPolicy',
    'writeJson', 'writeAtomic', 'ensureDir', 'cascadeInvalidate', 'gitUserRepo',
  ];
  const FORBIDDEN_MODULES = [/(^|\/)state\.mjs$/, /^node:child_process$/, /(^|\/)runner\.mjs$/];
  const WRITE_CALLS = /\b(writeFileSync|appendFileSync|renameSync|rmSync|unlinkSync|mkdirSync|mkdtempSync|createWriteStream|cpSync|copyFileSync|truncateSync|utimesSync|chmodSync|openSync)\s*\(/;

  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const what = relative(ROOT, f);
    for (const m of src.matchAll(/import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\})?\s*from\s*'([^']+)'/g)) {
      const spec = m[3];
      const named = (m[2] ?? '').split(',').map((x) => x.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      const all = [...named, ...(m[1] ? [m[1]] : [])];
      // src/kernel/state.mjs IS imported by the projection — for its PREDICATES, which is the
      // point (calling them beats re-implementing them). What may never cross is a mutator.
      for (const name of all) {
        assert.ok(!FORBIDDEN_NAMES.includes(name),
          `${what} imports state-mutating '${name}' from ${spec} — the viewer mutates nothing`);
      }
      for (const re of FORBIDDEN_MODULES) {
        // The kernel's own state.mjs is allowed (predicates); src/cli/state.mjs — the typed-op
        // COMMAND — is not, and neither is a raw spawn or the runner seam.
        if (re.source.includes('state') && spec.includes('kernel/state.mjs')) continue;
        assert.ok(!re.test(spec), `${what} imports ${spec} — the viewer may not reach the mutation path`);
      }
    }
    assert.equal(WRITE_CALLS.exec(src), null,
      `${what} names a filesystem write (${WRITE_CALLS.exec(src)?.[1]}) — the viewer writes nothing, anywhere`);
    // No POST route may EXIST, not even a disabled one (the port deleted them, it did not gate them).
    assert.ok(!/['"]POST['"]/.test(src.replace(/POST\/PUT\/DELETE\/PATCH/g, '')),
      `${what} names a POST method string — the mutation surface was deleted, not disabled`);
  }
});

test('PROHIBITION: another command never loads viewer code (measured with V8 coverage)', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  const cov = mkdtempSync(join(tmpdir(), 'legion3-viewer-cov-'));
  try {
    const r = spawnSync(process.execPath, [BIN, 'doctor', '--json'], {
      cwd: h.repoRoot, encoding: 'utf8', env: { ...h.env, NODE_V8_COVERAGE: cov },
    });
    assert.ok(r.status === 0 || r.status === 1, `doctor exited ${r.status}: ${r.stderr}`);
    const urls = [];
    for (const f of readdirSync(cov)) {
      for (const s of JSON.parse(readFileSync(join(cov, f), 'utf8')).result ?? []) urls.push(s.url ?? '');
    }
    // Not vacuous: the command's OWN module must be in the list, or the probe proves nothing.
    assert.ok(urls.some((u) => u.endsWith('/src/cli/doctor.mjs')),
      `V8 coverage listed no doctor.mjs — the probe would be vacuous (${urls.length} scripts)`);
    const leaked = urls.filter((u) => /\/src\/cli\/viewer\.mjs$|\/src\/cli\/_viewer\//.test(u));
    assert.deepEqual(leaked, [], 'a non-viewer command loaded viewer code');
  } finally { rmSync(cov, { recursive: true, force: true }); h.cleanup(); }
});

// --- C. traversal + artifact containment ------------------------------------------------------------

test('/api/artifact serves allowlisted dossier files and refuses every escape', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  const outside = mkdtempSync(join(tmpdir(), 'legion3-viewer-outside-'));
  try {
    writeFileSync(join(outside, 'secret.md'), '# not yours\n');
    h.writeArtifact('intent.md', '# intent\nhello\n');
    h.writeArtifact('notes.txt', 'plain\n');
    h.writeArtifact('secret.key', 'sk-shouldnotbeserved\n');
    h.writeArtifact('.hidden.md', 'dotfile\n');
    h.writeArtifact('big.md', 'x'.repeat(2 * 1024 * 1024 + 1));
    mkdirSync(join(h.dossier, 'visual'), { recursive: true });
    writeFileSync(join(h.dossier, 'visual', 'shot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
    mkdirSync(join(h.dossier, 'mockups'), { recursive: true });
    writeFileSync(join(h.dossier, 'mockups', 'modal.html'), '<h1>mock</h1><script>1</script>\n');
    h.writeArtifact('stray.html', '<h1>not a mock</h1>\n');
    // A symlink INSIDE the dossier pointing OUT of it — the case a normalize()-only guard misses.
    symlinkSync(join(outside, 'secret.md'), join(h.dossier, 'escape.md'));

    await withHome(h.home, async () => {
      const s = await serve({});
      const id = 'org=default&project=proj&name=f1';
      try {
        const ok = await fetch(`${s.base}/api/artifact?${id}&path=intent.md`);
        assert.equal(ok.status, 200);
        assert.equal(ok.headers.get('content-type'), 'text/markdown; charset=utf-8');
        assert.equal(ok.headers.get('x-content-type-options'), 'nosniff');
        assert.match(ok.headers.get('content-security-policy'), /default-src 'self'/);
        assert.equal(await ok.text(), '# intent\nhello\n');
        const png = await fetch(`${s.base}/api/artifact?${id}&path=visual/shot.png`);
        assert.equal(png.status, 200);
        assert.equal(png.headers.get('content-type'), 'image/png');
        // An html mock is served, but under the SANDBOX csp — never the viewer's own policy,
        // which would let a model-authored page script against this API same-origin.
        const html = await fetch(`${s.base}/api/artifact?${id}&path=mockups/modal.html`);
        assert.equal(html.status, 200);
        assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
        const mockCsp = html.headers.get('content-security-policy');
        assert.match(mockCsp, /sandbox allow-scripts/);
        // The two load-bearing properties, pinned by NAME: no egress (a mock built from injected
        // text must not be able to SEND dossier content anywhere), and no allow-same-origin —
        // the one token whose addition would hand model-authored HTML this API. Both would
        // otherwise slip through a well-meaning "fix" with every other assertion green.
        assert.match(mockCsp, /default-src 'none'/);
        assert.match(mockCsp, /connect-src 'none'/);
        assert.doesNotMatch(mockCsp, /allow-same-origin/);

        const refused = [
          ['path=../../../../etc/passwd', 400, /escapes the dossier/],
          ['path=..%2F..%2Fprojects.json', 400, /escapes the dossier/],
          ['path=/etc/passwd', 400, /must be dossier-relative/],
          ['path=intent%00.md', 400, /NUL byte/],
          ['path=.hidden.md', 400, /dotfiles are not served/],
          ['path=escape.md', 403, /resolves outside the dossier/],
          ['path=secret.key', 415, /not a servable artifact type/],
          ['path=stray.html', 415, /served from mockups\/ only/],
          ['path=big.md', 413, /over the 2097152-byte cap/],
          ['path=nope.md', 404, /no artifact 'nope\.md'/],
          ['', 400, /missing required query parameter 'path'/],
        ];
        for (const [qs, status, re] of refused) {
          const r = await getJson(s.base, `/api/artifact?${id}&${qs}`);
          assert.equal(r.status, status, `${qs} answered ${r.status}: ${JSON.stringify(r.body)}`);
          assert.match(r.body.error, re);
        }
        // A bad identity is a 400 that names the offending segment; an unknown feature is a 404.
        const bad = await getJson(s.base, '/api/artifact?org=..&project=proj&name=f1&path=intent.md');
        assert.equal(bad.status, 400);
        assert.match(bad.body.error, /invalid org/);
        const gone = await getJson(s.base, '/api/artifact?org=default&project=proj&name=nope&path=intent.md');
        assert.equal(gone.status, 404);
        assert.match(gone.body.error, /no dossier at/);
      } finally { await s.close(); }
    });
  } finally { rmSync(outside, { recursive: true, force: true }); h.cleanup(); }
});

test('static serving: SPA fallback, content types, and no file outside the bundle', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  const dist = fakeDist();
  const outside = mkdtempSync(join(tmpdir(), 'legion3-viewer-outdist-'));
  try {
    writeFileSync(join(outside, 'stolen.js'), 'const secret = 1;\n');
    symlinkSync(join(outside, 'stolen.js'), join(dist, 'assets', 'link.js'));
    await withHome(h.home, async () => {
      const s = await serve({ distDir: dist });
      try {
        const root = await fetch(`${s.base}/`);
        assert.equal(root.status, 200);
        assert.equal(root.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.match(root.headers.get('content-security-policy'), /frame-ancestors 'none'/);
        assert.match(await root.text(), /<div id="root">/);

        const spa = await fetch(`${s.base}/features/default/proj/f1`);
        assert.equal(spa.status, 200, 'the SPA fallback serves index.html for a client route');
        assert.match(await spa.text(), /<div id="root">/);

        const js = await fetch(`${s.base}/assets/app.js`);
        assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
        const css = await fetch(`${s.base}/assets/app.css`);
        assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8');

        // Traversal out of the bundle: refused, and NEVER answered with the repository's own file.
        for (const p of ['/../../package.json', '/..%2f..%2fpackage.json', '/assets/../../package.json']) {
          const r = await fetch(s.base + p);
          const body = await r.text();
          assert.ok(!body.includes('"bin"'), `${p} served a file outside the bundle`);
          assert.ok(r.status === 403 || body.includes('<div id="root">'), `${p} answered ${r.status}`);
        }
        // A symlink inside the bundle pointing out of it is refused by the realpath check.
        const link = await fetch(`${s.base}/assets/link.js`);
        assert.equal(link.status, 403);
        assert.match((await link.json()).error, /resolves outside the viewer bundle/);

        // An unknown /api/* is JSON, never the SPA page: a mistyped endpoint must not arrive at a
        // client as HTML that JSON.parse chokes on.
        const nope = await getJson(s.base, '/api/nope');
        assert.equal(nope.status, 404);
        assert.match(nope.body.error, /no such endpoint '\/api\/nope'/);
        assert.deepEqual(nope.body.routes, ROUTES);
      } finally { await s.close(); }
    });
  } finally {
    rmSync(dist, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    h.cleanup();
  }
});

// A read that fails AFTER the stat-based pre-checks is the one fault the file-serving branches can
// still hit, and it used to be lethal: writeHead(200) had already run, so the handler's catch called
// json() on a committed response, ERR_HTTP_HEADERS_SENT was thrown FROM INSIDE THE CATCH, and the
// whole viewer process died on one unreadable file. Not an exotic case for the static branch —
// `npm run build` in viewer/ unlinks and rewrites dist under a running viewer. chmod 000 is the
// deterministic stand-in for that TOCTOU window (root ignores the mode bits, hence the named skip).
// Verified by mutation: restoring `res.end(readFileSync(real))` after writeHead turns each half of
// this test into an uncaught ERR_HTTP_HEADERS_SENT that takes the test process with it.
test('an unreadable file is a 500 and the server SURVIVES it — both file-serving branches', {
  skip: process.getuid?.() === 0 ? 'running as root: chmod 000 would not deny the read' : false,
}, async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  const dist = fakeDist();
  const noread = join(h.dossier, 'noread.md');
  const distAsset = join(dist, 'assets', 'app.js');
  try {
    h.writeArtifact('intent.md', '# intent\n');
    h.writeArtifact('noread.md', '# unreadable\n');
    chmodSync(noread, 0o000);
    chmodSync(distAsset, 0o000);
    await withHome(h.home, async () => {
      const s = await serve({ distDir: dist });
      const id = 'org=default&project=proj&name=f1';
      try {
        const art = await getJson(s.base, `/api/artifact?${id}&path=noread.md`);
        assert.equal(art.status, 500, `unreadable artifact answered ${art.status}`);
        assert.match(art.body.error, /EACCES|permission denied/i);
        // The server is still answering: this is the whole point of the assertion above.
        const after = await fetch(`${s.base}/api/artifact?${id}&path=intent.md`);
        assert.equal(after.status, 200);
        assert.equal(await after.text(), '# intent\n');

        const asset = await getJson(s.base, '/assets/app.js');
        assert.equal(asset.status, 500, `unreadable dist asset answered ${asset.status}`);
        assert.match(asset.body.error, /EACCES|permission denied/i);
        const root = await fetch(`${s.base}/`);
        assert.equal(root.status, 200, 'the server died on an unreadable bundle file');
        assert.match(await root.text(), /<div id="root">/);
      } finally { await s.close(); }
    });
  } finally {
    chmodSync(noread, 0o600);
    chmodSync(distAsset, 0o600);
    rmSync(dist, { recursive: true, force: true });
    h.cleanup();
  }
});

test('--api-only serves no frontend at all, and says so instead of 404ing blankly', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  await withHome(h.home, async () => {
    const s = await serve({});
    try {
      const r = await getJson(s.base, '/');
      assert.equal(r.status, 404);
      assert.match(r.body.error, /started with --api-only, so no frontend is served/);
      assert.equal((await fetch(`${s.base}/api/health`)).status, 200);
    } finally { await s.close(); }
  });
  h.cleanup();
});

test('a non-loopback Host header is refused on a loopback bind (DNS rebinding)', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  await withHome(h.home, async () => {
    const s = await serve({});
    try {
      // node:http, not fetch(): undici owns the Host header and will not let a caller forge one,
      // which is exactly the header this guard exists to judge.
      const port = Number(new URL(s.base).port);
      const ask = (host) => new Promise((resolve, reject) => {
        const req = httpRequest({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, (res) => {
          let body = '';
          res.on('data', (d) => { body += d; });
          res.on('end', () => resolve({ status: res.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
      const evil = await ask('evil.example.com');
      assert.equal(evil.status, 403);
      assert.match(JSON.parse(evil.body).error, /forbidden Host header/);
      // The loopback names a browser actually sends still work.
      for (const good of [`127.0.0.1:${port}`, `localhost:${port}`]) {
        assert.equal((await ask(good)).status, 200, good);
      }
    } finally { await s.close(); }
  });
  h.cleanup();
});

// --- D. behaviour: the endpoints render the projection and nothing else -----------------------------

test('/api/health is a fact about this process, with no token and nothing to protect', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  await withHome(h.home, async () => {
    const s = await serve({});
    try {
      const r = await getJson(s.base, '/api/health');
      assert.equal(r.status, 200);
      assert.deepEqual(r.body, {
        ok: true, v: 1, mode: 'legion3', legionHome: h.home, readOnly: true, methods: ['GET', 'HEAD'],
      });
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(r.headers.get('cache-control'), 'no-store');
      // No CSRF token, because there is nothing to protect (the v2 token guarded POSTs).
      assert.ok(!/token/i.test(JSON.stringify(r.body)));
    } finally { await s.close(); }
  });
  h.cleanup();
});

test('/api/features renders the inventory including the unreadable row (H06)', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    for (const n of ['f2', 'f3']) {
      assert.equal(h.legionIn(h.repoRoot, 'feature', 'start', n, '--base', 'main').code, 0);
    }
    writeFileSync(join(dirname(h.dossier), 'f2', 'feature.json'), '{ this is not json\n');

    await withHome(h.home, async () => {
      const s = await serve({});
      try {
        const r = await getJson(s.base, '/api/features');
        assert.equal(r.status, 200);
        assert.equal(r.body.v, 1);
        // The server adds NOTHING: the body is the projection call, verbatim.
        const direct = featureSummaries({});
        assert.deepEqual(r.body.summaries.map((x) => x.key).sort(), direct.summaries.map((x) => x.key).sort());
        assert.deepEqual(r.body.unreadable.map((u) => u.key), ['default/proj/f2']);
        assert.equal(r.body.unreadable[0].viewerStatus, 'unreadable');
        assert.deepEqual(r.body.population, { features: 3, readable: 2, unreadable: 1 });
        // ONE broken dossier did not take the inventory down.
        assert.deepEqual(r.body.summaries.map((x) => x.name).sort(), ['f1', 'f3']);
        // The org filter is display-only and selects nothing outside the org.
        const other = await getJson(s.base, '/api/features?org=nobody');
        assert.deepEqual(other.body.summaries, []);
        // A server pinned to an org ignores a query that would widen it.
        const pinned = await serve({ org: 'nobody' });
        try {
          const p = await getJson(pinned.base, '/api/features?org=default');
          assert.deepEqual(p.body.summaries, []);
        } finally { await pinned.close(); }
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});

test('/api/feature is T39\'s projection verbatim — the server derives nothing', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.seedPlan([planTask('T1', { milestone: 'M1' })]);
    assert.equal(h.legion('state', 'task-start', 'T1').code, 0);
    h.commit('work one');

    await withHome(h.home, async () => {
      const s = await serve({});
      try {
        const r = await getJson(s.base, '/api/feature?org=default&project=proj&name=f1');
        assert.equal(r.status, 200);
        // The SAME projection call the server makes, with the SAME injected git seam. Only
        // `ageHours` may differ (the two calls are milliseconds apart).
        const direct = featureView({ org: 'default', project: 'proj', name: 'f1', readCommits: readFeatureCommits });
        const strip = (v) => { const { ageHours, ...rest } = v; return rest; };
        assert.deepEqual(strip(r.body.feature), strip(direct));
        assert.equal(typeof r.body.feature.ageHours, 'number');
        // The git block is the SEAM's verdict, and the commit rows reached the activity feed.
        assert.equal(r.body.feature.git.available, true);
        assert.ok(r.body.feature.activity.some((a) => a.kind === 'commit' && /work one/.test(a.label)));
        // Approvals are RECORDED, never valid — the rule the whole viewer exists to obey. The
        // body carries the stored facts and the kernel's live answer, and no prose about either.
        assert.ok(!('approvalsCaveat' in r.body.feature));

        // A feature that does not exist is a 404 that names what was asked.
        const gone = await getJson(s.base, '/api/feature?org=default&project=proj&name=nope');
        assert.equal(gone.status, 404);
        assert.match(gone.body.error, /no such feature 'default\/proj\/nope'/);
        assert.deepEqual(gone.body.asked, { org: 'default', project: 'proj', name: 'nope' });
        // A missing parameter is a 400 naming the parameter.
        const bad = await getJson(s.base, '/api/feature?org=default');
        assert.equal(bad.status, 400);
        assert.match(bad.body.error, /missing required query parameter 'project'/);
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});

test('an unreadable dossier is a 200 unreadable ROW on the detail endpoint, never a 500', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.corrupt('tasks');
    await withHome(h.home, async () => {
      const s = await serve({});
      try {
        const r = await getJson(s.base, '/api/feature?org=default&project=proj&name=f1');
        assert.equal(r.status, 200, 'a broken dossier renders the honest row, it does not 500');
        assert.equal(r.body.feature.unreadable, true);
        assert.equal(r.body.feature.viewerStatus, 'unreadable');
        assert.match(r.body.feature.why, /corrupt JSON/);
        // …and so do the git endpoints that would otherwise need its manifest.
        const c = await getJson(s.base, '/api/commits?org=default&project=proj&name=f1');
        assert.equal(c.status, 200);
        assert.equal(c.body.available, false);
        assert.match(c.body.reason, /corrupt JSON/);
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});

test('/api/commits and /api/diff read a real repo through the seam, and degrade typed', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    const first = h.commit('work one');
    const second = h.commit('work two');
    assert.notEqual(first, second);

    await withHome(h.home, async () => {
      const s = await serve({});
      const id = 'org=default&project=proj&name=f1';
      try {
        const c = await getJson(s.base, `/api/commits?${id}`);
        assert.equal(c.status, 200);
        assert.equal(c.body.available, true);
        assert.equal(c.body.head, second);
        assert.deepEqual(c.body.commits.map((x) => x.subject), ['work two', 'work one']);
        assert.equal(c.body.commits[0].sha, second);
        assert.ok(!Number.isNaN(Date.parse(c.body.commits[0].at)));

        const d = await getJson(s.base, `/api/diff?${id}`);
        assert.equal(d.body.available, true);
        assert.deepEqual(d.body.files, [{ status: 'M', path: 'src/index.mjs' }]);
        assert.match(d.body.diff, /^diff --git a\/src\/index\.mjs b\/src\/index\.mjs$/m);
        assert.equal(d.body.file, null);

        const one = await getJson(s.base, `/api/diff?${id}&file=src/index.mjs`);
        assert.equal(one.body.file, 'src/index.mjs');
        assert.match(one.body.diff, /src\/index\.mjs/);
        const nothing = await getJson(s.base, `/api/diff?${id}&file=does/not/exist.mjs`);
        assert.equal(nothing.body.available, true);
        assert.equal(nothing.body.diff, ''); // an empty diff is an ANSWER, not an error

        // A pruned worktree (`legion feature clean`) is a TYPED degraded read at HTTP 200.
        h.writeFeature((f) => ({ ...f, worktree: join(h.sandbox, 'gone') }));
        const pruned = await getJson(s.base, `/api/commits?${id}`);
        assert.equal(pruned.status, 200);
        assert.equal(pruned.body.available, false);
        assert.match(pruned.body.reason, /is absent — pruned by `legion feature clean`/);
        assert.deepEqual(pruned.body.commits, []);
        const prunedDiff = await getJson(s.base, `/api/diff?${id}`);
        assert.equal(prunedDiff.status, 200);
        assert.equal(prunedDiff.body.available, false);
        // The detail view says the same thing in its own git block, from the same seam.
        const v = await getJson(s.base, `/api/feature?${id}`);
        assert.equal(v.body.feature.git.available, false);
        assert.match(v.body.feature.git.reason, /is absent — pruned/);
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});

test('a hand-edited baseSha is refused as a revision rather than handed to git', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.writeFeature((f) => ({ ...f, baseSha: '--upload-pack=touch /tmp/pwned' }));
    await withHome(h.home, async () => {
      const s = await serve({});
      try {
        const r = await getJson(s.base, '/api/commits?org=default&project=proj&name=f1');
        assert.equal(r.status, 200);
        assert.equal(r.body.available, false);
        assert.match(r.body.reason, /records no usable baseSha/);
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});

test('/api/activity is the cross-feature manifest-only feed, newest first and honestly truncated', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.seedPlan([planTask('T1', { milestone: 'M1' })]);
    assert.equal(h.legion('state', 'task-start', 'T1').code, 0);
    assert.equal(h.legion('state', 'session-record', '--session-id', 'sess-1').code, 0);
    const intent = h.writeArtifact('intent.md', '# intent\nagreed\n');
    assert.equal(h.legion('state', 'artifact-record', 'intent', intent).code, 0);
    assert.equal(h.legion('state', 'decision-record', 'intake').code, 0);
    h.commit('a commit the GLOBAL feed must not carry');

    await withHome(h.home, async () => {
      const s = await serve({});
      try {
        const r = await getJson(s.base, '/api/activity');
        assert.equal(r.status, 200);
        assert.ok(r.body.rows.length >= 3, `expected several recorded rows, got ${r.body.rows.length}`);
        assert.equal(r.body.truncated, false);
        assert.equal(r.body.total, r.body.rows.length);
        for (const row of r.body.rows) assert.equal(row.key, 'default/proj/f1');
        // NEWEST FIRST, so `limit` returns the page a reader wants.
        const dated = r.body.rows.filter((x) => !Number.isNaN(Date.parse(x.at))).map((x) => Date.parse(x.at));
        assert.deepEqual(dated, [...dated].sort((a, b) => b - a));
        // No commit rows: the global feed is manifest-only (a git log per feature per poll is the
        // load source this endpoint refuses to be).
        assert.deepEqual(r.body.rows.filter((x) => x.kind === 'commit'), []);

        const capped = await getJson(s.base, '/api/activity?limit=2');
        assert.equal(capped.body.rows.length, 2);
        assert.equal(capped.body.limit, 2);
        assert.equal(capped.body.truncated, true);
        assert.equal(capped.body.total, r.body.total);
        const bad = await getJson(s.base, '/api/activity?limit=nope');
        assert.equal(bad.status, 400);
        assert.match(bad.body.error, /limit must be a non-negative integer/);
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});

test('/api/insights carries its denominators and never a cost or token number', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    await withHome(h.home, async () => {
      const s = await serve({});
      try {
        const r = await getJson(s.base, '/api/insights');
        assert.equal(r.status, 200);
        assert.deepEqual(r.body.population, { features: 1, readable: 1, unreadable: 0, org: null, tasks: 0 });
        for (const k of ['outcomes', 'recentOutcomes', 'featureDuration', 'stageDuration', 'attempts', 'reviewRounds']) {
          assert.ok(k in r.body, `insights is missing ${k}`);
        }
        assert.equal(r.body.featureDuration.n, 0);
        assert.equal(r.body.featureDuration.p50Ms, null); // empty is empty, never a smoothed zero
        assert.ok(!/cost|token/i.test(JSON.stringify(r.body)));
        // The scoped read reports the org it was scoped to, so a thin denominator is legible.
        const scoped = await getJson(s.base, '/api/insights?org=default');
        assert.equal(scoped.body.population.org, 'default');
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});

test('the recorded/valid distinction survives the wire: no endpoint ever calls an approval valid', async () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    const intent = h.writeArtifact('intent.md', '# intent\nagreed\n');
    assert.equal(h.legion('state', 'artifact-record', 'intent', intent).code, 0);
    assert.equal(h.legion('state', 'decision-record', 'intake').code, 0);

    await withHome(h.home, async () => {
      const s = await serve({});
      try {
        const r = await getJson(s.base, '/api/feature?org=default&project=proj&name=f1');
        const f = r.body.feature;
        assert.deepEqual(Object.keys(f.approvals.intake).sort(), ['at', 'subjectHash']);
        assert.equal(f.approvals.intake.at, NOW);
        assert.ok(!/valid/i.test(JSON.stringify(f.approvals)));
        // Validity is the KERNEL's live verdict, computed now, under a name that says so…
        assert.equal(f.lifecycleNow.available, true);
        assert.equal(f.lifecycleNow.approvalsValidNow.intake, true);
        // …and it dies with the bytes, which is the proof the kernel function is CALLED.
        writeFileSync(intent, '# intent\nsomething else\n');
        const after = await getJson(s.base, '/api/feature?org=default&project=proj&name=f1');
        assert.deepEqual(after.body.feature.approvals.intake, f.approvals.intake); // record unmoved
        assert.equal(after.body.feature.lifecycleNow.approvalsValidNow.intake, false);
      } finally { await s.close(); }
    });
  } finally { h.cleanup(); }
});
