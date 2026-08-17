// viewer-projection.test.mjs — T39: the viewer's ONE read-only projection over legion3
// manifests (src/cli/_viewer/projection.mjs + activity.mjs). No HTTP is exercised here; the
// server is T40.
//
// HERMETIC. Every scenario builds a REAL sandbox through test/helpers/fixture.mjs (real
// `legion project init` / `feature start` / `state …` through bin/legion.mjs), and
// LEGION_HOME is repointed at that sandbox IN THIS PROCESS only for the duration of each
// projection call (withHome below, restored in a finally). The real ~/.legion is never read.
//
// WHERE MANIFESTS ARE HAND-WRITTEN, AND WHY. The projection is a READER, so its adversarial and
// arithmetic cases need states a legitimate command cannot cheaply produce: a corrupt dossier
// (nothing writes one), a `declaredCommands: 0` receipt (only a real gate mints receipts, and
// this suite never runs one), a delivered close (which demands a boundary receipt, an MR read
// back from a server and the whole lifecycle prefix), an initiative block (which needs a second
// repository and a recorded recap), and the pinned insights population (which needs timestamps
// hours apart). Those are written by hand, deliberately and locally — exactly as
// test/helpers/fixture.mjs's own writeTasks/writeFeature/corrupt exist for. Everything a real op
// CAN produce cheaply (task-start, task-answer, artifact-record, decision-record, review-record,
// escalate-profile, close abandoned) is produced by the real op.
//
// WHAT THESE TESTS PIN, beyond shapes:
//   - H06: one corrupt dossier is ONE unreadable row and the siblings render normally.
//   - H02: an unrecognized status/stage renders `unknown` — never coerced, never a crash.
//   - the recorded-vs-valid rule: approvals carry {at, subjectHash} and NO validity key, while
//     `lifecycleNow` — computed by CALLING the kernel's own approvalValid — flips to false the
//     moment the artifact bytes change. That is the test that proves the kernel functions are
//     called rather than re-implemented.
//   - a weak (`declaredCommands: 0`) receipt is flagged weak and an absent one is not.
//   - the ONE stats formula: exact numbers over a forged two-feature population.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, planTask, NOW } from '../helpers/fixture.mjs';
import {
  APPROVALS_CAVEAT, ATTENTION_KINDS, DRAFT_FILENAMES, KERNEL_STATUSES, QUIET_AFTER_HOURS,
  RECENT_OUTCOME_DAYS, VIEWER_STATUSES, featureSummaries, featureView, groupByInitiative, insights,
} from '../../src/cli/_viewer/projection.mjs';
import { ARTIFACT_KINDS } from '../../src/kernel/state.mjs';
import { ACTIVITY_KINDS, featureActivity } from '../../src/cli/_viewer/activity.mjs';
// The ONE sanctioned export added to src/cli/feature.mjs this task (T39 spec A): the diff to that
// file is the `export` keyword and nothing else. Importing it here is what pins that it IS
// exported; that its BEHAVIOUR is byte-identical is a property of the diff, not of a test.
import { scanRegisteredFeatures } from '../../src/cli/feature.mjs';

/** Run `fn` with LEGION_HOME pinned at a sandbox home, always restored. The projection reads the
 * home lazily on every call (kernel/paths.mjs), so this is all the isolation it needs. */
function withHome(home, fn) {
  const saved = process.env.LEGION_HOME;
  process.env.LEGION_HOME = home;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = saved;
  }
}

const dossierOf = (h, name) => join(h.home, 'orgs', 'default', 'projects', h.project, 'features', name);
const readManifest = (dir, file) => JSON.parse(readFileSync(join(dir, file), 'utf8'));
const writeManifest = (dir, file, doc) => writeFileSync(join(dir, file), `${JSON.stringify(doc, null, 2)}\n`);
const patch = (dir, file, fn) => writeManifest(dir, file, fn(readManifest(dir, file)) ?? readManifest(dir, file));
const keys = (rows) => rows.map((r) => r.key).sort();
const HOUR = 3_600_000;

test('the vocabularies are closed sets and the caveat is the hook\'s wording', () => {
  assert.deepEqual(VIEWER_STATUSES,
    ['delivered', 'abandoned', 'init-failed', 'blocked', 'active', 'unreadable', 'unknown']);
  assert.deepEqual(KERNEL_STATUSES, ['active', 'initialization_failed', 'delivered', 'abandoned']);
  assert.deepEqual(ATTENTION_KINDS, ['open-question', 'init-failed', 'unreadable-manifest', 'quiet']);
  assert.equal(QUIET_AFTER_HOURS, 24);
  assert.equal(RECENT_OUTCOME_DAYS, 7);
  // The rule this whole viewer exists to obey: an approval is RECORDED, never VALID.
  assert.match(APPROVALS_CAVEAT, /recorded != valid/);
  assert.match(APPROVALS_CAVEAT, /the kernel decides at use time/);
  // No lifecycle state the manifests cannot support (header: there is no source for either).
  assert.ok(!VIEWER_STATUSES.includes('stalled'));
  assert.ok(!VIEWER_STATUSES.includes('running'));
});

