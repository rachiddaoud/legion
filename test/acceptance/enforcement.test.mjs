// enforcement.test.mjs — THE ACCEPTANCE CRITERIA FOR T12, T13 AND T14, written before the fixer
// sees them (red-loop-first applied to a chunk instead of a task). Each criterion asserts the
// DESIRED POST-FIX behaviour and is marked `{ todo: '<the task that flips it>' }`, so one that is
// not met yet reports as todo — `node --test` stays at exit 0 and still prints the assertion diff.
// THE CHUNK EXIT CONDITION IS ZERO REMAINING TODOS IN THIS FILE: a todo flipped to a passing
// assertion is how a later task proves it landed, and a todo that passes ALREADY is a finding (the
// case was written for behaviour that was never missing), not a convenience.
//
// A FEW TESTS HERE ARE ORDINARY, NOT TODO, and the distinction is deliberate: they assert behaviour
// that is already correct and that T12-T14 must PRESERVE while they change the code underneath.
// They are the other jaw of the vice — C1/C2 prove the harness itself works, and 10c-content stops
// the fix for 10c's deadlock from narrowing the plan subject too far. Making one of them a todo
// would be claiming a defect that is not there.
//
// HOW TO READ A RUN: a failing todo prints under `✖ failing tests:` with its diff and is counted
// under `todo`, never under `fail`. A todo that PASSES prints as `✔ <name> # <task>` and does NOT
// appear in that block — that absence is the signal to report it as a finding.
//
// EVERY CASE DRIVES THE REAL bin/legion.mjs END TO END and asserts BOTH the refusal AND that no
// state moved, by reading the manifests back (h.assertUnmoved compares manifest BYTES: a refused
// op must write nothing, and a revision bump with the visible field unchanged is still state that
// moved). Fixture, isolation and hermeticity rules live in test/helpers/fixture.mjs.
//
// THE TWO PRINCIPLES THE T13/T14 CASES ENCODE (PLAN-V3 §State, "Facts, not judgments"):
//   1. Manifests store FACTS; conclusions are PREDICATES RE-DERIVED where they gate something.
//      `stageHistory`/`completedStages` are an audit trail and never authority — which is why
//      several cases below deliberately forge the stored stage or reach `finalize` legitimately
//      and then break an EARLIER stage: every op that advances or closes the lifecycle
//      (`stage-enter` forward, `stage-complete`, `close delivered`, `legion finalize`) must
//      re-derive the WHOLE prefix from intake. There is no completion-clearing mechanism to
//      test, because nothing was ever trusted.
//   2. Evidence binds to exactly what was judged — NO WIDER, NO NARROWER, and both failures are
//      asserted here. Too narrow: a plan review bound to the worktree tree survives the plan edit
//      it should have died on, because plan.md and tasks.json live in the dossier and change
//      without the tree moving (case 10b). Too wide, and this one DEADLOCKS the lifecycle: a plan
//      approval whose subject hashes whole task rows is invalidated by `task-start`, so under
//      corollary 1 the first task started strands the feature forever — the subject must cover
//      plan.md plus `planContent`'s six-field projection of the rows (case 10c). A subject hash covers precisely
//      the bytes a human or a reviewer assented to: include less and stale evidence survives a
//      real change, include more and ordinary work destroys valid evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, fixture, planTask } from '../helpers/fixture.mjs';
// The evidence-only walk and its drivers moved to test/helpers/lifecycle.mjs when T21 added a
// second acceptance file: two copies of a walk that encodes T13's prerequisite table is two places
// for that table to drift. The definitions are unchanged — see that file's header.
import { advanceTo, ok, recordPlanCritic, satisfyReviews, taskRow } from '../helpers/lifecycle.mjs';

// --- shared drivers -------------------------------------------------------------------------

// test/acceptance/x -> the repo root = the DEVELOPMENT plugin root the launch line must name
// (T17; PLAN-V3 §Startup step 5). Derived here, independently of the CLI's own derivation.
const PLUGIN_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const builderStop = (h, extra = {}) => ({
  hook_event_name: 'SubagentStop',
  agent_type: 'legion:builder',
  agent_id: 'a1',
  agent_transcript_path: '/dev/null',
  stop_hook_active: false,
  cwd: h.worktree,
  ...extra,
});

/** POSIX single-quote escaping — the form PLAN-V3 §Startup step 5 requires of the launch line. */
const sq = (s) => `'${s.replaceAll("'", "'\\''")}'`;

/** A minimal POSIX word-splitter: enough to prove what argv a shell would hand `claude`.
 * Single quotes are literal (the `'\''` idiom is close + escaped quote + reopen and falls out of
 * this loop naturally), double quotes honour backslash escapes, and a bare backslash escapes.
 * NOTHING IS EXECUTED — the emitted command must never run, which is the case's whole point. */
function shellWords(line) {
  const words = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "'") {
      const end = line.indexOf("'", i + 1);
      assert.notEqual(end, -1, `unterminated single quote in: ${line}`);
      cur += line.slice(i + 1, end); has = true; i = end + 1; continue;
    }
    if (c === '"') {
      i += 1;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) { cur += line[i + 1]; i += 2; continue; }
        cur += line[i]; i += 1;
      }
      assert.equal(line[i], '"', `unterminated double quote in: ${line}`);
      has = true; i += 1; continue;
    }
    if (c === '\\' && i + 1 < line.length) { cur += line[i + 1]; i += 2; has = true; continue; }
    if (c === ' ' || c === '\t') { if (has) { words.push(cur); cur = ''; has = false; } i += 1; continue; }
    cur += c; has = true; i += 1;
  }
  if (has) words.push(cur);
  return words;
}

const THREE = [planTask('T1'), planTask('T2'), planTask('T3')];

/** A gate command that PROVES it ran, by writing `file` before exiting green. "The refusal
 * happened before anything was spawned" is then a FACT — the sentinel does not exist — instead of
 * an inference from log wording, which would couple the criterion to a message T12 is free to
 * rewrite. The sentinel lives in the sandbox, never in the worktree: writing into the worktree
 * would dirty the tree and trip a different guard entirely. */
