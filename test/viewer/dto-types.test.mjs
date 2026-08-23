// dto-types.test.mjs — THE SEAM THE T41 REVIEW FOUND MISSING: the client's declared DTO TYPES
// checked, field by field, against a LIVE projection payload built from real manifests.
//
// WHY IT EXISTS. `viewer/src/data/types.ts` declared `commandPolicyHash: string | null`. The kernel
// writes an OBJECT there — `feature start` pins one hash per gate tier, `{task, boundary}`
// (kernel/state.mjs commandPolicyPin) — and the projection passes it through verbatim, so
// FeatureDetail handed an object to JSX and React threw error #31 ("Objects are not valid as a React
// child") on EVERY readable feature. Nothing in the suite caught it, and the reason is the shape of
// what was tested: frontend-contract.test.mjs compares the three ENUM VOCABULARIES against the
// server's exports, and the fixture worlds in viewer/src/data/fixtures.ts agreed with the wrong type
// because they were written FROM it. Fixtures cannot falsify a DTO they were derived from; only the
// live payload can.
//
// WHAT IT CHECKS, and what it deliberately does not. This is a RUNTIME TYPE CHECK, not a type
// checker: it parses the interface declarations out of types.ts (no TypeScript, no viewer/
// node_modules, no build — green on a fresh clone) and asserts that every field the client declares
// is PRESENT in the live payload and that its live JavaScript value SATISFIES the declared
// annotation. Declared names it cannot resolve (imported or generic types) are skipped rather than
// guessed at, and a live object carrying EXTRA keys is not a failure — the client rendering less
// than the server records is the design.
//
// IT IS ITS OWN MUTATION TEST. `the checker is not vacuous` below feeds the matcher the exact drift
// that shipped (an object against `string | null`), plus a missing required field, a wrong scalar
// and a bad array element, and requires each to be REPORTED. A matcher that quietly returned true
// would pass every other test in this file, so that one is what keeps them worth running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixture, planTask } from '../helpers/fixture.mjs';
import { featureSummaries, featureView } from '../../src/cli/_viewer/projection.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // test/viewer/x -> repo root
const TYPES_PATH = join(ROOT, 'viewer', 'src', 'data', 'types.ts');

/** Run `fn` with LEGION_HOME pinned at a sandbox home, always restored (same seam as
 * test/cli/viewer-projection.test.mjs: the projection reads the home lazily on every call). */
function withHome(home, fn) {
  const saved = process.env.LEGION_HOME;
  process.env.LEGION_HOME = home;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = saved;
  }
}

// --- a very small TypeScript declaration reader ----------------------------------------------------
// It understands exactly the type language types.ts is written in: scalars, string/boolean literals,
// `null`, unions, arrays, `Record<K, V>`, inline object literals, index signatures, `unknown`, and
// interface/alias names. Anything else is UNRESOLVED and skipped — never assumed to match.

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

/** Split on top-level separator characters, respecting (), [], {}, <> and quoted strings. */
function splitTop(s, seps) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (const ch of s) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if ('([{<'.includes(ch)) depth += 1;
    else if (')]}>'.includes(ch)) depth -= 1;
    if (depth === 0 && seps.includes(ch)) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter((x) => x.length > 0);
}

/** The `{ … }` starting at `open`, with its matching close brace. */
function braceBody(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
    }
  }
  throw new Error('unbalanced braces in types.ts');
}

