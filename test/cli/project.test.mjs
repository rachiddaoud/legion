// End-to-end guard for `legion project init` through the REAL bin against REAL fixture
// git repos. Every spawn pins LEGION_HOME to a per-scenario temp dir — the real
// ~/.legion is NEVER touched. Invariants under test: derived evidence in project.json,
// index registration (CAS version counting), byte-identical re-init no-op, reconcile
// diffs (derived always; --protected/--ticket-project/--notify only when flagged),
// structured-bootstrap enforcement, safeSegment on names, loud failures.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateBootstrap } from '../../src/cli/project.mjs';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';

// HERMETIC GIT (T7b): the suite ran against the DEVELOPER's ~/.gitconfig and inherited GIT_*
// env, which is exactly why the `status.showUntrackedFiles=no` fail-open was invisible to it
// — a machine with that preference set would have gone GREEN here. This one mutation neuters
// global/system config and every inherited GIT_* variable and pins a deterministic identity;
// every child below spawns from `process.env` (directly or via `{...process.env, LEGION_HOME}`),
// so no other call site changes. A future test that builds an env object from scratch would
// silently opt out.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });


const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'legion.mjs');

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-project-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};

let n = 0;
/** Fresh sandbox: an isolated LEGION_HOME plus a one-commit fixture repo. */
function scenario({ pkg = { name: 'fix-proj' }, remote = true } = {}) {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  if (pkg) writeFileSync(join(repo, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  else writeFileSync(join(repo, 'README.md'), 'fixture\n');
  sh(repo, 'add', '-A');
  sh(repo, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-m', 'init');
  if (remote) sh(repo, 'remote', 'add', 'origin', 'https://example.invalid/r.git');
  return { home, repo: realpathSync(repo) };
}

const legion = (home, ...args) =>
  spawnSync(process.execPath, [BIN, 'project', ...args], {
    encoding: 'utf8',
    env: { ...process.env, LEGION_HOME: home },
  });

const readCfg = (home, org, name) =>
  JSON.parse(readFileSync(join(home, 'orgs', org, 'projects', name, 'project.json'), 'utf8'));
const readIndex = (home) => JSON.parse(readFileSync(join(home, 'projects.json'), 'utf8'));

test('init on a fixture repo derives evidence and registers in the index', () => {
  const { home, repo } = scenario();
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 0, r.stderr);
  const cfg = readCfg(home, 'default', 'fix-proj');
  assert.equal(cfg.schemaVersion, 1);
  assert.equal(cfg.revision, 0);
  assert.equal(cfg.org, 'default');
  assert.equal(cfg.name, 'fix-proj');
  assert.equal(realpathSync(cfg.repoRoot), repo);
  assert.equal(cfg.remoteUrl, 'https://example.invalid/r.git');
  assert.equal(cfg.defaultBranch, 'main');
  assert.deepEqual(cfg.protectedBranches, ['main']);
  assert.deepEqual(cfg.gates, {});
  assert.deepEqual(cfg.bootstrap, []);
  assert.equal(cfg.ticketProject, null);
  assert.equal(cfg.notify, null);
  assert.ok(cfg.legionVersion, 'legionVersion recorded');
  assert.equal(cfg.createdAt, cfg.updatedAt);
  const idx = readIndex(home);
  assert.equal(idx.version, 1);
  assert.equal(idx.schemaVersion, 1);
  assert.equal(idx.projects.length, 1);
  assert.equal(idx.projects[0].org, 'default');
  assert.equal(idx.projects[0].name, 'fix-proj');
  assert.equal(idx.projects[0].configPath, join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json'));
});

test('re-init is a byte-identical no-op — config untouched, index version unchanged', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const cfgPath = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json');
  const bytesBefore = readFileSync(cfgPath, 'utf8');
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /up to date/);
  assert.equal(readFileSync(cfgPath, 'utf8'), bytesBefore, 'config bytes must be identical');
  assert.equal(readIndex(home).version, 1, 'no-op re-init must not bump the index');
});

test('reconcile: --protected updates + bumps revision; gates/bootstrap/createdAt preserved', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const before_ = readCfg(home, 'default', 'fix-proj');
  const r = legion(home, 'init', '--root', repo, '--protected', 'main,release');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /protectedBranches: \["main"\] -> \["main","release"\]/);
  const cfg = readCfg(home, 'default', 'fix-proj');
  assert.deepEqual(cfg.protectedBranches, ['main', 'release']);
  assert.equal(cfg.revision, 1);
  assert.equal(cfg.createdAt, before_.createdAt);
  assert.deepEqual(cfg.gates, {});
  assert.deepEqual(cfg.bootstrap, []);
  // plain re-init does NOT reset the curated protected list (flag-gated reconcile)
  const r2 = legion(home, 'init', '--root', repo);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /up to date/);
  assert.deepEqual(readCfg(home, 'default', 'fix-proj').protectedBranches, ['main', 'release']);
});