const sentinelCmd = (file) => ({
  argv: [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(file)}, 'ran\\n')`],
  timeoutMs: 30_000,
});
/** The PINNED policy: one command, which writes the sentinel. */
const sentinelPolicy = (file) => ({ commands: { test: sentinelCmd(file) }, task: ['test'], boundary: ['test'] });
/** The DRIFTED policy: the same command plus a second declared one — the drift the spec names. */
const driftedPolicy = (file, tier) => ({
  commands: { test: sentinelCmd(file), extra: sentinelCmd(file) },
  task: tier === 'task' ? ['test', 'extra'] : ['test'],
  boundary: tier === 'boundary' ? ['test', 'extra'] : ['test'],
});

// --- 1. (T12) receipts have exactly one minter ----------------------------------------------

// WHAT THIS CASE COVERS, AND WHAT IT DOES NOT — stated because the title is broader than the
// three assertions, which is the failure this file's own header warns about (T12b/B5):
//   (a) the ADVERTISED op list carries no receipt writer — the RETIRED TYPED OP, surface one;
//   (b) it is not DISPATCHABLE either — the same retired op, surface two, the half a usage edit
//       alone would fake;
//   (c) a RED gate leaves nothing to consume, so task-done refuses — the MISSING-RECEIPT path.
// The HAND-WRITTEN MANIFEST path — a caller with Bash writing tasks.json directly, which is how
// the R1 bypass was actually demonstrated — is covered by case 1b, not here. And the RESIDUAL is
// open BY DESIGN: a forger who COPIES the pinned policy (names, order, argv) out of feature.json —
// or who rewrites both halves of the pin to the empty policy and claims zero commands — still
// produces a receipt that passes provenance, because every input the check has is readable and
// WRITABLE in the same directory by the same shell. That is stated in src/cli/gate.mjs's header,
// and prevention of it is claimed nowhere. ("reconstructs the whole pinned policy" stood here and
// overstated the cost: the list is stored in feature.json, so nothing has to be reconstructed.)
test('1 (T12) no path outside `legion gate` can produce a receipt that closes a task', () => {
  const h = fixture({ gates: 'RED' });
  h.seedPlan(THREE);

  // (a) the ADVERTISED op list must not carry a receipt writer — `legion state` with no op is
  // the router's own usage, generated from STATE_OPS, so this is the authority, not a copy.
  const usage = h.legion('state');
  assert.equal(usage.code, 1, 'a bare `legion state` must fail closed');
  assert.doesNotMatch(usage.stderr, /receipt-record/,
    'PLAN-V3 §State: there is NO receipt-record op — it must not be advertised anywhere');

  // (b) and it must not be dispatchable, which is the half a usage edit alone would fake.
  const snap = h.snapshot();
  const rec = h.legion('state', 'receipt-record', '--task', 'T1');
  assert.notEqual(rec.code, 0, 'receipt-record must not be a dispatchable op');
  assert.match(rec.stderr, /unknown state op/, 'the refusal must be the router\'s unknown-op refusal');
  assert.equal(taskRow(h, 'T1').receipt, undefined, 'nothing may have been recorded on T1');
  h.assertUnmoved(snap, 'a refused receipt-record');

  // (c) and after a RED gate there is no receipt to consume, so task-done refuses.
  h.commit('T1: work');
  ok(h, 'case1', 'state', 'task-start', 'T1');
  const g = h.legion('gate', 'run', '--task', 'T1');
  assert.equal(g.code, 1, `the RED gate must fail: ${g.stdout}`);
  const snap2 = h.snapshot();
  const done = h.legion('state', 'task-done', 'T1');
  assert.equal(done.code, 1, 'task-done must refuse without a receipt');
  assert.match(done.stderr, /receipt/);
  assert.equal(taskRow(h, 'T1').status, 'started', 'the task must not have closed');
  h.assertUnmoved(snap2, 'a refused task-done');
});

// --- 1b. (T12b) naming the pinned policy HASH without reproducing its commands is not evidence --
// THE TITLE IS THE CLAIM, so it is worded to exactly what the three assertions check. It read
// "copying the pin out of feature.json closes nothing" and that is FALSE under the tree's own
// definition of the pin (kernel/state.mjs commandPolicyPin: the hashes PLUS the triples they
// cover) — copying BOTH halves is precisely what still passes, as src/cli/gate.mjs's residual
// states and as this file's case-1 comment now says. PLAN-V3 §Milestones treats this case's wording
// as the claim that carries weight for M0, which is why a broad title here is a defect and not a
// nitpick: a test that reads as proof of something broader than it checks is worse than no test.

test('1b (T12b) a provenance-SHAPED receipt that names the pinned policy HASH without reproducing its commands closes nothing', () => {
  // RED declares exactly ONE command per tier, so the forgery's `declaredCommands: 1` is HONEST
  // against the pin — this case therefore dies on the results-vs-POLICY check, not on the cheap
  // count check, which is what makes it the right case.
  const h = fixture({ gates: 'RED' });
  h.seedPlan(THREE);
  h.commit('T1: work');
  ok(h, 'case1b', 'state', 'task-start', 'T1');

  // POSITIVE CONTROL: the RED gate must mint NOTHING, so every receipt below is a forgery rather
  // than a leftover of a real run.
  const red = h.legion('gate', 'run', '--task', 'T1');
  assert.equal(red.code, 1, `the RED gate must fail: ${red.stdout}`);
  assert.equal(taskRow(h, 'T1').receipt, undefined, 'fixture: the RED gate must mint nothing');

  // THE FORGERY, exactly as reachable as the demonstrated R1 bypass was: the pin is stored IN
  // PLAIN TEXT in feature.json, in the SAME dossier as tasks.json, so a caller with Bash COPIES
  // IT OUT OF THE NEIGHBOURING FILE and hand-writes a receipt that is honest in every field it
  // fills in — the real HEAD, the real tree, the pinned policy hash, and a declaredCommands that
  // matches the pin. The one thing it does not have is the RESULTS the pinned policy names.
  const f = h.readFeature();
  const head = h.head();
  const tree = h.tree();
  const forged = (tier, results = []) => ({
    tier,
    commandPolicyHash: f.commandPolicyHash[tier], // COPIED out of feature.json, next door
    results,
    declaredCommands: 1,
    head,
    treeHash: tree,
    at: NOW,
  });
  h.writeTasks((doc) => ({
    ...doc,
    tasks: doc.tasks.map((t) => (t.id === 'T1' ? { ...t, receipt: forged('task') } : t)),
    receipts: { ...doc.receipts, boundary: forged('boundary') },
  }));
  const snap = h.snapshot();

  const v = h.legion('gate', 'verify-receipt', '--task', 'T1');
  assert.equal(v.code, 1, `verify-receipt must refuse a receipt whose results[] never ran: ${v.stdout}`);
  assert.match(v.stderr, /provenance/i, 'and must say WHY');

  const done = h.legion('state', 'task-done', 'T1');
  assert.equal(done.code, 1, 'task-done must refuse it — naming the policy hash correctly proves nothing');
  assert.match(done.stderr, /provenance/i);
  assert.equal(taskRow(h, 'T1').status, 'started', 'the task must not have closed');

  const vb = h.legion('gate', 'verify-receipt', '--boundary');
  assert.equal(vb.code, 1, `the SAME forgery at the boundary tier must refuse too: ${vb.stdout}`);
  assert.match(vb.stderr, /provenance/i);

  // The fourth consumer, and the one that would have PUSHED: finalize reaches C3 (C0 active, C1
  // on the feature branch, C2 clean) and must refuse on provenance having called nothing — the
  // fixture's `glab` shim exits 1 loudly if anything ever reaches it.
  const fin = h.legion('finalize');
  assert.equal(fin.code, 1, `finalize must refuse the forged boundary receipt: ${fin.stdout}`);
  assert.match(fin.stderr, /GATE PROVENANCE/);
  assert.doesNotMatch(fin.stderr, /must never be invoked/,
    'it must refuse BEFORE reaching glab (the fixture shim proves it never got there)');

  h.assertUnmoved(snap, 'four refusals over a pin-copying forgery');

  // SECOND ROUND, and it pins the argv comparison end to end: the forgery gets closer — the right
  // NAME, the right COUNT, exit 0 — but an argv the pinned policy does not declare. results[] must
  // REPRODUCE the pinned command list, not merely carry one plausible entry per declared command.
  h.writeTasks((doc) => ({
    ...doc,
    tasks: doc.tasks.map((t) => (t.id === 'T1'
      ? { ...t, receipt: forged('task', [{ name: 'test', argv: ['definitely', 'not', 'the', 'pinned', 'argv'], exitCode: 0, ms: 1 }]) }
      : t)),
  }));
  const snap2 = h.snapshot();
  const done2 = h.legion('state', 'task-done', 'T1');
  assert.equal(done2.code, 1, 'an argv the pinned policy does not declare is not evidence of the pinned policy');
  assert.match(done2.stderr, /provenance/i);
  assert.equal(taskRow(h, 'T1').status, 'started');
  h.assertUnmoved(snap2, 'a refused task-done over a wrong-argv forgery');
});

// --- 2. (T12) a receipt without gate provenance is not a receipt ------------------------------

test('2 (T12) a rev-4-shaped receipt (no gate provenance) closes nothing', () => {
  const h = fixture();
  h.seedPlan(THREE);
  h.commit('T1: work');
  ok(h, 'case2', 'state', 'task-start', 'T1');

  // The forgery a caller can actually perform: {treeHash, commit, at} and nothing else, for the
  // CURRENT tree. Written by hand because `plan check --import` strips `receipt` — this is the
  // exact shape the demonstrated R1 bypass minted through the retired typed op.
  const tree = h.tree();
  const head = h.head();
  h.writeTasks((doc) => ({
    ...doc,
    tasks: doc.tasks.map((t) => (t.id === 'T1' ? { ...t, receipt: { treeHash: tree, commit: head, at: '2026-07-25T00:00:00.000Z' } } : t)),
  }));
  const snap = h.snapshot();

  const v = h.legion('gate', 'verify-receipt', '--task', 'T1');
  assert.equal(v.code, 1, 'verify-receipt must refuse a receipt no gate issued');
  assert.match(v.stderr, /provenance/i, 'and must say WHY: the receipt carries no gate provenance');

  const done = h.legion('state', 'task-done', 'T1');
  assert.equal(done.code, 1, 'task-done must refuse it too — the tree being real proves nothing');
  assert.match(done.stderr, /provenance/i);
  assert.equal(taskRow(h, 'T1').status, 'started');
  h.assertUnmoved(snap, 'two refusals over a forged receipt');
});

// --- 3. (T12) the PINNED policy model, in three assertions ------------------------------------

test('3 (T12) policy drift refuses the RUN while the earned receipt still certifies, until a re-pin', () => {
  const h = fixture({ gates: ({ sandbox }) => sentinelPolicy(join(sandbox, 'gate-ran.txt')) });
  const sentinel = join(h.sandbox, 'gate-ran.txt');
  h.seedPlan(THREE);
  h.commit('T1: work');
  ok(h, 'case3', 'state', 'task-start', 'T1');
  ok(h, 'case3', 'gate', 'run', '--task', 'T1'); // a genuinely earned receipt under the pinned policy
  // POSITIVE CONTROL: the sentinel really does appear when a gate command runs, so its absence
  // below means something. Then clear it, so the next run starts from nothing.
  assert.ok(existsSync(sentinel), 'the pinned policy\'s command must have run and written its sentinel');
  rmSync(sentinel);

  // Drift: a SECOND declared task command appears in the live project config.
  h.setGates(driftedPolicy(sentinel, 'task'));

  // (a) the RUN refuses, and BEFORE spawning anything.
  const snapA = h.snapshot();
  const run = h.legion('gate', 'run', '--task', 'T1');
  assert.equal(run.code, 1, 'live policy != pinned policy must refuse the run');
  assert.match(run.stderr, /pin|drift/i, 'the refusal must name the drift');
  assert.equal(existsSync(sentinel), false,
    'the refusal must precede any spawned gate command — every declared command writes this sentinel');
  h.assertUnmoved(snapA, 'a refused gate run');

  // (b) CONSUMPTION compares against the FEATURE PIN, which has not moved — the receipt earned
  // under the pinned policy still closes its task. This is the half a live-policy comparison
  // would get wrong.
  const done = h.legion('state', 'task-done', 'T1');
  assert.equal(done.code, 0, `the earned receipt must still certify: ${done.stderr}`);
  assert.equal(taskRow(h, 'T1').status, 'done');

  // (c) the deliberate re-pin supersedes it: the old receipt carries the old policy hash. The
  // re-pin is an EXPLICIT FLAG, not a recorded approval — the `policy-change` approval kind was cut
  // on 2026-07-25 as ceremony (the operator of this tool is the human who edits the config, so an
  // approval artifact gating their own edit buys nothing an honest refusal does not).
  // It is taken on a DIFFERENT task deliberately: re-gating T1 would mint it a fresh receipt under
  // the NEW pin, and the assertion below would then be vacuous.
  const rp = h.legion('gate', 'run', '--task', 'T2', '--repin');
  assert.equal(rp.code, 0, `\`gate run --repin\` must record the live policy as the new pin and proceed: ${rp.stderr}`);
  const v = h.legion('gate', 'verify-receipt', '--task', 'T1');
  assert.equal(v.code, 1, 'after a re-pin the receipt earned under the OLD policy no longer certifies');
  // …and it must refuse FOR THAT REASON. Without this, the assertion above could go green merely
  // because the task is already `done`, or on any unrelated refusal.
  assert.match(v.stderr, /pin|superseded|policy/i, 'the refusal must name the superseded policy hash');
});

