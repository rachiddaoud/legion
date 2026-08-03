// fixture.mjs — THE shared test fixture for the M0 acceptance track (T11). One definition of
// "a legion project + feature that exists for real", built through the REAL bin/legion.mjs so a
// test can never certify a code path the operator does not walk.
//
// WHY THIS FILE EXISTS AT ALL, and what it is NOT: test/cli/state.test.mjs,
// test/cli/gate.test.mjs and test/hooks.test.mjs each carry their own `scenario()` and those
// three have DRIFTED (state's has no configPath and no `state init`; gate's adds
// baseFiles/setGates/commitInWorktree; hooks' adds configPath + `state init`). Unifying them is
// a KNOWN FOLLOW-UP, deliberately NOT done here (T11 scope guard): a 300-line test refactor
// inside this chunk is exactly the scope creep that hides a real defect. New tests use this
// helper; the three existing suites keep working untouched.
//
// `node --test` DISCOVERS EVERY .mjs UNDER test/, INCLUDING THIS ONE. It is executed as a
// (zero-test) test file and counted in the run's test total. Consequences, load-bearing:
//   - module scope does NOTHING but harden the env, declare constants and register the exit
//     sweep. No temp dirs, no git, no assertions at import — an import-time failure would
//     surface as a phantom failing test named after this file, and an import-time mkdtemp would
//     leak a directory on every run of the whole suite.
//
// HERMETIC, AND HONEST ABOUT HOW:
//   - GIT CONFIG: applyHardenedGitEnv(process.env, {identity}) — the SAME single mechanism the
//     three existing suites use, never a second one. It purges every GIT_* except GIT_EXEC_PATH,
//     points GIT_CONFIG_GLOBAL/SYSTEM at /dev/null and pins author/committer, so the developer's
//     ~/.gitconfig can neither steer evidence nor make a fixture commit fail for want of a
//     user.name. Every child below spawns from an env SPREAD from process.env; a future helper
//     that builds an env object from scratch silently opts out — that is the one way this seam
//     can be defeated (kernel/git.mjs header E).
//   - LEGION_HOME: a fresh temp dir per fixture, asserted absolute. paths.mjs already refuses a
//     relative/empty value, but a silent fall-back to the real ~/.legion from a test would be
//     catastrophic, so this file checks too rather than trusting the layer under test.
//   - HOME/XDG_CONFIG_HOME are repointed into the sandbox as well: nothing in a test may read
//     the operator's dotfiles even by a path this helper does not know about.
//   - NETWORK/AGENTS: <sandbox>/fakebin is PREPENDED to PATH and holds `glab` and `claude`
//     shims that print a loud refusal and exit 1. Deliberately NOT fakes that SUCCEED — a
//     succeeding glab would fabricate exactly the remote evidence the kernel exists to demand.
//     Nothing in the acceptance suite invokes them; the shims make an accident loud, not real.
//   - CLEANUP: every sandbox root is registered in ROOTS and removed by ONE `process.on('exit')`
//     sweep, so temp dirs go even when a test throws mid-way (verified: a `{todo}` test that
//     throws still sweeps and the run still exits 0). handle.cleanup() removes eagerly.
//
// ORDER OF OPERATIONS IS LOAD-BEARING: `project init` -> PATCH project.json's gates -> `feature
// start` -> `state init`. The gate policy is PINNED PER FEATURE at `feature start` (PLAN-V3
// §Gates), so a preset declared AFTER start is itself policy drift and every RED/GREEN case
// would refuse for a reason it is not testing. Post-start mutation is available only through the
// explicitly named setGates(), used by the two cases that WANT drift.
//
// EVIDENCE VS FORGERY: seedPlan() imports through the real `plan check --import`, commit() makes
// real commits, and gate receipts are only ever earned by a real `gate run`. writeTasks() /
// writeFeature() / corrupt() / recordMr() write manifests by hand and exist ONLY for the
// adversarial cases that must forge what a caller could forge (a rev-4-shaped receipt, a corrupt
// dossier, the MR record `legion finalize` would have written — this suite never touches a
// remote). Each call site says why.
import { spawnSync } from 'node:child_process';
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';

applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // test/helpers/x -> repo root
const BIN = join(ROOT, 'bin', 'legion.mjs');
const HOOK = (name) => join(ROOT, 'hooks', `${name}.mjs`);
const NODE = process.execPath;

/** Fixed timestamp for every kernel call: deterministic manifests, so "nothing moved" can be
 * asserted by comparing manifest BYTES rather than by hand-picking fields. */
