// setup.test.mjs — `legion setup` (src/cli/setup.mjs) driven ENTIRELY through the injected
// deps: a recording fake `run` (never the real runner — no claude, no npm, no network), a temp
// checkout with its own marketplace.json, an explicit marketplaceBase, a synthetic PATH, and a
// fake doctor. What is under test is the CONTRACT the header states: derived-not-guessed
// install identity, create→refresh fallback that dies loudly only when BOTH forms fail,
// fail-closed step ordering (a dead step means later steps never run), the asymmetric PATH
// policy (link when absent, hands off when a FOREIGN legion resolves), the checkout-only
// refusal, and doctor owning the exit code.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setupCore, whichLegion } from '../../src/cli/setup.mjs';

const boxes = [];
function mkBox() {
  const box = mkdtempSync(join(tmpdir(), 'legion-setup-'));
  boxes.push(box);
  return box;
}
test.after(() => { for (const b of boxes) rmSync(b, { recursive: true, force: true }); });

/** A temp legion checkout: marketplace manifest + an executable bin/legion. `viewer` adds the
 * frontend source, which is what makes setup attempt the bundle build — WITHOUT it the build step
 * skips and spawns nothing, which is why every pre-existing test here still records zero npm calls. */
function mkCheckout({ marketName = 'legion', pluginName = 'legion', manifest, viewer = false, viewerBuilt = false } = {}) {
  const root = join(mkBox(), 'checkout');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin', 'legion'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(root, 'bin', 'legion'), 0o755);
  writeFileSync(
    join(root, '.claude-plugin', 'marketplace.json'),
    manifest ?? JSON.stringify({ name: marketName, plugins: [{ name: pluginName, source: './' }] }),
  );
  if (viewer) {
    mkdirSync(join(root, 'viewer'), { recursive: true });
    writeFileSync(join(root, 'viewer', 'package.json'), JSON.stringify({ name: 'legion-viewer' }));
    writeFileSync(join(root, 'viewer', 'package-lock.json'), JSON.stringify({ lockfileVersion: 3 }));
  }
  // A bundle ALREADY BUILT — index.html, because that is what "built" means (_viewer-bundle.mjs).
  // Without this the force:true assertion below is vacuous: with no dist to skip on, the build runs
  // whether or not setup passes --force, and the test passes with the flag deleted.
  if (viewerBuilt) {
    mkdirSync(join(root, 'viewer', 'dist'), { recursive: true });
    writeFileSync(join(root, 'viewer', 'dist', 'index.html'), '<!doctype html>\n');
  }
  return root;
}

/** Recording fake for the runner seam. `script(file, args)` returns a partial result; absent
 * ⇒ ok. Every call is recorded with its cwd so ordering AND placement are assertable. */
function fakeRun(script = () => ({})) {
  const calls = [];
  const run = (file, args, opts = {}) => {
    calls.push({ file, args, cwd: opts.cwd ?? null });
    const r = script(file, args) ?? {};
    return { ok: true, code: 0, signal: null, stdout: '', stderr: '', spawnError: null, ...r };
  };
  return { run, calls };
}

/** deps for a standard happy layout: marketplaceBase far away, PATH resolving into the
 * checkout's own bin, doctor green. Overridable per test. */
function depsFor(root, run, over = {}) {
  return {
    run,
    pluginRoot: root,
    marketplaceBase: join(mkBox(), 'claude-config', 'plugins'), // never contains the checkout
    pathEnv: join(root, 'bin'),
    runDoctor: async () => 0,
    ...over,
  };
}

/** Capture process.stdout.write for one call. */
async function withStdout(fn) {
  const real = process.stdout.write;
  let out = '';
  process.stdout.write = (s) => { out += s; return true; };
  try { await fn(); } finally { process.stdout.write = real; }
  return out;
}

const verbs = (calls) => calls.map((c) => `${c.file} ${c.args.slice(0, 3).join(' ')}`);

