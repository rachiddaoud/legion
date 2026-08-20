// End-to-end guard for the three hook SCRIPTS, driven exactly as Claude Code drives them:
// one JSON payload on stdin, output read from stdout/stderr, decision read from the exit code.
// Against real fixture git repos with LEGION_HOME pinned per scenario — the real ~/.legion is
// NEVER touched, and nothing here reaches the network (the Notification hook's push path is
// covered only up to the point where it decides NOT to send).
//
// WHAT THIS CANNOT PROVE, and test/plugin-manifest.test.mjs says the same: that Claude Code
// actually invokes these scripts. That is the manifest's job (shape + matchers, validated
// against 2.1.219) and a one-time live `claude --debug` check. What IS proven here is the half
// that a wrong shape would hide: given the payload the harness documents, each script fails
// safe outside a feature, does its one job inside one, and blocks when it must.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHardenedGitEnv } from '../src/kernel/git.mjs';

// The suite must not depend on the developer's ~/.gitconfig or inherited GIT_* variables.
applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(ROOT, 'bin', 'legion.mjs');
const NODE = process.execPath;
const HOOK = (n) => join(ROOT, 'hooks', `${n}.mjs`);
const NOW = ['--now', '2026-07-25T00:00:00.000Z'];

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-hooks-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const gitc = (cwd, ...args) => sh(cwd, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', ...args);

let n = 0;
/** A registered project + started feature f1 with a real worktree, dossier and tasks.json.
 * `attach` (T23) names ADDITIONAL repositories to create beside the fixture repo and hand to
 * `feature start --add-repo`, so the manifest carries `intakeRepos`; the default — no attachment,
 * hence no key — is the shape every other test here runs against. */
function scenario({ attach = [] } = {}) {
  const base = join(TMP, `s${n++}`);
  const home = join(base, 'home');
  const repo = join(base, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  sh(repo, 'init', '-b', 'main');
  writeFileSync(join(repo, 'package.json'), `${JSON.stringify({ name: 'fix-proj' }, null, 2)}\n`);
  sh(repo, 'add', '-A');
  gitc(repo, 'commit', '-m', 'init');
  const intakeRepos = attach.map((name) => {
    const p = join(base, name);
    mkdirSync(p, { recursive: true });
    sh(p, 'init', '-b', 'main');
    writeFileSync(join(p, 'README.md'), `# ${name}\n`);
    sh(p, 'add', '-A');
    gitc(p, 'commit', '-m', 'init');
    return realpathSync(p);
  });
  const env = { ...process.env, LEGION_HOME: home };
  let r = spawnSync(NODE, [BIN, 'project', 'init', '--root', repo], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  r = spawnSync(
    NODE,
    [BIN, 'feature', 'start', 'f1', '--base', 'main', ...intakeRepos.flatMap((p) => ['--add-repo', p])],
    { cwd: repo, encoding: 'utf8', env },
  );
  assert.equal(r.status, 0, r.stderr);
  const dossier = join(home, 'orgs', 'default', 'projects', 'fix-proj', 'features', 'f1');
  const worktree = realpathSync(join(base, '.legion-worktrees', 'fix-proj', 'f1', 'checkout'));
  const s = {
    home, base, repo, dossier, worktree, env, intakeRepos,
    configPath: join(home, 'orgs', 'default', 'projects', 'fix-proj', 'project.json'),
  };
  assert.equal(kernel(s, 'state', 'init', ...NOW).status, 0);
  return s;
}

const kernel = (s, ...args) =>
  spawnSync(NODE, [BIN, ...args], { cwd: s.worktree, encoding: 'utf8', env: s.env });

/** Drive a hook the way the harness does: payload on stdin, nothing else.
 * `env` defaults to the scenario's (LEGION_HOME pinned, every GIT_* purged by the module-level
 * hardening); the T29 hostile-environment cases pass their own to export GIT_DIR/GIT_WORK_TREE. */
const fire = (s, hook, payload, env = s.env) =>
  spawnSync(NODE, [HOOK(hook)], { input: JSON.stringify(payload), encoding: 'utf8', env });

const featureJson = (s) => JSON.parse(readFileSync(join(s.dossier, 'feature.json'), 'utf8'));

function seedTasks(s, tasks) {
  writeFileSync(join(s.dossier, 'plan.md'), '# plan\n');
  writeFileSync(
    join(s.dossier, 'plan.tasks.json'),
    `${JSON.stringify({ milestones: [{ id: 'M1', title: 'm', tasks }] }, null, 2)}\n`,
  );
  const r = kernel(s, 'plan', 'check', '--feature', 'f1', '--import', ...NOW);
  assert.equal(r.status, 0, r.stderr);
}

// --- SessionStart ---------------------------------------------------------------------------

test('SessionStart records the session and injects the stage as additionalContext', () => {
  const s = scenario();
  seedTasks(s, [
    { id: 'T1', title: 'do T1', status: 'pending', attempt: 0 },
    { id: 'T2', title: 'do T2', status: 'pending', attempt: 0 },
  ]);
  const r = fire(s, 'session-start', { session_id: 'sess-abc', cwd: s.worktree, source: 'resume', hook_event_name: 'SessionStart' });
  assert.equal(r.status, 0, r.stderr);

  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart',
    'hookEventName is REQUIRED in 2.1.219 — without it the whole output is rejected and nothing is injected');
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /default\/fix-proj\/f1/);
  assert.match(ctx, /stage:\s+intake/);
  assert.match(ctx, /T1 \[pending\] do T1/);
  assert.match(ctx, /T2 \[pending\] do T2/);
  assert.match(ctx, /0\/2 done/);
  assert.doesNotMatch(ctx, /LEGION KERNEL REFUSAL/);

  // The write went through the typed op, so it lands in feature.json's session history.
  const f = featureJson(s);
  assert.equal(f.currentSession, 'sess-abc');
  assert.deepEqual(f.sessionHistory.map((h) => h.sessionId), ['sess-abc']);
});

test('SessionStart surfaces a kernel refusal in-band — it cannot block, so it must be loud', () => {
  const s = scenario();
  // A REAL refusal: the dossier is readable but not writable, so feature.json still renders
  // while the session-record write fails. SessionStart's exit 2 only reaches the user, never
  // the model, so the refusal has to travel inside additionalContext or it is lost.
  chmodSync(s.dossier, 0o555);
  let r;
  try {
    r = fire(s, 'session-start', { session_id: 'sess-x', cwd: s.worktree, source: 'startup' });
  } finally {
    chmodSync(s.dossier, 0o755);
  }
  assert.equal(r.status, 0, 'it must not die: a broken write is not a reason to lose the stage');
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /^LEGION KERNEL REFUSAL/, 'the refusal goes FIRST, where the model reads it');
  assert.match(ctx, /session-record/);
  assert.match(ctx, /stage:\s+intake/, 'and the stage is still injected — it is what the session needs');
  // The claim under test is that nothing was silently recorded.
  assert.deepEqual(featureJson(s).sessionHistory, []);
});