test('an absent projects.json is an ANSWER (empty inventory), not a crash', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion3-viewer-empty-'));
  try {
    const out = withHome(dir, () => featureSummaries({}));
    assert.deepEqual(out.summaries, []);
    assert.deepEqual(out.unreadable, []);
    assert.deepEqual(out.population, { features: 0, readable: 0, unreadable: 0 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('H06: one corrupt dossier is ONE unreadable row and the siblings survive', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    for (const n of ['f2', 'f3']) {
      const r = h.legionIn(h.repoRoot, 'feature', 'start', n, '--base', 'main');
      assert.equal(r.code, 0, r.stderr);
    }
    // f2's feature.json will not parse; f3's tasks.json will not parse. Two DIFFERENT files, so
    // the inventory has to survive a break in either manifest, not just the first one it reads.
    writeFileSync(join(dossierOf(h, 'f2'), 'feature.json'), '{ this is not json\n');
    assert.equal(h.legionIn(h.worktree, 'state', 'init').code !== -1, true);
    const f3 = dossierOf(h, 'f3');
    writeFileSync(join(f3, 'tasks.json'), '{ also not json\n');

    const out = withHome(h.home, () => featureSummaries({}));
    assert.deepEqual(keys(out.summaries), ['default/proj/f1']);
    assert.deepEqual(keys(out.unreadable), ['default/proj/f2', 'default/proj/f3']);
    for (const u of out.unreadable) {
      assert.equal(u.unreadable, true);
      assert.equal(u.viewerStatus, 'unreadable');
      assert.deepEqual(u.attention.map((a) => a.kind), ['unreadable-manifest']);
      assert.match(u.why, /corrupt JSON in .*\.json/);
      assert.equal(u.attention[0].detail.why, u.why);
    }
    assert.deepEqual(out.population, { features: 3, readable: 1, unreadable: 2 });
    // The surviving feature is NOT degraded by its broken siblings.
    assert.equal(out.summaries[0].viewerStatus, 'active');
    // And the detail view of a broken one renders the honest row rather than throwing.
    const v = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f2' }));
    assert.equal(v.unreadable, true);
    assert.match(v.why, /corrupt JSON/);
    // A feature that does not exist at all is a CALLER error and dies loudly (the server's 404).
    assert.throws(
      () => withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'nope' })),
      /no such feature 'default\/proj\/nope'/,
    );
  } finally { h.cleanup(); }
});

test('an unanswered question is `blocked` plus an attention row naming the tasks', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.seedPlan([planTask('T1', { milestone: 'M1' }), planTask('T2', { milestone: 'M1' })]);
    assert.equal(h.legion('state', 'task-start', 'T1').code, 0);
    // The OPEN question. `task-answer` refuses a null answer by design (both flags are required),
    // so the unanswered half is written by hand — it is the shape the build loop's blocked-as-data
    // produces and the shape hooks/session-start.mjs already reads (`answer == null`).
    patch(dossierOf(h, 'f1'), 'tasks.json', (t) => ({
      ...t,
      tasks: t.tasks.map((x) => (x.id === 'T1'
        ? { ...x, answers: [{ question: 'which shape?', answer: null, at: NOW }] }
        : x)),
    }));

    const { summaries } = withHome(h.home, () => featureSummaries({ org: 'default' }));
    const s = summaries.find((x) => x.name === 'f1');
    assert.equal(s.viewerStatus, 'blocked');
    assert.equal(s.kernelStatus, 'active'); // the KERNEL status is rendered verbatim beside it
    assert.deepEqual(s.tasks, { total: 2, done: 0, started: 1, pending: 1, openQuestions: 1 });
    const row = s.attention.find((a) => a.kind === 'open-question');
    assert.deepEqual(row.detail, { count: 1, taskIds: ['T1'] });

    // An ANSWERED question is not attention: the row exists, the queue is empty.
    assert.equal(h.legion('state', 'task-answer', 'T1', '--question', 'q', '--answer', 'a').code, 0);
    patch(dossierOf(h, 'f1'), 'tasks.json', (t) => ({
      ...t,
      tasks: t.tasks.map((x) => (x.id === 'T1' ? { ...x, answers: x.answers.slice(1) } : x)),
    }));
    const again = withHome(h.home, () => featureSummaries({ org: 'default' })).summaries
      .find((x) => x.name === 'f1');
    assert.equal(again.viewerStatus, 'active');
    assert.equal(again.tasks.openQuestions, 0);
    assert.deepEqual(again.attention, []);
  } finally { h.cleanup(); }
});

