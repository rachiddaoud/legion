// Unit guard for the pure evidence helpers of the state machine (src/kernel/state.mjs):
// sha256 derivation, BOTH FROZEN hash formulas (the combined plan hash and the gate
// commandPolicyHash) and their determinism, receipt PROVENANCE, canonical review ordering, the
// deterministic cascade (order + dependents), and the schemaVersion guard via dispatch.
// recordGateReceipt is exercised directly here — it is exported for `legion gate` alone and is no
// longer reachable through any typed op, so its dirty-worktree and gated-tree guards (which
// `legion state receipt-record` used to expose through the CLI) get their coverage here rather
// than being dropped with the op. Full lifecycle + refusal coverage lives in test/cli/state.test.mjs
// (end-to-end through the real bin); these are the fast, git-free invariants.
// task-answer's full behavioural matrix lives HERE (not in the CLI test) because the op is
// manifest-only: it touches tasks.json alone — no feature.json, no git — so it needs no
// worktree fixture. The CLI test carries only its flag-parsing/wiring case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenedGitEnv } from '../../src/kernel/git.mjs';
import {
  sha256, combinedPlanHash, canonicalReviews, cascadeInvalidate,
  APPROVAL_CHAIN, STATE_OPS, dispatch,
  commandPolicyHash, commandPolicyPin, commandPolicyTriples, receiptProvenance, recordGateReceipt,
} from '../../src/kernel/state.mjs';

const h = (s) => createHash('sha256').update(s).digest('hex');

test('sha256 matches node:crypto for strings and buffers', () => {
  assert.equal(sha256('hello'), h('hello'));
  assert.equal(sha256(Buffer.from('hello')), h('hello'));
});

// THE PLAN SUBJECT FORMULA CHANGED ONCE, in T13 (kernel/state.mjs header APPROVALS): it hashes
// plan.md's bytes plus the CONTENT PROJECTION of each row (planContent: id, title, depends_on,
// milestone, validate, notes) — never the live rows, or `task-start` invalidates the plan
// approval and, under prefix re-derivation, strands the feature forever (PLAN-V3 §State
// corollary 2; acceptance case 10c). The expected value below reproduces the projection
// INDEPENDENTLY so the recorder and the verifier cannot both drift.
const planContentOf = (x) => JSON.stringify({
  id: x.id,
  title: x.title,
  depends_on: x.depends_on ?? [],
  milestone: x.milestone ?? null,
  validate: x.validate ?? null,
  notes: x.notes ?? null,
});

test('combinedPlanHash binds plan bytes AND the projected task list, deterministically and order-sensitively', () => {
  const plan = Buffer.from('# plan\n');
  const tasks = [{ id: 'T1' }, { id: 'T2' }];
  const expected = h(`${h(plan)}:${h(JSON.stringify(tasks.map(planContentOf)))}`);
  assert.equal(combinedPlanHash(plan, tasks), expected);
  // deterministic on repeat
  assert.equal(combinedPlanHash(plan, tasks), combinedPlanHash(plan, tasks));
  // a changed plan.md changes the hash
  assert.notEqual(combinedPlanHash(Buffer.from('# plan v2\n'), tasks), expected);
  // a changed task list changes the hash — order included (execution order is enforced
  // elsewhere; the SUBJECT is the list as approved, in the order approved)
  assert.notEqual(combinedPlanHash(plan, [{ id: 'T2' }, { id: 'T1' }]), expected);
});

test('combinedPlanHash covers plan CONTENT only — kernel-owned progress cannot move the subject', () => {
  const plan = Buffer.from('# plan\n');
  const approved = [{ id: 'T1', title: 'do T1', depends_on: [], milestone: 'M1' }];
  const inFlight = [{
    id: 'T1', title: 'do T1', depends_on: [], milestone: 'M1',
    status: 'done', attempt: 2, startedAt: 't1', doneAt: 't2',
    receipt: { tier: 'task', treeHash: 't'.repeat(40) },
    answers: [{ question: 'q', answer: 'a', at: 't' }],
  }];
  assert.equal(combinedPlanHash(plan, inFlight), combinedPlanHash(plan, approved),
    'progress on a row must leave the plan subject unchanged — a human approved content, not progress');
  // …while every CONTENT field still moves it.
  for (const edit of [
    { title: 'a different task' },
    { depends_on: ['T0'] },
    { milestone: 'M2' },
    { validate: { cwd: '.', argv: ['npm', 'test'], timeoutMs: 1000 } },
    { notes: 'mirror: something else' },
  ]) {
    assert.notEqual(
      combinedPlanHash(plan, [{ ...approved[0], ...edit }]),
      combinedPlanHash(plan, approved),
      `plan content ${JSON.stringify(edit)} must move the subject`,
    );
  }
});

test('canonicalReviews is a stable sort independent of input order', () => {
  const a = { role: 'r1', verdict: 'pass', subject: 'feature', at: 't1' };
  const b = { role: 'r2', verdict: 'fail', subject: 'task:T1', at: 't2' };
  assert.deepEqual(canonicalReviews([a, b]), canonicalReviews([b, a]));
  // the sort key is the stringified review, so the result is fully determined
  assert.equal(
    JSON.stringify(canonicalReviews([b, a])),
    JSON.stringify([a, b].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1))),
  );
});