test('SessionStart falls silent when there is no manifest at all — the one sanctioned silence', () => {
  const s = scenario();
  rmSync(join(s.dossier, 'feature.json'));
  const r = fire(s, 'session-start', { session_id: 'sess-x', cwd: s.worktree, source: 'startup' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'no manifest ⇒ nothing to say; this plugin loads in every session');
});

test('SessionStart renders a feature with no tasks.json without inventing one', () => {
  const s = scenario();
  rmSync(join(s.dossier, 'tasks.json'));
  const r = fire(s, 'session-start', { session_id: 'sess-y', cwd: s.worktree, source: 'compact' });
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /tasks\.json does not exist yet/);
  assert.match(ctx, /SessionStart\(compact\)/, 'the source is echoed so a compaction is recognisable');
});

// --- T23: attached intake repositories are RENDERED, because nothing else tells the session ------
// The launch line put them in reach with --add-dir, but a resumed session reads only this block:
// without the line, a code-informed intake over two repos silently degrades to one. Both halves are
// pinned — the line when the manifest has the field, and NO line when it does not (which is every
// ordinary single-repo feature, and every manifest written before this field existed).

test('SessionStart names the attached intake repos, so a resumed session knows they are in reach', () => {
  const s = scenario({ attach: ['aux-one', 'aux-two'] });
  const r = fire(s, 'session-start', { session_id: 'sess-attached', cwd: s.worktree, source: 'resume' });
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /intake repos/, 'the attachment must be named, not merely implied by the dossier');
  for (const p of s.intakeRepos) assert.ok(ctx.includes(p), `${p} must appear in:\n${ctx}`);
  assert.equal(ctx.split('\n').filter((l) => l.includes('intake repos')).length, 1,
    'one line — this block is CAP-capped and prepended to every resumed context');
  assert.match(ctx, /--add-dir/, 'and it must say WHY they are reachable, or the session will try to clone');
});

test('SessionStart renders a feature with NO attached repos without inventing the line', () => {
  const s = scenario();
  assert.equal(JSON.parse(readFileSync(join(s.dossier, 'feature.json'), 'utf8')).intakeRepos, undefined,
    'fixture: the ordinary single-repo manifest has no such key at all');
  const r = fire(s, 'session-start', { session_id: 'sess-plain', cwd: s.worktree, source: 'resume' });
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.doesNotMatch(ctx, /intake repos/, 'absence is the common case and must render nothing');
  assert.match(ctx, /stage:\s+intake/, 'and the rest of the block is unchanged');
});

