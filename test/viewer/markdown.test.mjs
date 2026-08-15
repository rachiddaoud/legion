// markdown.test.mjs — the viewer's markdown pipeline, tested at the exact module the component
// uses. PORTED FROM legion2's test/viewer/markdown.test.mjs (its B01 regression) and extended for
// the one legion3 addition: bare relative references survive the sanitizer so
// lib/artifact-url.mjs can rewrite them to /api/artifact.
//
// WHY IT MATTERS HERE. Dossier artifacts (intent.md, specs/*.md, plan.md, review-visual.md) are
// written by MODELS and by the operator's own projects, and the viewer renders them in the same
// origin as the read-only API. There is no mutation endpoint to steal — that is the whole shape of
// this port — but a script running in the viewer's origin can still read every dossier the server
// will serve, so the pipeline must drop raw HTML and refuse javascript:/data: URLs by construction.
//
// AUTO-SKIP, NAMED, NEVER A SILENT GREEN. The module imports `marked`, which lives in
// viewer/node_modules — gitignored and installed on demand. Without it this file reports a NAMED
// skip carrying the command that fixes it, exactly as the kickoff requires of every browser/budget
// test in this directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let renderMarkdown = null;
try { ({ renderMarkdown } = await import('../../viewer/src/lib/markdown.mjs')); }
catch { /* viewer deps absent — every test below reports the named skip */ }
const skip = renderMarkdown ? false : 'viewer build deps are not installed — run `legion viewer-build`';

test('raw HTML never passes through — event-handler injection dies at parse time', { skip }, () => {
  const out = renderMarkdown('hi <img src=x onerror=alert(1)> there');
  assert.ok(!out.includes('<img'), 'inline raw HTML dropped');
  assert.ok(!out.includes('onerror'), 'handler gone');
  assert.ok(out.includes('hi') && out.includes('there'), 'surrounding text kept');

  const block = renderMarkdown('<script>alert(1)</script>\n\n<svg onload=alert(1)></svg>\n\n<iframe src="https://evil"></iframe>');
  assert.ok(!/script|onload|iframe|<svg/i.test(block), 'block raw HTML dropped');
});

test('link protocols are allowlisted — javascript:/data:/protocol-relative become plain text', { skip }, () => {
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('href'), 'javascript: refused');
  assert.ok(!renderMarkdown('[x](data:text/html,<script>alert(1)</script>)').includes('href'), 'data: refused');
  assert.ok(!renderMarkdown('[x](//evil.example/p)').includes('href'), 'protocol-relative refused');
  assert.ok(!renderMarkdown('[x](JaVaScRiPt:alert(1))').includes('href'), 'case tricks refused');
  assert.ok(!renderMarkdown('[x](vbscript:msgbox(1))').includes('href'), 'vbscript: refused');
  const ok = renderMarkdown('[docs](https://example.com/a) and [rel](./spec.md)');
  assert.ok(ok.includes('href="https://example.com/a"'), 'https kept');
  assert.ok(ok.includes('href="./spec.md"'), 'relative kept');
  assert.ok(ok.includes('rel="noopener noreferrer"'), 'external links carry rel');
});

test('images: only http(s)/relative sources; data: URIs and handlers cannot ride through', { skip }, () => {
  assert.ok(!renderMarkdown('![x](data:image/svg+xml,<svg onload=alert(1)/>)').includes('<img'), 'data: image refused');
  assert.ok(renderMarkdown('![shot](https://example.com/s.png)').includes('<img src="https://example.com/s.png"'), 'https image kept');
  const titled = renderMarkdown('![a](https://e.com/i.png "t\\" onerror=\\"x")');
  assert.ok(!titled.includes('onerror="x"'), 'attribute breakout escaped');
});

// THE legion3 ADDITION. `review-visual.md` writes `![home](visual/M1/home@1280.png)` — a BARE
// relative reference, which legion2's two allowlists (both require a scheme, a leading `/` or a
// leading `./`) would have turned into alt text. Dropping it would erase the visual reviewer's
// evidence, so it survives here VERBATIM and lib/artifact-url.mjs decides whether it is servable.
test('bare relative references survive for the /api/artifact rewrite — and only bare ones', { skip }, () => {
  const img = renderMarkdown('![home](visual/M1/home@1280.png)');
  assert.ok(img.includes('<img src="visual/M1/home@1280.png"'), 'a dossier-relative screenshot is kept as written');
  const link = renderMarkdown('[the plan](plan.md)');
  assert.ok(link.includes('href="plan.md"'), 'a dossier-relative document link is kept as written');
  // A scheme is still a scheme, however it is spelled: the relative admission must not become a
  // hole. `mailto:` stays allowed by the ordinary link allowlist; the dangerous schemes stay out.
  assert.ok(!renderMarkdown('[x](javascript:alert(1))').includes('href'), 'still no javascript:');
  assert.ok(!renderMarkdown('![x](javascript:alert(1))').includes('<img'), 'still no javascript: image');
  assert.ok(!renderMarkdown('[x](//evil.example/p)').includes('href'), 'still no protocol-relative');
});

test('malformed and hostile-shaped input renders without crashing and without tags', { skip }, () => {
  for (const s of ['<img "<>', '<<b>>', '<a href="', '<!doctype html><html>', '](', '<![CDATA[<script>]]>', '']) {
    const out = renderMarkdown(s);
    assert.equal(typeof out, 'string');
    assert.ok(!/onerror|<script/i.test(out), `no live vector for ${JSON.stringify(s)}`);
  }
});

test('normal artifacts still render: headings, tables, code, and mermaid fences as code blocks', { skip }, () => {
  const out = renderMarkdown('## Digest\n\n| a |\n|---|\n| b |\n\n```mermaid\ngraph TD; A-->B;\n```\n\n`x < y`');
  assert.ok(out.includes('<h2'), 'heading');
  assert.ok(out.includes('<table>'), 'table');
  assert.ok(out.includes('language-mermaid'), 'mermaid fence preserved for the lazy renderer');
  assert.ok(out.includes('x &lt; y'), 'code content escaped');
});
