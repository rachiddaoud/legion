// forge.test.mjs — the pure forge-selection kernel: host derivation (moved here with the
// function, 2026-08-15 — it lived in doctor.mjs as glabHost), URL-based forge detection, and
// the one enum validator every forge-bearing surface shares.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_FORGE, FORGES, FORGE_IDENTITY, detectForge, forgeTable, remoteHost, validateForge,
} from '../../src/kernel/forge.mjs';

test('remoteHost derives the host from every remote form, and refuses to guess', () => {
  assert.equal(remoteHost('git@gitlab.invalid:acme/fix-proj.git'), 'gitlab.invalid', 'scp-like');
  assert.equal(remoteHost('https://gitlab.invalid/acme/sub/fix-proj.git'), 'gitlab.invalid', 'https');
  assert.equal(remoteHost('ssh://git@gitlab.invalid:2222/acme/fix-proj.git'), 'gitlab.invalid', 'ssh with a port');
  assert.equal(remoteHost('ssh://git@gitlab.invalid/acme/fix-proj.git'), 'gitlab.invalid', 'ssh without a port');
  assert.equal(remoteHost('https://user:tok@gitlab.invalid:8443/a/b.git'), 'gitlab.invalid', 'userinfo and port both stripped');
  assert.equal(remoteHost('HTTPS://GitLab.Invalid/a/b.git'), 'gitlab.invalid', 'hosts are case-insensitive');
  assert.equal(remoteHost('https://gitlab/a/b.git'), 'gitlab', 'a single-label internal host is still unambiguous');
  for (const bad of [null, undefined, 42, '', '   ', '/local/path/repo.git', 'not a url', 'file:///somewhere/odd', './rel/path']) {
    assert.equal(remoteHost(bad), null, `must not guess a host from ${JSON.stringify(bad)}`);
  }
});

test('detectForge reads github.com and *.ghe.com as github, in every remote form', () => {
  assert.equal(detectForge('git@github.com:acme/fix-proj.git'), 'github', 'scp-like');
  assert.equal(detectForge('https://github.com/acme/fix-proj.git'), 'github', 'https');
  assert.equal(detectForge('ssh://git@github.com/acme/fix-proj.git'), 'github', 'ssh');
  assert.equal(detectForge('ssh://git@github.com:443/acme/fix-proj.git'), 'github', 'port stripped before matching');
  assert.equal(detectForge('https://user:tok@github.com/a/b.git'), 'github', 'userinfo stripped before matching');
  assert.equal(detectForge('HTTPS://GitHub.Com/a/b.git'), 'github', 'case-insensitive');
  assert.equal(detectForge('git@acme.ghe.com:acme/fix-proj.git'), 'github', 'GHE data-residency tenant');
});

test('detectForge reads every other resolvable host as gitlab — the pre-existing world', () => {
  assert.equal(detectForge('git@gitlab.com:acme/fix-proj.git'), 'gitlab');
  assert.equal(detectForge('https://gitlab.invalid/acme/fix-proj.git'), 'gitlab', 'self-managed GitLab');
  assert.equal(detectForge('https://gitlab/a/b.git'), 'gitlab', 'single-label internal host');
  // The documented wrong-by-default (module header): a self-hosted GHES on its own domain is
  // indistinguishable by URL — detection says gitlab, and --forge github is the escape hatch.
  assert.equal(detectForge('git@github.acme.invalid:acme/fix-proj.git'), 'gitlab', 'GHES needs the explicit override');
  assert.equal(detectForge('https://notgithub.com/a/b.git'), 'gitlab', 'a suffix-similar host is not github.com');
});

test('detectForge returns null — never a guess — when no host resolves', () => {
  for (const bad of [null, undefined, '', '/local/path/repo.git', 'file:///somewhere/odd']) {
    assert.equal(detectForge(bad), null, `must not pick a forge from ${JSON.stringify(bad)}`);
  }
});