// --- R9: a CORRUPT dossier is never rendered as "not a legion feature" -------------------------
// The SubagentStop half of this is test/acceptance/enforcement.test.mjs case 4; this is the
// SessionStart half. The distinction the whole fix turns on is ABSENT vs CORRUPT: the test above
// (`no manifest at all`) and the one below it (`no tasks.json`) pin the ABSENT side and must not
// move — absence is an ordinary early stage, corruption is a session running with no gate.
// SessionStart cannot block (exit 2 reaches the user, not the model), so loud-in-band via
// additionalContext is the loudest channel this event has.

for (const which of ['tasks', 'feature']) {
  test(`SessionStart is LOUD in-band on a corrupt ${which}.json, and records nothing`, () => {
    const s = scenario();
    if (which === 'tasks') seedTasks(s, [{ id: 'T1', title: 'do T1', status: 'pending', attempt: 0 }]);
    const path = join(s.dossier, `${which}.json`);
    writeFileSync(path, '{ this is not json\n');

    const r = fire(s, 'session-start', { session_id: 'sess-corrupt', cwd: s.worktree, source: 'resume' });
    assert.equal(r.status, 0, 'it must not die: a corruption report is worth more than a stack trace');
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(ctx, /^LEGION DOSSIER CORRUPT/, 'the corruption goes FIRST, where the model reads it');
    assert.match(ctx, new RegExp(`${which}\\.json`), 'the corruption must be NAMED');
    assert.ok(ctx.includes(path), `and located: ${ctx}`);
    assert.match(ctx, /NO GATE/, 'and it must say what that means for this session');
    assert.doesNotMatch(ctx, /not a legion feature/i,
      'rendering a broken dossier as "not a legion feature" is R9 itself');
    // Nothing may be silently recorded into a manifest whose shape is unknown. For the corrupt
    // tasks.json case feature.json is still readable, so this is checkable.
    if (which === 'tasks') assert.deepEqual(featureJson(s).sessionHistory, []);
  });
}

test('SessionStart is LOUD on a corrupt projects.json — every feature becomes unresolvable', () => {
  const s = scenario();
  const idx = join(s.home, 'projects.json');
  writeFileSync(idx, '{ "projects": not json\n');
  const r = fire(s, 'session-start', { session_id: 'sess-corrupt-idx', cwd: s.worktree, source: 'startup' });
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /projects\.json/, 'the index must be named');
  assert.doesNotMatch(ctx, /not a legion feature/i);
});

test('a PARSEABLE but wrong-shape projects.json is corrupt too, not silence', () => {
  // PARSING IS NOT VALIDATION. These three slid through the first version of the preflight and came
  // back as ordinary silence — "not a legion feature" — which is the one outcome R9 forbids for a
  // broken index: every feature on this machine is unresolvable and the session runs with no gate.
  // Each missing fact is owned elsewhere (`version` by kernel/casfile.mjs, `schemaVersion` by
  // cli/project.mjs, `projects` by both), so its absence means a hand-edit or a version skew.
  // One case per BRANCH, which is the point: `{}` and the version-less object both trip the
  // `version` check, so on their own they leave the `projects` arm — the actual widening over the
  // old "an array IF defined" test — with no coverage at all.
  const cases = [
    ['{}', 'an empty object'],
    ['{ "schemaVersion": 1, "projects": [] }', 'no casfile `version`'],
    ['{ "version": 1, "schemaVersion": 99, "projects": [] }', 'an unrecognised schemaVersion'],
    ['{ "version": 1, "schemaVersion": 1 }', '`projects` missing entirely'],
    ['{ "version": 1, "schemaVersion": 1, "projects": {} }', '`projects` present but not an array'],
  ];
  for (const [json, what] of cases) {
    const s = scenario();
    writeFileSync(join(s.home, 'projects.json'), `${json}\n`);
    const r = fire(s, 'session-start', { session_id: 'sess-shape', cwd: s.worktree, source: 'startup' });
    assert.equal(r.status, 0, what);
    const ctx = JSON.parse(r.stdout).hookSpecificOutput?.additionalContext;
    assert.ok(ctx, `${what}: the hook must inject something rather than fall silent`);
    assert.match(ctx, /projects\.json/, `${what}: the index must be named`);
    assert.doesNotMatch(ctx, /not a legion feature/i, `${what}: silence is the one forbidden outcome`);
  }
});

// --- SessionStart: merged-sweep (the second, ASYNCHRONOUS entry) ------------------------------
// This hook is the only thing in legion that notices a merge, and it is the only hook whose
// message reaches BOTH audiences: on exit 2 the harness shows the manifest's `rewakeSummary` to
// the operator and hands `${rewakeMessage} ${stderr || stdout}` to the model. So the contract
// under test is exactly three-valued — silent, silent, or exit 2 with the finding ON STDERR — and
// the two silences matter more than the finding: this fires at the top of every session.

