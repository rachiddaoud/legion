// budgets.test.mjs — T42(C): the INITIAL LOAD of the built viewer, measured then enforced. Ported
// from legion2's test/viewer/budgets.test.mjs and re-aimed at this bundle.
//
// WHY A BUDGET TEST EXISTS AT ALL. The viewer is a disposable read-only projection of a LOCAL
// legion home, served by a loopback node:http server. Nothing about that forgives a first paint
// that drags in a diagram renderer, a maths typesetter and a graph layout engine: `mermaid` alone
// is ~140KB gzip, `katex` ~77KB and `cytoscape` ~142KB, all of them reachable only from an artifact
// that happens to carry a ```mermaid fence. They belong in lazy chunks, and "belong in lazy chunks"
// is a claim that rots silently — one static `import mermaid from 'mermaid'` at the top of
// Markdown.tsx moves 300KB into the eager path and NOTHING else in this suite notices. So the eager
// path is measured here, in bytes, against numbers a human chose.
//
// THE NUMBERS ARE legion2's, KEPT ON PURPOSE: entry JS <= 160KB gzip, entry CSS <= 30KB gzip. The
// port's shell is smaller than v2's (no SSE client, no intake, no notification machinery) and
// measured 103KB/4KB at T42 — the headroom is deliberate, not slack to be spent: a budget set at
// the current measurement fails on the next honest component and teaches nobody anything.
//
// GZIP, NOT RAW, because gzip is what the operator's browser actually transfers... except that it
// is not: this server sends the bytes uncompressed (loopback, no compression middleware — see
// src/cli/_viewer/server.mjs). The gzip figure is therefore a PROXY FOR COMPRESSIBLE SIZE, i.e. for
// how much code there is, which is the thing the budget is about. Said plainly here so nobody reads
// these numbers as a transfer measurement.
//
// AUTO-SKIP, NAMED. `viewer/dist` is gitignored and built on demand, so a fresh clone has no bundle
// and this file must neither fail (the bundle's absence is the documented state) nor pass silently
// (a green tick over an unmeasured budget is the lie this whole chunk exists to avoid). It SKIPS,
// and the skip line says the exact command that turns it back on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // test/viewer/x -> repo root
const DIST = join(ROOT, 'viewer', 'dist');
const ASSETS = join(DIST, 'assets');

/** The one skip reason this file can have, phrased as the command that fixes it. */
const skip = existsSync(join(DIST, 'index.html'))
  ? false
  : 'viewer/dist is absent (it is gitignored and built on demand) — run `legion viewer-build`';

const ENTRY_JS_BUDGET = 160 * 1024;
const ENTRY_CSS_BUDGET = 30 * 1024;

const gzipOf = (rel) => gzipSync(readFileSync(join(DIST, rel))).length;
const kb = (n) => `${(n / 1024).toFixed(1)}KB`;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** index.html's own references — the EAGER set, by definition: whatever the browser is told to
 * fetch before a single line of application code has run. `modulepreload` counts; a lazy chunk that
 * is preloaded here is not lazy. */