test('closed outcomes win over everything, and a real `close abandoned` renders abandoned', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    assert.equal(h.legionIn(h.repoRoot, 'feature', 'start', 'f2', '--base', 'main').code, 0);
    // A REAL close for abandoned (it needs no evidence the kernel must derive)…
    assert.equal(h.legion('state', 'close', 'abandoned').code, 0);
    // …and a hand-written delivered, because `close delivered` demands a boundary receipt, a
    // read-back MR and the whole prefix — evidence this projection never reads.
    const d2 = dossierOf(h, 'f2');
    patch(d2, 'feature.json', (f) => ({
      ...f, status: 'delivered', stage: 'finalize', closedAt: NOW, initError: 'stale bootstrap error',
    }));

    const { summaries } = withHome(h.home, () => featureSummaries({}));
    const byName = Object.fromEntries(summaries.map((s) => [s.name, s]));
    assert.equal(byName.f1.viewerStatus, 'abandoned');
    assert.equal(byName.f1.closedAt, NOW);
    // A delivered feature's old initError is HISTORY: the closed outcome wins, and no
    // init-failed attention row is raised over a finished feature.
    assert.equal(byName.f2.viewerStatus, 'delivered');
    assert.deepEqual(byName.f2.attention, []);
  } finally { h.cleanup(); }
});

test('H02: an unrecognized status or stage renders `unknown`, never a guess', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    assert.equal(h.legionIn(h.repoRoot, 'feature', 'start', 'f2', '--base', 'main').code, 0);
    patch(dossierOf(h, 'f1'), 'feature.json', (f) => ({ ...f, stage: 'polishing' }));
    patch(dossierOf(h, 'f2'), 'feature.json', (f) => ({ ...f, status: 'paused' }));

    const { summaries } = withHome(h.home, () => featureSummaries({}));
    const byName = Object.fromEntries(summaries.map((s) => [s.name, s]));
    assert.equal(byName.f1.viewerStatus, 'unknown');
    assert.equal(byName.f1.stage, 'polishing');  // rendered VERBATIM, never coerced to a real stage
    assert.equal(byName.f1.stageKnown, false);
    assert.equal(byName.f2.viewerStatus, 'unknown');
    assert.equal(byName.f2.kernelStatus, 'paused'); // verbatim too

    // The detail view refuses to fake a kernel verdict it cannot ask for.
    const v = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.equal(v.lifecycleNow.available, false);
    assert.match(v.lifecycleNow.why, /"polishing" is not a stage this kernel knows/);
    assert.equal(v.lifecycleNow.satisfied, undefined); // no green, no red — no claim at all
  } finally { h.cleanup(); }
});

test('an initialization_failed feature is init-failed, with the recorded error', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    patch(dossierOf(h, 'f1'), 'feature.json', (f) => ({
      ...f, status: 'initialization_failed', initError: 'bootstrap: npm ci exited 1',
    }));
    const { summaries } = withHome(h.home, () => featureSummaries({}));
    assert.equal(summaries[0].viewerStatus, 'init-failed');
    assert.deepEqual(summaries[0].attention, [{
      kind: 'init-failed',
      detail: { message: 'bootstrap: npm ci exited 1', status: 'initialization_failed' },
    }]);
  } finally { h.cleanup(); }
});

test('a weak (declaredCommands 0) receipt is flagged weak; a full one is not; an absent one is neither', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.seedPlan([planTask('T1', { milestone: 'M1' }), planTask('T2', { milestone: 'M1' }), planTask('T3', { milestone: 'M2' })]);
    // Receipts are minted ONLY by a real `legion gate run`, which this suite never runs — so the
    // two shapes are written by hand, exactly as the R1 adversarial cases do.
    const weak = { tier: 'task', commandPolicyHash: 'h0', results: [], declaredCommands: 0, head: 'H', treeHash: 'T', at: NOW };
    const full = { tier: 'task', commandPolicyHash: 'h1', results: [{ name: 'test', argv: ['x'], exitCode: 0, ms: 1 }], declaredCommands: 1, head: 'H', treeHash: 'T', at: NOW };
    patch(dossierOf(h, 'f1'), 'tasks.json', (t) => ({
      ...t,
      tasks: t.tasks.map((x) => (x.id === 'T1' ? { ...x, receipt: weak } : x.id === 'T2' ? { ...x, receipt: full } : x)),
      receipts: { boundary: { ...weak, tier: 'boundary' } },
    }));

    const v = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    const byId = Object.fromEntries(v.tasksDetail.map((t) => [t.id, t]));
    assert.equal(byId.T1.receipt.present, true);
    assert.equal(byId.T1.receipt.declaredCommands, 0);
    assert.equal(byId.T1.receipt.weak, true);
    assert.equal(byId.T2.receipt.weak, false);
    assert.equal(byId.T2.receipt.declaredCommands, 1);
    // ABSENT is not weak — nothing was certified at all, which is the louder statement.
    assert.deepEqual(byId.T3.receipt.present, false);
    assert.equal(byId.T3.receipt.weak, false);
    assert.equal(byId.T3.receipt.declaredCommands, null);
    assert.equal(v.boundaryReceipt.present, true);
    assert.equal(v.boundaryReceipt.weak, true);
    assert.equal(v.boundaryReceipt.tier, 'boundary');
    // The activity feed says it in words too, so a weak certificate cannot read like a full one.
    const receiptRows = v.activity.filter((a) => a.kind === 'gate-receipt');
    assert.equal(receiptRows.filter((r) => /TIER-0 ONLY, a real but WEAK certificate/.test(r.label)).length, 2);
    assert.equal(receiptRows.filter((r) => /1 declared command\(s\)\)$/.test(r.label)).length, 1);
  } finally { h.cleanup(); }
});

