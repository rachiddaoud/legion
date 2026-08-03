// Guards the args.mjs contract: --name value pairs, declared bools never consume the
// next token, positionals keep order, and the fail-closed hardening — a valueless
// value-flag THROWS instead of storing undefined (deliberate deviation from legion2).
// T23 adds the opt-in `multi` mode (repeatable flags) and pins BOTH sides of it: what a listed
// name does, and that an unlisted name still last-wins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, requireFlags } from '../../src/kernel/args.mjs';

test('mixed flags, bools, and positionals parse with order preserved', () => {
  const { flags, positional } = parseArgs(
    ['alpha', '--name', 'val', 'beta', '--force', 'gamma', '--count', '3'],
    { bools: ['force'] },
  );
  assert.deepEqual(flags, { name: 'val', force: true, count: '3' });
  assert.deepEqual(positional, ['alpha', 'beta', 'gamma']);
});

test('a bool listed in bools does not consume the following token', () => {
  const { flags, positional } = parseArgs(['--dry-run', 'target'], { bools: ['dry-run'] });
  assert.equal(flags['dry-run'], true);
  assert.deepEqual(positional, ['target']);
});

test('value-taking flag at end of argv throws missing value', () => {
  assert.throws(() => parseArgs(['--base']), /missing value for --base/);
});

test('value-taking flag followed by another --flag throws missing value', () => {
  assert.throws(() => parseArgs(['--base', '--force'], { bools: ['force'] }), /missing value for --base/);
});

test('inline --name=value binds before the missing-value check, so a --leading value is expressible', () => {
  const { flags, positional } = parseArgs(
    ['task-answer', 'T1', '--question=--force: ok?', '--answer=--no-verify is fine here'],
  );
  assert.deepEqual(flags, { question: '--force: ok?', answer: '--no-verify is fine here' });
  assert.deepEqual(positional, ['task-answer', 'T1']);
});

test('inline value splits on the FIRST = only and may be empty', () => {
  assert.deepEqual(parseArgs(['--expr=a=b=c', '--empty=']).flags, { expr: 'a=b=c', empty: '' });
});

test('inline value on a declared bool throws rather than being dropped', () => {
  assert.throws(() => parseArgs(['--force=yes'], { bools: ['force'] }), /--force takes no value/);
});

// --- T23: opt-in repeatable flags (`feature start --add-repo <path>`, repeatable) -------------
// The contract is small and each half is load-bearing: ARGV ORDER is the recorded order (the
// launch line replays it), one occurrence is still an ARRAY, an absent flag leaves NO KEY (which
// is what lets feature.json omit the field), every occurrence is value-checked on its own, and an
// unlisted name is untouched — this is a mode, not a behaviour change.

test('a multi flag collects every occurrence in argv order, both forms, alongside ordinary flags', () => {
  const { flags, positional } = parseArgs(
    ['start', 'f1', '--add-repo', '/a', '--base', 'main', '--add-repo=/b', '--add-repo', '/c'],
    { multi: ['add-repo'] },
  );
  assert.deepEqual(flags, { 'add-repo': ['/a', '/b', '/c'], base: 'main' });
  assert.deepEqual(positional, ['start', 'f1']);
});

test('a single occurrence of a multi flag is still an ARRAY, never a bare string', () => {
  assert.deepEqual(parseArgs(['--add-repo', '/only'], { multi: ['add-repo'] }).flags,
    { 'add-repo': ['/only'] });
  assert.deepEqual(parseArgs(['--add-repo=/only'], { multi: ['add-repo'] }).flags,
    { 'add-repo': ['/only'] });
});

test('a multi flag never passed leaves NO KEY — absence, not an empty array', () => {
  const { flags } = parseArgs(['start', 'f1', '--base', 'main'], { multi: ['add-repo'] });
  assert.equal('add-repo' in flags, false, 'an empty array would be a value the caller must then unwrite');
  assert.deepEqual(flags, { base: 'main' });
});

test('each occurrence of a multi flag is value-checked on its own — a trailing one still throws', () => {
  assert.throws(() => parseArgs(['--add-repo', '/a', '--add-repo'], { multi: ['add-repo'] }),
    /missing value for --add-repo/);
  assert.throws(() => parseArgs(['--add-repo', '/a', '--add-repo', '--base', 'main'], { multi: ['add-repo'] }),
    /missing value for --add-repo/, 'the next token being a flag is still no value');
});

test('a name declared as BOTH a bool and a multi is a config error, thrown before any argv is read', () => {
  assert.throws(() => parseArgs([], { bools: ['x'], multi: ['x'] }),
    /--x is declared as both a bool and a multi flag/);
});

test('a repeated flag NOT listed in multi still last-wins, exactly as before', () => {
  assert.deepEqual(parseArgs(['--base', 'main', '--base', 'other']).flags, { base: 'other' });
  assert.deepEqual(parseArgs(['--base', 'main', '--base', 'other'], { multi: ['add-repo'] }).flags,
    { base: 'other' }, 'declaring some other name multi changes nothing for this one');
});

test('no-args parse yields empty flags and positionals', () => {
  assert.deepEqual(parseArgs([]), { flags: {}, positional: [] });
});

test('requireFlags passes when all names present', () => {
  requireFlags({ base: 'main', name: 'f1' }, ['base', 'name'], 'legion x --base <b> --name <n>');
});

test('requireFlags throws with the flag name and usage embedded', () => {
  assert.throws(
    () => requireFlags({ base: 'main' }, ['base', 'name'], 'legion x --base <b> --name <n>'),
    /missing --name\. usage: legion x --base <b> --name <n>/,
  );
});
