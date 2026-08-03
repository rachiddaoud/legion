// End-to-end guard for `legion state <op>` through the REAL bin, against real fixture git
// repos with LEGION_HOME pinned per scenario (the real ~/.legion is NEVER touched). Every
// scenario runs `project init` + `feature start` to produce a genuine worktree + dossier,
// then drives `legion state` from inside that worktree so the feature resolves from cwd.
//
// Coverage (per the spec's "full coverage" clause):
//  - happy path per op (init, stage-enter/complete, artifact-record, decision-record each
//    kind, task-start/done, task-answer, review-record, session-record,
//    escalate-profile, invalidate, close delivered + abandoned);
//  - every refusal path (init preconditions, stage-complete plan without critic / without
//    valid approval, decision-record with missing subject per kind, task-done receipt rules,
//    unknown ids, close preconditions incl. stale HEAD, already
//    closed, unknown schemaVersion, unknown op);
//
// RECEIPTS ARE EARNED HERE, NEVER TYPED (T12). There is no `receipt-record` op — `legion gate` is
// the only minter (PLAN-V3 §State; R1) — so every test below that needs a receipt runs a REAL
// `legion gate run`. scenario() already does `project init` + `feature start`, and `project init`
// scaffolds `gates: {}`, so such a run is TIER-0 ONLY: real, green, provenanced, and deliberately
// weak. That is exactly the right setup fixture for the state layer, which only ever CONSUMES a
// receipt.
//  - the invalidation cascade (spec edit kills plan+preview+pre-merge, intake survives;
//    preview-depends-on-plan);
//  - revision monotonicity (each writing op +1 on its OWN manifest; refused ops write
//    nothing);
//  - evidence never caller-supplied (recorded hash == independent sha256; receipt treeHash
//    == `git rev-parse HEAD^{tree}`; a bogus --subject-hash flag is ignored).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-state-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) => sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);

let n = 0;
/** Fresh sandbox: isolated LEGION_HOME + a one-commit fixture repo nested at base/repo,
 * a registered project, and a started feature `f1` with a real worktree + dossier. */
function scenario() {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fix-proj' }, null, 2) + '\n');
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  const env = { ...process.env, LEGION_HOME: home };
  let r = spawnSync(process.execPath, [BIN, 'project', 'init', '--root', repo], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(process.execPath, [BIN, 'feature', 'start', 'f1', '--base', 'main'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const dossier = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'features', 'f1');
  const worktree = realpathSync(join(base, '.legion-worktrees', 'fix-proj', 'f1', 'checkout'));
  return { home, repo: realpathSync(repo), base, dossier, worktree, env };
}

/** Run `legion state ...` from inside the feature worktree (feature resolves from cwd). */
const state = (s, ...args) =>
  spawnSync(process.execPath, [BIN, 'state', ...args], { cwd: s.worktree, encoding: 'utf8', env: s.env });

/** Run `legion gate ...` from inside the feature worktree. */
const gate = (s, ...args) =>
  spawnSync(process.execPath, [BIN, 'gate', ...args], { cwd: s.worktree, encoding: 'utf8', env: s.env });
/** EARN a receipt the only way there is: a real, green (tier-0-only) `legion gate run`. */
function gateOk(s, ...args) {
  const r = gate(s, 'run', ...args, NOW, '2026-07-24T00:00:00.000Z');
  assert.equal(r.status, 0, `legion gate run ${args.join(' ')}: ${r.stderr}`);
  return r;
}

const tasks = (s) => JSON.parse(readFileSync(join(s.dossier, 'tasks.json'), 'utf8'));
const feature = (s) => JSON.parse(readFileSync(join(s.dossier, 'feature.json'), 'utf8'));
const NOW = '--now';

/** init + write an artifact file in the dossier and record it; returns its absolute path. */
function writeArtifact(s, name, content) {
  const p = join(s.dossier, name);
  writeFileSync(p, content);
  return p;
}
/** Commit a change in the worktree so HEAD/tree advance. */
function commit(s, name, content) {
  writeFileSync(join(s.worktree, name), content);
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', `add ${name}`);
}
/** Hand-write the `mr` record `legion finalize` would have written. This suite never runs
 * finalize and never touches a remote; the record is the only thing close() reads. */
function recordMr(s, headSha, iid = 7) {
  const f = feature(s);
  writeFileSync(join(s.dossier, 'feature.json'), JSON.stringify({
    ...f,
    revision: f.revision + 1,
    mr: {
      iid,
      url: `https://gitlab.invalid/acme/x/-/merge_requests/${iid}`,
      targetBranch: f.baseBranch,
      headSha,
      at: '2026-07-24T00:00:00.000Z',
    },
  }, null, 2) + '\n');
}
/** Seed tasks.json.tasks[] directly (stands in for `legion plan check` import). */
function seedTasks(s, list) {
  const t = tasks(s);
  writeFileSync(join(s.dossier, 'tasks.json'), JSON.stringify({ ...t, tasks: list }, null, 2) + '\n');
}

const stateOk = (s, ...args) => {
  const r = state(s, ...args);
  assert.equal(r.status, 0, `legion state ${args.join(' ')}: ${r.stderr}`);
  return r;
};
const STAGES = ['intake', 'spec', 'plan', 'build', 'review', 'pre-merge', 'finalize'];

/** Walk the feature to `target` on REAL evidence (T13 — the state machine re-derives the whole
 * prefix, so an op can only be driven from a stage that permits it; mirrors the acceptance
 * suite's advanceTo). Default profile express: stage-complete review requires no recorded
 * reviews, so the walk stays minimal. Pass `profile: 'standard'` only for targets up to
 * 'review' — the want>=5 leg completes stage review, which on standard demands recorded reviews
 * this walk does not mint. Every stage BEFORE `target` is satisfied and completed; the feature
 * STANDS IN `target` with the target's own evidence deliberately not recorded. tasks[] is
 * whatever the caller seeded — an EMPTY list satisfies the build row vacuously. */
function advance(s, target, profile = 'express') {
  const want = STAGES.indexOf(target);
  assert.notEqual(want, -1, `advance: '${target}' is not a stage`);
  if (want >= 1) {
    writeArtifact(s, 'intent.md', '# intent\n');
    stateOk(s, 'artifact-record', 'intent', 'intent.md');
    stateOk(s, 'decision-record', 'intake');
    stateOk(s, 'escalate-profile', profile);
    stateOk(s, 'stage-complete', 'intake');
    stateOk(s, 'stage-enter', 'spec');
  }
  if (want >= 2) {
    writeArtifact(s, 'spec.md', '# spec\n');
    stateOk(s, 'artifact-record', 'spec', 'spec.md');
    stateOk(s, 'decision-record', 'spec');
    stateOk(s, 'stage-complete', 'spec');
    stateOk(s, 'stage-enter', 'plan');
  }
  if (want >= 3) {
    writeArtifact(s, 'plan.md', '# plan (walk)\n');
    stateOk(s, 'artifact-record', 'plan', 'plan.md');
    stateOk(s, 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan');
    stateOk(s, 'decision-record', 'plan');
    stateOk(s, 'stage-complete', 'plan');
    stateOk(s, 'stage-enter', 'build');
  }
  if (want >= 4) {
    stateOk(s, 'stage-complete', 'build');
    stateOk(s, 'stage-enter', 'review');
  }
  if (want >= 5) {
    stateOk(s, 'stage-complete', 'review');
    stateOk(s, 'stage-enter', 'pre-merge');
  }
  if (want >= 6) {
    gateOk(s, '--boundary');
    stateOk(s, 'decision-record', 'pre-merge');
    stateOk(s, 'stage-complete', 'pre-merge');
    stateOk(s, 'stage-enter', 'finalize');
  }
  assert.equal(feature(s).stage, target, `advance: expected to stand in ${target}`);
}

// --- init ---------------------------------------------------------------------------------

test('init creates the tasks.json skeleton next to feature.json', () => {
  const s = scenario();
  const r = state(s, 'init', NOW, '2026-07-24T00:00:00.000Z');
  assert.equal(r.status, 0, r.stderr);
  const t = tasks(s);
  assert.equal(t.schemaVersion, 1);
  assert.equal(t.legionVersion, JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version);
  assert.equal(t.revision, 0);
  assert.equal(t.featureId, 'default/fix-proj/f1');
  assert.deepEqual(t.tasks, []);
  assert.deepEqual(t.artifacts, {});
  assert.deepEqual(t.approvals, {});
  assert.deepEqual(t.reviews, []);
  assert.deepEqual(t.receipts, { boundary: null });
  assert.equal(t.createdAt, '2026-07-24T00:00:00.000Z');
});

test('init refuses when tasks.json already exists', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  const r = state(s, 'init');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /tasks\.json already exists/);
});

test('init refuses when feature.json is missing (dossier without a feature)', () => {
  const s = scenario();
  rmSync(join(s.dossier, 'feature.json'));
  const r = state(s, 'init');
  // feature.json gone ⇒ cwd resolves (worktree still registered) but init refuses
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no feature\.json/);
});

