// casfile.mjs — lock + compare-and-swap JSON updates for shared manifests
// (projects.json is updated safely under this lock by concurrent feature sessions).
// Protocol per attempt: snapshot-read the doc (missing file ⇒ null; corrupt ⇒ throw;
// wrong-shape — non-plain-object or non-integer version — ⇒ throw: silent defaults
// propagate corruption), note its `version` (0 when null), run the
// mutator OUTSIDE the lock; mutator returns the next doc (a plain object), or null
// meaning "no change needed" (nothing written, unchanged doc returned — a true no-op).
// ANY other return (undefined, array, primitive, class instance) throws BEFORE the lock:
// spreading such a value into the commit would silently replace the whole document with
// `{version: n+1}` — a fail-open data-destruction path this primitive must never allow.
// To commit: acquire
// <path>.lock via mkdirSync (mkdir is atomic; EEXIST ⇒ contended), re-read and compare
// `version` to the snapshot — moved ⇒ release + retry; else write {...next, version+1}
// via writeJson (atomic rename) and release. `version` is OWNED here: mutators never set
// it. Retries back off exponentially with jitter, capped at maxDelayMs. After N attempts
// we throw naming path and lock dir. A lock left by a dead process is NEVER stolen
// (fail closed); the operator removes <path>.lock manually ONLY when no legion process is
// running.
import { readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeJson } from './fsatomic.mjs';

function snapshotRead(path) {
  let raw;
  try { raw = readFileSync(path, 'utf8'); }
  catch (e) {
    if (e.code === 'ENOENT') return null;
    throw new Error(`cannot read ${path}: ${e.message}`);
  }
  let doc;
  try { doc = JSON.parse(raw); }
  catch (e) { throw new Error(`corrupt JSON in ${path}: ${e.message}`); }
  // Valid JSON but the wrong shape (including literal `null` — distinct from the
  // legitimate ENOENT-null above) rejects loudly: this file is casfile-owned, so a
  // missing/mangled version means it was corrupted or hand-edited.
  const proto = doc !== null && typeof doc === 'object' ? Object.getPrototypeOf(doc) : undefined;
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `wrong-shape document in ${path}: expected a plain JSON object, got ` +
      `${Array.isArray(doc) ? 'an array' : doc === null ? 'null' : typeof doc}`,
    );
  }
  if (!Number.isInteger(doc.version)) {
    throw new Error(
      `wrong-shape document in ${path}: version must be an integer, got ${JSON.stringify(doc.version)} — ` +
      `this file is casfile-owned; a missing/mangled version means it was corrupted or hand-edited`,
    );
  }
  return doc;
}

export async function updateJsonCas(path, mutator, { attempts = 10, baseDelayMs = 25, maxDelayMs = 250 } = {}) {
  const lockDir = `${path}.lock`;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs);
      await sleep(Math.round(backoff * (0.5 + Math.random())));
    }
    const doc = snapshotRead(path);
    const version = doc?.version ?? 0;
    const next = mutator(doc);
    if (next === null) return doc; // no change needed — no lock, no write
    const proto = typeof next === 'object' && !Array.isArray(next) ? Object.getPrototypeOf(next) : undefined;
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(
        `CAS mutator for ${path} returned ${Array.isArray(next) ? 'an array' : typeof next} — ` +
        `must return the next doc as a plain object, or null for "no change"; ` +
        `committing anything else would destroy the document`,
      );
    }
    try { mkdirSync(lockDir); }
    catch (e) {
      if (e.code === 'EEXIST') continue; // contended — back off and retry
      throw e;
    }
    try {
      const current = snapshotRead(path);
      if ((current?.version ?? 0) !== version) continue; // lost the race — retry on fresh snapshot
      const committed = { ...next, version: version + 1 };
      writeJson(path, committed);
      return committed;
    } finally {
      rmdirSync(lockDir);
    }
  }
  throw new Error(
    `CAS update of ${path} failed after ${attempts} attempts — ${lockDir} is contended or left by a dead process; ` +
    `remove ${lockDir} ONLY if no legion process is running`,
  );
}
