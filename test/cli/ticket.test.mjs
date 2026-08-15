// End-to-end guard for the TICKET IDENTITY surface (T36), driven through the REAL bin against a
// real fixture repo with LEGION_HOME pinned per sandbox: `feature start --ticket`, the typed op
// `legion state ticket-record`, `project init --ticket-closing-style`, and the one `legion doctor`
// info line. No network, no agents — the fixture's fakebin shims cover glab/claude, and nothing
// here goes anywhere near a remote (the closing reference and the issue comment are `legion
// finalize`'s, and finalize is not touched by this task).
//
// THE CLAIMS, in the order the threat model ranks them:
//   1. A TICKET-LESS FEATURE IS BYTE-IDENTICAL TO PRE-T36. The whole track is additive; a feature
//      with no ticket must have the same manifest keys, the same output and the same behaviour it
//      always had. Pinned key-for-key, exactly as M1b pinned it for the initiative block.
//   2. ONE VALIDATOR, TWO WRITERS. `--ticket` and `ticket-record` must accept and refuse the same
//      strings — proven by driving the same garbage through both and comparing the refusals — and
//      every refusal must leave BOTH manifests byte-identical (a refused op writes nothing).
//   3. THE KERNEL NEVER DERIVES A REF. `feature start` without `--ticket` records no ticket even
//      though the branch name is right there; a ticket appears only when a human supplies one.
//   4. CONFIG IS OPERATOR-FACING AND ITS LEVEL IS VISIBLE. doctor states the resolved config and
//      which level each field came from, never fails on it, and prints a corrupt org.json's
//      refusal rather than swallowing it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture } from '../helpers/fixture.mjs';

const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);
const writeJson = (p, doc) => writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);

/** A second feature in the fixture's project, started through the same real bin. Mirrors
 * test/cli/initiative.test.mjs's helper — the cases here assert on refusals as often as successes. */
function startFeature(h, name, ...extra) {
  const r = h.legionIn(h.repoRoot, 'feature', 'start', name, '--base', 'main', ...extra);
  const dossier = join(h.home, 'orgs', 'default', 'projects', h.project, 'features', name);
  const worktree = join(dirname(h.repoRoot), '.legion-worktrees', h.project, name, 'checkout');
  return {
    r,
    name,
    dossier,
    worktree,
    legion: (...argv) => h.legionIn(worktree, ...argv),
    readFeature: () => JSON.parse(readFileSync(join(dossier, 'feature.json'), 'utf8')),
  };
}

/** The T17/R18 rule: a refused start leaves NO manifest, NO worktree, NO branch to block a retry. */
function assertNothingStarted(h, s) {
  assert.ok(!existsSync(join(s.dossier, 'feature.json')), `${s.name}: a refused start wrote a manifest`);
  assert.ok(!existsSync(s.worktree), `${s.name}: a refused start created a worktree`);
}

/** Deliberate garbage, one list, driven through BOTH writers so "one shared validator" is proven by
 * behaviour rather than by reading the imports. */
const GARBAGE = ['', ' ', 'abc', '#0', '007', '#12a', 'proj#1', 'a/b#0'];

// --- the flag ------------------------------------------------------------------------------------

test('WITHOUT --ticket the manifest is byte-identical to what start has always written', () => {
  const h = fixture();
  const plain = startFeature(h, 'f2');
  assert.equal(plain.r.code, 0, plain.r.stderr);
  const f = plain.readFeature();
  assert.equal(f.ticket, undefined, 'the field is OPTIONAL — absence is the ordinary case');
  // Key-for-key, in write order (the same red line M1b drew for the initiative block): the tickets
  // track is additive and a new key in EVERY manifest would break it.
  assert.deepEqual(Object.keys(f), [
    'schemaVersion', 'legionVersion', 'revision', 'org', 'project', 'name', 'featureId',
    'repoRoot', 'baseBranch', 'baseSha', 'commandPolicyHash', 'commandPolicy',
    'commandPolicyPinnedAt', 'worktree', 'branch', 'profile', 'stage', 'status',
    'createdAt', 'updatedAt', 'sessionHistory',
  ]);
  assert.ok(!plain.r.stdout.includes('ticket'), 'and nothing about tickets is printed');
  // THE KERNEL NEVER DERIVES ONE: the branch is feat/f2 and the feature id is right there, and
  // still no ticket was invented.
  assert.equal(f.branch, 'feat/f2');
});