/** A `gh` that answers one payload, in front of whatever the host PATH has. The sweep must be
 * driven through a forge CLI it can actually spawn, and the host's real `gh` must never be it. */
function withGh(s, stdout, code = 0) {
  const dir = join(s.base, 'forgebin');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'gh');
  writeFileSync(p, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${code}\n`);
  chmodSync(p, 0o755);
  return { ...s.env, PATH: `${dir}:${s.env.PATH ?? ''}` };
}

/** The finalize record plus the forge's answer, both hand-written: this suite runs no forge CLI
 * for real (test/cli/feature-merged.test.mjs is where that write is earned) and the sweep reads
 * `mr` to decide what to ASK about. */
function recordMr(s, head) {
  const p = join(s.dossier, 'feature.json');
  const f = JSON.parse(readFileSync(p, 'utf8'));
  f.revision += 1;
  f.mr = { iid: 7, url: 'https://github.invalid/acme/x/pull/7', targetBranch: f.baseBranch, headSha: head, at: NOW[1], forge: 'github' };
  writeFileSync(p, `${JSON.stringify(f, null, 2)}\n`);
}

test('merged-sweep is SILENT outside a registered legion project — most sessions are not one', () => {
  const s = scenario();
  const r = fire(s, 'merged-sweep', { session_id: 'sess-x', cwd: s.base, source: 'startup' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('merged-sweep is SILENT when nothing is merged — no noise at the top of a session', () => {
  const s = scenario();
  const head = gitc(s.worktree, 'rev-parse', 'HEAD');
  recordMr(s, head);
  const env = withGh(s, JSON.stringify({ state: 'OPEN', headRefOid: head }));
  const r = fire(s, 'merged-sweep', { session_id: 'sess-x', cwd: s.repo, source: 'startup' }, env);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, '');
});

test('a MERGED pull request exits 2 with the finding on stderr — the rewake channel', () => {
  const s = scenario();
  const head = gitc(s.worktree, 'rev-parse', 'HEAD');
  recordMr(s, head);
  const env = withGh(s, JSON.stringify({ state: 'MERGED', headRefOid: head }));

  // From the MAIN ROOT, which is the whole point of this hook: after finalize nobody opens a
  // session in the feature worktree again, so a sweep bound to the feature would fire exactly
  // where it is useless.
  const r = fire(s, 'merged-sweep', { session_id: 'sess-x', cwd: s.repo, source: 'startup' }, env);
  assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /^f1: #7 merged at /m);
  assert.match(r.stderr, /legion feature clean f1/);
  // stdout stays free for the harness's own JSON; the build composes the model's message from
  // `stderr || stdout` and would silently prefer an empty stderr over a full stdout.
  assert.equal(r.stdout, '');
  // The hook itself writes nothing — the kernel does, through the binary.
  assert.equal(featureJson(s).mr.merged.headSha, head);
});

// --- SubagentStop ---------------------------------------------------------------------------

test('SubagentStop BLOCKS the builder with exit 2 when the started task has no receipt', () => {
  const s = scenario();
  seedTasks(s, [{ id: 'T1', title: 'do T1', status: 'pending', attempt: 0 }]);
  assert.equal(kernel(s, 'state', 'task-start', 'T1', ...NOW).status, 0);

  const r = fire(s, 'builder-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:builder', agent_id: 'a1',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
  });
  // 2 is the ONLY code that shows stderr to the subagent and keeps it running (2.1.219).
  assert.equal(r.status, 2, `expected the block, got ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout, '', 'a block speaks on stderr; stdout would only reach the transcript');
  assert.match(r.stderr, /no valid gate receipt/);
  assert.match(r.stderr, /legion gate run --task T1/, 'it must name the exact remedy');
  assert.match(r.stderr, /commit/i, 'and the commit-then-gate order');
});

test('SubagentStop lets the builder stop once the gate has recorded a receipt', () => {
  const s = scenario();
  seedTasks(s, [{ id: 'T1', title: 'do T1', status: 'pending', attempt: 0 }]);
  assert.equal(kernel(s, 'state', 'task-start', 'T1', ...NOW).status, 0);
  writeFileSync(join(s.worktree, 'src.txt'), 'work\n');
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', 'T1');
  // No gates are declared in this fixture's project.json, so the run is tier-0 only — which is
  // still a REAL gate run recording a REAL receipt through the typed op.
  const g = kernel(s, 'gate', 'run', '--task', 'T1', ...NOW);
  assert.equal(g.status, 0, g.stderr);

  const r = fire(s, 'builder-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:builder', agent_id: 'a1',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
  });
  assert.equal(r.status, 0, r.stderr);
});

