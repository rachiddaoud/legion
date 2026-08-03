// End-to-end guard for `legion feature start|status|abandon` through the REAL bin
// against REAL fixture git repos, LEGION_HOME pinned per scenario (the real ~/.legion is
// NEVER touched). The fixture repo nests one level down (base/repo) so the worktree at
// dirname(repoRoot)/.legion-worktrees stays inside the scenario sandbox and is cleaned
// up with it. NOTE: fixture repos have no live remotes, so ANY commit on feat/<name> is
// "unpushed" by construction — the abandon-retain tests rely on exactly that.
// Invariants under test: refusal without project init; baseSha pinned pre-start;
// dossier feature.json field-for-field; worktree at the convention path on feat/<name>;
// index registration; exact launch command per mode; bootstrap exec + sha256-verified
// scripts (fail closed on mismatch); initialization_failed -> --repair recovery;
// abandon retain-vs-remove (remove also deletes feat/<name>); duplicate-start refusal;
// restart after abandon (clean: works; retained: actionable refusal, never circular);
// worktree-creation failure rolls the dossier back (no stranded 'active' manifest);
// status output — including (T22) that `status` alone resolves by REPOSITORY and therefore
// answers from inside a worktree, while the write paths keep resolving by CHECKOUT and keep
// refusing there; and (T23) `--add-repo`: every non-root refused naming what it is with nothing
// left behind, the recorded roots realpath'd in argv order, one `--add-dir` per repo on every
// launch mode, and absence changing nothing.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync, chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { delimiter, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';
import { launchCommand, shellQuote } from '../../src/cli/feature.mjs';

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
// T17 (M0 finding 1, PLAN-V3 §Startup step 5): this checkout is a DEVELOPMENT install — it is not
// under Claude Code's <config dir>/plugins — so every launch line below carries `--plugin-dir`
// naming it. ROOT is derived here from the TEST file's location, independently of the CLI's own
// derivation, so a launch line that named the wrong root (cwd, say) would fail these assertions.
const PLUGIN_FLAG = `--plugin-dir '${ROOT}' `;

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-feature-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) =>
  sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);

let n = 0;
/** Fresh sandbox: isolated LEGION_HOME + a one-commit fixture repo nested at base/repo,
 * optionally pre-initialized as a legion project. */