export const NOW = '2026-07-25T00:00:00.000Z';
export const NOW_ARGS = ['--now', NOW];
/** Commands that accept --now; legion() appends it for these so tests stay readable. */
const NOW_OK = new Set(['state', 'gate', 'plan', 'finalize', 'feature']);

/** A path segment carrying a space, a semicolon and an apostrophe. `pathHazards: true` nests the
 * whole sandbox inside it, which is how the launch-command case gets shell metacharacters into
 * the worktree path without touching the safeSegment'd org/project/feature ids. Opt-in: the
 * other cases must not pay this risk, and a suite-wide failure here would mask a real defect. */
const HAZARD_DIR = "we ird;dir'x";

/** RED/GREEN/NONE, the three gate outcomes the suite needs to be CERTAIN about (T11 spec A).
 * NONE is not declared here as `{}` and hoped for: fixture() asserts it equals what `project
 * init` actually scaffolded, so the preset cannot drift from the scaffold. */
export const GATE_PRESETS = {
  NONE: null, // "leave the scaffold alone, and check that it is still {}"
  RED: {
    commands: { test: { argv: [NODE, '-e', 'process.exit(1)'], timeoutMs: 30_000 } },
    task: ['test'],
    boundary: ['test'],
  },
  GREEN: {
    commands: { test: { argv: [NODE, '-e', 'process.exit(0)'], timeoutMs: 30_000 } },
    task: ['test'],
    boundary: ['test'],
  },
};

const ROOTS = new Set();
let sweepInstalled = false;
/** ONE sweep for every sandbox this process created. `exit` covers the ordinary paths — a clean
 * run, a thrown assertion, an uncaught error — and SIGINT/SIGTERM cover an interrupted run (a
 * killed runner used to leak one sandbox per fixture). SIGKILL cannot be handled and is stated
 * rather than papered over: after one, `rm -rf $TMPDIR/legion3-acceptance-*`. */
function installSweep() {
  if (sweepInstalled) return;
  sweepInstalled = true;
  const sweep = () => {
    for (const r of ROOTS) {
      try { rmSync(r, { recursive: true, force: true }); } catch { /* best-effort: exit path */ }
    }
    ROOTS.clear();
  };
  process.on('exit', sweep);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { sweep(); process.exit(1); }); // exit(1): interrupted, never "green"
  }
}

const readText = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const writeJson = (p, doc) => writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);

/** Build a whole sandbox: hermetic env, throwaway npm repo, registered project, started feature.
 * opts:
 *   gates       'NONE' | 'RED' | 'GREEN' | <gates object>   (applied BEFORE `feature start`)
 *   stateInit   run `legion state init` (default true; false leaves tasks.json ABSENT, which is
 *               an ordinary early stage and one of the four outcomes case 4 must distinguish)
 *   pathHazards nest the sandbox under HAZARD_DIR (default false)
 *   project/feature  identity segments (defaults fixproj / f1)
 */