// --- stage-enter / stage-complete ---------------------------------------------------------

test('stage-enter: forward needs the prefix to re-derive; backward is free; both append stageHistory', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  // Forward entry from an unsatisfied intake refuses, naming the stage that does not re-derive.
  let r = state(s, 'stage-enter', 'spec');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stage 'intake' does not re-derive satisfied/);
  assert.equal(feature(s).stage, 'intake');
  // A forward JUMP refuses naming the expected next stage — one hop at a time.
  r = state(s, 'stage-enter', 'plan');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /the next stage is 'spec'/);
  // With intake genuinely satisfied the hop lands and appends to the audit trail.
  advance(s, 'spec');
  const f = feature(s);
  assert.equal(f.stage, 'spec');
  assert.equal(f.stageHistory.at(-1).stage, 'spec');
  // Backward is always allowed, recorded, and clears nothing — the forward hop re-derives true.
  assert.equal(state(s, 'stage-enter', 'intake').status, 0);
  assert.equal(feature(s).stage, 'intake');
  assert.equal(feature(s).stageHistory.at(-1).stage, 'intake');
  assert.equal(state(s, 'stage-enter', 'spec').status, 0, 'unchanged evidence: the round trip costs nothing');
  const rx = state(s, 'stage-enter', 'bogus');
  assert.equal(rx.status, 1);
  assert.match(rx.stderr, /invalid stage 'bogus'/);
});

test('stage-complete requires the stage to be current AND its table row satisfied, and appends completedStages', () => {
  const s = scenario(); // starts at intake
  assert.equal(state(s, 'init').status, 0);
  const rWrong = state(s, 'stage-complete', 'spec');
  assert.equal(rWrong.status, 1);
  assert.match(rWrong.stderr, /current stage is 'intake'/);
  // The rev-5 intake row: intent artifact + hash-valid approval + a classified profile.
  const rBare = state(s, 'stage-complete', 'intake');
  assert.equal(rBare.status, 1);
  assert.match(rBare.stderr, /intent artifact/);
  writeArtifact(s, 'intent.md', 'i\n');
  assert.equal(state(s, 'artifact-record', 'intent', 'intent.md').status, 0);
  assert.equal(state(s, 'decision-record', 'intake').status, 0);
  const rUnclassified = state(s, 'stage-complete', 'intake');
  assert.equal(rUnclassified.status, 1);
  assert.match(rUnclassified.stderr, /profile is 'unclassified'/);
  assert.equal(state(s, 'escalate-profile', 'express').status, 0);
  const r = state(s, 'stage-complete', 'intake');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(feature(s).completedStages.at(-1).stage, 'intake');
});