test('--ticket records the ref VERBATIM and prints it where the operator is looking', () => {
  const h = fixture();
  for (const [name, ref] of [['f2', '#41'], ['f3', '123'], ['f4', 'acme/api#7']]) {
    const s = startFeature(h, name, '--ticket', ref);
    assert.equal(s.r.code, 0, s.r.stderr);
    assert.equal(s.readFeature().ticket, ref, 'stored exactly as supplied — never normalised');
    assert.match(s.r.stdout, new RegExp(`^ {2}ticket: +${ref.replace(/[#/]/g, '\\$&')}$`, 'm'));
  }
  // …and the field sits AFTER the derived identity, so the additive keys are the tail.
  const keys = Object.keys(startFeature(h, 'f5', '--ticket', '#9').readFeature());
  assert.equal(keys.at(-1), 'sessionHistory');
  assert.ok(keys.includes('ticket'));
});

test('a garbage --ticket refuses naming the accepted shapes, and leaves NO trace', () => {
  const h = fixture();
  let i = 0;
  for (const bad of GARBAGE) {
    const s = startFeature(h, `bad${i++}`, '--ticket', bad);
    assert.equal(s.r.code, 1, `${JSON.stringify(bad)} must be refused: ${s.r.stdout}`);
    assert.match(s.r.stderr, /--ticket: /);
    assert.match(s.r.stderr, /'123', '#123' or 'group\/project#123'/);
    assertNothingStarted(h, s);
  }
});

test('--ticket with --repair REFUSES rather than being silently dropped, and names the op', () => {
  const h = fixture();
  const r = h.legionIn(h.repoRoot, 'feature', 'start', h.feature, '--base', 'main', '--repair', '--ticket', '#5');
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /--ticket cannot be combined with --repair/);
  assert.match(r.stderr, /legion state ticket-record <ref>/);
  // The refusal must land BEFORE repair's own preconditions — the feature here is `active`, not
  // `initialization_failed`, and the combination is what is wrong.
  assert.doesNotMatch(r.stderr, /requires status 'initialization_failed'/);
  assert.equal(h.readFeature().ticket, undefined);
});

// --- the typed op ---------------------------------------------------------------------------------

test('ticket-record writes the field, and is IDEMPOTENT BY OVERWRITE with the bump as the signal', () => {
  const h = fixture();
  const before = h.readFeature().revision;
  let r = h.legion('state', 'ticket-record', '#41');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /recorded ticket #41/);
  assert.equal(h.readFeature().ticket, '#41');
  assert.equal(h.readFeature().revision, before + 1);

  // A DIFFERENT ref overwrites — no history array, because a ticket points at a live conversation.
  r = h.legion('state', 'ticket-record', 'acme/api#7');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.readFeature().ticket, 'acme/api#7');
  assert.equal(h.readFeature().revision, before + 2);

  // The SAME ref still bumps: the operator must be able to tell the op ran.
  r = h.legion('state', 'ticket-record', 'acme/api#7');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.readFeature().ticket, 'acme/api#7');
  assert.equal(h.readFeature().revision, before + 3);
});

test('ticket-record writes feature.json ONLY — one manifest per op, tasks.json untouched', () => {
  const h = fixture();
  const tasksBefore = readIf(h.tasksPath);
  assert.equal(h.legion('state', 'ticket-record', '#41').code, 0);
  assert.equal(readIf(h.tasksPath), tasksBefore, 'tasks.json MOVED — ticket-record owns one manifest');
});