// --- 6d. (T12) the same drift refusal at the boundary tier ------------------------------------

test('6d (T12) `gate run --boundary` refuses on live-vs-pinned drift before spawning anything', () => {
  const h = fixture({ gates: ({ sandbox }) => sentinelPolicy(join(sandbox, 'gate-ran.txt')) });
  const sentinel = join(h.sandbox, 'gate-ran.txt');
  h.seedPlan(THREE);
  h.commit('boundary work');
  // POSITIVE CONTROL first: under the PINNED policy the boundary tier runs and leaves the
  // sentinel, so its absence after the drifted run is evidence rather than an assumption.
  ok(h, 'case6d', 'gate', 'run', '--boundary');
  assert.ok(existsSync(sentinel), 'the pinned boundary policy must have run');
  rmSync(sentinel);
  const certified = h.head(); // the HEAD that receipt legitimately certifies
  h.setGates(driftedPolicy(sentinel, 'boundary'));

  const newHead = h.commit('more boundary work'); // a new HEAD the old receipt cannot cover
  const snap = h.snapshot();
  const r = h.legion('gate', 'run', '--boundary');
  assert.equal(r.code, 1, 'the boundary tier must refuse under drift too');
  assert.match(r.stderr, /pin|drift/i, 'naming the drift');
  assert.equal(existsSync(sentinel), false,
    'the refusal must precede any spawned gate command — every declared command writes this sentinel');
  assert.equal(h.readTasks().receipts.boundary.head, certified,
    `no receipt may be written for the ungated HEAD ${newHead}`);
  h.assertUnmoved(snap, 'a refused boundary gate run');

  // `--repin` is what permits the re-pin: an explicit operator flag that records the LIVE policy as
  // the new pin and proceeds, with the receipt carrying the policy it actually ran under. There is
  // no approval kind here — `policy-change` was cut on 2026-07-25 as ceremony, since the operator
  // of this tool is the human who edits the config. Pinning itself stays: it is what stops an agent
  // quietly weakening the gate to pass a task.
  const repin = h.legion('gate', 'run', '--boundary', '--repin');
  assert.equal(repin.code, 0, `--repin must re-pin the live policy and then run: ${repin.stderr}`);
  assert.ok(existsSync(sentinel), 'and this time the declared commands really do run');
  assert.equal(h.readTasks().receipts.boundary.head, newHead, 'and the receipt certifies the HEAD it gated');
});

// --- 4. (T12) a corrupt dossier is never silent ----------------------------------------------

test('4 (T12) the builder hook distinguishes corrupt, absent and unregistered — only one is silent', () => {
  // (a) CORRUPT tasks.json: loud. Rendering it as "not a legion feature" turns a broken dossier
  // into a session with no gate at all (R9), and hooks/_common.mjs's own header says the ONLY
  // sanctioned silence is an unregistered cwd.
  const h = fixture();
  h.seedPlan(THREE);
  ok(h, 'case4', 'state', 'task-start', 'T1');
  h.corrupt('tasks');
  const corruptTasks = h.fireHook('builder-receipt', builderStop(h));
  assert.ok(corruptTasks.code !== 0 || corruptTasks.stderr.trim() !== '',
    'a corrupt tasks.json must NOT be silent');
  assert.match(corruptTasks.stderr, /tasks\.json/, 'the corruption must be named');
  assert.doesNotMatch(corruptTasks.stderr, /not a legion feature/i);

  // (b) CORRUPT feature.json: loud, for the same reason.
  const h2 = fixture();
  h2.seedPlan(THREE);
  ok(h2, 'case4', 'state', 'task-start', 'T1');
  h2.corrupt('feature');
  const corruptFeature = h2.fireHook('builder-receipt', builderStop(h2));
  assert.ok(corruptFeature.code !== 0 || corruptFeature.stderr.trim() !== '',
    'a corrupt feature.json must NOT be silent');
  assert.match(corruptFeature.stderr, /feature\.json/, 'the corruption must be named');
  assert.doesNotMatch(corruptFeature.stderr, /not a legion feature/i);

  // (c) ABSENT tasks.json: an ordinary early stage, before `legion state init`. Silent.
  const h3 = fixture({ stateInit: false });
  const absent = h3.fireHook('builder-receipt', builderStop(h3));
  assert.equal(absent.code, 0, 'an early-stage feature must not block a subagent');
  assert.equal(absent.stdout, '');
  assert.equal(absent.stderr, '', 'and must say nothing at all');

  // (d) UNREGISTERED cwd: the one sanctioned silence (this plugin loads in every session).
  const unregistered = h3.fireHook('builder-receipt', builderStop(h3, { cwd: h3.repoRoot }));
  assert.equal(unregistered.code, 0);
  assert.equal(unregistered.stdout, '');
  assert.equal(unregistered.stderr, '');
});

// --- 5. (T13) stage order, four distinct assertions -------------------------------------------