test('stage-complete plan needs BOTH a plan-critic pass AND a hash-valid plan approval (standard — express excuses only the ABSENT critic)', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  advance(s, 'plan', 'standard'); // T13: standing in plan requires intake+spec to re-derive satisfied
  seedTasks(s, [{ id: 'T1' }]);
  const planPath = writeArtifact(s, 'plan.md', '# the plan\n');
  assert.equal(state(s, 'artifact-record', 'plan', planPath).status, 0);

  // no critic review yet, no approval yet
  let r = state(s, 'stage-complete', 'plan');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /plan-critic review/);

  // add a critic review but still no approval
  assert.equal(state(s, 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan').status, 0);
  r = state(s, 'stage-complete', 'plan');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hash-valid plan approval/);

  // approve the plan (subject recomputed now) — completion succeeds
  assert.equal(state(s, 'decision-record', 'plan').status, 0);
  r = state(s, 'stage-complete', 'plan');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(feature(s).completedStages.at(-1).stage, 'plan');
});

// A feature RE-ENTERS the plan stage whenever work is appended (the pre-merge fixup path), so
// the critic check is asked a second time as a matter of course. `reviews.some(pass)` matched
// any pass ever recorded, which meant round one permanently pre-satisfied it — a recorded FAIL
// still completed the stage. Nothing else anchors the critic to the current plan: unlike the
// pre-merge subject, the plan subject does not hash `reviews`.
// THE EXPRESS WALK IS LOAD-BEARING HERE (c11): express excuses only the ABSENCE of a critic
// verdict — this case doubles as the pin that a recorded LATEST fail blocks even on the profile
// that excuses absence. Do not rewalk it on standard.
test('stage-complete plan reads the LATEST plan-critic verdict, not any historic pass', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  advance(s, 'plan');
  seedTasks(s, [{ id: 'T1' }]);
  const planPath = writeArtifact(s, 'plan.md', '# v1\n');
  assert.equal(state(s, 'artifact-record', 'plan', planPath).status, 0);
  assert.equal(state(s, 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan').status, 0);
  assert.equal(state(s, 'decision-record', 'plan').status, 0);
  assert.equal(state(s, 'stage-complete', 'plan').status, 0, 'round one completes');

  // Round two: the plan changed and this time the critic REJECTED it.
  writeFileSync(planPath, '# v2, with the appended work\n');
  assert.equal(state(s, 'artifact-record', 'plan', planPath).status, 0, 'cascade drops the approval');
  assert.equal(state(s, 'review-record', '--role', 'plan-critic', '--verdict', 'fail', '--subject', 'plan').status, 0);
  assert.equal(state(s, 'decision-record', 'plan').status, 0, 're-approved over the new bytes');
  const r = state(s, 'stage-complete', 'plan');
  assert.equal(r.status, 1, 'a failing critic must block the stage even though an older pass exists');
  assert.match(r.stderr, /LATEST plan-critic/);

  // And the documented rejection loop still closes: revise, re-review, complete.
  assert.equal(state(s, 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan').status, 0);
  assert.equal(state(s, 'stage-complete', 'plan').status, 0, 'a fresh pass completes the stage');
});

test('stage-complete plan refuses when plan.md is edited after approval (hash drift)', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  advance(s, 'plan');
  seedTasks(s, [{ id: 'T1' }]);
  const planPath = writeArtifact(s, 'plan.md', '# v1\n');
  assert.equal(state(s, 'artifact-record', 'plan', planPath).status, 0);
  assert.equal(state(s, 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan').status, 0);
  assert.equal(state(s, 'decision-record', 'plan').status, 0);
  // edit plan.md on disk WITHOUT re-recording the artifact — approval subject drifts
  writeFileSync(planPath, '# v2 tampered\n');
  const r = state(s, 'stage-complete', 'plan');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hash-valid plan approval/);
});

// c11 (operator 2026-07-30): the express profile drops the MANDATORY critic. The standard half
// of the rule — no critic recorded refuses — is the first assertion of the BOTH test above.
test('express: stage-complete plan is satisfied with NO plan-critic verdict at all', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  advance(s, 'plan'); // express
  seedTasks(s, [{ id: 'T1' }]);
  const planPath = writeArtifact(s, 'plan.md', '# the plan\n');
  assert.equal(state(s, 'artifact-record', 'plan', planPath).status, 0);
  assert.equal(state(s, 'decision-record', 'plan').status, 0);
  const r = state(s, 'stage-complete', 'plan');
  assert.equal(r.status, 0, `express owes no critic verdict: ${r.stderr}`);
  assert.equal(feature(s).completedStages.at(-1).stage, 'plan');
});

// The third leg of the express rule: a STALE pass (recorded against an earlier plan, binding no
// longer holding) reads as ABSENCE on express — not required, so not checked — while on standard
// the same dead verdict refuses. A LATEST fail blocking on express is pinned by the LATEST test
// above; this pins the pass side of the asymmetry.
test('express: a STALE critic pass reads as absence (excused); on standard it is a dead verdict', () => {
  const walk = (profile) => {
    const s = scenario();
    assert.equal(state(s, 'init').status, 0);
    advance(s, 'plan', profile);
    seedTasks(s, [{ id: 'T1' }]);
    const planPath = writeArtifact(s, 'plan.md', '# v1\n');
    assert.equal(state(s, 'artifact-record', 'plan', planPath).status, 0);
    assert.equal(state(s, 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan').status, 0);
    // The plan moves AFTER the pass: re-record + re-approve, so the approval is hash-valid over
    // the new bytes while the critic pass still hashes the old subject.
    writeFileSync(planPath, '# v2, revised after the pass\n');
    assert.equal(state(s, 'artifact-record', 'plan', planPath).status, 0, 'cascade drops the approval');
    assert.equal(state(s, 'decision-record', 'plan').status, 0, 're-approved over the new bytes');
    return state(s, 'stage-complete', 'plan');
  };
  const express = walk('express');
  assert.equal(express.status, 0, `a stale pass is excused on express: ${express.stderr}`);
  const standard = walk('standard');
  assert.equal(standard.status, 1, 'the same dead verdict refuses on standard');
  assert.match(standard.stderr, /judged a DIFFERENT plan/);
});

// --- artifact-record ----------------------------------------------------------------------

test('artifact-record realpaths the file, stores {path,hash,at} with an independent sha256', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  const body = 'the intent\n';
  const p = writeArtifact(s, 'intent.md', body);
  const r = state(s, 'artifact-record', 'intent', 'intent.md', NOW, '2026-07-24T00:00:00.000Z');
  assert.equal(r.status, 0, r.stderr);
  const rec = tasks(s).artifacts.intent;
  assert.equal(rec.path, realpathSync(p)); // stored as the realpath'd absolute path
  assert.equal(rec.hash, createHash('sha256').update(body).digest('hex'));
  assert.equal(rec.at, '2026-07-24T00:00:00.000Z');
});

test('artifact-record refuses an invalid kind and a missing file', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  const rk = state(s, 'artifact-record', 'bogus', 'x.md');
  assert.equal(rk.status, 1);
  assert.match(rk.stderr, /invalid artifact kind/);
  const rf = state(s, 'artifact-record', 'intent', 'does-not-exist.md');
  assert.equal(rf.status, 1);
  assert.match(rf.stderr, /does not exist/);
});

// --- decision-record ----------------------------------------------------------------------

test('decision-record intake/spec/preview hash the artifact bytes; missing subject refuses', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  for (const [kind, artifactKind, file] of [['intake', 'intent', 'intent.md'], ['spec', 'spec', 'spec.md'], ['preview', 'preview', 'preview.png']]) {
    // missing subject first
    const rMissing = state(s, 'decision-record', kind);
    assert.equal(rMissing.status, 1, `${kind} should refuse without its artifact`);
    assert.match(rMissing.stderr, new RegExp(`no ${artifactKind} artifact`));
    // record artifact, then decide
    const body = `${kind} body\n`;
    writeArtifact(s, file, body);
    assert.equal(state(s, 'artifact-record', artifactKind, file).status, 0);
    const r = state(s, 'decision-record', kind);
    assert.equal(r.status, 0, r.stderr);
    const appr = tasks(s).approvals[kind];
    assert.equal(appr.kind, kind);
    assert.equal(appr.subjectHash, createHash('sha256').update(body).digest('hex'));
  }
});

test('decision-record plan hashes plan.md combined with the CONTENT PROJECTION of the task list', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }, { id: 'T2' }]);
  const planBody = '# plan\n';
  writeArtifact(s, 'plan.md', planBody);
  assert.equal(state(s, 'artifact-record', 'plan', 'plan.md').status, 0);
  const r = state(s, 'decision-record', 'plan');
  assert.equal(r.status, 0, r.stderr);
  // The T13 plan subject, recomputed INDEPENDENTLY: plan.md bytes + planContent's six-field
  // projection per row (kernel/state.mjs header APPROVALS — progress fields are OUTSIDE it, or
  // task-start would invalidate the approval and strand the feature; acceptance case 10c).
  const projected = (x) => JSON.stringify({
    id: x.id, title: x.title, depends_on: x.depends_on ?? [], milestone: x.milestone ?? null,
    validate: x.validate ?? null, notes: x.notes ?? null,
  });
  const ph = createHash('sha256').update(planBody).digest('hex');
  const th = createHash('sha256').update(JSON.stringify([{ id: 'T1' }, { id: 'T2' }].map(projected))).digest('hex');
  const expected = createHash('sha256').update(`${ph}:${th}`).digest('hex');
  assert.equal(tasks(s).approvals.plan.subjectHash, expected);
});

