// Guards git.mjs against a REAL fixture repository: derived evidence (toplevel from a
// subdirectory, remote URL, default-branch fallback) and the loud-failure contract
// (stderr text carried into the thrown message; gitTry null on optional facts).
// realpathSync on both sides of path comparisons — macOS /tmp is a symlink to /private/tmp.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyHardenedGitEnv, git, gitTry, gitUserRepo, hardenedGitEnv, STATUS_ARGV,
} from '../../src/kernel/git.mjs';

// RAW CONTROLS (T7c): several tests below must first PROVE the hostile fixture really works
// — that an unhardened git is blinded/hijacked — before asserting the seam neutralises it.
// The raw spawn primitive is deliberately NOT exported any more, so those controls spawn
// `git` directly here: the control belongs to git-the-program, not to our wrapper. (The
// audit test's no-bypass scan covers src/ only, so this is legal by construction.)
const rawGit = (args, cwd, env = process.env) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env }).stdout.trim();

// HERMETIC GIT (T7b): the suite ran against the DEVELOPER's ~/.gitconfig and inherited GIT_*
// env, which is exactly why the `status.showUntrackedFiles=no` fail-open was invisible to it
// — a machine with that preference set would have gone GREEN here. This one mutation neuters
// global/system config and every inherited GIT_* variable and pins a deterministic identity;
// every child below spawns from `process.env` (directly or via `{...process.env, LEGION_HOME}`),
// so no other call site changes. A future test that builds an env object from scratch would
// silently opt out.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });


const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
};

let TMP, REPO, SUB;
before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'legion3-git-'));
  REPO = join(TMP, 'fixture');
  SUB = join(REPO, 'sub', 'deeper');
  mkdirSync(SUB, { recursive: true });
  sh(REPO, 'init', '-b', 'main');
  writeFileSync(join(REPO, 'file.txt'), 'hello\n');
  sh(REPO, 'add', '-A');
  sh(REPO, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '-m', 'init');
});
after(() => { rmSync(TMP, { recursive: true, force: true }); });

test('rev-parse --show-toplevel from a subdirectory returns the fixture root', () => {
  const top = git(['rev-parse', '--show-toplevel'], SUB);
  assert.equal(realpathSync(top), realpathSync(REPO));
});

test('gitTry returns null for a missing remote, then the URL once added', () => {
  assert.equal(gitTry(['remote', 'get-url', 'origin'], REPO), null);
  sh(REPO, 'remote', 'add', 'origin', 'https://example.invalid/r.git');
  assert.equal(gitTry(['remote', 'get-url', 'origin'], REPO), 'https://example.invalid/r.git');
});

test('default-branch fallback: symbolic-ref --short HEAD is main', () => {
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], REPO), 'main');
});

test('maxBuffer: an undersized ceiling throws loudly instead of silently truncating', () => {
  // `log` output here is far longer than 1 byte; the gate's big range diff relies on this
  // knob, and an exceeded ceiling must never come back as a short-but-plausible string.
  assert.throws(
    () => git(['log', '--format=%H %s'], REPO, { maxBuffer: 1 }),
    (e) => e.message.includes('log') && /ENOBUFS/.test(e.message),
  );
  // A generous ceiling returns the same bytes as omitting the option entirely.
  assert.equal(
    git(['log', '--format=%H %s'], REPO, { maxBuffer: 64 * 1024 * 1024 }),
    git(['log', '--format=%H %s'], REPO),
  );
});

test('git() on a failing command throws with the stderr text and command in the message', () => {
  assert.throws(
    () => git(['rev-parse', '--show-toplevel'], TMP), // TMP itself is not a repo
    (e) => /not a git repository/i.test(e.message) && e.message.includes('rev-parse'),
  );
});

// --- the hardened invocation seam, INVERTED (T7c) ---------------------------------------------
// git()/gitTry() are hardened BY DEFAULT and must reach (and neutralise) a caller-supplied
// environment; hardenedGitEnv must purge repo/index redirection and config injection; git() must
// report an untracked file no matter what the ambient config says — the fail-open that let an
// untracked `sk-…` key ride a GREEN gate receipt; and gitUserRepo must be a REAL opt-out for the
// user's config while still refusing to be repointed at another repository.

// GIT_AUTHOR_IDENT is "Name <email> <unix-ts> <tz>", so two calls that straddle a second
// boundary differ ONLY in the clock — observed exactly once as `…1784928723 +0200` vs
// `…1784928724 +0200`, i.e. a suite that fails ~1 run in N and destroys its own signal. This
// assertion is about NAME/EMAIL inheritance, so the timestamp is stripped before comparing
// (pinning GIT_AUTHOR_DATE process-wide would leak into every fixture commit in this file).
const identOnly = (s) => s.replace(/ -?\d+ [+-]\d{4}$/, '');

