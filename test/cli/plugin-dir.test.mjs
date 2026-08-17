// T17 / M0 finding 1 — PLAN-V3 §Startup step 5: "Development launches additionally carry
// `--plugin-dir <plugin root>` when the plugin is not installed from the marketplace."
// The rule under test is a DERIVATION, not a flag: the CLI's own file location is the evidence of
// how legion is installed, and Claude Code keeps marketplace installs under its config dir's
// `plugins/` tree. So the cases that carry weight are the two LAYOUTS (a root inside that tree =>
// no flag; anywhere else => flag), the boundary between them (a sibling directory whose NAME
// merely starts with "plugins" is outside), and the escaping of a root that contains hostile
// bytes — a checkout under `~/My Work` is ordinary, not exotic.
// LEGION_HOME is pinned to a temp dir for the whole file: launchCommand composes a dossier path
// through paths.mjs, and the real ~/.legion is never read or written here (nothing on disk is
// touched at all except the sh/stub-claude scenario, which lives entirely in the temp tree).
// NO NETWORK, no marketplace install required: the marketplace layout is SIMULATED by handing
// launchCommand a root under the config dir, which is exactly the evidence the rule reads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMarketplaceClone, isMarketplaceInstall, launchCommand, marketplaceClonesRoot, marketplacePluginsRoot, shellQuote } from '../../src/cli/feature.mjs';

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