test('decision-record pre-merge needs a boundary receipt and binds HEAD+boundary+reviews', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  // no boundary receipt yet
  let r = state(s, 'decision-record', 'pre-merge');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /boundary receipt/);
  // earn a boundary receipt, add a review, then approve
  gateOk(s, '--boundary');
  assert.equal(state(s, 'review-record', '--role', 'reviewer', '--verdict', 'pass', '--subject', 'feature').status, 0);
  r = state(s, 'decision-record', 'pre-merge');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(tasks(s).approvals['pre-merge'].subjectHash);
});

// --- task-start / task-done ---------------------------------------------------------------

test('task-start/task-done happy path requires a matching receipt', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  assert.equal(state(s, 'task-start', 'T1').status, 0);
  assert.equal(tasks(s).tasks[0].status, 'started');
  // commit the work, earn a task receipt for the current tree, then done
  commit(s, 'impl.txt', 'code\n');
  gateOk(s, '--task', 'T1');
  const tree = sh(s.worktree, 'rev-parse', 'HEAD^{tree}');
  assert.equal(tasks(s).tasks[0].receipt.treeHash, tree, 'kernel derives the tree itself');
  const r = state(s, 'task-done', 'T1');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(tasks(s).tasks[0].status, 'done');
});

test('task-start/task-done refuse unknown ids; task-done refuses without or with a stale receipt', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  assert.equal(state(s, 'task-start', 'TX').status, 1);
  assert.match(state(s, 'task-start', 'TX').stderr, /unknown task 'TX'/);
  assert.equal(state(s, 'task-done', 'TX').status, 1);

  assert.equal(state(s, 'task-start', 'T1').status, 0);
  // no receipt
  let r = state(s, 'task-done', 'T1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /has no receipt/);
  // receipt for the current tree, then a NEW commit makes it stale
  commit(s, 'a.txt', '1\n');
  gateOk(s, '--task', 'T1');
  commit(s, 'b.txt', '2\n'); // tree moves past the receipt
  r = state(s, 'task-done', 'T1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /!= current HEAD tree/);
});

test('task-done refuses a task that is not started', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  const r = state(s, 'task-done', 'T1');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not started/);
});

