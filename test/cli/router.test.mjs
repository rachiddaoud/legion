// Guards the bin/legion router contract by spawning REAL node processes against a
// hermetic copy of the bin in a temp tree (fixture commands live in <tmp>/src/cli/ —
// never written into the repo, which would race and pollute it). Invariants under test:
// run(argv) dispatch + numeric exit codes, loud `legion <cmd>:` errors, usage+list on
// missing/unknown, traversal guard rejects BEFORE import, and the real repo bin exits 1
// for unknown commands while listing the implemented ones.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const REAL_BIN = join(ROOT, 'bin', 'legion.mjs');

let TMP, BIN, CANARY;
before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'legion3-router-'));
  mkdirSync(join(TMP, 'bin'));
  mkdirSync(join(TMP, 'src', 'cli'), { recursive: true });
  BIN = join(TMP, 'bin', 'legion.mjs');
  copyFileSync(REAL_BIN, BIN); // router resolves src/cli via import.meta.url ⇒ copy is self-contained
  writeFileSync(join(TMP, 'src', 'cli', 'hello.mjs'),
    `export function run(argv) { process.stdout.write('hello:' + argv.join(',') + '\\n'); }\n`);
  writeFileSync(join(TMP, 'src', 'cli', 'boom.mjs'),
    `export function run() { throw new Error('kaboom'); }\n`);
  writeFileSync(join(TMP, 'src', 'cli', 'threes.mjs'),
    `export function run() { return 3; }\n`);
  writeFileSync(join(TMP, 'src', 'cli', '_shared.mjs'),
    `export const helper = true;\n`); // underscore ⇒ never listed as a command
  // Pass the old suffix/underscore filter but fail CMD_RE — must never be advertised,
  // because dispatch would refuse them (usage and dispatch apply the SAME filter).
  writeFileSync(join(TMP, 'src', 'cli', 'Bad-Case.mjs'), `export function run() {}\n`);
  writeFileSync(join(TMP, 'src', 'cli', 'weird.name.mjs'), `export function run() {}\n`);
  // Traversal canary: if the router ever imported ../evil it would resolve here and drop a file.
  CANARY = join(TMP, 'canary.txt');
  writeFileSync(join(TMP, 'src', 'evil.mjs'),
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(CANARY)}, 'imported'); export function run() {}\n`);
});
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const run = (bin, ...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });

test('known command dispatches with argv.slice(3) and exits 0', () => {
  const r = run(BIN, 'hello', 'a', 'b');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'hello:a,b\n');
});

test('a numeric return from run() becomes the exit code', () => {
  assert.equal(run(BIN, 'threes').status, 3);
});

test('a throwing command dies loudly: legion <cmd>: <message>, exit 1', () => {
  const r = run(BIN, 'boom');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /legion boom: kaboom/);
});

test('no command prints usage with the available list, exit 1', () => {
  const r = run(BIN);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage: legion <command>/);
  assert.match(r.stderr, /legion hello/);
  assert.doesNotMatch(r.stderr, /_shared/, 'underscore modules are never listed');
});

test('usage never advertises an uninvokable command — same CMD_RE filter as dispatch', () => {
  const r = run(BIN);
  assert.equal(r.status, 1);
  for (const listed of ['legion boom', 'legion hello', 'legion threes']) {
    assert.ok(r.stderr.includes(listed), `${listed} must be listed`);
  }
  for (const hidden of ['Bad-Case', 'weird.name', '_shared']) {
    assert.ok(!r.stderr.includes(hidden), `${hidden} must never be advertised`);
  }
});

test('unknown command exits 1 and lists available commands', () => {
  const r = run(BIN, 'nope');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command 'nope'/);
  assert.match(r.stderr, /legion hello/);
});

test('traversal attempt is rejected before any import happens', () => {
  const r = run(BIN, '../evil');
  assert.equal(r.status, 1);
  assert.ok(!existsSync(CANARY), 'evil.mjs must never be imported');
});

test('the real repo bin rejects unknown commands and lists the implemented ones', () => {
  // The probe MUST name something PLAN-V3 never ships: this test asserts a REFUSAL against the
  // real bin, and the router auto-discovers src/cli/*.mjs, so any name on the kernel roadmap
  // turns this red the day it lands (it did, on 'doctor', in T9). 'not-a-command' is not a
  // legal command name candidate and never will be one.
  const r = run(REAL_BIN, 'not-a-command');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown command 'not-a-command'/);
  assert.match(r.stderr, /legion project/);
});
