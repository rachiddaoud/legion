// End-to-end guard for the four hook SCRIPTS, driven exactly as Claude Code drives them:
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

// --- PreToolUse (T26): raw remote writes typed into the Bash tool ------------------------------
// PLAN-V3 §Remote safety layer 3, the plugin half. What is proven here is the DECISION, on the
// exact deny surface 2.1.219 honours: exit code 2 with the message on stderr AND
// hookSpecificOutput.permissionDecision='deny' on stdout (hooks/bash-remote-write.mjs's header
// records where each half was read out of that build). What is NOT proven here — same caveat
// test/plugin-manifest.test.mjs opens with — is that Claude Code dispatches this script at all;
// that is the manifest's matcher plus a live `claude --debug` check.
//
// THE GUARD IS BYPASSABLE BY CONSTRUCTION and these tests must never read as if it were not:
// `bash -c 'git push'`, a script, an alias and an encoded string all walk past a token scan. The
// server is the guarantee (M0-FIXTURE-LEDGER row 8); this layer blocks the ordinary path.

/** Drive the PreToolUse hook the way Claude Code does: the validated payload, and nothing else. */
const preTool = (s, command, over = {}, env = s.env) => fire(s, 'bash-remote-write', {
  hook_event_name: 'PreToolUse', session_id: 'sess-p', cwd: s.worktree, tool_use_id: 'tu1',
  tool_name: 'Bash', tool_input: { command, description: 'a command' }, ...over,
}, env);

/** A real git repository legion knows NOTHING about, beside the fixture's own. The T29 rule turns
 * on registration, so half of these cases need a repo that is emphatically not registered — and it
 * must be a REAL repo, because "unregistered repository" and "not a repository at all" are two
 * different outcomes of the widened rule. */
let outside = 0;
function unregisteredRepo(s) {
  const p = join(s.base, `outside${outside++}`);
  mkdirSync(p, { recursive: true });
  sh(p, 'init', '-b', 'main');
  writeFileSync(join(p, 'x.txt'), 'x\n');
  sh(p, 'add', '-A');
  gitc(p, 'commit', '-m', 'init');
  return realpathSync(p);
}

/** An ALLOW is silence on BOTH channels — this hook fires on every Bash call in every session. */
function assertAllowed(r, what) {
  assert.equal(r.status, 0, `${what}: expected an allow, got ${r.status}: ${r.stderr}`);
  assert.equal(r.stdout, '', `${what}: an allow prints nothing`);
  assert.equal(r.stderr, '', `${what}: nor on stderr`);
}

