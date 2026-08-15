// browser.test.mjs — T42(A/B): the built viewer, in a real browser, over the REAL server, against a
// LEGION_HOME forged by test/helpers/fixture.mjs. Ported from legion2's test/viewer/responsive.test.mjs
// harness (same skip convention, same port-0 server-per-page shape) and re-aimed at what v3 renders.
//
// WHY A BROWSER AT ALL, when test/cli/viewer.test.mjs already walks every endpoint and
// test/viewer/frontend-contract.test.mjs already scans every source file. Because both of those ask
// about the parts. The claims this chunk actually makes are about the WHOLE: that an operator who
// opens this page sees the open question rather than a spinner, sees the corrupt dossier as one
// honest row rather than an empty inventory, sees "recorded" beside an approval rather than a green
// tick, and sees an unreachable server named as unreachable rather than as a world with no features
// in it. Every one of those is a rendering claim, and a rendering claim is only ever verified by
// rendering.
//
// THE SERVER IS THE REAL ONE. `createViewerServer` from src/cli/_viewer/server.mjs, bound on port 0
// (any free port, so parallel test FILES never collide), serving the real `viewer/dist`. There is no
// mock API and no fixture data source: `?fixtures` exists in the app for the component gallery and
// is deliberately NOT what this file exercises — a browser test against fabricated data proves the
// fabricator works.
//
// THE WORLD IS BUILT ONCE. `buildWorld()` runs the real `bin/legion.mjs` a couple of dozen times
// (project init, four `feature start`s, a plan import, a gate run, real commits); that is ~30s, and
// paying it per test would put this file over a minute for no extra coverage. It is built in
// `before` — never at module scope, because node --test imports every .mjs under test/ and a module
// that forges a home on import forges one for every run of every other file.
//
// FOUR FEATURES, EACH ANSWERING A DIFFERENT QUESTION (all in ONE home, which is the point — they
// have to coexist):
//   f-active   active with an UNANSWERED question  -> viewerStatus `blocked`, the attention queue
//   f-shipped  hand-written `delivered` + closedAt -> recent outcomes (a real `close delivered`
//              demands a boundary receipt, an MR read back from a server and the whole stage prefix;
//              this file renders outcomes, it does not test the close op — state.test.mjs does)
//   f-visual   plan.md with a mermaid fence, review-visual.md with a screenshot, a recorded intake
//              approval, a session, two stages, a real commit, an MR record and a WEAK (0 declared
//              commands) boundary receipt earned from a real `gate run --boundary`
//   f-broken   feature.json replaced with garbage -> the unreadable row (H06)
//
// AUTO-SKIP, NAMED, TWICE. `viewer/dist` is gitignored and built on demand; playwright is not a
// dependency of this repository at all (the root package.json has ZERO dependencies and stays that
// way — see the header of viewer/package.json). So this file skips when either is absent, and each
// skip line is the command that turns it back on. A skip is never a silent green: `node --test`
// prints it, counts it, and names it.
//
// MUTATION-CHECKED (T42 spec D, recorded in the commit message): deleting the attention-queue render
// from Operations.tsx and rebuilding fails the Operations scenario; pointing DIST at a directory
// with no index.html turns every test here into a named skip rather than a failure.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fixture, planTask, NOW } from '../helpers/fixture.mjs';
import { createViewerServer } from '../../src/cli/_viewer/server.mjs';
import { APPROVALS_CAVEAT } from '../../src/cli/_viewer/projection.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // test/viewer/x -> repo root
const DIST = join(ROOT, 'viewer', 'dist');

const BUILD_FIX = 'run `legion viewer-build`';
const PLAYWRIGHT_FIX = 'run `npm install --no-save playwright && npx playwright install chromium` from the repo root';

/** An 8x8 truecolour PNG, VALID down to its CRCs — a hand-typed almost-PNG decodes to naturalWidth
 * 0 and the browser-side assertion below would then be measuring a corrupt fixture rather than the
 * artifact route. Regenerate with node:zlib if it ever needs to change; do not hand-edit. */