test('fresh happy path: marketplace add + plugin install, PATH already this checkout, doctor code returned', async () => {
  const root = mkCheckout();
  const { run, calls } = fakeRun();
  let doctorRan = false;
  const code = await setupCore([], depsFor(root, run, { runDoctor: async () => { doctorRan = true; return 0; } }));
  assert.equal(code, 0);
  assert.equal(doctorRan, true);
  // Exactly the two create-form claude calls — no refresh fallback, no npm.
  assert.deepEqual(verbs(calls), ['claude plugin marketplace add', 'claude plugin install legion@legion']);
  assert.deepEqual(calls[0].args, ['plugin', 'marketplace', 'add', root]);
});

test("doctor owns the exit code: a red doctor is setup's nonzero exit", async () => {
  const root = mkCheckout();
  const { run } = fakeRun();
  const code = await setupCore([], depsFor(root, run, { runDoctor: async () => 2 }));
  assert.equal(code, 2);
});

test('install identity is DERIVED from the manifest, never the literal legion@legion', async () => {
  const root = mkCheckout({ marketName: 'acme', pluginName: 'tools' });
  const { run, calls } = fakeRun((file, args) => (args.join(' ') === 'plugin marketplace add ' + root ? { ok: false, code: 1, stderr: 'already' } : {}));
  await setupCore([], depsFor(root, run));
  assert.deepEqual(verbs(calls), [
    'claude plugin marketplace add',
    'claude plugin marketplace update', // fallback names the MANIFEST's marketplace
    'claude plugin install tools@acme',
  ]);
  assert.deepEqual(calls[1].args, ['plugin', 'marketplace', 'update', 'acme']);
});

test('marketplace add fails → update fallback succeeds → setup proceeds', async () => {
  const root = mkCheckout();
  const { run, calls } = fakeRun((file, args) =>
    (args[1] === 'marketplace' && args[2] === 'add' ? { ok: false, code: 1, stderr: 'marketplace already exists' } : {}));
  const code = await setupCore([], depsFor(root, run));
  assert.equal(code, 0);
  assert.deepEqual(verbs(calls), ['claude plugin marketplace add', 'claude plugin marketplace update', 'claude plugin install legion@legion']);
});

test('marketplace add AND update both fail → loud throw carrying BOTH outputs; install never attempted', async () => {
  const root = mkCheckout();
  const { run, calls } = fakeRun((file, args) =>
    (args[1] === 'marketplace' ? { ok: false, code: 1, stderr: args[2] === 'add' ? 'add-broke' : 'update-broke' } : {}));
  await assert.rejects(
    () => setupCore([], depsFor(root, run)),
    (e) => /add-broke/.test(e.message) && /update-broke/.test(e.message) && /registering marketplace/.test(e.message),
  );
  assert.equal(calls.some((c) => c.args[1] === 'install'), false, 'a dead marketplace step must stop setup before install');
});

test('plugin install fails → plugin update fallback succeeds → setup proceeds', async () => {
  const root = mkCheckout();
  const { run, calls } = fakeRun((file, args) =>
    (args[1] === 'install' ? { ok: false, code: 1, stderr: 'already installed' } : {}));
  const code = await setupCore([], depsFor(root, run));
  assert.equal(code, 0);
  assert.deepEqual(verbs(calls).slice(-1), ['claude plugin update legion']);
});

test('plugin install AND update both fail → loud throw; npm and doctor never run', async () => {
  const root = mkCheckout();
  const { run, calls } = fakeRun((file, args) =>
    (args[1] === 'install' || (args[1] === 'update')) ? { ok: false, code: 1, stderr: 'no' } : {});
  let doctorRan = false;
  await assert.rejects(
    () => setupCore([], depsFor(root, run, { pathEnv: '', runDoctor: async () => { doctorRan = true; return 0; } })),
    /installing 'legion@legion' failed both ways/,
  );
  assert.equal(calls.some((c) => c.file === 'npm'), false);
  assert.equal(doctorRan, false, 'doctor must not bless a failed install');
});

test('`legion` absent from PATH → npm link runs IN the checkout', async () => {
  const root = mkCheckout();
  const { run, calls } = fakeRun();
  const code = await setupCore([], depsFor(root, run, { pathEnv: join(mkBox(), 'empty-bin') }));
  assert.equal(code, 0);
  const npm = calls.find((c) => c.file === 'npm');
  assert.deepEqual(npm.args, ['link']);
  assert.equal(npm.cwd, root, 'npm link must run in the checkout, not cwd');
});