test('gitUserRepo honours an explicit {env}; the hardened git() purges the same variable', () => {
  const env = { ...process.env, GIT_AUTHOR_NAME: 'explicit-env-name' };
  const before = gitUserRepo(['var', 'GIT_AUTHOR_IDENT'], REPO);
  assert.match(gitUserRepo(['var', 'GIT_AUTHOR_IDENT'], REPO, { env }), /^explicit-env-name /);
  assert.equal(identOnly(gitUserRepo(['var', 'GIT_AUTHOR_IDENT'], REPO)), identOnly(before),
    'no {env} ⇒ unchanged inheritance (name/email; the timestamp is not the subject)');
  // Through the hardened default the same GIT_* variable never reaches git (gitTry, not git:
  // with no identity left and global config neutralised, `git var` may legitimately fail —
  // either way the caller's name must not come back).
  const hardened = gitTry(['var', 'GIT_AUTHOR_IDENT'], REPO, { env });
  assert.ok(hardened === null || !/^explicit-env-name /.test(hardened), `git() leaked GIT_AUTHOR_NAME: ${hardened}`);
});

test('hardenedGitEnv purges GIT_* (keeping GIT_EXEC_PATH) and pins global/system config', () => {
  const base = {
    PATH: process.env.PATH,
    GIT_DIR: '/decoy/.git',
    GIT_WORK_TREE: '/decoy',
    GIT_INDEX_FILE: '/decoy/index',
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'status.showUntrackedFiles',
    GIT_CONFIG_VALUE_0: 'no',
    GIT_EXEC_PATH: '/usr/libexec/git-core',
  };
  const out = hardenedGitEnv(base);
  for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
    assert.equal(out[k], undefined, `${k} must be purged`);
  }
  assert.equal(out.GIT_EXEC_PATH, '/usr/libexec/git-core', 'relocatable installs need this one');
  assert.equal(out.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(out.GIT_CONFIG_SYSTEM, '/dev/null');
  assert.equal(out.PATH, process.env.PATH, 'non-GIT_ variables pass through');
  assert.equal(base.GIT_DIR, '/decoy/.git', 'hardenedGitEnv is pure — the base is not mutated');
  const withId = hardenedGitEnv(base, { identity: { name: 'n', email: 'e@x.invalid' } });
  assert.equal(withId.GIT_COMMITTER_EMAIL, 'e@x.invalid');
});