function scenario({ init = true } = {}) {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fix-proj' }, null, 2) + '\n');
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  if (init) {
    const r = spawnSync(process.execPath, [BIN, 'project', 'init', '--root', repo], {
      encoding: 'utf8', env: { ...process.env, LEGION_HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
  }
  return { home, repo: realpathSync(repo), base: realpathSync(base) };
}

/** Run `legion feature ...` from an ARBITRARY cwd — the worktree, for the T22 cases where the
 * cwd is the whole point (resolution is derived from it and no caller may supply a root). */
const featureFrom = (s, cwd, ...args) =>
  spawnSync(process.execPath, [BIN, 'feature', ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, LEGION_HOME: s.home },
  });

/** Run `legion feature ...` from inside the fixture repo (project resolved from cwd). */
const feature = (s, ...args) => featureFrom(s, s.repo, ...args);

const cfgPath = (s) => join(s.home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json');
const setBootstrap = (s, entries) => {
  const cfg = JSON.parse(readFileSync(cfgPath(s), 'utf8'));
  cfg.bootstrap = entries;
  writeFileSync(cfgPath(s), JSON.stringify(cfg, null, 2) + '\n');
};
/** A SECOND one-commit repository inside the scenario sandbox, for `--add-repo` (T23). Returned
 * realpath'd, which is what the manifest must record however the path was spelled on the command
 * line. Lives beside the fixture repo, never inside it — an attached repo is an INDEPENDENT
 * repository, and nesting one would make the subdirectory case untestable. */
function extraRepo(s, name) {
  const p = join(s.base, name);
  mkdirSync(p, { recursive: true });
  sh(p, 'init', '-b', 'main');
  writeFileSync(join(p, 'README.md'), `# ${name}\n`);
  sh(p, 'add', '-A');
  gitc(p, 'commit', '-m', 'init');
  return realpathSync(p);
}

const dossier = (s, name) => join(s.home, 'orgs', 'default', 'projects', 'fix-proj', 'features', name);
const readManifest = (s, name) => JSON.parse(readFileSync(join(dossier(s, name), 'feature.json'), 'utf8'));
const worktreeOf = (s, name) => join(s.base, '.legion-worktrees', 'fix-proj', name, 'checkout');

test('start refuses without project init, naming legion project init', () => {
  const s = scenario({ init: false });
  const r = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /legion project init/);
  assert.ok(!existsSync(dossier(s, 'f1')), 'no dossier may be created');
});

test('start pins base SHA, writes the full manifest, creates the worktree, registers, prints launch', () => {
  const s = scenario();
  const baseSha = sh(s.repo, 'rev-parse', 'main'); // pinned BEFORE start
  const r = feature(s, 'start', 'f1', '--base', 'main', '--now', '2026-07-24T00:00:00.000Z');
  assert.equal(r.status, 0, r.stderr);

  const f = readManifest(s, 'f1');
  assert.equal(f.schemaVersion, 1);
  assert.equal(f.legionVersion, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(f.revision, 0);
  assert.equal(f.org, 'default');
  assert.equal(f.project, 'fix-proj');
  assert.equal(f.name, 'f1');
  assert.equal(f.featureId, 'default/fix-proj/f1');
  assert.equal(realpathSync(f.repoRoot), s.repo);
  assert.equal(f.baseBranch, 'main');
  assert.equal(f.baseSha, baseSha);
  // TWO THINGS ARE PINNED, FOR THE SAME REASON (T12, PLAN-V3 §Gates + §Startup step 3): the base
  // SHA and the per-tier GATE COMMAND POLICY. A feature must not be able to quietly weaken the
  // gate it will be certified by, and every receipt consumer verifies against THIS value.
  assert.deepEqual(Object.keys(f.commandPolicyHash).sort(), ['boundary', 'task']);
  for (const tier of ['task', 'boundary']) {
    assert.match(f.commandPolicyHash[tier], /^[0-9a-f]{64}$/, `${tier} policy must be pinned`);
    // `project init` scaffolds `gates: {}`, so the pinned command LISTS are empty here — an EMPTY
    // ARRAY IS A PRESENT PIN (R11), which is why this asserts `[]` and not absence. What each half
    // of the pin is for is stated once, in kernel/state.mjs commandPolicyPin's docblock; this
    // comment used to restate it as "only the hash is ever compared", which T12b made false.
    assert.deepEqual(f.commandPolicy[tier], []);
  }
  assert.equal(f.commandPolicyPinnedAt, '2026-07-24T00:00:00.000Z');
  assert.match(r.stdout, /gate policy pinned: task [0-9a-f]{64}/, 'and it is PRINTED, not merely stored');
  assert.match(r.stdout, /TIER-0 ONLY/,
    'a project declaring no gate commands must be warned about loudly, at start (R11)');
  assert.equal(f.worktree, worktreeOf(s, 'f1'));
  assert.equal(f.branch, 'feat/f1');
  assert.equal(f.profile, 'unclassified');
  assert.equal(f.stage, 'intake');
  assert.equal(f.status, 'active');
  assert.equal(f.createdAt, '2026-07-24T00:00:00.000Z');
  assert.deepEqual(f.sessionHistory, []);

  // worktree: exists, on feat/f1, HEAD == pinned base SHA
  const wt = worktreeOf(s, 'f1');
  assert.ok(existsSync(wt));
  assert.equal(sh(wt, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/f1');
  assert.equal(sh(wt, 'rev-parse', 'HEAD'), baseSha);

  // registered in projects.json under the project's features array
  const idx = JSON.parse(readFileSync(join(s.home, 'projects.json'), 'utf8'));
  const proj = idx.projects.find((p) => p.org === 'default' && p.name === 'fix-proj');
  assert.deepEqual(proj.features, [{
    name: 'f1', featureId: 'default/fix-proj/f1', dossier: dossier(s, 'f1'), worktree: wt, branch: 'feat/f1',
  }]);

  // exact interactive launch command — every interpolated path/identifier single-quote-escaped
  // (rev 5 §Startup step 5 — R10; the escaping table test below covers the hostile bytes)
  assert.ok(
    r.stdout.includes(`cd '${wt}' && claude ${PLUGIN_FLAG}--add-dir '${dossier(s, 'f1')}' '/legion:feature resume default/fix-proj/f1'`),
    `launch command missing from:\n${r.stdout}`,
  );
});

test('launch modes: background inserts --bg, remote inserts --remote-control --name; bogus refuses creating nothing', () => {
  const s = scenario();
  const rb = feature(s, 'start', 'fb', '--base', 'main', '--launch=background');
  assert.equal(rb.status, 0, rb.stderr);
  assert.ok(rb.stdout.includes(
    `cd '${worktreeOf(s, 'fb')}' && claude --bg ${PLUGIN_FLAG}--add-dir '${dossier(s, 'fb')}' '/legion:feature resume default/fix-proj/fb'`,
  ), rb.stdout);

  const rr = feature(s, 'start', 'fr', '--base', 'main', '--launch=remote');
  assert.equal(rr.status, 0, rr.stderr);
  assert.ok(rr.stdout.includes(
    `cd '${worktreeOf(s, 'fr')}' && claude --remote-control --name 'fr' ${PLUGIN_FLAG}--add-dir '${dossier(s, 'fr')}' '/legion:feature resume default/fix-proj/fr'`,
  ), rr.stdout);

  const rx = feature(s, 'start', 'fx', '--base', 'main', '--launch=bogus');
  assert.equal(rx.status, 1);
  assert.match(rx.stderr, /invalid --launch 'bogus'/);
  assert.ok(!existsSync(dossier(s, 'fx')), 'refused start must create nothing');
  assert.ok(!existsSync(worktreeOf(s, 'fx')));
});

// --- T14 (R10): the escaping table — the emitted launch line must parse back to EXACTLY the
// intended argv under every hostile byte the spec names. The authority is a REAL /bin/sh, not a
// re-implemented parser: a stub `claude` on PATH records the argv it received (NUL-joined, so a
// newline inside a path survives the comparison), and the stub writes into its CWD — which after
// the line's `cd` must BE the worktree, so a mangled cd target fails the read, not just the diff.
// NOTHING DANGEROUS IS EVER EXECUTABLE: the semicolon row's path spells a command precisely so
// that, were quoting to regress, the parse would break loudly rather than run it (`we;rm -rf x`
// resolves no such binary and `sh -c` then exits non-zero on the unknown command).
// T23 EXTENDS THIS TABLE rather than adding a second one: attached intake repos are interpolated
// into the same line under the same rule, so they belong in the same proof. Two are attached on
// every row — one path containing a SPACE, one an APOSTROPHE (the byte the `'\''` idiom exists
// for) — and the assertion is unchanged in kind: the emitted line must parse back to exactly the
// argv meant, each attached directory arriving as ONE word.
test('escaping table: space, semicolon, apostrophe, newline — the launch line parses to the intended argv', () => {
  const HAZARDS = [
    ['space', 'we ird'],
    ['semicolon', 'we;rm -rf x;d'],
    ['apostrophe', "we'ird"],
    ['newline', 'we\nird'],
  ];
  for (const [label, hazardDir] of HAZARDS) {
    const base = join(TMP, `haz${n++}`, hazardDir); // the hazard rides BOTH the worktree and LEGION_HOME
    const home = join(base, 'home');
    const worktree = join(base, 'checkout');
    const bin = join(base, 'bin');
    for (const d of [home, worktree, bin]) mkdirSync(d, { recursive: true });
    const stub = join(bin, 'claude');
    writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\0\' "$@" > argv-out\n');
    chmodSync(stub, 0o755);

    // attached intake repos ride the same line (T23) — they need not exist to be composed
    const attachedSpace = join(base, 'att ached');
    const attachedQuote = join(base, "att'ached");

    // launchCommand reads LEGION_HOME lazily (paths.mjs); pin it for the composition only.
    const prev = process.env.LEGION_HOME;
    process.env.LEGION_HOME = home;
    let line;
    try {
      line = launchCommand('interactive', {
        org: 'default',
        project: 'proj',
        name: 'f1',
        featureId: 'default/proj/f1',
        worktree,
        intakeRepos: [attachedSpace, attachedQuote],
      });
    } finally {
      if (prev === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = prev;
    }
    assert.ok(line.includes(shellQuote(worktree)), `${label}: the worktree must be single-quote escaped in: ${line}`);

    const r = spawnSync('/bin/sh', ['-c', line], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
    });
    assert.equal(r.status, 0, `${label}: the line must execute cleanly: ${r.stderr}`);
    const out = readFileSync(join(worktree, 'argv-out'), 'utf8'); // written in the stub's CWD ⇒ cd landed in the worktree
    const argv = out.split('\0').slice(0, -1);
    assert.deepEqual(argv, [
      '--plugin-dir',
      ROOT,
      '--add-dir',
      join(home, 'orgs', 'default', 'projects', 'proj', 'features', 'f1'),
      '--add-dir',
      attachedSpace,
      '--add-dir',
      attachedQuote,
      '/legion:feature resume default/proj/f1',
    ], `${label}: claude must receive exactly the intended argv, each word intact`);
  }
});

test('bootstrap {cwd,argv,timeoutMs} runs via execFileSync in the worktree', () => {
  const s = scenario();
  setBootstrap(s, [{
    cwd: '.',
    argv: [process.execPath, '-e', "require('node:fs').writeFileSync('marker.txt','ok')"],
    timeoutMs: 30000,
  }]);
  const r = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(worktreeOf(s, 'f1'), 'marker.txt'), 'utf8'), 'ok');
});

test('bootstrap failure -> initialization_failed; plain restart refused; --repair recovers without recreating the worktree', () => {
  const s = scenario();
  setBootstrap(s, [{ cwd: '.', argv: [process.execPath, '-e', 'process.exit(3)'], timeoutMs: 30000 }]);
  const r = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--repair/);
  let f = readManifest(s, 'f1');
  assert.equal(f.status, 'initialization_failed');
  assert.match(f.initError, /exit 3/);
  assert.equal(f.revision, 1);
  assert.ok(existsSync(worktreeOf(s, 'f1')), 'worktree exists even when bootstrap failed');

  // plain re-start refuses and points at --repair
  const r2 = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /already exists \(status: initialization_failed\)/);
  assert.match(r2.stderr, /--repair/);

  // --repair on a still-broken bootstrap stays initialization_failed
  const r3 = feature(s, 'start', 'f1', '--base', 'main', '--repair');
  assert.equal(r3.status, 1);
  assert.equal(readManifest(s, 'f1').status, 'initialization_failed');

  // fix bootstrap, plant a sentinel to prove the worktree is NOT recreated, repair
  writeFileSync(join(worktreeOf(s, 'f1'), 'sentinel.txt'), 'keep\n');
  setBootstrap(s, [{
    cwd: '.',
    argv: [process.execPath, '-e', "require('node:fs').writeFileSync('marker.txt','ok')"],
    timeoutMs: 30000,
  }]);
  const r4 = feature(s, 'start', 'f1', '--base', 'main', '--repair');
  assert.equal(r4.status, 0, r4.stderr);
  f = readManifest(s, 'f1');
  assert.equal(f.status, 'active');
  assert.equal(f.initError, undefined, 'initError cleared on repair');
  assert.equal(readFileSync(join(worktreeOf(s, 'f1'), 'sentinel.txt'), 'utf8'), 'keep\n', 'worktree not recreated');
  assert.equal(readFileSync(join(worktreeOf(s, 'f1'), 'marker.txt'), 'utf8'), 'ok', 'bootstrap re-ran');
  assert.ok(r4.stdout.includes('/legion:feature resume default/fix-proj/f1'), 'repair prints the launch command');

  // --repair on an active feature refuses
  const r5 = feature(s, 'start', 'f1', '--base', 'main', '--repair');
  assert.equal(r5.status, 1);
  assert.match(r5.stderr, /--repair requires status 'initialization_failed'/);
});

