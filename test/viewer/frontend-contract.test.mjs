// frontend-contract.test.mjs — T41's PROHIBITION TESTS, over the committed frontend source.
//
// Hermetic and dependency-free: it reads `viewer/src` off disk and imports the two SERVER modules
// whose exported constants are the contract. No build, no browser, no viewer/node_modules — so it
// is green on a fresh clone and it is green in CI, which is exactly where a mutation affordance
// would creep back in unnoticed.
//
// THE FOUR THINGS IT PINS, and what each one would catch:
//
//   1. THE VOCABULARY IS THE SERVER'S. `viewer/src/data/types.ts` transcribes VIEWER_STATUSES,
//      ATTENTION_KINDS and ACTIVITY_KINDS; here they are compared, member for member and in order,
//      against the live exports of src/cli/_viewer/projection.mjs and _viewer/activity.mjs. A
//      status added server-side without a client label would otherwise render as an unlabelled pill
//      in a corner of one screen; a status invented CLIENT-side is the second lifecycle vocabulary
//      the prohibitions forbid outright, and it fails here.
//
//   2. THE CLIENT CARRIES NO KERNEL STAGE LIST. legion2's `ui.tsx` held `STAGE_ORDER` as a literal;
//      the ported spine is built from recorded stageHistory/completedStages plus the kernel's own
//      `nextUnsatisfied`. A re-introduced stage table is viewer-derived lifecycle state, so no
//      component file may name three or more of the kernel's STAGES as string literals.
//
//   3. THERE IS NO MUTATION SURFACE, AND NO SSE. Every deleted module is absent as a FILE (not
//      commented out), no source names EventSource/onmessage/the CSRF token, and every `fetch(` in
//      the tree passes `method: 'GET'`. A POST would have to appear as a literal to work; there is
//      no route to send it to either, and test/cli/viewer.test.mjs walks the server side.
//
//   4. THE DELETED SENTENCES STAY DELETED, AND THE STATS FORMULA IS NOT RE-DERIVED. The screens
//      that explained legion to its own author render the state instead; a sentence re-typed into
//      a component is the same screen back. And the insights screen must not contain arithmetic
//      over the population (H01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ACTIVITY_KINDS } from '../../src/cli/_viewer/activity.mjs';
import { ATTENTION_KINDS, VIEWER_STATUSES } from '../../src/cli/_viewer/projection.mjs';
import { STAGES } from '../../src/kernel/state.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // test/viewer/x -> repo root
const SRC = join(ROOT, 'viewer', 'src');

/** Every source file under viewer/src, as {rel, text, code}. `node_modules`/`dist` are gitignored
 * and live outside this directory anyway; nothing here walks them.
 *
 * `code` IS THE TEXT WITH COMMENTS REMOVED, and the distinction is load-bearing for the residue
 * scans below. This port's headers DOCUMENT what was deleted — "legion2's class carried an
 * EventSource, a cursor map and a CSRF token; none of it is ported" — and that sentence is the
 * most valuable thing in the file. A scan over raw text would force the documentation to speak in
 * euphemisms, which is how the reason for a deletion gets lost. So the scans run over code and the
 * prose is free to name what is gone. Comment stripping is deliberately CONSERVATIVE: whole-line
 * `//` comments and `/* … *\/` blocks only, so a `//` inside a string (`https://…`) is never
 * mistaken for a comment and no real code is hidden from the scan by accident. */
function sources(exts = ['.ts', '.tsx', '.mjs']) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir).sort()) {
      const abs = join(dir, entry);
      if (statSync(abs).isDirectory()) { walk(abs); continue; }
      if (!exts.includes(extname(abs))) continue;
      const text = readFileSync(abs, 'utf8');
      out.push({ rel: relative(ROOT, abs), text, code: codeOf(text) });
    }
  };
  walk(SRC);
  return out;
}

const codeOf = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

/** The members of `export const NAME: … = [ … ];` in a TypeScript file, in order. The `=` is found
 * first because the TYPE ANNOTATION carries its own brackets (`: ViewerStatus[]`). */