test('validateForge accepts exactly the enum and refuses everything else naming the surface', () => {
  for (const ok of FORGES) assert.equal(validateForge(ok, '--forge'), ok);
  assert.ok(FORGES.includes(DEFAULT_FORGE), 'the default must be a member of the enum');
  for (const bad of ['GitHub', 'gh', 'glab', 'bitbucket', '', null, 42, undefined]) {
    assert.throws(
      () => validateForge(bad, '--forge'),
      (e) => e.message.includes('--forge') && e.message.includes('gitlab|github'),
      `must refuse ${JSON.stringify(bad)}`,
    );
  }
});

// --- the shared identity base (2026-08-15) -------------------------------------------------------
// doctor's FORGE_PROBES and finalize's FORGE_OPS used to restate id/cli/forgeName each, keyed by
// an enum in this file: three edits to add a forge, and nothing failed if one was missed. These
// pin the construction that makes that impossible.

test('FORGE_IDENTITY covers exactly FORGES, and carries the three facts every call site needs', () => {
  assert.deepEqual(Object.keys(FORGE_IDENTITY).sort(), [...FORGES].sort());
  for (const id of FORGES) {
    assert.deepEqual(Object.keys(FORGE_IDENTITY[id]).sort(), ['cli', 'forgeName', 'id']);
    assert.equal(FORGE_IDENTITY[id].id, id, 'the id is the key — never re-derived from the CLI name');
    assert.equal(typeof FORGE_IDENTITY[id].cli, 'string');
    assert.ok(Object.isFrozen(FORGE_IDENTITY[id]));
  }
  assert.deepEqual(FORGE_IDENTITY.gitlab.cli, 'glab');
  assert.deepEqual(FORGE_IDENTITY.github.cli, 'gh');
});

test('forgeTable merges the identity in and freezes the result', () => {
  const t = forgeTable({ gitlab: { noun: 'MR' }, github: { noun: 'PR' } }, 'test table');
  assert.deepEqual(t.gitlab, { id: 'gitlab', cli: 'glab', forgeName: 'GitLab', noun: 'MR' });
  assert.deepEqual(t.github, { id: 'github', cli: 'gh', forgeName: 'GitHub', noun: 'PR' });
  assert.ok(Object.isFrozen(t) && Object.isFrozen(t.gitlab));
  // A call site may override an identity fact only by saying so explicitly — nothing does today.
  assert.equal(forgeTable({ gitlab: {}, github: { cli: 'gh2' } }, 'x').github.cli, 'gh2');
});

test('forgeTable REFUSES a half-written table, in both directions, at import time', () => {
  // A forge in FORGES with no entry: the "added the enum, forgot one table" case.
  assert.throws(() => forgeTable({ gitlab: { noun: 'MR' } }, 'doctor FORGE_PROBES'),
    /doctor FORGE_PROBES: no entry for forge 'github' — every forge in FORGES must be covered/);
  // An entry for something that is not a forge: the typo case.
  assert.throws(() => forgeTable({ gitlab: {}, github: {}, gitbub: {} }, 'finalize FORGE_OPS'),
    /finalize FORGE_OPS: entries for unknown forge\(s\) gitbub — one of gitlab\|github/);
});

test('the two shipped tables are built through it, so neither can drift on identity', async () => {
  // Importing them is the assertion: forgeTable throws at module load on a gap, so a green
  // import here IS the coverage proof. The equality then pins that neither restated a fact.
  const [{ realIo }, doctor] = await Promise.all([
    import('../../src/cli/finalize.mjs'),
    import('../../src/cli/doctor.mjs'),
  ]);
  assert.equal(typeof realIo, 'function');
  assert.equal(typeof doctor.doctorCore, 'function');
  // Every CLI the io seam exposes is a FORGE_IDENTITY cli, and vice versa: the seam and the
  // table are the same set, so a forge added to one without the other is visible here.
  const io = realIo();
  assert.deepEqual(
    FORGES.map((id) => FORGE_IDENTITY[id].cli).sort(),
    Object.keys(io).filter((k) => k !== 'gitPush').sort(),
  );
});