function eagerRefs(html) {
  return [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
}

test('initial-load budget: entry JS <= 160KB gzip, entry CSS <= 30KB gzip', { skip }, () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const refs = eagerRefs(html);
  const js = refs.filter((r) => r.endsWith('.js'));
  const css = refs.filter((r) => r.endsWith('.css'));
  assert.equal(js.length, 1, `expected exactly one eager script, got ${JSON.stringify(js)}`);
  assert.equal(css.length, 1, `expected exactly one eager stylesheet, got ${JSON.stringify(css)}`);

  const jsGz = gzipOf(js[0].replace(/^\.?\//, ''));
  const cssGz = gzipOf(css[0].replace(/^\.?\//, ''));
  assert.ok(jsGz <= ENTRY_JS_BUDGET, `entry JS ${kb(jsGz)} gzip exceeds the ${kb(ENTRY_JS_BUDGET)} budget`);
  assert.ok(cssGz <= ENTRY_CSS_BUDGET, `entry CSS ${kb(cssGz)} gzip exceeds the ${kb(ENTRY_CSS_BUDGET)} budget`);
  // Printed on every run: the budget is a ceiling, and the trend under it is the interesting part.
  console.log(`  budgets: entry JS ${kb(jsGz)} gzip (${jsGz}B), entry CSS ${kb(cssGz)} gzip (${cssGz}B)`);
});

test('mermaid is never in the eager path — it is reached only through a dynamic import', { skip }, () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  const assets = readdirSync(ASSETS);
  const mermaidChunks = assets.filter((a) => /mermaid/i.test(a) && a.endsWith('.js'));
  assert.ok(mermaidChunks.length > 0, 'no mermaid chunk was built — the diagram renderer is missing entirely');

  for (const ref of eagerRefs(html)) {
    assert.ok(!/mermaid/i.test(ref), `index.html eagerly references ${ref} — mermaid must never be preloaded`);
  }

  // …and in the entry chunk every mention of a mermaid chunk must BE a dynamic import or a string
  // in Vite's `__vite__mapDeps` preload TABLE — the filename list Vite emits once the bundle has
  // more than one dynamic-import site (the hljs chunk added the second). The table is data consulted
  // AT dynamic-import time, not a load: nothing fetches from it eagerly, so it does not break the
  // laziness this test defends. A static `from "./mermaid.core-X.js"` still lands outside both
  // allowances and fails the count.
  const entryRel = eagerRefs(html).find((r) => r.endsWith('.js')).replace(/^\.?\//, '');
  const entry = readFileSync(join(DIST, entryRel), 'utf8');
  const mapDeps = (entry.match(/__vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=\[[^\]]*\]/) ?? [''])[0];
  for (const chunk of mermaidChunks) {
    const mentions = entry.split(chunk).length - 1;
    if (mentions === 0) continue; // a chunk mermaid itself pulls in, never named by our code
    const dynamic = entry.split(`import("./${chunk}")`).length - 1;
    const inMap = mapDeps.split(chunk).length - 1;
    assert.equal(dynamic + inMap, mentions,
      `${chunk} is referenced ${mentions}x in the entry chunk but only ${dynamic}x as a dynamic import and ${inMap}x in the preload table`);
  }
});

test('local-first: the eager path references no external origin and bundles its own fonts', { skip }, () => {
  const html = readFileSync(join(DIST, 'index.html'), 'utf8');
  // 1. THE DOCUMENT. Every reference is a relative path into ./assets — no CDN, no font host, no
  //    analytics beacon. This is the strongest of the three checks and the cheapest to keep true.
  for (const ref of eagerRefs(html)) {
    assert.ok(/^\.?\/assets\//.test(ref), `index.html references ${ref}, which is not a bundled asset`);
  }

  const entryRel = eagerRefs(html).find((r) => r.endsWith('.js')).replace(/^\.?\//, '');
  const cssRel = eagerRefs(html).find((r) => r.endsWith('.css')).replace(/^\.?\//, '');

  // 2. THE STYLESHEET. Fonts are the classic accidental origin (`@fontsource` resolves to local
  //    woff2 files; a hand-written @import to fonts.googleapis.com would not). Zero absolute URLs in
  //    the CSS, and the woff2 files really are in dist.
  const css = readFileSync(join(DIST, cssRel), 'utf8');
  const cssOrigins = [...css.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1]);
  assert.deepEqual(cssOrigins, [], `the entry stylesheet names external origins: ${cssOrigins.join(', ')}`);
  assert.ok(readdirSync(ASSETS).some((a) => a.endsWith('.woff2')), 'no woff2 in dist — the fonts are not bundled');
  assert.ok(/url\(\.\/[^)]+\.woff2\)/.test(css), 'the stylesheet does not reference a bundled woff2');

  // 3. THE ENTRY CHUNK. Absolute URLs survive minification as string literals, and only three kinds
  //    are legitimate — none of them is ever FETCHED, which is the property under test:
  //      - XML/SVG/MathML namespace URIs (React and DOMPurify write these into the DOM),
  //      - framework diagnostic links (react.dev/errors, marked's own README link in a throw),
  //      - hosts that appear inside FIXTURE DATA and are rendered as text/href, never requested.
  //    Anything else is a new origin someone added, and the CSP (connect-src 'self') would refuse it
  //    at runtime — which is a blank panel in front of an operator rather than a failing test here.
  const ALLOWED = /^(www\.w3\.org|react\.dev|reactjs\.org|github\.com|gitlab\.example\.com|localhost|127\.0\.0\.1)$/;
  const entry = readFileSync(join(DIST, entryRel), 'utf8');
  const seen = new Set();
  for (const m of entry.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) seen.add(m[1].toLowerCase());
  for (const origin of seen) {
    assert.ok(ALLOWED.test(origin), `unexpected external origin in the entry chunk: ${origin}`);
    assert.ok(!/(cdn|unpkg|jsdelivr|fonts\.|googleapis|gstatic|analytics)/.test(origin),
      `the entry chunk names a delivery/font/analytics host: ${origin}`);
  }
});