function arrayLiteral(text, name) {
  const start = text.indexOf(`export const ${name}`);
  assert.notEqual(start, -1, `viewer/src/data/types.ts declares ${name}`);
  const eq = text.indexOf('=', start);
  const open = text.indexOf('[', eq);
  const close = text.indexOf(']', open);
  assert.ok(eq !== -1 && open !== -1 && close > open, `${name} is an array literal`);
  return [...text.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the client transcribes the SERVER vocabularies exactly — order and members', () => {
  const types = readFileSync(join(SRC, 'data', 'types.ts'), 'utf8');
  assert.deepEqual(arrayLiteral(types, 'VIEWER_STATUSES'), VIEWER_STATUSES,
    'a status the server can emit and the client cannot label renders as an unstyled pill');
  assert.deepEqual(arrayLiteral(types, 'ATTENTION_KINDS'), ATTENTION_KINDS);
  assert.deepEqual(arrayLiteral(types, 'ACTIVITY_KINDS'), ACTIVITY_KINDS);
});

test('every viewer status has exactly one label and one colour class — none invented, none missing', () => {
  const types = readFileSync(join(SRC, 'data', 'types.ts'), 'utf8');
  for (const table of ['STATUS_LABELS', 'STATUS_CLASS']) {
    const start = types.indexOf(`export const ${table}`);
    assert.notEqual(start, -1, `${table} exists`);
    const body = types.slice(types.indexOf('{', start), types.indexOf('};', start));
    const keys = [...body.matchAll(/^\s*'?([a-z-]+)'?:/gm)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), [...VIEWER_STATUSES].sort(), `${table} covers the server enum and nothing else`);
  }
});

test('no component carries a copy of the kernel STAGES list — the spine is built from recorded facts', () => {
  // fixtures.ts is DATA: a fixture world legitimately records the stages a fake feature was in.
  // Everything else is code, and code that knows the lifecycle order is a second lifecycle model.
  const DATA_FILES = ['viewer/src/data/fixtures.ts'];
  for (const { rel, text } of sources()) {
    if (DATA_FILES.includes(rel)) continue;
    const named = STAGES.filter((s) => text.includes(`'${s}'`) || text.includes(`"${s}"`));
    assert.ok(named.length < 3,
      `${rel} names ${named.length} kernel stages as literals (${named.join(', ')}) — that is a client-side stage order`);
  }
});

test('the deleted modules are ABSENT AS FILES, not commented out', () => {
  const files = sources(['.ts', '.tsx', '.mjs', '.css']).map((f) => f.rel);
  for (const gone of [
    'Bell.tsx', 'Intake.tsx', 'IntakeValidationCard.tsx',
    'notifications.mjs', 'transcript.mjs', 'ticket-form.mjs', 'ticket-fixtures.mjs',
  ]) {
    assert.ok(!files.some((f) => f.endsWith(`/${gone}`)), `${gone} is deleted, not disabled`);
  }
  // And the screens that remain are exactly the ported five.
  const screens = files.filter((f) => f.includes('/screens/')).map((f) => f.split('/').pop());
  assert.deepEqual(screens.sort(), ['FeatureDetail.tsx', 'Features.tsx', 'Gallery.tsx', 'Insights.tsx', 'Operations.tsx']);
});

test('no SSE, no event stream, no CSRF token and no mutation verb in the frontend CODE', () => {
  for (const { rel, code } of sources()) {
    for (const pattern of [
      /EventSource/, /\.onmessage/, /x-legion-token/, /\/api\/events/,
      /\/api\/(?:answer|command|watchdog|intake)/,
    ]) {
      assert.equal(pattern.test(code), false, `${rel} names ${pattern} — legion3 has no event stream, no token and no command route`);
    }
  }
});

