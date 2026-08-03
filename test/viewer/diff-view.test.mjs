// diff-view.test.mjs — the pure diff presentation helpers. No DOM, no browser, no viewer deps, so
// this file never skips: lib/diff-view.mjs imports nothing.
//
// PORTED FROM legion2's test/viewer/diff-view.test.mjs. `parsePatch` is unchanged and its
// assertions carry over verbatim, because a unified diff did not change. The rest is REPOINTED at
// legion3's server shape: legion2's engine returned per-file `{additions, deletions, binary,
// truncated}`, and legion3's `/api/diff` returns what git printed — a `--name-status` list plus one
// raw `git diff` body (src/cli/_viewer/server.mjs).
//
// THE TRUNCATION CONTRACT IS THE POINT OF THE NEW CASES. legion2 clipped server-side and shipped a
// flag; legion3's server clips nothing, so the render cap moved to the client and MUST still say so.
// A diff shown in part that reads like a diff shown in whole is the defect, wherever the clipping
// happens — so `clipRows` reports shown/total and `clipNote` names the file to open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PATCH_ROWS, clipNote, clipRows, diffSummary, fileStatus, parsePatch,
} from '../../viewer/src/lib/diff-view.mjs';

const PATCH = `diff --git a/x.css b/x.css
index 1..2 100644
--- a/x.css
+++ b/x.css
@@ -1,4 +1,4 @@
 :root {
-  --gap: 8px;
+  --gap: 12px;
   --radius: 6px;
 }`;

test('parsePatch: hunk + context/add/del rows with correct old/new line numbers; metadata dropped', () => {
  const rows = parsePatch(PATCH);
  assert.equal(rows.filter((r) => r.text.startsWith('diff --git')).length, 0, 'file headers are not render rows');
  assert.deepEqual(rows.map((r) => r.kind), ['hunk', 'context', 'del', 'add', 'context', 'context']);
  const del = rows.find((r) => r.kind === 'del');
  const add = rows.find((r) => r.kind === 'add');
  assert.equal(del.oldNo, 2); assert.equal(del.newNo, null); assert.equal(del.text, '  --gap: 8px;');
  assert.equal(add.newNo, 2); assert.equal(add.oldNo, null); assert.equal(add.text, '  --gap: 12px;');
  const lastCtx = rows.filter((r) => r.kind === 'context').at(-1);
  assert.equal(lastCtx.oldNo, 4); assert.equal(lastCtx.newNo, 4);
});

test('parsePatch tolerates empty/undefined and "\\ No newline" meta', () => {
  assert.deepEqual(parsePatch(''), []);
  assert.deepEqual(parsePatch(undefined), []);
  const rows = parsePatch('@@ -1 +1 @@\n-old\n+new\n\\ No newline at end of file');
  assert.equal(rows.at(-1).kind, 'meta');
});

// THE PARSER IS PER-FILE, AND THIS PINS WHY THE CLIENT ASKS PER FILE. `git diff <range>` with no
// pathspec concatenates file sections, and the ported parser only skips header lines BEFORE the
// first `@@` — after that, a following section's `--- a/y.ts` / `+++ b/y.ts` read as a deletion and
// an addition. legion2 never hit this because its engine handed the client a structured per-file
// array. legion3's Changes tab therefore renders ONLY `/api/diff?...&file=<one file>` bodies, and
// uses the file-less response for the name-status list alone. This test is the guard on that: if
// someone ever feeds a whole-range body to parsePatch, the count below changes and they find out
// here rather than in a diff pane that quietly grew two phantom lines per file.
test('parsePatch is a PER-FILE parser — a concatenated multi-file body misreads the next header', () => {
  const two = `${PATCH}\ndiff --git a/y.ts b/y.ts\nindex 3..4 100644\n--- a/y.ts\n+++ b/y.ts\n@@ -10,2 +10,3 @@\n const a = 1;\n+const b = 2;`;
  const rows = parsePatch(two);
  const phantoms = rows.filter((r) => r.text === '-- a/y.ts' || r.text === '++ b/y.ts');
  assert.equal(phantoms.length, 2, 'the second section headers are misparsed — this is the documented limitation');

  // A single file section — what the client actually fetches — is clean: the leading `diff --git`,
  // `index`, `---` and `+++` lines all precede the first `@@` and are dropped.
  const one = parsePatch(`diff --git a/y.ts b/y.ts\nindex 3..4 100644\n--- a/y.ts\n+++ b/y.ts\n@@ -10,2 +10,3 @@\n const a = 1;\n+const b = 2;`);
  assert.deepEqual(one.map((r) => r.kind), ['hunk', 'context', 'add']);
  assert.equal(one.at(-1).newNo, 11);
});

