// Direct tests for kernel/runner.mjs — THE process seam for non-git tools (`glab`, `claude`).
//
// WHY THIS FILE EXISTS. Both callers (`legion finalize`, `legion doctor`) inject a FAKE run(),
// so the real module was executed by nothing in the suite: its two stated properties — the
// GIT_REDIRECT_VARS purge and the runtime `git` refusal — were prose. The refusal in particular
// is the COMPENSATING CONTROL for a disclosed blind spot of test/kernel/git-seam.audit.test.mjs
// (a source scan cannot see git spawned through a computed `file`), so leaving it unexercised
// removed the only enforcement it had.
//
// NO NETWORK, NO REAL TOOLS, NO ~/.legion. Every process spawned here is THIS node binary with
// `-e`: a hermetic subject that reports its own env and exit code. Nothing reads or writes the
// legion home, and nothing under test touches a repository.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCapture, runnerEnv, realRunner } from '../../src/kernel/runner.mjs';
import { GIT_REDIRECT_VARS } from '../../src/kernel/git.mjs';

const NODE = process.execPath;
/** A node one-liner as an argv — never a shell string, matching the seam's own contract. */
const node = (src) => [NODE, ['-e', src]];

test('runnerEnv strips exactly the repo/index redirection variables and keeps everything else', () => {
  const base = {
    PATH: '/usr/bin', GITLAB_TOKEN: 'tok', HOME: '/home/x',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_EXEC_PATH: '/opt/git/libexec',
    ...Object.fromEntries(GIT_REDIRECT_VARS.map((k) => [k, `/somewhere/${k}`])),
  };
  const env = runnerEnv(base);
  for (const k of GIT_REDIRECT_VARS) {
    assert.ok(!(k in env), `${k} must be deleted — glab resolves the project from the git remote of its cwd, ` +
      'and an ambient redirection aims it at a DIFFERENT repository');
  }
  // Everything else survives on purpose: without PATH and GITLAB_TOKEN every probe is a false
  // negative, and this is NOT git hardening (no GIT_CONFIG_* neutralisation).
  assert.deepEqual(env, { PATH: '/usr/bin', GITLAB_TOKEN: 'tok', HOME: '/home/x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_EXEC_PATH: '/opt/git/libexec' });
  assert.ok(GIT_REDIRECT_VARS.every((k) => k in base), 'pure: the caller\'s base object must not be mutated');
});

test('runnerEnv defaults to process.env', () => {
  const env = runnerEnv();
  assert.equal(env.PATH, process.env.PATH);
  assert.ok(!('GIT_DIR' in env));
});

test('the purge is REAL at runtime: an ambient GIT_DIR does not reach the child', () => {
  const had = Object.prototype.hasOwnProperty.call(process.env, 'GIT_DIR');
  const prev = process.env.GIT_DIR;
  process.env.GIT_DIR = '/nonexistent/other-repo.git';
  try {
    const r = runCapture(...node('process.stdout.write(String(process.env.GIT_DIR))'));
    assert.equal(r.ok, true, r.stderr);
    assert.equal(r.stdout, 'undefined', 'the child inherited the redirection the seam exists to strip');
  } finally {
    if (had) process.env.GIT_DIR = prev; else delete process.env.GIT_DIR;
  }
});

test('an explicitly supplied env is used verbatim — the caller owns it', () => {
  const r = runCapture(NODE, ['-e', 'process.stdout.write(`${process.env.MARK}`)'], { env: { ...process.env, MARK: 'x' } });
  assert.equal(r.stdout, 'x');
});

test('git is REFUSED at runtime — the audit scan cannot see a computed callee, this can', () => {
  // The compensating control named in kernel/runner.mjs's header and in
  // test/kernel/git-seam.audit.test.mjs's blind-spot list. A generic run(file, args) is a
  // latent bypass of the source scan; this is the enforcement that is not a source scan.
  assert.throws(() => runCapture('git', ['status']), /must never spawn git.*kernel\/git\.mjs/s);
  // Refused BEFORE the spawn, so no `git` process is created even when one would succeed.
  assert.throws(() => runCapture('git', ['--version'], { cwd: process.cwd() }), /kernel\/runner\.mjs must never spawn git/);
});

test('a successful command reports ok, code 0 and both streams', () => {
  const r = runCapture(...node('process.stdout.write("out"); process.stderr.write("err")'));
  assert.deepEqual(r, { ok: true, code: 0, signal: null, stdout: 'out', stderr: 'err', spawnError: null });
});

test('a non-zero exit is a RESULT, not an exception — the caller classifies it', () => {
  const r = runCapture(...node('process.stderr.write("boom"); process.exit(3)'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.equal(r.stderr, 'boom');
  assert.equal(r.spawnError, null);
});

test('a missing binary surfaces as spawnError ENOENT, never a throw', () => {
  const r = runCapture('legion-no-such-binary-xyz', ['--version']);
  assert.equal(r.ok, false);
  assert.equal(r.spawnError, 'ENOENT', 'doctor maps exactly this to "not on PATH"');
  assert.equal(r.code, null);
});

test('a hung command is killed at timeoutMs and reported, not awaited forever', () => {
  const r = runCapture(...node('setTimeout(() => {}, 60000)'), { timeoutMs: 250 });
  assert.equal(r.ok, false);
  assert.ok(r.signal === 'SIGKILL' || r.spawnError === 'ETIMEDOUT', `killed on timeout, got ${JSON.stringify(r)}`);
});

test('no shell: argv is passed through untouched, so metacharacters are inert', () => {
  const r = runCapture(NODE, ['-e', 'process.stdout.write(process.argv[1])', '$(echo pwned); rm -rf /']);
  assert.equal(r.ok, true, r.stderr);
  assert.equal(r.stdout, '$(echo pwned); rm -rf /', 'a shell would have expanded this');
});

test('realRunner() hands out runCapture itself under the injected name', () => {
  assert.deepEqual(Object.keys(realRunner()), ['run']);
  assert.equal(realRunner().run, runCapture);
});