// THE FORMULA TEST (T14): canonicalReviews covers the WHOLE record — `subjectHash` deliberately
// INSIDE the canonical form. The pre-merge subject hashes this output, so excluding the new field
// would let a review re-bound to different evidence leave the pre-merge approval standing — a
// review set that changed without changing the subject, which is R3 in a smaller costume. This
// froze once in T14 (pre-T14 pre-merge approvals invalidate, stated in the kernel header); the
// golden serialization below is what makes any future byte-drift a loud red instead of a silent
// invalidation of every recorded approval.
test('canonicalReviews formula: subjectHash is INSIDE the canonical form, and the bytes are frozen', () => {
  const rec = (subjectHash) => ({ role: 'code-reviewer', verdict: 'pass', subject: 'feature', subjectHash, at: 't1' });
  const a = rec('a'.repeat(64));
  const b = rec('b'.repeat(64));
  // Two records differing ONLY in subjectHash are DIFFERENT canonical reviews…
  assert.notEqual(JSON.stringify(canonicalReviews([a])), JSON.stringify(canonicalReviews([b])));
  // …and the hash participates in the ORDERING, not just the identity.
  assert.deepEqual(canonicalReviews([b, a]), [a, b]);
  // GOLDEN BYTES, spelled out rather than recomputed: recorder and verifier must serialize a
  // bound review identically or every pre-merge approval silently invalidates.
  assert.equal(
    JSON.stringify(canonicalReviews([a])),
    `[{"role":"code-reviewer","verdict":"pass","subject":"feature","subjectHash":"${'a'.repeat(64)}","at":"t1"}]`,
  );
});

test('cascadeInvalidate drops the kind and its DAG descendants, keeps ancestors and siblings', () => {
  const all = Object.fromEntries(APPROVAL_CHAIN.map((k) => [k, { kind: k }]));
  // spec edit kills spec+plan+preview+pre-merge; intake survives
  assert.deepEqual(Object.keys(cascadeInvalidate(all, 'spec')), ['intake']);
  // plan edit kills plan+preview+pre-merge (both hang off plan); intake+spec survive
  assert.deepEqual(Object.keys(cascadeInvalidate(all, 'plan')), ['intake', 'spec']);
  // preview kills ONLY preview — pre-merge is a SIBLING off plan, not a dependent (codex P2)
  assert.deepEqual(Object.keys(cascadeInvalidate(all, 'preview')), ['intake', 'spec', 'plan', 'pre-merge']);
  // intake kills everything
  assert.deepEqual(Object.keys(cascadeInvalidate(all, 'intake')), []);
  // pre-merge kills only itself
  assert.deepEqual(Object.keys(cascadeInvalidate(all, 'pre-merge')), ['intake', 'spec', 'plan', 'preview']);
});

test('cascadeInvalidate rejects a non-approval kind loudly', () => {
  assert.throws(() => cascadeInvalidate({}, 'nonsense'), /not an approval kind/);
});

test('dispatch on an unknown op dies loudly and lists the ops', () => {
  assert.throws(() => dispatch('frobnicate', '/nope', { flags: {}, positional: ['frobnicate'] }, 't'), /unknown state op/);
});

// --- the gate command policy hash: the SECOND frozen formula (T12) ---------------------------
// The pipeline-level canonicality test (validateGatesConfig → commandPolicyHash, which is what
// the recorder and every verifier actually run) lives in test/cli/gate.test.mjs, next to
// validateGatesConfig. These are the pure properties of the hash itself.

const NORM = (commands, task = [], boundary = []) => ({ commands, task, boundary });
const CMD = (argv, timeoutMs = 1000) => ({ argv, timeoutMs });

test('commandPolicyHash is 64 hex, deterministic, and TIER-SEPARATING', () => {
  const n = NORM({ test: CMD(['npm', 'test']) }, ['test'], ['test']);
  assert.match(commandPolicyHash(n, 'task'), /^[0-9a-f]{64}$/);
  assert.equal(commandPolicyHash(n, 'task'), commandPolicyHash(n, 'task'));
  // The tier NAME is inside the payload, so the same command list under `task` and `boundary` are
  // different policies — a receipt earned at one tier can never satisfy the other's pin.
  assert.notEqual(commandPolicyHash(n, 'task'), commandPolicyHash(n, 'boundary'));
  assert.throws(() => commandPolicyHash(n, 'nonsense'), /not a gate tier/);
});

test('commandPolicyTriples refuses a tier naming an undeclared command instead of hashing undefined', () => {
  // Only reachable by skipping validateGatesConfig, which is exactly why it dies loudly: hashing
  // `undefined` into a policy would produce a stable hash for a config that cannot run.
  assert.throws(() => commandPolicyTriples(NORM({}, ['ghost']), 'task'), /undeclared command 'ghost'/);
});

test('commandPolicyPin covers BOTH tiers, and its hashes are the hashes of its lists', () => {
  const n = NORM({ a: CMD(['a']), b: CMD(['b']) }, ['a'], ['a', 'b']);
  const pin = commandPolicyPin(n);
  assert.deepEqual(Object.keys(pin).sort(), ['commandPolicy', 'commandPolicyHash']);
  assert.deepEqual(Object.keys(pin.commandPolicyHash).sort(), ['boundary', 'task']);
  assert.deepEqual(pin.commandPolicy.task, [['a', ['a'], 1000]]);
  assert.deepEqual(pin.commandPolicy.boundary, [['a', ['a'], 1000], ['b', ['b'], 1000]]);
  for (const tier of ['task', 'boundary']) {
    assert.equal(pin.commandPolicyHash[tier], commandPolicyHash(n, tier),
      'the recorded hash must be the hash of the recorded list — one definition, written together');
  }
});

// --- receiptProvenance: the ONE definition of "a gate ran" ------------------------------------

// THE PIN IS REAL, NOT A LITERAL, and that is now REQUIRED rather than tidy (T12b): provenance
// reads the pinned command LIST as well as the pinned hash, and refuses a pin whose list does not
// hash to its hash — a literal `'p'.repeat(64)` can never be self-consistent, so every case below
// would refuse for the wrong reason. One `NORM` triple is therefore the source of both halves.
const NORM_T = NORM({ test: CMD(['npm', 'test']) }, ['test'], []);
const PIN = {
  tier: 'task',
  pinnedHash: commandPolicyHash(NORM_T, 'task'),
  pinnedTriples: commandPolicyTriples(NORM_T, 'task'),
};
/** The TIER-0-ONLY pin: `project init` scaffolds `gates: {}` and a fresh project must still gate
 * (PLAN-V3 §Gates / R11). An EMPTY pinned list is a PRESENT pin, never an absent one. */