test('clipRows caps rendering and REPORTS the cap — a clipped patch never reads as a whole one', () => {
  const rows = parsePatch(`@@ -1,300 +1,300 @@\n${Array.from({ length: 300 }, (_, i) => ` line ${i}`).join('\n')}`);
  assert.equal(rows.length, 301, '300 context lines plus the hunk header row');

  const whole = clipRows(rows, 4000);
  assert.equal(whole.clipped, false);
  assert.equal(whole.shown, 301);
  assert.equal(whole.total, 301);
  assert.equal(clipNote(whole, 'src/big.tsx'), null, 'no banner when nothing was clipped');

  const clipped = clipRows(rows, 50);
  assert.equal(clipped.rows.length, 50);
  assert.equal(clipped.clipped, true);
  assert.equal(clipped.shown, 50);
  assert.equal(clipped.total, 301, 'the TOTAL survives the clip — that is what makes the banner honest');
  const note = clipNote(clipped, 'src/big.tsx');
  assert.match(note, /Showing the first 50 of 301 lines/);
  assert.match(note, /open src\/big\.tsx in the worktree/);
});

test('clipRows is total on junk input and defaults to the named cap', () => {
  assert.deepEqual(clipRows(undefined), { rows: [], shown: 0, total: 0, clipped: false });
  assert.deepEqual(clipRows([], NaN).rows, []);
  assert.equal(typeof MAX_PATCH_ROWS, 'number');
  assert.ok(MAX_PATCH_ROWS > 0);
});

test('fileStatus renders git letters, and renders an UNRECOGNISED one as itself', () => {
  assert.deepEqual(fileStatus('M'), { code: 'M', label: 'modified', cls: 'modified' });
  assert.deepEqual(fileStatus('A'), { code: 'A', label: 'added', cls: 'added' });
  assert.deepEqual(fileStatus('D'), { code: 'D', label: 'deleted', cls: 'deleted' });
  assert.deepEqual(fileStatus('R100'), { code: 'R100', label: 'renamed', cls: 'renamed' });
  // The honesty case: a letter this table does not know keeps its own text and a neutral class —
  // it is NEVER coerced into 'modified', which is the guess H02 forbids.
  const weird = fileStatus('Z9');
  assert.equal(weird.code, 'Z9');
  assert.equal(weird.cls, 'unknown');
  assert.match(weird.label, /unrecognised/);
  assert.equal(fileStatus(undefined).code, '?');
});

test('diffSummary counts files and never invents ± totals (the server sends none)', () => {
  assert.equal(diffSummary({ files: [{ status: 'M', path: 'a' }] }), '1 file changed');
  assert.equal(diffSummary({ files: [] }), '0 files changed');
  const ranged = diffSummary({
    files: [{ status: 'M', path: 'a' }, { status: 'A', path: 'b' }],
    baseSha: '1a2b3c4d5e6f7081', head: '9c1f2ab3d4e5f607',
  });
  assert.equal(ranged, '2 files changed in 1a2b3c4d..9c1f2ab3');
  assert.ok(!/\+\d/.test(ranged), 'no addition count is fabricated');
  assert.equal(diffSummary(undefined), '0 files changed');
});