const PNG_8x8 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEUlEQVR4nGPQz7+AFTEMLQkAmJVbgTQEwGUAAAAASUVORK5CYII=',
  'base64',
);

/** playwright, from wherever the operator put it: the repo root (`npm install --no-save playwright`,
 * which lands in a gitignored root node_modules and leaves package.json byte-identical) or
 * viewer/node_modules, which has its own package.json and therefore its own resolution root. Both
 * are tried because both are reasonable and neither is committed. */
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    const req = createRequire(join(ROOT, 'viewer', 'package.json'));
    return await import(pathToFileURL(req.resolve('playwright')).href);
  }
}

const firstLine = (e) => String(e?.message ?? e).split('\n')[0];

// --- the skip probe (module scope, exactly as legion2's browser tests do it) -----------------------
let browser = null;
/** @type {string|false} */
let skip = false;
if (!existsSync(join(DIST, 'index.html'))) {
  skip = `viewer/dist is absent (it is gitignored and built on demand) — ${BUILD_FIX}`;
} else {
  try {
    const { chromium } = await loadPlaywright();
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    skip = `playwright/chromium unavailable — ${PLAYWRIGHT_FIX} (${firstLine(e)})`;
  }
}

// --- the forged world -----------------------------------------------------------------------------

/** @type {{h: import('../helpers/fixture.mjs').default, empty: string}|null} */
let world = null;

