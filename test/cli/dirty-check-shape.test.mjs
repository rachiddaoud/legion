// THE CLASS-CLOSING REGRESSION FILE for the dirty check (T7d). Three review rounds each
// found a different git config that empties `git status --porcelain`, and each was fixed by
// pinning that one knob; this file asserts the property that makes the NEXT one harmless —
// the clean/dirty verdict is DERIVED (worktree → temp index → tree object, compared to
// HEAD's tree, kernel/git.mjs header F), so a knob that silences status output cannot move
// it. One test per knob, each driving BOTH remaining consumers end-to-end through bin/legion.mjs:
// `gate run` and `feature abandon` (the destructive one).
//
// IT WAS THREE CONSUMERS UNTIL T12. The third was `legion state receipt-record`, and that op no
// longer exists (PLAN-V3 §State; R1 — a dispatchable receipt writer certifies trees no gate ran
// on). Nothing is lost from this file's claim: the kernel-side receipt writer it exercised is now
// reachable ONLY from `gate run`, which is the first consumer here, and the writer's OWN isClean()
// guard — no longer reachable through any CLI op — is covered directly on recordGateReceipt in
// test/kernel/state.test.mjs.
//
// KNOBS ARE SET IN THE REPO-LOCAL .git/config, never via `-c`: that is the reachable path
// (linked worktrees SHARE the main checkout's config), and a `-c` that only this test passes
// would prove nothing about what a real worktree carries. Each test first asserts the knob
// really blinds a plain `git status --porcelain` — a fixture that does not reproduce the
// fail-open cannot prove the fix.
//
// PROVENANCE OF THE OBSERVATIONS BELOW, corrected rather than silently falsified. They were taken
// by running THIS FILE, in its T7d form, against b7a5bef with `git stash push -- src` — possible
// because it imported nothing from src/ but applyHardenedGitEnv. T12 changed the CALLS (the
// receipt-record arm is gone — see above), so the file as it now stands is NO LONGER a drop-in
// probe of that tree; reproducing the run needs the T7d revision of this file from history. The
// observations are kept because they are exactly what this file exists to hold closed. Still true:
// it imports nothing from src/ but applyHardenedGitEnv. OBSERVED, verbatim, no extrapolation:
//   K2 submodule.sub.ignore=all + moved gitlink → FAILED: "gate run went GREEN on
//        submodule.sub.ignore=all + a moved gitlink … gate: tier-0 OK … gate GREEN (task
//        tier) / recorded task receipt for T1 (tree 15be493f…)", actual 0 expected non-0.
//   K3 diff.ignoreSubmodules=all + moved gitlink → FAILED identically ("recorded task
//        receipt for T1 (tree 0631babb…)").
//   A second probe run at b7a5bef with the gate/receipt assertions removed (so the
//   DESTRUCTIVE arm is reached) showed the rest of the old behaviour for K2/K3:
//        `state receipt-record --task T1` exited 0 and recorded a receipt on the moved
//        gitlink, and `feature abandon f1` took its REMOVE branch — the only thing that
//        stopped the deletion was git's own unrelated refusal, "fatal: working trees
//        containing submodules cannot be moved or removed". legion's guard let it through.
//   K1 status.showUntrackedFiles=no PASSED at b7a5bef — stated rather than dressed up as a
//        new RED: that ONE knob was already pinned in T7b (STATUS_ARGV's explicit
//        --untracked-files=normal), which is exactly why it is knob #1 of three. It is kept
//        here as the guard that the shape change did not lose the property T7b won.
//   Both NEGATIVE tests passed at b7a5bef too, as they must: they exist so this file cannot
//        be satisfied by a check that refuses everything.
//
// RESIDUAL, stated and deliberately NOT asserted: an untracked secret INSIDE the submodule
// is not in the SUPERPROJECT's tree — and not in the tree the receipt certifies either — so
// it is still not detected here (kernel/git.mjs header F(f)). This file proves the GITLINK
// is covered, not that submodule contents are.
//
// FIXTURE HYGIENE (as in gate.test.mjs): legion3 gates ITSELF with this command, so the
// `sk-…` fixture is concatenated at runtime and never appears in these source bytes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';