test('5a (T13) `stage-enter finalize` from intake is refused, naming the expected next stage', () => {
  const h = fixture();
  const snap = h.snapshot();
  const r = h.legion('state', 'stage-enter', 'finalize');
  assert.equal(r.code, 1, 'a forward jump over the whole lifecycle must refuse');
  assert.match(r.stderr, /spec/, 'the refusal must name the expected next stage');
  assert.equal(h.readFeature().stage, 'intake');
  h.assertUnmoved(snap, 'a refused stage-enter');
});

test('5b (T13) the one-hop-at-a-time WALK is refused at the FIRST forward hop', () => {
  const h = fixture();
  const snap = h.snapshot();
  // This walk is how every prerequisite gets skipped while stageHistory stays perfectly ordered:
  // stepping to the NEXT stage each time, never calling stage-complete.
  const first = h.legion('state', 'stage-enter', 'spec');
  assert.equal(first.code, 1, 'forward entry requires the prefix to re-derive satisfied, not merely to be ordered');
  assert.match(first.stderr, /intake/, 'the refusal must name the unsatisfied stage');
  assert.equal(h.readFeature().stage, 'intake');
  h.assertUnmoved(snap, 'the first refused hop');
  for (const s of ['plan', 'build', 'review', 'pre-merge', 'finalize']) {
    assert.equal(h.legion('state', 'stage-enter', s).code, 1, `stage-enter ${s} from intake must refuse`);
    // Per hop, not merely at the end: a refusal that appended to stageHistory on its way out
    // would leave the audit trail claiming a hop that never happened.
    h.assertUnmoved(snap, `a refused stage-enter ${s}`);
  }
  assert.equal(h.readFeature().stage, 'intake', 'no hop may have landed');
});

test('5c (T13) backward re-entry is free, and forward entry afterwards depends ONLY on the evidence', () => {
  const h = fixture();
  advanceTo(h, 'review');

  // Backward: always allowed and recorded. Nothing needs clearing, because nothing was trusted —
  // there is no clearing mechanism in the design and therefore none to test here.
  ok(h, 'case5c', 'state', 'stage-enter', 'plan');
  assert.equal(h.readFeature().stage, 'plan');

  // Half one: unchanged evidence ⇒ the round trip costs nothing. "Unchanged" is exact here, and
  // worth spelling out: this feature has been through the build stage, so its task rows carry
  // progress (status, receipts, timestamps) — and that progress is outside the plan approval's
  // subject BY SPEC (PLAN-V3 §State corollary 2, pinned by case 10c). Nothing a human assented to
  // has moved, so the forward hop must re-derive true.
  ok(h, 'case5c', 'state', 'stage-enter', 'build');
  ok(h, 'case5c', 'state', 'stage-enter', 'plan');

  // Half two: the plan artifact is re-recorded with NEW content, so the plan approval invalidates
  // and the same forward hop must now refuse.
  h.writeArtifact('plan.md', '# plan\na materially different plan\n');
  ok(h, 'case5c', 'state', 'artifact-record', 'plan', 'plan.md');
  const snap = h.snapshot();
  const fwd = h.legion('state', 'stage-enter', 'build');
  assert.equal(fwd.code, 1, 'a changed plan invalidates its approval, so forward entry must refuse');
  assert.match(fwd.stderr, /plan/, 'the refusal must name the stage whose evidence went');
  assert.equal(h.readFeature().stage, 'plan');
  h.assertUnmoved(snap, 'a refused forward hop after invalidation');
});

test('5d (T13) staleness at an OLDER stage refuses the next forward hop — the prefix re-derives from intake', () => {
  const h = fixture();
  advanceTo(h, 'build');

  // From build, invalidate the SPEC approval — two stages back, already "completed", and nothing
  // about the plan or the build changes.
  h.writeArtifact('spec.md', '# spec\nthe scope moved materially\n');
  ok(h, 'case5d', 'state', 'artifact-record', 'spec', 'spec.md');
  assert.ok(!h.readTasks().approvals.spec, 'the spec approval must have fallen with its subject');

  const snap = h.snapshot();
  const r = h.legion('state', 'stage-enter', 'review');
  assert.equal(r.code, 1, 'the whole prefix is re-derived, not merely the current stage');
  assert.match(r.stderr, /spec/, 'the refusal must name the stale EARLIER stage');
  assert.equal(h.readFeature().stage, 'build');
  h.assertUnmoved(snap, 'a refused hop over a stale earlier stage');
});

// --- 6 / 6b / 6c / 6e. (T13) stage completion and close ---------------------------------------

test('6 (T13) `stage-complete build` refuses while a task is pending or blocked, and accepts once all are done', () => {
  const h = fixture();
  advanceTo(h, 'build', { tasks: THREE });

  // pending
  let snap = h.snapshot();
  let r = h.legion('state', 'stage-complete', 'build');
  assert.equal(r.code, 1, 'a pending task is an unfinished build');
  assert.match(r.stderr, /T1|T2|T3|pending/, 'the refusal must name what is unfinished');
  h.assertUnmoved(snap, 'a refused stage-complete build (pending)');

  // Close T1 and T2 for real, then BLOCK T3. No typed op writes `blocked` — the build workflow
  // reports it as data (PLAN-V3 decision 11), so the row is written by hand here; T13 must treat
  // any non-`done` status as an unfinished build rather than special-casing `pending`.
  for (const id of ['T1', 'T2']) {
    ok(h, `case6 ${id}`, 'state', 'task-start', id);
    h.commit(`${id}: work`);
    ok(h, `case6 ${id}`, 'gate', 'run', '--task', id);
    ok(h, `case6 ${id}`, 'state', 'task-done', id);
  }
  h.writeTasks((doc) => ({
    ...doc,
    tasks: doc.tasks.map((t) => (t.id === 'T3' ? { ...t, status: 'blocked' } : t)),
  }));
  snap = h.snapshot();
  r = h.legion('state', 'stage-complete', 'build');
  assert.equal(r.code, 1, 'a blocked task is an unfinished build');
  assert.match(r.stderr, /T3|blocked/);
  h.assertUnmoved(snap, 'a refused stage-complete build (blocked)');

  // Accepted once every task is genuinely done.
  h.writeTasks((doc) => ({
    ...doc,
    tasks: doc.tasks.map((t) => (t.id === 'T3' ? { ...t, status: 'pending' } : t)),
  }));
  ok(h, 'case6 T3', 'state', 'task-start', 'T3');
  h.commit('T3: work');
  ok(h, 'case6 T3', 'gate', 'run', '--task', 'T3');
  ok(h, 'case6 T3', 'state', 'task-done', 'T3');
  ok(h, 'case6', 'state', 'stage-complete', 'build');
});

test('6b (T13) `stage-complete intake` refuses without an intent artifact, without a hash-valid approval, and while unclassified', () => {
  const h = fixture();

  // (a) no intent artifact at all.
  let snap = h.snapshot();
  let r = h.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 1, 'intake is where recap-and-agreement becomes enforceable');
  assert.match(r.stderr, /intent/, 'the refusal must name the missing artifact');
  h.assertUnmoved(snap, 'a refused stage-complete intake (no artifact)');

  // (b) an artifact and an approval, then the artifact CHANGES: the approval is no longer
  // hash-valid, and presence is not validity.
  const intent = h.writeArtifact('intent.md', '# intent\nv1\n');
  ok(h, 'case6b', 'state', 'artifact-record', 'intent', 'intent.md');
  ok(h, 'case6b', 'state', 'decision-record', 'intake');
  ok(h, 'case6b', 'state', 'escalate-profile', 'express');
  writeFileSync(intent, '# intent\nv2 — materially different\n');
  snap = h.snapshot();
  r = h.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 1, 'a recorded approval whose subject moved is not a valid approval');
  assert.match(r.stderr, /approval|intake/i);
  h.assertUnmoved(snap, 'a refused stage-complete intake (stale approval)');

  // (c) evidence repaired, but the profile is still unclassified: intake is the LAST moment
  // classification can happen before prerequisites start depending on it.
  const h2 = fixture();
  h2.writeArtifact('intent.md', '# intent\nv1\n');
  ok(h2, 'case6b', 'state', 'artifact-record', 'intent', 'intent.md');
  ok(h2, 'case6b', 'state', 'decision-record', 'intake');
  assert.equal(h2.readFeature().profile, 'unclassified');
  snap = h2.snapshot();
  r = h2.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 1, 'an unclassified feature cannot complete intake');
  assert.match(r.stderr, /unclassified|profile/i);
  h2.assertUnmoved(snap, 'a refused stage-complete intake (unclassified)');

  ok(h2, 'case6b', 'state', 'escalate-profile', 'standard');
  ok(h2, 'case6b', 'state', 'stage-complete', 'intake');
});

