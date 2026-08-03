// AUDIT of the git seam (kernel/git.mjs header E) — the test that closes the CLASS rather
// than the individual call sites. Three consecutive review rounds each pinned exactly the
// calls the previous round named and each left a new unhardened batch behind; this file
// makes the next one break the suite the moment it is typed, not two reviews later.
//
// WHAT IT ENFORCES
//   (a) the EXPORT SET of kernel/git.mjs — in particular that the raw spawn primitive stays
//       module-private, since re-exporting it restores the exact affordance T7c removed;
//   (b) every gitUserRepo() call site in src/ matches the explicit allowlist below (the
//       three genuinely mutating calls), and every allowlist entry still matches something
//       — a stale entry is a failure too, so the allowlist cannot rot silently;
//   (c) nothing in src/ spawns `git` behind the kernel's back via child_process;
//   (d) the scan actually walked files (a broken path must not pass by finding nothing).
//
// WHAT IT CANNOT SEE — stated plainly rather than implying a guarantee it does not provide.
// This block is the artifact reviewers are told to trust, so an UNDISCLOSED false negative is
// worse than a disclosed limit. Two disclosed ones were CLOSED in T7d rather than merely
// listed: a MULTI-LINE `gitUserRepo(` call (the scans now run over the file's text with
// comment lines blanked, so a call and its argv may straddle line breaks and the reported
// line number is still exact), and a `--porcelain` copy written with double quotes or a
// template literal (the drift guard matched a single-quoted literal only).
// A third is now COMPENSATED rather than merely listed: src/ contains a GENERIC process seam
// (kernel/runner.mjs, for `glab`/`claude`), i.e. `run(file, args)` with `file` computed at
// runtime — the "git spawned from a VARIABLE command" blind spot, present in src/ by design.
// The scans below cannot see it, so the seam REFUSES `file === 'git'` at runtime and the test
// at the bottom of this file exercises that refusal; kernel/runner.mjs is the only such seam,
// and a second one would have to carry the same control.
// The honest remainder, all of it a SOURCE SCAN's blind spot: an aliased import
// (`import { gitUserRepo as g }`), a dynamic `await import(...)`, a computed callee
// (`mod['gitUser' + 'Repo'](...)`), git spawned from a VARIABLE command anywhere OTHER than
// that one refusing seam (`const c = 'git'; spawnSync(c, …)`), a status argv assembled from
// fragments or variables that never spells '--porcelain' literally, and anything outside src/.
// A tripwire, not a proof of hardening.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as gitmod from '../../src/kernel/git.mjs';
import { runCapture } from '../../src/kernel/runner.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SRC = join(ROOT, 'src');
const GIT_MODULE = 'src/kernel/git.mjs'; // defines the helper — exempt from the call scans

/** Every .mjs under src/, as {rel, lines}. Repo-relative paths so failures name the file
 * the way a reviewer would type it. */
function sourceFiles() {
  return readdirSync(SRC, { recursive: true })
    .filter((p) => typeof p === 'string' && p.endsWith('.mjs'))
    .map((p) => join(SRC, p))
    .map((abs) => ({ rel: relative(ROOT, abs).replaceAll('\\', '/'), lines: readFileSync(abs, 'utf8').split('\n') }));
}

/** Comment lines are not call sites; skipping them keeps the header prose (which NAMES the
 * opt-out on purpose) from tripping the scan. */
const isComment = (line) => {
  const t = line.trim();
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*');
};

/** The file as ONE searchable string with comment lines BLANKED — blanked, not dropped, so
 * `lineAt()` still reports the real line number. Scanning text rather than lines is what
 * catches a call whose argv wraps onto the following line (a disclosed false negative until
 * T7d): `gitUserRepo(\n  ['worktree', 'add', …]` is one match here and was none before. */
const scanText = ({ lines }) => lines.map((l) => (isComment(l) ? '' : l)).join('\n');
const lineAt = (text, offset) => text.slice(0, offset).split('\n').length;
/** A match plus the ~200 chars after it, whitespace-collapsed: the window an allowlist argv
 * signature is checked against, and the excerpt a failure prints. */
const snippet = (text, offset) => text.slice(offset, offset + 200).replace(/\s+/g, ' ').trim();

// THE ALLOWLIST: the only calls in the tree that may reach the user's ambient git config.
// Anchored by file + an argv signature, never by line number (a line number rots on the
// first edit above it). Each entry states WHY the mutation legitimately runs under the
// user's config — that reason is the thing a reviewer checks.
const ALLOWED_USER_REPO_CALLS = [
  { file: 'src/cli/feature.mjs', argv: "'worktree', 'add'", why: "creates the feature worktree in the user's repo (hooks, worktree settings apply)" },
  { file: 'src/cli/feature.mjs', argv: "'worktree', 'remove'", why: 'removes that worktree again on abandon' },
  { file: 'src/cli/feature.mjs', argv: "'branch', '-D'", why: 'deletes feat/<name> so the feature name is reusable' },
  { file: 'src/cli/finalize.mjs', argv: "'push', '--set-upstream'", why: "THE one remote write; needs the operator's credential helper / url.insteadOf, which hardened config (GIT_CONFIG_GLOBAL=/dev/null) removes — repo/index redirection is still stripped" },
];

