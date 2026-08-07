// End-to-end guard for `legion doctor` (PLAN-V3: "env, hooks, glab, branch protection,
// version pin").
//
// THIS SUITE NEVER SPAWNS `claude` OR `glab` AND NEVER TOUCHES THE NETWORK. Every external
// probe in doctor goes through the injected kernel/runner.mjs seam, and these tests drive the
// exported doctorCore(argv, deps) in-process with a RECORDING FAKE — so "a check probed
// nothing" (the unset-pin case) is observable as an empty call list rather than inferred, and
// a real `glab api` can never leak out of a test run.
//
// LEGION_HOME is pinned to a per-scenario temp dir and process.cwd() is moved into the fixture
// repo (doctor resolves the project by repo root), BOTH restored in a finally: the real
// ~/.legion is never read or written, and nothing leaks into sibling tests.
//
// THE READ-ONLY CLAIM IS TESTED, NOT ASSERTED IN PROSE: the last test snapshots every file
// under the temp home and the fixture repo (path, size, mtime, bytes) before and after a full
// run and requires them byte-identical.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync,
  statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  doctorCore, cmpSemver, gitlabProjectPath, branchPatternMatches, glabHost, parseGlabAuthHosts,
  CHECK_IDS, MIN_CLAUDE_VERSION,
} from '../../src/cli/doctor.mjs';
import { readJson } from '../../src/kernel/fsatomic.mjs';
import { writeJson } from '../../src/kernel/fsatomic.mjs';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';

// HERMETIC GIT: neuters global/system config and every inherited GIT_* variable, and pins a
// deterministic identity — the fixture repos below must not depend on the operator's config.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'legion.mjs');
const NODE = process.execPath;

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-doctor-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) => sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);

let n = 0;
/** Fresh sandbox: isolated LEGION_HOME + a one-commit repo with origin
 * git@gitlab.invalid:acme/fix-proj.git, registered via the REAL bin (`project init`), whose
 * protected set therefore defaults to ['main'] exactly as a real onboarding produces it. */
function scenario({ initArgs = [] } = {}) {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'fix-proj' }, null, 2)}\n`);
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  // Never fetched from, never pushed to: doctor only READS the recorded remoteUrl.
  sh(repo, 'remote', 'add', 'origin', 'git@gitlab.invalid:acme/fix-proj.git');
  const env = { ...process.env, LEGION_HOME: home };
  const r = spawnSync(NODE, [BIN, 'project', 'init', '--root', repo, ...initArgs], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  return {
    home,
    repo: realpathSync(repo),
    configPath: join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json'),
  };
}

/** Run doctorCore with LEGION_HOME + cwd pointed anywhere, both always restored. */
async function inDir(dir, homeDir, argv, deps) {
  const cwd = process.cwd();
  const home = process.env.LEGION_HOME;
  process.chdir(dir);
  process.env.LEGION_HOME = homeDir;
  try {
    return await doctorCore(argv, deps);
  } finally {
    process.chdir(cwd);
    if (home === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = home;
  }
}

/** The common case: cwd in the scenario's MAIN checkout. */
const inScenario = (s, argv, deps) => inDir(s.repo, s.home, argv, deps);

// --- the fake runner ---------------------------------------------------------------------------

/** responses: {'<file> <args...>' prefix: {ok?, code?, stdout?, stderr?, spawnError?}}.
 * Longest matching prefix wins, so 'glab api projects/X' and 'glab api projects/X/protected_
 * branches' can both be configured. An unconfigured probe THROWS — a check that starts calling
 * something new must be noticed here, not silently defaulted to green. */
function makeRun(responses) {
  const keys = Object.keys(responses).sort((a, b) => b.length - a.length);
  const fn = (file, args = [], opts = {}) => {
    const key = [file, ...args].join(' ');
    fn.calls.push({ key, file, args, opts });
    const hit = keys.find((k) => key === k || key.startsWith(k));
    if (hit === undefined) throw new Error(`fake runner: no response configured for \`${key}\``);
    const r = responses[hit];
    return {
      ok: r.ok ?? (r.spawnError == null && (r.code ?? 0) === 0),
      code: r.code ?? 0,
      signal: null,
      stdout: r.stdout ?? '',
      stderr: r.stderr ?? '',
      spawnError: r.spawnError ?? null,
    };
  };
  fn.calls = [];
  return fn;
}

const PROJ = 'glab api projects/acme%2Ffix-proj';
const MAINTAINER_ONLY = [{
  name: 'main',
  push_access_levels: [{ access_level: 40, user_id: null, group_id: null }],
  merge_access_levels: [{ access_level: 40, user_id: null, group_id: null }],
}];

/** A fully-healthy environment: claude 2.9.9, glab authed, we are a DEVELOPER (30) on a project
 * whose `main` admits only maintainers (40) — i.e. verified-protected. */
function green(over = {}) {
  return makeRun({
    'claude --version': { stdout: '2.9.9 (Claude Code)\n' },
    'glab auth status': { stderr: 'gitlab.invalid\n  ✓ Logged in as legion-bot\n' },
    'glab api user': { stdout: JSON.stringify({ id: 7, username: 'legion-bot' }) },
    [PROJ]: { stdout: JSON.stringify({ permissions: { project_access: { access_level: 30 }, group_access: null } }) },
    [`${PROJ}/protected_branches`]: { stdout: JSON.stringify(MAINTAINER_ONLY) },
    ...over,
  });
}

const DEPS = (run, over = {}) => ({ run, nodeVersion: 'v22.14.0', minClaudeVersion: '2.0.0', ...over });
const levels = (r) => Object.fromEntries(r.checks.map((c) => [c.check, c.level]));

// --- pure helpers -------------------------------------------------------------------------------

test('cmpSemver orders triples numerically and ignores a prerelease suffix', () => {
  assert.equal(cmpSemver('2.0.0', '2.0.0'), 0);
  assert.equal(cmpSemver('1.9.9', '2.0.0'), -1);
  assert.equal(cmpSemver('2.10.0', '2.9.0'), 1, '10 > 9 numerically, not lexically');
  assert.equal(cmpSemver('2.0.1-beta.1', '2.0.0'), 1);
});

test('gitlabProjectPath parses both remote forms and refuses to guess', () => {
  assert.equal(gitlabProjectPath('git@gitlab.invalid:acme/fix-proj.git'), 'acme/fix-proj');
  assert.equal(gitlabProjectPath('https://gitlab.invalid/acme/sub/fix-proj.git'), 'acme/sub/fix-proj');
  assert.equal(gitlabProjectPath('ssh://git@gitlab.invalid/acme/fix-proj.git'), 'acme/fix-proj');
  for (const bad of [null, '', '   ', '/local/path/repo.git', 'not a url', 'file:///somewhere/odd', 'git@host:repo.git']) {
    assert.equal(gitlabProjectPath(bad), null, `must not guess a project path from ${JSON.stringify(bad)}`);
  }
});

test('branchPatternMatches honours GitLab wildcards and stays anchored', () => {
  assert.ok(branchPatternMatches('main', 'main'));
  assert.ok(!branchPatternMatches('main', 'mainX'), 'anchored: a prefix is not a match');
  assert.ok(branchPatternMatches('release/*', 'release/1.0'));
  assert.ok(!branchPatternMatches('release/*', 'hotfix/1.0'));
  assert.ok(!branchPatternMatches('main.x', 'mainYx'), 'the dot is escaped, not a wildcard');
});

