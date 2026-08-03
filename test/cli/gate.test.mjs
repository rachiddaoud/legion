// End-to-end guard for `legion gate run|verify-receipt` through the REAL bin, against real
// fixture git repos with LEGION_HOME pinned per scenario (the real ~/.legion is NEVER
// touched). Every scenario builds a genuine project + feature worktree + dossier + tasks.json,
// commits inside the worktree, and drives the gate from the worktree — exactly as the builder
// session does. Gate commands are hermetic (`node -e …`, /usr/bin/true, /usr/bin/false):
// nothing here touches the network.
//
// FIXTURE HYGIENE (load-bearing): legion3 will gate ITSELF with this very command. A literal
// `sk-…`/`ghp_…` token or a literal `debugger` statement in THIS file would be caught by
// tier-0 on the commit that adds it. Every tier-0 fixture is therefore assembled by RUNTIME
// concatenation, so the offending pattern never appears in the source bytes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateGatesConfig } from '../../src/cli/gate.mjs';
import { commandPolicyHash } from '../../src/kernel/state.mjs';
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
const NODE = process.execPath;

// Tier-0 fixtures, assembled at runtime — see FIXTURE HYGIENE above.
const FAKE_KEY = 'sk-' + 'A1b2C3d4E5f6G7h8I9j0';       // matches SECRETS[0]
const DBG_LINE = ['debug', 'ger'].join('') + ';';       // matches DEBUGGER

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-gate-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) => sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const NOW = ['--now', '2026-07-24T00:00:00.000Z'];

let n = 0;
/** Fresh sandbox: isolated LEGION_HOME + one-commit fixture repo, a registered project, a
 * started feature `f1` with a real worktree + dossier, and an initialized tasks.json.
 * `baseFiles` ({relPath: contents}) join that FIRST commit, i.e. they pre-exist the feature's
 * baseSha — the only way to test what a feature does to something it did not introduce.
 *
 * `opts.gates` DECLARES THE GATE POLICY BEFORE `feature start`, and that ordering is load-bearing
 * (T12): the policy is PINNED PER FEATURE at start (PLAN-V3 §Gates), so a policy declared
 * AFTERWARDS is by definition drift and `gate run` refuses it before running anything. Every test
 * that just wants a green/red command therefore declares it here; post-start setGates() survives
 * for the handful of tests that deliberately want drift, or whose refusal fires strictly earlier
 * than the pin comparison (the dirty check, and config validation). It may be a plain gates object
 * or a FACTORY taking the sandbox paths — a command that proves it ran needs a sentinel path
 * inside the sandbox, which the caller cannot know before scenario() returns. */
function scenario(baseFiles = {}, { gates } = {}) {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fix-proj' }, null, 2) + '\n');
  for (const [rel, body] of Object.entries(baseFiles)) {
    const abs = join(repo, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  const env = { ...process.env, LEGION_HOME: home };
  let r = spawnSync(NODE, [BIN, 'project', 'init', '--root', repo], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const dossier = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'features', 'f1');
  const configPath = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json');
  if (gates !== undefined) {
    writeGates(configPath, typeof gates === 'function' ? gates({ base, home, repo, dossier }) : gates);
  }
  r = spawnSync(NODE, [BIN, 'feature', 'start', 'f1', '--base', 'main'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const worktree = realpathSync(join(base, '.legion-worktrees', 'fix-proj', 'f1', 'checkout'));
  const s = { home, repo: realpathSync(repo), base, dossier, worktree, configPath, env };
  assert.equal(state(s, 'init').status, 0, 'state init');
  return s;
}

const state = (s, ...args) =>
  spawnSync(NODE, [BIN, 'state', ...args], { cwd: s.worktree, encoding: 'utf8', env: s.env });
/** Run `legion gate ...` from inside the feature worktree (resolves by git toplevel). */
const gate = (s, ...args) =>
  spawnSync(NODE, [BIN, 'gate', ...args], { cwd: s.worktree, encoding: 'utf8', env: s.env });

const tasksJson = (s) => JSON.parse(readFileSync(join(s.dossier, 'tasks.json'), 'utf8'));

/** Patch a project.json's gates block in place. */
function writeGates(configPath, gates) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  writeFileSync(configPath, JSON.stringify({ ...cfg, gates }, null, 2) + '\n');
}
/** Patch project.json's gates block AFTER `feature start`, i.e. AFTER the policy was pinned.
 * That is policy DRIFT by construction (T12), so this is now only for tests that want drift, or
 * whose refusal fires strictly before the pin comparison. Everything else passes `{gates}` to
 * scenario(). */
const setGates = (s, gates) => writeGates(s.configPath, gates);
/** The per-tier policy hash pinned in this feature's feature.json. */
const pinnedPolicy = (s) => featureJson(s).commandPolicyHash;
const featureJson = (s) => JSON.parse(readFileSync(join(s.dossier, 'feature.json'), 'utf8'));

/** Write files into the worktree and commit them. `files` is {relPath: contents}. */
function commitInWorktree(s, files, msg = 'work') {
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(s.worktree, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', msg);
}

/** Seed canonical tasks[] through the real import path (plan check --import). */
function seedTasks(s, tasks) {
  writeFileSync(join(s.dossier, 'plan.md'), '# plan\n');
  writeFileSync(
    join(s.dossier, 'plan.tasks.json'),
    JSON.stringify({ milestones: [{ id: 'M1', title: 'm', tasks }] }, null, 2) + '\n',
  );
  const r = spawnSync(NODE, [BIN, 'plan', 'check', '--feature', 'f1', '--import', ...NOW], { cwd: s.worktree, encoding: 'utf8', env: s.env });
  assert.equal(r.status, 0, r.stderr);
}
const planTask = (id, extra = {}) => ({ id, title: `do ${id}`, status: 'pending', attempt: 0, ...extra });

/** A structured gate command running `node -e <src>`. */
const nodeCmd = (src, timeoutMs = 30000) => ({ argv: [NODE, '-e', src], timeoutMs });
/** node -e source that appends `mark` to <worktree>/marks.txt (outside git's index concerns). */
const appendMark = (mark) =>
  `require('node:fs').appendFileSync(process.env.MARKS, ${JSON.stringify(mark)})`;

// --- 1. tier-0 secrets ---------------------------------------------------------------------

test('tier-0: a secret in the committed range fails the gate and records no receipt', () => {
  const s = scenario();
  commitInWorktree(s, { 'src/leak.mjs': `export const token = '${FAKE_KEY}';\n` });
  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /API key/);
  assert.match(r.stderr, /src\/leak\.mjs/);
  assert.equal(tasksJson(s).receipts.boundary, null, 'a red gate records nothing');
});

// --- 2. tier-0 debugger + CODE_EXT gating ---------------------------------------------------

test('tier-0: a debugger statement fails in a .mjs but the same bytes pass in a .txt', () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': `function f() {\n  ${DBG_LINE}\n}\n` });
  let r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /debugger statement in src\/a\.mjs/);

  const s2 = scenario();
  commitInWorktree(s2, { 'notes/a.txt': `function f() {\n  ${DBG_LINE}\n}\n` });
  r = gate(s2, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(tasksJson(s2).receipts.boundary.head, sh(s2.worktree, 'rev-parse', 'HEAD'));
});

// --- 3. new files in the range are scanned (the v2 -> v3 diff-source change) -----------------

test('tier-0 scans NEW files in <baseSha>..HEAD, not just modified ones', () => {
  const s = scenario();
  // A brand-new file, introduced two commits deep, must still be scanned.
  commitInWorktree(s, { 'src/ok.mjs': 'export const ok = 1;\n' }, 'first');
  commitInWorktree(s, { 'src/brand-new.mjs': `const k = '${FAKE_KEY}';\nexport default k;\n` }, 'second');
  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /src\/brand-new\.mjs/);
});

// --- 3b. the diff FORMAT is pinned, not inherited ---------------------------------------------
// Each of these gated a committed `sk-…` key GREEN before the fix, by making the scanner's
// `+++ b/<path>` headers vanish — a scan of zero bytes printing `tier-0 OK`.

test('tier-0 still sees the diff under hostile repo diff config (noprefix/color/mnemonic)', () => {
  for (const cfg of [['diff.noprefix', 'true'], ['color.diff', 'always'], ['diff.mnemonicPrefix', 'true'], ['diff.srcPrefix', 'src|'], ['diff.dstPrefix', 'dst|']]) {
    const s = scenario();
    sh(s.worktree, 'config', ...cfg); // repo-local == what a ~/.gitconfig preference would do
    commitInWorktree(s, { 'src/leak.mjs': `export const token = '${FAKE_KEY}';\n` });
    const r = gate(s, 'run', '--boundary', ...NOW);
    assert.equal(r.status, 1, `${cfg.join('=')} must not blind tier-0: ${r.stdout}`);
    assert.match(r.stderr, /API key/);
    assert.match(r.stderr, /src\/leak\.mjs/);
    assert.equal(tasksJson(s).receipts.boundary, null);
  }
});

test('tier-0 still sees the diff when the feature commits `.gitattributes` marking code binary', () => {
  const s = scenario();
  commitInWorktree(s, {
    '.gitattributes': '*.mjs -diff\n',
    'src/leak.mjs': `export const token = '${FAKE_KEY}';\n`,
  });
  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /API key/);
  assert.match(r.stderr, /src\/leak\.mjs/);
});

