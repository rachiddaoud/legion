// setup.test.mjs — `legion setup` (src/cli/setup.mjs) driven ENTIRELY through the injected
// deps: a recording fake `run` (never the real runner — no claude, no npm, no network), a temp
// checkout with its own marketplace.json, an explicit marketplaceBase, a synthetic PATH, and a
// fake doctor. What is under test is the CONTRACT the header states: derived-not-guessed
// install identity, create→refresh fallback that dies loudly only when BOTH forms fail,
// fail-closed step ordering (a dead step means later steps never run), the asymmetric PATH
// policy (link when absent, hands off when a FOREIGN legion resolves), the snapshot refusal
// (fail-closed: under plugins/ but not a marketplace clone ⇒ refuse), the clone mode's
// update-only marketplace step, and doctor owning the exit code.
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setupCore, whichLegion } from '../../src/cli/setup.mjs';
import { STAMP_FILE, computeSourceDigest } from '../../src/cli/viewer-build.mjs';

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
function mkCheckout(opts = {}) {
  return populate(join(mkBox(), 'checkout'), opts);
}

/** The same checkout shape, but living where Claude Code keeps a git-source marketplace's CLONE —
 * `<plugins base>/marketplaces/<name>` — the layout that makes setup take its from-clone mode.
 * Returns both the plugins base (the injectable marketplaceBase) and the clone root. */
function mkClone(opts = {}) {
  const base = join(mkBox(), 'claude-config', 'plugins');
  const root = populate(join(base, 'marketplaces', opts.marketName ?? 'legion'), opts);
  return { base, root };
}