test('re-init preserves valid structured bootstrap entries verbatim', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const cfgPath = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const entry = { cwd: '.', argv: ['npm', 'ci'], timeoutMs: 120000 };
  cfg.bootstrap = [entry];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readCfg(home, 'default', 'fix-proj').bootstrap, [entry]);
});

test('re-init dies loudly on a raw-shell-string bootstrap entry', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const cfgPath = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.bootstrap = ['npm ci && npm test'];
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid bootstrap\[0\]/);
  assert.match(r.stderr, /raw shell strings are forbidden/);
});

test('--org places config under orgs/<org>; projects coexist in the index', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const r = legion(home, 'init', '--root', repo, '--org', 'acme');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(home, 'orgs', 'acme', 'projects', 'fix-proj', 'project.json')));
  const idx = readIndex(home);
  assert.equal(idx.version, 2);
  assert.deepEqual(
    idx.projects.map((p) => `${p.org}/${p.name}`).sort(),
    ['acme/fix-proj', 'default/fix-proj'],
  );
});

test('--name with an unsafe segment fails closed via safeSegment', () => {
  const { home, repo } = scenario();
  const r = legion(home, 'init', '--root', repo, '--name', '../x');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid project/);
  assert.ok(!existsSync(join(home, 'projects.json')), 'nothing may be registered');
});

test('scoped package name derives the tail segment', () => {
  const { home, repo } = scenario({ pkg: { name: '@scope/thing' } });
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readCfg(home, 'default', 'thing').name, 'thing');
});

test('no package.json name falls back to the repo dirname', () => {
  const { home, repo } = scenario({ pkg: null });
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readCfg(home, 'default', 'repo').name, 'repo');
});

test('non-git --root exits 1 naming the git failure', () => {
  const { home } = scenario();
  const notRepo = mkdtempSync(join(TMP, 'notgit-'));
  const r = legion(home, 'init', '--root', notRepo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a git repository/i);
});

test('missing or unknown subcommand exits 1 with usage', () => {
  const { home, repo } = scenario();
  const r1 = legion(home);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /usage: legion project init/);
  const r2 = legion(home, 'frobnicate', '--root', repo);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /unknown or missing subcommand 'frobnicate'/);
});

// --- validateBootstrap strict keys (direct import — exported precisely for reuse) ---

const SHA = 'a'.repeat(64);

test('validateBootstrap accepts both exact shapes', () => {
  validateBootstrap([
    { cwd: '.', argv: ['npm', 'ci'], timeoutMs: 120000 },
    { script: 'setup.sh', sha256: SHA },
  ], '/cfg/project.json');
});

test('validateBootstrap rejects extra fields and mixed shapes, naming index and path', () => {
  const bads = [
    { cwd: '.', argv: ['npm'], timeoutMs: 1, shell: 'sh -c' },       // exec + extra
    { script: 's.sh', sha256: SHA, argv: ['x'] },                    // script + extra
    { cwd: '.', argv: ['npm'], timeoutMs: 1, script: 's.sh', sha256: SHA }, // both shapes merged
  ];
  for (const bad of bads) {
    assert.throws(
      () => validateBootstrap([{ cwd: '.', argv: ['ok'], timeoutMs: 1 }, bad], '/cfg/project.json'),
      (e) => e.message.includes('bootstrap[1]')
        && e.message.includes('/cfg/project.json')
        && /no extra fields, no mixed shapes/.test(e.message),
      JSON.stringify(bad),
    );
  }
});

