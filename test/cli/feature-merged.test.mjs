// feature-merged.test.mjs — `legion feature merged`, the ONE reader of the forge outside
// finalize and doctor, and the only thing in legion that can notice a merge.
//
// WHAT IS ACTUALLY AT STAKE HERE, and it is not the printing: this command is the sole writer of
// `mr.merged`, and `mr.merged` is the sole way `legion feature clean` will delete a worktree that
// its local containment formula would otherwise retain. So every case below asks one of two
// questions — "did it record a merge the server did NOT report?" (a forged certificate deletes
// someone's work) and "did it stay silent when it could not tell?" (noise at the top of every
// session in a repo with no network).
//
// THE FORGE IS A PATH SHIM, never a network call. The shared fixture already prepends a `fakebin`
// to PATH carrying a `glab` that refuses loudly; these cases OVERWRITE it (and add `gh`) with
// shims that print one chosen payload, so both forges are driven for real through
// kernel/runner.mjs — argv, cwd and env included — with nothing reaching a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fixture, NOW } from '../helpers/fixture.mjs';

/** The fixture's fakebin — first on the PATH it hands every child, by construction. Derived
 * rather than exported so this file cannot drift from where the fixture actually put it. */
const fakeBin = (h) => h.env.PATH.split(delimiter)[0];

/** Replace a forge CLI with a shim that prints `stdout` and exits `code`. */
function shim(h, cli, stdout, code = 0) {
  const p = join(fakeBin(h), cli);
  writeFileSync(p, `#!/bin/sh\ncat <<'JSON'\n${stdout}\nJSON\nexit ${code}\n`);
  chmodSync(p, 0o755);
}

/** A feature that has been finalized: an MR recorded at the current HEAD, on the named forge. */
function finalized(h, { forge = null } = {}) {
  const head = h.head();
  h.recordMr(head);
  if (forge !== null) h.writeFeature((f) => ({ ...f, revision: f.revision + 1, mr: { ...f.mr, forge } }));
  return head;
}

test('a MERGED pull request is reported once and recorded as a certificate', () => {
  const h = fixture();
  const head = finalized(h, { forge: 'github' });
  shim(h, 'gh', JSON.stringify({ state: 'MERGED', headRefOid: head }));

  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^f1: #7 merged at /m);
  // The line must name the command that is actually next for THIS status: the feature is still
  // active, so closing the lifecycle comes before local cleanup. Naming `clean` here would send
  // the reader straight into its closed-only refusal.
  assert.match(r.stdout, /legion state close delivered/);
  assert.match(r.stdout, /legion feature clean f1/);

  const f = h.readFeature();
  assert.deepEqual(f.mr.merged, { at: NOW, headSha: head },
    'the certificate carries the head the FORGE reported, beside the verdict');
  assert.equal(f.mr.headSha, head, 'the finalize record itself is untouched');
});

test('an OPEN pull request says nothing and writes nothing', () => {
  const h = fixture();
  const head = finalized(h, { forge: 'github' });
  shim(h, 'gh', JSON.stringify({ state: 'OPEN', headRefOid: head }));
  const before = h.snapshot();

  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  h.assertUnmoved(before, 'an open PR');
});

test('GitLab is driven through its own spelling, and a merged MR is recorded the same way', () => {
  const h = fixture();
  // No `forge` marker at all — the fixture's recordMr writes the pre-2026-08-15 shape, which
  // every reader in the tree treats as GitLab by construction. That default is what is under
  // test here: it decides WHICH CLI gets spawned.
  const head = finalized(h);
  shim(h, 'glab', JSON.stringify({ state: 'merged', sha: head }));

  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^f1: !7 merged at /m, 'GitLab notation, not GitHub');
  assert.deepEqual(h.readFeature().mr.merged, { at: NOW, headSha: head });
});

test('a closed feature is told to clean, not to close again', () => {
  const h = fixture();
  const head = finalized(h, { forge: 'github' });
  h.writeFeature((f) => ({ ...f, revision: f.revision + 1, status: 'delivered', closedAt: NOW }));
  shim(h, 'gh', JSON.stringify({ state: 'MERGED', headRefOid: head }));

  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /legion feature clean f1/);
  assert.doesNotMatch(r.stdout, /close delivered/, 'an already-closed feature has nothing to close');
});

test('a CLI that is absent, unauthenticated or offline is SILENT — never a guessed verdict', () => {
  const h = fixture();
  finalized(h, { forge: 'github' });
  // REALLY absent: the fixture's own loud `gh` shim is REMOVED, so the spawn fails with ENOENT
  // rather than with a shim's exit 1. Without this the case would silently become "gh ran and
  // failed" on any machine — and, before the fixture shimmed gh at all, it would have reached
  // the operator's real one.
  rmSync(join(fakeBin(h), 'gh'));
  const before = h.snapshot();
  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  h.assertUnmoved(before, 'no forge CLI');

  // And the same for a CLI that runs and FAILS (unauthenticated is exactly this shape).
  shim(h, 'gh', 'gh: not authenticated', 1);
  const r2 = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.stdout, '');
  h.assertUnmoved(before, 'an unauthenticated CLI');
});