// --- the green baseline --------------------------------------------------------------------------

test('a fully-green environment: six passes, exit 0', async () => {
  const s = scenario();
  const run = green();
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(r.code, 0, r.output);
  assert.deepEqual(r.checks.map((c) => c.check), CHECK_IDS);
  for (const c of r.checks) assert.equal(c.level, 'pass', `${c.check}: ${c.detail}`);
  assert.match(r.output, /doctor: 6 pass, 0 warn, 0 fail/);
  assert.ok(!r.output.includes('FAIL —'), 'a green run must not print the verdict line');
});

// --- node --------------------------------------------------------------------------------------

test('an old node flips ONLY the node check, and the exit code with it', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green(), { nodeVersion: 'v18.20.0' }));
  assert.equal(r.code, 1);
  assert.deepEqual(levels(r), {
    node: 'fail', 'claude-version': 'pass', 'plugin-manifest': 'pass', 'glab-auth': 'pass',
    'branch-protection': 'pass', 'remote-guards': 'pass',
  });
  assert.match(r.checks[0].detail, /below the required >= 22/);
  assert.match(r.output, /FAIL — fix the failing checks/);
});

// --- claude version pin ----------------------------------------------------------------------------

test('no pin ⇒ claude-version WARNs, exit stays 0, and claude is never probed', async () => {
  const s = scenario();
  const run = green();
  const r = await inScenario(s, [], DEPS(run, { minClaudeVersion: null }));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['claude-version'], 'warn');
  assert.match(r.checks[1].detail, /no minimum Claude Code version is pinned/);
  assert.equal(run.calls.filter((c) => c.file === 'claude').length, 0,
    'with no pin there is nothing to compare against — probing anyway would invite a silent pass');
});

test('claude absent ⇒ claude-version WARNs (the pin is unverified, not violated), exit 0', async () => {
  // doctor is run from plain shells where `claude` need not be on PATH. "We could not read a
  // version" is not "your Claude Code is too old" — the only evidence that earns a FAIL here.
  const s = scenario();
  const run = green({ 'claude --version': { spawnError: 'ENOENT' } });
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(r.code, 0, 'an unknown must not fail the command');
  assert.equal(levels(r)['claude-version'], 'warn');
  assert.match(r.checks[1].detail, /claude not found on PATH/);
  assert.match(r.checks[1].detail, /pinned minimum 2\.0\.0 is UNVERIFIED/, 'the warn must name the pin it could not check');
});

test('a spawn error other than ENOENT ⇒ the same UNVERIFIED warn', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({ 'claude --version': { spawnError: 'EACCES' } })));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['claude-version'], 'warn');
  assert.match(r.checks[1].detail, /could not run: EACCES/);
});

test('claude below the pin fails; exactly at the pin passes', async () => {
  const s = scenario();
  const below = await inScenario(s, [], DEPS(green({ 'claude --version': { stdout: '1.0.0 (Claude Code)\n' } })));
  assert.equal(below.code, 1);
  assert.equal(levels(below)['claude-version'], 'fail');
  assert.match(below.checks[1].detail, /1\.0\.0 is below the pinned minimum 2\.0\.0/);

  const equal = await inScenario(s, [], DEPS(green({ 'claude --version': { stdout: '2.0.0 (Claude Code)\n' } })));
  assert.equal(equal.code, 0);
  assert.equal(levels(equal)['claude-version'], 'pass');
});

test('unparseable claude output ⇒ warn — an unknown version is never a pass and never a verdict', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({ 'claude --version': { stdout: 'claude code (dev build)\n' } })));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['claude-version'], 'warn');
  assert.match(r.checks[1].detail, /could not parse a version/);
  assert.match(r.checks[1].detail, /UNVERIFIED/);
  assert.ok(!/pass/i.test(r.checks[1].detail), 'an unknown must not read as green anywhere in the words either');
});

test('a non-zero `claude --version` warns naming the exit code', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({ 'claude --version': { code: 127, stderr: 'boom' } })));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['claude-version'], 'warn');
  assert.match(r.checks[1].detail, /exited 127: boom/);
});

test('the SHIPPED pin is 2.1.219 — the build every shipped hook and skill format was validated against', () => {
  // M0 finding 4: an unpinned minimum verifies nothing. The number is not free-floating — it is
  // the build hooks/hooks.json, hooks/_common.mjs and skills/feature/SKILL.md all name, and the
  // pin may never sit BELOW the version those components were validated against.
  assert.equal(MIN_CLAUDE_VERSION, '2.1.219');
  const declared = new Set();
  for (const rel of ['hooks/hooks.json', 'hooks/_common.mjs', 'skills/feature/SKILL.md']) {
    const m = /VALIDATED AGAINST CLAUDE CODE (\d+\.\d+\.\d+)|validated against Claude Code (\d+\.\d+\.\d+)/
      .exec(readFileSync(join(ROOT, rel), 'utf8'));
    assert.ok(m, `${rel} must state the Claude Code build it was validated against`);
    declared.add(m[1] ?? m[2]);
  }
  assert.equal(declared.size, 1, `the shipped components must agree on one build, got ${[...declared].join(', ')}`);
  assert.ok(cmpSemver(MIN_CLAUDE_VERSION, [...declared][0]) >= 0,
    'the pin must never be below the build the shipped components were validated against');
});

test('with NO deps override the real pin is enforced: 2.1.218 fails, 2.1.219 passes, a build tag parses', async () => {
  const s = scenario();
  // deps without minClaudeVersion ⇒ doctorCore falls back to MIN_CLAUDE_VERSION itself, so this
  // is the check as the operator actually runs it.
  const at = async (v) => inScenario(s, [], { run: green({ 'claude --version': { stdout: v } }), nodeVersion: 'v22.14.0' });

  const below = await at('2.1.218 (Claude Code)\n');
  assert.equal(levels(below)['claude-version'], 'fail', below.checks[1].detail);
  assert.equal(below.code, 1, 'a version we READ and that is below the pin is the one FAIL this check has');
  assert.match(below.checks[1].detail, /2\.1\.218 is below the pinned minimum 2\.1\.219/);

  const exact = await at('2.1.219 (Claude Code)\n');
  assert.equal(levels(exact)['claude-version'], 'pass', exact.checks[1].detail);

  const smoked = await at('2.1.220 (Claude Code)\n');
  assert.equal(levels(smoked)['claude-version'], 'pass', 'the version M0 actually ran on');
  assert.match(smoked.checks[1].detail, /Claude Code 2\.1\.220 \(>= pinned minimum 2\.1\.219\)/,
    'the trailing build tag must not leak into the reported version');
});

// --- plugin manifest -------------------------------------------------------------------------------

test('the REAL plugin root passes the manifest check', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(levels(r)['plugin-manifest'], 'pass');
  assert.match(r.checks[2].detail, /plugin manifest and components valid/);
});