// --- --protected '' / --no-protected: an empty protected set is only ever explicit ---

test("--protected '' and whitespace/comma-only values are rejected loudly", () => {
  const { home, repo } = scenario();
  for (const empty of ['', ' , ', ',,']) {
    const r = legion(home, 'init', '--root', repo, '--protected', empty);
    assert.equal(r.status, 1, `--protected '${empty}' must fail`);
    assert.match(r.stderr, /--no-protected/);
  }
  assert.ok(!existsSync(join(home, 'projects.json')), 'nothing may be registered');
});

test('--protected with --no-protected is rejected as mutually exclusive', () => {
  const { home, repo } = scenario();
  const r = legion(home, 'init', '--root', repo, '--protected', 'main', '--no-protected');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /mutually exclusive/);
});

test('--no-protected yields an explicit empty protected set on fresh init', () => {
  const { home, repo } = scenario();
  const r = legion(home, 'init', '--root', repo, '--no-protected');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readCfg(home, 'default', 'fix-proj').protectedBranches, []);
});

test('--no-protected on re-init empties a curated list and bumps revision', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo, '--protected', 'main,release').status, 0);
  const r = legion(home, 'init', '--root', repo, '--no-protected');
  assert.equal(r.status, 0, r.stderr);
  const cfg = readCfg(home, 'default', 'fix-proj');
  assert.deepEqual(cfg.protectedBranches, []);
  assert.equal(cfg.revision, 1);
});

// --- T17 A (R11 / M0 finding 2): --gates and --bootstrap are the onboarding ------------------
// The point of the flags is that the SAFE configuration stops being a hand-edit of project.json
// in ~/.legion, so every case below drives the real bin with a real file, and the validation
// cases assert the message names the offending KEY and the FLAG FILE it came from — not
// project.json, which is not where the operator's mistake is.

const writeCfgFile = (dir, name, doc) => {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
  return p;
};

const GATES = {
  commands: { test: { argv: ['node', '--test'], timeoutMs: 300000 } },
  task: ['test'],
};

test('--gates writes the NORMALIZED block that feature start will pin', () => {
  const { home, repo } = scenario();
  const f = writeCfgFile(home, 'gates.json', GATES);
  const r = legion(home, 'init', '--root', repo, '--gates', f);
  assert.equal(r.status, 0, r.stderr);
  // Normalized, not verbatim: `boundary` is materialized as the empty tier, because THAT is the
  // value commandPolicyPin hashes at `feature start` — storing the raw text would leave the
  // pinned policy one normalization away from what the operator read.
  assert.deepEqual(readCfg(home, 'default', 'fix-proj').gates, {
    commands: { test: { argv: ['node', '--test'], timeoutMs: 300000 } },
    task: ['test'],
    boundary: [],
  });
});

test('--bootstrap writes the validated structured entries', () => {
  const { home, repo } = scenario();
  const entries = [{ cwd: '.', argv: ['npm', 'ci'], timeoutMs: 120000 }, { script: 'setup.sh', sha256: SHA }];
  const f = writeCfgFile(home, 'bootstrap.json', entries);
  const r = legion(home, 'init', '--root', repo, '--bootstrap', f);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readCfg(home, 'default', 'fix-proj').bootstrap, entries);
});

test('a --gates file with a dangling tier reference dies naming the key AND the flag file', () => {
  const { home, repo } = scenario();
  const f = writeCfgFile(home, 'gates.json', { commands: {}, task: ['lint'] });
  const r = legion(home, 'init', '--root', repo, '--gates', f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gates\.task\[0\] references unknown command 'lint'/);
  assert.ok(r.stderr.includes(f), `the error must name the flag file, not project.json:\n${r.stderr}`);
  assert.ok(!existsSync(join(home, 'orgs')), 'a rejected config must write nothing');
  assert.ok(!existsSync(join(home, 'projects.json')), 'and register nothing');
});