test('{script,sha256} bootstrap: wrong hash fails closed without executing; correct hash executes', () => {
  const s = scenario();
  const script = '#!/bin/sh\necho scripted > script-marker.txt\n';
  writeFileSync(join(s.repo, 'bootstrap.sh'), script);
  chmodSync(join(s.repo, 'bootstrap.sh'), 0o755);
  sh(s.repo, 'add', '-A');
  gitc(s.repo, 'commit', '-m', 'add bootstrap script');

  // wrong hash: refuse BEFORE exec
  setBootstrap(s, [{ script: 'bootstrap.sh', sha256: 'a'.repeat(64) }]);
  const r1 = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /sha256 mismatch/);
  assert.match(r1.stderr, /refusing to execute/);
  assert.ok(!existsSync(join(worktreeOf(s, 'f1'), 'script-marker.txt')), 'script must NOT have run');
  assert.equal(readManifest(s, 'f1').status, 'initialization_failed');

  // correct hash (of the worktree copy == committed bytes): executes
  const digest = createHash('sha256').update(readFileSync(join(s.repo, 'bootstrap.sh'))).digest('hex');
  setBootstrap(s, [{ script: 'bootstrap.sh', sha256: digest }]);
  const r2 = feature(s, 'start', 'f1', '--base', 'main', '--repair');
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(join(worktreeOf(s, 'f1'), 'script-marker.txt'), 'utf8'), 'scripted\n');
});