test('SubagentStop blocks again after a new commit — the receipt keys to the TREE, not the task', () => {
  const s = scenario();
  seedTasks(s, [{ id: 'T1', title: 'do T1', status: 'pending', attempt: 0 }]);
  assert.equal(kernel(s, 'state', 'task-start', 'T1', ...NOW).status, 0);
  writeFileSync(join(s.worktree, 'src.txt'), 'work\n');
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', 'T1');
  assert.equal(kernel(s, 'gate', 'run', '--task', 'T1', ...NOW).status, 0);
  // Ungated work lands on top. The receipt now certifies a tree that is no longer HEAD's.
  writeFileSync(join(s.worktree, 'src.txt'), 'more work\n');
  sh(s.worktree, 'add', '-A');
  gitc(s.worktree, 'commit', '-m', 'more');

  const r = fire(s, 'builder-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:builder', agent_id: 'a1',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
  });
  assert.equal(r.status, 2, 'a stale receipt is not a receipt');
});

test('SubagentStop releases on the second attempt but never pretends the receipt is valid', () => {
  const s = scenario();
  seedTasks(s, [{ id: 'T1', title: 'do T1', status: 'pending', attempt: 0 }]);
  assert.equal(kernel(s, 'state', 'task-start', 'T1', ...NOW).status, 0);
  const r = fire(s, 'builder-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:builder', agent_id: 'a1',
    agent_transcript_path: '/dev/null', stop_hook_active: true, cwd: s.worktree,
  });
  // The harness caps stop-hook recursion, so blocking forever is not on offer. Releasing is
  // only safe because task-done re-derives the tree itself — assert BOTH halves: the release,
  // and that the refusal is still reported rather than swallowed.
  assert.equal(r.status, 0);
  assert.match(r.stderr, /releasing the builder/);
  assert.match(r.stderr, /legion state task-done T1/, 'it must name the layer that actually fails closed');
  const done = kernel(s, 'state', 'task-done', 'T1', ...NOW);
  assert.equal(done.status, 1, 'and that layer must in fact refuse');
  assert.match(done.stderr, /no receipt/);
});

test('SubagentStop is inert for every other subagent and outside a task', () => {
  const s = scenario();
  seedTasks(s, [{ id: 'T1', title: 'do T1', status: 'pending', attempt: 0 }]);
  assert.equal(kernel(s, 'state', 'task-start', 'T1', ...NOW).status, 0);
  for (const agent_type of ['legion:code-reviewer', 'legion:architect', 'general-purpose', '']) {
    const r = fire(s, 'builder-receipt', { agent_type, cwd: s.worktree, stop_hook_active: false });
    assert.equal(r.status, 0, `${agent_type} must not be blocked by the builder hook`);
    assert.equal(r.stderr, '');
  }
  // A builder that ran with no task started (an exploratory dispatch) has nothing to verify.
  const s2 = scenario();
  const r2 = fire(s2, 'builder-receipt', { agent_type: 'legion:builder', cwd: s2.worktree, stop_hook_active: false });
  assert.equal(r2.status, 0);
});

// --- SubagentStop: review-receipt (the reviewer-scoped minter) -------------------------------
// The asymmetry with builder-receipt is deliberate and pinned here: NOTHING in this hook ever
// exits 2. A reviewer that stopped has no remedial action; the fail-closed layer is
// `legion state review-record`, which refuses without the receipt this hook mints.

const readTasksJson = (s) => JSON.parse(readFileSync(join(s.dossier, 'tasks.json'), 'utf8'));

test('a reviewer stop MINTS a verdict-bearing receipt from last_assistant_message', () => {
  const s = scenario();
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: 'rev-1',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    last_assistant_message: '{"verdict":"pass","findings":[]}',
  });
  assert.equal(r.status, 0, r.stderr);
  const receipt = readTasksJson(s).reviewReceipts.at(-1);
  assert.equal(receipt.role, 'code-reviewer');
  assert.equal(receipt.agentId, 'rev-1');
  assert.equal(receipt.verdict, 'pass');
  assert.equal(receipt.treeHash, sh(s.worktree, 'rev-parse', 'HEAD^{tree}'));
  assert.equal(receipt.consumed, null);
});

test('the LAST verdict in the message wins, and `revise` (plan-critic vocabulary) maps to fail', () => {
  const s = scenario();
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:plan-critic', agent_id: 'critic-1',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    // Quoted findings mention a pass; the critic's own conclusion comes last.
    last_assistant_message: 'earlier draft said {"verdict":"pass"} but final: {"verdict":"revise","findings":[]}',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readTasksJson(s).reviewReceipts.at(-1).verdict, 'fail', 'a plan sent back is not a plan that passed');
});

