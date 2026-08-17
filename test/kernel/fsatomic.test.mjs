// Guards fsatomic invariants: atomic replace leaves no temp siblings, JSON roundtrips
// carry schemaVersion untouched (passthrough — no strip/inject/validate at this layer),
// and readJson dies loudly naming the path on missing OR corrupt files (never a default).
// Hermetic: everything under a mkdtemp sandbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, writeJson, readJson, withLock } from '../../src/kernel/fsatomic.mjs';

let DIR;
before(() => { DIR = mkdtempSync(join(tmpdir(), 'legion3-fsatomic-')); });
after(() => { rmSync(DIR, { recursive: true, force: true }); });

test('writeAtomic writes exact content and leaves no .tmp-* sibling', () => {
  const p = join(DIR, 'a.txt');
  writeAtomic(p, 'exact content\n');
  assert.equal(readFileSync(p, 'utf8'), 'exact content\n');
  assert.deepEqual(readdirSync(DIR).filter((f) => f.startsWith('.tmp-')), []);
});

test('writeAtomic over an existing file replaces content', () => {
  const p = join(DIR, 'b.txt');
  writeAtomic(p, 'first');
  writeAtomic(p, 'second');
  assert.equal(readFileSync(p, 'utf8'), 'second');
  assert.deepEqual(readdirSync(DIR).filter((f) => f.startsWith('.tmp-')), []);
});

test('writeJson/readJson roundtrip preserves schemaVersion and all fields', () => {
  const p = join(DIR, 'feature.json');
  const obj = { schemaVersion: 3, name: 'f1', nested: { stage: 'intake', n: [1, 2] } };
  writeJson(p, obj);
  assert.deepEqual(readJson(p), obj);
  const raw = readFileSync(p, 'utf8');
  assert.ok(raw.endsWith('\n'), 'file must end with a newline');
  assert.equal(raw, JSON.stringify(obj, null, 2) + '\n', 'must be 2-space pretty-printed');
});

test('readJson on a missing path throws naming the path with machine-readable code + cause', () => {
  const p = join(DIR, 'nope', 'missing.json');
  assert.throws(() => readJson(p), (e) =>
    e instanceof Error
    && e.message.includes(p)
    && e.code === 'ENOENT'
    && e.cause?.code === 'ENOENT');
});

test('readJson on invalid JSON throws loudly naming the path with the SyntaxError as cause', () => {
  const p = join(DIR, 'corrupt.json');
  writeFileSync(p, '{ not json !');
  assert.throws(() => readJson(p), (e) =>
    e instanceof Error && e.message.includes(p) && e.cause instanceof SyntaxError);
});

// Failure path: the thrown error must name the TARGET (the caller's manifest), never the
// opaque .tmp-* name, and the temp file must be unlinked (best-effort) so failed writes
// leave no litter behind.
test('writeAtomic into a missing parent dir throws naming the target, code+cause set, no temp litter', () => {
  const p = join(DIR, 'no-such-dir', 'x.json');
  assert.throws(() => writeAtomic(p, 'data'), (e) =>
    e instanceof Error
    && e.message.includes(p)
    && e.code === 'ENOENT'
    && e.cause instanceof Error);
  assert.deepEqual(readdirSync(DIR).filter((f) => f.startsWith('.tmp-')), [], 'no temp litter');
});

// --- withLock: lost-update protection for the writers with genuinely concurrent callers ----

test('withLock holds the .lock dir during fn, releases after, and passes the return through', () => {
  const p = join(DIR, 'locked.json');
  let sawLock = false;
  const out = withLock(p, () => { sawLock = existsSync(`${p}.lock`); return 'ret'; });
  assert.equal(out, 'ret');
  assert.equal(sawLock, true, 'the lock is held during fn');
  assert.equal(existsSync(`${p}.lock`), false, 'released after');
});

test('withLock releases on a throwing fn and rethrows it', () => {
  const p = join(DIR, 'locked-throw.json');
  assert.throws(() => withLock(p, () => { throw new Error('inner'); }), /inner/);
  assert.equal(existsSync(`${p}.lock`), false);
});

test('a HELD lock makes withLock retry, then refuse loudly naming the lock dir', () => {
  const p = join(DIR, 'held.json');
  mkdirSync(`${p}.lock`);
  assert.throws(() => withLock(p, () => 'never', { retries: 2, delayMs: 5 }), (e) =>
    e instanceof Error && e.message.includes(`${p}.lock`) && /remove that directory by hand/.test(e.message));
  assert.equal(existsSync(`${p}.lock`), true, 'a refusal does not steal the holder\'s lock');
  rmSync(`${p}.lock`, { recursive: true, force: true });
});