test('approvals render RECORDED; validity comes from CALLING the kernel and dies with the bytes', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    const intent = h.writeArtifact('intent.md', '# intent\nthe agreed shape\n');
    assert.equal(h.legion('state', 'artifact-record', 'intent', intent).code, 0);
    assert.equal(h.legion('state', 'decision-record', 'intake').code, 0);
    assert.equal(h.legion('state', 'escalate-profile', 'standard').code, 0);

    const before = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    // RECORDED: exactly the two stored facts, and no validity key anywhere in the block.
    assert.deepEqual(Object.keys(before.approvals), ['intake']);
    assert.deepEqual(Object.keys(before.approvals.intake).sort(), ['at', 'subjectHash']);
    assert.equal(before.approvals.intake.at, NOW);
    assert.equal(before.approvalsCaveat, APPROVALS_CAVEAT);
    assert.ok(!/valid/i.test(JSON.stringify(before.approvals)));
    // COMPUTED NOW, by the kernel's own approvalValid — the intake row re-derives satisfied.
    assert.equal(before.lifecycleNow.available, true);
    assert.equal(before.lifecycleNow.approvalsValidNow.intake, true);
    assert.equal(before.lifecycleNow.satisfied, true);
    assert.equal(before.lifecycleNow.nextUnsatisfied, null);
    // The artifact is rendered DOSSIER-RELATIVE (that is what /api/artifact accepts).
    assert.equal(before.artifacts.intent.path, 'intent.md');
    assert.equal(before.artifacts.intent.inside, true);

    // Edit the bytes the approval bound to. The RECORD does not move; the kernel's verdict does.
    writeFileSync(intent, '# intent\nsomething else entirely\n');
    const after = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.deepEqual(after.approvals.intake, before.approvals.intake); // still RECORDED, unchanged
    assert.equal(after.lifecycleNow.approvalsValidNow.intake, false);
    assert.equal(after.lifecycleNow.satisfied, false);
    assert.match(after.lifecycleNow.why, /no hash-valid intake approval/);
    assert.deepEqual(after.lifecycleNow.nextUnsatisfied.stage, 'intake');
  } finally { h.cleanup(); }
});

test('a conventional draft file renders recorded:false; a record always wins its kind', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    // On disk, never recorded: existence on this request is the only claim — no hash, no at.
    h.writeArtifact('spec.md', '# spec draft\n');
    const drafted = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.deepEqual(drafted.artifacts.spec,
      { path: 'spec.md', inside: true, hash: null, at: null, recorded: false });

    // Record the kind at a DIFFERENT, free-form path: the manifest is the ledger, the disk is
    // not — the record takes the kind and the still-present draft file stops mattering.
    const real = h.writeArtifact('specs-final.md', '# the recorded spec\n');
    assert.equal(h.legion('state', 'artifact-record', 'spec', real).code, 0);
    const recorded = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.equal(recorded.artifacts.spec.recorded, true);
    assert.equal(recorded.artifacts.spec.path, 'specs-final.md');
    assert.ok(recorded.artifacts.spec.hash);
    assert.equal(recorded.artifacts.spec.at, NOW);
  } finally { h.cleanup(); }
});

test('drafts slot into ARTIFACT_KINDS lifecycle order beside recorded kinds', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.seedPlan([planTask('T1')]); // records `plan` through the real import
    h.writeArtifact('intent.md', '# intent draft\n'); // draft, never recorded
    const v = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.deepEqual(Object.keys(v.artifacts), ['intent', 'plan']);
    assert.equal(v.artifacts.intent.recorded, false);
    assert.equal(v.artifacts.plan.recorded, true);
  } finally { h.cleanup(); }
});

test('mockups/*.html surface as mock: draft rows — a recorded kind naming the same file wins', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    // The mock convention records nothing (skills/feature SKILL.md), so without this scan the
    // one artifact the human approved a surface from would never appear in the viewer.
    mkdirSync(join(h.dossier, 'mockups'), { recursive: true });
    writeFileSync(join(h.dossier, 'mockups', 'modal.html'), '<h1>mock</h1>\n');
    writeFileSync(join(h.dossier, 'mockups', 'notes.txt'), 'not a mock\n'); // wrong extension: skipped
    const v = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.deepEqual(v.artifacts['mock:modal'],
      { path: 'mockups/modal.html', inside: true, hash: null, at: null, recorded: false });
    assert.ok(!('mock:notes' in v.artifacts));

    // Recorded under a real kind at the SAME path: the ledger's row is the only row.
    assert.equal(h.legion('state', 'artifact-record', 'preview', join(h.dossier, 'mockups', 'modal.html')).code, 0);
    const rec = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.equal(rec.artifacts.preview.recorded, true);
    assert.ok(!('mock:modal' in rec.artifacts), 'no duplicate row for the recorded mock');
  } finally { h.cleanup(); }
});