// --- task-answer --------------------------------------------------------------------------
// Wiring only (value-flag parsing in both `--flag value` and `--flag=value` forms, dispatch
// reachability, non-zero exit on refusal); the behavioural matrix lives in the git-free
// test/kernel/state.test.mjs. seedTasks writes tasks.json directly (bypassing bumpWrite), so
// revision arithmetic is NOT asserted across a seed here.

test('task-answer records {question,answer,at} verbatim and fails closed through the bin', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1', status: 'started' }]);
  const r = state(s, 'task-answer', 'T1', '--question', 'use pg or sqlite?', '--answer=pg — "chosen"',
    NOW, '2026-07-24T00:00:00.000Z');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tasks(s).tasks[0].answers, [
    { question: 'use pg or sqlite?', answer: 'pg — "chosen"', at: '2026-07-24T00:00:00.000Z' },
  ]);
  assert.equal(tasks(s).tasks[0].status, 'started'); // status is the build-loop's, not ours
  const unknown = state(s, 'task-answer', 'TX', '--question', 'q', '--answer', 'a');
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown task 'TX'/);
  const noQ = state(s, 'task-answer', 'T1', '--answer', 'a');
  assert.equal(noQ.status, 1);
  assert.match(noQ.stderr, /requires --question/);
  seedTasks(s, [{ id: 'T1', status: 'done' }]);
  const doneT = state(s, 'task-answer', 'T1', '--question', 'q', '--answer', 'a');
  assert.equal(doneT.status, 1);
  assert.match(doneT.stderr, /already done/);
});

test('task-answer stores --leading question/answer text via the inline --flag=value form', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1', status: 'started' }]);
  // The content legitimately starts with `--`; only the inline form can carry it, and the
  // two-token form must still refuse loudly rather than swallow the next flag as a value.
  const r = state(s, 'task-answer', 'T1', '--question=--force ok?', '--answer=--no-verify is fine here',
    NOW, '2026-07-24T00:00:00.000Z');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(tasks(s).tasks[0].answers, [
    { question: '--force ok?', answer: '--no-verify is fine here', at: '2026-07-24T00:00:00.000Z' },
  ]);
  const split = state(s, 'task-answer', 'T1', '--question', 'q', '--answer', '--no-verify');
  assert.equal(split.status, 1);
  assert.match(split.stderr, /missing value for --answer/);
});

// --- review-record ------------------------------------------------------------------------

test('review-record appends {role,verdict,subject,subjectHash,at}; validates verdict, subject shape AND subject existence', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1', milestone: 'M1' }]);
  assert.equal(state(s, 'review-record', '--role', 'skeptic', '--verdict', 'pass', '--subject', 'task:T1').status, 0);
  const rec = tasks(s).reviews.at(-1);
  assert.deepEqual({ role: rec.role, verdict: rec.verdict, subject: rec.subject }, { role: 'skeptic', verdict: 'pass', subject: 'task:T1' });
  // T14: the subjectHash is DERIVED BY KIND — a task review binds the worktree TREE, and the
  // kernel derived it itself (there is no --subject-hash flag to supply one).
  assert.equal(rec.subjectHash, sh(s.worktree, 'rev-parse', 'HEAD^{tree}'));
  assert.match(state(s, 'review-record', '--role', 'r', '--verdict', 'maybe', '--subject', 'feature').stderr, /verdict must be pass\|fail/);
  assert.match(state(s, 'review-record', '--role', 'r', '--verdict', 'pass', '--subject', 'nonsense').stderr, /subject must be/);
  // T14: a syntactically valid subject naming NOTHING is a caller assertion, refused.
  const ghostTask = state(s, 'review-record', '--role', 'r', '--verdict', 'pass', '--subject', 'task:TX');
  assert.equal(ghostTask.status, 1);
  assert.match(ghostTask.stderr, /unknown task 'TX'/);
  const ghostMs = state(s, 'review-record', '--role', 'r', '--verdict', 'pass', '--subject', 'milestone:MX');
  assert.equal(ghostMs.status, 1);
  assert.match(ghostMs.stderr, /unknown milestone 'MX'/);
  // …while a real milestone (a task belongs to it) records, milestone reviews binding the tree.
  const ms = state(s, 'review-record', '--role', 'r', '--verdict', 'pass', '--subject', 'milestone:M1');
  assert.equal(ms.status, 0, ms.stderr);
  assert.equal(tasks(s).reviews.at(-1).subjectHash, sh(s.worktree, 'rev-parse', 'HEAD^{tree}'));
  // …and a PLAN review binds the PLAN subject, not the tree (corollary 2 "too narrow": plan.md
  // and tasks.json live in the dossier and change without the tree moving).
  writeArtifact(s, 'plan.md', '# plan\n');
  assert.equal(state(s, 'artifact-record', 'plan', 'plan.md').status, 0);
  const pr = state(s, 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan');
  assert.equal(pr.status, 0, pr.stderr);
  const planRec = tasks(s).reviews.at(-1);
  assert.notEqual(planRec.subjectHash, sh(s.worktree, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(planRec.subjectHash.length, 64);
});

// --- receipts: earned, never typed (T12) ---------------------------------------------------
// The `receipt-record` op is GONE (PLAN-V3 §State; R1), so the three halves of the old test here
// are re-expressed rather than deleted: (1) the neither/both FLAG test died with the op, and its
// place is taken by the assertion that the op is not dispatchable at all; (2) the DERIVE-HEAD/tree
// half is asserted against `legion gate run`, the only minter; (3) the recorded SHAPE assertion
// moves from the rev-4 `{treeHash, commit}` to the rev-5 provenance shape `{tier,
// commandPolicyHash, results, declaredCommands, head, treeHash, at}`. The kernel writer's own
// dirty-worktree guard is no longer reachable through any op, so it is covered directly on
// recordGateReceipt in test/kernel/state.test.mjs instead of being dropped.

test('there is NO receipt-record op: it is neither advertised nor dispatchable', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  const usage = state(s);
  assert.equal(usage.status, 1, 'a bare `legion state` must fail closed');
  assert.doesNotMatch(usage.stderr, /receipt-record/, 'it must not be advertised anywhere');
  const rev = tasks(s).revision;
  for (const argv of [['receipt-record'], ['receipt-record', '--task', 'T1']]) {
    const r = state(s, ...argv);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /unknown state op 'receipt-record'/);
  }
  assert.equal(tasks(s).revision, rev, 'a refused dispatch writes nothing');
  assert.equal(tasks(s).tasks[0].receipt, undefined);
});