const NORM_0 = NORM({}, [], []);
const PIN_0 = { tier: 'task', pinnedHash: commandPolicyHash(NORM_0, 'task'), pinnedTriples: [] };

const FULL = {
  tier: 'task',
  commandPolicyHash: PIN.pinnedHash,
  results: [{ name: 'test', argv: ['npm', 'test'], exitCode: 0, ms: 5 }],
  declaredCommands: 1,
  head: 'h'.repeat(40),
  treeHash: 't'.repeat(40),
  at: '2026-07-25T00:00:00.000Z',
};
const without = (k) => { const { [k]: _drop, ...rest } = FULL; return rest; };

test('receiptProvenance accepts a full receipt whose policy equals the pin', () => {
  assert.deepEqual(receiptProvenance(FULL, PIN), { ok: true });
});

test('receiptProvenance rejects a missing receipt and every missing required field', () => {
  for (const bad of [null, undefined, 'a receipt', [], 42]) {
    assert.equal(receiptProvenance(bad, PIN).ok, false, `${JSON.stringify(bad)} is not a receipt`);
  }
  // The rev-4 shape is the one a caller could actually forge (acceptance case 2): a real tree, a
  // real commit, and nothing that proves a gate ever ran.
  const rev4 = { treeHash: FULL.treeHash, commit: FULL.head, at: FULL.at };
  const r4 = receiptProvenance(rev4, PIN);
  assert.equal(r4.ok, false);
  assert.match(r4.why, /no gate provenance/);
  for (const k of ['tier', 'commandPolicyHash', 'results', 'declaredCommands', 'head', 'treeHash']) {
    const r = receiptProvenance(without(k), PIN);
    assert.equal(r.ok, false, `a receipt missing ${k} proves nothing`);
    assert.ok(r.why.length > 0, `and must say why (${k})`);
  }
  // `at` is NOT required-for-provenance: it is a timestamp, not evidence.
  assert.deepEqual(receiptProvenance(without('at'), PIN), { ok: true });
  // Well-formedness of the fields that ARE required.
  assert.equal(receiptProvenance({ ...FULL, tier: 'boundary' }, PIN).ok, false);
  assert.equal(receiptProvenance({ ...FULL, declaredCommands: -1 }, PIN).ok, false);
  assert.equal(receiptProvenance({ ...FULL, declaredCommands: 1.5 }, PIN).ok, false);
  assert.equal(receiptProvenance({ ...FULL, commandPolicyHash: '' }, PIN).ok, false);
  assert.equal(receiptProvenance({ ...FULL, results: 'ran' }, PIN).ok, false);
  assert.equal(receiptProvenance({ ...FULL, head: 7 }, PIN).ok, false);
  // declaredCommands 0 is a REAL but weak certificate, never an invalid one (PLAN-V3 §Gates/R11):
  // `project init` scaffolds `gates: {}`, and a fresh project must still be able to gate.
  // RE-POINTED AT A TIER-0 PIN (T12b): declaredCommands must now EQUAL the pinned count, so "0
  // declared is a real but weak certificate" is true against the pin that declares nothing and
  // FALSE against a one-command pin. The R11 property is preserved and stated more precisely.
  assert.deepEqual(
    receiptProvenance({ ...FULL, commandPolicyHash: PIN_0.pinnedHash, declaredCommands: 0, results: [] }, PIN_0),
    { ok: true },
  );
});

test('receiptProvenance refuses a MISMATCHED pin, and an ABSENT pin — never fail-open', () => {
  const superseded = receiptProvenance(FULL, { tier: 'task', pinnedHash: 'q'.repeat(64) });
  assert.equal(superseded.ok, false);
  assert.match(superseded.why, /SUPERSEDED/);
  for (const pinnedHash of [undefined, null, '', 7]) {
    const r = receiptProvenance(FULL, { tier: 'task', pinnedHash });
    assert.equal(r.ok, false, `an absent pin (${JSON.stringify(pinnedHash)}) must REFUSE, not default to fine`);
    assert.match(r.why, /--repin/, 'and must name the way to establish one');
  }
});

test('the OPTIONAL audit fields are accepted when present and when absent, and type-checked', () => {
  // A receipt is not invalid for carrying the audit fields, nor for lacking them — their mere
  // PRESENCE is the signal downstream renders.
  assert.deepEqual(receiptProvenance({ ...FULL, allowConfig: true }, PIN), { ok: true });
  assert.deepEqual(receiptProvenance({ ...FULL, repinnedFrom: 'z'.repeat(64) }, PIN), { ok: true });
  assert.deepEqual(receiptProvenance({ ...FULL, allowConfig: false, repinnedFrom: 'z' }, PIN), { ok: true });
  assert.equal(receiptProvenance({ ...FULL, allowConfig: 'yes' }, PIN).ok, false);
  assert.equal(receiptProvenance({ ...FULL, repinnedFrom: 42 }, PIN).ok, false);
});

test('receiptProvenance rejects an unknown tier loudly rather than answering about one', () => {
  assert.throws(() => receiptProvenance(FULL, { tier: 'nonsense', pinnedHash: 'x' }), /not a gate tier/);
});

// --- T12b: a receipt that PASSES provenance must prove a gate ran -----------------------------
// The reproduced bypass: `results: []` with `declaredCommands: 1` and a commandPolicyHash COPIED
// out of feature.json used to pass, because the only checks were `Array.isArray(results)` and
// hash-equality. Nothing compared the recorded results against the policy the receipt named.