test('no extractable verdict anywhere ⇒ ATTENDANCE-ONLY receipt, never a guessed verdict', () => {
  const s = scenario();
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:product-reviewer', agent_id: 'prod-1',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    last_assistant_message: 'the reviewer said many things but returned no structured verdict',
  });
  assert.equal(r.status, 0, r.stderr);
  const receipt = readTasksJson(s).reviewReceipts.at(-1);
  assert.equal(receipt.verdict, null);
  assert.equal(receipt.role, 'product-reviewer');
});

test('the stated review SUBJECT is extracted and scopes the receipt; garbage subjects are left unstated', () => {
  const s = scenario();
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: 'rev-s',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    last_assistant_message: '{"verdict":"pass","subject":"milestone:M1","findings":[]}',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readTasksJson(s).reviewReceipts.at(-1).subject, 'milestone:M1');
  // A subject outside the kernel vocabulary is not extracted — the receipt stays unscoped
  // rather than carrying a value the kernel would refuse the whole mint over.
  const r2 = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: 'rev-g',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    last_assistant_message: '{"verdict":"pass","subject":"whatever:thing","findings":[]}',
  });
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readTasksJson(s).reviewReceipts.at(-1).subject, null);
});

test('consult reporting available:false mints ATTENDANCE-ONLY — a missing lens is not a fail', () => {
  // The loop never records an unavailable consult, so a schema-forced 'fail' minted here would
  // strand an unconsumable fail receipt that anti-fold-blocks the honest pass after the backend
  // comes back at the same tree — the consult lens's own top finding on this feature.
  const s = scenario();
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:consult', agent_id: 'codex-1',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    last_assistant_message: '{"available":false,"verdict":"fail","findings":[],"raw":"codex CLI not found"}',
  });
  assert.equal(r.status, 0, r.stderr);
  const receipt = readTasksJson(s).reviewReceipts.at(-1);
  assert.equal(receipt.verdict, null, 'a missing lens has no verdict to certify');
  assert.equal(receipt.role, 'consult');
});

test('the transcript TAIL is the fallback source when last_assistant_message carries no verdict', () => {
  const s = scenario();
  const transcript = join(s.base, 'reviewer-transcript.jsonl');
  writeFileSync(transcript, `${'x'.repeat(200)}\n{"type":"assistant","message":"…"}\n{"toolu":"structured","input":{"verdict":"fail","findings":[]}}\n`);
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:visual-reviewer', agent_id: 'vis-1',
    agent_transcript_path: transcript, stop_hook_active: false, cwd: s.worktree,
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readTasksJson(s).reviewReceipts.at(-1).verdict, 'fail');
});

test('available:false voids the verdict for the CONSULT LENS ONLY — any other reviewer keeps its fail', () => {
  // The orphan-receipt argument is consult's alone: the loop never records an unavailable
  // consult, so its schema-forced 'fail' would strand an unconsumable receipt. `available` is not
  // in any other reviewer's contract, so honouring it there would let one off-contract field
  // retire the anti-fold rule — a later `review-record --verdict pass` at that subject and tree
  // would meet no live fail receipt and be accepted.
  const s = scenario();
  for (const agent_type of ['legion:product-reviewer', 'legion:code-reviewer', 'legion:visual-reviewer', 'legion:plan-critic']) {
    const r = fire(s, 'review-receipt', {
      hook_event_name: 'SubagentStop', agent_type, agent_id: `av-${agent_type}`,
      agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
      last_assistant_message: '{"available":false,"verdict":"fail","subject":"milestone:M1","findings":[]}',
    });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readTasksJson(s).reviewReceipts.at(-1).verdict, 'fail', `${agent_type} keeps its verdict`);
  }
});

test('verdict and subject come from the SAME source — a quoted subject never re-scopes a tail verdict', () => {
  // The subject used to be read from last_assistant_message with the tail as a fallback, while the
  // verdict picked its own source. A message that merely QUOTES a subject (an echoed brief, an
  // earlier draft) without a verdict literal therefore paired the tail's verdict with the
  // message's subject: a `fail` receipt at a subject nobody reviewed, which anti-fold-blocks the
  // honest pass there while the reviewed subject's record is refused for want of evidence.
  const s = scenario();
  const transcript = join(s.base, 'mixed-source-transcript.jsonl');
  writeFileSync(transcript, `${'x'.repeat(200)}\n{"toolu":"structured","input":{"verdict":"fail","subject":"milestone:M1","findings":[]}}\n`);
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: 'rev-mixed',
    agent_transcript_path: transcript, stop_hook_active: false, cwd: s.worktree,
    // No verdict literal ⇒ the tail is the source. The quoted subject must NOT be picked up.
    last_assistant_message: 'I reviewed the milestone; my brief quoted "subject":"task:T1" as the example shape.',
  });
  assert.equal(r.status, 0, r.stderr);
  const receipt = readTasksJson(s).reviewReceipts.at(-1);
  assert.equal(receipt.verdict, 'fail');
  assert.equal(receipt.subject, 'milestone:M1', 'the subject must come from the source the verdict came from');
});