function buildWorld() {
  const h = fixture({ project: 'proj', feature: 'f-active' });
  const dossierOf = (n) => join(h.home, 'orgs', 'default', 'projects', h.project, 'features', n);
  const worktreeOf = (n) => realpathSync(join(dirname(h.repoRoot), '.legion-worktrees', h.project, n, 'checkout'));
  const at = (n, ...argv) => {
    const r = h.legionIn(worktreeOf(n), ...argv);
    assert.equal(r.code, 0, `world: \`legion ${argv.join(' ')}\` in ${n} failed: ${r.stderr}`);
    return r;
  };
  const patch = (n, file, fn) => {
    const p = join(dossierOf(n), file);
    writeFileSync(p, `${JSON.stringify(fn(JSON.parse(readFileSync(p, 'utf8'))), null, 2)}\n`);
  };
  const put = (n, rel, body) => {
    const p = join(dossierOf(n), rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const git = (cwd, ...args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: h.env });
    assert.equal(r.status, 0, `world: git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout.trim();
  };

  for (const n of ['f-shipped', 'f-visual', 'f-broken']) {
    assert.equal(h.legionIn(h.repoRoot, 'feature', 'start', n, '--base', 'main').code, 0, `world: feature start ${n}`);
    at(n, 'state', 'init');
  }

  // f-active — the actionable queue. `task-answer` REFUSES a null answer by design (both flags are
  // required), so the unanswered half is hand-written: it is the shape the build loop's
  // blocked-as-data produces and the shape hooks/session-start.mjs already reads (`answer == null`).
  h.seedPlan([planTask('T1', { milestone: 'M1' }), planTask('T2', { milestone: 'M1' })]);
  assert.equal(h.legion('state', 'task-start', 'T1').code, 0);
  patch('f-active', 'tasks.json', (t) => ({
    ...t,
    tasks: t.tasks.map((x) => (x.id === 'T1'
      ? { ...x, answers: [{ question: 'Which page size does the print CSS target?', answer: null, at: NOW }] }
      : x)),
  }));

  // f-shipped — a closed outcome (header: hand-written, and why). closedAt is RELATIVE to the
  // real clock, not the frozen NOW: the insights window is computed against Date.now()
  // (projection.mjs insights()), so a fixed date here silently fell out of the
  // RECENT_OUTCOME_DAYS window once the calendar moved past it and the recent-outcomes
  // assertions started failing on time alone.
  patch('f-shipped', 'feature.json', (f) => ({
    ...f, status: 'delivered', stage: 'finalize',
    closedAt: new Date(Date.now() - 3600_000).toISOString(),
  }));

  // f-visual — everything the Artifacts and Changes tabs render.
  put('f-visual', 'plan.md', [
    '# The plan',
    '',
    '```mermaid',
    'graph TD;',
    '  A[intake] --> B[plan];',
    '  B --> C[build];',
    '```',
    '',
    '| task | what |',
    '| ---- | ---- |',
    '| T1   | one  |',
    '',
  ].join('\n'));
  writeFileSync(
    join(dossierOf('f-visual'), 'plan.tasks.json'),
    `${JSON.stringify({ milestones: [{ id: 'M1', title: 'the milestone', tasks: [planTask('T1'), planTask('T2')] }] }, null, 2)}\n`,
  );
  at('f-visual', 'plan', 'check', '--feature', 'f-visual', '--import');
  put('f-visual', 'visual/M1/home@1280.png', PNG_8x8);
  put('f-visual', 'review-visual.md',
    '# Visual review\n\nThe dashboard at 1280:\n\n![dashboard at 1280](visual/M1/home@1280.png)\n');
  at('f-visual', 'state', 'artifact-record', 'review', join(dossierOf('f-visual'), 'review-visual.md'));
  at('f-visual', 'state', 'artifact-record', 'intent', put('f-visual', 'intent.md', '# intent\nthe agreed shape\n'));
  put('f-visual', 'spec.md', '# Spec draft\n\nStill being discussed — on disk, never recorded.\n');
  at('f-visual', 'state', 'decision-record', 'intake');
  at('f-visual', 'state', 'escalate-profile', 'standard');
  at('f-visual', 'state', 'session-record', '--session-id', 'sess-c13-t42');
  at('f-visual', 'state', 'stage-complete', 'intake');
  at('f-visual', 'state', 'stage-enter', 'spec');
  const w = worktreeOf('f-visual');
  writeFileSync(join(w, 'src', 'index.mjs'), `${readFileSync(join(w, 'src', 'index.mjs'), 'utf8')}export const step1 = 1;\n`);
  git(w, 'add', '-A');
  git(w, 'commit', '-m', 'feat: the visible change');
  const head = git(w, 'rev-parse', 'HEAD');
  // A REAL receipt, earned: the fixture's gate policy is the empty scaffold, so `gate run --boundary`
  // produces `declaredCommands: 0` — a real but TIER-0-ONLY certificate. Nothing is forged here.
  at('f-visual', 'gate', 'run', '--boundary');
  patch('f-visual', 'feature.json', (f) => ({
    ...f,
    revision: f.revision + 1,
    mr: { iid: 7, url: 'https://gitlab.invalid/acme/x/-/merge_requests/7', targetBranch: f.baseBranch, headSha: head, at: NOW },
  }));

  // f-broken — one corrupt dossier, which must cost the inventory exactly one row (H06).
  writeFileSync(join(dossierOf('f-broken'), 'feature.json'), '{ this is not json\n');

  // A second home with NOTHING in it: the honest empty state has to be rendered, not errored.
  const empty = mkdtempSync(join(tmpdir(), 'legion3-viewer-empty-'));
  return { h, empty };
}

before(() => { if (!skip) world = buildWorld(); });
after(async () => {
  if (browser) await browser.close();
  if (world) {
    world.h.cleanup();
    rmSync(world.empty, { recursive: true, force: true });
  }
});

// --- the harness ------------------------------------------------------------------------------------

/**
 * One page, one real server, one LEGION_HOME. The home is pinned for the duration INCLUDING the
 * awaits — the projection reads it lazily per request (kernel/paths.mjs), and node:test runs the
 * tests in a file sequentially, so no other test in this file can observe the pin.
 */
