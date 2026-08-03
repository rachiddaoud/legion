// fsatomic.mjs — atomic writes + loud JSON IO for every manifest the kernel owns.
// writeAtomic: temp file in the SAME directory as the target, then rename — same-dir
// rename is atomic on POSIX, so readers never observe partial content. On failure the
// temp file is unlinked (best-effort) and the thrown error names the TARGET path, not
// the opaque temp name. Decision: no fsync before rename — a deliberate durability
// trade; rename atomicity protects readers from torn content, but an OS crash in the
// window may lose the write; manifests are reconstructible and fsync-per-write is not
// worth the cost at this layer.
// writeJson/readJson: schemaVersion (and every other field) passes through UNTOUCHED —
// never stripped, injected, or validated here; schema validation belongs to
// `legion state`. readJson never returns a default: a missing or corrupt file throws an
// Error naming the absolute path (fail closed — silent defaults propagate corruption);
// callers can branch machine-readably on err.code (e.g. ENOENT) and inspect err.cause.
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Write-then-rename so readers never observe partial JSON. Same-directory rename is atomic. */
export function writeAtomic(path, content) {
  const tmp = join(dirname(path), `.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort cleanup — original error wins */ }
    const err = new Error(`atomic write of ${path} failed: ${e.message}`, { cause: e });
    err.code = e.code;
    throw err;
  }
}

export function writeJson(path, obj) {
  writeAtomic(path, JSON.stringify(obj, null, 2) + '\n');
}

export function readJson(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) {
    const err = new Error(`cannot read ${path}: ${e.message}`, { cause: e });
    err.code = e.code; // machine-readable: callers branch on ENOENT etc.
    throw err;
  }
  try { return JSON.parse(raw); }
  catch (e) { throw new Error(`corrupt JSON in ${path}: ${e.message}`, { cause: e }); } // SyntaxError has no .code — none fabricated
}