test('a plugin root missing hooks/ fails ONLY the manifest check', async () => {
  const s = scenario();
  const broken = join(TMP, `plugin-nohooks-${n++}`);
  mkdirSync(join(broken, '.claude-plugin'), { recursive: true });
  for (const d of ['skills', 'agents', 'bin']) mkdirSync(join(broken, d), { recursive: true });
  writeFileSync(join(broken, 'bin', 'legion.mjs'), '#!/usr/bin/env node\n');
  writeJson(join(broken, '.claude-plugin', 'plugin.json'),
    { name: 'legion', description: 'x', version: '0.1.0', author: { name: 'a' } });
  writeJson(join(broken, 'package.json'), { name: 'legion', bin: { legion: './bin/legion.mjs' } });

  const r = await inScenario(s, [], DEPS(green(), { pluginRoot: broken }));
  assert.equal(r.code, 1);
  assert.deepEqual(levels(r), {
    node: 'pass', 'claude-version': 'pass', 'plugin-manifest': 'fail', 'glab-auth': 'pass',
    'branch-protection': 'pass', 'remote-guards': 'pass',
  });
  assert.match(r.checks[2].detail, /component directory hooks\/ is missing/);
});

test('a malformed manifest, a bad version and a dangling declared path all fail', async () => {
  const s = scenario();

  const unparseable = join(TMP, `plugin-bad-json-${n++}`);
  mkdirSync(join(unparseable, '.claude-plugin'), { recursive: true });
  writeFileSync(join(unparseable, '.claude-plugin', 'plugin.json'), '{ not json');
  let r = await inScenario(s, [], DEPS(green(), { pluginRoot: unparseable }));
  assert.equal(levels(r)['plugin-manifest'], 'fail');
  assert.match(r.checks[2].detail, /cannot read plugin manifest/);

  const bad = join(TMP, `plugin-bad-fields-${n++}`);
  mkdirSync(join(bad, '.claude-plugin'), { recursive: true });
  for (const d of ['skills', 'agents', 'hooks', 'bin']) mkdirSync(join(bad, d), { recursive: true });
  writeFileSync(join(bad, 'bin', 'legion.mjs'), '#!/usr/bin/env node\n');
  writeJson(join(bad, '.claude-plugin', 'plugin.json'), {
    name: 'legion', description: '', version: 'v1', author: {},
    hooks: './hooks/nope.json',
  });
  writeJson(join(bad, 'package.json'), { name: 'legion', bin: { legion: './bin/legion.mjs' } });
  r = await inScenario(s, [], DEPS(green(), { pluginRoot: bad }));
  assert.equal(levels(r)['plugin-manifest'], 'fail');
  for (const re of [/description must be a non-empty string/, /author\.name must be/, /version must be X\.Y\.Z/,
    /declared hooks path \.\/hooks\/nope\.json does not exist/]) {
    assert.match(r.checks[2].detail, re);
  }
});

test('a declared component path that DOES exist is accepted', async () => {
  const s = scenario();
  const ok = join(TMP, `plugin-declared-${n++}`);
  mkdirSync(join(ok, '.claude-plugin'), { recursive: true });
  for (const d of ['skills', 'agents', 'hooks', 'bin']) mkdirSync(join(ok, d), { recursive: true });
  writeFileSync(join(ok, 'bin', 'legion.mjs'), '#!/usr/bin/env node\n');
  writeFileSync(join(ok, 'hooks', 'hooks.json'), '{}\n');
  writeJson(join(ok, '.claude-plugin', 'plugin.json'), {
    name: 'legion', description: 'd', version: '0.1.0', author: { name: 'a' },
    hooks: '${CLAUDE_PLUGIN_ROOT}/hooks/hooks.json',
  });
  writeJson(join(ok, 'package.json'), { name: 'legion', bin: { legion: './bin/legion.mjs' } });
  const r = await inScenario(s, [], DEPS(green(), { pluginRoot: ok }));
  assert.equal(levels(r)['plugin-manifest'], 'pass', r.checks[2].detail);
});

// --- glab ------------------------------------------------------------------------------------------

test('glab missing ⇒ glab-auth FAILS and branch-protection WARNS (not fails), exit 1', async () => {
  const s = scenario();
  const run = green({ 'glab auth status': { spawnError: 'ENOENT' } });
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(r.code, 1, 'driven by glab-auth alone');
  assert.equal(levels(r)['glab-auth'], 'fail');
  assert.equal(levels(r)['branch-protection'], 'warn',
    'unreachable server means UNVERIFIED, never "unprotected"');
  assert.match(r.checks[3].detail, /glab not found on PATH/);
  assert.match(r.checks[4].detail, /UNVERIFIED/);
  assert.match(r.checks[4].detail, /best-effort/);
  assert.equal(run.calls.filter((c) => c.args[0] === 'api').length, 0,
    'with glab down there is nothing to query — the check must not pretend to');
});

test('glab installed but unauthenticated ⇒ same shape, with the login remediation', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({ 'glab auth status': { code: 1, stderr: 'not logged in' } })));
  assert.equal(r.code, 1);
  assert.equal(levels(r)['glab-auth'], 'fail');
  assert.match(r.checks[3].detail, /not authenticated .*glab auth login/);
  assert.equal(levels(r)['branch-protection'], 'warn');
});

// --- host-aware glab auth (M0 finding 3) --------------------------------------------------------

test('glabHost derives the host from every remote form, and refuses to guess', () => {
  assert.equal(glabHost('git@gitlab.invalid:acme/fix-proj.git'), 'gitlab.invalid', 'scp-like');
  assert.equal(glabHost('https://gitlab.invalid/acme/sub/fix-proj.git'), 'gitlab.invalid', 'https');
  assert.equal(glabHost('ssh://git@gitlab.invalid:2222/acme/fix-proj.git'), 'gitlab.invalid', 'ssh with a port');
  assert.equal(glabHost('ssh://git@gitlab.invalid/acme/fix-proj.git'), 'gitlab.invalid', 'ssh without a port');
  assert.equal(glabHost('https://user:tok@gitlab.invalid:8443/a/b.git'), 'gitlab.invalid', 'userinfo and port both stripped');
  assert.equal(glabHost('HTTPS://GitLab.Invalid/a/b.git'), 'gitlab.invalid', 'hosts are case-insensitive');
  assert.equal(glabHost('https://gitlab/a/b.git'), 'gitlab', 'a single-label internal host is still unambiguous');
  for (const bad of [null, undefined, 42, '', '   ', '/local/path/repo.git', 'not a url', 'file:///somewhere/odd', './rel/path']) {
    assert.equal(glabHost(bad), null, `must not guess a host from ${JSON.stringify(bad)}`);
  }
});

/** The M0 configuration, in shape: a token-less gitlab.com entry left over from a `glab auth
 * login` walkthrough sitting next to the fully authenticated TARGET host. `glab auth status`
 * exits non-zero because ONE host is broken — the global code doctor used to inherit. */
const M0_STATUS = {
  code: 1,
  stderr: [
    'gitlab.com',
    '  x gitlab.com: API call failed: GET https://gitlab.com/api/v4/user: 401 (Unauthorized)',
    '  - No token provided',
    '',
    'gitlab.intech.dev',
    '  ✓ Logged in to gitlab.intech.dev as legion-bot (keyring)',
    '  ✓ Git operations for gitlab.intech.dev configured to use ssh protocol.',
    '  ✓ Token: **************************',
    '',
  ].join('\n'),
};