/** BOTH deny mechanisms, asserted together — either one alone would leave the other free to rot. */
function assertDenied(r, what) {
  assert.equal(r.status, 2, `${what}: exit 2 is what blocks the tool call in 2.1.219 — got ${r.status}: ${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse',
    'hookEventName is REQUIRED and is checked against the fired event');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  const reason = out.hookSpecificOutput.permissionDecisionReason;
  assert.ok(reason.length > 0, `${what}: a deny with no reason teaches nothing`);
  assert.equal(reason.split('\n').length, 1, `${what}: one line — a wrapped block reads as several findings`);
  assert.match(r.stderr, /BLOCKED/, `${what}: the stderr half must carry the message too`);
  return reason;
}

test('PreToolUse DENIES the raw remote-write Bash commands, on both honoured surfaces', () => {
  const s = scenario();
  const denied = [
    'git push',
    'git push origin main',
    'git -C /x push',
    'cd /x && git push',
    'glab mr create --fill',
    'npm test; git push',
    // Beyond the spec's table, and each one a shape an erring agent actually types:
    'git push --dry-run',                       // denied ON PURPOSE — simplicity over flag grammar
    'glab mr merge 12',                         // the other glab verb that writes an MR
    'glab -R o/p mr create --fill',             // a global flag before the subcommand
    'glab api -X POST projects/1/merge_requests', // the same write one layer down
    '/usr/bin/git push',                        // an absolute path must not hide the program name
    'npm test && git push origin HEAD',
  ];
  for (const command of denied) {
    const reason = assertDenied(preTool(s, command), command);
    assert.match(reason, /legion finalize/, `${command}: the refusal must name the sanctioned path`);
    assert.match(reason, /DEPTH|depth/, `${command}: and must not read as a guarantee`);
    assert.match(reason, /server/i, `${command}: the server is what actually refuses`);
  }
});

test('PreToolUse ALLOWS everything else, in silence', () => {
  const s = scenario();
  const allowed = [
    'git status',
    'git commit -F m',
    'echo hello',
    'npm test',
    // `legion finalize` is not a git/glab invocation at this layer, so it needs no exception —
    // and if this ever denies, the guard has broken THE sanctioned path.
    'legion finalize --description-file d.md',
    'git log --oneline -5',
    'git fetch origin',
    'node --test test/hooks.test.mjs',
  ];
  for (const command of allowed) {
    const r = preTool(s, command);
    assert.equal(r.status, 0, `${command} must be allowed: ${r.stderr}`);
    assert.equal(r.stdout, '', `${command}: an allow prints nothing (this fires on EVERY Bash call)`);
    assert.equal(r.stderr, '', `${command}: nor on stderr`);
  }
});

test('PreToolUse fails OPEN on a payload it cannot read — the one deliberate fail-open', () => {
  // A guard that refuses whatever surprises it does not degrade here, it bricks every Bash call
  // in the session. hooks/bash-remote-write.mjs decision A states the trade; this pins it.
  const s = scenario();
  const raw = (input) => spawnSync(NODE, [HOOK('bash-remote-write')], { input, encoding: 'utf8', env: s.env });
  for (const [input, what] of [
    ['', 'empty stdin'],
    ['not json at all\n', 'unparseable stdin'],
    ['[1,2,3]\n', 'a JSON array rather than an object'],
    ['{"tool_name":"Bash"}\n', 'no tool_input at all'],
    ['{"tool_name":"Bash","tool_input":{}}\n', 'no command field'],
    ['{"tool_name":"Bash","tool_input":{"command":42}}\n', 'a non-string command'],
    ['{"tool_name":"Write","tool_input":{"content":"git push"}}\n', 'a tool that is not Bash'],
  ]) {
    const r = raw(input);
    assert.equal(r.status, 0, `${what} must be allowed silently: ${r.stderr}`);
    assert.equal(r.stdout, '', what);
    assert.equal(r.stderr, '', what);
  }
});

// --- T29: scoped to the TARGET REPOSITORY, not to the session's launch cwd ----------------------
// PLAN-V3 §Startup's S-007 amendment (one session: started from the main repo root, CONTINUING as
// the feature session) made T26's launch-cwd scoping wrong — that session's frozen launch cwd is
// the main checkout, so it got NO plugin-layer deny at all. §Remote safety names this widening the
// one sanctioned exception to layer 3 being closed as landed.
// THE FLIP IS DELIBERATE AND IS THE TASK: the main checkout of a registered project was asserted
// here as an ALLOW until T29 and is now a DENY. Everything T26 denied is still denied — a feature
// worktree resolves to the same registered repoRoot (subsumption), pinned below.
// The residual is asserted rather than hidden: this is COARSER than hooks/pre-push.mjs's rule 4
// (which lets an unrelated branch out of a managed repo), because a token scan cannot see refs.

test('T29: a raw push aimed at a REGISTERED repository is DENIED from its MAIN checkout', () => {
  const s = scenario();
  const reason = assertDenied(preTool(s, 'git push origin main', { cwd: join(s.base, 'repo') }), 'main checkout');
  assert.match(reason, /default\/fix-proj/, 'the MATCHED project must be named or the deny is unactionable');
  assert.match(reason, /legion finalize/, 'and the sanctioned path named');
  assert.doesNotMatch(reason, /feature worktree/i,
    'the rule is no longer about the launch cwd being a worktree, and the message must not say it is');
});

test('T29: a registered FEATURE WORKTREE is still denied — subsumed, not lost', () => {
  // The T26 behaviour, unchanged: the worktree's MAIN root is the registered repoRoot.
  const s = scenario();
  const reason = assertDenied(preTool(s, 'git push', { cwd: s.worktree }), 'feature worktree');
  assert.match(reason, /default\/fix-proj/);
});

test('T29: an UNREGISTERED repository is allowed, in silence — the operator\'s own work', () => {
  const s = scenario();
  assertAllowed(preTool(s, 'git push origin main', { cwd: unregisteredRepo(s) }), 'an unregistered repo');
});

test('T29: a directory in NO repository is allowed — git answering "not a repository" is an answer', () => {
  // LEGION_HOME is not a git repo. Every registered project IS one, so this cannot be registered:
  // an answer, not an unknown. (hooks/pre-push.mjs blocks the same failure, and correctly so —
  // git invoked IT from inside a repository, where the failure is anomalous rather than ordinary.)
  const s = scenario();
  assertAllowed(preTool(s, 'git push origin main', { cwd: s.home }), 'LEGION_HOME');
});

test('T29: the command\'s own `cd` decides, not the session cwd', () => {
  const s = scenario();
  const reg = join(s.base, 'repo');
  const un = unregisteredRepo(s);
  // Denied: an unregistered launch cwd, a `cd` into the managed repository. This is the shape the
  // whole widening exists for — under T26 the launch cwd alone decided and this walked through.
  const reason = assertDenied(preTool(s, `cd ${reg} && git push`, { cwd: un }), 'cd into a registered repo');
  assert.match(reason, /default\/fix-proj/);
  // Allowed: the mirror image — a registered launch cwd, a `cd` out of it. The command is about the
  // repository it names, and legion has no business with that one.
  assertAllowed(preTool(s, `cd ${un} && git push`, { cwd: reg }), 'cd out of a registered repo');
  // A relative `cd` folds against the payload cwd, exactly as the shell would.
  assert.match(
    assertDenied(preTool(s, 'cd ../repo && git push', { cwd: un }), 'a relative cd'),
    /default\/fix-proj/,
  );
});

test('T29: `-C` decides, and it BEATS a preceding `cd` in both directions', () => {
  const s = scenario();
  const reg = join(s.base, 'repo');
  const un = unregisteredRepo(s);
  assert.match(assertDenied(preTool(s, `git -C ${reg} push`, { cwd: un }), '-C at a registered repo'),
    /default\/fix-proj/);
  // -C applies to the git invocation itself, so it wins over the directory the segment runs in.
  assert.match(assertDenied(preTool(s, `cd ${un} && git -C ${reg} push`, { cwd: un }), '-C beats cd'),
    /default\/fix-proj/, 'the -C target is the repository this command writes to');
  assertAllowed(preTool(s, `cd ${reg} && git -C ${un} push`, { cwd: reg }), '-C beats cd, the other way');
});

test('T29: a target a token scan cannot evaluate is UNDECIDED, therefore DENIED', () => {
  const s = scenario();
  const un = unregisteredRepo(s);
  // The cwd is UNREGISTERED in every case here, so an allow is what a guard that silently fell back
  // to the payload cwd would produce — which is exactly the wrong answer to hide.
  for (const [command, cause] of [
    ['cd "$DIR" && git push', /\$DIR/],
    ['cd ~/somewhere && git push', /~\/somewhere/],
    ['cd && git push', /bare `cd`/],
    ['git -C "$REPO" push', /\$REPO/],
    ['git -C /no/such/dir/anywhere push', /\/no\/such\/dir\/anywhere.*does not exist/],
  ]) {
    const reason = assertDenied(preTool(s, command, { cwd: un }), command);
    assert.match(reason, cause, `${command}: the cause must be named — "could not decide" is unactionable`);
    assert.match(reason, /legion finalize/, `${command}: and the sanctioned path is still the remedy`);
  }
  // A later ABSOLUTE `cd` makes an earlier unevaluable one irrelevant, as it would in a shell.
  assertAllowed(preTool(s, `cd $D && cd ${un} && git push`, { cwd: un }), 'an absolute cd after an unevaluable one');
});

test('T29: glab is decided by the target repo, and `-R`/`--repo` is undecided anywhere', () => {
  const s = scenario();
  const un = unregisteredRepo(s);
  assert.match(assertDenied(preTool(s, 'glab mr create --fill', { cwd: join(s.base, 'repo') }), 'glab in a registered repo'),
    /default\/fix-proj/);
  assertAllowed(preTool(s, 'glab mr create --fill', { cwd: un }), 'glab in an unregistered repo');
  for (const command of ['glab -R o/p mr create --fill', 'glab --repo o/p mr create', 'glab --repo=o/p mr merge 12']) {
    const reason = assertDenied(preTool(s, command, { cwd: un }), command);
    assert.match(reason, /slug/, `${command}: a project named by slug has no path here, and that must be said`);
  }
});

test('T29: index ABSENT ⇒ allow; present but unreadable, malformed or ambiguous ⇒ deny naming it', () => {
  const idxOf = (s) => join(s.home, 'projects.json');
  const cwdOf = (s) => join(s.base, 'repo');

  const absent = scenario();
  rmSync(idxOf(absent), { force: true });
  assertAllowed(preTool(absent, 'git push', { cwd: cwdOf(absent) }), 'an absent index');

  const unreadable = scenario();
  writeFileSync(idxOf(unreadable), '{ this is not json\n');
  const u = assertDenied(preTool(unreadable, 'git push', { cwd: cwdOf(unreadable) }), 'an unreadable index');
  assert.match(u, /projects\.json/);
  assert.match(u, /unreadable/);

  const malformed = scenario();
  writeFileSync(idxOf(malformed), `${JSON.stringify({ version: 1, schemaVersion: 1, projects: {} })}\n`);
  assert.match(assertDenied(preTool(malformed, 'git push', { cwd: cwdOf(malformed) }), 'a malformed index'), /malformed/);

  const ambiguous = scenario();
  const idx = JSON.parse(readFileSync(idxOf(ambiguous), 'utf8'));
  idx.projects.push({ ...idx.projects[0], org: 'other' });
  writeFileSync(idxOf(ambiguous), `${JSON.stringify(idx, null, 2)}\n`);
  assert.match(
    assertDenied(preTool(ambiguous, 'git push', { cwd: cwdOf(ambiguous) }), 'an ambiguous registration'),
    /MORE THAN ONE legion project/,
  );
});

test('T29: an ambient GIT_DIR/GIT_WORK_TREE at ANOTHER repo never re-aims the guard', () => {
  // The in-scope hostile environment (kernel/git.mjs header E, the same case
  // test/cli/feature-hostile-env.test.mjs and test/git-hooks.test.mjs cover): resolution must come
  // from the TARGET PATH through the hardened seam, never from the environment.
  const s = scenario();
  const reg = join(s.base, 'repo');
  const un = unregisteredRepo(s);
  const aimedAt = (p) => ({ ...s.env, GIT_DIR: join(p, '.git'), GIT_WORK_TREE: p });

  const reason = assertDenied(preTool(s, 'git push', { cwd: reg }, aimedAt(un)), 'GIT_* at an unregistered repo');
  assert.match(reason, /default\/fix-proj/, 'the ambient env must not talk the guard out of the deny');
  assertAllowed(preTool(s, 'git push', { cwd: un }, aimedAt(reg)), 'GIT_* at the registered repo');
});

test('PreToolUse fails CLOSED once the scan has matched — an unusable cwd', () => {
  // Past the match the direction inverts: the question is no longer "is anything wrong" but
  // "is this the one place we may not allow", and unknown ⇒ refuse. The payload cwd is required
  // even when the command carries a `-C`, because it is what a relative path folds against.
  const s = scenario();
  for (const [cwd, what, cause] of [
    [undefined, 'no cwd', /carries no `cwd`/],
    ['/no/such/dir/anywhere', 'a cwd that does not exist', /\/no\/such\/dir\/anywhere does not exist/],
  ]) {
    const reason = assertDenied(preTool(s, 'git push', { cwd }), what);
    assert.match(reason, cause, `${what}: "could not decide" without the cause is unactionable`);
    assert.match(reason, /legion finalize/, `${what}: and the sanctioned path is still the remedy`);
  }
});

test('PreToolUse decides on the REGISTRATION, so a corrupt dossier neither blinds nor decides it', () => {
  // T26 read the dossier (via resolveFeature) and denied on `corrupt`; T29 never looks at it — the
  // registered repoRoot is the whole question. Both halves are pinned, because the second is what
  // a reader would otherwise have to guess: a corrupt dossier in a registered repository is STILL
  // denied (by registration), and R9's forbidden rendering never appears either way.
  const s = scenario();
  writeFileSync(join(s.dossier, 'feature.json'), '{ this is not json\n');
  const c = preTool(s, 'git push', { cwd: s.worktree });
  assert.match(assertDenied(c, 'corrupt feature.json in a registered repo'), /default\/fix-proj/);
  assert.doesNotMatch(c.stderr, /not a legion feature/i);
  // And in a repository nobody registered, a corrupt dossier is not a reason to speak at all.
  assertAllowed(preTool(s, 'git push', { cwd: unregisteredRepo(s) }), 'unregistered, corrupt dossier');
});