/** True iff refs/heads/<branch> exists in the fixture repo. */
const branchExists = (s, branch) =>
  spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: s.repo }).status === 0;

test('abandon on a clean worktree removes it, deletes feat/<name>, and closes the manifest', () => {
  const s = scenario();
  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 0);
  const r = feature(s, 'abandon', 'f1');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /worktree removed/);
  assert.ok(!existsSync(worktreeOf(s, 'f1')));
  assert.ok(!branchExists(s, 'feat/f1'), 'feat/f1 deleted with the clean worktree — no leaked branch');
  const f = readManifest(s, 'f1');
  assert.equal(f.status, 'abandoned');
  assert.ok(f.closedAt, 'closedAt set');
  assert.equal(f.revision, 1);

  // idempotent: second abandon reports and leaves closedAt untouched
  const r2 = feature(s, 'abandon', 'f1');
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /already abandoned/);
  assert.equal(readManifest(s, 'f1').closedAt, f.closedAt);
});

test('abandon retains a worktree with uncommitted changes, and one with unpushed commits', () => {
  // uncommitted changes
  const s = scenario();
  assert.equal(feature(s, 'start', 'fdirty', '--base', 'main').status, 0);
  writeFileSync(join(worktreeOf(s, 'fdirty'), 'wip.txt'), 'work in progress\n');
  const r = feature(s, 'abandon', 'fdirty');
  assert.equal(r.status, 0, r.stderr);
  // T7d: the retain reason now NAMES the offending paths (worktreeDirt's best-effort report).
  assert.match(r.stdout, /RETAINED \(uncommitted changes \([^)]*wip\.txt/);
  assert.ok(existsSync(join(worktreeOf(s, 'fdirty'), 'wip.txt')));
  assert.equal(readManifest(s, 'fdirty').status, 'abandoned', 'manifest still closed');

  // committed but unpushed (remote-less fixture: every feat commit is unpushed)
  assert.equal(feature(s, 'start', 'fcommit', '--base', 'main').status, 0);
  const wt = worktreeOf(s, 'fcommit');
  writeFileSync(join(wt, 'done.txt'), 'committed\n');
  sh(wt, 'add', '-A');
  gitc(wt, 'commit', '-m', 'wip');
  const r2 = feature(s, 'abandon', 'fcommit');
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /RETAINED \(1 unpushed commit/);
  assert.ok(existsSync(join(wt, 'done.txt')));
  assert.equal(readManifest(s, 'fcommit').status, 'abandoned');
});

// The retain decision is EVIDENCE, read under whatever config the repo carries — and a linked
// worktree SHARES the main checkout's .git/config. Unpinned, `status.showUntrackedFiles=no`
// empties the porcelain, abandon believes the tree is clean and DESTROYS it; git's own
// `worktree remove` check_clean_worktree() shells out to an equally blinded status, so it does
// not save us either. Verified on git 2.50.1 against the unpinned call: worktree and untracked
// file gone, branch force-deleted, no warning.
test('abandon RETAINS an untracked-only worktree under status.showUntrackedFiles=no', () => {
  const s = scenario();
  assert.equal(feature(s, 'start', 'fblind', '--base', 'main').status, 0);
  const wt = worktreeOf(s, 'fblind');
  sh(s.repo, 'config', 'status.showUntrackedFiles', 'no'); // linked worktrees share .git/config
  writeFileSync(join(wt, 'sk-secret.txt'), 'sk-live-0000\n');
  assert.equal(sh(wt, 'status', '--porcelain'), '', 'fixture: plain status is blinded');

  const r = feature(s, 'abandon', 'fblind');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RETAINED \(uncommitted changes \([^)]*sk-secret\.txt/);
  assert.ok(existsSync(join(wt, 'sk-secret.txt')), 'untracked work must survive abandon');
  assert.ok(branchExists(s, 'feat/fblind'), 'branch survives a retained abandon');
  assert.equal(readManifest(s, 'fblind').status, 'abandoned', 'manifest still closed');
});

test('duplicate start refuses on an active feature', () => {
  const s = scenario();
  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 0);
  const shaBefore = sh(worktreeOf(s, 'f1'), 'rev-parse', 'HEAD');
  const r = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already exists \(status: active\)/);
  assert.equal(sh(worktreeOf(s, 'f1'), 'rev-parse', 'HEAD'), shaBefore, 'worktree untouched');
});