test('ticket-record needs no `state init` — it mirrors session-record, a feature.json-only op', () => {
  const h = fixture({ stateInit: false });
  assert.equal(readIf(h.tasksPath), null, 'precondition: tasks.json is absent');
  const r = h.legion('state', 'ticket-record', '#41');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(h.readFeature().ticket, '#41');
  assert.equal(readIf(h.tasksPath), null, 'and it did not create one');
  // The sibling it is modelled on behaves identically, which is the point of the comparison.
  assert.equal(h.legion('state', 'session-record', '--session-id', 's1').code, 0);
});

test('ticket-record refuses the SAME garbage as --ticket, in the same words, moving nothing', () => {
  const h = fixture();
  for (const bad of GARBAGE) {
    const snap = h.snapshot();
    const r = h.legion('state', 'ticket-record', bad);
    assert.equal(r.code, 1, `${JSON.stringify(bad)} must be refused: ${r.stdout}`);
    assert.match(r.stderr, /ticket-record <ref>: /);
    assert.match(r.stderr, /'123', '#123' or 'group\/project#123'/);
    h.assertUnmoved(snap, `a refused ticket-record ${JSON.stringify(bad)}`);
  }
  // A missing positional is the same refusal, not a crash and not a silent no-op.
  const snap = h.snapshot();
  const r = h.legion('state', 'ticket-record');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /ticket-record <ref>: expected a string, got nothing/);
  h.assertUnmoved(snap, 'a bare ticket-record');
  // POSITIVE CONTROL: the door still opens.
  assert.equal(h.legion('state', 'ticket-record', '#1').code, 0);
});

test('ticket-record is advertised by the op list, and there is still no receipt writer on it', () => {
  const h = fixture();
  const r = h.legion('state');
  assert.equal(r.code, 1, 'a bare `legion state` is a usage error');
  assert.match(r.stderr, /ticket-record/);
  assert.doesNotMatch(r.stderr, /receipt-record/);
});

test('ticket-record outside a registered feature worktree refuses, like every other op', () => {
  const h = fixture();
  const r = h.legionIn(h.repoRoot, 'state', 'ticket-record', '#41');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /not a registered legion feature worktree/);
});

// --- project init: the closing-style flag -----------------------------------------------------------

test('project init records --ticket-closing-style, preserves it on an unflagged re-init', () => {
  const h = fixture();
  const cfg = () => JSON.parse(readFileSync(h.configPath, 'utf8'));
  assert.equal(cfg().ticketClosingStyle, null, 'scaffolded as UNSET, so it cannot shadow an org');

  let r = h.legionIn(h.repoRoot, 'project', 'init', '--root', h.repoRoot, '--ticket-closing-style', 'refs');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cfg().ticketClosingStyle, 'refs');

  r = h.legionIn(h.repoRoot, 'project', 'init', '--root', h.repoRoot);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /up to date/);
  assert.equal(cfg().ticketClosingStyle, 'refs', 'an unflagged re-init must not reset it');

  // Both ticket fields reconcile independently, like every other operator-owned field.
  r = h.legionIn(h.repoRoot, 'project', 'init', '--root', h.repoRoot, '--ticket-project', 'acme/issues');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(cfg().ticketProject, 'acme/issues');
  assert.equal(cfg().ticketClosingStyle, 'refs');
});

test('an invalid closing style refuses at init, judged by the RESOLVER\'s own validator', () => {
  const h = fixture();
  const before = readFileSync(h.configPath, 'utf8');
  for (const bad of ['Closes', 'close', 'closes #{n}', '']) {
    const r = h.legionIn(h.repoRoot, 'project', 'init', '--root', h.repoRoot, '--ticket-closing-style', bad);
    assert.equal(r.code, 1, `${JSON.stringify(bad)} must be refused: ${r.stdout}`);
    assert.match(r.stderr, /--ticket-closing-style: invalid ticket closing style/);
    assert.match(r.stderr, /closes\|fixes\|resolves\|refs/);
  }
  assert.equal(readFileSync(h.configPath, 'utf8'), before, 'a refused init wrote nothing');
});