test('a --bootstrap file with a raw shell string dies naming the entry AND the flag file', () => {
  const { home, repo } = scenario();
  const f = writeCfgFile(home, 'bootstrap.json', ['npm ci && npm test']);
  const r = legion(home, 'init', '--root', repo, '--bootstrap', f);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid bootstrap\[0\]/);
  assert.match(r.stderr, /raw shell strings are forbidden/);
  assert.ok(r.stderr.includes(f), r.stderr);
  assert.ok(!existsSync(join(home, 'orgs')), 'a rejected config must write nothing');
});

test('a missing or corrupt flag file dies loudly naming the flag and the path', () => {
  const { home, repo } = scenario();
  const missing = join(home, 'nope.json');
  const r1 = legion(home, 'init', '--root', repo, '--gates', missing);
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /--gates: cannot read /);
  assert.ok(r1.stderr.includes(missing), r1.stderr);

  const corrupt = join(home, 'corrupt.json');
  writeFileSync(corrupt, '{ nope\n');
  const r2 = legion(home, 'init', '--root', repo, '--bootstrap', corrupt);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /--bootstrap: corrupt JSON in /);
  assert.ok(r2.stderr.includes(corrupt), r2.stderr);
});

test('re-init: --gates/--bootstrap are flag-gated like every other explicit field', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const gatesFile = writeCfgFile(home, 'gates.json', GATES);
  const bootFile = writeCfgFile(home, 'boot.json', [{ cwd: '.', argv: ['npm', 'ci'], timeoutMs: 1000 }]);

  const r = legion(home, 'init', '--root', repo, '--gates', gatesFile, '--bootstrap', bootFile);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gates: \{\} -> /);
  const cfg = readCfg(home, 'default', 'fix-proj');
  assert.deepEqual(cfg.gates.task, ['test']);
  assert.deepEqual(cfg.bootstrap, [{ cwd: '.', argv: ['npm', 'ci'], timeoutMs: 1000 }]);
  assert.equal(cfg.revision, 1);

  // absent ⇒ preserved untouched, and a re-run with the SAME files is a byte-identical no-op
  const r2 = legion(home, 'init', '--root', repo);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /up to date/);
  const r3 = legion(home, 'init', '--root', repo, '--gates', gatesFile, '--bootstrap', bootFile);
  assert.match(r3.stdout, /up to date/, 're-declaring the same config must not churn the revision');
  const after = readCfg(home, 'default', 'fix-proj');
  assert.equal(after.revision, 1);
  assert.deepEqual(after.gates.task, ['test']);
});

test('re-init dies on a carried-forward malformed gates block, naming the key', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const cfgPath = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  cfg.gates = { commands: { test: { argv: ['node'], timeoutMs: 1 } }, boundary: ['nope'] };
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /gates\.boundary\[0\] references unknown command 'nope'/);
});

// --- T17 B (R18): a failed init leaves NO trace ------------------------------------------------
// The injected failure is a CORRUPT INDEX — the CAS layer's own loud refusal, reached at the
// commit point after project.json has already been written. That is exactly the window R18
// names, and it is reachable without a seam: the index is a real file the operator can corrupt.

const corruptIndex = (home) => writeFileSync(join(home, 'projects.json'), '{ this is not json\n');

test('a registration failure rolls the fresh init back — no orphan dir, no success claim', () => {
  const { home, repo } = scenario();
  mkdirSync(home, { recursive: true });
  corruptIndex(home);
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /project init failed at registration/);
  assert.match(r.stderr, /corrupt JSON/);
  assert.match(r.stderr, /rolled back — removed /);
  assert.doesNotMatch(r.stdout, /initialized project/, 'success is announced only after the commit point');

  const projDir = join(home, 'orgs', 'default', 'projects', 'fix-proj');
  assert.ok(!existsSync(projDir), 'the orphan project directory is exactly what R18 forbids');

  // …and the retry, once the index is readable again, is a FRESH init — not a reconcile against
  // config that was never registered (the second half of the R18 defect).
  rmSync(join(home, 'projects.json'));
  const r2 = legion(home, 'init', '--root', repo);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /initialized project/);
  const cfg = readCfg(home, 'default', 'fix-proj');
  assert.equal(cfg.revision, 0);
  assert.equal(cfg.createdAt, cfg.updatedAt);
});