test('restart after a clean abandon succeeds with a fresh manifest and worktree', () => {
  const s = scenario();
  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 0);
  assert.equal(feature(s, 'abandon', 'f1').status, 0);

  const r = feature(s, 'start', 'f1', '--base', 'main', '--now', '2026-07-24T01:00:00.000Z');
  assert.equal(r.status, 0, r.stderr);
  const f = readManifest(s, 'f1');
  assert.equal(f.status, 'active');
  assert.equal(f.revision, 0, 'fresh manifest, not a bump of the abandoned one');
  assert.equal(f.createdAt, '2026-07-24T01:00:00.000Z');
  assert.equal(f.closedAt, undefined, 'closedAt from the abandoned run must not leak');
  assert.ok(existsSync(worktreeOf(s, 'f1')));
  assert.equal(sh(worktreeOf(s, 'f1'), 'rev-parse', '--abbrev-ref', 'HEAD'), 'feat/f1');
});

test('restart after a RETAINED abandon refuses with actionable recovery steps, never circular', () => {
  const s = scenario();
  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 0);
  writeFileSync(join(worktreeOf(s, 'f1'), 'wip.txt'), 'work\n');
  assert.equal(feature(s, 'abandon', 'f1').status, 0); // retained: dirty tree

  // leftover worktree: refuse naming the exact removal command; manifest untouched
  const r1 = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /worktree path .* already exists/);
  assert.match(r1.stderr, /worktree remove --force/);
  assert.ok(!r1.stderr.includes('legion feature abandon'), 'must not point back at abandon (circular)');
  assert.equal(readManifest(s, 'f1').status, 'abandoned');

  // user removes the worktree; the leaked branch alone still refuses, naming branch -D
  sh(s.repo, 'worktree', 'remove', '--force', worktreeOf(s, 'f1'));
  assert.ok(branchExists(s, 'feat/f1'), 'branch survives a retained abandon');
  const r2 = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /branch feat\/f1 already exists/);
  assert.match(r2.stderr, /branch -D feat\/f1/);
  assert.equal(readManifest(s, 'f1').status, 'abandoned');

  // after the prescribed cleanup, restart works
  sh(s.repo, 'branch', '-D', 'feat/f1');
  const r3 = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r3.status, 0, r3.stderr);
  assert.equal(readManifest(s, 'f1').status, 'active');
});

test('worktree-creation failure on a fresh start removes the manifest — never a stranded active feature', () => {
  const s = scenario();
  // Block worktree creation past the upfront checks: a FILE where the .legion-worktrees
  // directory must be created makes ensureDir/worktree add fail.
  writeFileSync(join(s.base, '.legion-worktrees'), 'blocker\n');
  const r = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /worktree creation failed/);
  assert.match(r.stderr, /no feature state was kept/);
  assert.ok(!existsSync(join(dossier(s, 'f1'), 'feature.json')), 'manifest rolled back');

  // fix the cause -> plain re-start succeeds (the promised recovery path)
  rmSync(join(s.base, '.legion-worktrees'));
  const r2 = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readManifest(s, 'f1').status, 'active');
});

test('worktree-creation failure during a restart restores the prior abandoned manifest verbatim', () => {
  const s = scenario();
  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 0);
  assert.equal(feature(s, 'abandon', 'f1').status, 0); // clean: worktree + branch gone
  const abandoned = readManifest(s, 'f1');

  // worktree remove leaves the empty <name> parent dir; replace it with a file so the
  // restart's worktree creation fails after the manifest was rewritten.
  const parent = dirname(worktreeOf(s, 'f1'));
  rmSync(parent, { recursive: true, force: true });
  writeFileSync(parent, 'blocker\n');
  const r = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /worktree creation failed/);
  assert.deepEqual(readManifest(s, 'f1'), abandoned, 'abandoned manifest restored verbatim');

  rmSync(parent);
  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 0);
  assert.equal(readManifest(s, 'f1').status, 'active');
});

test('status <name> prints the summary; bare status lists features or says none', () => {
  const s = scenario();
  const r0 = feature(s, 'status');
  assert.equal(r0.status, 0, r0.stderr);
  assert.match(r0.stdout, /no features for default\/fix-proj/);

  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 0);
  assert.equal(feature(s, 'start', 'f2', '--base', 'main').status, 0);
  assert.equal(feature(s, 'abandon', 'f2').status, 0);

  const r1 = feature(s, 'status', 'f1');
  assert.equal(r1.status, 0, r1.stderr);
  assert.match(r1.stdout, /feature default\/fix-proj\/f1/);
  assert.match(r1.stdout, /status: {3}active/);
  assert.match(r1.stdout, /stage: {4}intake/);
  assert.match(r1.stdout, /branch: {3}feat\/f1/);
  assert.match(r1.stdout, /sessions: 0/);

  const rl = feature(s, 'status');
  assert.equal(rl.status, 0, rl.stderr);
  const lines = rl.stdout.trim().split('\n');
  assert.deepEqual(lines, [
    'f1  active  intake  feat/f1',
    'f2  abandoned  intake  feat/f2',
  ]);

  const rm = feature(s, 'status', 'nope');
  assert.equal(rm.status, 1);
  assert.match(rm.stderr, /feature 'nope' does not exist/);
});

test('unknown subcommand and missing --base fail closed with usage', () => {
  const s = scenario();
  const r1 = feature(s, 'frobnicate', 'f1');
  assert.equal(r1.status, 1);
  assert.match(r1.stderr, /unknown or malformed subcommand/);
  const r2 = feature(s, 'start', 'f1');
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /missing --base/);
  assert.ok(!existsSync(dossier(s, 'f1')));
});