test('a STALE lock (older than staleMs) is reaped and the caller proceeds', () => {
  const p = join(DIR, 'stale.json');
  mkdirSync(`${p}.lock`);
  const old = (Date.now() - 60_000) / 1000; // an mtime a dead holder left a minute ago
  utimesSync(`${p}.lock`, old, old);
  const out = withLock(p, () => 'went through', { retries: 1, delayMs: 5, staleMs: 10_000 });
  assert.equal(out, 'went through');
  assert.equal(existsSync(`${p}.lock`), false);
  assert.deepEqual(readdirSync(DIR).filter((f) => f.includes('.lock.reaped-')), [], 'the reaped dir is removed, not left as litter');
});

test('a lock path that EEXISTs but cannot be statted (dangling symlink) hits the retry cap — never a busy-spin', () => {
  const p = join(DIR, 'symlinked.json');
  symlinkSync(join(DIR, 'no-such-target'), `${p}.lock`);
  const t0 = Date.now();
  assert.throws(() => withLock(p, () => 'never', { retries: 3, delayMs: 20 }), /could not take lock/);
  assert.ok(Date.now() - t0 >= 40, 'the capped path must still sleep between attempts');
  rmSync(`${p}.lock`, { force: true });
});

test('a STALE lock whose reap can NEVER succeed hits the retry cap too — never a silent busy-spin', () => {
  // The reap used to `continue` unconditionally, skipping both the cap check and the sleep. When
  // the rename cannot succeed AT ALL — the lock's parent read-only here, an immutable flag or
  // EBUSY on a mount point in the field — that is an endless 100%-CPU spin, and a SILENT one: the
  // stderr line is written only after a rename that worked. A hook masks it with its timeout; a
  // plain `legion state review-record` hangs forever. The lock is stale AND unreapable, which is
  // exactly the crossing of the two conditions.
  const parent = join(DIR, 'ro-parent');
  mkdirSync(parent);
  const p = join(parent, 'unreapable.json');
  mkdirSync(`${p}.lock`);
  const old = (Date.now() - 60_000) / 1000;
  utimesSync(`${p}.lock`, old, old);
  chmodSync(parent, 0o555); // mkdir ⇒ EEXIST, stat ⇒ OK, rename ⇒ EACCES, forever
  try {
    const t0 = Date.now();
    assert.throws(() => withLock(p, () => 'never', { retries: 3, delayMs: 20, staleMs: 10_000 }),
      /could not take lock/);
    const spent = Date.now() - t0;
    assert.ok(spent >= 40, `the unreapable path must sleep between attempts, spent ${spent}ms`);
    assert.ok(spent < 5_000, `it must reach the cap, not spin: spent ${spent}ms`);
  } finally {
    chmodSync(parent, 0o755);
    rmSync(parent, { recursive: true, force: true });
  }
});

test('release checks the OWNER token: a holder reaped mid-fn does not remove its successor\'s lock', () => {
  const p = join(DIR, 'reaped.json');
  const lock = `${p}.lock`;
  const out = withLock(p, () => {
    // Simulate a reaper takeover while fn runs: the successor holds the dir with ITS token.
    writeFileSync(join(lock, 'owner'), 'successor:token');
    return 'ran';
  });
  assert.equal(out, 'ran');
  assert.equal(existsSync(lock), true, 'the successor\'s lock must survive our release');
  assert.equal(readFileSync(join(lock, 'owner'), 'utf8'), 'successor:token');
  rmSync(lock, { recursive: true, force: true });
});

test('writeAtomic rename failure throws naming the target and unlinks the temp file', () => {
  // renaming a FILE onto an existing non-empty DIRECTORY fails (ENOTEMPTY/EISDIR/EEXIST
  // depending on platform) — the write of tmp succeeded, so this exercises the cleanup path.
  const target = join(DIR, 'occupied');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'child.txt'), 'keeps the dir non-empty');
  assert.throws(() => writeAtomic(target, 'data'), (e) =>
    e instanceof Error && e.message.includes(target) && e.cause instanceof Error);
  assert.deepEqual(readdirSync(DIR).filter((f) => f.startsWith('.tmp-')), [], 'temp file must be unlinked');
});