test('the FROZEN commandPolicyHash payload has not moved by one byte (golden freeze)', () => {
  // Pinned literals, computed against the pre-T12b kernel. Every receipt and every pin in
  // existence is keyed on these bytes, so a change here is a SCHEMA change, not a refactor — and
  // this test is what makes the T12b extraction of the payload helper provably byte-identical.
  const n = NORM({ test: CMD(['npm', 'test'], 1000) }, ['test'], []);
  assert.equal(commandPolicyHash(n, 'task'), '6641112481f6aa20021b5c5029d3b8a0d236f3f796f7fdc49f7ca11944fde84f');
  assert.equal(commandPolicyHash(n, 'boundary'), 'da2c9c54719ec7e6ded0d1820ae2d65c613a2c11e2925e816cc49b7c40788a8b');
});

test('an ABSENT pinned command list is a REFUSAL, exactly as an absent pin is — never fail-open', () => {
  // The pin names a policy HASH but not the commands it covers, so what the receipt claims to have
  // run cannot be checked. Nothing declaring the coverage is the CONDITION, not a reason to skip.
  for (const pinnedTriples of [undefined, null, 'nope', {}, 7]) {
    const r = receiptProvenance(FULL, { ...PIN, pinnedTriples });
    assert.equal(r.ok, false, `an absent pinned list (${JSON.stringify(pinnedTriples)}) must REFUSE`);
    // The remedy must be NAMED, and `repinCommandPolicy` repairs the list half so that naming it is
    // true. It was not: `moved` was hash-only, so `--repin` wrote nothing in exactly this state and
    // the refusal looped forever. The rationale this assertion used to carry — "an older dossier
    // must not be stranded" — was itself false and is gone: both halves of the pin entered together
    // in ff50d64, so no committed kernel ever wrote a hash without a list.
    assert.match(r.why, /--repin/, 'and must name a way out that actually clears this state');
    assert.match(r.why, /pin|policy/i, 'and must keep the pin/policy refusal vocabulary');
  }
});

test('a MALFORMED pinned command list refuses, naming the offending index', () => {
  for (const bad of [[['test']], [[1, ['a'], 1]], [['test', 'npm test', 1]], [null], [['', ['a'], 1]], [['test', ['a', 7], 1]]]) {
    const r = receiptProvenance(FULL, { ...PIN, pinnedTriples: bad });
    assert.equal(r.ok, false, `a malformed pinned list ${JSON.stringify(bad)} must REFUSE`);
    // MATCH THE MALFORMED REFUSAL ITSELF, not merely a '0' somewhere in the string. `/0/` was
    // VACUOUS: delete the malformed check and every input here falls through to the pin
    // self-consistency refusal, whose text embeds the 64-hex pinned hash — which contains a '0'.
    // Found by mutation (`if (malformed)` → `if (false)` left the whole suite green).
    assert.match(r.why, /malformed at command 0/, 'and must name the offending index, not merely refuse');
  }
});

test('a pinned command list that does not HASH to the pinned hash refuses — the pin was hand-edited', () => {
  // Without this, emptying commandPolicy[tier] while KEEPING the copied hash makes every
  // results-vs-policy check pass vacuously (declaredCommands 0, results []). What this check buys
  // is precisely that the pin cannot be edited by HALVES — NOT a higher forgery cost overall: move
  // BOTH halves to the empty policy and the pin is self-consistent by construction and still
  // verifies. See the case below, which pins that residual so it cannot be quietly re-claimed.
  const other = NORM({ lint: CMD(['npm', 'run', 'lint']) }, ['lint'], []);
  const r = receiptProvenance(FULL, { tier: 'task', pinnedHash: PIN.pinnedHash, pinnedTriples: commandPolicyTriples(other, 'task') });
  assert.equal(r.ok, false, 'a pin whose list and hash disagree describes no real policy');
  assert.match(r.why, /--repin/);
  assert.match(r.why, /pin|policy/i);
  // The emptied-list variant, which is the forgery this refusal exists to kill.
  const emptied = receiptProvenance(
    { ...FULL, declaredCommands: 0, results: [] },
    { tier: 'task', pinnedHash: PIN.pinnedHash, pinnedTriples: [] },
  );
  assert.equal(emptied.ok, false, 'emptying the pinned list must not make a forged receipt verifiable');
});

test('THE EMPTY-PIN VARIANT OF THE RESIDUAL, ASSERTED: two halves moved TOGETHER are adopted', () => {
  // THIS TEST ASSERTS A HOLE, DELIBERATELY. It is not novel in doing so — see
  // test/kernel/git-tree-dirty.test.mjs, "a .gitignore-d file reads CLEAN — the documented
  // residual, neither widened nor narrowed", which pins decision 12's ignored-file hole in the same
  // spirit. That precedent is the argument for this device; a residual living only in a comment is
  // one refactor from being quietly re-claimed as closed.
  //
  // IT ADDS FRAMING, NOT COVERAGE, and says so rather than reading as new enforcement: the call
  // below is the same assertion as the R11 tier-0-only case above (`PIN_0`, deepEqual `{ok:true}`),
  // re-declared under the name the residual gives it. No mutation can kill one without the other.
  //
  // Both halves of the pin live in feature.json, which the same Bash that writes tasks.json can
  // write. Move them together and the pin self-consistency check is satisfied by construction. The
  // cheapest form needs NO knowledge of the real policy: the empty policy's hash is a
  // project-independent CONSTANT (`project init` scaffolds `gates: {}`, so real features already pin
  // it — and its boundary value is the golden literal asserted in the freeze test above).
  const empty = { tier: 'task', pinnedHash: commandPolicyHash(NORM_0, 'task'), pinnedTriples: [] };
  assert.notEqual(empty.pinnedHash, PIN.pinnedHash, 'the real feature is pinned to a REAL policy');
  const forged = { ...FULL, commandPolicyHash: empty.pinnedHash, declaredCommands: 0, results: [] };
  // `r.ok`, not deepEqual on the whole return: an ADDITIVE change to the success shape (`{ok:true,
  // note}`) is not the residual closing, and this assertion must not go red for it.
  assert.equal(
    receiptProvenance(forged, empty).ok,
    true,
    'KNOWN-OPEN: rewriting BOTH halves of the pin to the empty policy verifies a receipt that ran '
    + 'nothing. Closing it needs a binding OUTSIDE the dossier (gate.mjs, "WHAT GENUINE CLOSURE '
    + 'WOULD REQUIRE"). IF THIS STARTS FAILING, only the EMPTY-PIN variant has closed — that is a '
    + 'live possibility on its own, since R11\'s deferred "force gates" half would make an empty pin '
    + 'refuse. The THREE-FIELD COPY of a real policy into results[] is a SEPARATE hole, asserted '
    + 'nowhere and almost certainly still open. Read gate.mjs\'s residual bullets before widening '
    + 'any claim in gate.mjs, state.mjs, finalize.mjs or case 1 — widening them for this alone would '
    + 'restore a false claim of prevention, which is the failure T12b exists to remove.',
  );
});