test('6c (T13) `close delivered` refuses outside the finalize stage even with every piece of evidence valid', () => {
  const h = fixture();
  advanceTo(h, 'finalize');
  const head = h.head();
  h.recordMr(head);

  // Backward re-entry clears no evidence — the boundary receipt, the pre-merge approval and the
  // recorded MR all still describe this HEAD. Only the stage is wrong, and that is the point.
  ok(h, 'case6c', 'state', 'stage-enter', 'plan');
  const t = h.readTasks();
  assert.equal(t.receipts.boundary.head, head, 'the boundary receipt is still for HEAD');
  assert.ok(t.approvals['pre-merge'], 'the pre-merge approval is still recorded');
  assert.equal(h.readFeature().mr.headSha, head, 'the MR is still recorded at HEAD');

  const snap = h.snapshot();
  const r = h.legion('state', 'close', 'delivered');
  assert.equal(r.code, 1, 'a feature moved back into plan must not close delivered on the old evidence');
  assert.match(r.stderr, /finalize/, 'the refusal must name the required stage');
  assert.equal(h.readFeature().status, 'active');
  h.assertUnmoved(snap, 'a refused close delivered');
});

test('6e (T13) reaching finalize once is not evidence: a raised review set refuses close AND finalize', () => {
  const h = fixture();
  advanceTo(h, 'finalize', { profile: 'express' });
  const head = h.head();
  h.recordMr(head);
  const before = h.readTasks();

  // Nothing about HEAD, the receipt, the reviews or the pre-merge approval changes — only the
  // REQUIREMENT does. `stageSatisfied(review)` must be re-derived, so both consumers refuse.
  ok(h, 'case6e', 'state', 'escalate-profile', 'full');
  const after = h.readTasks();
  assert.equal(h.head(), head, 'HEAD must not have moved');
  assert.deepEqual(after.receipts, before.receipts, 'the receipts must be untouched');
  assert.deepEqual(after.reviews, before.reviews, 'the reviews must be untouched');
  assert.deepEqual(after.approvals, before.approvals, 'the approvals must be untouched');
  assert.equal(h.readFeature().mr.headSha, head, 'the recorded MR must be untouched');

  const snap = h.snapshot();
  const closed = h.legion('state', 'close', 'delivered');
  assert.equal(closed.code, 1, 'close delivered must re-derive the whole prefix, not only its own evidence');
  assert.match(closed.stderr, /review|profile|full/i, 'the refusal must name the prefix stage that no longer re-derives');
  assert.equal(h.readFeature().status, 'active');
  h.assertUnmoved(snap, 'a refused close delivered after a profile escalation');

  // `legion finalize` is the other consumer, and it must refuse for the SAME reason rather than
  // pushing. It reaches no remote here: the MR recorded at this HEAD is the idempotence path.
  // ITS SNAPSHOT MATTERS MORE THAN ANY OTHER IN THIS FILE — finalize is the one writer of
  // feature.json outside src/kernel/state.mjs, so a refusing-but-mutating implementation would
  // slip through exactly here.
  const snapFin = h.snapshot();
  const fin = h.legion('finalize');
  assert.equal(fin.code, 1, 'finalize must refuse too — the lifecycle is not satisfied');
  assert.match(fin.stderr, /review|profile|full/i, 'and must name the same unsatisfied prefix stage');
  assert.doesNotMatch(fin.stderr, /must never be invoked/,
    'it must refuse BEFORE reaching glab (the fixture shim proves it never got there)');
  h.assertUnmoved(snapFin, 'a refused finalize');
});

test('6f a CLOSED feature accepts no stage transition — backward included', () => {
  // The amendment door (skills/feature/SKILL.md ## Amendments) is backward `stage-enter` on an
  // ACTIVE feature; after close, new work is a new feature. The ledgers are byte-frozen per
  // chunk, so this claim lives here rather than in a FIXTURE-LEDGER entry — deliberate.
  const h = fixture();
  advanceTo(h, 'review');

  // Positive control, asserted BEFORE the close so the test proves the door was open until it:
  // backward entry on an active feature is free (5c holds the full round-trip claim).
  ok(h, 'case6f', 'state', 'stage-enter', 'plan');
  assert.equal(h.readFeature().stage, 'plan');

  ok(h, 'case6f', 'state', 'close', 'abandoned');
  assert.equal(h.readFeature().status, 'abandoned');

  const snap = h.snapshot();
  for (const s of ['spec', 'build', 'review', 'pre-merge', 'finalize']) {
    const r = h.legion('state', 'stage-enter', s);
    assert.equal(r.code, 1, `stage-enter ${s} on a closed feature must refuse`);
    assert.match(r.stderr, /feature is closed \(status: abandoned\)/, 'the refusal must name the status');
    h.assertUnmoved(snap, `a refused stage-enter ${s} on a closed feature`);
  }
  assert.equal(h.readFeature().stage, 'plan', 'no hop may have landed');
});

// --- 7. (T13) the profile is load-bearing at review -------------------------------------------

test('7 (T13) `stage-complete review` refuses without the profile\'s review set, and an unclassified feature never completes review', () => {
  const h = fixture();
  advanceTo(h, 'review', { profile: 'standard' });
  assert.deepEqual(h.readTasks().reviews.filter((r) => r.role !== 'plan-critic'), [],
    'the case needs the required review set to be genuinely absent');

  const snap = h.snapshot();
  const r = h.legion('state', 'stage-complete', 'review');
  assert.equal(r.code, 1, 'the reviews the PROFILE requires must be present and passing');
  assert.match(r.stderr, /review/i, 'the refusal must say what is missing');
  h.assertUnmoved(snap, 'a refused stage-complete review');

  // The unclassified half, reached LEGITIMATELY so that classification is the only defect. The
  // feature walks to review for real and its required review set IS satisfied; only then is the
  // profile forged back to `unclassified`. Forging the STAGE instead would leave the whole prefix
  // unsatisfied, so a faithful T13 would refuse naming intake — and this case would then push the
  // implementer to reorder checks until the profile clause fired first, which is not the claim.
  const h2 = fixture();
  advanceTo(h2, 'review', { profile: 'standard' });
  satisfyReviews(h2);
  h2.writeFeature((f) => ({ ...f, profile: 'unclassified' }));
  const snap2 = h2.snapshot();
  const r2 = h2.legion('state', 'stage-complete', 'review');
  assert.equal(r2.code, 1, 'an unclassified feature cannot complete review at all — every stage past intake requires a member of {express, standard, full}');
  assert.match(r2.stderr, /unclassified|profile/i, 'and the refusal must name the profile');
  h2.assertUnmoved(snap2, 'a refused stage-complete review (unclassified)');
});

// --- 8. (T13) dependencies are enforced at EXECUTION ------------------------------------------

test('8 (T13) `task-start T2` refuses while its depends_on T1 is not done — even with T2 first in the file', () => {
  const h = fixture();
  // T2 FIRST: order in the file must never be load-bearing (PLAN-V3 decision 2).
  h.seedPlan([planTask('T2', { depends_on: ['T1'] }), planTask('T1'), planTask('T3')]);
  assert.equal(h.readTasks().tasks[0].id, 'T2', 'the fixture must really put the dependent task first');

  const snap = h.snapshot();
  const r = h.legion('state', 'task-start', 'T2');
  assert.equal(r.code, 1, 'acyclic-at-import is a property of the graph; "T1 before T2" is a property of the run');
  assert.match(r.stderr, /T1/, 'the refusal must name the unmet dependency');
  assert.equal(taskRow(h, 'T2').status, 'pending');
  h.assertUnmoved(snap, 'a refused task-start');

  // Once T1 is genuinely done, T2 starts.
  ok(h, 'case8', 'state', 'task-start', 'T1');
  h.commit('T1: work');
  ok(h, 'case8', 'gate', 'run', '--task', 'T1');
  ok(h, 'case8', 'state', 'task-done', 'T1');
  ok(h, 'case8', 'state', 'task-start', 'T2');
});