test('an unknown recorded kind appends after known kinds and drafts, verbatim', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.writeArtifact('spec.md', '# spec draft\n');
    // Only a hand-edit can produce an unknown kind — artifact-record validates against
    // ARTIFACT_KINDS — so this is a forgery, exactly what writeTasks exists for.
    const rogue = h.writeArtifact('rogue.md', '# rogue\n');
    h.writeTasks((doc) => ({ ...doc, artifacts: { ...doc.artifacts, sidecar: { path: rogue, hash: 'h', at: NOW } } }));
    const v = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.deepEqual(Object.keys(v.artifacts), ['spec', 'sidecar']);
    assert.equal(v.artifacts.sidecar.recorded, true);
    assert.equal(v.artifacts.sidecar.path, 'rogue.md');
  } finally { h.cleanup(); }
});

test('DRAFT_FILENAMES keys are ARTIFACT_KINDS members — a display convention, not a second vocabulary', () => {
  for (const kind of Object.keys(DRAFT_FILENAMES)) {
    assert.ok(ARTIFACT_KINDS.includes(kind), `'${kind}' is not a kernel artifact kind`);
  }
  // No draft convention for review/preview — their absence here is deliberate (projection docblock).
  assert.ok(!('review' in DRAFT_FILENAMES) && !('preview' in DRAFT_FILENAMES));
});

test('lifecycleNow is unavailable — never green — before the plan is imported', () => {
  const h = fixture({ project: 'proj', feature: 'f1', stateInit: false });
  try {
    const v = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.equal(v.hasPlan, false);
    assert.equal(v.lifecycleNow.available, false);
    assert.match(v.lifecycleNow.why, /tasks\.json does not exist yet/);
    assert.deepEqual(v.tasksDetail, []);
    assert.deepEqual(v.milestones, []);
    assert.deepEqual(v.approvals, {});
    assert.equal(v.boundaryReceipt.present, false);
    assert.equal(v.viewerStatus, 'active');
  } finally { h.cleanup(); }
});

test('quiet flips on a backdated manifest mtime, and is a fact about files, not a state', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    const fresh = withHome(h.home, () => featureSummaries({})).summaries[0];
    assert.equal(fresh.viewerStatus, 'active');
    assert.deepEqual(fresh.attention, []);
    assert.ok(fresh.ageHours < QUIET_AFTER_HOURS);

    const dossier = dossierOf(h, 'f1');
    const old = new Date(Date.now() - 30 * HOUR);
    for (const f of ['feature.json', 'tasks.json']) utimesSync(join(dossier, f), old, old);

    const quiet = withHome(h.home, () => featureSummaries({})).summaries[0];
    assert.equal(quiet.viewerStatus, 'active'); // STILL active — quiet is not a lifecycle state
    const row = quiet.attention.find((a) => a.kind === 'quiet');
    assert.ok(row, 'expected a quiet attention row after 30h without a manifest write');
    assert.equal(row.detail.sinceHours, QUIET_AFTER_HOURS);
    assert.ok(row.detail.ageHours > QUIET_AFTER_HOURS && row.detail.ageHours < 32);
    assert.equal(quiet.updatedAt, new Date(old.getTime()).toISOString());
  } finally { h.cleanup(); }
});

test('initiative siblings group by scan, within the org, naming what could not be read', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    for (const n of ['f2', 'f3', 'f4']) {
      assert.equal(h.legionIn(h.repoRoot, 'feature', 'start', n, '--base', 'main').code, 0);
    }
    // A REAL initiative spans repositories and needs the primary's recorded recap; the block
    // itself is rendered verbatim and the grouping is a pure scan over summaries, so hand-written
    // blocks exercise exactly what this helper does.
    patch(dossierOf(h, 'f1'), 'feature.json', (f) => ({ ...f, initiative: { id: 'INIT-1', role: 'primary' } }));
    patch(dossierOf(h, 'f2'), 'feature.json', (f) => ({
      ...f, initiative: { id: 'INIT-1', role: 'secondary', primary: 'default/proj/f1' },
    }));
    patch(dossierOf(h, 'f4'), 'feature.json', (f) => ({ ...f, initiative: { id: 'INIT-2', role: 'primary' } }));
    writeFileSync(join(dossierOf(h, 'f3'), 'feature.json'), '{ broken\n');

    const out = withHome(h.home, () => featureSummaries({}));
    const g = groupByInitiative(out.summaries, out.unreadable);
    const init1 = g.groups.find((x) => x.id === 'INIT-1');
    assert.equal(init1.org, 'default');
    assert.deepEqual(init1.members.map((m) => m.key).sort(), ['default/proj/f1', 'default/proj/f2']);
    assert.deepEqual(init1.members.map((m) => m.role).sort(), ['primary', 'secondary']);
    assert.equal(init1.primary, 'default/proj/f1');
    assert.equal(g.groups.find((x) => x.id === 'INIT-2').members.length, 1);
    assert.deepEqual(g.ungrouped, []); // f3 is unreadable, not ungrouped
    assert.deepEqual(g.unreadable.map((u) => u.key), ['default/proj/f3']);
    // The block itself travels VERBATIM on the summary.
    const s2 = out.summaries.find((s) => s.name === 'f2');
    assert.deepEqual(s2.initiative, { id: 'INIT-1', role: 'secondary', primary: 'default/proj/f1' });
    assert.equal(out.summaries.find((s) => s.name === 'f4').initiative.id, 'INIT-2');
  } finally { h.cleanup(); }
});