test('tier-0 DIES rather than reporting OK when a changed path yields no parseable diff section', () => {
  const s = scenario();
  // A path git must C-quote is the one input the pinned parser cannot attribute. Before the
  // audit it was silently skipped (fail-open); now the whole gate refuses.
  commitInWorktree(s, { 'src/we"ird.mjs': `export const token = '${FAKE_KEY}';\n` });
  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /tier-0 could not read the diff/);
  assert.match(r.stderr, /read nothing/);
  assert.equal(tasksJson(s).receipts.boundary, null);
});

// --- 4. protected config --------------------------------------------------------------------

test('protected config: refused without --allow-config, allowed (and receipted) with it', () => {
  const s = scenario();
  commitInWorktree(s, { 'tsconfig.json': '{"compilerOptions":{}}\n' });
  let r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /protected config modified: tsconfig\.json/);
  assert.match(r.stderr, /don't weaken the gate/);
  assert.equal(tasksJson(s).receipts.boundary, null);

  r = gate(s, 'run', '--boundary', '--allow-config', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /--allow-config: tsconfig\.json/);
  assert.equal(tasksJson(s).receipts.boundary.head, sh(s.worktree, 'rev-parse', 'HEAD'));

  const s2 = scenario();
  commitInWorktree(s2, { '.eslintrc.json': '{}\n' });
  r = gate(s2, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /protected config modified: \.eslintrc\.json/);
});

test('protected config cannot be neutralized by RENAMING it out of the way', () => {
  const s = scenario({ '.eslintrc.json': '{}\n' }); // pre-exists baseSha
  assert.ok(existsSync(join(s.worktree, '.eslintrc.json')), 'fixture: base carries the lint config');

  sh(s.worktree, 'mv', '.eslintrc.json', 'eslint-old.txt'); // git's rename detection hides the source
  gitc(s.worktree, 'commit', '-m', 'shhh');
  let r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /protected config modified: \.eslintrc\.json/);
  assert.equal(tasksJson(s).receipts.boundary, null);

  // Plain deletion was already caught and must stay caught.
  const s3 = scenario({ '.eslintrc.json': '{}\n' });
  sh(s3.worktree, 'rm', '.eslintrc.json');
  gitc(s3.worktree, 'commit', '-m', 'gone');
  r = gate(s3, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /protected config modified: \.eslintrc\.json/);
});

// --- 5. green task run records a receipt the state layer accepts -----------------------------

test('green task gate records a tree-keyed receipt that state task-done accepts', () => {
  // Declared BEFORE `feature start` so the pin matches (scenario header): a policy declared
  // afterwards is drift and the run would refuse for a reason this test is not about.
  const s = scenario({}, { gates: { commands: { ok: nodeCmd('process.exit(0)') }, task: ['ok'], boundary: [] } });
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  const r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /gate GREEN \(task tier\)/);
  const tree = sh(s.worktree, 'rev-parse', 'HEAD^{tree}');
  assert.equal(tasksJson(s).tasks.find((t) => t.id === 'T1').receipt.treeHash, tree);

  assert.equal(state(s, 'task-start', 'T1', ...NOW).status, 0);
  const done = state(s, 'task-done', 'T1', ...NOW);
  assert.equal(done.status, 0, done.stderr);
});

// --- 6. green boundary run unblocks close delivered's receipt check ---------------------------

test('green boundary gate records receipts.boundary.head = HEAD and clears close delivered', () => {
  const s = scenario({}, { gates: { commands: { ok: nodeCmd('process.exit(0)') }, task: [], boundary: ['ok'] } });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  const head = sh(s.worktree, 'rev-parse', 'HEAD');
  assert.equal(tasksJson(s).receipts.boundary.head, head);

  // close delivered must now complain about the NEXT unmet condition, not the receipt. Since
  // T13 that is the STAGE clause (this feature never left intake — close delivered requires the
  // finalize stage before it reads any evidence); the receipt check is demonstrably cleared
  // because the refusal no longer names it.
  const close = state(s, 'close', 'delivered', ...NOW);
  assert.equal(close.status, 1);
  assert.match(close.stderr, /requires the current stage to be 'finalize'/);
  assert.doesNotMatch(close.stderr, /boundary receipt/);
});

// --- 7. red tier records nothing --------------------------------------------------------------

test('a red tier command exits nonzero, reports the tail, and writes no receipt', () => {
  const s = scenario({}, { gates: { commands: { red: nodeCmd('console.log("boom detail"); process.exit(3)') }, task: ['red'], boundary: [] } });
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const revBefore = tasksJson(s).revision;

  const r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /gate RED \(task tier\) at `red`/);
  assert.match(r.stderr, /exit 3/);
  assert.match(r.stderr, /boom detail/);
  const t = tasksJson(s);
  assert.equal(t.revision, revBefore, 'a red gate must not write tasks.json');
  assert.equal(t.tasks.find((x) => x.id === 'T1').receipt, undefined);
});

// --- 7b. a PASSING but verbose command is green, not a fabricated timeout -----------------------

test('a gate command that passes while printing >1 MiB is GREEN, not a bogus timeout', () => {
  // writeSync, not process.stdout.write + exit: the latter drops the tail at the pipe buffer
  // and would never reach execFileSync's ceiling at all.
  const s = scenario({}, {
    gates: {
      commands: {
        loud: nodeCmd('require("node:fs").writeSync(1, "y".repeat(2*1024*1024))', 60000),
      },
      task: [], boundary: ['loud'],
    },
  });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, /timeout/);
  assert.match(r.stdout, /gate GREEN \(boundary tier\)/);
  assert.equal(tasksJson(s).receipts.boundary.head, sh(s.worktree, 'rev-parse', 'HEAD'));
});

test('a real timeout is still reported as a timeout, and is not confused with output volume', () => {
  const s = scenario({}, { gates: { commands: { hang: nodeCmd('setTimeout(() => {}, 600000)', 700) }, task: [], boundary: ['hang'] } });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /gate RED \(boundary tier\) at `hang`/);
  assert.match(r.stderr, /timeout after 700ms/);
  assert.equal(tasksJson(s).receipts.boundary, null);
});

// --- 8. stop at the first failure -------------------------------------------------------------