// --- 9. (T14) plan check rejects ids the kernel would later refuse -----------------------------

test('9 (T14) `plan check` rejects ids the kernel would refuse, importing nothing', () => {
  const h = fixture();
  h.writeArtifact('plan.md', '# plan\n'); // present, so --import fails on the ID, not on plan.md
  // Each of these flows from a model-authored plan into briefs, dispatch text and file paths; an
  // id the kernel's own safeSegment would later refuse is a plan that imports and can never be
  // worked (R4). The first one is the injectable form: it reached canonical tasks.json.
  const BAD = ['T3; echo INJECTED #', 'a b', '../x', ''];
  for (const id of BAD) {
    const snap = h.snapshot();
    h.writePlanTasks([planTask(id), planTask('X1'), planTask('X2')]);
    const check = h.legion('plan', 'check', '--feature', h.feature);
    assert.equal(check.code, 1, `plan check must reject the id ${JSON.stringify(id)}`);
    // The finding must name the offending id — or, for the empty one, where it sits.
    if (id === '') assert.match(check.stderr, /tasks\[0\]\.id/, 'an empty id must be located');
    else assert.ok(check.stderr.includes(id), `the finding must name ${JSON.stringify(id)}: ${check.stderr}`);
    const imported = h.legion('plan', 'check', '--feature', h.feature, '--import');
    assert.equal(imported.code, 1, `--import must refuse the id ${JSON.stringify(id)} too`);
    assert.deepEqual(h.readTasks().tasks, [], 'NOTHING may be imported');
    h.assertUnmoved(snap, `a refused plan check for ${JSON.stringify(id)}`);
  }
});

// --- 10 / 10b. (T14) a review records the hash of what it actually judged ----------------------

test('10 (T14) a feature review is bound to the tree it judged', () => {
  const h = fixture();
  advanceTo(h, 'review');
  const recorded = satisfyReviews(h); // asserts the requirement IS satisfied at this tree
  assert.ok(h.readTasks().reviews.length > 0, `the case needs at least one recorded review (${recorded.join(', ')})`);

  const snap = h.snapshot();
  h.commit('a change no reviewer ever saw');
  const r = h.legion('state', 'stage-complete', 'review');
  assert.equal(r.code, 1, 'a review passed on an older tree does not satisfy the requirement at this one');
  assert.match(r.stderr, /review/i);
  // The FACT survives; only the CONCLUSION is re-derived.
  assert.ok(h.readTasks().reviews.length > 0, 'the recorded verdicts are facts and must not be deleted');
  h.assertUnmoved(snap, 'a refused stage-complete review at a new tree');
});

test('10b (T14) a PLAN review is bound to the plan, and a FEATURE review survives a dossier-only edit', () => {
  const h = fixture();
  advanceTo(h, 'plan');
  h.seedPlan([planTask('T1')]);
  recordPlanCritic(h, 'pass');
  ok(h, 'case10b', 'state', 'decision-record', 'plan');
  ok(h, 'case10b', 'state', 'stage-complete', 'plan'); // satisfied for the plan the critic judged

  // Edit plan.md IN THE DOSSIER — the git tree does not move, which is exactly why binding a plan
  // review to the tree would let the critic pass survive the plan edit it should have died on.
  const treeBefore = h.tree();
  h.writeArtifact('plan.md', '# plan\na different plan the critic never read\n');
  assert.equal(h.tree(), treeBefore, 'a dossier edit must not move the git tree');
  // Re-validate the APPROVAL only, so the refusal below can only be about the REVIEW.
  ok(h, 'case10b', 'state', 'artifact-record', 'plan', 'plan.md');
  ok(h, 'case10b', 'state', 'decision-record', 'plan');

  const snap = h.snapshot();
  const r = h.legion('state', 'stage-complete', 'plan');
  assert.equal(r.code, 1, 'the critic pass died with the plan it judged');
  assert.match(r.stderr, /critic|review/i, 'the refusal must name the review, not the approval');
  h.assertUnmoved(snap, 'a refused stage-complete plan over a stale critic pass');

  // The contrast: a FEATURE review is TREE-bound, so a dossier-only edit must not kill it.
  recordPlanCritic(h, 'pass'); // re-review the new plan, and the plan stage is satisfied again
  ok(h, 'case10b', 'state', 'stage-complete', 'plan');
  ok(h, 'case10b', 'state', 'stage-enter', 'build');
  ok(h, 'case10b', 'state', 'task-start', 'T1');
  h.commit('T1: work');
  ok(h, 'case10b', 'gate', 'run', '--task', 'T1');
  ok(h, 'case10b', 'state', 'task-done', 'T1');
  ok(h, 'case10b', 'state', 'stage-complete', 'build');
  ok(h, 'case10b', 'state', 'stage-enter', 'review');
  const reviews = satisfyReviews(h);
  const tree = h.tree();
  h.writeArtifact('plan.md', '# plan\nyet another dossier-only edit\n');
  assert.equal(h.tree(), tree, 'the second dossier edit must not move the tree either');
  // REPAIR THE PLAN PREFIX THE RAW EDIT BROKE, exactly as half one does, before asking for an
  // accept. `stage-complete review` re-derives the WHOLE prefix (corollary 1), so a raw plan.md
  // edit left unrepaired makes an accept impossible by design — demanding one here could only
  // ever be satisfied by narrowing prefix re-derivation, which is precisely what 5d and 6e exist
  // to prevent. After the repair exactly one question remains open: did the TREE-bound feature
  // review survive an edit that did not touch the tree?
  ok(h, 'case10b', 'state', 'artifact-record', 'plan', 'plan.md');
  ok(h, 'case10b', 'state', 'decision-record', 'plan');
  recordPlanCritic(h, 'pass');
  const still = h.legion('state', 'stage-complete', 'review');
  assert.equal(still.code, 0,
    'a TREE-bound review must survive a dossier-only edit. A refusal naming the plan means the ' +
    'prefix repair above is incomplete (a test defect); a refusal naming the review means the ' +
    `review was bound to the wrong subject (the defect this case is for). Got: ${still.stderr}`);
  assert.deepEqual(h.readTasks().reviews.filter((rv) => rv.role !== 'plan-critic').map((rv) => rv.role), reviews,
    'and the reviews it re-derived over are the ones recorded before the edit');
});

// --- 10c. (T14/T12) the plan subject covers CONTENT only, in two halves ------------------------
// Split deliberately. The two halves fail for opposite reasons and must both EXECUTE: as one test
// the progress half aborted at its first assertion under today's whole-row hashing and left the
// content assertions as dead code — an unexecuted assertion is exactly what this suite exists to
// prevent. So: the progress half is a TODO (red today; the deadlock), and the content half is an
// ORDINARY test (green today, and it must STAY green) because content-invalidation is behaviour
// T14 has to PRESERVE while it narrows the subject — it is what stops the corollary-2 fix from
// over-narrowing to plan.md alone, or to a projection that drops notes/validate/depends_on.

/** The plan-stage fixture both halves need: standing in `plan`, plan imported with content-bearing
 * fields on the rows, a passing critic, and `stage-complete plan` as the probe. */
function planStageFixture() {
  const h = fixture();
  advanceTo(h, 'plan');
  h.seedPlan([
    planTask('T1', { notes: 'mirror: the existing widget', validate: { cwd: '.', argv: ['/usr/bin/true'], timeoutMs: 1000 } }),
    planTask('T2', { depends_on: ['T1'] }),
  ]);
  recordPlanCritic(h, 'pass');
  // THE PROBE IS A CONSUMER, never a field read: the only honest way to ask "is this approval still
  // hash-valid" is to ask something that gates on it, and `stage-complete plan` is the cheapest.
  // Its success appends to completedStages — which is what an audit trail is for. (The prerequisite
  // table lists no stage clause for task-start/task-done/task-answer, so driving them from the plan
  // stage is legitimate and keeps each half to one probe.)
  return { h, probe: () => h.legion('state', 'stage-complete', 'plan') };
}