test('git() reports an untracked file despite hostile repo config AND GIT_CONFIG_* env', () => {
  const hostile = join(TMP, 'hostile');
  mkdirSync(hostile, { recursive: true });
  sh(hostile, 'init', '-b', 'main');
  writeFileSync(join(hostile, 'tracked.txt'), 'x\n');
  sh(hostile, 'add', '-A');
  sh(hostile, 'commit', '-m', 'init');
  sh(hostile, 'config', 'status.showUntrackedFiles', 'no');
  writeFileSync(join(hostile, 'untracked.txt'), 'secret\n');

  assert.equal(rawGit(['status', '--porcelain'], hostile), '',
    'fixture: an unhardened status IS blinded by the repo config');

  const saved = { ...process.env };
  try {
    Object.assign(process.env, {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'no',
    });
    assert.match(git(STATUS_ARGV, hostile), /\?\? untracked\.txt/);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

test('git() HARDENS a caller-supplied {env} instead of discarding it', () => {
  // The seam must be exercisable with an explicit hostile environment — otherwise the only way
  // to test it is mutating global process.env, which tests the ambient process, not the wrapper.
  const other = join(TMP, 'env-seam-decoy');
  mkdirSync(other, { recursive: true });
  sh(other, 'init', '-b', 'main');
  writeFileSync(join(other, 'o.txt'), 'o\n');
  sh(other, 'add', '-A');
  sh(other, 'commit', '-m', 'init');

  const hostileEnv = {
    ...process.env,
    GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'status.showUntrackedFiles', GIT_CONFIG_VALUE_0: 'no',
    GIT_EXEC_PATH: '/probe/exec-path', // allowlisted ⇒ survives hardening, so it proves the BASE
  };
  // The supplied env really is hostile: raw, its redirection retargets git away from REPO.
  // (Direct spawn: the unhardened primitive is no longer exported — see rawGit above. The
  // GIT_EXEC_PATH probe is dropped from the control's env, since a bogus exec-path makes
  // git-the-program unable to find its own subcommands.)
  const { GIT_EXEC_PATH: _probe, ...redirectOnly } = hostileEnv;
  assert.notEqual(realpathSync(rawGit(['rev-parse', '--show-toplevel'], REPO, redirectOnly)), realpathSync(REPO));
  // Hardened, the hostile parts are neutralised — the supplied env is HARDENED, not ignored …
  assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'], REPO, { env: hostileEnv })), realpathSync(REPO));
  // … and it is genuinely the base: an allowlisted GIT_* from the CALLER reaches the child,
  // which cannot happen if hardenedGitEnv() is re-derived from the ambient process instead.
  assert.equal(git(['--exec-path'], REPO, { env: hostileEnv }), '/probe/exec-path');
  assert.notEqual(git(['--exec-path'], REPO), '/probe/exec-path', 'no {env} ⇒ ambient base');
  // Remaining opts survive the env override (undersized ceiling still throws ENOBUFS).
  assert.throws(() => git(['log', '--format=%H %s'], REPO, { env: hostileEnv, maxBuffer: 1 }), /ENOBUFS/);
  assert.equal(hostileEnv.GIT_DIR, join(other, '.git'), 'the caller-supplied env is not mutated');
});

test('git() neutralises a GIT_DIR/GIT_WORK_TREE redirection to another repository', () => {
  const decoy = join(TMP, 'decoy');
  mkdirSync(decoy, { recursive: true });
  sh(decoy, 'init', '-b', 'main');
  writeFileSync(join(decoy, 'd.txt'), 'd\n');
  sh(decoy, 'add', '-A');
  sh(decoy, 'commit', '-m', 'init');

  const realHead = git(['rev-parse', 'HEAD'], REPO);
  const decoyHead = git(['rev-parse', 'HEAD'], decoy);
  assert.notEqual(realHead, decoyHead, 'fixture: the two repos have distinct HEADs');

  const saved = { ...process.env };
  try {
    Object.assign(process.env, { GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy });
    // Unhardened, the redirection wins: asked about REPO, git answers about the DECOY.
    assert.equal(rawGit(['rev-parse', 'HEAD'], REPO), decoyHead, 'fixture: the hijack really works');
    // Hardened, cwd decides — which is why every kernel read resolves through git():
    // otherwise an exported GIT_DIR retargets another repository entirely (T7c: it did).
    assert.equal(git(['rev-parse', 'HEAD'], REPO), realHead);
    assert.equal(realpathSync(git(['rev-parse', '--show-toplevel'], REPO)), realpathSync(REPO));
    // The MUTATION opt-out keeps the user's config but is NOT redirectable either: cwd,
    // which the kernel chose, still decides which repository the command acts on.
    assert.equal(gitUserRepo(['rev-parse', 'HEAD'], REPO), realHead);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// --- the INVERSION itself (T7c): the default is safe, the opt-out is a real opt-out ---------

test('default git() ignores repo config that blinds status; gitUserRepo deliberately obeys it', () => {
  const repo = join(TMP, 'inversion');
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'tracked.txt'), 'x\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'init');
  sh(repo, 'config', 'status.showUntrackedFiles', 'no'); // repo-local: linked worktrees SHARE it
  writeFileSync(join(repo, 'untracked.txt'), 'sk-would-be-a-secret\n');

  // The ORDINARY helper — what a caller gets without typing anything special — sees it.
  assert.match(git(STATUS_ARGV, repo), /\?\? untracked\.txt/);
  // The NAMED opt-out runs under the user's config, by design: that is what makes it an
  // opt-out rather than a synonym, and why it is allowlisted to three mutations only.
  assert.equal(gitUserRepo(['status', '--porcelain'], repo), '');
});

test('gitUserRepo strips repo redirection while keeping the user config it exists for', () => {
  const decoy = join(TMP, 'user-repo-decoy');
  mkdirSync(decoy, { recursive: true });
  sh(decoy, 'init', '-b', 'main');
  writeFileSync(join(decoy, 'x.txt'), 'x\n');
  sh(decoy, 'add', '-A');
  sh(decoy, 'commit', '-m', 'init');
  sh(REPO, 'config', 'user.name', 'repo-local-identity');

  const env = { ...process.env, GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy };
  // Redirection stripped: the answer is about cwd, not about the decoy …
  assert.equal(realpathSync(gitUserRepo(['rev-parse', '--show-toplevel'], REPO, { env })), realpathSync(REPO));
  assert.notEqual(gitUserRepo(['rev-parse', 'HEAD'], REPO, { env }), rawGit(['rev-parse', 'HEAD'], decoy));
  // … while the repo's own config still applies (an evidence read would have `-c` pins but
  // this is a mutation path, where the user's settings are the point).
  assert.equal(gitUserRepo(['config', 'user.name'], REPO, { env }), 'repo-local-identity');
  assert.equal(env.GIT_DIR, join(decoy, '.git'), 'the caller-supplied env is not mutated');
});
