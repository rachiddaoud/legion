// m1b-fixtures.test.mjs — PLAN-V3 §Milestones M1b's fixture track, the CASCADE half (T33):
// "editing the contract invalidates BOTH siblings' spec approvals and their dependents (the
// cascade is verified, not assumed)". §State's rev-6 approvals note says the same thing from the
// other end — "a contract edit changes the spec subject, the spec approval falls, and every
// dependent approval falls with it" — and §Risks 6 names contract drift as the initiative layer's
// one real risk. This file is the verification those three sentences are owed.
//
// HONEST SCOPE, and it is a milestone rule rather than a caveat: M1b's ATTENDED FE+BE proving run
// is DEFERRED (§Milestones M1b, amended 2026-07-29). The layer is BUILT AND HERMETICALLY TESTED —
// that is the whole claim this file supports and the only one it may be read as making. No real
// initiative has been driven through it; M1b's acceptance stays OPEN.
//
// THE BAR, identical to M0's and M1a's: drive the REAL bin/legion.mjs into a state where a refusal
// is the correct answer, assert the refusal, assert WHAT it names, assert THAT NOTHING MOVED
// (manifest bytes), and end every group on a POSITIVE CONTROL — a refusal test that never proves
// the door opens again passes just as well against a layer that wedged it shut.
//
// THE MECHANISM, STATED PRECISELY, because the plan's word "cascade" covers two different things
// here and conflating them would let this file overclaim:
//   - THE SPEC APPROVAL FALLS BY SUBJECT. computeSubjectHash('spec') binds the spec artifact's
//     bytes together with the LIVE bytes of the interface contract (src/kernel/state.mjs,
//     specContractBytes). Editing the contract moves the subject, so the stored subjectHash no
//     longer matches and approvalValid('spec') is false — on the SECONDARY through its
//     `initiative.contract` reference, and on the PRIMARY through its own recorded `contract`
//     artifact. Both siblings, which is exactly what "invalidates BOTH" demands.
//   - THE BINDING IS BY PATH ON BOTH SIDES, AND THE PATH IS HELD STILL BY A REFUSAL. The secondary
//     resolves the contract through the reference `feature start` pinned; the primary through its
//     own recorded artifact. Re-recording the contract at a NEW FILE would split those two — the
//     primary's approval falls, the sibling keeps binding an abandoned file that is still on disk
//     and still hash-valid, and it builds on against a stale contract with no signal anywhere in
//     its repo (risk 6, exactly). So `artifact-record contract` REFUSES to move a contract while
//     the initiative block stands (kernel/state.mjs artifactRecord), and case 4 is that refusal's
//     fixture. Without it the M1b sentence would be true only of in-place edits, and this file
//     would be asserting a guarantee the kernel does not have.
//   - THE DEPENDENTS FALL BY PREFIX RE-DERIVATION (§State corollary 1), NOT by a new cascade edge.
//     `artifact-record contract` deliberately runs no cascade of its own (T32: contract has no
//     ARTIFACT_TO_APPROVAL entry) — and a cascade there would be useless anyway, since the edit
//     that matters is an edit to the FILE, which no op observes. What makes the plan approval stop
//     counting is that every op which advances the lifecycle re-derives the WHOLE prefix, and the
//     spec row of that prefix is now unsatisfied. So the plan APPROVAL RECORD survives (its own
//     subject — plan.md + planContent — never mentioned the contract) while every stage that
//     depends on it refuses. That is the true shape, it is asserted below in both halves, and
//     stating it here is cheaper than a reader inferring the wrong one.
//   - THE SHARPEST PREFIX-DEPENDENT OP REACHABLE FROM THE PLAN STAGE is the forward
//     `stage-enter build` (kernel/state.mjs stageEnter → unsatisfiedPrefix over intake…plan);
//     `stage-complete plan` walks the same prefix. `legion finalize` and `close delivered` call
//     THE SAME unsatisfiedPrefix (src/cli/finalize.mjs:548, kernel/state.mjs closeFeature) and
//     `decision-record`/`approvalValid` call THE SAME computeSubjectHash — verified by reading,
//     with no code changed there, which is the point of there being one shared formula.
//
// THE REGRESSION PIN IS PART OF THE TRACK, not a courtesy: M1b must not destabilize M1a, so a
// NON-initiative feature must be byte-identical to what it was before this layer existed. Case 3
// pins the spec subject of an ordinary feature to sha256(spec bytes) ALONE — including the
// adversarial version, a feature that has recorded a `contract` artifact without an initiative
// block, where a clause that keyed off the artifact instead of the block would fire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture, planTask } from '../helpers/fixture.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/** THE FORMULA UNDER TEST, written out independently of the kernel (T33): the spec subject with a
 * contract in play is the two-digest framing combinedPlanHash already uses — each half a
 * fixed-width hex digest, ':' not a hex character, so no reshuffling of bytes between the two
 * files can collide them. Recomputed here from the files on disk so the assertions pin the actual
 * VALUE rather than merely "something changed". */
