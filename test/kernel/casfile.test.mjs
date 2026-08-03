// Guards the lock+CAS contract of updateJsonCas: version ownership (increments by
// exactly 1 per committed write), null-from-mutator as a byte-identical no-op, loud
// failure on corrupt docs, fail-closed behavior on a held lock (bounded retries, lock
// NEVER stolen), and — the load-bearing one — no lost updates under two real concurrent
// writer processes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { updateJsonCas } from '../../src/kernel/casfile.mjs';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const CASFILE = join(ROOT, 'src', 'kernel', 'casfile.mjs');

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-casfile-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

test('missing file: mutator receives null, created doc lands with version 1', async () => {
  const p = join(TMP, 'a.json');
  let seen = 'unset';
  const out = await updateJsonCas(p, (doc) => { seen = doc; return { items: ['x'] }; });
  assert.equal(seen, null);
  assert.deepEqual(out, { items: ['x'], version: 1 });
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { items: ['x'], version: 1 });
});

test('each committed update increments version by exactly 1', async () => {
  const p = join(TMP, 'b.json');
  await updateJsonCas(p, () => ({ n: 1 }));
  await updateJsonCas(p, (doc) => ({ ...doc, n: doc.n + 1 }));
  const out = await updateJsonCas(p, (doc) => ({ ...doc, n: doc.n + 1 }));
  assert.equal(out.version, 3);
  assert.equal(out.n, 3);
});

test('mutator returning null writes nothing — bytes and version unchanged', async () => {
  const p = join(TMP, 'c.json');
  await updateJsonCas(p, () => ({ n: 1 }));
  const before_ = readFileSync(p, 'utf8');
  const out = await updateJsonCas(p, () => null);
  assert.equal(readFileSync(p, 'utf8'), before_);
  assert.equal(out.version, 1);
});

// The silent-data-destruction guard: any mutator return other than null or a plain
// object (undefined from a forgotten return, an array, a primitive, a class instance)
// would spread into `{version: n+1}` and wipe the document — must throw, doc untouched.
test('mutator returning non-plain-object throws loudly and writes nothing', async () => {
  const p = join(TMP, 'guard.json');
  await updateJsonCas(p, () => ({ projects: ['keep-me'] }));
  const before_ = readFileSync(p, 'utf8');
  for (const bad of [undefined, ['a'], 42, 'doc', true, new Date()]) {
    await assert.rejects(
      () => updateJsonCas(p, () => bad),
      /must return the next doc as a plain object, or null/,
    );
  }
  assert.equal(readFileSync(p, 'utf8'), before_, 'doc must be untouched');
  assert.ok(!existsSync(`${p}.lock`), 'no lock may be left behind');
});

test('corrupt JSON throws naming the path, before any locking', async () => {
  const p = join(TMP, 'corrupt.json');
  writeFileSync(p, '{nope');
  await assert.rejects(() => updateJsonCas(p, () => ({})), new RegExp(`corrupt JSON in .*corrupt\\.json`));
  assert.ok(!existsSync(`${p}.lock`), 'no lock may be left behind');
});

// Valid-JSON wrong-shape docs (array, string, literal null, non-integer version) must
// reject loudly BEFORE any locking — literal null is distinct from ENOENT-null (missing
// file = legitimate first-init; a file CONTAINING null = corruption/hand-edit).
test('valid-JSON wrong-shape documents reject loudly, bytes untouched, no lock left', async () => {
  const cases = ['[1,2]', '"str"', 'null', '{"version":"1"}', '{"version":1.5}', '{"no":"version"}'];
  for (const [i, content] of cases.entries()) {
    const p = join(TMP, `shape-${i}.json`);
    writeFileSync(p, content);
    await assert.rejects(() => updateJsonCas(p, () => ({})), /wrong-shape/);
    assert.equal(readFileSync(p, 'utf8'), content, `bytes untouched for ${content}`);
    assert.ok(!existsSync(`${p}.lock`), `no lock left behind for ${content}`);
  }
});

test('held lock: bounded retries then loud failure naming the lock dir; lock never stolen', async () => {
  const p = join(TMP, 'locked.json');
  writeFileSync(p, JSON.stringify({ version: 1, n: 0 }));
  const lock = `${p}.lock`;
  mkdirSync(lock);
  await assert.rejects(
    () => updateJsonCas(p, (doc) => ({ ...doc, n: doc.n + 1 }), { attempts: 3, baseDelayMs: 1 }),
    (e) => e.message.includes(lock) && /ONLY if no legion process is running/.test(e.message),
  );
  assert.ok(existsSync(lock), 'held lock must never be stolen');
  assert.deepEqual(JSON.parse(readFileSync(p, 'utf8')), { version: 1, n: 0 }, 'doc untouched');
});

// The CAS conflict simulation the task demands: two real writer processes, K updates
// each, real backoff. May take a few seconds under contention on slow CI.
test('two concurrent writer processes lose no updates', { timeout: 60_000 }, async () => {
  const p = join(TMP, 'contended.json');
  const K = 20;
  const worker = join(TMP, 'worker.mjs');
  writeFileSync(worker, `
    import { updateJsonCas } from ${JSON.stringify(CASFILE)};
    const [path, id] = process.argv.slice(2);
    for (let k = 0; k < ${K}; k++) {
      await updateJsonCas(path, (doc) => {
        const d = doc ?? { entries: [], count: 0 };
        return { ...d, entries: [...d.entries, id + ':' + k], count: d.count + 1 };
      }, { attempts: 100, baseDelayMs: 5, maxDelayMs: 60 });
    }
  `);
  const spawnWorker = (id) => new Promise((res, rej) => {
    const c = spawn(process.execPath, [worker, p, id], { stdio: ['ignore', 'inherit', 'inherit'] });
    c.on('error', rej);
    c.on('close', (code) => (code === 0 ? res() : rej(new Error(`worker ${id} exited ${code}`))));
  });
  await Promise.all([spawnWorker('A'), spawnWorker('B')]);
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  assert.equal(doc.version, 2 * K, 'every committed write bumped version exactly once');
  assert.equal(doc.count, 2 * K);
  assert.equal(doc.entries.length, 2 * K);
  for (const id of ['A', 'B']) {
    for (let k = 0; k < K; k++) assert.ok(doc.entries.includes(`${id}:${k}`), `lost update ${id}:${k}`);
  }
  assert.ok(!existsSync(`${p}.lock`), 'lock released after the dust settles');
});