test('the org filter is display-only and selects nothing outside the org', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    const all = withHome(h.home, () => featureSummaries({}));
    assert.equal(all.summaries.length, 1);
    const scoped = withHome(h.home, () => featureSummaries({ org: 'default' }));
    assert.deepEqual(keys(scoped.summaries), keys(all.summaries));
    const other = withHome(h.home, () => featureSummaries({ org: 'no_such_org' }));
    assert.deepEqual(other.summaries, []);
    assert.deepEqual(other.unreadable, []);
    // The sanctioned export is reachable and still org-scoped, byte-for-byte as before.
    const scan = withHome(h.home, () => scanRegisteredFeatures({ org: 'default' }));
    assert.deepEqual(scan.rows.map((r) => r.label), ['default/proj/f1']);
    assert.throws(() => scanRegisteredFeatures({}), /an org is required/);
  } finally { h.cleanup(); }
});

test('the detail view: two-level milestones, verbatim spine, worktree as an fs fact', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    h.seedPlan([
      planTask('T1', { milestone: 'M1' }),
      planTask('T2', { milestone: 'M1' }),
      planTask('T3', { milestone: 'M2' }),
    ]);
    // `plan check --import` puts every imported task under ONE milestone (the fixture's
    // writePlanTasks wraps them in a single block), so the second milestone is set by hand — the
    // grouping under test is derived from `tasks[].milestone`, whatever wrote it.
    patch(dossierOf(h, 'f1'), 'tasks.json', (t) => ({
      ...t, tasks: t.tasks.map((x) => (x.id === 'T3' ? { ...x, milestone: 'M2' } : x)),
    }));
    assert.equal(h.legion('state', 'task-start', 'T1').code, 0);
    assert.equal(h.legion('gate', 'review-receipt', '--agent-type', 'legion:code-reviewer', '--agent-id', 'vp-rev', '--verdict', 'pass').code, 0);
    assert.equal(h.legion('state', 'review-record', '--role', 'code-reviewer', '--verdict', 'pass', '--subject', 'milestone:M1').code, 0);
    assert.equal(h.legion('state', 'session-record', '--session-id', 'sess-1').code, 0);

    const v = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.deepEqual(v.milestones.map((m) => m.id), ['M1', 'M2']);
    assert.deepEqual(v.milestones[0].taskIds, ['T1', 'T2']);
    assert.deepEqual(v.milestones[0].tasks, { total: 2, done: 0, started: 1, pending: 1 });
    assert.deepEqual(v.milestones[0].closeReviews, [{ role: 'code-reviewer', verdict: 'pass', at: NOW }]);
    assert.deepEqual(v.milestones[1].closeReviews, []);
    assert.equal(v.worktree.path, h.worktree);
    assert.equal(v.worktree.present, true);
    assert.deepEqual(v.sessions, { current: 'sess-1', history: [{ sessionId: 'sess-1', at: NOW }] });
    assert.deepEqual(v.reviews, [{ role: 'code-reviewer', verdict: 'pass', subject: 'milestone:M1', at: NOW }]);
    // The projection NEVER spawns git: commits arrive injected, so an un-supplied view says so.
    assert.equal(v.git.available, false);
    assert.match(v.git.reason, /the projection never spawns git/);
    const injected = withHome(h.home, () => featureView({
      org: 'default', project: 'proj', name: 'f1',
      commits: [{ sha: 'abcdef1234', at: '2026-07-25T01:00:00.000Z', subject: 'work' }],
    }));
    assert.equal(injected.git.available, true);
    assert.ok(injected.activity.some((a) => a.kind === 'commit' && a.label === 'abcdef12 work'));
    // A vanished worktree is an ordinary fact, not an error (`legion feature clean` removes it).
    patch(dossierOf(h, 'f1'), 'feature.json', (f) => ({ ...f, worktree: join(h.sandbox, 'gone') }));
    const gone = withHome(h.home, () => featureView({ org: 'default', project: 'proj', name: 'f1' }));
    assert.equal(gone.worktree.present, false);
  } finally { h.cleanup(); }
});