// --- the unregistered-repo remediation must never name a WORKTREE -------------------------------
// resolveProject's default mode resolves by CHECKOUT, so inside a linked worktree it finds no
// entry and refuses — correctly, and that refusal is the WRITE-PATH GUARD itself. The bug was the
// ADVICE it printed: `--root <the worktree>`. `legion project init` on a worktree path RECONCILES
// the real entry onto it, rewriting repoRoot and defaultBranch to the feature checkout, so the
// kernel was printing verbatim the command that corrupts the registration — worst exactly inside a
// worktree, which is where these commands are typed (PLAN-V3 §Startup step 5 launches every
// session there).
// THE TRIGGER MOVED (T22); THE CLAIM DID NOT. This case used `feature status` from the worktree
// only as a convenient way to REACH the default-mode refusal — the claim was always about the
// remediation text, never about status. Status is read-only and now resolves
// {fromAnyWorktree:true} (the T21 fixture-audit finding), so from the worktree it SUCCEEDS and
// triggers nothing. `feature abandon` is the trigger now: it is a write path and keeps default-mode
// resolution BY DESIGN, and it refuses in resolveProject — before it reads the manifest or touches
// the worktree — so the case still exercises the refusal without destroying anything (asserted).
test('the not-a-registered-project remediation names the MAIN repo root, never the worktree', () => {
  const s = scenario();
  const r0 = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r0.status, 0, r0.stderr);
  const wt = realpathSync(worktreeOf(s, 'f1'));

  // `feature abandon f1` from inside f1's own checkout: refuses (default mode resolves by checkout).
  const r = featureFrom(s, wt, 'abandon', 'f1');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /is not a registered project/);
  assert.match(r.stderr, new RegExp(`--root ${s.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    `remediation must name the main repo root ${s.repo}, got: ${r.stderr}`);
  assert.ok(!r.stderr.includes(`--root ${wt}`),
    `remediation named the WORKTREE — that command corrupts the registration: ${r.stderr}`);
  // The refused write path destroyed nothing — which is the reason it keeps the default mode.
  assert.ok(existsSync(wt), 'a refused abandon must leave the worktree standing');
  assert.equal(readManifest(s, 'f1').status, 'active', 'and the manifest untouched');
});

// --- T22: `feature status` is READ-ONLY, so it resolves by REPOSITORY ----------------------------
// The carried finding from T21's fixture audit (test/acceptance/M0-FIXTURE-LEDGER.md row 5 /
// findings item 1): status resolved by CHECKOUT, so from the worktree PLAN-V3 §Startup step 5
// launches every session into, the first command a resumed session runs answered "repo … is not a
// registered project". Both tests below fail if `{fromAnyWorktree:true}` is reverted; the test
// above is what fails if the mode leaks onto a write path.
test('feature status runs from INSIDE a feature worktree — both forms, identical to the main repo root', () => {
  const s = scenario();
  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 0);
  assert.equal(feature(s, 'start', 'f2', '--base', 'main').status, 0);
  const wt = realpathSync(worktreeOf(s, 'f1'));

  // named form — the resumed session's own question: "what stage am I in"
  const named = featureFrom(s, wt, 'status', 'f1');
  assert.equal(named.status, 0, `status must succeed from inside the worktree: ${named.stderr}`);
  assert.match(named.stdout, /feature default\/fix-proj\/f1/);
  assert.match(named.stdout, /stage: {4}intake/);
  assert.equal(named.stdout, feature(s, 'status', 'f1').stdout,
    'the same answer wherever in the repository it is asked from — the cwd selects nothing');

  // list form — and it lists the WHOLE project, not just the feature whose checkout we stand in
  const list = featureFrom(s, wt, 'status');
  assert.equal(list.status, 0, `the list form must succeed from inside the worktree: ${list.stderr}`);
  assert.deepEqual(list.stdout.trim().split('\n'), [
    'f1  active  intake  feat/f1',
    'f2  active  intake  feat/f2',
  ]);
  assert.equal(list.stdout, feature(s, 'status').stdout);

  // resolution is by REPOSITORY, so another feature's checkout answers identically — a session
  // that opened the wrong worktree gets the truth, not a different truth.
  const cross = featureFrom(s, realpathSync(worktreeOf(s, 'f2')), 'status', 'f1');
  assert.equal(cross.status, 0, cross.stderr);
  assert.equal(cross.stdout, named.stdout);
});

test('--org still disambiguates feature status from inside a worktree; the bare form still refuses', () => {
  // A repo registered under two orgs makes resolveProject ambiguous, and the mode change must not
  // quietly pick one: the refusal and the --org filter both live above the mode switch, and this
  // pins that they survive it.
  const s = scenario();
  const second = spawnSync(process.execPath, [BIN, 'project', 'init', '--root', s.repo, '--org', 'acme'], {
    encoding: 'utf8', env: { ...process.env, LEGION_HOME: s.home },
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(feature(s, 'start', 'f1', '--base', 'main', '--org', 'default').status, 0);
  const wt = realpathSync(worktreeOf(s, 'f1'));

  const bare = featureFrom(s, wt, 'status');
  assert.equal(bare.status, 1, bare.stdout);
  assert.match(bare.stderr, /matches multiple projects .* disambiguate with --org/);
  assert.match(bare.stderr, new RegExp(`repo ${s.repo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`),
    'and the ambiguity is reported against the MAIN repo root it was resolved to');

  const mine = featureFrom(s, wt, 'status', '--org', 'default');
  assert.equal(mine.status, 0, mine.stderr);
  assert.deepEqual(mine.stdout.trim().split('\n'), ['f1  active  intake  feat/f1']);

  const other = featureFrom(s, wt, 'status', '--org', 'acme');
  assert.equal(other.status, 0, other.stderr);
  assert.match(other.stdout, /no features for acme\/fix-proj/,
    '--org selects the project, not the cwd — the other org has no features');
});

// --- T12: a malformed gates block fails START, not the first gate run ---------------------------

test('start REFUSES a malformed gates block — strictly earlier and louder than the first gate run', () => {
  // The pin is computed from validateGatesConfig()'s normalized triple, so a broken `gates` block
  // is now a refused `feature start` (deliberate consequence of pinning: PLAN-V3 §Gates). Nothing
  // may be left behind — the refusal happens before the manifest is written and before the
  // worktree exists.
  const s = scenario();
  const cfg = JSON.parse(readFileSync(cfgPath(s), 'utf8'));
  writeFileSync(cfgPath(s), JSON.stringify({ ...cfg, gates: { commands: { ok: { argv: 'npm test', timeoutMs: 1 } }, task: ['ok'] } }, null, 2) + '\n');

  const r = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /gates\.commands\.ok\.argv must be a non-empty array of strings/,
    'the refusal must name the offending KEY, as the gate does');
  assert.ok(!existsSync(join(dossier(s, 'f1'), 'feature.json')), 'no manifest may be written');
  assert.ok(!existsSync(worktreeOf(s, 'f1')), 'no worktree may be created');
});

// --- T23: additional intake repositories (`--add-repo`, repeatable) ----------------------------
// The transport initiatives ride on (PLAN-V3 §Milestones post-M0, §Initiatives): a feature can be
// STARTED with other repositories attached, and the launch line puts each in the session's reach.
// The refusals carry the weight — an attachment that is not a main repository root is either
// unreadable (a corner of a repo) or meaningless (the feature's own repo, a duplicate, a bare
// repo), and every one of them must cost the operator NOTHING to retry: no dossier, no worktree.

test('start REFUSES an --add-repo that is not a main repository root, naming what it is — and leaves NO trace', () => {
  const s = scenario();
  const other = extraRepo(s, 'other');

  // a linked worktree OF the attachable repo — the likeliest mistake, since every legion session
  // runs inside one (PLAN-V3 §Startup step 5)
  const linked = join(s.base, 'other-wt');
  sh(other, 'worktree', 'add', '-b', 'side', linked);
  // a subdirectory of it
  const sub = join(other, 'src');
  mkdirSync(sub, { recursive: true });
  // a plain directory in no repository at all, and a plain file
  const plain = join(s.base, 'plain-dir');
  mkdirSync(plain, { recursive: true });
  const file = join(s.base, 'a-file.txt');
  writeFileSync(file, 'not a repo\n');
  // a BARE repository: `git worktree list` names it as its own root, so it passes every root check
  // and still has no working tree for the intake session to read
  const bare = join(s.base, 'bare.git');
  mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '--bare');

  const cases = [
    [[join(s.base, 'nope')], /--add-repo .*: .*nope does not exist/],
    [[file], /is a file, not a directory/],
    [[sub], new RegExp(`is a subdirectory of ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)],
    [[linked], new RegExp(`is a LINKED WORKTREE of ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)],
    [[plain], /is not inside a git repository/],
    [[bare], /is a BARE repository/],
    [[s.repo], /is this feature's OWN repository/],
    [[other, other], /is already attached/],
  ];
  for (const [paths, expected] of cases) {
    const r = feature(s, 'start', 'f1', '--base', 'main', ...paths.flatMap((p) => ['--add-repo', p]));
    assert.equal(r.status, 1, `${paths.join(' ')} must be refused, got:\n${r.stdout}`);
    assert.match(r.stderr, expected);
    assert.ok(!existsSync(join(dossier(s, 'f1'), 'feature.json')), `${paths.join(' ')}: no manifest may be written`);
    assert.ok(!existsSync(worktreeOf(s, 'f1')), `${paths.join(' ')}: no worktree may be created`);
  }
  // and the three near-miss refusals name the root that WOULD work, so the retry is one edit away
  for (const p of [sub, linked]) {
    const r = feature(s, 'start', 'f1', '--base', 'main', '--add-repo', p);
    assert.match(r.stderr, new RegExp(`--add-repo ${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `the refusal for ${p} must name the main root to use instead: ${r.stderr}`);
  }

  // the refused starts really did cost nothing: the same name starts cleanly afterwards
  const ok = feature(s, 'start', 'f1', '--base', 'main', '--add-repo', other);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(readManifest(s, 'f1').intakeRepos, [other]);
});