const specSubjectWithContract = (specPath, contractPath) =>
  sha256(`${sha256(readFileSync(specPath))}:${sha256(readFileSync(contractPath))}`);

// --- harness: two real repositories, two real features, one initiative ---------------------------
// Everything goes through the real bin and fixture.mjs's hardened env; nothing is re-invented.
// (The startFeature/secondRepo shapes match test/cli/initiative.test.mjs's deliberately — that file
// owns the LINK's unit coverage, this one owns the milestone's cascade claim, and a shared import
// between two test files would make `node --test` run one of them twice.)

/** A feature in the fixture's own project, started through the real CLI. */
function startFeature(h, name, ...extra) {
  const r = h.legionIn(h.repoRoot, 'feature', 'start', name, '--base', 'main', ...extra);
  return featureHandle(h, h.project, h.repoRoot, name, r);
}

function featureHandle(h, project, repoRoot, name, r) {
  const dossier = join(h.home, 'orgs', 'default', 'projects', project, 'features', name);
  const worktree = join(dirname(repoRoot), '.legion-worktrees', project, name, 'checkout');
  return {
    r,
    name,
    dossier,
    worktree,
    legion: (...argv) => h.legionIn(worktree, ...argv),
    readFeature: () => JSON.parse(readFileSync(join(dossier, 'feature.json'), 'utf8')),
    readTasks: () => JSON.parse(readFileSync(join(dossier, 'tasks.json'), 'utf8')),
    writeArtifact: (file, body) => {
      const p = join(dossier, file);
      writeFileSync(p, body);
      return realpathSync(p);
    },
    snapshot: () => ({
      feature: readIf(join(dossier, 'feature.json')),
      tasks: readIf(join(dossier, 'tasks.json')),
    }),
  };
}

/** `h.assertUnmoved`, for a dossier the fixture did not start (both siblings are such). Byte
 * comparison is the right question: a refused op must write NOTHING, and a revision bump with every
 * visible field unchanged is still state that moved. */
function assertUnmoved(s, snap, what) {
  const now = s.snapshot();
  assert.equal(now.feature, snap.feature, `${what}: ${s.name}'s feature.json MOVED`);
  assert.equal(now.tasks, snap.tasks, `${what}: ${s.name}'s tasks.json MOVED`);
}

/** A step that MUST succeed for the case to be meaningful (lifecycle.mjs's `ok`, bound to a sibling
 * handle instead of the fixture's own). */
function ok(s, ...argv) {
  const r = s.legion(...argv);
  assert.equal(r.code, 0, `${s.name}: \`legion ${argv.join(' ')}\` must succeed, got ${r.code}: ${(r.stderr || r.stdout).trim()}`);
  return r;
}

/** A SECOND real repository, registered as a second legion project in the same LEGION_HOME — the
 * driving case §Initiatives opens with ("projects split into frontend and backend repositories,
 * where one change spans both"). The cascade is asserted ACROSS that boundary deliberately: a
 * contract edit in the BE dossier has to reach the FE feature's spec approval, and a same-project
 * pair would prove a weaker thing. */