test('stop-at-first-failure: the expensive command after a red one never runs', () => {
  const s = scenario({}, {
    gates: ({ base }) => ({
      commands: {
        red: nodeCmd('process.exit(1)'),
        expensive: nodeCmd(`require('node:fs').writeFileSync(${JSON.stringify(join(base, 'expensive.sentinel'))}, 'ran')`),
      },
      task: [], boundary: ['red', 'expensive'],
    }),
  });
  const sentinel = join(s.base, 'expensive.sentinel');
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /at `red`/);
  assert.equal(existsSync(sentinel), false, 'the expensive command must never have run');
});

// --- 9. validate runs LAST, after the tier commands --------------------------------------------

test('the task validate runs after the declared tier commands, in order', () => {
  const s = scenario({}, { gates: { commands: { first: nodeCmd(appendMark('A')) }, task: ['first'], boundary: [] } });
  const marks = join(s.base, 'marks.txt');
  writeFileSync(marks, '');
  const env = { ...s.env, MARKS: marks };
  seedTasks(s, [
    planTask('T1', { validate: { cwd: '.', argv: [NODE, '-e', appendMark('B')], timeoutMs: 30000 } }),
    planTask('T2'), planTask('T3'),
  ]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  const r = spawnSync(NODE, [BIN, 'gate', 'run', '--task', 'T1', ...NOW], { cwd: s.worktree, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(marks, 'utf8'), 'AB', 'tier command first, validate last');
});

// --- 10. absent validate is skipped LOUDLY ------------------------------------------------------

test('a task with no validate passes but warns that nothing task-specific ran', () => {
  const s = scenario();
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /declares no validate/);
});

// --- 11. unrunnable validate = PLAN DEFECT -------------------------------------------------------

test('a validate whose argv[0] is not executable is reported as a PLAN DEFECT', () => {
  const s = scenario();
  seedTasks(s, [
    planTask('T1', { validate: { cwd: '.', argv: ['definitely-not-a-binary-xyz'], timeoutMs: 5000 } }),
    planTask('T2'), planTask('T3'),
  ]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /PLAN DEFECT/);
  assert.match(r.stderr, /definitely-not-a-binary-xyz/);
  assert.equal(tasksJson(s).tasks.find((x) => x.id === 'T1').receipt, undefined);
});

// --- 12. {script,sha256} validate ----------------------------------------------------------------

test('{script,sha256} validate runs from the dossier; a mutated script is refused loudly', () => {
  const s = scenario();
  const body = '#!/bin/sh\nexit 0\n';
  mkdirSync(join(s.dossier, 'checks'), { recursive: true });
  const scriptPath = join(s.dossier, 'checks', 'ok.sh');
  writeFileSync(scriptPath, body, { mode: 0o755 });
  seedTasks(s, [
    planTask('T1', { validate: { script: 'checks/ok.sh', sha256: sha256(body) } }),
    planTask('T2'), planTask('T3'),
  ]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  let r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(tasksJson(s).tasks.find((x) => x.id === 'T1').receipt);

  // Mutate the script WITHOUT updating the recorded hash → refused before exec.
  writeFileSync(scriptPath, '#!/bin/sh\nexit 0\n# tampered\n', { mode: 0o755 });
  commitInWorktree(s, { 'src/b.mjs': 'export const b = 1;\n' });
  r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /sha256 mismatch/);
  assert.match(r.stderr, /refusing to execute/);
  // The stale receipt is untouched — no NEW receipt for the new tree.
  const tree = sh(s.worktree, 'rev-parse', 'HEAD^{tree}');
  assert.notEqual(tasksJson(s).tasks.find((x) => x.id === 'T1').receipt.treeHash, tree);
});

// --- 13. dirty worktree refused --------------------------------------------------------------------

test('a dirty worktree is refused before any gate command runs', () => {
  const s = scenario();
  const sentinel = join(s.base, 'dirty.sentinel');
  setGates(s, {
    commands: { touchy: nodeCmd(`require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'ran')`) },
    task: ['touchy'], boundary: [],
  });
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  writeFileSync(join(s.worktree, 'src', 'uncommitted.mjs'), 'export const u = 1;\n');

  const r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /dirty/);
  assert.match(r.stderr, /commit-then-gate/);
  assert.equal(existsSync(sentinel), false, 'nothing may run on a dirty tree');
});

// --- 14. absent / empty gates config is usable, tier-0 still enforced ---------------------------------

test('the `gates: {}` init scaffold and an empty tier both warn but still run tier-0', () => {
  for (const gates of [{}, { commands: {}, task: [] }]) {
    const s = scenario();
    setGates(s, gates);
    seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
    commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
    let r = gate(s, 'run', '--task', 'T1', ...NOW);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /no project-owned task commands declared/);
    // tier-0 is NOT weakened by an empty tier
    commitInWorktree(s, { 'src/leak.mjs': `const k = '${FAKE_KEY}';\n` });
    r = gate(s, 'run', '--task', 'T2', ...NOW);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stderr, /API key/);
  }
});

// --- 15. malformed / dangling gates config dies loudly ------------------------------------------------

test('a dangling tier name dies loudly naming the tier and the unknown command', () => {
  const s = scenario();
  setGates(s, { commands: { ok: nodeCmd('0') }, task: ['ok', 'lint'], boundary: [] });
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /gates\.task\[1\] references unknown command 'lint'/);
});

test('a malformed gate command dies loudly through the CLI', () => {
  const s = scenario();
  setGates(s, { commands: { ok: { argv: 'npm test', timeoutMs: 1 } }, task: ['ok'], boundary: [] });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /gates\.commands\.ok\.argv must be a non-empty array of strings/);
});

test('validateGatesConfig: null/{} are usable; every malformed shape names its key', () => {
  const P = '/cfg/project.json';
  assert.deepEqual(validateGatesConfig(null, P), { commands: {}, task: [], boundary: [] });
  assert.deepEqual(validateGatesConfig(undefined, P), { commands: {}, task: [], boundary: [] });
  assert.deepEqual(validateGatesConfig({}, P), { commands: {}, task: [], boundary: [] });
  assert.deepEqual(
    validateGatesConfig({ commands: { ok: { argv: ['true'], timeoutMs: 5 } }, task: ['ok'] }, P),
    { commands: { ok: { argv: ['true'], timeoutMs: 5 } }, task: ['ok'], boundary: [] },
  );

  const bad = [
    [{ commands: { ok: { argv: ['x'], timeoutMs: 1 } }, tiers: [] }, /unknown key 'gates\.tiers'/],
    [{ commands: [] }, /gates\.commands must be an object/],
    [{ commands: { Ok: { argv: ['x'], timeoutMs: 1 } } }, /command name 'Ok'/],
    [{ commands: { ok: 'npm test' } }, /gates\.commands\.ok must be exactly/],
    [{ commands: { ok: { argv: ['x'], timeoutMs: 1, extra: 1 } } }, /gates\.commands\.ok must be exactly/],
    [{ commands: { ok: { argv: 'npm test', timeoutMs: 1 } } }, /gates\.commands\.ok\.argv/],
    [{ commands: { ok: { argv: [], timeoutMs: 1 } } }, /gates\.commands\.ok\.argv/],
    [{ commands: { ok: { argv: [1], timeoutMs: 1 } } }, /gates\.commands\.ok\.argv/],
    [{ commands: { ok: { argv: ['x'], timeoutMs: 0 } } }, /gates\.commands\.ok\.timeoutMs/],
    [{ commands: { ok: { argv: ['x'], timeoutMs: 1.5 } } }, /gates\.commands\.ok\.timeoutMs/],
    [{ commands: { ok: { argv: ['x'], timeoutMs: '1' } } }, /gates\.commands\.ok\.timeoutMs/],
    [{ commands: {}, task: 'ok' }, /gates\.task must be an array/],
    [{ commands: {}, boundary: [7] }, /gates\.boundary\[0\] must be a command-name string/],
    [{ commands: {}, boundary: ['nope'] }, /gates\.boundary\[0\] references unknown command 'nope'/],
    ['npm test', /gates must be an object/],
  ];
  for (const [cfg, re] of bad) {
    assert.throws(() => validateGatesConfig(cfg, P), re, `expected refusal for ${JSON.stringify(cfg)}`);
  }
});