test('rollback removes exactly what the run created — a pre-existing project dir survives', () => {
  const { home, repo } = scenario();
  const projDir = join(home, 'orgs', 'default', 'projects', 'fix-proj');
  mkdirSync(join(projDir, 'features'), { recursive: true });
  const keep = join(projDir, 'features', 'leftover.txt');
  writeFileSync(keep, 'a dossier from an earlier life\n');
  corruptIndex(home);
  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rolled back — removed .*project\.json/);
  assert.ok(!existsSync(join(projDir, 'project.json')), 'the config this run wrote must be gone');
  assert.equal(readFileSync(keep, 'utf8'), 'a dossier from an earlier life\n', 'unrelated content must survive');
});

test('a registration failure on RE-init restores the previous config byte-for-byte', () => {
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const cfgPath = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json');
  // Hand-formatted on purpose: the restore must put the FILE back, not re-serialize the doc.
  const handEdited = readFileSync(cfgPath, 'utf8').replace(/\n$/, '\n\n');
  writeFileSync(cfgPath, handEdited);
  corruptIndex(home);
  const r = legion(home, 'init', '--root', repo, '--protected', 'main,release');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rolled back — restored /);
  assert.equal(readFileSync(cfgPath, 'utf8'), handEdited, 'the reconciled write must be undone byte-for-byte');
  assert.doesNotMatch(r.stdout, /reconciled project/);
});

test('--ticket-project and --notify are recorded; omitted stays null', () => {
  const { home, repo } = scenario();
  const r = legion(home, 'init', '--root', repo, '--ticket-project', 'ABC', '--notify', 'legion-topic');
  assert.equal(r.status, 0, r.stderr);
  const cfg = readCfg(home, 'default', 'fix-proj');
  assert.equal(cfg.ticketProject, 'ABC');
  assert.equal(cfg.notify, 'legion-topic');
  // plain re-init leaves them alone (flag-gated reconcile)
  const r2 = legion(home, 'init', '--root', repo);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /up to date/);
  assert.equal(readCfg(home, 'default', 'fix-proj').ticketProject, 'ABC');
});

test("re-init MERGES over the index entry — a project's features[] survives it", () => {
  // THE 2026-08-07 CLOBBER, pinned: `feature start` writes features[] into the project's index
  // entry, and a re-init that rebuilt the entry from its own four fields silently unregistered
  // every feature of the project. The invariant is merge-not-replace: keys this command does not
  // own must ride through a re-init untouched.
  const { home, repo } = scenario();
  assert.equal(legion(home, 'init', '--root', repo).status, 0);
  const st = spawnSync(process.execPath, [BIN, 'feature', 'start', 'f1', '--base', 'main'],
    { cwd: repo, encoding: 'utf8', env: { ...process.env, LEGION_HOME: home } });
  assert.equal(st.status, 0, st.stderr);
  const before = readIndex(home);
  const entry = before.projects.find((p) => p.name === 'fix-proj');
  assert.equal(entry.features?.length, 1, 'the fixture needs a registered feature to protect');

  const r = legion(home, 'init', '--root', repo);
  assert.equal(r.status, 0, r.stderr);
  const after = readIndex(home);
  const kept = after.projects.find((p) => p.name === 'fix-proj');
  assert.equal(kept.features?.length, 1, 're-init must not unregister the feature');
  assert.deepEqual(kept.features, entry.features, 'and must not rewrite it either');
  // With every owned field unchanged and the foreign key preserved, this re-init is a TRUE no-op:
  // the index version must not move.
  assert.equal(after.version, before.version, 'a merge that changes nothing must not bump the CAS');
});