function secondRepo(h, project = 'feproj') {
  const repoRoot = join(dirname(h.repoRoot), project);
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: project, private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`);
  writeFileSync(join(repoRoot, 'src', 'a.mjs'), 'export const a = 1;\n');
  const gitAt = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=legion test', ...args],
      { cwd: repoRoot, encoding: 'utf8', env: h.env });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  gitAt('init', '-b', 'main');
  gitAt('add', '-A');
  gitAt('commit', '-m', 'init');
  const real = realpathSync(repoRoot);
  const init = h.legionIn(real, 'project', 'init', '--root', real, '--name', project);
  assert.equal(init.code, 0, `second project init: ${init.stderr}`);
  return {
    project,
    repoRoot: real,
    start(name, ...extra) {
      const r = h.legionIn(real, 'feature', 'start', name, '--base', 'main', ...extra);
      return featureHandle(h, project, real, name, r);
    },
  };
}

const CONTRACT_V1 = '# interface contract v1\nGET /widgets -> [{id, name}]\n';
const CONTRACT_V2 = '# interface contract v2\nGET /widgets -> [{id, name, colour}]\n';
const RECAP = '# recap\nwe agreed the FE and BE halves of the widget colour change\n';

/** Complete intake on a sibling. The SECONDARY goes BY REFERENCE (no `decision-record intake` — the
 * recap conversation happened once, in the primary's session, §State rev-6); the PRIMARY records
 * its own. Profiles are deliberately DIFFERENT (§Initiatives: "profiles are fully independent per
 * sibling — any mix"), which costs nothing and pins that the cascade does not care. */
function completeIntake(s, { byReference, profile }) {
  ok(s, 'state', 'init');
  s.writeArtifact('intent.md', `# intent\nthe ${s.name} half of the agreed change\n`);
  ok(s, 'state', 'artifact-record', 'intent', 'intent.md');
  if (!byReference) ok(s, 'state', 'decision-record', 'intake');
  ok(s, 'state', 'escalate-profile', profile);
  ok(s, 'state', 'stage-complete', 'intake');
  ok(s, 'state', 'stage-enter', 'spec');
}

/** Record and approve a spec. The spec TEXT pins the contract hash the way a real spec would (the
 * plan's "its hash is pinned into every sibling's spec content") — realism only: what is actually
 * under test is the SUBJECT, which binds the contract's live bytes whatever the prose says. */
function approveSpec(s, contractPath) {
  const specPath = s.writeArtifact('spec.md',
    `# spec — ${s.name}\nbuilt against interface contract sha256 ${sha256(readFileSync(contractPath))}\n`);
  ok(s, 'state', 'artifact-record', 'spec', 'spec.md');
  ok(s, 'state', 'decision-record', 'spec');
  return specPath;
}

/** Import a real plan, pass the critic, approve it — the DEPENDENT evidence whose fate case 1
 * asserts. Imported through the real `plan check --import`, never hand-written. */