async function withUi(path, fn, { home = null, viewport = { width: 1280, height: 900 } } = {}) {
  const saved = process.env.LEGION_HOME;
  process.env.LEGION_HOME = home ?? world.h.home;
  const server = createViewerServer({ distDir: DIST });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  let stopped = false;
  const stop = () => (stopped ? Promise.resolve() : new Promise((r) => {
    stopped = true;
    server.closeAllConnections?.();
    server.close(() => r());
  }));
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();
  /** Every method the PAGE issued. The prohibition, observed from the browser side. */
  const methods = new Set();
  page.on('request', (r) => methods.add(r.method()));
  try {
    await page.goto(`http://127.0.0.1:${port}${path}`, { waitUntil: 'domcontentloaded' });
    await fn(page, { stop, port, methods });
  } finally {
    await context.close();
    await stop();
    if (saved === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = saved;
  }
}

const bodyText = (page) => page.locator('body').innerText();
const detail = (name) => `/#/features/default/proj/${name}`;

/** ONE section, addressed by its OWN heading. `filter({hasText})` over the section would match any
 * section whose PROSE mentions the word — the Delivery card's sentence about commits made
 * `hasText: 'Commits'` select Delivery, and the assertion that followed was then about the wrong
 * card. Headings are text-transform: uppercase in the theme, hence the case-insensitive anchor. */
const sect = (page, title) => page.locator('section.sect')
  .filter({ has: page.locator('h2').filter({ hasText: new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i') }) })
  .first();

/** Open a feature detail tab by its accessible name and wait for the panel to swap. */
async function openTab(page, name) {
  await page.locator('[role="tab"]').first().waitFor();
  await page.getByRole('tab', { name, exact: true }).click();
  await page.locator(`[role="tabpanel"][aria-labelledby="tab-${name}"]`).waitFor();
}

// --- B. the scenarios ---------------------------------------------------------------------------------

test('Operations: the open question is the queue, the delivered feature is an outcome, the corrupt dossier is one row', { skip }, async () => {
  await withUi('/#/operations', async (page, { methods }) => {
    const queue = sect(page, 'Needs your attention');
    await queue.getByRole('button', { name: 'default/proj/f-active' }).first().waitFor();

    const queueText = await queue.innerText();
    // The QUEUE ROW is the projection's attention entry, rendered with its recorded detail.
    assert.match(queueText, /1 unanswered question recorded on/);
    assert.match(queueText, /\bT1\b/);
    // H06: the unreadable dossier is a ROW in the same queue, carrying its why — not a 500, and not
    // an inventory that lost its other three features.
    assert.match(queueText, /default\/proj\/f-broken/);
    assert.match(queueText, /corrupt JSON/);

    // Recent outcomes is a different section, and the delivered feature is in it.
    const outcomes = sect(page, 'Recent outcomes');
    await outcomes.getByRole('button', { name: 'default/proj/f-shipped' }).first().waitFor();
    // `innerText` is what the OPERATOR reads, text-transform and all — hence the /i.
    assert.match(await outcomes.innerText(), /delivered/i);

    // No invented lifecycle. `quiet` is the ONLY age statement, and it is labelled as manifest age.
    const all = await bodyText(page);
    assert.doesNotMatch(all, /stalled/i);
    assert.doesNotMatch(all, /\brunning\b/i);
    assert.match(all, /Quiet — manifest age/i);

    // THE PROHIBITION, OBSERVED FROM THE BROWSER: the page issued nothing but GETs.
    assert.deepEqual([...methods].sort(), ['GET'], `the page issued ${[...methods].join(', ')}`);
  });
});

test('Features: all four are listed, and the unreadable one renders distinctly with its why', { skip }, async () => {
  await withUi('/#/features', async (page) => {
    await page.locator('table.tbl').first().waitFor();
    // Features separates the inventory into one table PER lifecycle group, so the assertion is over
    // the whole screen: four features, four groups (blocked / delivered / active / unreadable).
    const text = await page.locator('main').innerText();
    for (const name of ['f-active', 'f-shipped', 'f-visual', 'f-broken']) {
      assert.match(text, new RegExp(name), `${name} missing from the inventory`);
    }
    assert.match(text, /3 readable · 1 unreadable · 4 registered on this machine\./);

    // The unreadable row is its OWN kind of row: a class the healthy rows do not carry, its why
    // visible in the page (not hidden in a title attribute), and no invented columns beside it.
    const dead = page.locator('tr.row-unreadable');
    assert.equal(await dead.count(), 1);
    assert.match(await dead.innerText(), /corrupt JSON/);
    assert.equal(await page.locator('tr.row-unreadable .unreadable-why').count(), 1);
    assert.match(await dead.innerText(), /No other field is shown for this row/);
    // …and the three healthy rows are unaffected — one corrupt dossier cost exactly one row (H06).
    assert.equal(await page.locator('table.tbl tbody tr.click').count(), 3);
  });
});

test('FeatureDetail/Overview: the spine, the RECORDED approval caveat, and session presence as a recorded fact', { skip }, async () => {
  await withUi(detail('f-visual'), async (page) => {
    await page.locator('ol.spine').waitFor();
    const spine = await page.locator('ol.spine').innerText();
    assert.match(spine, /intake/);
    assert.match(spine, /spec/);
    assert.match(spine, /completed/); // intake was really completed by the kernel op
    assert.match(spine, /current/);

    // THE CAVEAT IS THE SERVER'S SENTENCE, rendered verbatim under a heading that says RECORDED.
    const caveat = page.locator('p.caveat').first();
    await caveat.waitFor();
    const caveatText = await caveat.innerText();
    assert.match(caveatText, /Recorded, not valid\./);
    assert.ok(caveatText.includes(APPROVALS_CAVEAT), 'the rendered caveat is not the projection\'s string');

    // RECORDED and VALID-NOW are two columns, never one green tick. The recorded row carries a time
    // and a subject hash; the kernel's live answer sits beside it, labelled as asked just now.
    const approvals = sect(page, 'Approvals — recorded');
    const approvalsText = await approvals.innerText();
    assert.match(approvalsText, /intake/);
    assert.match(approvalsText, /The kernel, asked just now/i); // the th is text-transform: uppercase
    assert.match(approvalsText, /still binds/);
    // The word "valid" appears in the caveat and NOWHERE as a verdict on a recorded row.
    assert.doesNotMatch(approvalsText, /\bapproved\b/i);

    // Session presence, as RECORDED: the id and the manifest-write facts, with no liveness claim
    // anywhere on the panel (the c13b prose trim removed the explainer; the ABSENCE of "running"/
    // "working" language is the pin now).
    const sessions = sect(page, 'Sessions and freshness');
    const sessionsText = await sessions.innerText();
    assert.match(sessionsText, /sess-c13-t42/);
    assert.match(sessionsText, /last manifest write/i);
    assert.doesNotMatch(sessionsText, /\b(running|working|live)\b/i);

    // The kernel's live verdict is a panel of ITS OWN, and it names the next unsatisfied stage the
    // kernel picked — not one this client ordered.
    const now = await page.locator('.lifecycle-now').innerText();
    assert.match(now, /satisfied/);
    assert.match(now, /Next unsatisfied:\s*spec/);
  });
});

test('FeatureDetail/Artifacts: plan.md renders as markdown with its mermaid diagram, and the screenshot loads through /api/artifact', { skip }, async () => {
  await withUi(detail('f-visual'), async (page) => {
    await openTab(page, 'Artifacts');

    // The tab is a PICKER now (c13b): one artifact renders at a time. Pick plan first.
    await page.locator('[role="tab"]', { hasText: 'plan' }).click();

    // plan.md — markdown, not a blob of text: the heading and the table are real elements.
    const digest = page.locator('.digest .md').first();
    await digest.locator('h1', { hasText: 'The plan' }).waitFor();
    assert.ok(await digest.locator('table').count() >= 1, 'the markdown table did not render');

    // The mermaid fence became an SVG. This is the lazy chunk actually loading over the real server
    // under the real CSP (`script-src 'self'`), which is the only way to know the split works.
    const holder = page.locator('.mermaid-holder svg').first();
    await holder.waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('code.language-mermaid').count(), 0, 'the fence was left as code — mermaid did not render');

    // The screenshot lives in the review artifact — pick it.
    await page.locator('[role="tab"]', { hasText: 'review' }).click();

    // The screenshot: rewritten to an /api/artifact URL and DECODED by the browser. naturalWidth is
    // the assertion that matters — a broken image has a src too. It is `loading="lazy"`, so it must
    // be scrolled to before the browser will fetch it at all.
    const img = page.locator('img.md-img').first();
    await img.waitFor();
    const src = await img.getAttribute('src');
    assert.match(src, /^\/api\/artifact\?/);
    assert.match(decodeURIComponent(src), /path=visual\/M1\/home@1280\.png/);
    await img.scrollIntoViewIfNeeded();
    await page.waitForFunction(
      (el) => el.complete && el.naturalWidth > 0,
      await img.elementHandle(), { timeout: 15_000 },
    );
  });
});

test('FeatureDetail/Artifacts: an unrecorded spec.md renders as a draft, labeled as one', { skip }, async () => {
  await withUi(detail('f-visual'), async (page) => {
    await openTab(page, 'Artifacts');

    // The picker names the draft as one — and it is a real tab whose body renders from disk.
    await page.locator('[role="tab"]', { hasText: 'spec · draft' }).click();
    await page.locator('.mission-sub', { hasText: 'draft — not yet recorded' }).waitFor();
    await page.locator('.digest .md h1', { hasText: 'Spec draft' }).waitFor();
  });
});

test('FeatureDetail/Changes: a real diff from the scratch repo, and the weak receipt flagged TIER-0 ONLY', { skip }, async () => {
  await withUi(detail('f-visual'), async (page) => {
    await openTab(page, 'Changes');

    // The receipt is REAL (a `gate run --boundary` earned it) and WEAK (0 declared commands). It must
    // not render like a full certificate — the badge and the caveat both say so.
    const receipts = sect(page, 'Boundary gate receipt');
    await receipts.waitFor();
    const receiptText = await receipts.innerText();
    assert.match(receiptText, /TIER-0 ONLY — weak receipt/);
    assert.match(receiptText, /must not be read as one/);

    // The commit reached the page through the hardened git seam.
    const commits = sect(page, 'Commits');
    await commits.getByText('feat: the visible change').waitFor();
    assert.match(await commits.innerText(), /squashed per milestone/);

    // …and so did the diff, in the MR-review split (c13b): the tree names the file by basename
    // (full path in the title attribute), selecting it renders the one pane on the right.
    const files = sect(page, 'Changed files');
    await files.locator('button.difftree-file[title="src/index.mjs"]').click();
    assert.match(await files.locator('.diff-content-head').innerText(), /src\/index\.mjs/);
    const pane = page.locator('.diff-pane').first();
    await pane.waitFor();
    const paneText = await pane.innerText();
    assert.match(paneText, /\+export const step1 = 1;/);
    assert.match(paneText, /export const answer = 1;/); // the context line, unmarked

    // Code coloring (c13b): the lazy hljs chunk loads over the real CSP and marks `export`/`const`
    // as keywords. The TEXT above already asserted exactness — the spans are additive.
    await pane.locator('.hljs-keyword').first().waitFor({ timeout: 15_000 });
  });
});

test('Insights: every tile carries its denominator', { skip }, async () => {
  await withUi('/#/insights', async (page) => {
    await page.locator('.tiles').waitFor();
    const notes = await page.locator('.tile-note').allInnerTexts();
    // H01/VF18: a count with no population is a number nobody can act on. Four statuses are non-zero
    // in this world (delivered, blocked, active, unreadable) and only non-zero ones get a tile — a
    // wall of zeroes is not an insight. Every one of them states the denominator it was counted out
    // of; the fifth tile is the recent-outcomes split, which is a denominator of a different kind.
    const denominated = notes.filter((n) => /of 4 features/.test(n));
    assert.equal(denominated.length, 4, `expected a denominator on every outcome tile, got ${denominated.length} of ${notes.length}`);
    assert.equal(notes.length, 5, `expected 4 outcome tiles + the recent-outcomes tile, got ${notes.length}`);
    assert.ok(notes.some((n) => /1 delivered · 0 abandoned/.test(n)), 'the recent-outcomes tile lost its split');
    const all = await bodyText(page);
    assert.match(all, /Closed in 7d/i);
    // The other populations are stated in words rather than left implicit under a percentile.
    assert.match(all, /4 tasks across 3 readable features\./);
    // Cost and tokens have no source in legion3, so there is no tile and no placeholder for them —
    // only a sentence saying they are absent and why. The absence is the claim under test.
    assert.equal(await page.locator('.tile', { hasText: /cost|token/i }).count(), 0);
    assert.match(all, /Cost, token counts and a waiting-versus-processing split are not shown/);
    assert.doesNotMatch(all, /\$[0-9]/);
  });
});

test('the empty home renders the honest All-clear, not an error and not a spinner', { skip }, async () => {
  await withUi('/#/operations', async (page) => {
    await page.getByText('All clear —').waitFor();
    const text = await bodyText(page);
    assert.match(text, /All clear — no feature on this machine records an open question/);
    assert.match(text, /No feature on this machine has been closed yet\./);
    assert.match(text, /Nothing is recorded in any manifest on this machine\./);
    // An empty world is not a failure: no error strip, and nothing still loading.
    assert.equal(await page.locator('[role="alert"]').count(), 0);
    assert.doesNotMatch(text, /Loading /);
    // …and the connection is healthy, which is what distinguishes "empty" from "unreachable".
    assert.match(await page.locator('.conn').innerText(), /read-only · loopback/);
  }, { home: world.empty });
});

test('the unreachable server is NAMED, the last good read is kept, and nothing spins forever', { skip }, async () => {
  await withUi('/#/operations', async (page, { stop }) => {
    // First, a real read: the inventory is on the page.
    await page.getByRole('button', { name: 'default/proj/f-active' }).first().waitFor();
    await stop(); // the server dies mid-session, exactly as ^C in the other terminal does

    // The next poll fails, and the failure is rendered AS a failure. (Features poll every 5s.)
    const strip = page.locator('[role="alert"].sync-strip').first();
    await strip.waitFor({ timeout: 30_000 });
    const stripText = await strip.innerText();
    assert.match(stripText, /showing the last successful read from/);
    assert.match(stripText, /nothing here is guessed/);
    await page.getByRole('button', { name: 'Retry now' }).waitFor();

    // H02, the whole point: the last good data is still there, not blanked and not replaced by an
    // empty world that would read as "you have no features".
    await page.getByRole('button', { name: 'default/proj/f-active' }).first().waitFor();
    assert.doesNotMatch(await bodyText(page), /Loading the feature inventory/);
  });
});

test('a POST issued BY THE PAGE is refused 405 with Allow: GET, HEAD — there is no route to mutate', { skip }, async () => {
  await withUi('/#/operations', async (page) => {
    await page.getByRole('button', { name: 'default/proj/f-active' }).first().waitFor();
    const probes = await page.evaluate(async () => {
      const out = [];
      for (const [method, path] of [
        ['POST', '/api/features'],
        ['POST', '/api/feature?org=default&project=proj&name=f-active'],
        ['PUT', '/api/health'],
        ['DELETE', '/api/artifact?org=default&project=proj&name=f-visual&path=plan.md'],
        ['PATCH', '/'],
      ]) {
        const r = await fetch(path, { method, body: method === 'DELETE' ? undefined : '{}' });
        out.push({ method, path, status: r.status, allow: r.headers.get('allow') });
      }
      return out;
    });
    for (const p of probes) {
      assert.equal(p.status, 405, `${p.method} ${p.path} answered ${p.status}`);
      assert.equal(p.allow, 'GET, HEAD', `${p.method} ${p.path} advertised Allow: ${p.allow}`);
    }
  });
});