function populate(root, { marketName = 'legion', pluginName = 'legion', manifest, viewer = false, viewerBuilt = false } = {}) {
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

/** deps for the clone layout: marketplaceBase is the plugins dir that CONTAINS the clone. */
function cloneDepsFor(base, root, run, over = {}) {
  return depsFor(root, run, { marketplaceBase: base, ...over });
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
  let code;
  const out = await withStdout(async () => { code = await setupCore([], depsFor(root, run)); });
  assert.equal(code, 0);
  assert.deepEqual(verbs(calls), ['claude plugin marketplace add', 'claude plugin marketplace update', 'claude plugin install legion@legion']);
  // The refresh form updates from the REGISTERED source, which need not be this checkout (it may
  // be a github source on the hybrid machine) — the ok-line must not claim a checkout refresh.
  assert.match(out, /refreshed from its registered source/);
  assert.doesNotMatch(out, /refreshed from the checkout/);
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

test('npm link success is VERIFIED, not assumed: a link that landed off-PATH warns with the PATH remedy', async () => {
  // The custom-npm-prefix trap: `npm link` exits 0 having symlinked into a bin dir this PATH
  // never sees. The old success line sent the operator into a loop (doctor: "not on PATH, run
  // setup"; setup: "linked"). Now the claim is re-measured after the link.
  const root = mkCheckout();
  const { run, calls } = fakeRun(); // npm link "succeeds" but creates nothing on this PATH
  let out = '';
  out = await withStdout(async () => {
    assert.equal(await setupCore([], depsFor(root, run, { pathEnv: join(mkBox(), 'empty-bin') })), 0);
  });
  assert.equal(calls.some((c) => c.file === 'npm'), true);
  assert.match(out, /WARNING/);
  assert.match(out, /STILL not on PATH/);
  assert.match(out, /export PATH=/, 'the remedy setup cannot apply itself must be printed HERE, not only on link failure');
  assert.doesNotMatch(out, /linked `legion` onto PATH/, 'no success claim without evidence');
});

test('npm link success that VERIFIABLY landed on PATH keeps the success line', async () => {
  const root = mkCheckout();
  const linkBin = join(mkBox(), 'link-bin');
  mkdirSync(linkBin, { recursive: true });
  // The fake npm link plants the symlink the real one would: linkBin is on PATH, target in root.
  const { run } = fakeRun((file) => {
    if (file === 'npm') symlinkSync(join(root, 'bin', 'legion'), join(linkBin, 'legion'));
    return {};
  });
  const out = await withStdout(async () => {
    assert.equal(await setupCore([], depsFor(root, run, { pathEnv: linkBin })), 0);
  });
  assert.match(out, /linked `legion` onto PATH via npm link/);
  assert.doesNotMatch(out, /WARNING/);
});

test('a DIRECTORY named `legion` on PATH is not a legion: whichLegion skips it and setup links', async () => {
  // X_OK on a directory merely means searchable; treating it as found would mask a broken
  // install as "foreign" and skip the npm link that repairs it.
  const root = mkCheckout();
  const dirBin = join(mkBox(), 'dir-bin');
  mkdirSync(join(dirBin, 'legion'), { recursive: true }); // a FOLDER named legion
  assert.equal(whichLegion(dirBin), null, 'a directory must never satisfy the PATH scan');
  const { run, calls } = fakeRun();
  await withStdout(async () => {
    assert.equal(await setupCore([], depsFor(root, run, { pathEnv: dirBin })), 0);
  });
  assert.equal(calls.some((c) => c.file === 'npm' && c.args[0] === 'link'), true,
    'setup must treat the folder as absent and link');
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

test('snapshot refusal: a cache-resident legion refuses with ZERO spawns', async () => {
  // The snapshot cache is per-commit and garbage-swept — anchoring anything there dies with the
  // next update, so setup refuses before it spawns a thing.
  const base = join(mkBox(), 'claude-config', 'plugins');
  const root = join(base, 'cache', 'legion', 'legion', '3abc27f');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'legion', plugins: [{ name: 'legion' }] }));
  const { run, calls } = fakeRun();
  await assert.rejects(
    () => setupCore([], { run, pluginRoot: root, marketplaceBase: base, pathEnv: '', runDoctor: async () => 0 }),
    /INSTALLED SNAPSHOT/,
  );
  assert.equal(calls.length, 0);
});

test('snapshot refusal FAILS CLOSED: an unknown subtree under plugins/ refuses too, ZERO spawns', async () => {
  // Not the cache, not a marketplace clone — a layout this build does not know. Treating it as a
  // checkout would run `marketplace add` against a directory Claude Code owns, so: refuse.
  const base = join(mkBox(), 'claude-config', 'plugins');
  const root = join(base, 'some-future-layout', 'legion');
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'legion', plugins: [{ name: 'legion' }] }));
  const { run, calls } = fakeRun();
  await assert.rejects(
    () => setupCore([], { run, pluginRoot: root, marketplaceBase: base, pathEnv: '', runDoctor: async () => 0 }),
    /INSTALLED SNAPSHOT/,
  );
  assert.equal(calls.length, 0);
});

// --- from-clone mode: the github-source install route (src/cli/setup.mjs header) ---------------
// The clone at <plugins>/marketplaces/<name> is a real git checkout Claude Code auto-pulls; setup
// run from it must refresh, never re-register — `marketplace add <clone path>` would re-register
// the marketplace as a DIRECTORY source and silently end auto-update.

test('clone happy path: marketplace UPDATE only (never add), install, doctor code returned', async () => {
  const { base, root } = mkClone();
  const { run, calls } = fakeRun();
  let doctorRan = false;
  const out = await withStdout(async () => {
    const code = await setupCore([], cloneDepsFor(base, root, run, { runDoctor: async () => { doctorRan = true; return 0; } }));
    assert.equal(code, 0);
  });
  assert.equal(doctorRan, true);
  assert.deepEqual(verbs(calls), ['claude plugin marketplace update', 'claude plugin install legion@legion']);
  assert.deepEqual(calls[0].args, ['plugin', 'marketplace', 'update', 'legion']);
  assert.equal(calls.some((c) => c.args[1] === 'marketplace' && c.args[2] === 'add'), false,
    'the create form must NEVER run from the clone — it would re-register as a directory source');
  assert.match(out, /marketplace clone/, 'the banner names the mode');
});

