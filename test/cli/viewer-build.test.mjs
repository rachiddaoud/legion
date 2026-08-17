// viewer-build.test.mjs — `legion viewer-build` (src/cli/viewer-build.mjs), driven ENTIRELY
// through the injected seams: a synthetic `exists` for the plan and a recording fake `run` for the
// execution. THE SUITE NEVER INVOKES REAL npm — no network, no node_modules, no minute-long build
// in CI — which is the whole reason the command is split into a pure core and an executor.
//
// What is under test: the refusals it OWNS (each names its own remedy), the skip that makes the
// command safe to call unconditionally, the step list and where it runs, and — the one that
// matters most on a bad day — that a failed step stops the build and reports npm's own output
// rather than a re-worded summary.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BUILD_TIMEOUT_MS, LOCK_FILE, STAMP_FILE, STEPS, buildViewer, computeSourceDigest,
  listViewerSources, lockRefusal, lockfileRefusal, sourceRefusal, stepFailure, viewerBuildCore,
} from '../../src/cli/viewer-build.mjs';

const ROOT = '/fake/checkout';
const VIEWER = join(ROOT, 'viewer');
const DIST = join(VIEWER, 'dist');

/** `exists` over an explicit set of present paths — the plan's only environmental input. */
const existsOf = (...present) => (p) => present.includes(p);
const PKG = join(VIEWER, 'package.json');
const LOCK = join(VIEWER, 'package-lock.json');
/** The ENTRY FILE is what "built" means (src/cli/_viewer-bundle.mjs) — a fixture that seeded the
 * DIRECTORY instead would pin the empty-dist defect rather than the property. */
const ENTRY = join(DIST, 'index.html');

/** A complete checkout: source, lockfile, and optionally a built bundle. */
const wholeCheckout = (built = false) => existsOf(...[PKG, LOCK, ...(built ? [ENTRY] : [])]);

const plan = (argv = [], exists = wholeCheckout()) => viewerBuildCore(argv, { exists, pluginRoot: ROOT });

/** Recording fake for the runner seam; `script(file, args)` returns a partial result (absent ⇒ ok). */
function fakeRun(script = () => ({})) {
  const calls = [];
  const run = (file, args, opts = {}) => {
    calls.push({ file, args, cwd: opts.cwd ?? null, timeoutMs: opts.timeoutMs });
    return { ok: true, code: 0, signal: null, stdout: '', stderr: '', spawnError: null, ...(script(file, args) ?? {}) };
  };
  return { run, calls };
}

/** Collect what buildViewer writes, so progress output is assertable without touching stdout. */
function sink() {
  let out = '';
  return { write: (s) => { out += s; }, get text() { return out; } };
}

// --- the plan: pure, and it owns every refusal -------------------------------------------------

test('viewerBuildCore writes nothing and plans the two steps, in order, for a whole checkout', () => {
  const p = plan();
  assert.equal(p.refusal, null);
  assert.equal(p.skip, false);
  assert.deepEqual(p.steps, STEPS);
  assert.deepEqual(p.steps, [['npm', ['ci']], ['npm', ['run', 'build']]]);
  assert.equal(p.viewerDir, VIEWER);
  assert.equal(p.distDir, DIST);
});

test('malformed input dies loudly with the usage line, never with a build', () => {
  const owned = [
    [['--verbose', 'x'], /unknown flag '--verbose'/],
    [['--verbose=1'], /unknown flag '--verbose'/],
    [['--port', '4600'], /unknown flag '--port'/],
    [['dist'], /unexpected argument 'dist'/],
  ];
  for (const [argv, re] of owned) {
    assert.throws(() => plan(argv), re, `argv ${argv.join(' ')}`);
    assert.throws(() => plan(argv), /usage: legion viewer-build/, `argv ${argv.join(' ')}`);
  }
  // Refusals the PARSER owns (kernel/args.mjs), quoted rather than re-worded — a second wording of
  // a kernel refusal is a second definition of it. A valueless unknown flag trips this one FIRST,
  // which is why the unknown-flag cases above all carry a value.
  assert.throws(() => plan(['--verbose']), /missing value for --verbose/);
  assert.throws(() => plan(['--force=yes']), /--force takes no value/);
});