test('parseGlabAuthHosts reads the per-host blocks and never invents a host', () => {
  assert.deepEqual(parseGlabAuthHosts(M0_STATUS.stderr), [
    { host: 'gitlab.com', authenticated: false },
    { host: 'gitlab.intech.dev', authenticated: true },
  ]);
  // A block with neither marker is UNKNOWN, which is not authenticated.
  assert.deepEqual(parseGlabAuthHosts('gitlab.invalid\n  something new upstream prints\n'),
    [{ host: 'gitlab.invalid', authenticated: false }]);
  // A ✓ block that ALSO carries an error line is not authenticated.
  assert.deepEqual(parseGlabAuthHosts('gitlab.invalid\n  ✓ Logged in\n  x token expired\n'),
    [{ host: 'gitlab.invalid', authenticated: false }]);
  // Unindented prose is not a host, and indented lines with no open block are dropped.
  for (const noise of ['', 'No hosts configured\n', 'Warning:\n  ✓ nope\n', '  ✓ orphaned line\n']) {
    assert.deepEqual(parseGlabAuthHosts(noise), [], `must read no hosts out of ${JSON.stringify(noise)}`);
  }
});

/** Point the scenario's recorded remote at `url` — `project init` derives it from the fixture
 * repo's origin, and these cases are about hosts other than the fixture's. */
function withRemote(s, url) {
  writeJson(s.configPath, { ...readJson(s.configPath), remoteUrl: url });
  return s;
}

test('THE M0 REGRESSION: a token-less gitlab.com must not fail a green target host', async () => {
  // M0, verbatim: `glab auth status` exits 1 for gitlab.com while the project's own host is
  // fully authenticated, and doctor went red on it. Now only the project's host is judged.
  const s = withRemote(scenario(), 'ssh://git@gitlab.intech.dev:2222/acme/fix-proj.git');
  const run = green({
    'glab auth status': M0_STATUS,
    'glab auth status --hostname gitlab.intech.dev': { stderr: '✓ Logged in to gitlab.intech.dev as legion-bot\n' },
  });
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(levels(r)['glab-auth'], 'pass', r.checks[3].detail);
  assert.equal(r.code, 0, r.output);
  assert.match(r.checks[3].detail, /authenticated for gitlab\.intech\.dev/);
  assert.match(r.checks[3].detail, /default\/fix-proj/, 'the pass must name the project whose host it judged');
  const probes = run.calls.filter((c) => c.args[0] === 'auth');
  assert.deepEqual(probes.map((c) => c.args), [['auth', 'status', '--hostname', 'gitlab.intech.dev']],
    'exactly one, host-scoped probe — the global status is never consulted when a project resolves');
  assert.ok(!r.output.includes('gitlab.com'), 'an unrelated host must not even appear in the report');
});

test('the scoped check still FAILS when the token missing is the PROJECT’s host', async () => {
  // The mirror image, and the reason scoping is not just "be quieter": same glab config, but
  // now gitlab.com IS the target.
  const s = withRemote(scenario(), 'https://gitlab.com/acme/fix-proj.git');
  const run = green({
    'glab auth status': M0_STATUS,
    'glab auth status --hostname gitlab.com': { code: 1, stderr: 'x gitlab.com: 401 (Unauthorized)\n- No token provided' },
  });
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(levels(r)['glab-auth'], 'fail');
  assert.equal(r.code, 1);
  assert.match(r.checks[3].detail, /not authenticated for gitlab\.com/);
  assert.match(r.checks[3].detail, /glab auth login --hostname gitlab\.com/);
  assert.equal(levels(r)['branch-protection'], 'warn', 'an unauthenticated target host leaves protection UNVERIFIED');
});

test('the scoped probe runs from inside a feature worktree too — the cwd every session uses', async () => {
  const s = withRemote(scenario(), 'ssh://git@gitlab.intech.dev/acme/fix-proj.git');
  const wt = worktreeOf(s.repo, 'hostscope');
  const run = green({
    'glab auth status': M0_STATUS,
    'glab auth status --hostname gitlab.intech.dev': { stderr: '✓ Logged in\n' },
  });
  const r = await inDir(wt, s.home, [], DEPS(run));
  assert.equal(levels(r)['glab-auth'], 'pass', r.checks[3].detail);
  assert.ok(run.calls.some((c) => c.args.join(' ') === 'auth status --hostname gitlab.intech.dev'),
    'resolution is fromAnyWorktree, so the check must not silently unscope itself in a worktree');
});

test('NO project resolves ⇒ per-host truth as a WARN, never a FAIL, exit 0', async () => {
  // Same glab config, no project context: doctor cannot know which host matters, so it names
  // both states and refuses to fail on a host this cwd may have nothing to do with.
  const s = scenario();
  const outside = join(TMP, `no-project-${n++}`);
  mkdirSync(outside, { recursive: true });
  const run = green({ 'glab auth status': M0_STATUS });
  const r = await inDir(outside, s.home, [], DEPS(run));
  assert.equal(levels(r)['glab-auth'], 'warn');
  assert.equal(r.code, 0, `an unscoped unknown must not fail the command: ${r.output}`);
  assert.match(r.checks[3].detail, /authenticated for gitlab\.intech\.dev and NOT for gitlab\.com/);
  assert.match(r.checks[3].detail, /no registered project resolves from this cwd/);
  assert.match(r.checks[3].detail, /cannot tell which host matters/);
  assert.deepEqual(run.calls.filter((c) => c.args[0] === 'auth').map((c) => c.args), [['auth', 'status']],
    'with no host to scope to there is nothing to pass --hostname');
});

test('NO project, every configured host authenticated ⇒ pass that says nothing was scoped', async () => {
  const s = scenario();
  const outside = join(TMP, `no-project-green-${n++}`);
  mkdirSync(outside, { recursive: true });
  const r = await inDir(outside, s.home, [], DEPS(green({
    'glab auth status': { stderr: 'gitlab.invalid\n  ✓ Logged in to gitlab.invalid as legion-bot\n' },
  })));
  assert.equal(levels(r)['glab-auth'], 'pass', r.checks[3].detail);
  assert.match(r.checks[3].detail, /gitlab\.invalid/);
  assert.match(r.checks[3].detail, /no single host was verified as the target/);
});

test('NO project, non-zero exit but an all-good parse ⇒ WARN, never a pass on a host it could not read', async () => {
  // The parser is deliberately lossy (AUTH_HOST_LINE requires a dot), so a broken SINGLE-LABEL
  // host — the shape glabHost explicitly supports — is dropped while glab still exits 1. Reading
  // only the surviving block would print "authenticated for every configured host" over a
  // non-zero exit. The exit code withholds the pass; it must still not become a fail.
  const s = scenario();
  const outside = join(TMP, `no-project-partial-${n++}`);
  mkdirSync(outside, { recursive: true });
  const r = await inDir(outside, s.home, [], DEPS(green({
    'glab auth status': {
      code: 1,
      stderr: 'gitlab.com\n  ✓ Logged in to gitlab.com as legion-bot\ngitlab\n  x gitlab: 401 (Unauthorized)\n',
    },
  })));
  assert.deepEqual(parseGlabAuthHosts('gitlab\n  x gitlab: 401\n'), [], 'the premise: a single-label host is dropped');
  assert.equal(levels(r)['glab-auth'], 'warn', r.checks[3].detail);
  assert.equal(r.code, 0, `the exit code may withhold a pass, never inherit a fail: ${r.output}`);
  assert.match(r.checks[3].detail, /exited 1/);
  assert.match(r.checks[3].detail, /gitlab\.com/, 'the hosts it COULD read are still named');
  assert.doesNotMatch(r.checks[3].detail, /authenticated for every configured host/);
});