test('a payload the kernel cannot read a HEAD out of is UNKNOWN, not merged', () => {
  const h = fixture();
  finalized(h, { forge: 'github' });
  const before = h.snapshot();

  // MERGED, but no headRefOid: a certificate without the head it was earned at certifies
  // nothing about the tree `clean` would delete, so there is nothing here to record.
  shim(h, 'gh', JSON.stringify({ state: 'MERGED' }));
  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');

  // And a payload that is not JSON at all.
  shim(h, 'gh', 'not json');
  const r2 = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r2.code, 0, r2.stderr);
  assert.equal(r2.stdout, '');
  h.assertUnmoved(before, 'an unreadable payload');
});

test('a feature that never finalized is not asked about at all', () => {
  const h = fixture();
  shim(h, 'gh', JSON.stringify({ state: 'MERGED', headRefOid: h.head() }));
  const before = h.snapshot();
  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
  h.assertUnmoved(before, 'no mr recorded');
});

test('re-running reports again but writes once — the sweep fires on every session start', () => {
  const h = fixture();
  const head = finalized(h, { forge: 'github' });
  shim(h, 'gh', JSON.stringify({ state: 'MERGED', headRefOid: head }));

  assert.equal(h.legionIn(h.repoRoot, 'feature', 'merged').code, 0);
  const after = h.snapshot();
  const r2 = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r2.code, 0, r2.stderr);
  assert.match(r2.stdout, /^f1: #7 merged at /m, 'the operator still gets told');
  h.assertUnmoved(after, 'an unchanged certificate');
});

test('a settled certificate is reported from the record, without asking the forge again', () => {
  const h = fixture();
  const head = finalized(h, { forge: 'github' });
  shim(h, 'gh', JSON.stringify({ state: 'MERGED', headRefOid: head }));
  assert.equal(h.legionIn(h.repoRoot, 'feature', 'merged').code, 0);

  // A `gh` that would now CRASH the sweep if it were called. The verdict is already on record, so
  // nothing may call it — a merged feature the operator has not cleaned up yet must not buy a
  // forge round-trip at every session opening for the rest of its life.
  shim(h, 'gh', 'this must never be read', 1);
  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^f1: #7 merged at /m, 'and the operator is still told, from the record');
});

test('a merge at a head finalize never recorded says so, and names finalize — not clean', () => {
  const h = fixture();
  finalized(h, { forge: 'github' });
  // The MR moved past what finalize pushed (a colleague's fixup on the PR is exactly this).
  // `mergeCertified` will refuse this certificate and `clean` will retain, so advertising the
  // cleanup here would send the reader straight into a refusal.
  shim(h, 'gh', JSON.stringify({ state: 'MERGED', headRefOid: 'a'.repeat(40) }));

  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /but finalize recorded/);
  assert.match(r.stdout, /re-run legion finalize/);
  assert.doesNotMatch(r.stdout, /legion feature clean/, 'a cleanup that cannot be certified is not offered');
});

test('a feature already cleaned up is never asked about again', () => {
  const h = fixture();
  const head = finalized(h, { forge: 'github' });
  h.writeFeature((f) => ({ ...f, revision: f.revision + 1, status: 'delivered', closedAt: NOW }));
  // What `legion feature clean` leaves behind: the dossier and the manifest, no worktree and no
  // branch. There is nothing left to unblock, so there is nothing to ask the forge about.
  const r0 = h.legionIn(h.repoRoot, 'feature', 'clean', 'f1');
  assert.equal(r0.code, 0, `${r0.stdout}${r0.stderr}`);
  shim(h, 'gh', 'this must never be read', 1);

  const r = h.legionIn(h.repoRoot, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('it resolves the project from a feature worktree too, not just the main root', () => {
  const h = fixture();
  const head = finalized(h, { forge: 'github' });
  shim(h, 'gh', JSON.stringify({ state: 'MERGED', headRefOid: head }));
  // The hook fires in whatever cwd the session opened in, and that is a linked worktree as often
  // as the main root — the reason `feature status` takes {fromAnyWorktree} as well.
  const r = h.legionIn(h.worktree, 'feature', 'merged');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^f1: #7 merged at /m);
});

test('an unregistered repository REFUSES — it is the hook that stays silent, not the kernel', () => {
  const h = fixture();
  const r = h.legionIn(h.sandbox, 'feature', 'merged');
  assert.notEqual(r.code, 0);
  assert.match(r.stderr, /not a registered project|not a git repository|legion project init/);
});