test('clone marketplace update fails → loud throw with verbatim output and the re-add remedy; install never attempted', async () => {
  const { base, root } = mkClone();
  const { run, calls } = fakeRun((file, args) =>
    (args[1] === 'marketplace' ? { ok: false, code: 1, stderr: 'update-broke' } : {}));
  await assert.rejects(
    () => setupCore([], cloneDepsFor(base, root, run)),
    (e) => /update-broke/.test(e.message)
      && e.message.includes('claude plugin marketplace add <owner>/<repo>')
      && !e.message.includes(`marketplace add ${root}`),
  );
  assert.equal(calls.some((c) => c.args[1] === 'install'), false, 'a dead marketplace step must stop setup before install');
});

test('clone marketplace update dying on a SPAWN error names the claude CLI, not the marketplace', async () => {
  // ENOENT means `claude` itself never ran — the re-add remedy would need the same missing CLI.
  const { base, root } = mkClone();
  const { run } = fakeRun((file, args) =>
    (args[1] === 'marketplace' ? { ok: false, code: null, spawnError: 'ENOENT' } : {}));
  await assert.rejects(
    () => setupCore([], cloneDepsFor(base, root, run)),
    (e) => /Is the `claude` CLI installed and current\?/.test(e.message)
      && !/marketplace add <owner>/.test(e.message),
  );
});

test('clone mode RE-READS the identity after the refresh — the pull may have renamed the plugin', async () => {
  // The marketplace update git-pulls the very tree the manifest lives in. The fake update
  // rewrites the manifest the way a pulled rename would; the install spec must use the fresh one.
  const { base, root } = mkClone();
  const { run, calls } = fakeRun((file, args) => {
    if (file === 'claude' && args[1] === 'marketplace' && args[2] === 'update') {
      writeFileSync(join(root, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ name: 'legion', plugins: [{ name: 'legion-next', source: './' }] }));
    }
    return {};
  });
  await withStdout(async () => {
    assert.equal(await setupCore([], cloneDepsFor(base, root, run)), 0);
  });
  const install = calls.find((c) => c.args[1] === 'install');
  assert.deepEqual(install.args, ['plugin', 'install', 'legion-next@legion'],
    'the install spec must come from the POST-pull manifest');
});

test('clone-mode output never speaks checkout: the snapshot line names auto-update instead', async () => {
  const { base, root } = mkClone();
  const { run } = fakeRun();
  const out = await withStdout(async () => {
    assert.equal(await setupCore([], cloneDepsFor(base, root, run)), 0);
  });
  assert.doesNotMatch(out, /upgrading the checkout/);
  assert.match(out, /marketplace auto-update refreshes it/);
});

test('clone plugin install fails → plugin update fallback succeeds — symmetric with dev mode', async () => {
  const { base, root } = mkClone();
  const { run, calls } = fakeRun((file, args) =>
    (args[1] === 'install' ? { ok: false, code: 1, stderr: 'already installed' } : {}));
  const code = await setupCore([], cloneDepsFor(base, root, run));
  assert.equal(code, 0);
  assert.deepEqual(verbs(calls).slice(-1), ['claude plugin update legion']);
});

test('clone mode, `legion` absent from PATH → npm link runs IN the clone', async () => {
  // THE point of the route: the PATH kernel is linked from the directory Claude Code pulls, so
  // marketplace auto-update updates what every `legion …` callsite runs.
  const { base, root } = mkClone();
  const { run, calls } = fakeRun();
  const code = await setupCore([], cloneDepsFor(base, root, run, { pathEnv: join(mkBox(), 'empty-bin') }));
  assert.equal(code, 0);
  const npm = calls.find((c) => c.file === 'npm');
  assert.deepEqual(npm.args, ['link']);
  assert.equal(npm.cwd, root, 'npm link must run in the clone');
});