test('NO project and output no parser can read ⇒ warn stating exactly that, not a pass', async () => {
  const s = scenario();
  const outside = join(TMP, `no-project-opaque-${n++}`);
  mkdirSync(outside, { recursive: true });
  const r = await inDir(outside, s.home, [], DEPS(green({
    'glab auth status': { code: 1, stderr: 'You are not logged into any GitLab hosts.\n' },
  })));
  assert.equal(levels(r)['glab-auth'], 'warn');
  assert.equal(r.code, 0);
  assert.match(r.checks[3].detail, /no per-host state could be read/);
  assert.match(r.checks[3].detail, /not logged into any GitLab hosts/, 'the raw output is quoted for the human');
});

test('a project whose recorded remote names no host falls back to the unscoped probe, and says so', async () => {
  const s = withRemote(scenario(), 'file:///somewhere/odd');
  const run = green({ 'glab auth status': M0_STATUS });
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(levels(r)['glab-auth'], 'warn');
  assert.match(r.checks[3].detail, /records no host-bearing remote \("file:\/\/\/somewhere\/odd"\)/);
  assert.deepEqual(run.calls.filter((c) => c.args[0] === 'auth').map((c) => c.args), [['auth', 'status']],
    'a host we could not derive is never guessed at');
});

test('glab missing is a FAIL on both paths — that one is not a scoping question', async () => {
  const s = scenario();
  const outside = join(TMP, `no-project-noglab-${n++}`);
  mkdirSync(outside, { recursive: true });
  const r = await inDir(outside, s.home, [], DEPS(green({ 'glab auth status': { spawnError: 'ENOENT' } })));
  assert.equal(levels(r)['glab-auth'], 'fail');
  assert.equal(r.code, 1);
  assert.match(r.checks[3].detail, /glab not found on PATH/);
});

// --- branch protection ------------------------------------------------------------------------------

test('VERIFIED-unprotected ⇒ fail, exit 1', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({ [`${PROJ}/protected_branches`]: { stdout: '[]' } })));
  assert.equal(r.code, 1);
  assert.equal(levels(r)['branch-protection'], 'fail');
  assert.match(r.checks[4].detail, /'main' is NOT protected on acme\/fix-proj/);
  assert.match(r.checks[4].detail, /Settings → Repository → Protected branches/);
});

test('the agent identity CAN push ⇒ fail', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({
    [`${PROJ}/protected_branches`]: {
      stdout: JSON.stringify([{
        name: 'main',
        push_access_levels: [{ access_level: 30, user_id: null, group_id: null }],
        merge_access_levels: [{ access_level: 40, user_id: null, group_id: null }],
      }]),
    },
  })));
  assert.equal(r.code, 1);
  assert.equal(levels(r)['branch-protection'], 'fail');
  assert.match(r.checks[4].detail, /CAN push 'main'/);
  assert.match(r.checks[4].detail, /developer \(30\)/);
});

test('an explicit user exception for OUR id ⇒ fail; another user\'s exception ⇒ pass', async () => {
  const s = scenario();
  const rule = (userId) => ({
    stdout: JSON.stringify([{
      name: 'main',
      push_access_levels: [{ access_level: null, user_id: userId, group_id: null }],
      merge_access_levels: [{ access_level: 40, user_id: null, group_id: null }],
    }]),
  });
  const mine = await inScenario(s, [], DEPS(green({ [`${PROJ}/protected_branches`]: rule(7) })));
  assert.equal(mine.code, 1);
  assert.equal(levels(mine)['branch-protection'], 'fail');
  assert.match(mine.checks[4].detail, /user 7\) is an explicit push exception/);

  const theirs = await inScenario(s, [], DEPS(green({ [`${PROJ}/protected_branches`]: rule(99) })));
  assert.equal(theirs.code, 0);
  assert.equal(levels(theirs)['branch-protection'], 'pass', theirs.checks[4].detail);
});

test('a group exception is UNVERIFIABLE ⇒ warn, never a pass', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({
    [`${PROJ}/protected_branches`]: {
      stdout: JSON.stringify([{
        name: 'main',
        push_access_levels: [{ access_level: null, user_id: null, group_id: 12 }],
        merge_access_levels: [{ access_level: 40, user_id: null, group_id: null }],
      }]),
    },
  })));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['branch-protection'], 'warn');
  assert.match(r.checks[4].detail, /group 12, whose membership cannot be evaluated/);
});

test('access_level 0 ("No one") does not grant us anything ⇒ pass', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({
    [`${PROJ}/protected_branches`]: {
      stdout: JSON.stringify([{
        name: 'main',
        push_access_levels: [{ access_level: 0, user_id: null, group_id: null }],
        merge_access_levels: [{ access_level: 40, user_id: null, group_id: null }],
      }]),
    },
  })));
  assert.equal(levels(r)['branch-protection'], 'pass', r.checks[4].detail);
});

test('a glab API error ⇒ warn (exit 0), stating best-effort honestly', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({
    [`${PROJ}/protected_branches`]: { code: 1, stderr: '404 Not Found' },
  })));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['branch-protection'], 'warn');
  assert.match(r.checks[4].detail, /404 Not Found/);
  assert.match(r.checks[4].detail, /only the server is authoritative/);
});

test('non-JSON glab output ⇒ warn, never a crash and never a pass', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({ [PROJ]: { stdout: '<html>login</html>' } })));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['branch-protection'], 'warn');
  assert.match(r.checks[4].detail, /did not return JSON/);
});

test('unknown access level (permissions all null) ⇒ warn, not a pass by arithmetic', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({
    [PROJ]: { stdout: JSON.stringify({ permissions: { project_access: null, group_access: null } }) },
  })));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['branch-protection'], 'warn');
  assert.match(r.checks[4].detail, /access level is unknown/);
});

test('an access-level list the server never sent ⇒ warn, NOT a verified pass', async () => {
  const s = scenario();
  // Absent, null and a non-array: three shapes of "we did not read who may push", each of
  // which iterated as EMPTY before and fell through to "can neither push nor merge".
  for (const [what, rule] of [
    ['absent', { name: 'main', merge_access_levels: [{ access_level: 40, user_id: null, group_id: null }] }],
    ['null', { name: 'main', push_access_levels: null, merge_access_levels: [{ access_level: 40 }] }],
    ['non-array', { name: 'main', push_access_levels: [{ access_level: 40 }], merge_access_levels: { access_level: 40 } }],
  ]) {
    const r = await inScenario(s, [], DEPS(green({ [`${PROJ}/protected_branches`]: { stdout: JSON.stringify([rule]) } })));
    assert.equal(r.code, 0, what);
    assert.equal(levels(r)['branch-protection'], 'warn', `${what}: an unread permission list must never read as proven safe`);
    assert.match(r.checks[4].detail, /could not be read/);
    assert.match(r.checks[4].detail, /UNVERIFIED/);
  }
});