function approvePlan(s) {
  s.writeArtifact('plan.md', `# plan — ${s.name}\n`);
  s.writeArtifact('plan.tasks.json', `${JSON.stringify({
    milestones: [{ id: 'M1', title: 'the milestone', tasks: [planTask('T1'), planTask('T2', { depends_on: ['T1'] }), planTask('T3')] }],
  }, null, 2)}\n`);
  ok(s, 'plan', 'check', '--feature', s.name, '--import');
  ok(s, 'gate', 'review-receipt', '--agent-type', 'legion:plan-critic', '--agent-id', 'm1b-critic', '--verdict', 'pass');
  ok(s, 'state', 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan');
  ok(s, 'state', 'decision-record', 'plan');
}

/** The whole two-repo initiative, both siblings standing in `plan` with spec and plan approved —
 * i.e. the state a real M1b pair reaches just before the build stage, and the state the contract
 * edit has to poison. Returns the handles plus the shared paths. */
function initiativePair() {
  const h = fixture(); // its own f1 carries NO initiative block: the regression control, for free
  const be = startFeature(h, 'be1', '--initiative', 'widget-colour');
  assert.equal(be.r.code, 0, `primary start: ${be.r.stderr}`);
  // The primary HOSTS the shared artifacts in its own dossier — no separate initiative directory.
  const recapPath = be.writeArtifact('intent.md', RECAP);
  const contractPath = be.writeArtifact('contract.md', CONTRACT_V1);
  ok(be, 'state', 'init');
  ok(be, 'state', 'artifact-record', 'intent', 'intent.md');
  ok(be, 'state', 'artifact-record', 'contract', 'contract.md');
  ok(be, 'state', 'decision-record', 'intake'); // the human's yes to the recap, once, here
  ok(be, 'state', 'escalate-profile', 'standard');
  ok(be, 'state', 'stage-complete', 'intake');
  ok(be, 'state', 'stage-enter', 'spec');

  const fe = secondRepo(h);
  const feF = fe.start('fe1', '--initiative', 'widget-colour');
  assert.equal(feF.r.code, 0, `secondary start: ${feF.r.stderr}`);
  assert.equal(feF.readFeature().initiative.contract.path, contractPath,
    'the secondary must reference the PRIMARY\'s contract file by path');
  completeIntake(feF, { byReference: true, profile: 'express' });

  const beSpec = approveSpec(be, contractPath);
  const feSpec = approveSpec(feF, contractPath);
  return { h, be, feF, fe, recapPath, contractPath, beSpec, feSpec };
}

/** Both siblings, so a case can never assert on one and read as covering both. */
const siblings = (p) => [{ s: p.be, spec: p.beSpec }, { s: p.feF, spec: p.feSpec }];

// =================================================================================================
// CASE 1 — the M1b sentence itself: a contract edit invalidates BOTH siblings' spec approvals
//          and their dependents
// =================================================================================================

test('M1b-1 editing the interface contract falls BOTH siblings\' spec approvals and every dependent stage', () => {
  const p = initiativePair();

  // --- POSITIVE CONTROL, BEFORE. Both siblings complete spec and plan cleanly. Without this the
  // case would pass against a layer that simply refuses everything for an initiative feature.
  for (const { s, spec } of siblings(p)) {
    // THE SUBJECT IS THE BINDING, pinned to its VALUE and not merely to "it changed": the recorded
    // subjectHash equals sha256(sha256(spec bytes) : sha256(LIVE contract bytes)) — the primary
    // resolving the contract from its OWN recorded artifact, the secondary from its reference, and
    // both landing on the same contract file in the primary's dossier.
    assert.equal(s.readTasks().approvals.spec.subjectHash, specSubjectWithContract(spec, p.contractPath),
      `${s.name}: the spec approval must bind spec bytes AND the live contract bytes`);
    assert.notEqual(s.readTasks().approvals.spec.subjectHash, sha256(readFileSync(spec)),
      `${s.name}: and it must NOT be the bare spec hash — that is the pre-T33 formula`);
    ok(s, 'state', 'stage-complete', 'spec');
    ok(s, 'state', 'stage-enter', 'plan');
    approvePlan(s);
    ok(s, 'state', 'stage-complete', 'plan');
  }

  // --- THE EDIT, through the operator's own path: change the file, then re-record it in the
  // PRIMARY's session. Manifests are never hand-edited here — the whole claim is about what the
  // ordinary path does.
  const planApprovalsBefore = siblings(p).map(({ s }) => JSON.stringify(s.readTasks().approvals.plan));
  writeFileSync(p.contractPath, CONTRACT_V2);

  // (a) THE FILE EDIT ALONE IS ALREADY ENOUGH — asserted before the re-record, because the subject
  //     binds LIVE BYTES. A binding that keyed off the RECORDED artifact hash would still be
  //     "valid" here, which is the drift M1b's risk 6 is about: the contract moved and nobody's
  //     approval noticed.
  for (const { s } of siblings(p)) {
    const snap = s.snapshot();
    const r = s.legion('state', 'stage-enter', 'build');
    assert.equal(r.code, 1, `${s.name}: a moved contract must poison the prefix immediately, before any re-record`);
    assert.match(r.stderr, /stage 'spec' does not re-derive satisfied/);
    assertUnmoved(s, snap, 'a refused stage-enter build over an edited contract');
  }

  ok(p.be, 'state', 'artifact-record', 'contract', 'contract.md'); // the primary's ordinary path

  // (2) THE DEPENDENTS FELL WITH IT. The plan APPROVAL RECORD is untouched — its subject is
  //     plan.md + planContent and never mentioned the contract — and that is exactly why the
  //     dependency has to be proven at a CONSUMER: the sharpest one reachable here is the forward
  //     `stage-enter build`, which re-derives the whole prefix (corollary 1). `legion finalize` and
  //     `close delivered` call the same unsatisfiedPrefix and therefore inherit this with no code
  //     of their own.
  for (const [i, { s }] of siblings(p).entries()) {
    assert.equal(JSON.stringify(s.readTasks().approvals.plan), planApprovalsBefore[i],
      `${s.name}: control — the plan approval RECORD is unchanged; what fell is the stage that reads the prefix`);
    const snap = s.snapshot(); // both siblings are still standing in `plan`, where the edit found them
    const stale = s.legion('state', 'stage-complete', 'plan');
    assert.equal(stale.code, 1, `${s.name}: the plan stage depends on a spec stage that no longer re-derives`);
    assert.match(stale.stderr, /earlier stage 'spec' does not re-derive satisfied/);
    assert.match(stale.stderr, /no hash-valid spec approval/);
    const fwd = s.legion('state', 'stage-enter', 'build');
    assert.equal(fwd.code, 1, `${s.name}: and the build stage is unreachable while it stands`);
    assert.match(fwd.stderr, /stage 'spec' does not re-derive satisfied/);
    assertUnmoved(s, snap, 'a refused plan-stage op over an edited contract');
  }

  // (1) BOTH SIBLINGS' `stage-complete spec` REFUSE NOW, on the re-derived hash, naming the spec
  //     approval. They are standing in `plan`, so each goes BACKWARD to spec first — always allowed,
  //     always recorded, and it clears nothing (§State stageEnter): if the evidence were still good
  //     the round trip would cost nothing, which is precisely why the refusal below is evidence.
  for (const { s } of siblings(p)) {
    ok(s, 'state', 'stage-enter', 'spec');
    const snap = s.snapshot();
    const r = s.legion('state', 'stage-complete', 'spec');
    assert.equal(r.code, 1, `${s.name}: stage-complete spec must refuse after the contract moved`);
    assert.match(r.stderr, /no hash-valid spec approval/,
      'the refusal names the APPROVAL that fell — the operator re-records that, not the artifact');
    assert.match(r.stderr, /decision-record spec/, 'and the op that repairs it');
    assertUnmoved(s, snap, 'a refused stage-complete spec over an edited contract');
  }

  // (3) POSITIVE CONTROL, AFTER. Re-approving each spec against the NEW contract — the human looked
  //     at the new interface — releases both siblings, and the plan approval that was never dropped
  //     starts counting again. The door was closed, not wedged shut.
  for (const { s, spec } of siblings(p)) {
    ok(s, 'state', 'decision-record', 'spec'); // standing in spec, where probe (1) left them
    assert.equal(s.readTasks().approvals.spec.subjectHash, specSubjectWithContract(spec, p.contractPath),
      `${s.name}: the new approval binds the NEW contract bytes`);
    ok(s, 'state', 'stage-complete', 'spec');
    ok(s, 'state', 'stage-enter', 'plan');
    ok(s, 'state', 'stage-complete', 'plan');
    ok(s, 'state', 'stage-enter', 'build');
  }

  // AND THE OTHER DIRECTION OF THE SAME CLAIM: restoring the contract's ORIGINAL bytes would revive
  // the ORIGINAL approvals — the subject is a claim about CONTENT, not about a file's mtime or the
  // order in which it was edited. Asserted on the primary; the formula is the same one.
  writeFileSync(p.contractPath, CONTRACT_V1);
  const back = p.be.legion('state', 'stage-enter', 'review');
  assert.equal(back.code, 1, 'the contract is back to v1 while the spec was approved against v2 — that must refuse too');
  assert.match(back.stderr, /stage 'spec' does not re-derive satisfied/);
});

// =================================================================================================
// CASE 2 — fail-closed in the other two directions: the contract GONE, and a reference that is not
//          a reference
// =================================================================================================

test('M1b-2 a contract that cannot be read fails BOTH siblings closed, loudly at the recorder', () => {
  const p = initiativePair();
  for (const { s } of siblings(p)) ok(s, 'state', 'stage-complete', 'spec');

  // THE CONTRACT VANISHES — the primary's dossier is where it lives, so one deletion reaches both.
  rmSync(p.contractPath);
  for (const { s } of siblings(p)) {
    // At a VERIFIER the recompute throws and approvalValid reads it as invalid through its catch:
    // the existing missing-artifact direction, fail-closed for free. (Both siblings are still
    // STANDING in spec — `stage-complete` records a completion, it does not move the stage — so the
    // same op that just succeeded is the probe, with only the contract file changed underneath.)
    const snap = s.snapshot();
    const r = s.legion('state', 'stage-complete', 'spec');
    assert.equal(r.code, 1, `${s.name}: a spec approval whose contract is gone must not be usable`);
    assert.match(r.stderr, /no hash-valid spec approval/);
    assertUnmoved(s, snap, 'a refused stage-complete spec over a deleted contract');

    // At the RECORDER the same throw is the message: `decision-record spec` cannot invent a subject
    // for a contract that is not there, and says which file and why rather than dying obscurely.
    const rec = s.legion('state', 'decision-record', 'spec');
    assert.equal(rec.code, 1, `${s.name}: re-recording the approval must not paper over the missing contract`);
    assert.ok(rec.stderr.includes(p.contractPath), 'the refusal names the file it could not read');
    assert.match(rec.stderr, /cannot be read/);
    assertUnmoved(s, snap, 'a refused decision-record spec over a deleted contract');
  }

  // POSITIVE CONTROL: restore the exact bytes and both siblings' ORIGINAL approvals validate again,
  // with nothing re-recorded — the subject is a claim about content, and the content is back.
  writeFileSync(p.contractPath, CONTRACT_V1);
  for (const { s } of siblings(p)) ok(s, 'state', 'stage-complete', 'spec');
});

test('M1b-2b a SECONDARY whose block carries no usable contract reference fails closed, not open', () => {
  const p = initiativePair();
  // DELIBERATE FORGERY, and the only way to reach this state: the kernel derives the block itself,
  // so a reference-shaped hole is what a hand-edited or half-repaired manifest looks like. The
  // dangerous answer is "no reference ⇒ no contract ⇒ the plain spec hash", which would silently
  // unbind the sibling from the contract it exists to track.
  const fp = join(p.feF.dossier, 'feature.json');
  const doc = JSON.parse(readFileSync(fp, 'utf8'));
  // The RECAP reference is left intact deliberately: dropping both would refuse one row earlier, at
  // intake, and the case would never reach the clause it is about.
  writeFileSync(fp, `${JSON.stringify({
    ...doc,
    initiative: { id: 'widget-colour', role: 'secondary', primary: doc.initiative.primary, recap: doc.initiative.recap },
  }, null, 2)}\n`);
  const snap = p.feF.snapshot();

  const r = p.feF.legion('state', 'stage-complete', 'spec');
  assert.equal(r.code, 1, 'a secondary with no contract reference must not fall back to the bare spec hash');
  assert.match(r.stderr, /no hash-valid spec approval/);
  assertUnmoved(p.feF, snap, 'a refused stage-complete spec over a hollow initiative block');
  const rec = p.feF.legion('state', 'decision-record', 'spec');
  assert.equal(rec.code, 1);
  assert.match(rec.stderr, /carries no usable contract reference/);
  assert.match(rec.stderr, /--initiative widget-colour/, 'and the remedy: re-start so the reference is re-derived');

  // AND THE SAME CHOICE ON THE OTHER SIDE: a role the kernel does not know resolves like the HOST,
  // not like "no contract". The kernel only ever writes primary/secondary, so an unknown role is a
  // hand-edit — and the fail-OPEN reading of it (unknown ⇒ bind nothing) would make a one-word
  // manifest edit the way to silence the whole drift mechanism.
  const bp = join(p.be.dossier, 'feature.json');
  const bdoc = JSON.parse(readFileSync(bp, 'utf8'));
  writeFileSync(bp, `${JSON.stringify({ ...bdoc, initiative: { id: 'widget-colour', role: 'host' } }, null, 2)}\n`);
  assert.equal(p.be.legion('state', 'stage-complete', 'spec').code, 0, 'control: the approval still validates');
  writeFileSync(p.contractPath, CONTRACT_V2);
  const drift = p.be.legion('state', 'stage-complete', 'spec');
  assert.equal(drift.code, 1, 'an unknown role must still bind the recorded contract');
  assert.match(drift.stderr, /no hash-valid spec approval/);
});

// =================================================================================================
// CASE 3 — THE SINGLE-REPO REGRESSION PIN: without an initiative block, nothing whatsoever changed
// =================================================================================================
// M1b's own constraint (§Milestones): "M1b must not destabilize M1a — the initiative layer is
// additive, and M1a's acceptance stays green throughout". The suite-wide half of that is the 587
// tests that were green before this clause landed; the sharp half is here.

test('M1b-3 a NON-initiative feature\'s spec subject is sha256(spec bytes) alone — even holding a contract artifact', () => {
  const h = fixture();
  h.writeArtifact('intent.md', '# intent\n');
  h.legion('state', 'artifact-record', 'intent', 'intent.md');
  h.legion('state', 'decision-record', 'intake');
  h.legion('state', 'escalate-profile', 'express');
  h.legion('state', 'stage-complete', 'intake');
  h.legion('state', 'stage-enter', 'spec');
  const specPath = h.writeArtifact('spec.md', '# spec\nan ordinary single-repo feature\n');
  const contractPath = h.writeArtifact('contract.md', CONTRACT_V1);
  // THE ADVERSARIAL HALF: this feature has RECORDED a contract artifact and still carries no
  // initiative block. A clause keyed off the artifact rather than the block would bind it here and
  // change the subject of a feature that never opted in — an observable behaviour change to
  // non-initiative features, which is M1b's red line.
  assert.equal(h.legion('state', 'artifact-record', 'contract', 'contract.md').code, 0);
  assert.equal(h.legion('state', 'artifact-record', 'spec', 'spec.md').code, 0);
  assert.equal(h.legion('state', 'decision-record', 'spec').code, 0);
  assert.equal(h.readFeature().initiative, undefined, 'control: no initiative block');
  assert.equal(h.readTasks().approvals.spec.subjectHash, sha256(readFileSync(specPath)),
    'the pre-T33 formula, byte for byte: spec bytes alone');

  // And the contract is INERT for it: editing the file moves nothing, the stage completes, and the
  // plan stage behind it completes exactly as it did before this layer existed.
  writeFileSync(contractPath, CONTRACT_V2);
  assert.equal(h.readTasks().approvals.spec.subjectHash, sha256(readFileSync(specPath)));
  assert.equal(h.legion('state', 'stage-complete', 'spec').code, 0,
    'a contract edit must be invisible to a feature that never joined an initiative');
  assert.equal(h.legion('state', 'stage-enter', 'plan').code, 0);
  h.seedPlan([planTask('T1'), planTask('T2', { depends_on: ['T1'] }), planTask('T3')]);
  assert.equal(h.legion('gate', 'review-receipt', '--agent-type', 'legion:plan-critic', '--agent-id', 'm1b-critic', '--verdict', 'pass').code, 0);
  assert.equal(h.legion('state', 'review-record', '--role', 'plan-critic', '--verdict', 'pass', '--subject', 'plan').code, 0);
  assert.equal(h.legion('state', 'decision-record', 'plan').code, 0);
  assert.equal(h.legion('state', 'stage-complete', 'plan').code, 0);
  writeFileSync(contractPath, '# a third contract nobody here is bound to\n');
  assert.equal(h.legion('state', 'stage-enter', 'build').code, 0,
    'and the prefix re-derives satisfied whatever the contract file does');
});

// =================================================================================================
// CASE 4 — THE OTHER WAY A CONTRACT CHANGES: it is re-recorded at a NEW FILE. The siblings bind by
//          PATH, so this is refused — otherwise the cascade fires in the primary's repo alone
// =================================================================================================
// Case 1 proves the IN-PLACE edit reaches both siblings. The commonplace alternative — write
// contract-v2.md and `artifact-record contract contract-v2.md` — is an ordinary sanctioned op that
// leaves the OLD file untouched on disk, so the secondary's reference stays resolvable, stays
// hash-valid, and keeps binding a contract that is no longer the initiative's. Nothing downstream
// can see it: the ref's stored hash gates nothing, and stageSatisfied('intake') re-validates the
// RECAP, not the contract. The fix is at the writer, and this is its fixture.

test('M1b-4 the interface contract cannot be RE-RECORDED AT A NEW PATH while the initiative stands', () => {
  const p = initiativePair();
  for (const { s } of siblings(p)) ok(s, 'state', 'stage-complete', 'spec'); // control: both valid

  // THE MOVE, through the operator's own path: a new file beside the old one, then the ordinary op.
  const relocated = p.be.writeArtifact('contract-v2.md', CONTRACT_V2);
  const snaps = siblings(p).map(({ s }) => s.snapshot());
  const r = p.be.legion('state', 'artifact-record', 'contract', 'contract-v2.md');
  assert.equal(r.code, 1, 'relocating the contract of an initiative feature must be refused');
  assert.ok(r.stderr.includes(p.contractPath), 'the refusal names the path the siblings are bound to');
  assert.ok(r.stderr.includes(relocated), 'and the path that was refused');
  assert.match(r.stderr, /IN PLACE/, 'and the sanctioned edit, which is the one the cascade watches');
  for (const [i, { s }] of siblings(p).entries()) assertUnmoved(s, snaps[i], 'a refused contract relocation');
  assert.equal(p.feF.readFeature().initiative.contract.path, p.contractPath,
    'and the secondary is still bound to the one contract file');

  // WHY IT MATTERS, asserted rather than argued: had the move landed, THIS is the state it would
  // have left — the old file still on disk, unchanged, and the secondary reading it. The file the
  // sibling would have kept binding is v1 while the initiative's contract is v2.
  assert.equal(readFileSync(p.contractPath, 'utf8'), CONTRACT_V1);
  assert.notEqual(readFileSync(relocated, 'utf8'), CONTRACT_V1);

  // POSITIVE CONTROL (1): the door is closed, not wedged. The IN-PLACE edit of the same contract is
  // still accepted, still re-recordable at its own path, and still falls BOTH siblings.
  writeFileSync(p.contractPath, CONTRACT_V2);
  ok(p.be, 'state', 'artifact-record', 'contract', 'contract.md');
  for (const { s } of siblings(p)) {
    const bad = s.legion('state', 'stage-complete', 'spec');
    assert.equal(bad.code, 1, `${s.name}: the in-place edit must still fall the spec approval`);
    assert.match(bad.stderr, /no hash-valid spec approval/);
  }
  for (const { s } of siblings(p)) {
    ok(s, 'state', 'decision-record', 'spec');
    ok(s, 'state', 'stage-complete', 'spec');
  }

  // POSITIVE CONTROL (2), the M1a red line: a feature with NO initiative block may relocate its
  // contract artifact as freely as any other artifact — the refusal is gated on the block, never on
  // the kind. (p.h's own f1 carries no block; it is the regression control this file starts with.)
  p.h.writeArtifact('c1.md', CONTRACT_V1);
  p.h.writeArtifact('c2.md', CONTRACT_V2);
  assert.equal(p.h.legion('state', 'artifact-record', 'contract', 'c1.md').code, 0);
  const moved = p.h.legion('state', 'artifact-record', 'contract', 'c2.md');
  assert.equal(moved.code, 0, `a non-initiative feature's contract artifact moves freely: ${moved.stderr}`);
  assert.equal(p.h.readTasks().artifacts.contract.path, realpathSync(join(p.h.dossier, 'c2.md')));
});
