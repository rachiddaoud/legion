// Guards fsatomic invariants: atomic replace leaves no temp siblings, JSON roundtrips
// carry schemaVersion untouched (passthrough — no strip/inject/validate at this layer),
// and readJson dies loudly naming the path on missing OR corrupt files (never a default).
// Hermetic: everything under a mkdtemp sandbox.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAtomic, writeJson, readJson } from '../../src/kernel/fsatomic.mjs';

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