// --- 16 + 17. verify-receipt: fresh / missing / stale, and it never runs the gate ------------------

test('verify-receipt passes on a fresh receipt and fails when missing or stale — running nothing', () => {
  const s = scenario({}, {
    gates: ({ base }) => {
      const touchy = nodeCmd(`require('node:fs').writeFileSync(${JSON.stringify(join(base, 'verify.sentinel'))}, 'ran')`);
      return { commands: { touchy }, task: ['touchy'], boundary: ['touchy'] };
    },
  });
  const sentinel = join(s.base, 'verify.sentinel');
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  // missing receipt
  let r = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /run `legion gate run --task T1`/);
  assert.equal(existsSync(sentinel), false, 'verify-receipt must never run a gate command');
  r = gate(s, 'verify-receipt', '--boundary');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /run `legion gate run --boundary`/);
  assert.equal(existsSync(sentinel), false);

  // record both receipts with a real (green) gate run
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);
  assert.equal(gate(s, 'run', '--boundary', ...NOW).status, 0);
  assert.equal(existsSync(sentinel), true, 'the real gate DOES run the command');
  rmSync(sentinel);

  r = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /receipt OK for task T1/);
  r = gate(s, 'verify-receipt', '--boundary');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /boundary receipt OK/);
  assert.equal(existsSync(sentinel), false, 'verify-receipt must never run a gate command');

  // a NEW commit makes both receipts stale
  commitInWorktree(s, { 'src/b.mjs': 'export const b = 1;\n' });
  r = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /no valid receipt for task T1/);
  r = gate(s, 'verify-receipt', '--boundary');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /no valid boundary receipt/);
  assert.equal(existsSync(sentinel), false, 'verify-receipt must never run a gate command');
});

// --- 18. verify-receipt fails closed on a dirty tree --------------------------------------------------

test('verify-receipt refuses a dirty worktree even with a matching receipt', () => {
  const s = scenario();
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);
  assert.equal(gate(s, 'verify-receipt', '--task', 'T1').status, 0);

  writeFileSync(join(s.worktree, 'src', 'a.mjs'), 'export const a = 2;\n'); // ungated edit
  const r = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /uncommitted changes/);
});

// --- 19. flag discipline ---------------------------------------------------------------------------

test('flag discipline: exactly one of --task/--boundary, known subcommand, inline --task=', () => {
  const s = scenario();
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  let r = gate(s, 'run', ...NOW);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /EXACTLY one of --task <id> \| --boundary/);

  r = gate(s, 'run', '--task', 'T1', '--boundary', ...NOW);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /EXACTLY one of --task <id> \| --boundary/);

  r = gate(s, 'verify-receipt');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /EXACTLY one of --task <id> \| --boundary/);

  r = gate(s, 'frobnicate', '--boundary');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown or malformed subcommand 'frobnicate'/);
  assert.match(r.stderr, /legion gate run/);

  r = gate(s, 'run', '--task=T1', ...NOW);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(tasksJson(s).tasks.find((x) => x.id === 'T1').receipt);

  r = gate(s, 'run', '--task', 'TX', ...NOW);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown task 'TX'/);
});

// --- 20. resolution refusal outside a feature worktree ------------------------------------------------

test('gate refuses to run from the main repo root (not a feature worktree)', () => {
  const s = scenario();
  const r = spawnSync(NODE, [BIN, 'gate', 'run', '--boundary'], { cwd: s.repo, encoding: 'utf8', env: s.env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not a registered legion feature worktree/);
});

// --- tasks.json precondition ---------------------------------------------------------------------------

test('gate refuses before `legion state init` with the exact recovery instruction', () => {
  const s = scenario();
  rmSync(join(s.dossier, 'tasks.json'));
  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no tasks\.json/);
  assert.match(r.stderr, /legion state init/);
});

// --- T7b MUST-FIX 1: the dirty-worktree refusal must not be fail-open ---------------------------
// Every case below gated a committed-clean tree GREEN on d30972f while an UNTRACKED file holding
// an `sk-…` key sat in the worktree: `git status --porcelain` came back empty, so the gate never
// refused, tier-0 never saw the file (it is not in <baseSha>..HEAD), and the tree got a receipt.

/** gate() with extra environment variables merged into the child — the hostile-ambient seam. */
const gateEnv = (s, envExtra, ...args) =>
  spawnSync(NODE, [BIN, 'gate', ...args], { cwd: s.worktree, encoding: 'utf8', env: { ...s.env, ...envExtra } });

/** Drop an untracked file holding a fake secret into the worktree. */
const dropSecret = (s, rel = 'leaked.txt') =>
  writeFileSync(join(s.worktree, rel), `TOKEN=${FAKE_KEY}\n`);

test('an untracked secret is still DIRTY under repo config status.showUntrackedFiles=no', () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  // Repo-local .git/config: a linked worktree SHARES it with the main checkout, and the same
  // knob in a developer's ~/.gitconfig behaves identically.
  sh(s.worktree, 'config', 'status.showUntrackedFiles', 'no');
  assert.equal(sh(s.worktree, 'status', '--porcelain'), '', 'fixture: plain status is blinded');
  dropSecret(s);

  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /dirty/);
  assert.match(r.stderr, /leaked\.txt/);
  assert.equal(tasksJson(s).receipts.boundary, null, 'no receipt for a tree with an unscanned secret');
});

test('an untracked secret is still DIRTY under GIT_CONFIG_* env-injected config', () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  dropSecret(s);
  const hostile = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'status.showUntrackedFiles',
    GIT_CONFIG_VALUE_0: 'no',
  };
  const r = gateEnv(s, hostile, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /dirty/);
  assert.match(r.stderr, /leaked\.txt/);
  assert.equal(tasksJson(s).receipts.boundary, null);
});

test('GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE in the environment cannot make a dirty tree look clean', () => {
  // These are NOT config: no `-c` can override them, they repoint git at another repository
  // (or a bogus index) and `status --porcelain` then reports nothing about OUR worktree.
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const other = join(s.base, 'other');
  mkdirSync(other, { recursive: true });
  sh(other, 'init', '-b', 'main');
  writeFileSync(join(other, 'x.txt'), 'x\n');
  sh(other, 'add', '-A');
  gitc(other, 'commit', '-m', 'other');
  dropSecret(s);

  for (const hostile of [
    { GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other },
    { GIT_INDEX_FILE: join(s.base, 'bogus.index') },
  ]) {
    const r = gateEnv(s, hostile, 'run', '--boundary', ...NOW);
    assert.equal(r.status, 1, `${JSON.stringify(hostile)}: ${r.stdout}`);
    assert.match(r.stderr, /dirty/);
    assert.match(r.stderr, /leaked\.txt/);
    // The gate must still have resolved OUR feature worktree, not the decoy repo.
    assert.ok(r.stderr.includes(s.worktree), `refusal must name ${s.worktree}: ${r.stderr}`);
    assert.equal(tasksJson(s).receipts.boundary, null);
  }
});

test('a GLOBAL excludes file cannot hide an untracked secret, but a COMMITTED .gitignore still exempts build output', () => {
  // The documented ignored-file decision (header 12): ignored files are not dirty, because they
  // are not in the tree the receipt certifies — but the ONLY ignore sources that survive are the
  // repo's committed, reviewable .gitignore files.
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const excludes = join(s.base, 'hostile.excludes');
  writeFileSync(excludes, 'leaked.txt\n');
  const globalCfg = join(s.base, 'hostile.gitconfig');
  writeFileSync(globalCfg, `[core]\n\texcludesFile = ${excludes}\n`);
  dropSecret(s);
  let r = gateEnv(s, { GIT_CONFIG_GLOBAL: globalCfg }, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /dirty/);
  assert.match(r.stderr, /leaked\.txt/);

  // The other half of the decision: committed .gitignore'd build output must NOT block the gate.
  rmSync(join(s.worktree, 'leaked.txt'));
  commitInWorktree(s, { '.gitignore': 'build/\n' }, 'ignore build');
  mkdirSync(join(s.worktree, 'build'), { recursive: true });
  writeFileSync(join(s.worktree, 'build', 'out.txt'), 'artifact\n');
  r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(tasksJson(s).receipts.boundary.head, sh(s.worktree, 'rev-parse', 'HEAD'));
});