test('review-receipt is inert for non-reviewers and unregistered cwds', () => {
  const s = scenario();
  const before = readTasksJson(s).revision;
  for (const agent_type of ['legion:builder', 'legion:architect', 'general-purpose', 'legion:kernel-op', '']) {
    const r = fire(s, 'review-receipt', { agent_type, agent_id: 'x', cwd: s.worktree, stop_hook_active: false });
    assert.equal(r.status, 0, `${agent_type} must not trigger the reviewer hook`);
    assert.equal(r.stderr, '', `${agent_type}: silence, not a refusal`);
  }
  assert.equal(readTasksJson(s).revision, before, 'nothing minted for any of them');
  const outside = fire(s, 'review-receipt', {
    agent_type: 'legion:code-reviewer', agent_id: 'x', cwd: tmpdir(), stop_hook_active: false,
    last_assistant_message: '{"verdict":"pass"}',
  });
  assert.equal(outside.status, 0);
  assert.equal(outside.stderr, '', 'not a legion worktree — the one sanctioned silence');
});

test('a CORRUPT tasks.json is LOUD but RELEASES (exit 0) — review-record is the fail-closed layer', () => {
  const s = scenario();
  writeFileSync(join(s.dossier, 'tasks.json'), '{ not json !\n');
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: 'rev-1',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    last_assistant_message: '{"verdict":"pass"}',
  });
  assert.equal(r.status, 0, 'blocking a reviewer stop cannot mend a manifest or mint anything');
  assert.match(r.stderr, /DOSSIER CORRUPT/);
  assert.match(r.stderr, /tasks\.json/, 'the broken file is named');
  assert.match(r.stderr, /review-record/, 'and the layer that will refuse is named');
});

test('a kernel REFUSAL of the mint is surfaced on stderr, never swallowed — and still releases', () => {
  const s = scenario();
  const r = fire(s, 'review-receipt', {
    hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: '',
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    last_assistant_message: '{"verdict":"pass"}',
  });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /review receipt mint refused/);
  assert.match(r.stderr, /agent id/);
});

test('two lenses stopping CONCURRENTLY both mint — the manifest lock loses neither', async () => {
  const s = scenario();
  const payload = (id) => JSON.stringify({
    hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: id,
    agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: s.worktree,
    last_assistant_message: '{"verdict":"pass","findings":[]}',
  });
  const fireAsync = (id) => new Promise((resolve) => {
    const p = spawn(NODE, [HOOK('review-receipt')], { env: s.env });
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => resolve({ code, stderr }));
    p.stdin.end(payload(id));
  });
  const [a, b] = await Promise.all([fireAsync('lens-a'), fireAsync('lens-b')]);
  assert.equal(a.code, 0, a.stderr);
  assert.equal(b.code, 0, b.stderr);
  const ids = readTasksJson(s).reviewReceipts.map((x) => x.agentId).sort();
  assert.deepEqual(ids, ['lens-a', 'lens-b'], 'a lost update here IS a lost review');
});

// --- issue #3: the SESSION FALLBACK — a feature session whose cwd is NOT the worktree ---------
// A `/legion:start` session, and a `/legion:feature` resume launched from the main root, ARE
// feature sessions standing in the main checkout; the harness also stamps the Bash tool's
// persistent cwd on hook input, so one stray `cd <dossier>` drifts an ordinary worktree session
// the same way. Each of those made every receipt hook take the sanctioned-silence path, and
// `legion state review-record` then refused forever for want of evidence. The second resolution
// is feature.json's `currentSession`, written by `legion state session-record` — a session that
// recorded ITSELF into exactly one feature.

/** Record `id` as f1's currentSession, the way the skills tell the session to. */
const recordSession = (s, id) => {
  const r = kernel(s, 'state', 'session-record', '--session-id', id, ...NOW);
  assert.equal(r.status, 0, r.stderr);
  return id;
};

const mintFromCwd = (s, cwd, extra = {}) => fire(s, 'review-receipt', {
  hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: 'rev-root',
  agent_transcript_path: '/dev/null', stop_hook_active: false, cwd,
  last_assistant_message: '{"verdict":"pass","subject":"task:T1","findings":[]}',
  ...extra,
});

