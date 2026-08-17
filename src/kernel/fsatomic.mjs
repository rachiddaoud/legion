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
import { readFileSync, writeFileSync, renameSync, unlinkSync, mkdirSync, rmSync, statSync } from 'node:fs';
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

/** Run `fn` while holding an exclusive lock on `path` (a sibling `<path>.lock` directory —
 * mkdir is atomic-exclusive on every filesystem we run on, and needs no O_EXCL file handle to
 * leak). writeAtomic protects readers from TORN content; this protects read-modify-write
 * cycles from LOST UPDATES, which rename atomicity cannot: two writers that both read revision
 * N would both write N+1 and one of them silently vanishes. Only the writers with genuinely
 * concurrent callers take it (review receipts: N reviewer lenses stop, and therefore mint, at
 * the same moment) — every other kernel writer keeps the historical no-lock posture, because a
 * blanket lock would be a claim of a concurrency guarantee the CLI as a whole does not make.
 *
 * OWNERSHIP AND STALE REAPING. The lock dir carries an `owner` token (pid + nonce). A lock
 * older than `staleMs` is presumed abandoned (a holder that died between mkdir and the
 * finally) and reaped — by RENAME-then-remove, so exactly one reaper wins and a fresh lock a
 * new holder just took is never half-deleted; the reaper re-stats immediately before the
 * rename and aborts unless the lock is STILL stale, which closes the decided-stale-long-ago
 * race. Release removes the lock only while the token is still OURS: a holder that was reaped
 * mid-`fn` must not delete its reaper's successor lock (it says so on stderr instead).
 * RESIDUAL, stated: a LIVE holder suspended past `staleMs` (laptop sleep, stopped debugger) is
 * reaped as dead, and its in-flight write can still clobber the reaper's — the token stops the
 * lock-file theft, not the suspended writer. `staleMs` is that liveness/safety trade-off; the
 * ordinary holds here are milliseconds. A SECOND residual, of the same shape: the release check
 * is read-then-remove on a path, so a holder that stalls past `staleMs`, reads its own token,
 * and only then loses the race to a reaper can still remove the successor's lock — the window
 * is one syscall wide and, like the clobbering write above, needs a hold suspended past
 * `staleMs` to open at all.
 * Retry budget: retries*delayMs stays ABOVE staleMs by default, so a waiter outlives any hold
 * it is allowed to see refused — and EVERY contended path pays that sleep and counts against
 * the cap. Only a rename that actually moved the lock aside skips them (there is nothing left
 * to wait for); a reap that cannot succeed is a wait, not a fast path, or the loop busy-spins
 * without end. */
export function withLock(path, fn, { retries = 240, delayMs = 50, staleMs = 10_000 } = {}) {
  const lock = `${path}.lock`;
  const token = `${process.pid}:${Math.random().toString(36).slice(2)}`;
  const ownerPath = join(lock, 'owner');
  const ownerNow = () => { try { return readFileSync(ownerPath, 'utf8'); } catch { return null; } };
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(lock);
      writeFileSync(ownerPath, token);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        throw new Error(`cannot take lock ${lock}: ${e.message}`, { cause: e });
      }
      let age;
      // A throwing stat (lock vanished between mkdir and here, or the path is not a real dir —
      // e.g. a dangling symlink) counts as an ORDINARY contended attempt: it must reach the cap
      // and the sleep below, never short-circuit them — an uncapped fast path here busy-spins.
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { age = 0; }
      if (age > staleMs) {
        // Re-stat, then reap by rename: the rename is atomic, so of N waiters that all decided
        // "stale", exactly one moves the dir aside — and a FRESH lock (new mtime) aborts the
        // reap for every waiter still holding yesterday's decision.
        let still;
        try { still = Date.now() - statSync(lock).mtimeMs; } catch { still = 0; }
        if (still > staleMs) {
          const trash = `${lock}.reaped-${process.pid}-${Math.random().toString(36).slice(2)}`;
          let reaped = false;
          try {
            renameSync(lock, trash);
            reaped = true; // the lock is GONE from its path: recontend at once, no sleep to pay
            process.stderr.write(`removing stale lock ${lock} (held ~${Math.round(still)}ms > ${staleMs}ms — a previous holder died)\n`);
            rmSync(trash, { recursive: true, force: true });
          } catch { /* a racing reaper won the rename, or it CANNOT succeed here at all */ }
          if (reaped) continue;
        }
        // NOT reaped — the lock turned out fresh, a racing reaper won, or the rename can never
        // succeed (an immutable flag, a read-only parent, EBUSY on a mount point). That is an
        // ORDINARY contended attempt and must fall through to the cap and the sleep below:
        // short-circuiting here spins at 100% CPU forever on a rename that always throws, and
        // silently — the stderr line above is written only when the rename WORKS.
      }
      if (attempt >= retries) {
        throw new Error(
          `could not take lock ${lock} after ${retries} attempts (~${retries * delayMs}ms) — ` +
          `another process holds it; if no legion process is alive, remove that directory by hand`,
        );
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs); // sync sleep, no busy-wait
    }
  }
  try { return fn(); }
  finally {
    if (ownerNow() === token) {
      try { rmSync(lock, { recursive: true, force: true }); } catch { /* vanished under us — nothing to release */ }
    } else {
      // We were reaped as stale while running; the lock now belongs to a successor. Removing it
      // would admit a THIRD writer beside them — leave it, and say what happened.
      process.stderr.write(`lock ${lock} was reaped while held (this process stalled past ${staleMs}ms); not releasing a successor's lock\n`);
    }
  }
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