test('`gate run` derives HEAD/tree itself and records the full provenance shape', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  const head = sh(s.worktree, 'rev-parse', 'HEAD');
  const tree = sh(s.worktree, 'rev-parse', 'HEAD^{tree}');
  const pinned = feature(s).commandPolicyHash;

  gateOk(s, '--boundary');
  const b = tasks(s).receipts.boundary;
  assert.deepEqual({ head: b.head, treeHash: b.treeHash }, { head, treeHash: tree },
    'the kernel derives both itself — no flag supplies either');
  assert.deepEqual(Object.keys(b),
    ['tier', 'commandPolicyHash', 'results', 'declaredCommands', 'head', 'treeHash', 'at'],
    'the rev-5 receipt shape (rev-4 was {head, treeHash, at} and proved nothing)');
  assert.equal(b.tier, 'boundary');
  assert.equal(b.commandPolicyHash, pinned.boundary, 'stamped with the policy it ran under');
  assert.equal(b.declaredCommands, 0, 'this fixture declares none — tier-0 only, real but weak');
  assert.deepEqual(b.results, []);
  assert.equal(b.at, '2026-07-24T00:00:00.000Z');

  gateOk(s, '--task', 'T1');
  const t = tasks(s).tasks[0].receipt;
  assert.deepEqual({ treeHash: t.treeHash, head: t.head }, { treeHash: tree, head },
    'a task receipt carries `head`, not rev-4\'s `commit`');
  assert.equal(t.tier, 'task');
  assert.equal(t.commandPolicyHash, pinned.task);
});

// --- session-record / escalate-profile ----------------------------------------------------

test('session-record appends to sessionHistory and sets currentSession', () => {
  const s = scenario();
  const r = state(s, 'session-record', '--session-id', 'sess-abc');
  assert.equal(r.status, 0, r.stderr);
  const f = feature(s);
  assert.equal(f.sessionHistory.at(-1).sessionId, 'sess-abc');
  assert.equal(f.currentSession, 'sess-abc');
  assert.match(state(s, 'session-record').stderr, /requires --session-id/);
});

test('escalate-profile is monotonic: raising and re-set land, lowering refuses naming both profiles', () => {
  const s = scenario();
  // First set from unclassified, and the validation refusal, as before (c11 kept both).
  assert.equal(state(s, 'escalate-profile', 'standard').status, 0);
  assert.equal(feature(s).profile, 'standard');
  assert.match(state(s, 'escalate-profile', 'ultra').stderr, /invalid profile/);
  // Same-profile re-set is IDEMPOTENT: a re-entrant session re-runs its classification step and
  // must not fail a walk that changed nothing.
  assert.equal(state(s, 'escalate-profile', 'standard').status, 0);
  // Lowering refuses, naming both profiles: review owed under the classification cannot be
  // un-owed by reclassifying.
  const lower = state(s, 'escalate-profile', 'express');
  assert.equal(lower.status, 1);
  assert.match(lower.stderr, /monotonic/);
  assert.match(lower.stderr, /'standard'/);
  assert.match(lower.stderr, /'express'/);
  assert.equal(feature(s).profile, 'standard', 'a refused lowering writes nothing');
  // Raising still works, then both lowerings from full refuse.
  assert.equal(state(s, 'escalate-profile', 'full').status, 0);
  assert.equal(state(s, 'escalate-profile', 'standard').status, 1);
  assert.equal(state(s, 'escalate-profile', 'express').status, 1);
  assert.equal(feature(s).profile, 'full');
  // unclassified -> the top rank in one step is a first-set, not a raise-chain requirement.
  const s2 = scenario();
  assert.equal(state(s2, 'escalate-profile', 'full').status, 0);
  assert.equal(feature(s2).profile, 'full');
});

// --- invalidation cascade -----------------------------------------------------------------

test('cascade: re-recording the spec artifact kills spec+plan+preview+pre-merge, intake survives', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  // record + approve intake, spec, plan; add preview + pre-merge approvals too
  writeArtifact(s, 'intent.md', 'intent\n');
  writeArtifact(s, 'spec.md', 'spec v1\n');
  writeArtifact(s, 'plan.md', 'plan\n');
  writeArtifact(s, 'preview.png', 'img\n');
  assert.equal(state(s, 'artifact-record', 'intent', 'intent.md').status, 0);
  assert.equal(state(s, 'artifact-record', 'spec', 'spec.md').status, 0);
  assert.equal(state(s, 'artifact-record', 'plan', 'plan.md').status, 0);
  assert.equal(state(s, 'artifact-record', 'preview', 'preview.png').status, 0);
  assert.equal(state(s, 'decision-record', 'intake').status, 0);
  assert.equal(state(s, 'decision-record', 'spec').status, 0);
  assert.equal(state(s, 'decision-record', 'plan').status, 0);
  assert.equal(state(s, 'decision-record', 'preview').status, 0);
  gateOk(s, '--boundary');
  assert.equal(state(s, 'decision-record', 'pre-merge').status, 0);
  assert.deepEqual(Object.keys(tasks(s).approvals).sort(), ['intake', 'plan', 'pre-merge', 'preview', 'spec']);

  // edit the spec file and re-record it — deterministic cascade
  writeFileSync(join(s.dossier, 'spec.md'), 'spec v2\n');
  assert.equal(state(s, 'artifact-record', 'spec', 'spec.md').status, 0);
  assert.deepEqual(Object.keys(tasks(s).approvals), ['intake'], 'only intake survives a spec change');
});