test('every fetch in the frontend is a GET — there is no other method literal in the tree', () => {
  let fetches = 0;
  let gets = 0;
  for (const { rel, code } of sources()) {
    fetches += [...code.matchAll(/\bfetch\(/g)].length;
    gets += [...code.matchAll(/method:\s*'GET'/g)].length;
    // A method literal that is not GET cannot be anything but a mutation attempt.
    const bad = [...code.matchAll(/method:\s*'(?!GET|HEAD)([A-Za-z]+)'/g)].map((m) => m[1]);
    assert.deepEqual(bad, [], `${rel} builds a ${bad.join('/')} request — the viewer is read-only`);
  }
  assert.ok(fetches > 0, 'the live data source really does fetch');
  assert.equal(fetches, gets, `every one of the ${fetches} fetch call(s) states method: 'GET' explicitly`);
});

test('no client file renders a sentence about how legion works — the screens show the state', () => {
  // The approvals table's last column answers "does this still bind" per row, from the kernel asked
  // on this request; the initiative identifiers are the operator's own link; the statistics screen
  // opens on its tiles and ends on its last table. No component may re-type any of it — including
  // fixtures.ts, which is exempt from the stage scan but has nothing left to state here. The scan
  // is over CODE, so a header stays free to record what was removed and why.
  const gone = [
    /ApprovalsCaveat/, /approvalsCaveat/, /recorded != valid/i, /Recorded, not valid/,
    /view\.initiative/, /title="Initiative"/,
    /Percentiles are nearest-rank/, /waiting-versus-processing/i,
  ];
  for (const { rel, code } of sources()) {
    for (const pattern of gone) {
      assert.equal(pattern.test(code), false, `${rel} renders ${pattern} — that sentence is deleted, not moved`);
    }
  }
});

test('the Insights screen renders, it does not compute (H01)', () => {
  const insights = codeOf(readFileSync(join(SRC, 'screens', 'Insights.tsx'), 'utf8'));
  // NO ARITHMETIC ON A SERVER NUMBER. `insights()` ships the counts, the denominators and the
  // nearest-rank percentiles; this screen may format them (ms → hours, in ui.tsx's fmtDuration,
  // which is named as formatting) and may not derive one number from another. A second average, a
  // percentage or a "success rate" computed here would be the second formula H01 forbids.
  const arithmetic = [...insights.matchAll(/data\.[A-Za-z.[\]']+\s*[-+*/%]\s*\S/g)].map((m) => m[0]);
  assert.deepEqual(arithmetic, [], 'a server statistic is combined with something on this screen');
  assert.ok(!insights.includes('reduce('), 'no aggregation is computed on this screen');
  assert.ok(!insights.includes('Math.'), 'no arithmetic beyond rendering');
  // NO MONEY FIGURE, AND NO PLACEHOLDER FOR ONE: no rate is recorded anywhere, so a cost is the one
  // number this screen could only invent. Token counts arrive computed, and the scans above are what
  // keep the rendering from deriving a fifth number out of the four.
  assert.ok(!/\bcost\b|\bprice\b|\$[0-9]/i.test(insights), 'a money figure is rendered on a screen that has no rate');
});

test('Markdown owns its children exactly once — the memoised __html and the idempotent rewrite', () => {
  // BOTH RULES ARE REGRESSIONS THAT SHIPPED ONCE, and neither is visible to a node test that does
  // not render: react-dom-client diffs props by IDENTITY, so a fresh `{__html: …}` literal in the
  // JSX re-ran setInnerHTML on every render and wiped every mermaid diagram the effect had mounted
  // (~0.5s after it appeared, forever, because the mermaid effect keys on `html` and `html` had not
  // changed). The rewrite pass then has the mirror-image problem: its deps include a caller-supplied
  // `resolveHref` arrow, so it re-runs over a DOM it already rewrote, and a second pass would feed
  // `/api/artifact?…` back to the resolver — which refuses it — turning live images and links into
  // inert text. The browser-level proof lives in T42; this is the cheap guard that a later edit does
  // not quietly undo either one.
  const md = codeOf(readFileSync(join(SRC, 'components', 'Markdown.tsx'), 'utf8'));
  assert.ok(!/dangerouslySetInnerHTML=\{\{/.test(md),
    'an inline {__html} literal is a NEW object every render — React re-writes innerHTML and wipes the rendered diagrams');
  assert.match(md, /useMemo\(\(\) => \(\{ __html: html \}\), \[html\]\)/,
    'the __html object must be memoised on `html` so React writes the document once per document');
  for (const sel of ['img:not\\(\\[data-md-resolved\\]\\)', 'a:not\\(\\[data-md-resolved\\]\\)']) {
    assert.match(md, new RegExp(sel), 'the relative-reference rewrite must skip what it already rewrote');
  }
});

test('safeHref links http(s) and nothing else', async () => {
  const { safeHref } = await import('../../viewer/src/lib/safe-href.mjs');
  assert.equal(safeHref('https://gitlab.example.com/x/-/merge_requests/77'), 'https://gitlab.example.com/x/-/merge_requests/77');
  assert.equal(safeHref('http://localhost:8080/mr/1'), 'http://localhost:8080/mr/1');
  assert.equal(safeHref('javascript:alert(1)'), null);
  assert.equal(safeHref('file:///etc/passwd'), null);
  assert.equal(safeHref('//evil.example'), null);
  assert.equal(safeHref(null), null);
  assert.equal(safeHref(undefined), null);
  assert.equal(safeHref(''), null);
});