test('an EMPTY access-level list is an answer (nobody may push) ⇒ still a pass', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green({
    [`${PROJ}/protected_branches`]: { stdout: JSON.stringify([{ name: 'main', push_access_levels: [], merge_access_levels: [] }]) },
  })));
  assert.equal(levels(r)['branch-protection'], 'pass', r.checks[4].detail);
});

// --- the cwd legion actually runs in ------------------------------------------------------------

/** A linked worktree of `repo`, laid out the way `legion feature start` lays them out. */
function worktreeOf(repo, name = 'x') {
  const wt = join(dirname(repo), '.legion-worktrees', 'fix-proj', name, 'checkout');
  sh(repo, 'worktree', 'add', '-q', wt, '-b', `feat/${name}`);
  return realpathSync(wt);
}

test('from INSIDE a linked feature worktree — the cwd every session runs in — protection is still VERIFIED', async () => {
  // PLAN-V3 §Startup step 5 launches every session as `cd <worktree> && claude …`. Resolving
  // by checkout finds nothing there, so this check used to warn "unverified" on every real
  // invocation while doctor exited 0 — the one hard boundary of §Remote safety, inert exactly
  // where it is needed.
  const s = scenario();
  const wt = worktreeOf(s.repo);
  const run = green();
  const r = await inDir(wt, s.home, [], DEPS(run));
  assert.equal(r.code, 0, r.output);
  assert.equal(levels(r)['branch-protection'], 'pass', r.checks[4].detail);
  assert.match(r.checks[4].detail, /VERIFIED on acme\/fix-proj/);
  // …and the API was queried from the MAIN repository, not from the worktree.
  for (const c of run.calls.filter((c) => c.args[0] === 'api')) assert.equal(c.opts.cwd, s.repo);
});

test('a REAL fail is still reported from inside a worktree — the check is live there, not merely quiet', async () => {
  const s = scenario();
  const wt = worktreeOf(s.repo);
  const r = await inDir(wt, s.home, [], DEPS(green({ [`${PROJ}/protected_branches`]: { stdout: '[]' } })));
  assert.equal(r.code, 1);
  assert.equal(levels(r)['branch-protection'], 'fail');
  assert.match(r.checks[4].detail, /'main' is NOT protected on acme\/fix-proj/);
});

test('cwd outside any registered project ⇒ warn, not a crash', async () => {
  const s = scenario();
  const outside = join(TMP, `outside-${n++}`);
  mkdirSync(outside, { recursive: true });
  const r = await inDir(outside, s.home, [], DEPS(green()));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['branch-protection'], 'warn');
  assert.match(r.checks[4].detail, /cannot resolve a registered project from cwd/);
});

test('an UNREGISTERED repo names --root <main repo root> — never advice that would re-point the registration', async () => {
  // `legion project init` defaults to cwd and RECONCILES an existing entry onto it, so a bare
  // `legion project init` typed in a worktree rewrites repoRoot/defaultBranch to the feature
  // checkout. The remediation must therefore name the repository, not the checkout.
  const s = scenario();
  const other = join(TMP, `unregistered-${n++}`);
  mkdirSync(other, { recursive: true });
  sh(other, 'init', '-b', 'main');
  writeFileSync(join(other, 'f.txt'), 'x\n');
  sh(other, 'add', '-A');
  gitc(other, 'commit', '-m', 'init');
  const root = realpathSync(other);
  const wt = join(TMP, `unregistered-wt-${n++}`);
  sh(other, 'worktree', 'add', '-q', wt, '-b', 'feat/y');

  const r = await inDir(wt, s.home, [], DEPS(green()));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['branch-protection'], 'warn');
  assert.match(r.checks[4].detail, new RegExp(`repo ${root} is not a registered project`));
  assert.ok(r.checks[4].detail.includes(`legion project init --root ${root}`),
    `the remediation must name the repository root, got: ${r.checks[4].detail}`);
  assert.ok(!r.checks[4].detail.includes(realpathSync(wt)), 'it must not point the operator at the worktree');
});

test('an empty recorded protected set (--no-protected) ⇒ warn, never a silent pass', async () => {
  const s = scenario({ initArgs: ['--no-protected'] });
  assert.deepEqual(readJson(s.configPath).protectedBranches, []);
  const run = green();
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['branch-protection'], 'warn');
  assert.match(r.checks[4].detail, /records no protected branches/);
  assert.equal(run.calls.filter((c) => c.args[0] === 'api').length, 0);
});

test('an unparseable recorded remote ⇒ warn, never a guessed project path', async () => {
  const s = scenario();
  const cfg = readJson(s.configPath);
  writeJson(s.configPath, { ...cfg, remoteUrl: 'file:///somewhere/odd' });
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(levels(r)['branch-protection'], 'warn');
  assert.match(r.checks[4].detail, /cannot derive a GitLab project path/);
});

test('a wildcard rule covers the recorded branch ⇒ pass', async () => {
  const s = scenario({ initArgs: ['--protected', 'release/1.0'] });
  assert.deepEqual(readJson(s.configPath).protectedBranches, ['release/1.0']);
  const r = await inScenario(s, [], DEPS(green({
    [`${PROJ}/protected_branches`]: {
      stdout: JSON.stringify([{
        name: 'release/*',
        push_access_levels: [{ access_level: 40, user_id: null, group_id: null }],
        merge_access_levels: [{ access_level: 40, user_id: null, group_id: null }],
      }]),
    },
  })));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['branch-protection'], 'pass', r.checks[4].detail);
  assert.match(r.checks[4].detail, /release\/1\.0/);
});

test('every recorded branch is checked: one protected, one not ⇒ fail naming the unprotected one', async () => {
  const s = scenario({ initArgs: ['--protected', 'main,release/1.0'] });
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(r.code, 1);
  assert.equal(levels(r)['branch-protection'], 'fail');
  assert.match(r.checks[4].detail, /'release\/1\.0' is NOT protected/);
  assert.ok(!r.checks[4].detail.includes("'main' is NOT protected"), 'main IS protected in the fixture');
});

// --- remote-guards: the retired layer's leftovers, reported honestly ----------------------------
// The local push guards were REMOVED 2026-08-07 (server-only decision — src/kernel/githooks.mjs
// header). The check keeps its id (the `--json` contract) and its two-valued voice — pass/warn,
// never fail — but its question inverted: it now catches the MIGRATION HAZARD, a fail-closed stub
// from an older install whose guard file no longer ships. `project init` no longer installs
// anything, so the pass case is the fresh state onboarding leaves, and every leftover below is
// PLANTED by the fixture the way an old legion left it.

/** Where the retired installer put its stub — now where fixtures PLANT leftovers. */
const hookOf = (s) => join(s.repo, '.git', 'hooks', 'pre-push');

/** The stub an OLD legion installed: marker line, exec bit, fail-closed import. */
function plantStub(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, [
    '#!/usr/bin/env node',
    '// legion-managed-git-hook:pre-push:v1',
    'const guard = "file:///no/such/legion/hooks/pre-push.mjs";',
    'import(guard).catch(() => process.exit(1));',
    '',
  ].join('\n'));
  chmodSync(path, 0o755);
}