for (const [where, cwdOf] of [['the MAIN REPO ROOT', (s) => s.repo], ['the DOSSIER', (s) => s.dossier]]) {
  test(`a reviewer stopping with cwd at ${where} still mints, via the recorded session id`, () => {
    const s = scenario();
    recordSession(s, 'sess-root-1');
    const r = mintFromCwd(s, cwdOf(s), { session_id: 'sess-root-1' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '', 'the mint must go through, not merely be attempted');
    const receipt = readTasksJson(s).reviewReceipts.at(-1);
    assert.equal(receipt.agentId, 'rev-root');
    assert.equal(receipt.verdict, 'pass');
    assert.equal(receipt.subject, 'task:T1');
    // The receipt keys to the FEATURE WORKTREE's tree, which is the whole point of the chdir:
    // resolved-by-session and resolved-by-cwd must be indistinguishable downstream.
    assert.equal(receipt.treeHash, sh(s.worktree, 'rev-parse', 'HEAD^{tree}'));
  });
}

test('an UNRECORDED session id is not a resolution — silence, exactly as before', () => {
  const s = scenario();
  const before = readTasksJson(s).revision;
  for (const payload of [{ session_id: 'sess-never-recorded' }, {}]) {
    const r = mintFromCwd(s, s.repo, payload);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '', 'an unresolvable payload is the one sanctioned silence');
  }
  assert.equal(readTasksJson(s).revision, before, 'nothing was minted at a feature nobody named');
});

test('TWO features claiming one session id resolve to NEITHER — a receipt is never guessed', () => {
  const s = scenario();
  recordSession(s, 'sess-shared');
  // f2 is a second feature of the same project, hand-set to claim the same session. Nothing
  // legitimate produces this (session-record overwrites, it does not share), which is exactly why
  // it must not be repaired by picking one: the receipt would certify the wrong tree.
  let r = spawnSync(NODE, [BIN, 'feature', 'start', 'f2', '--base', 'main'], { cwd: s.repo, encoding: 'utf8', env: s.env });
  assert.equal(r.status, 0, r.stderr);
  const f2 = join(s.home, 'orgs', 'default', 'projects', 'fix-proj', 'features', 'f2');
  r = spawnSync(NODE, [BIN, 'state', 'session-record', '--session-id', 'sess-shared', ...NOW],
    { cwd: realpathSync(join(s.base, '.legion-worktrees', 'fix-proj', 'f2', 'checkout')), encoding: 'utf8', env: s.env });
  assert.equal(r.status, 0, r.stderr);

  const before = readTasksJson(s).revision;
  const hook = mintFromCwd(s, s.repo, { session_id: 'sess-shared' });
  assert.equal(hook.status, 0);
  assert.equal(hook.stderr, '', 'ambiguity is silence, not a coin toss');
  assert.equal(readTasksJson(s).revision, before, 'nothing minted for either claimant');
});

test('a CORRUPT projects.json stays LOUD from a main-root cwd — the fallback never softens R9', () => {
  // The index preflight runs BEFORE either resolution, so a broken index is still a corruption
  // report and never "not a legion feature", session id or no session id.
  const s = scenario();
  recordSession(s, 'sess-corrupt-root');
  writeFileSync(join(s.home, 'projects.json'), '{ "projects": not json\n');
  const r = mintFromCwd(s, s.repo, { session_id: 'sess-corrupt-root' });
  assert.equal(r.status, 0, 'a reviewer stop is never blocked');
  assert.match(r.stderr, /DOSSIER CORRUPT/);
  assert.match(r.stderr, /projects\.json/, 'the unreadable index must be named');
});

// --- Notification ----------------------------------------------------------------------------

test('Notification sends nothing when the project declares no topic (and never touches the network)', () => {
  const s = scenario();
  // `legion project init` recorded notify: null for this fixture. The hook must exit before it
  // builds a URL, which is what keeps this suite off the network.
  const cfg = JSON.parse(readFileSync(s.configPath, 'utf8'));
  assert.equal(cfg.notify, null);
  const r = fire(s, 'notify', {
    hook_event_name: 'Notification', notification_type: 'agent_needs_input',
    message: 'waiting for input', cwd: s.worktree,
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
});

test('Notification handles a CORRUPT dossier explicitly rather than by accident', () => {
  // Before this was handled, notify destructured `feature` (null on the corrupt path) and passed it
  // to projectConfig, whose own try/catch swallowed the resulting TypeError and returned null — the
  // right outcome for the wrong reason. This pins the explicit handling: no push, exit 0, and the
  // corrupt file NAMED on stderr rather than the hook pretending this is not a legion worktree.
  const s = scenario();
  writeFileSync(join(s.dossier, 'tasks.json'), '{ "schemaVersion": 1, oops\n');
  const r = fire(s, 'notify', {
    hook_event_name: 'Notification', notification_type: 'agent_needs_input',
    message: 'waiting for input', cwd: s.worktree,
  });
  assert.equal(r.status, 0, 'a Notification hook must never block a session');
  assert.equal(r.stdout, '', 'and must send nothing about a feature it could not read');
  assert.match(r.stderr, /tasks\.json/, 'the unreadable file must be named');
  assert.doesNotMatch(r.stderr, /not a legion feature/i, 'silence-by-mislabel is the forbidden outcome');
});