test('verify-receipt also refuses an untracked secret under hostile status config', () => {
  const s = scenario();
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);
  assert.equal(gate(s, 'verify-receipt', '--task', 'T1').status, 0);

  sh(s.worktree, 'config', 'status.showUntrackedFiles', 'no');
  dropSecret(s); // the receipt's tree hash still MATCHES — only the dirty check can catch this
  const r = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /uncommitted changes/);
  assert.match(r.stderr, /leaked\.txt/);
});

// --- T7b MUST-FIX 2: the receipt certifies the tree that was actually gated ---------------------

test('a tier command that COMMITS mid-gate aborts the gate and records no receipt', () => {
  const s = scenario({}, {
    gates: {
      commands: {
        sneaky: nodeCmd(
          "const {execFileSync:x}=require('node:child_process');" +
          "require('node:fs').writeFileSync('formatted.txt','tidied\\n');" +
          "x('git',['add','-A'],{stdio:'ignore'});" +
          "x('git',['-c','user.email=t@example.invalid','-c','user.name=t','commit','-m','auto-format'],{stdio:'ignore'});",
        ),
      },
      task: [], boundary: ['sneaky'],
    },
  });
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const headBefore = sh(s.worktree, 'rev-parse', 'HEAD');

  const r = gate(s, 'run', '--boundary', ...NOW);
  const headAfter = sh(s.worktree, 'rev-parse', 'HEAD');
  assert.notEqual(headAfter, headBefore, 'fixture: the tier command really did move HEAD');
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /ABORTED/);
  assert.match(r.stderr, /CHANGED during the boundary tier/);
  assert.ok(r.stderr.includes(headBefore), 'the refusal must name the GATED head');
  assert.ok(r.stderr.includes(headAfter), 'the refusal must name the MOVED head');
  assert.equal(tasksJson(s).receipts.boundary, null, 'no receipt may certify an unscanned tree');
});

test('a tier command that only WRITES an untracked file aborts the task gate (HEAD unchanged)', () => {
  const s = scenario({}, {
    gates: {
      commands: { messy: nodeCmd(`require('node:fs').writeFileSync('scratch.log','${'x'.repeat(8)}\\n')`) },
      task: ['messy'], boundary: [],
    },
  });
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const headBefore = sh(s.worktree, 'rev-parse', 'HEAD');

  const r = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.equal(sh(s.worktree, 'rev-parse', 'HEAD'), headBefore, 'fixture: HEAD did NOT move');
  assert.match(r.stderr, /ABORTED/);
  assert.match(r.stderr, /worktree dirty: .*scratch\.log/);
  assert.equal(tasksJson(s).tasks.find((x) => x.id === 'T1').receipt, undefined);
});

// --- T7b ALSO-FIX c: relocated content is not authored content ----------------------------------

test('moving a pre-existing file with a secret in it does NOT fail tier-0', () => {
  const s = scenario({ 'legacy/config.js': `const k = "${FAKE_KEY}";\nmodule.exports = k;\n` });
  mkdirSync(join(s.worktree, 'lib'), { recursive: true }); // git mv will not create it
  sh(s.worktree, 'mv', 'legacy/config.js', 'lib/config.js');
  gitc(s.worktree, 'commit', '-m', 'relocate');

  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.equal(tasksJson(s).receipts.boundary.head, sh(s.worktree, 'rev-parse', 'HEAD'));
});

test('a move that also ADDS a new secret line is still RED, naming only the new file', () => {
  const s = scenario({ 'legacy/config.js': `const k = "${FAKE_KEY}";\nmodule.exports = k;\n` });
  const NEW_KEY = 'sk-' + 'Z9y8X7w6V5u4T3s2R1q0';
  mkdirSync(join(s.worktree, 'lib'), { recursive: true });
  sh(s.worktree, 'mv', 'legacy/config.js', 'lib/config.js');
  writeFileSync(join(s.worktree, 'lib', 'config.js'),
    `const k = "${FAKE_KEY}";\nconst k2 = "${NEW_KEY}";\nmodule.exports = k;\n`);
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', 'relocate + new key');

  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /API key/);
  assert.match(r.stderr, /lib\/config\.js/);
  assert.equal(tasksJson(s).receipts.boundary, null);
});

// --- T7b ALSO-FIX d: project.json carries the same schemaVersion assertion ----------------------

test('an unknown project.json schemaVersion dies loudly instead of being read under v1 rules', () => {
  const s = scenario();
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
  writeFileSync(s.configPath, JSON.stringify({ ...cfg, schemaVersion: 2 }, null, 2) + '\n');
  const r = gate(s, 'run', '--boundary', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /unknown schemaVersion 2/);
  assert.ok(r.stderr.includes(s.configPath));
});

// --- T12: the FROZEN command-policy hash, over the pipeline every consumer actually runs --------
// The property under test is "byte-identical recomputation", and that is a property of the
// PIPELINE — validateGatesConfig() → commandPolicyHash() — not of the hash function alone. Both
// halves are therefore composed here exactly as `feature start`, `gate run` and every verifier
// compose them. The hash's own pure properties live in test/kernel/state.test.mjs.

/** The real pipeline: a raw project.json `gates` block in, one tier's policy hash out. */
const policyOf = (gates, tier) => commandPolicyHash(validateGatesConfig(gates, '/cfg/project.json'), tier);

test('the command-policy hash is CANONICAL: key order is invisible, execution order is policy', () => {
  const A = { argv: ['npm', 'test'], timeoutMs: 30000 };
  const B = { argv: ['npx', 'tsc', '--noEmit'], timeoutMs: 60000 };
  const base = { commands: { a: A, b: B }, task: ['a', 'b'], boundary: ['a'] };
  const h0 = policyOf(base, 'task');

  // (0) the same config twice is the same hash — the whole point.
  assert.equal(policyOf(base, 'task'), h0);

  // (i) `gates.commands` KEY ORDER is invisible: the payload is an array of triples indexed by the
  // TIER list, so no object key order is ever observed.
  assert.equal(policyOf({ commands: { b: B, a: A }, task: ['a', 'b'], boundary: ['a'] }, 'task'), h0);
  // …and so is the TOP-LEVEL `gates` key order.
  assert.equal(policyOf({ boundary: ['a'], task: ['a', 'b'], commands: { a: A, b: B } }, 'task'), h0);
  // …and so is a command object's own key order, because validateGatesConfig rebuilds it.
  assert.equal(policyOf({ commands: { a: { timeoutMs: 30000, argv: ['npm', 'test'] }, b: B }, task: ['a', 'b'] }, 'task'), h0);

  // (ii) an argv element, and a timeoutMs, are POLICY.
  assert.notEqual(policyOf({ commands: { a: { argv: ['npm', 'run', 'test'], timeoutMs: 30000 }, b: B }, task: ['a', 'b'] }, 'task'), h0);
  assert.notEqual(policyOf({ commands: { a: { argv: ['npm', 'test'], timeoutMs: 30001 }, b: B }, task: ['a', 'b'] }, 'task'), h0);

  // (iii) the TIER ARRAY's order IS load-bearing — it is the EXECUTION order (cheap → expensive,
  // stop at the first failure), so reordering it is a real policy change.
  assert.notEqual(policyOf({ commands: { a: A, b: B }, task: ['b', 'a'] }, 'task'), h0);

  // (iv) a command DECLARED but not referenced by the tier is not that tier's policy.
  assert.equal(policyOf({ commands: { a: A, b: B, unused: { argv: ['echo'], timeoutMs: 1 } }, task: ['a', 'b'] }, 'task'), h0);

  // the same command list under a DIFFERENT tier is a different policy (the tier is in the payload).
  assert.notEqual(policyOf({ commands: { a: A, b: B }, task: ['a', 'b'], boundary: ['a', 'b'] }, 'boundary'), h0);

  // the `project init` scaffold and an explicitly-empty tier normalize to the SAME policy — which
  // is why the scaffold test above still passes with a post-start setGates: canonicality, for free.
  assert.equal(policyOf({}, 'task'), policyOf({ commands: {}, task: [] }, 'task'));
  assert.equal(policyOf(null, 'task'), policyOf({}, 'task'));
});