test('--add-repo records realpath-resolved roots in ARGV ORDER and every one reaches the session', () => {
  const s = scenario();
  const a = extraRepo(s, 'repo-a');
  const b = extraRepo(s, 'repo-b');
  // deliberately mixed: inline form, a RELATIVE path (resolved against cwd == the fixture repo),
  // and reverse alphabetical order — the recorded order is argv's, not the filesystem's.
  const r = feature(s, 'start', 'f1', '--base', 'main', `--add-repo=${b}`, '--add-repo', '../repo-a');
  assert.equal(r.status, 0, r.stderr);

  const f = readManifest(s, 'f1');
  assert.deepEqual(f.intakeRepos, [b, a], 'absolute, realpath-resolved, in the order they were given');

  // THE LAUNCH LINE IS THE REACH: one --add-dir per attached repo, after the dossier's, before the
  // prompt (which must stay the last word). Every path single-quote escaped like the rest.
  assert.ok(r.stdout.includes(
    `cd '${worktreeOf(s, 'f1')}' && claude ${PLUGIN_FLAG}--add-dir '${dossier(s, 'f1')}' `
    + `--add-dir '${b}' --add-dir '${a}' '/legion:feature resume default/fix-proj/f1'`,
  ), `launch command missing or mis-ordered in:\n${r.stdout}`);
  // and start REPORTS what it derived — the operator typed '../repo-a', not this
  assert.match(r.stdout, new RegExp(`add-repo: ${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}, ${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

  // status prints them too, one line, for a session asking what it is attached to
  const st = feature(s, 'status', 'f1');
  assert.equal(st.status, 0, st.stderr);
  assert.equal(st.stdout.split('\n').filter((l) => l.includes('add-repo:')).length, 1, 'one line, not one per repo');
  assert.match(st.stdout, /add-repo: /);
  assert.ok(st.stdout.includes(a) && st.stdout.includes(b), st.stdout);

  // every launch mode carries them — the flag composition must not be interactive-only
  for (const mode of ['background', 'remote']) {
    const rm = feature(s, 'start', `f-${mode}`, '--base', 'main', '--add-repo', a, `--launch=${mode}`);
    assert.equal(rm.status, 0, rm.stderr);
    assert.ok(rm.stdout.includes(`--add-dir '${dossier(s, `f-${mode}`)}' --add-dir '${a}' '/legion:feature resume`),
      `${mode} launch must carry the attached repo: ${rm.stdout}`);
  }
});

