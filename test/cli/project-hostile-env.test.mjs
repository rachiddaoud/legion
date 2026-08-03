// The five-line sibling of feature-hostile-env.test.mjs, for the OTHER command that writes
// derived git facts into authoritative state. `legion project init` derives FOUR values —
// repoRoot, remoteUrl, originHead, defaultBranch — and writes them into project.json AND the
// machine-local projects index; they are evidence by definition, and every later command
// (feature start, gate, finalize) resolves through them. Unhardened, an ambient GIT_DIR /
// GIT_WORK_TREE points `rev-parse --show-toplevel` at ANOTHER repository, and the index then
// names repo B's root and remote under repo A's project — the same redirection that let
// `feature abandon` in A destroy B (T7c). project.mjs had no test for it.
// VERIFIED RED against the pre-T7c seam. Note WHERE the revert has to be: project.mjs is
// byte-identical at 0c2c130 apart from its header — T7c fixed this by INVERTING git()
// itself, so reverting src/cli/project.mjs proves nothing and the test still passes. With
// `git show 0c2c130:src/kernel/git.mjs` in place instead, observed: `legion project init
// --root <A>` printed "initialized project default/proj-b", ~/.legion/orgs/default/projects
// contained ONLY proj-b, and the index's single entry carried B's repoRoot — so the test
// died at its first read, "ENOENT … /orgs/default/projects/proj-a/project.json". The command
// registered the OTHER repository under the operator's nose, exit 0.
// Two repos, ONE hermetic LEGION_HOME, the real bin, a hostile environment. Nothing here
// touches the network or the real ~/.legion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';

applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'legion.mjs');

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let TMP, HOME, A, B;

/** A one-commit repo whose package.json name, origin URL and default branch are all
 * distinct from its sibling's — otherwise "which repo did it read?" has no answer. */
function repoAt(slot, project, branch) {
  const repo = join(TMP, slot);
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', branch);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: project }, null, 2) + '\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'init');
  sh(repo, 'remote', 'add', 'origin', `https://example.invalid/${project}.git`);
  return { project, branch, repo: realpathSync(repo), url: `https://example.invalid/${project}.git` };
}

before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'legion3-proj-hostile-'));
  HOME = join(TMP, 'home');
  mkdirSync(HOME, { recursive: true });
  A = repoAt('a', 'proj-a', 'main');
  B = repoAt('b', 'proj-b', 'trunk');
});
after(() => { rmSync(TMP, { recursive: true, force: true }); });

test('project init under a hostile GIT_DIR/GIT_WORK_TREE records A, never B', () => {
  const r = spawnSync(process.execPath, [BIN, 'project', 'init', '--root', A.repo], {
    cwd: A.repo,
    encoding: 'utf8',
    env: { ...process.env, LEGION_HOME: HOME, GIT_DIR: join(B.repo, '.git'), GIT_WORK_TREE: B.repo },
  });
  assert.equal(r.status, 0, r.stderr);

  // Every derived field must describe the repo the operator named, not the redirected one.
  const cfg = JSON.parse(readFileSync(join(HOME, 'orgs', 'default', 'projects', 'proj-a', 'project.json'), 'utf8'));
  assert.equal(cfg.name, 'proj-a', 'the project name came from B\'s package.json');
  assert.equal(cfg.repoRoot, A.repo, 'repoRoot names the redirected repository');
  assert.equal(cfg.remoteUrl, A.url, 'remoteUrl was read from the redirected repository');
  assert.equal(cfg.defaultBranch, 'main', 'defaultBranch was read from the redirected repository');

  // …and the authoritative index carries the same, with B nowhere in it.
  const idx = JSON.parse(readFileSync(join(HOME, 'projects.json'), 'utf8'));
  assert.deepEqual(idx.projects.map((p) => p.name), ['proj-a']);
  assert.equal(idx.projects[0].repoRoot, A.repo);
  assert.doesNotMatch(JSON.stringify(idx), /proj-b/, 'repo B must not appear in the projects index');
});