let TMP;
let PREV_HOME;
let PREV_CONFIG_DIR;
before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'legion3-plugindir-'));
  PREV_HOME = process.env.LEGION_HOME;
  PREV_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
  process.env.LEGION_HOME = join(TMP, 'legion-home');
  delete process.env.CLAUDE_CONFIG_DIR; // the default layout is ~/.claude/plugins unless a case says otherwise
});
after(() => {
  if (PREV_HOME === undefined) delete process.env.LEGION_HOME; else process.env.LEGION_HOME = PREV_HOME;
  if (PREV_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = PREV_CONFIG_DIR;
  rmSync(TMP, { recursive: true, force: true });
});

const F = (worktree = '/wt') => ({
  org: 'default', project: 'proj', name: 'f1', featureId: 'default/proj/f1', worktree,
});
test('a development root (not under the config dir) is named by --plugin-dir, escaped', () => {
  const dev = join(TMP, 'checkouts', 'legion3');
  const line = launchCommand('interactive', F('/tmp/wt'), dev);
  assert.equal(isMarketplaceInstall(dev), false, 'a temp-dir checkout is not a marketplace install');
  assert.ok(
    line.includes(`claude --plugin-dir ${shellQuote(dev)} --add-dir `),
    `the dev root must be carried, quoted, before --add-dir:\n  ${line}`,
  );
});

test('a marketplace-layout root (under <config dir>/plugins) carries NO --plugin-dir', () => {
  // Simulated, not installed: the rule reads the ROOT, so a root under ~/.claude/plugins IS the
  // marketplace evidence. homedir() is only read, never written.
  const mkt = join(homedir(), '.claude', 'plugins', 'legion-marketplace', 'legion');
  assert.equal(isMarketplaceInstall(mkt), true);
  const line = launchCommand('interactive', F('/tmp/wt'), mkt);
  assert.ok(!line.includes('--plugin-dir'), `a marketplace install must add nothing:\n  ${line}`);
  assert.ok(line.includes('claude --add-dir '), line);
  // …and the plugins directory itself counts as inside it, not merely its children.
  assert.equal(isMarketplaceInstall(marketplacePluginsRoot()), true);
});

test('containment is by path segment: ~/.claude/pluginsfoo is NOT a marketplace install', () => {
  const sibling = join(homedir(), '.claude', 'pluginsfoo', 'legion');
  assert.equal(isMarketplaceInstall(sibling), false, 'a string-prefix match would swallow this sibling');
  assert.ok(launchCommand('interactive', F('/tmp/wt'), sibling).includes('--plugin-dir'));
});

test('CLAUDE_CONFIG_DIR relocates the marketplace root, and is read at call time', () => {
  const relocated = join(TMP, 'claude-config');
  const root = join(relocated, 'plugins', 'legion-marketplace', 'legion');
  assert.equal(isMarketplaceInstall(root), false, 'without the env var, that path is an ordinary dev root');
  process.env.CLAUDE_CONFIG_DIR = relocated;
  try {
    assert.equal(marketplacePluginsRoot(), join(relocated, 'plugins'));
    assert.equal(isMarketplaceInstall(root), true, 'a relocated config dir moves the marketplace tree with it');
    assert.ok(!launchCommand('interactive', F('/tmp/wt'), root).includes('--plugin-dir'));
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
  assert.equal(isMarketplaceInstall(root), false, 'and the answer follows the env back');
});

test('isMarketplaceClone tells the durable clone from everything else under plugins/', () => {
  // The finer predicate setup composes with isMarketplaceInstall: true only under
  // <config dir>/plugins/marketplaces — the git clone Claude Code pulls — never for the
  // swept snapshot cache or a dev checkout.
  const plugins = join(homedir(), '.claude', 'plugins');
  assert.equal(isMarketplaceClone(join(plugins, 'marketplaces', 'legion')), true);
  assert.equal(isMarketplaceClone(join(plugins, 'marketplaces', 'legion', 'src', 'cli')), true, 'children of a clone are inside it');
  assert.equal(isMarketplaceClone(join(plugins, 'cache', 'legion', 'legion', 'abc123')), false, 'the snapshot cache is NOT a clone');
  assert.equal(isMarketplaceClone(join(TMP, 'checkouts', 'legion3')), false, 'a dev checkout is not a clone');
  assert.equal(isMarketplaceClone(join(plugins, 'marketplacesfoo', 'legion')), false, 'containment is by segment, not string prefix');
  assert.equal(marketplaceClonesRoot(), join(plugins, 'marketplaces'));
});

test('isMarketplaceClone follows CLAUDE_CONFIG_DIR at call time, like the plugins root', () => {
  const relocated = join(TMP, 'claude-config-clone');
  const clone = join(relocated, 'plugins', 'marketplaces', 'legion');
  assert.equal(isMarketplaceClone(clone), false, 'without the env var, that path is ordinary');
  process.env.CLAUDE_CONFIG_DIR = relocated;
  try {
    assert.equal(marketplaceClonesRoot(), join(relocated, 'plugins', 'marketplaces'));
    assert.equal(isMarketplaceClone(clone), true);
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
  assert.equal(isMarketplaceClone(clone), false, 'and the answer follows the env back');
});

// GATED TO THE CASE-INSENSITIVE PLATFORMS, exactly like the fold it rides with (feature.mjs):
// darwin and win32 are where two normalization forms name ONE file. On Linux they are two
// different directories, and folding them would be a defect rather than a fix.
const NORMALIZING_FS = process.platform === 'darwin' || process.platform === 'win32';

test('containment survives Unicode normalization — one path, two spellings', {
  skip: NORMALIZING_FS ? false : 'normalization folding is gated to darwin/win32',
}, () => {
  // The two sides reach these predicates from different producers: one from argv or a manifest,
  // the other composed from homedir(). A directory carrying any non-ASCII character can be spelled
  // decomposed on one side and composed on the other for the SAME directory, and realpathSync
  // canonicalizes symlinks and case — not Unicode form. Both predicates then go false TOGETHER,
  // which is the dangerous direction: setup reads the clone as a dev checkout and runs
  // `marketplace add <clone path>`, the directory-source re-registration that ends auto-update.
  const home = join(TMP, 'Développement');
  const nfc = join(home, 'plugins', 'marketplaces', 'legion').normalize('NFC');
  const nfd = nfc.normalize('NFD');
  assert.notEqual(nfc, nfd, 'the two spellings must genuinely differ, or this test proves nothing');
  process.env.CLAUDE_CONFIG_DIR = home.normalize('NFD');
  try {
    assert.equal(isMarketplaceInstall(nfc), true, 'NFC root against an NFD-spelled base');
    assert.equal(isMarketplaceClone(nfc), true);
    process.env.CLAUDE_CONFIG_DIR = home.normalize('NFC');
    assert.equal(isMarketplaceClone(nfd), true, 'and NFD root against an NFC-spelled base');
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
  }
});

test('launchCommand omits --plugin-dir for cache AND clone roots alike — the split does not touch it', () => {
  // The new clone/cache distinction exists for setup only; a launch printed from either copy
  // must stay flagless, because either way the plugin is genuinely installed.
  const plugins = join(homedir(), '.claude', 'plugins');
  for (const root of [
    join(plugins, 'cache', 'legion', 'legion', '3abc27f94533'),
    join(plugins, 'marketplaces', 'legion'),
  ]) {
    const line = launchCommand('interactive', F('/tmp/wt'), root);
    assert.ok(!line.includes('--plugin-dir'), `no flag for ${root}:\n  ${line}`);
  }
});

test('the default root is derived from the CLI file location — not cwd', () => {
  const fromRepo = launchCommand('interactive', F('/tmp/wt'));
  assert.ok(fromRepo.includes(`--plugin-dir ${shellQuote(REPO_ROOT)} `), fromRepo);
  const prev = process.cwd();
  process.chdir(TMP); // stand somewhere else entirely: the answer must not move
  try {
    assert.equal(launchCommand('interactive', F('/tmp/wt')), fromRepo);
  } finally {
    process.chdir(prev);
  }
});

test('every launch mode carries the flag, after its own mode flags', () => {
  const dev = join(TMP, 'checkouts', 'legion3');
  assert.ok(launchCommand('background', F('/tmp/wt'), dev).includes(`claude --bg --plugin-dir ${shellQuote(dev)} --add-dir `));
  assert.ok(launchCommand('remote', F('/tmp/wt'), dev).includes(`--name 'f1' --plugin-dir ${shellQuote(dev)} --add-dir `));
});

test('escaping holds: a root with a space and an apostrophe parses back to exactly one argument', () => {
  // The authority is a REAL /bin/sh plus a stub `claude` that records its argv NUL-joined — the
  // same technique as the T14 escaping table, extended to the new flag.
  const base = join(TMP, 'hazard');
  const pluginRoot = join(base, "my plugins", "rachid's legion3");
  const worktree = join(base, 'checkout');
  const bin = join(base, 'bin');
  for (const d of [pluginRoot, worktree, bin]) mkdirSync(d, { recursive: true });
  const stub = join(bin, 'claude');
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\0\' "$@" > argv-out\n');
  chmodSync(stub, 0o755);

  const line = launchCommand('interactive', F(worktree), pluginRoot);
  const r = spawnSync('/bin/sh', ['-c', line], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` },
  });
  assert.equal(r.status, 0, `the line must execute cleanly: ${r.stderr}`);
  const argv = readFileSync(join(worktree, 'argv-out'), 'utf8').split('\0').slice(0, -1);
  assert.deepEqual(argv, [
    '--plugin-dir',
    pluginRoot,
    '--add-dir',
    join(process.env.LEGION_HOME, 'orgs', 'default', 'projects', 'proj', 'features', 'f1'),
    '/legion:feature resume default/proj/f1',
  ], 'the hostile root must arrive as ONE intact argument');
});