test('kernel/git.mjs exports exactly the seam surface — the raw primitive stays private', () => {
  assert.deepEqual(Object.keys(gitmod).sort(), [
    'GIT_PIN_ARGS',
    'GIT_REDIRECT_VARS',
    'STATUS_ARGV',
    'applyHardenedGitEnv',
    'git',
    'gitTry',
    'gitUserRepo',
    'hardenedGitEnv',
    'isWorktreeClean',
    'mainWorktreeRoot',
    'worktreeDirt',
    'worktreeTreeHash',
  ], 'exporting an unhardened spawn helper re-opens the affordance T7c removed; ' +
     'adding a new export means updating this list DELIBERATELY');
});

test('every gitUserRepo() call site in src/ is on the allowlist, and every entry is live', () => {
  const files = sourceFiles();
  const hits = [];
  for (const f of files) {
    if (f.rel === GIT_MODULE) continue;
    const text = scanText(f);
    for (const m of text.matchAll(/\bgitUserRepo\s*\(/g)) {
      hits.push({ rel: f.rel, line: lineAt(text, m.index), text: snippet(text, m.index) });
    }
  }
  const matched = new Array(ALLOWED_USER_REPO_CALLS.length).fill(0);
  for (const h of hits) {
    const idx = ALLOWED_USER_REPO_CALLS.findIndex((a) => a.file === h.rel && h.text.includes(a.argv));
    assert.notEqual(idx, -1,
      `unallowlisted gitUserRepo() at ${h.rel}:${h.line}\n  ${h.text}\n` +
      `a MUTATION? add it to ALLOWED_USER_REPO_CALLS in this file with a reason. ` +
      `a READ? use git()/gitTry() — reads are evidence and must be hardened.`);
    matched[idx] += 1;
  }
  ALLOWED_USER_REPO_CALLS.forEach((a, i) => {
    assert.equal(matched[i], 1,
      `allowlist entry {${a.file}, ${a.argv}} matched ${matched[i]} call sites, expected exactly 1 — ` +
      `a stale entry silently widens the allowlist; delete it or fix the anchor.`);
  });
});

test('nothing in src/ spawns git behind the kernel — kernel/git.mjs is the only door', () => {
  // Text-scanned like the call scan above, so `spawnSync(\n  'git', …)` cannot slip past a
  // per-line regex. Still literal-only: a command held in a variable is invisible (header).
  const BYPASS = /\b(spawnSync|spawn|execSync|exec|execFileSync|execFile)\s*\(\s*['"`]git['"`]/g;
  for (const f of sourceFiles()) {
    if (f.rel === GIT_MODULE) continue;
    const text = scanText(f);
    for (const m of text.matchAll(BYPASS)) {
      assert.fail(
        `${f.rel}:${lineAt(text, m.index)} spawns git directly:\n  ${snippet(text, m.index)}\n` +
        `route it through kernel/git.mjs — a private spawn inherits the config and GIT_* env ` +
        `the seam exists to neutralise.`);
    }
  }
});

test('the ONE dirty-check argv: no module re-types a --porcelain status list', () => {
  // 5a drift guard. Three hand-copied status argvs existed and had already diverged
  // (feature.mjs's lacked =v1, --ignored=no and --no-renames); STATUS_ARGV is now the only
  // definition, so a literal '--porcelain' anywhere else in src/ is a new copy. ANY quoting
  // counts: matching only the single-quoted spelling was a disclosed false negative, and a
  // copy written with double quotes or in a template literal is the same drift.
  for (const f of sourceFiles()) {
    if (f.rel === GIT_MODULE) continue;
    const text = scanText(f);
    for (const m of text.matchAll(/['"`]--porcelain/g)) {
      assert.fail(
        `${f.rel}:${lineAt(text, m.index)} re-types a status argv:\n  ${snippet(text, m.index)}\n` +
        `import STATUS_ARGV from kernel/git.mjs instead — and note it is a REPORT, not the ` +
        `dirty VERDICT (worktreeDirt derives that; kernel/git.mjs header F).`);
    }
  }
});

test('the generic process seam refuses git AT RUNTIME — the compensating control for the one in-src blind spot', () => {
  // kernel/runner.mjs spawns `file` computed at runtime, which every scan above is blind to.
  // The control is not a scan and therefore lives here as an execution: pass it 'git' and it
  // must throw rather than spawn. Deeper coverage of the seam is test/kernel/runner.test.mjs;
  // this assertion exists in THIS file because this file is what a reviewer reads to decide
  // whether git can escape the kernel.
  assert.throws(() => runCapture('git', ['--version']), /must never spawn git/,
    'a generic runner that accepts "git" reopens the class this whole file closes');
});

test('the scan really walked the tree (a broken path must fail, not silently pass)', () => {
  const files = sourceFiles();
  assert.ok(files.length >= 5, `expected >= 5 .mjs files under src/, found ${files.length}`);
  assert.ok(files.some((f) => f.rel === 'src/cli/feature.mjs'), 'src/cli/feature.mjs must be in the scan set');
  assert.ok(files.some((f) => f.rel === GIT_MODULE), 'src/kernel/git.mjs must be in the scan set (it is skipped by name, not missed)');
});