/** The server-only framing every remote-guards detail must carry, pass and warn alike: the local
 * guards are gone, and the check that carries the guarantee is named. */
function assertServerOnlyFraming(detail) {
  assert.match(detail, /local push guards were REMOVED/, `missing the framing: ${detail}`);
  assert.match(detail, /ONLY barrier/, `the server-only claim must be stated: ${detail}`);
  assert.match(detail, /branch-protection check above/, `the guarantee must be named: ${detail}`);
}

test('a fresh registration carries no stub ⇒ remote-guards PASSES with the server-only framing', async () => {
  const s = scenario();
  assert.ok(!existsSync(hookOf(s)), '`project init` must not install anything — the layer is retired');
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(r.code, 0, r.output);
  assert.equal(levels(r)['remote-guards'], 'pass', r.checks[5].detail);
  assert.match(r.checks[5].detail, /no leftover/);
  assertServerOnlyFraming(r.checks[5].detail);
});

test('a LEFTOVER legion stub ⇒ WARN naming the file, the consequence and the remedy — never a fail', async () => {
  const s = scenario();
  plantStub(hookOf(s));
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(r.code, 0, 'a local file problem with a one-command remedy is not a red light');
  assert.equal(levels(r)['remote-guards'], 'warn', r.checks[5].detail);
  assert.ok(r.checks[5].detail.includes(hookOf(s)), `the exact file must be named: ${r.checks[5].detail}`);
  assert.match(r.checks[5].detail, /EVERY ordinary push/i, 'the consequence — bricked pushes — must be stated');
  assert.match(r.checks[5].detail, /legion finalize/, "finalize's own push dies in the stub too");
  assert.match(r.checks[5].detail, /legion project init/, 'the remedy must be nameable');
  assert.ok(existsSync(hookOf(s)), 'doctor REPORTS the leftover, it never removes it — read-only absolutely');
  assertServerOnlyFraming(r.checks[5].detail);
});

test("a FOREIGN pre-push hook is the operator's business ⇒ PASS, and doctor does not touch it", async () => {
  const s = scenario();
  writeFileSync(hookOf(s), '#!/bin/sh\nexit 0\n');
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['remote-guards'], 'pass', r.checks[5].detail);
  assert.match(r.checks[5].detail, /operator's own pre-push hook/);
  assert.match(r.checks[5].detail, /untouched/);
  assert.equal(readFileSync(hookOf(s), 'utf8'), '#!/bin/sh\nexit 0\n', 'and doctor must not touch it');
  assertServerOnlyFraming(r.checks[5].detail);
});

test('a leftover stub WITHOUT the exec bit is litter, not a blocker ⇒ WARN saying which', async () => {
  // git silently ignores a hook with no exec bit: this stub blocks nothing, but leaving it around
  // is how it comes back to life on the next archive restore or chmod sweep.
  const s = scenario();
  plantStub(hookOf(s));
  chmodSync(hookOf(s), 0o644);
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['remote-guards'], 'warn', r.checks[5].detail);
  assert.match(r.checks[5].detail, /blocks nothing/);
  assert.match(r.checks[5].detail, /legion project init/);
  assertServerOnlyFraming(r.checks[5].detail);
});

test('the check reads the EFFECTIVE hooks dir — a stub in a core.hooksPath dir is one git runs', async () => {
  const s = scenario();
  const elsewhere = join(TMP, `hookspath-${n++}`);
  mkdirSync(elsewhere, { recursive: true });
  sh(s.repo, 'config', 'core.hooksPath', elsewhere);
  // A stub at the DEFAULT path is invisible to git under the redirect: clean, git runs nothing.
  plantStub(hookOf(s));
  const clean = await inScenario(s, [], DEPS(green()));
  assert.equal(levels(clean)['remote-guards'], 'pass', clean.checks[5].detail);
  // A stub in the REDIRECTED dir (hand-copied, per the old composition advice) IS one git runs:
  // named for the operator to delete — removal never reaches into a redirected dir.
  plantStub(join(elsewhere, 'pre-push'));
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(levels(r)['remote-guards'], 'warn', r.checks[5].detail);
  assert.ok(r.checks[5].detail.includes(join(elsewhere, 'pre-push')), r.checks[5].detail);
  assert.ok(existsSync(join(elsewhere, 'pre-push')), 'reported, never removed');
  assert.equal(sh(s.repo, 'config', '--get', 'core.hooksPath'), elsewhere, 'doctor never rewrites the setting');
  // THE REMEDY MUST BE TRUE: `legion project init` only ever removes from the DEFAULT hooks dir,
  // so prescribing it for a redirected-dir leftover would send the operator down the one path
  // guaranteed to change nothing. The detail must say "by hand" and must NOT name project init.
  assert.match(r.checks[5].detail, /delete the file by hand/, r.checks[5].detail);
  assert.doesNotMatch(r.checks[5].detail, /legion project init/,
    'the remedy for a redirected-dir leftover is never a legion command');
});

test('from INSIDE a linked feature worktree a leftover is still found — worktrees share one hooks dir', async () => {
  const s = scenario();
  plantStub(hookOf(s));
  const wt = worktreeOf(s.repo);
  const r = await inDir(wt, s.home, [], DEPS(green()));
  assert.equal(r.code, 0, r.output);
  assert.equal(levels(r)['remote-guards'], 'warn', r.checks[5].detail);
  assert.ok(r.checks[5].detail.includes(hookOf(s)),
    `the stub lives in the COMMON dir, not under the worktree: ${r.checks[5].detail}`);
});

test('no project resolves from cwd ⇒ WARN saying the stub state is UNKNOWN, like its neighbour', async () => {
  const s = scenario();
  const outside = join(TMP, `outside-guards-${n++}`);
  mkdirSync(outside, { recursive: true });
  const r = await inDir(outside, s.home, [], DEPS(green()));
  assert.equal(r.code, 0);
  assert.equal(levels(r)['remote-guards'], 'warn', r.checks[5].detail);
  assert.equal(levels(r)['branch-protection'], 'warn', 'the neighbouring check answers the same way');
  assert.match(r.checks[5].detail, /cannot resolve a registered project from cwd/);
  assert.match(r.checks[5].detail, /UNKNOWN/);
  assertServerOnlyFraming(r.checks[5].detail);
});

test('EVERY leftover state is pass-or-warn — the check has no fail branch at all', async () => {
  // The table, exhaustively: nothing this check can observe about a retired layer's litter
  // justifies a red doctor, and a future edit that adds a fail here has to delete this test.
  const cases = [
    ['clean', (s) => {}],
    ['leftover', (s) => plantStub(hookOf(s))],
    ['foreign', (s) => writeFileSync(hookOf(s), '#!/bin/sh\nexit 0\n')],
    ['leftover-inert', (s) => { plantStub(hookOf(s)); chmodSync(hookOf(s), 0o644); }],
    ['no hooks directory at all', (s) => rmSync(join(s.repo, '.git', 'hooks'), { recursive: true, force: true })],
  ];
  for (const [name, mutate] of cases) {
    const s = scenario();
    mutate(s);
    const r = await inScenario(s, [], DEPS(green()));
    const c = r.checks[5];
    assert.equal(c.check, 'remote-guards');
    assert.ok(c.level !== 'fail', `${name} must never fail doctor: ${c.detail}`);
    assert.equal(r.code, 0, `${name}: exit 0, nothing else is red in this fixture`);
    assertServerOnlyFraming(c.detail);
  }
});

