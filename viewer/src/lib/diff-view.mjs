// diff-view.mjs — pure presentation helpers for `/api/diff` (no DOM, node-testable at
// test/viewer/diff-view.test.mjs). Coloring is CSS by row kind — never a syntax highlighter, which
// is what v2 decided and legion3 keeps: it would add a chunk, a theme and a language table to a
// pane whose job is showing what changed.
//
// PORTED, AND RESHAPED WHERE THE SERVER SHAPE DIFFERS. `parsePatch` is legion2's, unchanged — a
// unified diff is a unified diff. What changed is everything AROUND it, because legion2's engine
// (`src/git/diff.mjs`) returned a STRUCTURED per-file object carrying `{additions, deletions,
// binary, truncated, patch}`, and legion3's server returns what git itself printed: a
// `--name-status` file list and one raw `git diff` body (src/cli/_viewer/server.mjs). So:
//
//   - `fileCounts`/`diffSummary` no longer report ± totals. Nothing records them, and counting them
//     here would be arithmetic the client invented about a diff it may only have partially loaded.
//     The file list reports its length and its status letters, which is what git gave us.
//   - THE TRUNCATION CONTRACT MOVED, IT DID NOT DISAPPEAR. legion2 clipped server-side and shipped
//     `truncated: true`; legion3's server clips nothing (it raises maxBuffer instead, gate.mjs's
//     precedent), so an enormous file would be handed to the DOM whole and the tab would hang. The
//     cap therefore lives HERE, at the render, and `clipRows` reports it: a clipped patch says how
//     many of how many rows are shown and names the file to open locally. A truncated diff that
//     renders like a complete one is the defect this contract exists to prevent, wherever the
//     clipping happens.
//
// STATUS LETTERS ARE RENDERED, NEVER GUESSED. `git diff --name-status` emits M/A/D and, with
// renames off (server.mjs pins `--no-renames`), nothing else in practice — but T/U/X and R100/C75
// exist, so an unrecognised letter renders AS the letter with a neutral style instead of being
// coerced into 'modified'.

/**
 * Parse one file's unified-diff patch into render rows. File-header metadata (`diff --git`,
 * `index`, `---`, `+++`) is skipped; hunk headers (`@@`) and +/-/context lines carry old/new line
 * numbers.
 * @param {string} patch
 * @returns {{ kind: 'hunk'|'add'|'del'|'context'|'meta', oldNo: number|null, newNo: number|null, text: string }[]}
 */
export function parsePatch(patch) {
  /** @type {{ kind: 'hunk'|'add'|'del'|'context'|'meta', oldNo: number|null, newNo: number|null, text: string }[]} */
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const line of String(patch || '').split('\n')) {
    const hm = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hm) {
      oldNo = Number(hm[1]);
      newNo = Number(hm[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', oldNo: null, newNo: null, text: line });
      continue;
    }
    if (!inHunk) continue; // file-header metadata — not a render row
    if (line.startsWith('+')) { rows.push({ kind: 'add', oldNo: null, newNo, text: line.slice(1) }); newNo++; }
    else if (line.startsWith('-')) { rows.push({ kind: 'del', oldNo, newNo: null, text: line.slice(1) }); oldNo++; }
    else if (line.startsWith(' ')) { rows.push({ kind: 'context', oldNo, newNo, text: line.slice(1) }); oldNo++; newNo++; }
    else if (line.startsWith('\\')) { rows.push({ kind: 'meta', oldNo: null, newNo: null, text: line }); } // "\ No newline at end of file"
  }
  return rows;
}

/** THE render cap, named. Big enough that no ordinary task diff is ever clipped, small enough that
 * a vendored lockfile cannot put 200k table rows in the DOM. */
export const MAX_PATCH_ROWS = 4000;

/**
 * Clip parsed rows for rendering, reporting the clip so it can never be presented as the whole file.
 * @param {ReturnType<typeof parsePatch>} rows
 * @param {number} cap
 * @returns {{rows: ReturnType<typeof parsePatch>, shown: number, total: number, clipped: boolean}}
 */
export function clipRows(rows, cap = MAX_PATCH_ROWS) {
  const all = Array.isArray(rows) ? rows : [];
  const n = Number.isFinite(cap) && cap >= 0 ? Math.trunc(cap) : MAX_PATCH_ROWS;
  return { rows: all.slice(0, n), shown: Math.min(all.length, n), total: all.length, clipped: all.length > n };
}

/** The banner a clipped patch carries. null when nothing was clipped — a banner that always shows
 * teaches the reader to ignore it. */
export function clipNote(clip, path) {
  if (!clip?.clipped) return null;
  return `Showing the first ${clip.shown} of ${clip.total} lines — open ${path} in the worktree for the rest.`;
}

/** git `--name-status` letter → {code, label, cls}. An unknown letter keeps its own text (header). */
export function fileStatus(status) {
  const code = String(status ?? '').trim();
  const head = code.slice(0, 1).toUpperCase();
  const known = {
    A: ['added', 'added'], M: ['modified', 'modified'], D: ['deleted', 'deleted'],
    R: ['renamed', 'renamed'], C: ['copied', 'renamed'], T: ['type changed', 'modified'],
    U: ['unmerged', 'unknown'], X: ['unknown to git', 'unknown'],
  }[head];
  return known
    ? { code: code || '?', label: known[0], cls: known[1] }
    : { code: code || '?', label: 'unrecognised status', cls: 'unknown' };
}

/** The totals line for a file list. Files only: the server sends no ± counts and this module does
 * not invent them (header). */
export function diffSummary(diff) {
  const files = Array.isArray(diff?.files) ? diff.files : [];
  const range = diff?.baseSha && diff?.head ? ` in ${String(diff.baseSha).slice(0, 8)}..${String(diff.head).slice(0, 8)}` : '';
  return `${files.length} file${files.length === 1 ? '' : 's'} changed${range}`;
}