test('cascade: preview depends on plan — re-recording plan kills preview+pre-merge, keeps intake+spec', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  writeArtifact(s, 'intent.md', 'intent\n');
  writeArtifact(s, 'spec.md', 'spec\n');
  writeArtifact(s, 'plan.md', 'plan v1\n');
  writeArtifact(s, 'preview.png', 'img\n');
  for (const [ak, f] of [['intent', 'intent.md'], ['spec', 'spec.md'], ['plan', 'plan.md'], ['preview', 'preview.png']]) {
    assert.equal(state(s, 'artifact-record', ak, f).status, 0);
  }
  for (const dk of ['intake', 'spec', 'plan', 'preview']) assert.equal(state(s, 'decision-record', dk).status, 0);
  gateOk(s, '--boundary');
  assert.equal(state(s, 'decision-record', 'pre-merge').status, 0);

  writeFileSync(join(s.dossier, 'plan.md'), 'plan v2\n');
  assert.equal(state(s, 'artifact-record', 'plan', 'plan.md').status, 0);
  assert.deepEqual(Object.keys(tasks(s).approvals).sort(), ['intake', 'spec']);
});

test('cascade: re-recording an UNCHANGED artifact keeps its approval + all dependents (codex P2)', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  writeArtifact(s, 'intent.md', 'intent\n');
  writeArtifact(s, 'spec.md', 'spec\n');
  assert.equal(state(s, 'artifact-record', 'intent', 'intent.md').status, 0);
  assert.equal(state(s, 'artifact-record', 'spec', 'spec.md').status, 0);
  assert.equal(state(s, 'decision-record', 'intake').status, 0);
  assert.equal(state(s, 'decision-record', 'spec').status, 0);
  const before = tasks(s).approvals;
  assert.deepEqual(Object.keys(before).sort(), ['intake', 'spec']);
  // Re-record the SAME spec bytes at the SAME path — subject unchanged, approvals must survive.
  assert.equal(state(s, 'artifact-record', 'spec', 'spec.md').status, 0);
  assert.deepEqual(tasks(s).approvals, before, 'identical re-record must not drop approvals');
});

test('cascade: changing the preview keeps the pre-merge approval — siblings off plan (codex P2)', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  writeArtifact(s, 'intent.md', 'intent\n');
  writeArtifact(s, 'spec.md', 'spec\n');
  writeArtifact(s, 'plan.md', 'plan\n');
  writeArtifact(s, 'preview.png', 'img v1\n');
  for (const [ak, f] of [['intent', 'intent.md'], ['spec', 'spec.md'], ['plan', 'plan.md'], ['preview', 'preview.png']]) {
    assert.equal(state(s, 'artifact-record', ak, f).status, 0);
  }
  for (const dk of ['intake', 'spec', 'plan', 'preview']) assert.equal(state(s, 'decision-record', dk).status, 0);
  gateOk(s, '--boundary');
  assert.equal(state(s, 'decision-record', 'pre-merge').status, 0);
  assert.deepEqual(Object.keys(tasks(s).approvals).sort(), ['intake', 'plan', 'pre-merge', 'preview', 'spec']);

  // Edit + re-record ONLY the preview: it drops the preview approval but NOT its sibling pre-merge.
  writeFileSync(join(s.dossier, 'preview.png'), 'img v2\n');
  assert.equal(state(s, 'artifact-record', 'preview', 'preview.png').status, 0);
  assert.deepEqual(Object.keys(tasks(s).approvals).sort(), ['intake', 'plan', 'pre-merge', 'spec'],
    'preview change must not invalidate pre-merge');
});

test('invalidate <kind> is the caller-triggered cascade', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  writeArtifact(s, 'intent.md', 'i\n');
  writeArtifact(s, 'spec.md', 's\n');
  assert.equal(state(s, 'artifact-record', 'intent', 'intent.md').status, 0);
  assert.equal(state(s, 'artifact-record', 'spec', 'spec.md').status, 0);
  assert.equal(state(s, 'decision-record', 'intake').status, 0);
  assert.equal(state(s, 'decision-record', 'spec').status, 0);
  assert.equal(state(s, 'invalidate', 'spec').status, 0);
  assert.deepEqual(Object.keys(tasks(s).approvals), ['intake']);
  assert.match(state(s, 'invalidate', 'bogus').stderr, /invalid approval kind/);
});

// --- close --------------------------------------------------------------------------------

test('close delivered requires the finalize stage, boundary-for-current-HEAD, a hash-valid pre-merge approval AND a verified MR', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  // Outside the finalize stage nothing else is even read (T13/E2 — the stage clause is first).
  let r = state(s, 'close', 'delivered');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires the current stage to be 'finalize'/);
  // Stand in finalize FOR REAL: the walk necessarily earns the boundary receipt and the
  // pre-merge approval (the pre-merge subject requires the receipt), so the chain's earlier
  // refusals are reachable only when evidence VANISHES afterwards — a dossier is a plain file,
  // and that hand-removal is exactly the adversarial state the chain is depth against.
  advance(s, 'finalize');
  const intact = tasks(s);
  writeFileSync(join(s.dossier, 'tasks.json'),
    JSON.stringify({ ...intact, receipts: { ...intact.receipts, boundary: null } }, null, 2) + '\n');
  r = state(s, 'close', 'delivered');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /requires a boundary receipt/);
  const { 'pre-merge': _gone, ...approvalsWithout } = intact.approvals;
  writeFileSync(join(s.dossier, 'tasks.json'),
    JSON.stringify({ ...intact, approvals: approvalsWithout }, null, 2) + '\n');
  r = state(s, 'close', 'delivered');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hash-valid pre-merge approval/);
  // Manifest restored: the one missing link is the MR — PLAN-V3 §State's third condition.
  writeFileSync(join(s.dossier, 'tasks.json'), JSON.stringify(intact, null, 2) + '\n');
  r = state(s, 'close', 'delivered');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /verified MR/);
  assert.match(r.stderr, /legion finalize/);
  assert.equal(feature(s).status, 'active', 'a refused close writes nothing');
  // with the MR `legion finalize` would have recorded, close succeeds
  recordMr(s, sh(s.worktree, 'rev-parse', 'HEAD'));
  r = state(s, 'close', 'delivered');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(feature(s).status, 'delivered');
  assert.ok(feature(s).closedAt);
  // already closed
  assert.match(state(s, 'close', 'delivered').stderr, /already closed/);
});