// --- T12: the pin, the drift refusal, and --repin ----------------------------------------------

/** A gate command that PROVES it ran by writing `file`. The absence of the file is then a FACT
 * rather than an inference from log wording. It writes OUTSIDE the worktree — writing inside would
 * dirty the tree and trip decision 13 instead. */
const sentinelCmd = (file) => nodeCmd(`require('node:fs').writeFileSync(${JSON.stringify(file)}, 'ran')`);
/** The pinned policy: one command, `test`, which writes the sentinel. */
const pinnedGates = (file) => ({ commands: { test: sentinelCmd(file) }, task: ['test'], boundary: ['test'] });
/** The drifted policy: the same command plus a second one declared on ONE tier only. */
const driftedGates = (file, tier) => ({
  commands: { test: sentinelCmd(file), extra: sentinelCmd(file) },
  task: tier === 'task' ? ['test', 'extra'] : ['test'],
  boundary: tier === 'boundary' ? ['test', 'extra'] : ['test'],
});

test('`feature start` pins the per-tier policy, and the pin is what a receipt is stamped with', () => {
  const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
  const f = featureJson(s);
  assert.match(f.commandPolicyHash.task, /^[0-9a-f]{64}$/);
  assert.match(f.commandPolicyHash.boundary, /^[0-9a-f]{64}$/);
  assert.ok(typeof f.commandPolicyPinnedAt === 'string');
  // The command LISTS are recorded beside the hashes so a drift refusal can print WHAT changed.
  assert.deepEqual(f.commandPolicy.task.map(([n]) => n), ['test']);
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);
  assert.equal(tasksJson(s).tasks[0].receipt.commandPolicyHash, f.commandPolicyHash.task);
});

test('policy DRIFT refuses the run PER TIER, spawns nothing, writes nothing, and prints the old->new commands', () => {
  for (const tier of ['task', 'boundary']) {
    const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
    const sentinel = join(s.base, 'ran.txt');
    seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
    commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
    // POSITIVE CONTROL: the pinned policy really does run and leave the sentinel, so its absence
    // below is evidence rather than an assumption.
    assert.equal(gate(s, 'run', tier === 'task' ? '--task' : '--boundary', ...(tier === 'task' ? ['T1'] : []), ...NOW).status, 0);
    assert.ok(existsSync(sentinel), 'fixture: the pinned policy must have run');
    rmSync(sentinel);
    const revBefore = tasksJson(s).revision;
    const pinBefore = pinnedPolicy(s);

    setGates(s, driftedGates(sentinel, tier)); // AFTER the pin ⇒ drift, by construction
    const args = tier === 'task' ? ['run', '--task', 'T2'] : ['run', '--boundary'];
    const r = gate(s, ...args, ...NOW);
    assert.equal(r.status, 1, `${tier}: drift must refuse the run\n${r.stdout}`);
    assert.match(r.stderr, /GATE POLICY DRIFT/);
    assert.match(r.stderr, /pin|drift/i, 'the refusal must name the drift');
    assert.equal(existsSync(sentinel), false,
      `${tier}: the refusal must precede any spawned command — every declared command writes this sentinel`);
    // THE FULL COMMAND DIFF, not just two hashes: hash-only output must not satisfy this.
    assert.match(r.stderr, /PINNED policy/);
    assert.match(r.stderr, /LIVE policy/);
    assert.ok(r.stderr.includes('extra'), `the live-only command name must appear: ${r.stderr}`);
    assert.ok(r.stderr.includes(sentinel),
      `and its ARGV, so the operator reads WHAT changed rather than that something did: ${r.stderr}`);
    assert.ok(r.stderr.includes(`legion gate ${args.join(' ')} --repin`),
      `the refusal must print the literal re-pin command: ${r.stderr}`);
    // Nothing moved: not the manifests, not the pin.
    assert.equal(tasksJson(s).revision, revBefore, `${tier}: a refused run must write nothing`);
    assert.deepEqual(pinnedPolicy(s), pinBefore, `${tier}: and must NOT move the pin`);

    // The OTHER tier is untouched by this drift — the comparison is scoped to the tier being run.
    const other = tier === 'task' ? ['run', '--boundary'] : ['run', '--task', 'T2'];
    assert.equal(gate(s, ...other, ...NOW).status, 0, `${tier}: the undrifted tier must still run`);
  }
});

test('`gate run --repin` adopts the live policy, prints the diff, and stamps repinnedFrom on the receipt it earns', () => {
  const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
  const sentinel = join(s.base, 'ran.txt');
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  setGates(s, driftedGates(sentinel, 'task'));
  const pinBefore = pinnedPolicy(s);

  const r = gate(s, 'run', '--task', 'T1', '--repin', ...NOW);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  // (b) THE DIFF IS PRINTED on the re-pin path too, not only on the refusal.
  assert.match(r.stdout, /RECORDING THE LIVE GATE POLICY AS THE NEW PIN/);
  assert.match(r.stdout, /DETECTION, NOT PREVENTION/);
  assert.match(r.stdout, /PINNED policy/);
  assert.match(r.stdout, /LIVE policy/);
  assert.ok(r.stdout.includes('extra'), 'the live-only command name must appear in the diff');
  // …and the declared commands really did run this time.
  assert.ok(existsSync(sentinel), 'a --repin run PROCEEDS: the live commands must actually run');

  // The pin MOVED, to the live policy.
  const pinAfter = pinnedPolicy(s);
  assert.notEqual(pinAfter.task, pinBefore.task, 'the task pin must have moved');
  assert.equal(pinAfter.boundary, pinBefore.boundary, 'the boundary policy did not change here');
  // (a) THE RECEIPT CARRIES IT — compared against the REAL pre-repin value, never a literal.
  const receipt = tasksJson(s).tasks.find((t) => t.id === 'T1').receipt;
  assert.equal(receipt.repinnedFrom, pinBefore.task,
    'the receipt must record the hash the pin superseded, so the fact travels with the evidence');
  assert.equal(receipt.commandPolicyHash, pinAfter.task, 'and the policy it actually ran under');
  assert.match(r.stdout, /GATE POLICY RE-PINNED/, 'and the run says so out loud');

  // An ORDINARY run afterwards mints a receipt with NO repinnedFrom key at all.
  commitInWorktree(s, { 'src/b.mjs': 'export const b = 1;\n' });
  assert.equal(gate(s, 'run', '--task', 'T2', ...NOW).status, 0);
  const plain = tasksJson(s).tasks.find((t) => t.id === 'T2').receipt;
  assert.equal('repinnedFrom' in plain, false, 'presence is the signal, so absence must be absence');
});