test('an already-built bundle SKIPS — and --force overrides it', () => {
  const built = plan([], wholeCheckout(true));
  assert.equal(built.haveDist, true);
  assert.equal(built.skip, true, 'calling this command on a built checkout must be cheap');
  assert.equal(built.refusal, null);

  const forced = plan(['--force'], wholeCheckout(true));
  assert.equal(forced.force, true);
  assert.equal(forced.skip, false);
  assert.deepEqual(forced.steps, STEPS);
});

test('an EMPTY dist/ is not a built bundle — the interrupted-build state must still build', () => {
  // vite empties dist/ before refilling it, so Ctrl-C or the build timeout leaves the directory
  // present and the entry file gone. Under a directory-existence predicate this state reads as
  // "built" to BOTH commands: `legion viewer` serves a blank page and `legion viewer-build` — the
  // remedy the refusal names — exits 0 having done nothing. Mutation: switching the predicate back
  // to exists(distDir) turns this test red.
  const p = plan([], existsOf(PKG, LOCK, DIST)); // the directory, WITHOUT index.html
  assert.equal(p.haveDist, false);
  assert.equal(p.skip, false, 'an empty dist must never make the named remedy a no-op');
  assert.deepEqual(p.steps, STEPS);
});

test('no viewer/ source: refuse naming the FILE it looked for, never improvise a fetch', () => {
  const p = plan([], existsOf());
  assert.equal(p.haveSource, false);
  assert.equal(p.refusal, sourceRefusal(VIEWER));
  // The path, not "your viewer/ directory is missing": the predicate is package.json, and a
  // refusal that misdescribes its own trigger is one an operator learns to work around.
  assert.match(p.refusal, new RegExp(`no frontend source at ${PKG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.deepEqual(p.steps, [], 'a refused plan carries no steps');
});

test('no lockfile: refuse rather than fall back to `npm install`', () => {
  const p = plan([], existsOf(PKG));
  assert.equal(p.haveSource, true);
  assert.equal(p.haveLock, false);
  assert.equal(p.refusal, lockfileRefusal(VIEWER));
  assert.match(p.refusal, new RegExp(LOCK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // The point of the refusal: the unpinned form must not be offered as the way out.
  assert.doesNotMatch(p.refusal, /npm install/);
  // `git -C <viewerDir>`, never a cwd-relative path: this command is normally run from a feature
  // worktree, where `git checkout -- viewer/package-lock.json` would target the WRONG repository.
  assert.match(p.refusal, new RegExp(`git -C ${VIEWER} checkout -- package-lock\\.json`));
  assert.doesNotMatch(p.refusal, /git checkout --/, 'a bare, cwd-relative git remedy must not reappear');
});

test('the source refusal wins over the lockfile refusal — the outer cause is the actionable one', () => {
  const p = plan([], existsOf(LOCK)); // lockfile without a package.json: nonsense, name the real fault
  assert.equal(p.refusal, sourceRefusal(VIEWER));
});

// --- staleness: the stamp and the digest (src/cli/viewer-build.mjs header, STALENESS) -----------
// The default listSources/readFile hit the real fs and THROW on /fake/checkout — which is exactly
// the digest:null fallback every pre-existing case above rides on. These cases inject both.

const STAMP = join(DIST, STAMP_FILE);

/** A plan over the fake tree WITH a computable digest: sources are two in-memory files, and the
 * stamp (when `stamped`) holds whatever the same digest machinery computes for them. */
function stampedPlan(argv, { built = true, stamped = true, sources = { 'src/App.tsx': 'v1' } } = {}) {
  const files = Object.keys(sources).sort();
  const bytesOf = (p) => {
    for (const [rel, bytes] of Object.entries(sources)) if (p === join(VIEWER, rel)) return bytes;
    throw new Error(`unexpected read: ${p}`);
  };
  const digest = computeSourceDigest(VIEWER, { listSources: () => files, readFile: bytesOf });
  const exists = wholeCheckout(built);
  return viewerBuildCore(argv, {
    exists,
    pluginRoot: ROOT,
    listSources: () => files,
    readFile: (p) => (p === STAMP
      ? (stamped ? `${digest}\n` : (() => { throw new Error('ENOENT'); })())
      : bytesOf(p)),
  });
}

test('a built bundle with a MATCHING stamp skips — the verified skip', () => {
  const p = stampedPlan([]);
  assert.equal(p.stale, false);
  assert.equal(p.skip, true);
  assert.equal(p.digest, p.stampDigest);
});

test('sources drifted from the stamp → stale, rebuild WITHOUT --force', () => {
  // The auto-pull case: Claude Code pulled new viewer sources over a dist built from the old ones.
  const fresh = stampedPlan([]);
  const p = viewerBuildCore([], {
    exists: wholeCheckout(true),
    pluginRoot: ROOT,
    listSources: () => ['src/App.tsx'],
    readFile: (path) => (path === STAMP ? `${fresh.digest}\n` : 'v2-pulled'),
  });
  assert.equal(p.stale, true);
  assert.equal(p.force, false);
  assert.equal(p.skip, false, 'a stale bundle must never make the bare command a no-op');
  assert.deepEqual(p.steps, STEPS);
});

test('a built bundle with NO stamp rebuilds once — pre-stamp installs self-heal', () => {
  const p = stampedPlan([], { stamped: false });
  assert.equal(p.stampDigest, null);
  assert.equal(p.stale, true);
  assert.equal(p.skip, false);
});

test('an uncomputable digest falls back to the OLD skip-if-built semantics', () => {
  // The no-.git/cache/tarball analogue and every unreadable-tree mode in one: listSources throws.
  const p = viewerBuildCore([], {
    exists: wholeCheckout(true),
    pluginRoot: ROOT,
    listSources: () => { throw new Error('EACCES'); },
    readFile: () => { throw new Error('unreachable'); },
  });
  assert.equal(p.digest, null);
  assert.equal(p.stale, false, 'staleness is a claim, and an unanswerable question must not make it');
  assert.equal(p.skip, true, 'the pre-stamp behavior is the fallback, not a refusal');
});

test('refusals still win over staleness: a stale-but-lockfileless plan refuses with no steps', () => {
  const p = viewerBuildCore([], {
    exists: existsOf(PKG, ENTRY),
    pluginRoot: ROOT,
    listSources: () => ['src/App.tsx'],
    readFile: () => 'bytes',
  });
  assert.equal(p.refusal, lockfileRefusal(VIEWER));
  assert.deepEqual(p.steps, []);
  assert.equal(p.digest, null, 'a refused plan computes no digest — refusal precedence is total');
});

test('--force still rebuilds a verified-fresh bundle — force is a superset of staleness', () => {
  const p = stampedPlan(['--force']);
  assert.equal(p.stale, false);
  assert.equal(p.skip, false);
  assert.deepEqual(p.steps, STEPS);
});

test('computeSourceDigest: deterministic across listing order, sensitive to renames', () => {
  const bytes = { a: 'aa', 'b/c': 'cc' };
  const read = (p) => bytes[p.slice(VIEWER.length + 1)] ?? (() => { throw new Error(p); })();
  const d1 = computeSourceDigest(VIEWER, { listSources: () => ['a', 'b/c'], readFile: read });
  const d2 = computeSourceDigest(VIEWER, { listSources: () => ['b/c', 'a'].sort(), readFile: read });
  assert.equal(d1, d2, 'insertion order must not matter — the digest is over the SORTED listing');
  const renamed = computeSourceDigest(VIEWER, {
    listSources: () => ['a', 'b/d'],
    readFile: (p) => (p === join(VIEWER, 'b/d') ? 'cc' : read(p)),
  });
  assert.notEqual(d1, renamed, 'identical bytes under a new path IS a different bundle input');
});

test('the executor stamps AFTER both steps, with the plan digest, and not on failure', () => {
  const stamps = [];
  const order = [];
  const { run } = (() => {
    const run = (file, args) => { order.push(`${file} ${args.join(' ')}`); return { ok: true, code: 0, signal: null, stdout: '', stderr: '', spawnError: null }; };
    return { run };
  })();
  const p = stampedPlan([], { stamped: false }); // stale ⇒ builds
  const r = buildViewer(run, p, { write: sink().write, writeStamp: (path, digest) => { order.push('stamp'); stamps.push([path, digest]); } });
  assert.equal(r.ok, true);
  assert.deepEqual(order, ['npm ci', 'npm run build', 'stamp'], 'the stamp is the LAST act of a successful build');
  assert.deepEqual(stamps, [[STAMP, p.digest]]);

  const stamps2 = [];
  const { run: failRun } = (() => ({ run: (file, args) => ({ ok: args[0] !== 'ci', code: args[0] === 'ci' ? 1 : 0, signal: null, stdout: '', stderr: 'boom', spawnError: null }) }))();
  const r2 = buildViewer(failRun, stampedPlan([], { stamped: false }), { write: sink().write, writeStamp: (...a) => stamps2.push(a) });
  assert.equal(r2.ok, false);
  assert.deepEqual(stamps2, [], 'a failed build must not stamp — the dist does not match the sources');
});

test('a THROWING stamp write is a warning, never a failed build', () => {
  const s = sink();
  const { run } = (() => ({ run: () => ({ ok: true, code: 0, signal: null, stdout: '', stderr: '', spawnError: null }) }))();
  const r = buildViewer(run, stampedPlan([], { stamped: false }), {
    write: s.write,
    writeStamp: () => { throw new Error('EROFS'); },
  });
  assert.equal(r.ok, true, 'the bundle IS ready — recording what it was built from is best-effort');
  assert.match(s.text, /WARNING/);
  assert.match(s.text, /EROFS/);
  assert.match(s.text, /bundle ready at/);
});

test('a digest-less plan (fallback mode) stamps nothing', () => {
  const stamps = [];
  const { run } = (() => ({ run: () => ({ ok: true, code: 0, signal: null, stdout: '', stderr: '', spawnError: null }) }))();
  const p = viewerBuildCore(['--force'], {
    exists: wholeCheckout(true),
    pluginRoot: ROOT,
    listSources: () => { throw new Error('EACCES'); },
  });
  const r = buildViewer(run, p, { write: sink().write, writeStamp: (...a) => stamps.push(a) });
  assert.equal(r.ok, true);
  assert.deepEqual(stamps, [], 'a stamp claiming an uncomputed digest would be a lie the next run trusts');
});

// --- the digest walk against a REAL tree (listViewerSources' own contract) ----------------------

test('listViewerSources excludes outputs and litter, and THROWS on a symlink (fail-closed)', () => {
  const box = mkdtempSync(join(tmpdir(), 'legion-vb-walk-'));
  try {
    const v = join(box, 'viewer');
    mkdirSync(join(v, 'src'), { recursive: true });
    mkdirSync(join(v, 'dist'), { recursive: true });
    mkdirSync(join(v, 'node_modules', 'x'), { recursive: true });
    writeFileSync(join(v, 'package.json'), '{}');
    writeFileSync(join(v, 'pnpm-lock.yaml'), '');           // top-level litter, excluded
    writeFileSync(join(v, 'src', 'App.tsx'), 'x');
    writeFileSync(join(v, 'src', '.DS_Store'), 'finder');   // litter at ANY depth, excluded
    writeFileSync(join(v, 'dist', 'index.html'), '<html>'); // output, excluded
    assert.deepEqual(listViewerSources(v), ['package.json', 'src/App.tsx'],
      'outputs, node_modules and litter must not perturb the digest');

    // vite can see through a symlink; Dirent cannot — silently skipping it could report
    // "up to date" over changed content, so the walk throws and the caller falls back.
    symlinkSync(join(v, 'package.json'), join(v, 'src', 'aliased.json'));
    assert.throws(() => listViewerSources(v), /symlink at src\/aliased\.json/);
  } finally {
    rmSync(box, { recursive: true, force: true });
  }
});

// --- the concurrency lock (LOCK_FILE) -----------------------------------------------------------

test('a HELD lock refuses before the first spawn, naming the file and its age', () => {
  const { run, calls } = fakeRun();
  const p = stampedPlan([], { stamped: false }); // stale ⇒ would build
  const r = buildViewer(run, p, {
    write: sink().write,
    takeLock: () => ({ ok: false, ageMs: 30_000 }),
    dropLock: () => { throw new Error('must not drop a lock it never took'); },
  });
  assert.equal(r.ok, false);
  assert.deepEqual(calls, [], 'a held lock means another build owns viewer/ — spawn nothing');
  assert.equal(r.failure, lockRefusal(join(p.viewerDir, LOCK_FILE), 30_000));
  assert.match(r.failure, /another build appears to be running/);
  assert.match(r.failure, /delete the lock file/);
});

test('the lock is taken before the steps and dropped after them — on success AND on failure', () => {
  const order = [];
  const mkRun = (failCi) => (file, args) => {
    order.push(`${file} ${args.join(' ')}`);
    return { ok: !(failCi && args[0] === 'ci'), code: 0, signal: null, stdout: '', stderr: 'boom', spawnError: null };
  };
  const locks = { take: () => { order.push('take'); return { ok: true }; }, drop: () => order.push('drop') };

  const ok = buildViewer(mkRun(false), stampedPlan([], { stamped: false }),
    { write: sink().write, writeStamp: () => order.push('stamp'), takeLock: locks.take, dropLock: locks.drop });
  assert.equal(ok.ok, true);
  assert.deepEqual(order, ['take', 'npm ci', 'npm run build', 'stamp', 'drop'],
    'the lock brackets the whole build, stamp included');

  order.length = 0;
  const failed = buildViewer(mkRun(true), stampedPlan([], { stamped: false }),
    { write: sink().write, writeStamp: () => order.push('stamp'), takeLock: locks.take, dropLock: locks.drop });
  assert.equal(failed.ok, false);
  assert.deepEqual(order, ['take', 'npm ci', 'drop'], 'a failed step must still release the lock');
});

test('lock machinery THROWING degrades to building unlocked — the guard never blocks the build', () => {
  const { run, calls } = fakeRun();
  const dropped = [];
  const r = buildViewer(run, stampedPlan([], { stamped: false }), {
    write: sink().write,
    writeStamp: () => {},
    takeLock: () => { throw new Error('EROFS'); },
    dropLock: (...a) => dropped.push(a),
  });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 2, 'the build must proceed');
  assert.deepEqual(dropped, [], 'no lock was taken, none is dropped');
});

test('skips and refusals never touch the lock', () => {
  const takeLock = () => { throw new Error('must not be called'); };
  const skip = buildViewer(fakeRun().run, stampedPlan([]), { write: sink().write, takeLock });
  assert.equal(skip.skipped, true);
  const refused = buildViewer(fakeRun().run, plan([], existsOf()), { write: sink().write, takeLock });
  assert.equal(refused.ok, false);
});

// --- the executor -------------------------------------------------------------------------------

test('buildViewer runs npm ci then npm run build, IN viewer/, on the long timeout', () => {
  const { run, calls } = fakeRun();
  const s = sink();
  const r = buildViewer(run, plan(), { write: s.write });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
  assert.deepEqual(calls.map((c) => `${c.file} ${c.args.join(' ')}`), ['npm ci', 'npm run build']);
  for (const c of calls) {
    assert.equal(c.cwd, VIEWER, 'the build must run in viewer/, never in cwd');
    assert.equal(c.timeoutMs, BUILD_TIMEOUT_MS, 'the runner default (30s) would kill a cold build');
  }
  assert.match(s.text, /bundle ready at/);
  // The frozen-terminal mitigation: the operator is told it is slow BEFORE the first spawn.
  assert.match(s.text, /a minute or two/);
});

test('a skipping plan spawns NOTHING and says why', () => {
  const { run, calls } = fakeRun();
  const s = sink();
  const r = buildViewer(run, plan([], wholeCheckout(true)), { write: s.write });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
  assert.deepEqual(calls, []);
  assert.match(s.text, /already built/);
  assert.match(s.text, /--force/, 'the skip must name the way to override it');
});

test('a refused plan spawns NOTHING and carries the refusal out as the failure', () => {
  const { run, calls } = fakeRun();
  const r = buildViewer(run, plan([], existsOf()), { write: sink().write });
  assert.equal(r.ok, false);
  assert.deepEqual(calls, []);
  assert.equal(r.failure, sourceRefusal(VIEWER));
});

test('a failed `npm ci` STOPS the build — `npm run build` never runs on a broken install', () => {
  const { run, calls } = fakeRun((file, args) =>
    (args[0] === 'ci' ? { ok: false, code: 1, stderr: 'npm ERR! ETARGET no matching version' } : {}));
  const r = buildViewer(run, plan(), { write: sink().write });
  assert.equal(r.ok, false);
  assert.deepEqual(calls.map((c) => c.args.join(' ')), ['ci'],
    'building against a stale node_modules would ship a bundle nobody asked for');
  // npm's own output, verbatim — the line naming the dependency is the whole diagnosis.
  assert.match(r.failure, /npm ERR! ETARGET no matching version/);
  assert.match(r.failure, /`npm ci` failed in \/fake\/checkout\/viewer/);
  assert.match(r.failure, /re-run: legion viewer-build/);
});

test('a failed `npm run build` reports verbatim too, after a successful install', () => {
  const { run, calls } = fakeRun((file, args) =>
    (args[0] === 'run' ? { ok: false, code: 2, stdout: 'error TS2345: Argument of type ...' } : {}));
  const r = buildViewer(run, plan(), { write: sink().write });
  assert.equal(r.ok, false);
  assert.deepEqual(r.ran, ['npm ci', 'npm run build']);
  assert.match(r.failure, /error TS2345/);
  assert.match(r.failure, /exit 2/);
  assert.equal(calls.length, 2);
});

test('npm missing from PATH is named as that, not as a build failure', () => {
  const r = stepFailure('npm', ['ci'], VIEWER, { ok: false, code: null, signal: null, stdout: '', stderr: '', spawnError: 'ENOENT' });
  assert.match(r, /'npm' is not on PATH/);
  assert.match(r, /npm ships with Node/);
  assert.doesNotMatch(r, /exit null/, 'a spawn that never happened has no exit code to report');
});

test('a TIMEOUT is named as a kill and its retry carries --force — it is the half-written case', () => {
  // The one failure that can leave index.html in place over a stale bundle, so the plain retry
  // would skip. `ETIMEDOUT` printed bare told the operator nothing and pointed at the wrong retry.
  const r = stepFailure('npm', ['run', 'build'], VIEWER, { ok: false, code: null, signal: null, stdout: '', stderr: '', spawnError: 'ETIMEDOUT' });
  assert.match(r, /killed after 10 minutes/);
  assert.match(r, /re-run: legion viewer-build --force/);
  assert.doesNotMatch(r, /ETIMEDOUT/, 'the bare errno is not a diagnosis');
  // Every other failure keeps the plain retry — --force is for the case that needs it, not a habit.
  const plain = stepFailure('npm', ['ci'], VIEWER, { ok: false, code: 1, signal: null, stdout: '', stderr: 'boom', spawnError: null });
  assert.match(plain, /re-run: legion viewer-build\n/);
});

test('a step that produced no output still says so rather than printing an empty diagnosis', () => {
  const r = stepFailure('npm', ['run', 'build'], VIEWER, { ok: false, code: 1, signal: null, stdout: '', stderr: '', spawnError: null });
  assert.match(r, /the command produced no output/);
});