test('clone mode, FOREIGN `legion` on PATH (the checkout-linked hybrid): warn naming both, touch nothing', async () => {
  const { base, root } = mkClone();
  const foreignBin = join(mkBox(), 'other-bin');
  mkdirSync(foreignBin, { recursive: true });
  writeFileSync(join(foreignBin, 'legion'), '#!/bin/sh\nexit 0\n');
  chmodSync(join(foreignBin, 'legion'), 0o755);
  const { run, calls } = fakeRun();
  let doctorRan = false;
  const out = await withStdout(async () => {
    const code = await setupCore([], cloneDepsFor(base, root, run, { pathEnv: foreignBin, runDoctor: async () => { doctorRan = true; return 0; } }));
    assert.equal(code, 0);
  });
  assert.equal(calls.some((c) => c.file === 'npm'), false, 'repointing PATH is the operator\'s call, not setup\'s');
  assert.match(out, /WARNING/);
  assert.match(out, /other-bin/);
  assert.equal(doctorRan, true);
});

test('clone with viewer/ gets its bundle built in the clone, forced', async () => {
  const { base, root } = mkClone({ viewer: true, viewerBuilt: true });
  const { run, calls } = fakeRun();
  const code = await setupCore([], cloneDepsFor(base, root, run));
  assert.equal(code, 0);
  const npm = calls.filter((c) => c.file === 'npm');
  assert.deepEqual(npm.map((c) => c.args.join(' ')), ['ci', 'run build'], 'forced: a pre-pull dist must not skip the rebuild');
  for (const c of npm) assert.equal(c.cwd, join(root, 'viewer'), 'the build runs in the clone\'s viewer/');
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

test('a built-but-UNSTAMPED bundle (the drift/pre-stamp case) is rebuilt by setup', async () => {
  // setup IS the refresh path, and an upgraded checkout carries new viewer sources behind an old
  // dist. The stamp is what detects that now: no stamp ⇒ stale ⇒ rebuild, no --force needed.
  const root = mkCheckout({ viewer: true, viewerBuilt: true });
  const { run, calls } = fakeRun();
  const out = await withStdout(async () => {
    assert.equal(await setupCore([], depsFor(root, run)), 0);
  });
  assert.deepEqual(calls.filter((c) => c.file === 'npm').map((c) => c.args.join(' ')), ['ci', 'run build'],
    'a bundle the stamp cannot vouch for must not make setup skip the rebuild');
  assert.doesNotMatch(out, /already built/);
});

test('a STAMP-FRESH bundle makes setup skip the rebuild — no more unconditional --force', async () => {
  // The stamp proves the dist byte-current, so the documented setup re-run ritual stops paying a
  // multi-minute npm ci + vite for nothing. Mutation-tested: restoring the old unconditional
  // ['--force'] in src/cli/setup.mjs turns this red.
  const root = mkCheckout({ viewer: true, viewerBuilt: true });
  writeFileSync(join(root, 'viewer', 'dist', STAMP_FILE), `${computeSourceDigest(join(root, 'viewer'))}\n`);
  const { run, calls } = fakeRun();
  const out = await withStdout(async () => {
    assert.equal(await setupCore([], depsFor(root, run)), 0);
  });
  assert.equal(calls.some((c) => c.file === 'npm'), false, 'a verified-fresh bundle must not rebuild');
  assert.match(out, /already built/);
  assert.match(out, /up to date with viewer\/ sources/);
});

test('an UNCOMPUTABLE digest falls back to the forced rebuild — setup cannot vouch, so it rebuilds', async () => {
  // A symlink in viewer/ makes the digest throw (fail-closed, _viewer-bundle.mjs): the stamp can
  // prove nothing, and setup — the refresh path — must not report success over a bundle it
  // cannot vouch for. The old always-force behavior survives for exactly this case.
  const root = mkCheckout({ viewer: true, viewerBuilt: true });
  symlinkSync(join(root, 'viewer', 'package.json'), join(root, 'viewer', 'aliased.json'));
  const { run, calls } = fakeRun();
  await withStdout(async () => {
    assert.equal(await setupCore([], depsFor(root, run)), 0);
  });
  assert.deepEqual(calls.filter((c) => c.file === 'npm').map((c) => c.args.join(' ')), ['ci', 'run build']);
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