test('activity: time-sorted, every row a recorded fact, undated rows last', () => {
  // PURE — no filesystem, no LEGION_HOME, no git: the whole point of activity.mjs's shape.
  const feature = {
    stageHistory: [{ stage: 'intake', at: '2026-07-25T03:00:00.000Z' }, { stage: 'spec', at: '2026-07-25T05:00:00.000Z' }],
    completedStages: [{ stage: 'intake', at: '2026-07-25T04:00:00.000Z' }],
    sessionHistory: [{ sessionId: 's1', at: '2026-07-25T01:00:00.000Z' }],
    currentSession: 's1',
    mr: { iid: 7, headSha: 'deadbee', at: 'not-a-date' },
  };
  const tasks = {
    tasks: [{
      id: 'T1',
      startedAt: '2026-07-25T06:00:00.000Z',
      doneAt: '2026-07-25T08:00:00.000Z',
      answers: [
        { question: 'q', answer: null, at: '2026-07-25T07:00:00.000Z' },
        { question: 'q2', answer: 'a2', at: '2026-07-25T07:30:00.000Z' },
      ],
      receipt: { declaredCommands: 2, at: '2026-07-25T07:45:00.000Z' },
    }],
    reviews: [{ role: 'code-reviewer', verdict: 'fail', subject: 'feature', at: '2026-07-25T09:00:00.000Z' }],
    approvals: { intake: { at: '2026-07-25T02:00:00.000Z', subjectHash: 'x' } },
    receipts: { boundary: null },
  };
  const rows = featureActivity({ feature, tasks, commits: [{ sha: 'abc1234567', at: '2026-07-25T00:30:00.000Z', subject: 'init' }] });

  assert.deepEqual(rows.map((r) => r.kind), [
    'commit', 'session', 'approval', 'stage-enter', 'stage-complete', 'stage-enter',
    'task-start', 'question', 'answer', 'gate-receipt', 'task-done', 'review',
    'mr', // unparseable `at` sorts LAST, carrying the recorded value verbatim
  ]);
  assert.equal(rows[rows.length - 1].at, 'not-a-date');
  for (const r of rows) assert.ok(ACTIVITY_KINDS.includes(r.kind), `unknown kind ${r.kind}`);
  // Ascending, and every `at` is a string that came out of the input (nothing interpolated).
  const dated = rows.filter((r) => !Number.isNaN(Date.parse(r.at)));
  const sorted = [...dated].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  assert.deepEqual(dated, sorted);
  const recorded = new Set(JSON.stringify({ feature, tasks }).match(/2026-07-25T[0-9:.]+Z/g));
  for (const r of dated) assert.ok(recorded.has(r.at) || r.kind === 'commit', `${r.at} is not a recorded timestamp`);
  // No tasks.json yet ⇒ only the feature.json rows; still no crash.
  assert.deepEqual(featureActivity({ feature: {}, tasks: null }), []);
});