export function fixture({
  gates = 'NONE',
  stateInit = true,
  pathHazards = false,
  project = 'fixproj',
  feature = 'f1',
} = {}) {
  installSweep();
  const sandbox = mkdtempSync(join(tmpdir(), 'legion3-acceptance-'));
  ROOTS.add(sandbox);
  const box = pathHazards ? join(sandbox, HAZARD_DIR) : sandbox;
  const home = join(box, 'home');
  const fakeHome = join(box, 'fakehome');
  const fakeBin = join(box, 'fakebin');
  const repoDir = join(box, 'repo');
  for (const d of [home, join(fakeHome, '.config'), fakeBin, join(repoDir, 'src'), join(repoDir, 'test')]) {
    mkdirSync(d, { recursive: true });
  }

  // Loud, non-succeeding shims: an accidental remote/agent call must be visible, never real.
  for (const name of ['glab', 'claude']) {
    const p = join(fakeBin, name);
    writeFileSync(p, `#!/bin/sh\necho "legion3 acceptance fixture: the real ${name} must never be invoked from this suite (hermetic: no network, no agents)" >&2\nexit 1\n`);
    chmodSync(p, 0o755);
  }

  const env = {
    ...process.env, // hardened at module scope; a from-scratch env would opt out of that
    LEGION_HOME: home,
    HOME: fakeHome,
    XDG_CONFIG_HOME: join(fakeHome, '.config'),
    PATH: fakeBin + delimiter + (process.env.PATH ?? ''),
  };
  assert.ok(isAbsolute(env.LEGION_HOME) && env.LEGION_HOME.length > 0,
    'LEGION_HOME must be an absolute sandbox path — a fixture must never risk the real ~/.legion');

  // --- the throwaway npm repo: a REAL test script, a source file, one commit, branch main ---
  writeJson(join(repoDir, 'package.json'), {
    name: project, private: true, version: '0.0.0', type: 'module', scripts: { test: 'node --test' },
  });
  writeFileSync(join(repoDir, 'src', 'index.mjs'), 'export const answer = 1;\n');
  writeFileSync(join(repoDir, 'test', 'smoke.test.mjs'),
    "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { answer } from '../src/index.mjs';\ntest('smoke', () => { assert.equal(answer, 1); });\n");

  const gitAt = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=legion test', ...args], {
      cwd, encoding: 'utf8', env,
    });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${cwd} failed (${r.status}): ${r.stderr}`);
    return r.stdout.trim();
  };
  gitAt(repoDir, 'init', '-b', 'main');
  gitAt(repoDir, 'add', '-A');
  gitAt(repoDir, 'commit', '-m', 'init');
  const repoRoot = realpathSync(repoDir);

  /** Run the REAL router. {code, stdout, stderr}; code -1 when the process could not spawn at
   * all (distinguishable from a kernel refusal, exactly as hooks/_common.mjs runKernel is). */
  const legionIn = (cwd, ...argv) => {
    const withNow = NOW_OK.has(argv[0]) && !argv.includes('--now') ? [...argv, ...NOW_ARGS] : argv;
    const r = spawnSync(NODE, [BIN, ...withNow], { cwd, encoding: 'utf8', env });
    if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message ?? r.error) };
    return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  };

  let r = legionIn(repoRoot, 'project', 'init', '--root', repoRoot);
  assert.equal(r.code, 0, `fixture: project init failed: ${r.stderr}`);
  const configPath = join(home, 'orgs', 'default', 'projects', project, 'project.json');

  /** Patch project.json's gates block. `spec` is a preset NAME, a gates OBJECT, or a FACTORY
   * called with the sandbox paths. The factory form exists because a gate command that PROVES it
   * ran (by writing a sentinel) needs a path inside the sandbox, and the caller does not know the
   * sandbox until fixture() returns — while the policy has to be in place BEFORE `feature start`
   * pins it. */
  const setGates = (spec) => {
    const resolved = typeof spec === 'function'
      ? spec({ sandbox, home, repoRoot })
      : (typeof spec === 'string' ? GATE_PRESETS[spec] : spec);
    assert.ok(resolved !== undefined, `fixture: unknown gate preset '${spec}'`);
    const g = resolved === null ? {} : resolved; // the NONE preset names the scaffold shape
    const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
    writeJson(configPath, { ...cfg, gates: g });
  };
  if (typeof gates === 'string' && GATE_PRESETS[gates] === null) {
    // The NONE preset IS the scaffold — assert that rather than re-declaring it.
    assert.deepEqual(JSON.parse(readFileSync(configPath, 'utf8')).gates, {},
      'fixture: `project init` no longer scaffolds `gates: {}` — the NONE preset must follow it');
  } else {
    setGates(gates); // BEFORE feature start: the policy is pinned there (header)
  }

  r = legionIn(repoRoot, 'feature', 'start', feature, '--base', 'main');
  assert.equal(r.code, 0, `fixture: feature start failed: ${r.stderr}`);
  const launchLine = (r.stdout.split('\n').find((l) => l.includes('claude ')) ?? '').trim();
  assert.ok(launchLine.length > 0, 'fixture: `feature start` printed no launch command');

  const dossier = join(home, 'orgs', 'default', 'projects', project, 'features', feature);
  const worktree = realpathSync(join(dirname(repoRoot), '.legion-worktrees', project, feature, 'checkout'));
  const featurePath = join(dossier, 'feature.json');
  const tasksPath = join(dossier, 'tasks.json');

  const legion = (...argv) => legionIn(worktree, ...argv);
  if (stateInit) {
    const s = legion('state', 'init');
    assert.equal(s.code, 0, `fixture: state init failed: ${s.stderr}`);
  }

  let commitSeq = 0;
  const handle = {
    sandbox, home, repoRoot, worktree, dossier, configPath, featurePath, tasksPath, env,
    project, feature, launchLine,

    legion,
    legionIn,
    head: () => gitAt(worktree, 'rev-parse', 'HEAD'),
    tree: () => gitAt(worktree, 'rev-parse', 'HEAD^{tree}'),

    /** Commit in the worktree, moving HEAD by appending a unique line to src/index.mjs. Returns the
     * new HEAD. (It took a `files` map and a null-deletes convention while the config-approval cases
     * existed; those were cut with case 11 and the plumbing went with them — a fixture that can
     * write arbitrary repo content invites tests to build state git never saw.) */
    commit(message = 'work') {
      const p = join(worktree, 'src', 'index.mjs');
      writeFileSync(p, `${readFileSync(p, 'utf8')}export const step${commitSeq++} = ${commitSeq};\n`);
      gitAt(worktree, 'add', '-A');
      gitAt(worktree, 'commit', '-m', message);
      return handle.head();
    },

    readFeature: () => JSON.parse(readFileSync(featurePath, 'utf8')),
    readTasks: () => JSON.parse(readFileSync(tasksPath, 'utf8')),
    setGates,

    /** A dossier file (intent.md, spec.md, plan.md …); returns its absolute path. */
    writeArtifact(name, body) {
      const p = join(dossier, name);
      writeFileSync(p, body);
      return p;
    },
    /** The architect's CANDIDATE plan only — no import. `plan check` must be free to reject it. */
    writePlanTasks(tasks, milestone = 'M1') {
      writeJson(join(dossier, 'plan.tasks.json'), { milestones: [{ id: milestone, title: 'the milestone', tasks }] });
    },
    /** Seed canonical tasks[] through the REAL import path, plan.md included. */
    seedPlan(tasks, { planMd = '# plan\n' } = {}) {
      handle.writeArtifact('plan.md', planMd);
      handle.writePlanTasks(tasks);
      const out = legion('plan', 'check', '--feature', feature, '--import');
      assert.equal(out.code, 0, `fixture: plan check --import failed: ${out.stderr}`);
      return out;
    },

    // --- deliberate hand-writes (forgeries), each used by exactly the case that needs one ---
    /** Hand-edit tasks.json. The ONLY way to forge a receipt: `plan check --import` whitelists
     * plan content and strips `receipt`, which is the point — so the adversarial case has to
     * write the manifest directly, exactly as the demonstrated R1 bypass did. */
    writeTasks(fn) {
      const doc = JSON.parse(readFileSync(tasksPath, 'utf8'));
      writeJson(tasksPath, fn(doc) ?? doc);
    },
    writeFeature(fn) {
      const doc = JSON.parse(readFileSync(featurePath, 'utf8'));
      writeJson(featurePath, fn(doc) ?? doc);
    },
    corrupt(which) {
      const p = which === 'feature' ? featurePath : tasksPath;
      writeFileSync(p, '{ this is not json\n');
      return p;
    },
    /** The record `legion finalize` would have written after reading an MR back from the server.
     * This suite never pushes and never runs glab, and `close delivered` reads nothing else about
     * the MR — same approach as test/cli/state.test.mjs's recordMr. */
    recordMr(headSha, iid = 7) {
      handle.writeFeature((f) => ({
        ...f,
        revision: f.revision + 1,
        mr: {
          iid,
          url: `https://gitlab.invalid/acme/x/-/merge_requests/${iid}`,
          targetBranch: f.baseBranch,
          headSha,
          at: NOW,
        },
      }));
    },

    /** Drive a hook exactly as Claude Code does: one JSON payload on stdin, nothing else. */
    fireHook(name, payload) {
      const r2 = spawnSync(NODE, [HOOK(name)], { input: JSON.stringify(payload), encoding: 'utf8', env });
      if (r2.error) return { code: -1, stdout: '', stderr: String(r2.error.message ?? r2.error) };
      return { code: r2.status ?? -1, stdout: r2.stdout ?? '', stderr: r2.stderr ?? '' };
    },

    /** Manifest BYTES, both manifests, for the "no state moved" assertion. Byte comparison is
     * the right question: a refused op must write NOTHING, and a revision bump with the visible
     * field unchanged is still state that moved. */
    snapshot: () => ({ feature: readText(featurePath), tasks: readText(tasksPath) }),
    assertUnmoved(snap, what) {
      const now = handle.snapshot();
      const rev = (text) => (text === null ? 'absent' : JSON.parse(text).revision);
      assert.equal(now.feature, snap.feature,
        `${what}: feature.json MOVED (revision ${rev(snap.feature)} -> ${rev(now.feature)})`);
      assert.equal(now.tasks, snap.tasks,
        `${what}: tasks.json MOVED (revision ${rev(snap.tasks)} -> ${rev(now.tasks)})`);
    },

    cleanup() {
      rmSync(sandbox, { recursive: true, force: true });
      ROOTS.delete(sandbox);
    },
  };
  return handle;
}

/** A canonical candidate-plan task row (`plan check` demands status pending + attempt 0). */
export const planTask = (id, extra = {}) => ({ id, title: `do ${id}`, status: 'pending', attempt: 0, ...extra });