test('npm link failure is a loud throw naming the manual remedy; doctor never runs', async () => {
  const root = mkCheckout();
  const { run } = fakeRun((file) => (file === 'npm' ? { ok: false, code: 1, stderr: 'EACCES' } : {}));
  let doctorRan = false;
  await assert.rejects(
    () => setupCore([], depsFor(root, run, { pathEnv: '', runDoctor: async () => { doctorRan = true; return 0; } })),
    (e) => /npm link/.test(e.message) && /EACCES/.test(e.message) && /export PATH=/.test(e.message),
  );
  assert.equal(doctorRan, false);
});

test('a FOREIGN `legion` on PATH: warn naming both paths, touch nothing, still run doctor', async () => {
  const root = mkCheckout();
  const foreignBin = join(mkBox(), 'other-bin');
  mkdirSync(foreignBin, { recursive: true });
  writeFileSync(join(foreignBin, 'legion'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(foreignBin, 'legion'), 0o755);
  const { run, calls } = fakeRun();
  let doctorRan = false;
  let out = '';
  out = await withStdout(async () => {
    const code = await setupCore([], depsFor(root, run, { pathEnv: foreignBin, runDoctor: async () => { doctorRan = true; return 0; } }));
    assert.equal(code, 0);
  });
  assert.equal(calls.some((c) => c.file === 'npm'), false, 'a foreign legion is never clobbered');
  assert.match(out, /WARNING/);
  assert.match(out, new RegExp('other-bin'), 'the warning names where PATH points');
  assert.equal(doctorRan, true);
});

test('checkout-only refusal: a snapshot-resident legion refuses with ZERO spawns', async () => {
  const base = join(mkBox(), 'claude-config', 'plugins');
  const root = join(base, 'marketplaces', 'legion');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'legion', plugins: [{ name: 'legion' }] }));
  const { run, calls } = fakeRun();
  await assert.rejects(
    () => setupCore([], { run, pluginRoot: root, marketplaceBase: base, pathEnv: '', runDoctor: async () => 0 }),
    /INSTALLED SNAPSHOT/,
  );
  assert.equal(calls.length, 0);
});

test('missing marketplace.json refuses naming the path, ZERO spawns', async () => {
  const root = join(mkBox(), 'not-a-checkout');
  mkdirSync(root, { recursive: true });
  const { run, calls } = fakeRun();
  await assert.rejects(
    () => setupCore([], depsFor(root, run)),
    (e) => e.message.includes(join(root, '.claude-plugin', 'marketplace.json')),
  );
  assert.equal(calls.length, 0);
});

test('malformed marketplace.json (no plugin name) refuses — the spec is derived, never guessed', async () => {
  const root = mkCheckout({ manifest: JSON.stringify({ name: 'legion', plugins: [] }) });
  const { run, calls } = fakeRun();
  await assert.rejects(() => setupCore([], depsFor(root, run)), /marketplace name and a first plugin name/);
  assert.equal(calls.length, 0);
});

test('arguments are refused: setup takes none', async () => {
  const root = mkCheckout();
  const { run, calls } = fakeRun();
  await assert.rejects(() => setupCore(['extra'], depsFor(root, run)), /takes no arguments/);
  await assert.rejects(() => setupCore(['--force'], depsFor(root, run)), /takes no arguments|missing value/);
  assert.equal(calls.length, 0);
});

// --- the viewer bundle step: built here, but NEVER fatal (src/cli/setup.mjs) -------------------
// Building at install time is what stops the first `/legion:viewer` of a fresh checkout paying for
// an npm install. The property that matters is the SECOND half: a frontend toolchain must not be
// able to fail a kernel install, and it must not be able to do so QUIETLY either.

