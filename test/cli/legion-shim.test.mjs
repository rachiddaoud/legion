// Guards the T15a install slice (R19): bin/legion is a committed, executable, POSIX shim
// that execs `node bin/legion.mjs "$@"`, resolving its own symlink chain so both install
// routes work — `npm link` (a symlink onto PATH) and `export PATH=".../bin:$PATH"` (run in
// place). Hermetic: the shim is invoked by ABSOLUTE path (no assumption that `legion` is on
// PATH); the spawn env pins PATH to the running node's own directory plus the POSIX system
// dirs the shim's tools (dirname/readlink) live in, so `node` inside the shim resolves to
// THIS suite's node and never to whatever the developer's shell happens to prefer; LEGION_HOME
// points at a temp dir — never the real ~/.legion. No network.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const SHIM = join(ROOT, 'bin', 'legion');

let TMP;
before(() => { TMP = mkdtempSync(join(tmpdir(), 'legion3-shim-')); });
after(() => { rmSync(TMP, { recursive: true, force: true }); });

const run = (bin, ...args) => spawnSync(bin, args, {
  encoding: 'utf8',
  env: {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    LEGION_HOME: join(TMP, 'home'), // never the real ~/.legion
  },
});

test('bin/legion exists and is executable', () => {
  const st = statSync(SHIM);
  assert.ok(st.isFile(), 'bin/legion must be a regular file');
  assert.ok((st.mode & 0o111) !== 0, 'bin/legion must carry an execute bit');
});

test('no args: exits non-zero and prints the router usage', () => {
  const r = run(SHIM);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: legion <command>/);
  assert.match(r.stderr, /available commands:/);
  assert.match(r.stderr, /^ {2}legion doctor$/m, 'the real command list must appear');
});

test('unknown command: exits non-zero naming the command', () => {
  const r = run(SHIM, 'not-a-command');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /unknown command 'not-a-command'/);
});

test('behaves exactly like node bin/legion.mjs on the same argv', () => {
  const viaShim = run(SHIM, 'not-a-command');
  const viaNode = run(process.execPath, join(ROOT, 'bin', 'legion.mjs'), 'not-a-command');
  assert.equal(viaShim.status, viaNode.status);
  assert.equal(viaShim.stderr, viaNode.stderr);
  assert.equal(viaShim.stdout, viaNode.stdout);
});

test('the npm-link route: invoked through a symlink, the shim still finds the router', () => {
  // npm link puts `<prefix>/bin/legion -> <repo>/bin/legion` on PATH; the shim must resolve
  // the link to find legion.mjs beside the REAL file, not beside the symlink.
  const linked = join(TMP, 'legion');
  symlinkSync(SHIM, linked);
  const r = run(linked);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /usage: legion <command>/);
  assert.match(r.stderr, /^ {2}legion doctor$/m);
});