test('a --repin run that goes RED still records the history entry — the trail is UNCONDITIONAL', () => {
  // THE CASE THAT MOVED THE TRAIL OFF THE RECEIPT. A red run mints no receipt at all, so a
  // receipt-derived audit trail loses the fact entirely: the policy has moved and the only record
  // was a line on stdout, after which the next ordinary green run looks perfectly un-re-pinned.
  const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
  const sentinel = join(s.base, 'ran.txt');
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const pinBefore = pinnedPolicy(s);
  assert.equal(featureJson(s).commandPolicyHistory, undefined, 'fixture: no history before any re-pin');

  // Drift to a policy whose SECOND command fails, so the re-pinning run adopts it and then goes RED.
  setGates(s, {
    commands: { test: sentinelCmd(sentinel), red: nodeCmd('process.exit(4)') },
    task: ['test', 'red'],
    boundary: ['test'],
  });
  const r = gate(s, 'run', '--task', 'T1', '--repin', ...NOW);
  assert.equal(r.status, 1, `the re-pinned policy must fail this run\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /gate RED/, 'and it must fail as a RED gate, not as a drift refusal');

  // NO receipt was minted — which is exactly why the receipt cannot be the trail.
  assert.equal(tasksJson(s).tasks.find((t) => t.id === 'T1').receipt, undefined,
    'a red gate records no receipt; if it did, this test would be proving nothing');

  // …and yet the pin moved AND the move is on the record, in feature.json, where the pin lives.
  const f = featureJson(s);
  assert.notEqual(f.commandPolicyHash.task, pinBefore.task, 'the pin moved before the tiers ran');
  assert.equal(Array.isArray(f.commandPolicyHistory), true, 'the history must exist after a red re-pin');
  assert.equal(f.commandPolicyHistory.length, 1);
  const [entry] = f.commandPolicyHistory;
  assert.equal(entry.from.task, pinBefore.task, 'from = the REAL superseded hash, not a literal');
  assert.equal(entry.to.task, f.commandPolicyHash.task, 'to = the hash now pinned');
  assert.ok(typeof entry.at === 'string' && entry.at.length > 0);
});

test('`--repin` with NO drift is a no-op that proceeds, and is how a MISSING pin is established', () => {
  const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const pinBefore = pinnedPolicy(s);

  const revBefore = featureJson(s).revision;
  let r = gate(s, 'run', '--task', 'T1', '--repin', ...NOW);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /pin unchanged/);
  assert.deepEqual(pinnedPolicy(s), pinBefore);
  assert.equal('repinnedFrom' in tasksJson(s).tasks[0].receipt, false,
    'no drift ⇒ nothing was superseded ⇒ no audit field');
  // THE OTHER HALF OF "whenever the pin moves, AND ONLY THEN": a no-op must write NOTHING, so the
  // history stays absent and the revision does not bump. Without this, "unconditional trail" could
  // be satisfied by a function that logs an entry on every invocation.
  assert.equal(featureJson(s).commandPolicyHistory, undefined,
    'a no-drift --repin must append no history entry');
  assert.equal(featureJson(s).revision, revBefore,
    'and must not bump the revision or restamp commandPolicyPinnedAt for a no-op');

  // A feature.json with NO pin REFUSES an ordinary run, naming --repin — never a fail-open default.
  const f = featureJson(s);
  const { commandPolicyHash: _drop, ...noPin } = f;
  writeFileSync(join(s.dossier, 'feature.json'), JSON.stringify(noPin, null, 2) + '\n');
  commitInWorktree(s, { 'src/b.mjs': 'export const b = 1;\n' });
  r = gate(s, 'run', '--task', 'T2', ...NOW);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /NONE PINNED/);
  assert.match(r.stderr, /--repin/);
  // …and --repin is the way out: it establishes the pin and proceeds.
  r = gate(s, 'run', '--task', 'T2', '--repin', ...NOW);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.deepEqual(pinnedPolicy(s), pinBefore, 'the re-established pin is the live policy');
  assert.equal('repinnedFrom' in tasksJson(s).tasks.find((t) => t.id === 'T2').receipt, false,
    'there was no pin to supersede, so the audit field must be ABSENT rather than a placeholder');
});

test('`--repin` REPAIRS a pinned command LIST the hashes cannot see — the remedy the refusals name must work', () => {
  // THE REGRESSION THIS PINS. `moved` was computed from the HASHES alone and gated the whole write,
  // so in exactly the state receiptProvenance names `--repin` as the remedy for — a pinned list
  // absent or hand-edited while the hash still matches the live policy — `--repin` wrote nothing and
  // the refusal repeated forever. An operator-facing instruction that cannot clear the state it
  // refuses. Found by the T12b correctness lens.
  const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
  seedTasks(s, [planTask('T1')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  const pinBefore = pinnedPolicy(s);

  // Earn a GENUINE receipt first, so nothing below can pass by the receipt being bad.
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);
  assert.equal(gate(s, 'verify-receipt', '--task', 'T1').status, 0, 'the receipt is genuine to begin with');
  // The list a real `feature start` wrote — the repair must restore exactly this, and it is read
  // from disk rather than restated as a literal so the assertion cannot drift from the writer.
  const listBefore = featureJson(s).commandPolicy;

  for (const [what, mutate] of [
    ['ABSENT', (f) => { const { commandPolicy: _drop, ...rest } = f; return rest; }],
    ['HAND-EDITED', (f) => ({ ...f, commandPolicy: { ...f.commandPolicy, task: [['test', ['echo', 'hi'], 1000]] } })],
  ]) {
    writeFileSync(join(s.dossier, 'feature.json'), JSON.stringify(mutate(featureJson(s)), null, 2) + '\n');
    const before = featureJson(s);

    let r = gate(s, 'verify-receipt', '--task', 'T1');
    assert.equal(r.status, 1, `a ${what} pinned list must refuse: ${r.stdout}`);
    assert.match(r.stderr, /--repin/, `and the ${what} refusal must name --repin`);

    // THE REMEDY, RUN EXACTLY AS PRINTED.
    r = gate(s, 'run', '--task', 'T1', '--repin', ...NOW);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /repaired the pinned gate command LIST/,
      `a ${what} list must be reported as a REPAIR — "nothing written" and "re-pinned" are both false here`);
    // AND THE BRANCH MUST BE THE REPAIR BRANCH, not the no-op branch printing the same summary.
    // `res.summary` is computed from moved/listStale, so the no-op branch renders this identical
    // text and merely appends "— nothing written, proceeding": without this negative assertion the
    // `repaired` flag itself is killed by nothing (mutating it to `false` left the whole suite
    // green), and the operator would be shown a line saying the list was repaired AND that nothing
    // was written. Found by the T12b correctness lens's own mutation testing.
    assert.doesNotMatch(r.stdout, /nothing written/,
      `a ${what} list REPAIR must not also claim nothing was written — feature.json was rewritten`);
    assert.deepEqual(featureJson(s).commandPolicy, listBefore,
      `and the ${what} list must actually be rebuilt on disk`);
    assert.deepEqual(pinnedPolicy(s), pinBefore, 'the POLICY did not change, so the hashes must not move');

    // A REPAIR IS NOT A RE-PIN. Both facts that record a policy MOVE must stay untouched, or the
    // pre-merge human is shown a mid-feature policy change that never happened.
    assert.equal(featureJson(s).commandPolicyHistory, undefined,
      'a repair must append NO history entry — nothing was superseded');
    assert.equal(featureJson(s).commandPolicyPinnedAt, before.commandPolicyPinnedAt,
      'and must not restamp commandPolicyPinnedAt: the pin still dates from when it was set');

    assert.equal(gate(s, 'verify-receipt', '--task', 'T1').status, 0,
      `the ${what} state must be CLEARED by the remedy, not merely re-refused`);
  }
});

test('--repin is rejected on verify-receipt (it records nothing, so it must not advertise a re-pin)', () => {
  const s = scenario();
  const r = gate(s, 'verify-receipt', '--boundary', '--repin');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--repin is only valid on `legion gate run`/);
});

test('a minted receipt carries the full provenance shape, results in EXECUTION order', () => {
  const s = scenario({}, {
    gates: {
      commands: { first: nodeCmd('process.exit(0)'), second: nodeCmd('process.exit(0)') },
      task: ['first', 'second'], boundary: [],
    },
  });
  seedTasks(s, [
    planTask('T1', { validate: { cwd: '.', argv: [NODE, '-e', 'process.exit(0)'], timeoutMs: 30000 } }),
    planTask('T2'), planTask('T3'),
  ]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);

  const r = tasksJson(s).tasks[0].receipt;
  assert.deepEqual(Object.keys(r),
    ['tier', 'commandPolicyHash', 'results', 'declaredCommands', 'head', 'treeHash', 'at']);
  assert.equal(r.tier, 'task');
  assert.equal(r.declaredCommands, 2, 'the PROJECT-declared tier list, which excludes validate');
  assert.deepEqual(r.results.map((x) => x.name), ['first', 'second', 'validate'],
    'every command actually SPAWNED, in execution order, with the plan-owned validate LAST');
  for (const x of r.results) {
    assert.equal(x.exitCode, 0);
    assert.ok(Array.isArray(x.argv) && x.argv.length > 0);
    assert.equal(typeof x.ms, 'number');
  }
  assert.equal(r.head, sh(s.worktree, 'rev-parse', 'HEAD'));
  assert.equal(r.treeHash, sh(s.worktree, 'rev-parse', 'HEAD^{tree}'));
  assert.equal('allowConfig' in r, false, 'the waiver was not used, so the key must not exist');
});

test('the --allow-config waiver is recorded in the receipt provenance, and only when used', () => {
  const s = scenario();
  commitInWorktree(s, { 'tsconfig.json': '{"compilerOptions":{}}\n' });
  assert.equal(gate(s, 'run', '--boundary', '--allow-config', ...NOW).status, 0);
  assert.equal(tasksJson(s).receipts.boundary.allowConfig, true);

  const s2 = scenario();
  commitInWorktree(s2, { 'src/a.mjs': 'export const a = 1;\n' });
  assert.equal(gate(s2, 'run', '--boundary', ...NOW).status, 0);
  assert.equal('allowConfig' in tasksJson(s2).receipts.boundary, false);
});

test('a TIER-0-ONLY receipt is legible as WEAK in gate run\'s GREEN line and verify-receipt\'s OK line', () => {
  const s = scenario(); // `project init` scaffolds gates: {} ⇒ 0 declared commands
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  const g = gate(s, 'run', '--task', 'T1', ...NOW);
  assert.equal(g.status, 0, g.stderr);
  assert.match(g.stdout, /gate GREEN \(task tier\)/, 'the GREEN token itself must not move');
  assert.match(g.stdout, /0 declared task command\(s\)/);
  assert.match(g.stdout, /TIER-0 ONLY/, 'a weak certificate must never read as a full one (R11)');

  const v = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /receipt OK for task T1/);
  assert.match(v.stdout, /TIER-0 ONLY/);

  // …and a receipt WITH declared commands must NOT carry the marker.
  const s2 = scenario({}, { gates: { commands: { ok: nodeCmd('process.exit(0)') }, task: ['ok'], boundary: ['ok'] } });
  commitInWorktree(s2, { 'src/a.mjs': 'export const a = 1;\n' });
  const g2 = gate(s2, 'run', '--boundary', ...NOW);
  assert.equal(g2.status, 0, g2.stderr);
  assert.doesNotMatch(g2.stdout, /TIER-0 ONLY/);
  assert.doesNotMatch(gate(s2, 'verify-receipt', '--boundary').stdout, /TIER-0 ONLY/);
});

test('verify-receipt refuses an UNPROVENANCED receipt before comparing the tree, and reports live drift as a NOTE', () => {
  const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
  const sentinel = join(s.base, 'ran.txt');
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });

  // A hand-forged rev-4 receipt for the CURRENT tree: the tree is real and proves nothing.
  const doc = tasksJson(s);
  doc.tasks[0].receipt = { treeHash: sh(s.worktree, 'rev-parse', 'HEAD^{tree}'), commit: sh(s.worktree, 'rev-parse', 'HEAD'), at: 'forged' };
  writeFileSync(join(s.dossier, 'tasks.json'), JSON.stringify(doc, null, 2) + '\n');
  let v = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(v.status, 1, v.stdout);
  assert.match(v.stderr, /no PROVENANCED task T1 receipt/);
  assert.match(v.stderr, /provenance/i);
  assert.doesNotMatch(v.stderr, /current tree/, 'it must refuse on provenance, not on the tree');
  assert.equal(existsSync(sentinel), false, 'and it must still spawn nothing');

  // Earn a real one, then DRIFT the live policy: the verdict is against the PIN, so it stays OK,
  // with the drift reported as an informational note naming --repin.
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);
  setGates(s, driftedGates(sentinel, 'task'));
  v = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(v.status, 0, `the verdict is against the PIN, which has not moved: ${v.stderr}`);
  assert.match(v.stdout, /note: the live task gate policy/);
  assert.match(v.stdout, /--repin/);

  // An UNREADABLE project.json cannot change the answer — best-effort, informational only.
  writeFileSync(s.configPath, '{ not json\n');
  v = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(v.status, 0, `an unreadable project.json must not change the verdict: ${v.stderr}`);
  assert.doesNotMatch(v.stdout, /note: the live/);
});

test('a receipt earned under a SUPERSEDED policy stops certifying, even on a `done` task', () => {
  const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
  const sentinel = join(s.base, 'ran.txt');
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  assert.equal(state(s, 'task-start', 'T1', ...NOW).status, 0);
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);
  assert.equal(state(s, 'task-done', 'T1', ...NOW).status, 0, 'the earned receipt closes the task');

  // Re-pin on ANOTHER task, so T1's receipt is not re-minted under the new pin.
  setGates(s, driftedGates(sentinel, 'task'));
  assert.equal(gate(s, 'run', '--task', 'T2', '--repin', ...NOW).status, 0);

  // T1 is `done`, and its receipt must STILL be refused: verify-receipt must not short-circuit on
  // status, or a superseded certificate becomes invisible exactly where it matters.
  const v = gate(s, 'verify-receipt', '--task', 'T1');
  assert.equal(v.status, 1, v.stdout);
  assert.match(v.stderr, /SUPERSEDED/);
  assert.equal(tasksJson(s).tasks[0].status, 'done', 'and NO retroactive sweep reopened it');
});

test('task-done refuses a receipt with no provenance, and one whose policy was superseded', () => {
  const s = scenario({}, { gates: ({ base }) => pinnedGates(join(base, 'ran.txt')) });
  const sentinel = join(s.base, 'ran.txt');
  seedTasks(s, [planTask('T1'), planTask('T2'), planTask('T3')]);
  commitInWorktree(s, { 'src/a.mjs': 'export const a = 1;\n' });
  assert.equal(state(s, 'task-start', 'T1', ...NOW).status, 0);

  const doc = tasksJson(s);
  doc.tasks[0].receipt = { treeHash: sh(s.worktree, 'rev-parse', 'HEAD^{tree}'), commit: sh(s.worktree, 'rev-parse', 'HEAD'), at: 'forged' };
  writeFileSync(join(s.dossier, 'tasks.json'), JSON.stringify(doc, null, 2) + '\n');
  let d = state(s, 'task-done', 'T1', ...NOW);
  assert.equal(d.status, 1, d.stdout);
  assert.match(d.stderr, /GATE PROVENANCE/);
  assert.equal(tasksJson(s).tasks[0].status, 'started', 'a refused task-done must not close the task');

  // A genuinely earned receipt, then a re-pin on another task: T1's receipt is superseded.
  assert.equal(gate(s, 'run', '--task', 'T1', ...NOW).status, 0);
  setGates(s, driftedGates(sentinel, 'task'));
  assert.equal(gate(s, 'run', '--task', 'T2', '--repin', ...NOW).status, 0);
  d = state(s, 'task-done', 'T1', ...NOW);
  assert.equal(d.status, 1, d.stdout);
  assert.match(d.stderr, /SUPERSEDED/);
});