test('close delivered refuses a recorded MR for an OLDER commit', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  advance(s, 'finalize');
  recordMr(s, '0'.repeat(40));
  const r = state(s, 'close', 'delivered');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /recorded MR !7 is for 0{40}/);
  assert.match(r.stderr, /stale/);
  assert.equal(feature(s).status, 'active');
});

test('close delivered refuses a STALE boundary receipt (commit after the receipt)', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  advance(s, 'finalize');
  commit(s, 'late.txt', 'after receipt\n'); // HEAD moves past the boundary
  const r = state(s, 'close', 'delivered');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /stale/);
});

test('close abandoned needs no receipts', () => {
  const s = scenario();
  const r = state(s, 'close', 'abandoned');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(feature(s).status, 'abandoned');
  assert.match(state(s, 'close', 'bogus').stderr, /invalid close mode/);
});

// --- revision monotonicity ----------------------------------------------------------------

test('each writing op bumps its OWN manifest revision by exactly 1; refused ops write nothing', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]); // direct seed (not through a bumping op)
  const t0 = tasks(s).revision;
  const f0 = feature(s).revision;

  // a feature.json op bumps feature.json only (session-record: no stage prerequisites — T13
  // made stage-enter forward re-derive the prefix, which is not what this test measures)
  assert.equal(state(s, 'session-record', '--session-id', 's-rev').status, 0);
  assert.equal(feature(s).revision, f0 + 1);
  assert.equal(tasks(s).revision, t0, 'feature op leaves tasks.json revision untouched');

  writeArtifact(s, 'intent.md', 'i\n');
  assert.equal(state(s, 'artifact-record', 'intent', 'intent.md').status, 0); // tasks.json op
  assert.equal(tasks(s).revision, t0 + 1);
  assert.equal(feature(s).revision, f0 + 1, 'tasks op leaves feature.json revision untouched');

  // a refused op writes nothing to either manifest
  const tBefore = tasks(s).revision;
  const fBefore = feature(s).revision;
  assert.equal(state(s, 'decision-record', 'spec').status, 1); // no spec artifact ⇒ refuse
  assert.equal(tasks(s).revision, tBefore);
  assert.equal(feature(s).revision, fBefore);
});

// --- evidence never caller-supplied -------------------------------------------------------

test('a bogus --subject-hash flag is ignored; the kernel derives the hash itself', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  const body = 'authoritative\n';
  writeArtifact(s, 'intent.md', body);
  assert.equal(state(s, 'artifact-record', 'intent', 'intent.md').status, 0);
  // pass a fake hash — it must have NO effect
  const r = state(s, 'decision-record', 'intake', '--subject-hash', 'deadbeef'.repeat(8));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(tasks(s).approvals.intake.subjectHash, createHash('sha256').update(body).digest('hex'));
});

// --- resolution + dispatch refusals -------------------------------------------------------

test('unknown op and running outside a feature worktree fail closed', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  const ru = state(s, 'frobnicate');
  assert.equal(ru.status, 1);
  assert.match(ru.stderr, /unknown state op/);
  // from the base repo (not a feature worktree) resolution refuses
  const rOut = spawnSync(process.execPath, [BIN, 'state', 'init'], { cwd: s.repo, encoding: 'utf8', env: s.env });
  assert.equal(rOut.status, 1);
  assert.match(rOut.stderr, /not a registered legion feature worktree/);
});

test('unknown schemaVersion in tasks.json dies loudly through the bin', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  const t = tasks(s);
  writeFileSync(join(s.dossier, 'tasks.json'), JSON.stringify({ ...t, schemaVersion: 7 }, null, 2) + '\n');
  const r = state(s, 'invalidate', 'spec');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown schemaVersion 7/);
});

// --- T7b: the receipt path's isClean() must not be fail-open under ambient git config ---------
// COMMENT CORRECTED FOR T12: this used to say "receipt-record is the lower-level primitive
// `legion gate` composes", and drove the case through that op. The op is gone, so the case is
// driven through `legion gate run` — the only remaining reachable path to the writer, which is
// what makes this the honest end-to-end assertion. The kernel writer's OWN isClean() guard, no
// longer reachable through any op, is covered directly on recordGateReceipt in
// test/kernel/state.test.mjs. Verified on d30972f: the receipt was written for a tree holding an
// untracked file.

test('the receipt path still sees an untracked file under status.showUntrackedFiles=no', () => {
  const s = scenario();
  assert.equal(state(s, 'init').status, 0);
  seedTasks(s, [{ id: 'T1' }]);
  sh(s.worktree, 'config', 'status.showUntrackedFiles', 'no'); // linked worktrees share .git/config
  assert.equal(sh(s.worktree, 'status', '--porcelain'), '', 'fixture: plain status is blinded');
  writeFileSync(join(s.worktree, 'untracked.txt'), 'ungated\n');

  const r = gate(s, 'run', '--boundary', NOW, '2026-07-24T00:00:00.000Z');
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stderr, /dirty/);
  assert.equal(tasks(s).receipts.boundary, null, 'no receipt for a tree with ungated content');
});