test('a checkout with viewer/ gets its bundle built — in viewer/, and BEFORE doctor', async () => {
  const root = mkCheckout({ viewer: true });
  const { run, calls } = fakeRun();
  let npmCallsAtDoctor = null;
  const out = await withStdout(async () => {
    const code = await setupCore([], depsFor(root, run, {
      // Ordering, MEASURED: a `doctorRan` boolean is true no matter when the build happened.
      runDoctor: async () => { npmCallsAtDoctor = calls.filter((c) => c.file === 'npm').length; return 0; },
    }));
    assert.equal(code, 0);
  });
  const npm = calls.filter((c) => c.file === 'npm');
  assert.deepEqual(npm.map((c) => c.args.join(' ')), ['ci', 'run build']);
  for (const c of npm) assert.equal(c.cwd, join(root, 'viewer'), 'the build runs in viewer/, not the checkout root');
  assert.match(out, /bundle ready at/);
  assert.equal(npmCallsAtDoctor, 2, 'both build steps must have run by the time doctor is asked for a verdict');
});

test('setup FORCES the rebuild: an already-built bundle is rebuilt, never skipped', async () => {
  // setup IS the refresh path ("re-run setup after upgrading the checkout"), and an upgraded
  // checkout carries new viewer sources behind an old dist. Mutation-tested: dropping `--force` in
  // src/cli/setup.mjs turns this test red — which the previous fixture, having no dist at all,
  // could not do.
  const root = mkCheckout({ viewer: true, viewerBuilt: true });
  const { run, calls } = fakeRun();
  const out = await withStdout(async () => {
    assert.equal(await setupCore([], depsFor(root, run)), 0);
  });
  assert.deepEqual(calls.filter((c) => c.file === 'npm').map((c) => c.args.join(' ')), ['ci', 'run build'],
    'a stale bundle from before the upgrade must not make setup skip the rebuild');
  assert.doesNotMatch(out, /already built/);
});

test('a checkout with NO viewer/ says so and spawns nothing — the pre-existing shape', async () => {
  const root = mkCheckout(); // no viewer/
  const { run, calls } = fakeRun();
  const out = await withStdout(async () => {
    assert.equal(await setupCore([], depsFor(root, run)), 0);
  });
  assert.equal(calls.some((c) => c.file === 'npm'), false);
  assert.match(out, /no viewer\/ frontend source/);
});

test('a FAILED viewer build warns, names the retry, and setup still reaches doctor', async () => {
  const root = mkCheckout({ viewer: true });
  const { run } = fakeRun((file, args) =>
    (file === 'npm' && args[0] === 'ci' ? { ok: false, code: 1, stderr: 'npm ERR! ENOTFOUND registry.npmjs.org' } : {}));
  let doctorRan = false;
  const out = await withStdout(async () => {
    const code = await setupCore([], depsFor(root, run, { runDoctor: async () => { doctorRan = true; return 0; } }));
    assert.equal(code, 0, "doctor still owns the exit code — a viewer build is not setup's verdict");
  });
  assert.equal(doctorRan, true, 'the kernel is installed and usable; a missing viewer must not block it');
  assert.match(out, /WARNING/);
  // --force on the retry: this build was forced, so a pre-upgrade dist may still be sitting there
  // intact, and an unforced retry would skip on it and report success for what just failed.
  assert.match(out, /legion viewer-build --force/, 'the warning must name a retry that actually rebuilds');
  assert.match(out, /npm ERR! ENOTFOUND/, "npm's own output is the diagnosis");
});

test('whichLegion: finds the first EXECUTABLE legion, skips non-executable entries, null when absent', () => {
  const a = join(mkBox(), 'a');
  const b = join(mkBox(), 'b');
  mkdirSync(a, { recursive: true });
  mkdirSync(b, { recursive: true });
  writeFileSync(join(a, 'legion'), 'not executable');
  chmodSync(join(a, 'legion'), 0o644);
  writeFileSync(join(b, 'legion'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(b, 'legion'), 0o755);
  assert.equal(whichLegion(`${a}:${b}`), join(b, 'legion'), 'the non-executable candidate is skipped');
  assert.equal(whichLegion(a), null);
  assert.equal(whichLegion(''), null);
  assert.equal(whichLegion(undefined), null);
});