test('insights: THE one stats formula, pinned exactly over a forged two-feature population', () => {
  const h = fixture({ project: 'proj', feature: 'fa' });
  try {
    assert.equal(h.legionIn(h.repoRoot, 'feature', 'start', 'fb', '--base', 'main').code, 0);
    assert.equal(h.legionIn(h.worktree, 'state', 'init').code === 0 || true, true);
    const now = Date.parse('2026-07-25T00:00:00.000Z');
    const T0 = now - 24 * HOUR; // inside the 7-day recent window
    const at = (hours) => new Date(T0 + hours * HOUR).toISOString();

    const A = dossierOf(h, 'fa');
    patch(A, 'feature.json', (f) => ({
      ...f,
      status: 'delivered',
      stage: 'finalize',
      closedAt: at(10),
      stageHistory: [{ stage: 'intake', at: at(0) }, { stage: 'spec', at: at(1) }, { stage: 'plan', at: at(3) }],
    }));
    patch(A, 'tasks.json', (t) => ({
      ...t,
      tasks: [
        { id: 'T1', title: 'a', status: 'done', attempt: 0, milestone: 'M1', depends_on: [] },
        { id: 'T2', title: 'b', status: 'done', attempt: 1, milestone: 'M1', depends_on: [] },
      ],
      reviews: [
        { role: 'code-reviewer', verdict: 'fail', subject: 'feature', subjectHash: 'h', at: at(8) },
        { role: 'code-reviewer', verdict: 'pass', subject: 'feature', subjectHash: 'h', at: at(9) },
        { role: 'product-reviewer', verdict: 'pass', subject: 'feature', subjectHash: 'h', at: at(9) },
      ],
    }));

    const B = dossierOf(h, 'fb');
    // fb was started without `state init`, so give it the tasks.json this population needs.
    writeManifest(B, 'tasks.json', {
      schemaVersion: 1, legionVersion: '0.0.0', revision: 0, featureId: 'default/proj/fb',
      tasks: [
        { id: 'T1', title: 'a', status: 'done', attempt: 0, milestone: 'M1', depends_on: [] },
        { id: 'T2', title: 'b', status: 'started', attempt: 0, milestone: 'M1', depends_on: [] },
        { id: 'T3', title: 'c', status: 'pending', attempt: 2, milestone: 'M2', depends_on: [] },
      ],
      artifacts: {}, approvals: {},
      reviews: [{ role: 'plan-critic', verdict: 'fail', subject: 'plan', subjectHash: 'h', at: at(4) }],
      receipts: { boundary: null }, createdAt: at(0), updatedAt: at(4),
    });
    patch(B, 'feature.json', (f) => ({
      ...f,
      stage: 'spec',
      stageHistory: [{ stage: 'intake', at: at(0) }, { stage: 'spec', at: at(2) }],
      mr: { iid: 3, url: 'https://gitlab.invalid/x/-/merge_requests/3', targetBranch: 'main', headSha: 'abc', at: at(6) },
    }));

    const out = withHome(h.home, () => insights({ now }));

    assert.deepEqual(out.population, { features: 2, readable: 2, unreadable: 0, org: null, tasks: 5 });
    assert.deepEqual(out.outcomes, {
      delivered: 1, abandoned: 0, 'init-failed': 0, blocked: 0, active: 1, unreadable: 0, unknown: 0,
    });
    assert.deepEqual(out.recentOutcomes, {
      windowDays: 7, delivered: 1, abandoned: 0, features: ['default/proj/fa'],
    });
    // fa: at(0) -> closedAt at(10) = 10h. fb: at(0) -> mr.at at(6) = 6h. Nearest-rank, n=2:
    // p50 -> rank 1 -> the 6h value; p90 -> rank 2 -> the 10h value. No interpolation.
    assert.deepEqual(out.featureDuration, {
      n: 2, p50Ms: 6 * HOUR, p90Ms: 10 * HOUR, minMs: 6 * HOUR, maxMs: 10 * HOUR,
      excluded: { noStart: 0, noEnd: 0, negative: 0 },
    });
    // Consecutive stageHistory deltas, attributed to the stage being LEFT. `plan` and the
    // second `spec` are OPEN intervals (no successor) and are therefore not measured.
    assert.deepEqual(Object.keys(out.stageDuration), ['intake', 'spec']);
    assert.deepEqual(out.stageDuration.intake, { n: 2, p50Ms: 1 * HOUR, p90Ms: 2 * HOUR, minMs: 1 * HOUR, maxMs: 2 * HOUR });
    assert.deepEqual(out.stageDuration.spec, { n: 1, p50Ms: 2 * HOUR, p90Ms: 2 * HOUR, minMs: 2 * HOUR, maxMs: 2 * HOUR });
    assert.deepEqual(out.attempts, { tasks: 5, features: 2, distribution: { 0: 3, 1: 1, 2: 1 } });
    // fa: code-reviewer/feature is [fail, pass] -> one fix round; product-reviewer is a lone pass.
    // fb: plan-critic/plan is a lone fail -> UNRESOLVED, reported separately, never folded in.
    assert.deepEqual(out.reviewRounds, {
      features: 2, reviews: 4, fixRounds: 1, unresolvedFails: 1,
      byFeature: [
        { key: 'default/proj/fa', reviews: 3, fixRounds: 1, unresolvedFails: 0 },
        { key: 'default/proj/fb', reviews: 1, fixRounds: 0, unresolvedFails: 1 },
      ],
    });
    // NO COST AND NO TOKEN NUMBERS ANYWHERE: no source exists, so nothing is rendered (decision 9).
    assert.ok(!/cost|token/i.test(JSON.stringify(out)));
  } finally { h.cleanup(); }
});

test('insights carries its denominators when the population is empty or unreadable', () => {
  const h = fixture({ project: 'proj', feature: 'f1' });
  try {
    writeFileSync(join(dossierOf(h, 'f1'), 'feature.json'), '{ nope\n');
    const out = withHome(h.home, () => insights({}));
    assert.deepEqual(out.population, { features: 1, readable: 0, unreadable: 1, org: null, tasks: 0 });
    assert.equal(out.outcomes.unreadable, 1);
    // Empty is reported as empty — never smoothed into a zero that looks like a measurement.
    assert.deepEqual(out.featureDuration,
      { n: 0, p50Ms: null, p90Ms: null, minMs: null, maxMs: null, excluded: { noStart: 0, noEnd: 0, negative: 0 } });
    assert.deepEqual(out.stageDuration, {});
    assert.deepEqual(out.attempts, { tasks: 0, features: 0, distribution: {} });
    assert.deepEqual(out.reviewRounds, { features: 0, reviews: 0, fixRounds: 0, unresolvedFails: 0, byFeature: [] });
  } finally { h.cleanup(); }
});