test('10c (T14/T12) task PROGRESS must leave the plan approval hash-valid — the lifecycle deadlock', () => {
  // PLAN-V3 §State corollary 2, "too wide". combinedPlanHash currently hashes WHOLE task rows, so
  // the first `task-start` moves the plan subject and invalidates the plan approval. Harmless only
  // while nothing re-checks it — the moment T13 re-derives the prefix, `stage-complete build`,
  // `stage-enter review`, `finalize` and `close delivered` all become permanently unreachable and
  // the first task started strands the feature forever. The subject must cover plan.md's bytes plus
  // `planContent`'s six-field projection of the rows.
  const { h, probe } = planStageFixture();
  ok(h, 'case10c', 'state', 'decision-record', 'plan');
  assert.equal(probe().code, 0, 'precondition: a freshly recorded plan approval is hash-valid');

  ok(h, 'case10c', 'state', 'task-start', 'T1');
  assert.equal(probe().code, 0,
    'task-start must leave the plan approval hash-valid — a human assented to the plan\'s CONTENT, not to progress against it (this is the deadlock: every later stage becomes unreachable)');
  h.commit('T1: work');
  ok(h, 'case10c', 'gate', 'run', '--task', 'T1'); // mints a receipt ONTO the row
  assert.equal(probe().code, 0, 'a minted gate receipt must leave the plan approval hash-valid');
  ok(h, 'case10c', 'state', 'task-done', 'T1');
  assert.equal(probe().code, 0, 'task-done must leave the plan approval hash-valid');
  ok(h, 'case10c', 'state', 'task-answer', 'T2', '--question', 'which widget?', '--answer', 'the existing one');
  assert.equal(probe().code, 0, 'task-answer must leave the plan approval hash-valid');
});

test('10c-content (T14 guard) every byte of plan CONTENT invalidates the plan approval', () => {
  // Ordinary, not todo: this passes TODAY and must keep passing. It is the other jaw of the vice on
  // T14 — the deadlock fix narrows the plan subject, and this is what stops it narrowing too far.
  const { h, probe } = planStageFixture();

  // Content is edited straight into tasks.json rather than re-imported on purpose: a re-import
  // cascades the approval away by itself (src/kernel/state.mjs seedTasks), which would prove the
  // cascade works and say nothing about the HASH. This is the drift-not-routed-through-an-op case
  // that approvalValid's recomputation exists for.
  //
  // A FRESH APPROVAL IS RECORDED BEFORE EACH EDIT, and that is what makes every assertion here
  // EXECUTE: without it the first invalidation would leave the approval invalid for every later
  // probe and the rest would be dead code. The precondition probe is also the NON-VACUITY CONTROL —
  // it proves the refusal below came from the edit and not from an already-invalid approval.
  const executed = [];
  const contentEdit = (label, edit) => {
    ok(h, `10c-content ${label}`, 'state', 'decision-record', 'plan');
    assert.equal(probe().code, 0, `${label}: control — the re-recorded approval is hash-valid before the edit`);
    edit();
    // C-CARRY (T14, codex T11 finding): now that plan-critic reviews are PLAN-BOUND, a content
    // edit invalidates the critic pass too — so a fresh pass is re-recorded AFTER each edit,
    // leaving the plan APPROVAL HASH as the only stale thing the probe can refuse on. Without
    // this, the refusal below could pass because the REVIEW went stale rather than because the
    // approval subject covers the edited field, and the test would prove nothing while green.
    recordPlanCritic(h, 'pass');
    const snap = h.snapshot();
    const r = probe();
    assert.equal(r.code, 1, `${label} is plan CONTENT — it must invalidate the plan approval`);
    h.assertUnmoved(snap, `a refused stage-complete plan after editing ${label}`);
    executed.push(label);
  };
  const patch = (id, fields) => () => h.writeTasks((doc) => ({
    ...doc, tasks: doc.tasks.map((t) => (t.id === id ? { ...t, ...fields } : t)),
  }));
  contentEdit('a task title', patch('T1', { title: 'a materially different task' }));
  contentEdit('a depends_on edge', patch('T2', { depends_on: [] }));
  contentEdit('a validate command', patch('T1', { validate: { cwd: '.', argv: ['/usr/bin/false'], timeoutMs: 1000 } }));
  contentEdit('a notes block', patch('T1', { notes: 'mirror: something else entirely' }));
  // plan.md's bytes are the other half of the subject.
  contentEdit('plan.md itself', () => {
    writeFileSync(join(h.dossier, 'plan.md'), '# plan\nedited behind the kernel\'s back\n');
  });
  // AND EVERY ONE OF THEM RAN. The whole reason this half is its own test is that behind a red
  // assertion these five were dead code, so "they execute" is itself an assertion, not a claim.
  assert.deepEqual(executed,
    ['a task title', 'a depends_on edge', 'a validate command', 'a notes block', 'plan.md itself'],
    'all five content assertions must have executed');
});

// --- CASE 11 IS GONE, deliberately (user decision 2026-07-25) ---------------------------------
// It asserted that `gate run --allow-config` required a hash-valid `config-change` approval, plus
// the totality of that approval's subject over deleted and renamed protected config. THE APPROVAL
// KIND WAS CUT: the operator of this tool is the human who edits the config, so an approval artifact
// gating their own edit buys nothing an honest refusal message does not. R12's real defect was a
// MESSAGE THAT LIED — `--allow-config` claimed a recorded human ok that nothing checked — and the
// fix is to make the message true, not to add ceremony. `--allow-config` stays a deliberate operator
// waiver whose use is visible in the receipt's provenance. Recorded here rather than silently
// deleted, so a future reader does not re-derive the case and wonder where it went.

// --- 12. (T14) the printed launch command is shell-safe ---------------------------------------