// HERMETIC GIT: no ~/.gitconfig, no inherited GIT_*, a pinned identity. The ONLY config that
// can influence anything below is the repo-local one each test sets deliberately.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const BIN = join(ROOT, 'bin', 'legion.mjs');
const NODE = process.execPath;
const NOW = ['--now', '2026-07-24T00:00:00.000Z'];
const FAKE_KEY = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0';

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} (in ${cwd}): ${r.stderr}`);
  return r.stdout.trim();
};
// git >= 2.38 blocks the file transport for submodules; the URL must also be ABSOLUTE.
const shSub = (cwd, ...args) => sh(cwd, '-c', 'protocol.file.allow=always', ...args);

let TMP;
let n = 0;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-dirty-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

/** Sandbox: isolated LEGION_HOME, a one-commit fixture repo (optionally carrying a `sub`
 * submodule), a registered project, feature `f1` with a real worktree + dossier, tasks.json
 * seeded with T1 through the real import path. `git worktree add` does NOT populate
 * submodules, so the worktree's `sub` is initialised here — otherwise every scenario would
 * read dirty for the uninteresting reason (kernel/git.mjs header F(f)). */
function scenario({ submodule = false } = {}) {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fix-proj' }, null, 2) + '\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-m', 'init');
  if (submodule) {
    const inner = join(base, 'inner');
    mkdirSync(inner, { recursive: true });
    sh(inner, 'init', '-b', 'main');
    writeFileSync(join(inner, 'a.txt'), 'a\n');
    sh(inner, 'add', '-A');
    sh(inner, 'commit', '-m', 'c1');
    writeFileSync(join(inner, 'b.txt'), 'b\n');
    sh(inner, 'add', '-A');
    sh(inner, 'commit', '-m', 'c2'); // two commits so the gitlink can be MOVED
    shSub(repo, 'submodule', 'add', inner, 'sub');
    sh(repo, 'commit', '-m', 'add sub');
  }
  const env = { ...process.env, LEGION_HOME: home };
  let r = spawnSync(NODE, [BIN, 'project', 'init', '--root', repo], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(NODE, [BIN, 'feature', 'start', 'f1', '--base', 'main'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const worktree = realpathSync(join(base, '.legion-worktrees', 'fix-proj', 'f1', 'checkout'));
  const s = {
    home, base, env, worktree,
    repo: realpathSync(repo),
    dossier: join(home, 'orgs', 'default', 'projects', 'fix-proj', 'features', 'f1'),
  };
  if (submodule) shSub(s.worktree, 'submodule', 'update', '--init');
  r = spawnSync(NODE, [BIN, 'state', 'init'], { cwd: s.worktree, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  seedT1(s);
  return s;
}

/** One pending task T1, imported through `legion plan check --import` (the real path). */
function seedT1(s) {
  writeFileSync(join(s.dossier, 'plan.md'), '# plan\n');
  writeFileSync(join(s.dossier, 'plan.tasks.json'), JSON.stringify({
    milestones: [{ id: 'M1', title: 'm', tasks: [{ id: 'T1', title: 'do T1', status: 'pending', attempt: 0 }] }],
  }, null, 2) + '\n');
  const r = spawnSync(NODE, [BIN, 'plan', 'check', '--feature', 'f1', '--import', ...NOW],
    { cwd: s.worktree, encoding: 'utf8', env: s.env });
  assert.equal(r.status, 0, r.stderr);
}

const legion = (s, cwd, ...args) => spawnSync(NODE, [BIN, ...args], { cwd, encoding: 'utf8', env: s.env });
const tasksJson = (s) => JSON.parse(readFileSync(join(s.dossier, 'tasks.json'), 'utf8'));
const receiptOfT1 = (s) => tasksJson(s).tasks.find((t) => t.id === 'T1').receipt ?? null;
const branchExists = (s) =>
  spawnSync('git', ['-C', s.repo, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/f1'],
    { encoding: 'utf8', env: process.env }).status === 0;
/** Repo-local config — the reachable path, and the one linked worktrees share. */
const knob = (s, key, value) => sh(s.repo, 'config', key, value);

/** BOTH remaining consumers must REFUSE, and the destructive one must retain. */
function assertBothRefuse(s, what) {
  const g = legion(s, s.worktree, 'gate', 'run', '--task', 'T1', ...NOW);
  assert.notEqual(g.status, 0, `gate run went GREEN on ${what}\n${g.stdout}`);
  assert.match(g.stderr, /dirty/, g.stderr);
  assert.equal(receiptOfT1(s), null, `a refused gate must record NO receipt (${what})`);

  // The DESTRUCTIVE consumer, last: it closes the manifest either way.
  const ab = legion(s, s.repo, 'feature', 'abandon', 'f1');
  assert.equal(ab.status, 0, ab.stderr);
  assert.match(ab.stdout, /RETAINED/, `abandon destroyed a dirty worktree on ${what}\n${ab.stdout}`);
  assert.ok(existsSync(s.worktree), `worktree ${s.worktree} was DELETED on ${what}`);
  assert.ok(branchExists(s), `feat/f1 was force-deleted on ${what}`);
}

// --- K1: status.showUntrackedFiles=no ---------------------------------------------------------

test('K1 status.showUntrackedFiles=no: an untracked key cannot ride a GREEN receipt', () => {
  const s = scenario();
  knob(s, 'status.showUntrackedFiles', 'no');
  writeFileSync(join(s.worktree, 'leak.txt'), `${FAKE_KEY}\n`);
  assert.equal(sh(s.worktree, 'status', '--porcelain'), '',
    'fixture: the knob must really blind a plain status, or this proves nothing');
  assertBothRefuse(s, 'status.showUntrackedFiles=no + an untracked sk-… key');
});

// --- K2/K3: the submodule knobs, on a MOVED GITLINK -------------------------------------------
// The gitlink IS in the superproject's tree, so moving it is uncommitted work in the very
// tree a receipt certifies — and both knobs hide it from `git status` completely.

/** Move `sub` back one commit inside the worktree: the superproject's gitlink now differs
 * from the one HEAD records. */
const moveGitlink = (s) => sh(join(s.worktree, 'sub'), 'checkout', 'HEAD~1');

test('K2 submodule.<name>.ignore=all: a MOVED GITLINK cannot ride a GREEN receipt', () => {
  const s = scenario({ submodule: true });
  knob(s, 'submodule.sub.ignore', 'all');
  moveGitlink(s);
  assert.equal(sh(s.worktree, 'status', '--porcelain'), '',
    'fixture: the knob must really blind a plain status, or this proves nothing');
  assertBothRefuse(s, 'submodule.sub.ignore=all + a moved gitlink');
});

test('K3 diff.ignoreSubmodules=all: the same moved gitlink, the other knob', () => {
  const s = scenario({ submodule: true });
  knob(s, 'diff.ignoreSubmodules', 'all');
  moveGitlink(s);
  assert.equal(sh(s.worktree, 'status', '--porcelain'), '',
    'fixture: the knob must really blind a plain status, or this proves nothing');
  assertBothRefuse(s, 'diff.ignoreSubmodules=all + a moved gitlink');
});

// --- the NEGATIVE direction: the check is not merely refusing everything -----------------------

// Without these the file would be satisfied by a check that refuses EVERYTHING. Two tests
// because `git worktree remove` REFUSES outright on a worktree containing submodules
// ("working trees containing submodules cannot be moved or removed") — git's own limitation,
// pre-existing, unchanged by T7d and out of this task's scope, so the abandon arm is
// exercised on the submodule-free scenario with the same three knobs set (the two submodule
// knobs are simply inert there, which is exactly what "hostile config, clean tree" means).

test('a genuinely clean worktree with a submodule still gates GREEN under all three knobs', () => {
  const s = scenario({ submodule: true });
  knob(s, 'status.showUntrackedFiles', 'no');
  knob(s, 'submodule.sub.ignore', 'all');
  knob(s, 'diff.ignoreSubmodules', 'all');

  const g = legion(s, s.worktree, 'gate', 'run', '--task', 'T1', ...NOW);
  assert.equal(g.status, 0, `${g.stdout}\n${g.stderr}`);
  assert.equal(receiptOfT1(s).treeHash, sh(s.worktree, 'rev-parse', 'HEAD^{tree}'));

  const v = legion(s, s.worktree, 'gate', 'verify-receipt', '--task', 'T1');
  assert.equal(v.status, 0, v.stderr);
});

test('a genuinely clean worktree is still REMOVED by abandon under all three knobs', () => {
  const s = scenario();
  knob(s, 'status.showUntrackedFiles', 'no');
  knob(s, 'submodule.sub.ignore', 'all');
  knob(s, 'diff.ignoreSubmodules', 'all');

  // The receipt is EARNED through `gate run` (T12: the only minter), so this half still asserts
  // that hostile-but-inert config does not turn a CLEAN tree into a refusal.
  const rr = legion(s, s.worktree, 'gate', 'run', '--task', 'T1', ...NOW);
  assert.equal(rr.status, 0, rr.stderr);
  assert.equal(receiptOfT1(s).treeHash, sh(s.worktree, 'rev-parse', 'HEAD^{tree}'));

  const ab = legion(s, s.repo, 'feature', 'abandon', 'f1');
  assert.equal(ab.status, 0, ab.stderr);
  assert.doesNotMatch(ab.stdout, /RETAINED/, ab.stdout);
  assert.ok(!existsSync(s.worktree), 'a clean worktree must still be removable');
  assert.ok(!branchExists(s), 'feat/f1 must be deleted with its clean worktree');
});