test('without --add-repo there is NO intakeRepos key and the launch carries exactly one --add-dir', () => {
  // Absence is the common case and the compatibility story for every manifest written before T23:
  // it must be a missing key (not an empty array) and must change nothing anywhere.
  const s = scenario();
  const r = feature(s, 'start', 'f1', '--base', 'main');
  assert.equal(r.status, 0, r.stderr);
  const f = readManifest(s, 'f1');
  assert.equal('intakeRepos' in f, false, 'no empty-array noise in a single-repo manifest');

  const launch = r.stdout.split('\n').find((l) => l.includes('&& claude '));
  assert.equal(launch.match(/--add-dir /g).length, 1, `exactly the dossier's own --add-dir: ${launch}`);
  assert.ok(launch.includes(`--add-dir '${dossier(s, 'f1')}' '/legion:feature resume default/fix-proj/f1'`), launch);

  const st = feature(s, 'status', 'f1');
  assert.doesNotMatch(st.stdout, /add-repo/, 'no line at all when there is nothing to say');
});

test('--repair carries intakeRepos through untouched, and REFUSES to be handed new ones', () => {
  const s = scenario();
  const a = extraRepo(s, 'repo-a');
  const b = extraRepo(s, 'repo-b');
  setBootstrap(s, [{ cwd: '.', argv: [join(s.base, 'nope.sh')], timeoutMs: 5000 }]);
  assert.equal(feature(s, 'start', 'f1', '--base', 'main', '--add-repo', a).status, 1, 'bootstrap must fail');
  assert.deepEqual(readManifest(s, 'f1').intakeRepos, [a], 'recorded before the worktree, so it survives');

  setBootstrap(s, [{ cwd: '.', argv: ['/usr/bin/true'], timeoutMs: 5000 }]);
  // repair re-runs bootstrap and re-derives NOTHING, so a new --add-repo would be silently dropped
  const bad = feature(s, 'start', 'f1', '--base', 'main', '--repair', '--add-repo', b);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stderr, /--add-repo cannot be combined with --repair/);
  assert.equal(readManifest(s, 'f1').status, 'initialization_failed', 'the refusal repaired nothing either');

  const ok = feature(s, 'start', 'f1', '--base', 'main', '--repair');
  assert.equal(ok.status, 0, ok.stderr);
  const repaired = readManifest(s, 'f1');
  assert.equal(repaired.status, 'active');
  assert.deepEqual(repaired.intakeRepos, [a], 'repair rewrites by spread: the attached repos are untouched');
  assert.ok(ok.stdout.includes(`--add-dir '${a}'`), `the repaired launch line still reaches it: ${ok.stdout}`);
});

test('--repair carries the pin through untouched — repair re-runs bootstrap, it never re-pins', () => {
  const s = scenario();
  const bad = join(s.base, 'nope.sh');
  setBootstrap(s, [{ cwd: '.', argv: [bad], timeoutMs: 5000 }]);
  assert.equal(feature(s, 'start', 'f1', '--base', 'main').status, 1, 'bootstrap must fail');
  const failed = readManifest(s, 'f1');
  assert.equal(failed.status, 'initialization_failed');
  const pin = failed.commandPolicyHash;
  assert.match(pin.task, /^[0-9a-f]{64}$/, 'the pin is written before the worktree, so it survives');

  setBootstrap(s, [{ cwd: '.', argv: ['/usr/bin/true'], timeoutMs: 5000 }]);
  assert.equal(feature(s, 'start', 'f1', '--base', 'main', '--repair').status, 0);
  const repaired = readManifest(s, 'f1');
  assert.equal(repaired.status, 'active');
  assert.deepEqual(repaired.commandPolicyHash, pin, 'repair rewrites by spread: the pin is untouched');
  assert.equal(repaired.commandPolicyPinnedAt, failed.commandPolicyPinnedAt);
});