test('a hand-edited project.json with a bad ticket field is judged on re-init, naming the file', () => {
  const h = fixture();
  const doc = JSON.parse(readFileSync(h.configPath, 'utf8'));
  writeJson(h.configPath, { ...doc, ticketClosingStyle: 'nope' });
  const r = h.legionIn(h.repoRoot, 'project', 'init', '--root', h.repoRoot);
  assert.equal(r.code, 1, r.stdout);
  assert.match(r.stderr, /invalid ticket closing style "nope"/);
  assert.ok(r.stderr.includes(h.configPath), 'the refusal names the file the value came from');
});

// --- doctor: ONE info line, never a verdict ---------------------------------------------------------

const orgJsonPath = (h) => join(h.home, 'orgs', 'default', 'org.json');

test('doctor states the resolved ticket config AND the level each field came from', () => {
  const h = fixture();
  // Default alone.
  let r = h.legionIn(h.repoRoot, 'doctor');
  assert.equal(r.code, 0, `doctor must not fail in the sandbox: ${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /info {2}ticket config {2}issues in the code repository's own forge project \[plugin default\]/);
  assert.match(r.stdout, /closing line `Closes #<iid>` \[plugin default\]/);

  // Org level.
  writeJson(orgJsonPath(h), { ticketProject: 'acme/issues', ticketClosingStyle: 'fixes' });
  r = h.legionIn(h.repoRoot, 'doctor');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /issues in acme\/issues \[org\]/);
  assert.match(r.stdout, /closing line `Fixes #<iid>` \[org\]/);

  // Project level wins per field; the org's other field still composes.
  const cfg = JSON.parse(readFileSync(h.configPath, 'utf8'));
  writeJson(h.configPath, { ...cfg, ticketClosingStyle: 'refs' });
  r = h.legionIn(h.repoRoot, 'doctor');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /issues in acme\/issues \[org\]/);
  assert.match(r.stdout, /closing line `Refs #<iid>` \[project\]/);
});

test('the ticket line is INFORMATION: never a check, never in --json, never the exit code', () => {
  const h = fixture();
  const human = h.legionIn(h.repoRoot, 'doctor');
  assert.equal(human.code, 0);
  assert.ok(!/^(PASS|WARN|FAIL) +ticket/m.test(human.stdout), 'it must not masquerade as a check row');
  assert.doesNotMatch(human.stdout, /ticket config.*(FAIL|WARN)/);

  const json = h.legionIn(h.repoRoot, 'doctor', '--json');
  assert.equal(json.code, 0);
  const checks = JSON.parse(json.stdout); // pure JSON, still — the array IS the contract
  assert.ok(Array.isArray(checks));
  assert.ok(!checks.some((c) => /ticket/.test(c.check)), 'CHECK_IDS is unchanged');
});

test('a CORRUPT org.json is printed loudly by doctor and STILL never fails it', () => {
  const h = fixture();
  const clean = h.legionIn(h.repoRoot, 'doctor');
  assert.equal(clean.code, 0);

  writeFileSync(orgJsonPath(h), '{ this is not json\n');
  const r = h.legionIn(h.repoRoot, 'doctor');
  assert.equal(r.code, 0, 'ticket config gates nothing — a broken one must not turn doctor red');
  assert.match(r.stdout, /info {2}ticket config {2}UNRESOLVED for default\//);
  assert.ok(r.stdout.includes(orgJsonPath(h)), 'and it names the file');
  assert.ok(!r.stdout.includes('FAIL —'), 'no verdict line: nothing failed');

  // Removing it restores the silent, ordinary case.
  rmSync(orgJsonPath(h));
  assert.match(h.legionIn(h.repoRoot, 'doctor').stdout, /\[plugin default\]/);
});

test('doctor run from OUTSIDE any registered project says which levels it did not read', () => {
  const h = fixture();
  const elsewhere = join(h.sandbox, 'not-a-project');
  mkdirSync(elsewhere, { recursive: true });
  const r = h.legionIn(elsewhere, 'doctor');
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /no registered project resolves from this cwd/);
  assert.match(r.stdout, /neither the org nor the project level was read/);
});