test('declaredCommands must EQUAL the pinned command count, not merely be a non-negative integer', () => {
  for (const declaredCommands of [0, 2, 5]) {
    const r = receiptProvenance({ ...FULL, declaredCommands }, PIN);
    assert.equal(r.ok, false, `${declaredCommands} declared against a 1-command pin must refuse`);
    assert.match(r.why, new RegExp(String(declaredCommands)), 'the refusal must name what the receipt claims');
    assert.match(r.why, /1/, 'and what the pin declares');
  }
  // THE REPRODUCED BYPASS, asserted at the unit level: an HONEST count with NO results.
  const bypass = receiptProvenance({ ...FULL, declaredCommands: 1, results: [] }, PIN);
  assert.equal(bypass.ok, false, '`declaredCommands: 1, results: []` is the R1 bypass and must refuse');
});

test('every results[] element must be well-shaped, and a recorded NON-ZERO exit is incoherent', () => {
  const el = (over) => ({ ...FULL, results: [{ name: 'test', argv: ['npm', 'test'], exitCode: 0, ms: 5, ...over }] });
  const badElements = [
    ['a null element', { ...FULL, results: [null] }],
    ['an array element', { ...FULL, results: [['test']] }],
    ['a string element', { ...FULL, results: ['test'] }],
    ['a missing name', { ...FULL, results: [{ argv: ['npm', 'test'], exitCode: 0, ms: 5 }] }],
    ['an empty name', el({ name: '' })],
    ['a non-array argv', el({ argv: 'npm test' })],
    ['an empty argv', el({ argv: [] })],
    ['a non-string argv element', el({ argv: ['ok', 7] })],
    ['an absent exitCode', { ...FULL, results: [{ name: 'test', argv: ['npm', 'test'], ms: 5 }] }],
    ['a null exitCode', el({ exitCode: null })],
    ['a negative ms', el({ ms: -1 })],
    ['a string ms', el({ ms: 'fast' })],
    ['a NaN ms', el({ ms: NaN })],
    ['an absent ms', { ...FULL, results: [{ name: 'test', argv: ['npm', 'test'], exitCode: 0 }] }],
  ];
  for (const [what, receipt] of badElements) {
    const r = receiptProvenance(receipt, PIN);
    assert.equal(r.ok, false, `${what} must refuse`);
    assert.ok(r.why.length > 0, `and must say why (${what})`);
  }
  // A receipt is minted ONLY on a GREEN run, so a recorded non-zero exit is not weak evidence —
  // it is incoherent evidence, and the refusal must say so out loud.
  const red = receiptProvenance(el({ exitCode: 1 }), PIN);
  assert.equal(red.ok, false);
  assert.match(red.why, /GREEN/, 'the refusal must state that a receipt is minted only on a GREEN run');
});

test('REQUIRED-FIELDS not exact-keys holds at BOTH levels — a future field stays additive', () => {
  assert.deepEqual(receiptProvenance({ ...FULL, someFutureField: 1 }, PIN), { ok: true });
  assert.deepEqual(
    receiptProvenance({ ...FULL, results: [{ name: 'test', argv: ['npm', 'test'], exitCode: 0, ms: 5, stdoutBytes: 12 }] }, PIN),
    { ok: true },
    'a future per-command field must not invalidate a receipt already earned',
  );
});

test('results[] must MATCH THE PINNED POLICY — names, ORDER and argv, positionally', () => {
  const two = NORM({ first: CMD(['a']), second: CMD(['b']) }, ['first', 'second'], []);
  const pin2 = { tier: 'task', pinnedHash: commandPolicyHash(two, 'task'), pinnedTriples: commandPolicyTriples(two, 'task') };
  const receipt = (results) => ({ ...FULL, commandPolicyHash: pin2.pinnedHash, declaredCommands: 2, results });
  const first = { name: 'first', argv: ['a'], exitCode: 0, ms: 1 };
  const second = { name: 'second', argv: ['b'], exitCode: 0, ms: 2 };

  assert.deepEqual(receiptProvenance(receipt([first, second]), pin2), { ok: true });

  // SWAPPED: the tier list's order IS policy, because it is the EXECUTION order.
  const swapped = receiptProvenance(receipt([second, first]), pin2);
  assert.equal(swapped.ok, false, 'a swapped order is a different policy, not the same one');
  assert.match(swapped.why, /order/i);
  assert.match(swapped.why, /execution/i, 'and must say WHY the order is policy');

  // right count, wrong name
  assert.equal(receiptProvenance(receipt([first, { ...second, name: 'third' }]), pin2).ok, false);
  // right name, wrong argv — and the refusal must name BOTH argvs
  const wrongArgv = receiptProvenance(receipt([first, { ...second, argv: ['b', '--fast'] }]), pin2);
  assert.equal(wrongArgv.ok, false);
  assert.match(wrongArgv.why, /"b","--fast"/, 'the refusal must print what ran');
  assert.match(wrongArgv.why, /\["b"\]/, 'and what the pin declares');
  // one result for two declared commands
  assert.equal(receiptProvenance(receipt([first]), pin2).ok, false);

  // DUPLICATE declared names are legal (validateGatesConfig does not de-duplicate), so the match
  // is POSITIONAL and a duplicate must be reproduced twice.
  const dup = NORM({ first: CMD(['a']) }, ['first', 'first'], []);
  const pinDup = { tier: 'task', pinnedHash: commandPolicyHash(dup, 'task'), pinnedTriples: commandPolicyTriples(dup, 'task') };
  const dupReceipt = (results) => ({ ...FULL, commandPolicyHash: pinDup.pinnedHash, declaredCommands: 2, results });
  assert.deepEqual(receiptProvenance(dupReceipt([first, { ...first, ms: 2 }]), pinDup), { ok: true });
  assert.equal(receiptProvenance(dupReceipt([first]), pinDup).ok, false);
});