test('remote-guards probes NOTHING external — it asks the filesystem, never `claude` or `glab`', async () => {
  const s = scenario();
  plantStub(hookOf(s));
  const run = green();
  const before = run.calls.length;
  await inScenario(s, [], DEPS(run));
  // Only the five probes the OTHER checks make: claude --version, glab auth status, glab api
  // user, glab api projects/… ×2 (project + one protected_branches page).
  assert.equal(run.calls.length - before, 5, run.calls.map((c) => c.key).join(' | '));
  assert.ok(!run.calls.some((c) => c.key.includes('pre-push')), 'the stub is read, never executed');
});

test('branch-protection keeps its own three-valued voice while remote-guards warns beside it', async () => {
  // The two checks are about the same layering and must not blur: a VERIFIED server refusal
  // stays a pass even with a leftover stub bricking local pushes, and the leftover stays a warn.
  const s = scenario();
  plantStub(hookOf(s));
  const r = await inScenario(s, [], DEPS(green()));
  assert.equal(levels(r)['branch-protection'], 'pass', r.checks[4].detail);
  assert.match(r.checks[4].detail, /server-side protection VERIFIED/);
  assert.equal(levels(r)['remote-guards'], 'warn');
  assert.match(r.output, /doctor: 5 pass, 1 warn, 0 fail/);
});

// --- output shapes -----------------------------------------------------------------------------------

test('--json emits a complete machine-readable array and nothing else', async () => {
  const s = scenario();
  const r = await inScenario(s, ['--json'], DEPS(green()));
  const parsed = JSON.parse(r.output);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 6);
  assert.deepEqual(parsed.map((c) => c.check), CHECK_IDS);
  for (const c of parsed) {
    assert.deepEqual(Object.keys(c).sort(), ['check', 'detail', 'level']);
    assert.ok(['pass', 'warn', 'fail'].includes(c.level));
    assert.equal(typeof c.detail, 'string');
    assert.ok(c.detail.length > 0, `${c.check} must carry a human detail`);
  }
  assert.ok(!r.output.includes('doctor: 6 pass'), 'the human summary must not pollute the JSON');
  assert.ok(!/^PASS /m.test(r.output), 'the human table must not pollute the JSON');
});

test('--json carries the failing levels too, and the exit code is unchanged by the format', async () => {
  const s = scenario();
  const deps = DEPS(green({ [`${PROJ}/protected_branches`]: { stdout: '[]' } }), { nodeVersion: 'v18.0.0' });
  const human = await inScenario(s, [], deps);
  const json = await inScenario(s, ['--json'], deps);
  assert.equal(human.code, 1);
  assert.equal(json.code, 1);
  assert.deepEqual(levels(json), levels(human));
  assert.deepEqual(JSON.parse(json.output).filter((c) => c.level === 'fail').map((c) => c.check),
    ['node', 'branch-protection']);
});

test('the human table prints one row per check, level first', async () => {
  const s = scenario();
  const r = await inScenario(s, [], DEPS(green()));
  for (const id of CHECK_IDS) assert.match(r.output, new RegExp(`^PASS +${id.replace('-', '-')} `, 'm'));
});

// --- usage -------------------------------------------------------------------------------------------

test('a stray positional throws the usage BEFORE any probe runs', async () => {
  const s = scenario();
  const run = green();
  await assert.rejects(() => inScenario(s, ['extra'], DEPS(run)), /unexpected argument 'extra'.*usage: legion doctor/s);
  assert.equal(run.calls.length, 0, 'a typo must not be answered with a report');
});

test('doctorCore refuses to run without the injected seam', async () => {
  await assert.rejects(() => doctorCore([], {}), /requires deps\.run/);
});

// --- the read-only claim ------------------------------------------------------------------------------

/** Every file under `dir` as rel → {size, mtimeMs, bytes}. */
function snapshot(dir) {
  const out = {};
  for (const p of readdirSync(dir, { recursive: true })) {
    const abs = join(dir, String(p));
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    out[relative(dir, abs)] = { size: st.size, mtimeMs: st.mtimeMs, bytes: readFileSync(abs, 'base64') };
  }
  return out;
}

test('doctor writes NOTHING — the legion home and the repo are byte-identical after a run', async () => {
  const s = scenario();
  const beforeHome = snapshot(s.home);
  const beforeRepo = snapshot(s.repo);
  assert.ok(Object.keys(beforeHome).length > 0, 'the snapshot must actually see files');

  const r = await inScenario(s, [], DEPS(green({ [`${PROJ}/protected_branches`]: { stdout: '[]' } })));
  assert.equal(r.code, 1, 'even a FAILING run must not write');

  assert.deepEqual(snapshot(s.home), beforeHome);
  assert.deepEqual(snapshot(s.repo), beforeRepo);
});

// --- protected_branches paging -----------------------------------------------------------------
// GitLab REST lists default to 20 per page and return only the first page unless asked. Reading
// that partial list as the complete rule set makes doctor assert VERIFIED-unprotected about a
// branch that IS protected — a fail-direction lie, but still evidence it never established.
const PROT_PAGE = (page) => `${PROJ}/protected_branches?per_page=100&page=${page}`;
/** `count` rules that match nothing we record, i.e. a full page of noise ahead of the real one. */
const filler = (count) => Array.from({ length: count }, (_, i) => ({
  name: `release/v${i}`, push_access_levels: [], merge_access_levels: [],
}));

test('protected_branches is paged: a rule on page 2 is found, not reported as unprotected', async () => {
  const s = scenario();
  // The unpaginated request (what the old code sent) and page 1 both yield 100 non-matching
  // rules; only page 2 carries 'main'. Old code stops at the first response and calls main
  // unprotected; paged code walks on because a FULL page proves nothing about exhaustion.
  const run = green({
    [`${PROJ}/protected_branches`]: { stdout: JSON.stringify(filler(100)) },
    [PROT_PAGE(2)]: { stdout: JSON.stringify(MAINTAINER_ONLY) },
  });
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(levels(r)['branch-protection'], 'pass', r.checks[4].detail);
  assert.match(r.checks[4].detail, /VERIFIED on acme\/fix-proj/);
  const pages = run.calls.filter((c) => String(c.args[1] ?? '').includes('protected_branches'));
  assert.equal(pages.length, 2, `expected exactly 2 page requests, got ${pages.map((c) => c.args[1]).join(' | ')}`);
});

test('a list too long to finish reading is UNVERIFIED, never a verdict in either direction', async () => {
  const s = scenario();
  // Every page comes back full, so exhaustion is never proven. The honest answer is "cannot
  // tell" — not pass (nothing was checked) and not fail (nothing was disproved).
  const run = green({ [`${PROJ}/protected_branches`]: { stdout: JSON.stringify(filler(100)) } });
  const r = await inScenario(s, [], DEPS(run));
  assert.equal(levels(r)['branch-protection'], 'warn', r.checks[4].detail);
  assert.match(r.checks[4].detail, /could not be read completely/);
  assert.equal(r.code, 0, 'unverifiable is warn, so doctor still exits 0');
});