const FIELD_RE = /^(?:readonly\s+)?(\[[^\]]+\]|[A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/;

/** `{name, optional, type, index}` per declared member; members this reader cannot parse (method
 * signatures, call signatures) are dropped, and no interface checked below has one. */
function parseFields(body) {
  const out = [];
  for (const member of splitTop(body, ';,')) {
    const m = FIELD_RE.exec(member);
    if (!m) continue;
    out.push({ name: m[1], optional: m[2] === '?', type: m[3].trim(), index: m[1].startsWith('[') });
  }
  return out;
}

function parseTypes(text) {
  const src = stripComments(text);
  const interfaces = new Map();
  const aliases = new Map();
  const ri = /export interface (\w+)(?:\s+extends\s+([\w,\s]+?))?\s*\{/g;
  let m;
  while ((m = ri.exec(src)) !== null) {
    const { body, end } = braceBody(src, src.indexOf('{', m.index + m[0].length - 1));
    interfaces.set(m[1], {
      parents: m[2] ? m[2].split(',').map((s) => s.trim()).filter(Boolean) : [],
      fields: parseFields(body),
    });
    ri.lastIndex = end;
  }
  // `export type X = …;` — generics (`Loaded<T>`) do not match and are left unresolved on purpose.
  const ra = /export type (\w+)\s*=\s*([\s\S]*?);\n/g;
  while ((m = ra.exec(src)) !== null) aliases.set(m[1], m[2].trim());
  return { interfaces, aliases };
}

const { interfaces, aliases } = parseTypes(readFileSync(TYPES_PATH, 'utf8'));

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Declared fields of an interface, its parents' included. */
function fieldsOf(name) {
  const decl = interfaces.get(name);
  if (!decl) return null;
  return [...decl.parents.flatMap((p) => fieldsOf(p) ?? []), ...decl.fields];
}

const unwrapParens = (t) => (braceLike(t) ? t.slice(1, -1).trim() : t);

/** true when the whole string is one parenthesized group (`(string | null)`, not `(a) | (b)`). */
function braceLike(t) {
  if (!t.startsWith('(')) return false;
  let depth = 0;
  for (let i = 0; i < t.length; i += 1) {
    if (t[i] === '(') depth += 1;
    else if (t[i] === ')') { depth -= 1; if (depth === 0) return i === t.length - 1; }
  }
  return false;
}

/** Does `value` satisfy the declared annotation `type`? Unresolvable names answer `true` — this
 * reader says "I do not know", never "it matched". */
function fits(type, value) {
  const t = unwrapParens(type.trim());
  if (t === 'unknown' || t === 'any' || t === 'never') return true;
  const union = splitTop(t, '|');
  if (union.length > 1) return union.some((u) => fits(u, value));
  if (t === 'null') return value === null;
  if (t === 'undefined') return value === undefined;
  if (t === 'string') return typeof value === 'string';
  if (t === 'number') return typeof value === 'number';
  if (t === 'boolean') return typeof value === 'boolean';
  if (t === 'true') return value === true;
  if (t === 'false') return value === false;
  if (/^'[^']*'$/.test(t)) return value === t.slice(1, -1);
  if (t.endsWith('[]')) {
    const inner = t.slice(0, -2);
    return Array.isArray(value) && value.every((el) => fits(inner, el));
  }
  if (t.startsWith('Record<') && t.endsWith('>')) {
    const args = splitTop(t.slice('Record<'.length, -1), ',');
    return isPlainObject(value) && Object.values(value).every((v) => fits(args[1] ?? 'unknown', v));
  }
  if (t.startsWith('{') && t.endsWith('}')) return fitsFields(parseFields(t.slice(1, -1)), value);
  const fields = fieldsOf(t);
  if (fields) return fitsFields(fields, value);
  const alias = aliases.get(t);
  if (alias !== undefined) return fits(alias, value);
  return true; // an imported or generic name: unresolved, so no verdict
}

function fitsFields(fields, value) {
  if (!isPlainObject(value)) return false;
  for (const f of fields) {
    if (f.index) continue; // an index signature makes no field mandatory
    const present = Object.prototype.hasOwnProperty.call(value, f.name) && value[f.name] !== undefined;
    if (!present) { if (f.optional) continue; return false; }
    if (!fits(f.type, value[f.name])) return false;
  }
  return true;
}

const describe = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (isPlainObject(v)) return `object with keys {${Object.keys(v).join(', ')}} — React renders one as error #31`;
  return `${typeof v} ${JSON.stringify(v)}`;
};

/** Report every mismatch under `path`, drilling into arrays and objects so the message names the
 * field that is actually wrong rather than the container that holds it. */
function report(path, type, value, problems) {
  if (fits(type, value)) return;
  const t = unwrapParens(type.trim());
  if (t.endsWith('[]') && Array.isArray(value)) {
    const inner = t.slice(0, -2);
    value.forEach((el, i) => report(`${path}[${i}]`, inner, el, problems));
    if (problems.some((p) => p.startsWith(`${path}[`))) return;
  }
  const fields = t.startsWith('{') && t.endsWith('}') ? parseFields(t.slice(1, -1)) : fieldsOf(t);
  if (fields && isPlainObject(value) && splitTop(t, '|').length === 1) {
    let found = false;
    for (const f of fields) {
      if (f.index) continue;
      const present = Object.prototype.hasOwnProperty.call(value, f.name) && value[f.name] !== undefined;
      if (!present) {
        if (f.optional) continue;
        problems.push(`${path}.${f.name}: declared \`${f.type}\` and ABSENT from the live payload`);
        found = true;
        continue;
      }
      const before = problems.length;
      report(`${path}.${f.name}`, f.type, value[f.name], problems);
      if (problems.length > before) found = true;
    }
    if (found) return;
  }
  problems.push(`${path}: declared \`${t}\`, live value is ${describe(value)}`);
}

/** Every declared field of `iface` against `value`, as a list of human-readable problems. */
function checkAgainst(iface, value, path) {
  const fields = fieldsOf(iface);
  assert.ok(fields && fields.length > 0, `types.ts declares interface ${iface}`);
  const problems = [];
  report(path, iface, value, problems);
  return problems;
}

// --- the reader itself, before anything is concluded from it ---------------------------------------

test('the declaration reader actually read types.ts — it is not silently empty', () => {
  assert.ok(interfaces.size >= 15, `parsed ${interfaces.size} interfaces from types.ts`);
  assert.ok(aliases.has('ViewerStatus') && aliases.has('ActivityKind'));
  const view = fieldsOf('FeatureView');
  assert.ok(view.length >= 35, `FeatureView resolves ${view.length} fields including FeatureSummary's`);
  // The inherited half is really inherited: `key` comes from FeatureSummary, `dossier` from FeatureView.
  assert.ok(view.some((f) => f.name === 'key'));
  assert.ok(view.some((f) => f.name === 'dossier'));
  assert.ok(view.some((f) => f.name === 'commandPolicyHash'));
});

test('the checker is not vacuous — it catches the exact drift that shipped, and three of its cousins', () => {
  // 1. THE ONE THAT SHIPPED: the kernel's tier map against a `string | null` declaration.
  assert.equal(fits('string | null', { task: 'a', boundary: 'b' }), false);
  const p1 = [];
  report('feature.commandPolicyHash', 'string | null', { task: 'a', boundary: 'b' }, p1);
  assert.equal(p1.length, 1);
  assert.match(p1[0], /declared `string \| null`, live value is object with keys \{task, boundary\}/);
  // ...and the corrected declaration accepts it, while still refusing a bare string map value.
  assert.equal(fits('Record<string, string> | null', { task: 'a', boundary: 'b' }), true);
  assert.equal(fits('Record<string, string> | null', { task: { a: 1 } }), false);

  // 2. a required field that the payload does not carry
  const p2 = [];
  report('row', '{ a: string; b: number }', { a: 'x' }, p2);
  assert.deepEqual(p2, ['row.b: declared `number` and ABSENT from the live payload']);

  // 3. a wrong scalar, named by its path rather than by its container
  const p3 = [];
  report('row', 'FeatureId', { org: 'o', project: 'p', name: 7 }, p3);
  assert.equal(p3.length, 1);
  assert.match(p3[0], /^row\.name: declared `string`, live value is number 7$/);

  // 4. one bad element in an otherwise fine array
  const p4 = [];
  report('rows', 'StageStamp[]', [{ stage: 's', at: 'now' }, { stage: 's' }], p4);
  assert.deepEqual(p4, ['rows[1].at: declared `string` and ABSENT from the live payload']);

  // And the shapes that are RIGHT are not reported: unions, literals, optionals, index signatures.
  assert.equal(fits('Attention[]', [{ kind: 'quiet', detail: { ageHours: 1, sinceHours: 1, updatedAt: null } }]), true);
  assert.equal(fits('Attention[]', [{ kind: 'quiet', detail: { ageHours: 1 } }]), false);
  assert.equal(fits('UnreadableRow', { key: 'k', label: 'l', unreadable: true, why: 'w', viewerStatus: 'unreadable', attention: [] }), true);
  assert.equal(fits('InitiativeBlock', { id: 'i', anythingElse: 42 }), true); // index signature: growth is the kernel's
  assert.equal(fits('Receipt', { present: false, declaredCommands: null, weak: false, tier: null, head: null, treeHash: null, at: null }), true);
});

// --- the live payloads ------------------------------------------------------------------------------

test('every FeatureView field the client declares matches the LIVE /api/feature payload', () => {
  const h = fixture({ project: 'fixproj', feature: 'f1' });
  try {
    // A feature carrying as much RECORDED reality as real ops can cheaply produce: an imported plan
    // with two milestones, a started task with an open question, an approved intake, an escalated
    // profile and a review — so the check walks tasksDetail, milestones, artifacts, approvals,
    // reviews, activity and lifecycleNow rather than a page of nulls.
    const intent = h.writeArtifact('intent.md', '# intent\nthe agreed shape\n');
    assert.equal(h.legion('state', 'artifact-record', 'intent', intent).code, 0);
    assert.equal(h.legion('state', 'decision-record', 'intake').code, 0);
    // An unrecorded draft too, so the payload carries a `recorded: false` ArtifactRef through
    // the field-by-field check (the ONE artifact shape covers records and drafts alike).
    h.writeArtifact('spec.md', '# spec draft\n');
    h.seedPlan([
      planTask('T1', { milestone: 'M1' }),
      planTask('T2', { milestone: 'M1' }),
      planTask('T3', { milestone: 'M2' }),
    ]);
    assert.equal(h.legion('state', 'task-start', 'T1').code, 0);
    assert.equal(h.legion('state', 'task-answer', 'T1', '--question', 'which base?', '--answer', 'the pinned baseSha').code, 0);
    assert.equal(h.legion('gate', 'review-receipt', '--agent-type', 'legion:code-reviewer', '--agent-id', 'dto-rev', '--verdict', 'pass').code, 0);
    assert.equal(h.legion('state', 'review-record', '--role', 'code-reviewer', '--verdict', 'pass', '--subject', 'task:T1').code, 0);
    // The OPEN question — `task-answer` requires both halves by design, so the unanswered shape is
    // written by hand exactly as test/cli/viewer-projection.test.mjs does. It is what puts an
    // `open-question` Attention row (its own inline detail type) into the payload being checked.
    const tasksPath = join(h.home, 'orgs', 'default', 'projects', 'fixproj', 'features', 'f1', 'tasks.json');
    const doc = JSON.parse(readFileSync(tasksPath, 'utf8'));
    doc.tasks = doc.tasks.map((t) => (t.id === 'T2'
      ? { ...t, answers: [{ question: 'which shape?', answer: null, at: doc.updatedAt ?? new Date().toISOString() }] }
      : t));
    writeFileSync(tasksPath, `${JSON.stringify(doc, null, 2)}\n`);

    const view = withHome(h.home, () => featureView({ org: 'default', project: 'fixproj', name: 'f1' }));
    // The field that crashed the screen, stated as the fact it is rather than left to the walk.
    assert.ok(isPlainObject(view.commandPolicyHash),
      'feature start pins commandPolicyHash PER TIER — a client that types it as a string crashes on every feature');
    assert.deepEqual(Object.keys(view.commandPolicyHash).sort(), ['boundary', 'task']);

    const problems = checkAgainst('FeatureView', view, 'feature');
    assert.deepEqual(problems, [], `the live feature DTO contradicts viewer/src/data/types.ts:\n  ${problems.join('\n  ')}`);

    // THE TOKEN BLOCK NEEDS A READER, and no manifest produces one: without the injection every
    // token field is absent, so the POPULATED shape would go unchecked — fixtures.ts's blind spot.
    const withTokens = withHome(h.home, () => featureView({
      org: 'default',
      project: 'fixproj',
      name: 'f1',
      readAgents: () => ({
        available: true,
        agents: [{ at: '2026-07-25T01:00:00.000Z', tokens: { input: 1, output: 2, cacheRead: 3, cacheCreate: 4 } }],
        session: { tokens: { input: 5, output: 6, cacheRead: 7, cacheCreate: 8 }, sessionId: 'sess-1' },
      }),
    }));
    assert.equal(withTokens.tokens.available, true);
    assert.deepEqual(checkAgainst('FeatureView', withTokens, 'feature(transcripts read)'), []);
  } finally { h.cleanup(); }
});

test('the DELIVERED-shaped and UNREADABLE payloads match their declarations too', () => {
  const h = fixture({ project: 'fixproj', feature: 'f1' });
  try {
    // A second feature, corrupted, proves the unreadable row is checked as UnreadableRow — the row
    // H06 exists for must satisfy its own declaration or the inventory renders a half-row.
    assert.equal(h.legionIn(h.repoRoot, 'feature', 'start', 'f2', '--base', 'main').code, 0);
    const f2 = join(h.home, 'orgs', 'default', 'projects', 'fixproj', 'features', 'f2', 'feature.json');
    writeFileSync(f2, '{ not json\n');

    const out = withHome(h.home, () => featureSummaries({}));
    assert.equal(out.summaries.length, 1);
    assert.equal(out.unreadable.length, 1);
    for (const s of out.summaries) {
      assert.deepEqual(checkAgainst('FeatureSummary', s, `summary(${s.key})`), []);
    }
    for (const u of out.unreadable) {
      assert.deepEqual(checkAgainst('UnreadableRow', u, `unreadable(${u.key})`), []);
    }
    // The detail view of the corrupt one is the same row shape, not a stripped FeatureView.
    const v = withHome(h.home, () => featureView({ org: 'default', project: 'fixproj', name: 'f2' }));
    assert.deepEqual(checkAgainst('UnreadableRow', v, 'feature(f2)'), []);
  } finally { h.cleanup(); }
});
