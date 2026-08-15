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
import { join } from 'node:path';
import test from 'node:test';
import {
  BUILD_TIMEOUT_MS, STEPS, buildViewer, lockfileRefusal, sourceRefusal, stepFailure, viewerBuildCore,
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