test('12 (T14) the printed launch command survives a shell parse as exactly three arguments to claude', () => {
  const h = fixture({ pathHazards: true });
  assert.match(h.worktree, /[ ;']/, 'the fixture must really exercise a space, a semicolon and an apostrophe');
  const line = h.launchLine;

  // PLAN-V3 §Startup step 5: every interpolated path and identifier is single-quote-shell-escaped.
  assert.ok(line.includes(sq(h.worktree)), `the worktree path must be single-quote escaped in:\n  ${line}`);
  assert.ok(line.includes(sq(h.dossier)), `the dossier path must be single-quote escaped in:\n  ${line}`);

  // A NON-EXECUTING parse: `sh -n` reads the command and runs nothing. Unquoted, today's line
  // dies here with an unterminated-quote syntax error.
  const parsed = spawnSync('/bin/sh', ['-n', '-c', line], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, `the emitted line must survive a shell parse: ${parsed.stderr.trim()}`);

  // …and it must parse into the argv the operator meant.
  const words = shellWords(line);
  const ci = words.indexOf('claude');
  assert.notEqual(ci, -1, `no bare \`claude\` word in: ${words.join(' | ')}`);
  // EXACTLY five, not "contains five": the interactive launch command has exactly five arguments
  // now that T17 landed §Startup step 5's `--plugin-dir <root>` for development launches (M0
  // finding 1) — the suite runs from a checkout, never from <config dir>/plugins, so the flag is
  // always present here. A `contains` check would trade a real assertion for a hypothetical
  // convenience; the marketplace layout (flag ABSENT) is asserted in test/cli/plugin-dir.test.mjs,
  // where the install root can be simulated without a marketplace install.
  assert.deepEqual(
    words.slice(ci + 1),
    ['--plugin-dir', PLUGIN_ROOT, '--add-dir', h.dossier, `/legion:feature resume default/${h.project}/${h.feature}`],
    'exactly five arguments to claude, each one intact (not split at the space, not truncated at the apostrophe)',
  );
  assert.equal(words[words.indexOf('cd') + 1], h.worktree, 'and the cd target is the whole worktree path');
});

// --- C. THE NON-TODO HALF: these pass TODAY and prove the harness itself works -----------------

test('C1 (harness) a malformed candidate plan is bounced by `plan check` and imports nothing', () => {
  const h = fixture();
  h.writeArtifact('plan.md', '# plan\n');
  h.writePlanTasks([
    // The exact v2 defect: a model-produced, critic-missed shell-string `validate`.
    { id: 'T1', title: 'shell-string validate', status: 'pending', attempt: 0, validate: 'npm test && echo ok' },
    { id: 'T2', title: 'dangling dependency', status: 'pending', attempt: 0, depends_on: ['T9'] },
    planTask('T3'),
  ]);
  const r = h.legion('plan', 'check', '--feature', h.feature);
  assert.equal(r.code, 1, 'a malformed plan bounces to the architect, never to the builder');
  assert.match(r.stderr, /plan check FAILED/);
  assert.match(r.stderr, /must be structured \{cwd,argv,timeoutMs\}/);
  assert.match(r.stderr, /references unknown task 'T9'/);
  const imported = h.legion('plan', 'check', '--feature', h.feature, '--import');
  assert.equal(imported.code, 1);
  assert.deepEqual(h.readTasks().tasks, [], 'nothing may reach canonical tasks.json');
});

test('C2 (harness) a RED gate records no receipt at all', () => {
  const h = fixture({ gates: 'RED' });
  h.seedPlan(THREE);
  h.commit('T1: work');
  const snap = h.snapshot();
  const r = h.legion('gate', 'run', '--task', 'T1');
  assert.equal(r.code, 1, 'the RED gate must fail');
  assert.match(r.stderr, /gate RED/);
  assert.match(r.stderr, /no receipt recorded/);
  const t = h.readTasks();
  assert.equal(t.tasks.find((x) => x.id === 'T1').receipt, undefined);
  assert.equal(t.receipts.boundary, null);
  h.assertUnmoved(snap, 'a red gate');
});

// --- review receipts (2026-08-17): a reviewer-role verdict demands attendance evidence -------
// The same three-layer shape as gate receipts: minted by ONE surface (`legion gate
// review-receipt`, ordinarily the reviewer agent's SubagentStop hook, where agent type and id
// are HARNESS-supplied), verified and CONSUMED by `review-record`, and forgeable only by the
// same Bash that can already hand-write tasks.json. WHAT IS NOT CLOSED, stated exactly as
// src/cli/gate.mjs's residual is: a forger who derives the REAL tree hash — readable in the
// same worktree — and hand-writes a receipt row passes. The closed surfaces are the advertised
// op list and the BARE assertion; prevention beyond that is claimed nowhere.

test('R1 (receipts) a bare reviewer-role record refuses; a forged receipt with a guessed hash changes nothing; a real mint records', () => {
  const h = fixture({ gates: 'NONE' });
  h.seedPlan(THREE);

  const snap = h.snapshot();
  const bare = h.legion('state', 'review-record', '--role', 'code-reviewer', '--verdict', 'pass', '--subject', 'task:T1');
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /no unconsumed code-reviewer review receipt/);
  assert.match(bare.stderr, /caller's\s+assertion/, 'the refusal must say WHY a bare record is not evidence');
  h.assertUnmoved(snap, 'a bare reviewer-role record');

  // Forged, with a GUESSED binding hash: the kernel re-derives the tree itself and the guess loses.
  h.writeTasks((doc) => ({
    ...doc,
    reviewReceipts: [{
      agentType: 'legion:code-reviewer', agentId: 'forged', role: 'code-reviewer',
      verdict: 'pass', treeHash: '0'.repeat(64), planHash: null, at: '2026-08-17T00:00:00.000Z', consumed: null,
    }],
  }));
  const snap2 = h.snapshot();
  const forged = h.legion('state', 'review-record', '--role', 'code-reviewer', '--verdict', 'pass', '--subject', 'task:T1');
  assert.equal(forged.code, 1, 'a receipt binding a tree this worktree never had is not attendance');
  h.assertUnmoved(snap2, 'a record over a wrong-hash forgery');

  // The vice's other jaw: a REAL mint through the one surface, and the record consumes it.
  ok(h, 'R1', 'gate', 'review-receipt', '--agent-type', 'legion:code-reviewer', '--agent-id', 'real', '--verdict', 'pass');
  ok(h, 'R1', 'state', 'review-record', '--role', 'code-reviewer', '--verdict', 'pass', '--subject', 'task:T1');
  const receipts = h.readTasks().reviewReceipts;
  assert.equal(receipts.at(-1).consumed.subject, 'task:T1', 'the real receipt was consumed by the record');
  assert.equal(receipts.at(0).consumed, null, 'the forgery matched nothing and was not even worth consuming');
});

test('R2 (receipts) freshness IS the hash equality: the tree moving strands a receipt; a fresh mint at the new tree records', () => {
  const h = fixture({ gates: 'NONE' });
  h.seedPlan(THREE);
  ok(h, 'R2', 'gate', 'review-receipt', '--agent-type', 'legion:code-reviewer', '--agent-id', 'lens-1', '--verdict', 'pass');
  h.commit('ungated drift after the review');
  const snap = h.snapshot();
  const stale = h.legion('state', 'review-record', '--role', 'code-reviewer', '--verdict', 'pass', '--subject', 'task:T1');
  assert.equal(stale.code, 1, 'attendance at the OLD tree is not attendance at this one');
  h.assertUnmoved(snap, 'a record over a stale receipt');
  ok(h, 'R2', 'gate', 'review-receipt', '--agent-type', 'legion:code-reviewer', '--agent-id', 'lens-2', '--verdict', 'pass');
  ok(h, 'R2', 'state', 'review-record', '--role', 'code-reviewer', '--verdict', 'pass', '--subject', 'task:T1');
});

test('R3 (receipts) the waiver is audited, and the review ROW is field-identical — pre-merge approvals never see receipts', () => {
  const h = fixture({ gates: 'NONE' });
  h.seedPlan(THREE);

  const snap = h.snapshot();
  const empty = h.legion('state', 'review-record', '--role', 'product-reviewer', '--verdict', 'pass', '--subject', 'feature', '--no-receipt-attest', '  ');
  assert.equal(empty.code, 1);
  assert.match(empty.stderr, /non-empty reason/);
  h.assertUnmoved(snap, 'an empty waiver reason');

  ok(h, 'R3', 'state', 'review-record', '--role', 'product-reviewer', '--verdict', 'pass', '--subject', 'feature',
    '--no-receipt-attest', 'human reviewed in the MR UI');
  const waived = h.readTasks().reviewReceipts.at(-1);
  assert.equal(waived.waived, true);
  assert.equal(waived.reason, 'human reviewed in the MR UI');
  assert.equal(waived.agentId, null, 'the waiver marks the ABSENCE of evidence; it fabricates none');
  assert.notEqual(waived.consumed, null, 'born consumed — it can never satisfy a later record');

  ok(h, 'R3', 'gate', 'review-receipt', '--agent-type', 'legion:product-reviewer', '--agent-id', 'pr-1', '--verdict', 'pass');
  ok(h, 'R3', 'state', 'review-record', '--role', 'product-reviewer', '--verdict', 'pass', '--subject', 'feature');
  const [a, b] = h.readTasks().reviews.slice(-2);
  assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(),
    'waived and receipted rows carry identical fields — receipts live OUTSIDE canonicalReviews, so the frozen pre-merge formula cannot tell them apart');
});

test('R4 (receipts) end to end through the REAL SubagentStop hook: reviewer stops, receipt lands, the record consumes it', () => {
  const h = fixture({ gates: 'NONE' });
  h.seedPlan(THREE);
  const hook = spawnSync(process.execPath, [join(PLUGIN_ROOT, 'hooks', 'review-receipt.mjs')], {
    input: JSON.stringify({
      hook_event_name: 'SubagentStop', agent_type: 'legion:code-reviewer', agent_id: 'e2e-lens',
      agent_transcript_path: '/dev/null', stop_hook_active: false, cwd: h.worktree,
      last_assistant_message: '{"verdict":"pass","findings":[]}',
    }),
    encoding: 'utf8', env: h.env,
  });
  assert.equal(hook.status, 0, hook.stderr);
  const minted = h.readTasks().reviewReceipts.at(-1);
  assert.equal(minted.agentId, 'e2e-lens', 'the hook minted from the harness-supplied identity');
  assert.equal(minted.verdict, 'pass');
  ok(h, 'R4', 'state', 'review-record', '--role', 'code-reviewer', '--verdict', 'pass', '--subject', 'task:T1');
  assert.equal(h.readTasks().reviewReceipts.at(-1).consumed.subject, 'task:T1');
});
