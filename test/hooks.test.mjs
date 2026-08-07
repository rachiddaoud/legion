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
import { spawnSync } from 'node:child_process';
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
    home, base, dossier, worktree, env, intakeRepos,
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