test('the trailing `validate` is allowed on the TASK tier only, once, and its argv is NEVER compared', () => {
  // The validate is PLAN-owned — bound by the plan approval and (for {script,sha256}) by its own
  // script digest, deliberately outside commandPolicyHash — so comparing its argv would couple the
  // gate policy to every plan edit. Its argv here is deliberately unrelated to the pin.
  const validate = { name: 'validate', argv: ['/abs/dossier/script.sh'], exitCode: 0, ms: 1 };
  const declared = { name: 'test', argv: ['npm', 'test'], exitCode: 0, ms: 5 };
  assert.deepEqual(receiptProvenance({ ...FULL, results: [declared, validate] }, PIN), { ok: true });

  // A trailing entry named ANYTHING else is a command the policy never declared.
  const notValidate = receiptProvenance({ ...FULL, results: [declared, { ...validate, name: 'sneaky' }] }, PIN);
  assert.equal(notValidate.ok, false);
  assert.match(notValidate.why, /validate/, 'the refusal must name what may legitimately follow');
  // TWO trailing entries: the gate pushes at most one.
  assert.equal(receiptProvenance({ ...FULL, results: [declared, validate, validate] }, PIN).ok, false);

  // THE TRAILING POSITION IS WHERE THE ELEMENT SHAPE CHECKS ARE THE SOLE GUARD, so it is the only
  // place they can be isolated. At a DECLARED position the positional comparison rejects a bad name
  // or argv anyway, which is why the badElements table above cannot kill either mutant (mutation
  // testing: disabling the results[].name check, or the results[].argv check, left the whole suite
  // green). The validate's argv is never COMPARED — it still has to exist and be argv-shaped,
  // because "plan-owned" is not "unchecked".
  for (const [what, over] of [
    ['a missing argv', { argv: undefined }],
    ['an empty argv', { argv: [] }],
    ['a non-string argv element', { argv: ['/abs/script.sh', 7] }],
  ]) {
    const r = receiptProvenance({ ...FULL, results: [declared, { ...validate, ...over }] }, PIN);
    assert.equal(r.ok, false, `a trailing validate with ${what} must REFUSE`);
    assert.match(r.why, /argv/, `and must say so (${what})`);
  }
  // An EMPTY trailing name must refuse AS a shape violation, not as "that is not a validate" — the
  // two refusals differ, and asserting the shape one is what isolates the name check.
  const noName = receiptProvenance({ ...FULL, results: [declared, { ...validate, name: '' }] }, PIN);
  assert.equal(noName.ok, false);
  assert.match(noName.why, /name is missing or not a non-empty string/, 'a nameless element is malformed, not merely un-validate-like');

  // The BOUNDARY tier never appends a task's validate — gateRun builds the boundary queue from the
  // declared names alone.
  const bPin = { tier: 'boundary', pinnedHash: commandPolicyHash(NORM({ test: CMD(['npm', 'test']) }, [], ['test']), 'boundary'), pinnedTriples: [['test', ['npm', 'test'], 1000]] };
  const b = receiptProvenance({ ...FULL, tier: 'boundary', commandPolicyHash: bPin.pinnedHash, results: [declared, validate] }, bPin);
  assert.equal(b.ok, false);
  assert.match(b.why, /boundary tier never runs a task's validate/);
});

test('a TIER-0-ONLY pin stays valid, with and without the task\'s own validate (R11)', () => {
  assert.deepEqual(
    receiptProvenance({ ...FULL, commandPolicyHash: PIN_0.pinnedHash, declaredCommands: 0, results: [] }, PIN_0),
    { ok: true },
    '`project init` scaffolds `gates: {}` and a fresh project must still be able to gate',
  );
  assert.deepEqual(
    receiptProvenance({
      ...FULL,
      commandPolicyHash: PIN_0.pinnedHash,
      declaredCommands: 0,
      results: [{ name: 'validate', argv: ['/abs/dossier/script.sh'], exitCode: 0, ms: 1 }],
    }, PIN_0),
    { ok: true },
    'a tier-0-only task run still appends the task\'s own validate',
  );
});

// --- recordGateReceipt: THE replacement coverage for the retired op's kernel-side guards -------
// `legion state receipt-record` used to expose these two refusals directly through the CLI. The op
// is gone (R1), so they are asserted here, on the exported writer, rather than dropped: a guard
// that stops being reachable through an op does not stop being load-bearing.

test('receipt-record is NOT an op — the writer is exported and deliberately undispatchable', () => {
  assert.ok(!STATE_OPS.includes('receipt-record'), 'PLAN-V3 §State: there is no receipt-record op');
  assert.deepEqual(STATE_OPS.filter((op) => /receipt/.test(op)), [],
    'no op may write a receipt: `legion state` generates its advertised list from this table');
  assert.equal(typeof recordGateReceipt, 'function', 'the writer exists, for `legion gate` alone');
});

/** A dossier with a feature.json pointing at a real one-commit git worktree, plus tasks.json. */
function gitDossier(tasks = [{ id: 'T1' }]) {
  const root = mkdtempSync(join(tmpdir(), 'legion3-receipt-'));
  const wt = join(root, 'wt');
  const dossier = join(root, 'dossier');
  mkdirSync(wt, { recursive: true });
  mkdirSync(dossier, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: wt, encoding: 'utf8', env: hardenedGitEnv(process.env, {
      identity: { name: 'legion test', email: 'test@example.invalid' },
    }) });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  git('init', '-b', 'main');
  writeFileSync(join(wt, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-m', 'init');
  writeFileSync(join(dossier, 'feature.json'), JSON.stringify({
    schemaVersion: 1, revision: 0, worktree: wt,
    commandPolicyHash: { task: 'p'.repeat(64), boundary: 'p'.repeat(64) },
  }));
  writeFileSync(join(dossier, 'tasks.json'), JSON.stringify({
    schemaVersion: 1, revision: 0, tasks, receipts: { boundary: null },
  }));
  return { root, wt, dossier, head: git('rev-parse', 'HEAD'), tree: git('rev-parse', 'HEAD^{tree}') };
}

const SPEC = (d, over = {}) => ({
  tier: 'task', taskId: 'T1', expectHead: d.head, expectTree: d.tree,
  commandPolicyHash: 'p'.repeat(64), declaredCommands: 0, results: [], ...over,
});

test('recordGateReceipt refuses a DIRTY worktree — the guard the retired op used to expose', () => {
  const d = gitDossier();
  try {
    writeFileSync(join(d.wt, 'untracked.txt'), 'ungated\n');
    assert.throws(() => recordGateReceipt(d.dossier, SPEC(d), 't'), /is dirty/);
    assert.equal(readTasks(d.dossier).revision, 0, 'a refused write must write NOTHING');
    assert.equal(readTasks(d.dossier).tasks[0].receipt, undefined);
  } finally {
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('recordGateReceipt refuses when expectHead/expectTree disagree with what it DERIVES', () => {
  // The kernel-side restatement of gate decision 13: the gate says what it scanned, the kernel
  // decides whether that is still true. A caller cannot pass a HEAD it wishes were true.
  const d = gitDossier();
  try {
    for (const over of [{ expectHead: 'f'.repeat(40) }, { expectTree: 'f'.repeat(40) }]) {
      assert.throws(() => recordGateReceipt(d.dossier, SPEC(d, over), 't'),
        /the repository moved between the gated scan and the record/);
      assert.equal(readTasks(d.dossier).revision, 0);
    }
  } finally {
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('recordGateReceipt writes the provenance shape, one revision bump, and the optional fields only when asked', () => {
  const d = gitDossier();
  try {
    const results = [{ name: 'test', argv: ['npm', 'test'], exitCode: 0, ms: 3 }];
    recordGateReceipt(d.dossier, SPEC(d, { declaredCommands: 1, results }), 'now-1');
    let t = readTasks(d.dossier);
    assert.equal(t.revision, 1, 'exactly one revision-bumping write');
    assert.deepEqual(t.tasks[0].receipt, {
      tier: 'task', commandPolicyHash: 'p'.repeat(64), results, declaredCommands: 1,
      head: d.head, treeHash: d.tree, at: 'now-1',
    }, 'no allowConfig and no repinnedFrom key at all on an ordinary run');

    recordGateReceipt(d.dossier, SPEC(d, { allowConfig: true, repinnedFrom: 'q'.repeat(64) }), 'now-2');
    t = readTasks(d.dossier);
    assert.equal(t.tasks[0].receipt.allowConfig, true);
    assert.equal(t.tasks[0].receipt.repinnedFrom, 'q'.repeat(64));

    // The boundary tier writes receipts.boundary, and the same shape.
    recordGateReceipt(d.dossier, SPEC(d, { tier: 'boundary', taskId: null }), 'now-3');
    assert.equal(readTasks(d.dossier).receipts.boundary.tier, 'boundary');
    assert.equal(readTasks(d.dossier).revision, 3);
  } finally {
    rmSync(d.root, { recursive: true, force: true });
  }
});

test('recordGateReceipt refuses an unknown tier, an unknown task and an incomplete spec', () => {
  const d = gitDossier();
  try {
    assert.throws(() => recordGateReceipt(d.dossier, SPEC(d, { tier: 'nonsense' }), 't'), /not a gate tier/);
    assert.throws(() => recordGateReceipt(d.dossier, SPEC(d, { taskId: 'TX' }), 't'), /unknown task 'TX'/);
    assert.throws(() => recordGateReceipt(d.dossier, SPEC(d, { commandPolicyHash: undefined }), 't'),
      /requires the commandPolicyHash the run actually ran under/);
    assert.throws(() => recordGateReceipt(d.dossier, SPEC(d, { declaredCommands: undefined }), 't'),
      /requires declaredCommands/);
    assert.throws(() => recordGateReceipt(d.dossier, SPEC(d, { results: undefined }), 't'), /results\[\]/);
    assert.equal(readTasks(d.dossier).revision, 0, 'not one of those may have written');
  } finally {
    rmSync(d.root, { recursive: true, force: true });
  }
});

// --- task-answer (manifest-only: no feature.json, no git) ----------------------------------

/** A bare dossier holding ONLY a tasks.json seeded with `list`. */
function dossierWithTasks(list) {
  const dir = mkdtempSync(join(tmpdir(), 'legion3-answer-'));
  writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ schemaVersion: 1, revision: 0, tasks: list }));
  return dir;
}
const readTasks = (dir) => JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
const answer = (dir, id, q, a, now = 't1') =>
  dispatch('task-answer', dir, { flags: { question: q, answer: a }, positional: ['task-answer', id] }, now);

test('task-answer appends {question,answer,at}, bumps revision by 1, touches nothing else', () => {
  const seed = { id: 'T1', status: 'started', title: 'x', receipt: { treeHash: 'abc' } };
  const sibling = { id: 'T2', status: 'pending', title: 'y' };
  const dir = dossierWithTasks([{ ...seed }, { ...sibling }]);
  try {
    assert.match(answer(dir, 'T1', 'q?', 'a!'), /recorded answer for task T1/);
    const t = readTasks(dir);
    assert.deepEqual(t.tasks[0].answers, [{ question: 'q?', answer: 'a!', at: 't1' }]);
    const { answers, ...rest } = t.tasks[0];
    assert.deepEqual(rest, seed);            // every other field carried through untouched
    assert.deepEqual(t.tasks[1], sibling);   // no cross-task mutation
    assert.equal(t.revision, 1);
    assert.equal(t.updatedAt, 't1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task-answer accumulates answers in call order, one revision bump each', () => {
  const dir = dossierWithTasks([{ id: 'T1', status: 'started' }]);
  try {
    answer(dir, 'T1', 'q1?', 'first', 't1');
    answer(dir, 'T1', 'q2?', 'second', 't2');
    const t = readTasks(dir);
    assert.equal(t.tasks[0].answers.length, 2);
    assert.deepEqual(t.tasks[0].answers.map((a) => a.answer), ['first', 'second']);
    assert.deepEqual(t.tasks[0].answers.map((a) => a.at), ['t1', 't2']);
    assert.equal(t.revision, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task-answer refuses an unknown task and writes nothing', () => {
  const dir = dossierWithTasks([{ id: 'T1', status: 'started' }]);
  try {
    assert.throws(() => answer(dir, 'TX', 'q?', 'a!'), /unknown task 'TX'.*task-answer/s);
    assert.equal(readTasks(dir).revision, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task-answer requires BOTH --question and --answer, naming the missing flag', () => {
  const dir = dossierWithTasks([{ id: 'T1', status: 'started' }]);
  try {
    assert.throws(
      () => dispatch('task-answer', dir, { flags: { answer: 'a' }, positional: ['task-answer', 'T1'] }, 't1'),
      /task-answer requires --question/,
    );
    assert.throws(
      () => dispatch('task-answer', dir, { flags: { question: 'q' }, positional: ['task-answer', 'T1'] }, 't1'),
      /task-answer requires --answer/,
    );
    assert.equal(readTasks(dir).revision, 0);
    // an empty-string answer is legitimate CONTENT, not a missing flag (`== null`, not falsy)
    answer(dir, 'T1', 'q?', '');
    assert.deepEqual(readTasks(dir).tasks[0].answers, [{ question: 'q?', answer: '', at: 't1' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task-answer refuses a done task — a stale answer must not ride into a re-brief', () => {
  const dir = dossierWithTasks([{ id: 'T1', status: 'done' }]);
  try {
    assert.throws(() => answer(dir, 'T1', 'q?', 'a!'), /already done/);
    const t = readTasks(dir);
    assert.equal(t.revision, 0);
    assert.equal('answers' in t.tasks[0], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('task-answer stores question/answer bytes verbatim', () => {
  const dir = dossierWithTasks([{ id: 'T1', status: 'started' }]);
  const q = 'why x=1?\n"quoted" — ünïcode';
  const a = "  leading space, tab\there, = signs = kept\nüñ '\\' ";
  try {
    answer(dir, 'T1', q, a);
    const [rec] = readTasks(dir).tasks[0].answers;
    assert.equal(rec.question, q);
    assert.equal(rec.answer, a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reads of an unknown schemaVersion die loudly (both manifests)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion3-state-unit-'));
  try {
    // feature.json with a bad schema — any feature-writing op (stage-enter) must refuse
    writeFileSync(join(dir, 'feature.json'), JSON.stringify({ schemaVersion: 2, revision: 0, stage: 'intake' }));
    assert.throws(
      () => dispatch('stage-enter', dir, { flags: {}, positional: ['stage-enter', 'spec'] }, 't'),
      /unknown schemaVersion 2/,
    );
    // tasks.json with a bad schema — any task-reading op (invalidate) must refuse
    writeFileSync(join(dir, 'feature.json'), JSON.stringify({ schemaVersion: 1, revision: 0, stage: 'intake' }));
    writeFileSync(join(dir, 'tasks.json'), JSON.stringify({ schemaVersion: 9, revision: 0, approvals: {} }));
    assert.throws(
      () => dispatch('invalidate', dir, { flags: {}, positional: ['invalidate', 'spec'] }, 't'),
      /unknown schemaVersion 9/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A closed feature accepts no stage transition — in EITHER direction. Backward entry is the
// amendment door, and it only exists on an ACTIVE feature; after close, new work is a new
// feature. The refusal must name the status so the operator knows which close it hit.
test('stage-enter refuses a closed feature, forward and backward, naming the status', () => {
  const dir = mkdtempSync(join(tmpdir(), 'legion3-state-unit-'));
  const feat = (status) => JSON.stringify({ schemaVersion: 1, revision: 0, stage: 'review', status });
  const enter = (stage) => dispatch('stage-enter', dir, { flags: {}, positional: ['stage-enter', stage] }, 't');
  try {
    for (const status of ['delivered', 'abandoned']) {
      writeFileSync(join(dir, 'feature.json'), feat(status));
      assert.throws(() => enter('plan'), new RegExp(`feature is closed \\(status: ${status}\\)`), 'backward');
      assert.throws(() => enter('pre-merge'), new RegExp(`feature is closed \\(status: ${status}\\)`), 'forward');
      assert.equal(JSON.parse(readFileSync(join(dir, 'feature.json'), 'utf8')).revision, 0, 'nothing written');
    }
    // Positive control: the same manifest with status 'active' still takes the backward hop.
    writeFileSync(join(dir, 'feature.json'), feat('active'));
    assert.match(enter('plan'), /entered stage plan/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
