// initiative.test.mjs — THE initiative link (T32, PLAN-V3 §Initiatives + §State rev-6): the
// optional `feature.json` block, `feature start --initiative`, the `contract` artifact kind, and
// the ONE additive prerequisite clause that lets a SECONDARY complete intake BY REFERENCE.
//
// WHY A NEW FILE rather than more cases in test/cli/feature.test.mjs or test/cli/state.test.mjs:
// this layer spans BOTH — the block is derived by the CLI and consumed by the kernel's stage
// machine — and neither of those two large, interlocking files is the home of a claim that needs
// the other half. It also needs something neither of their scenario helpers builds: TWO features
// in ONE project, driven independently. test/helpers/fixture.mjs already builds a real project
// with one real feature through the REAL bin, so the second feature is started through the same
// bin from the same sandbox and nothing about the harness is re-invented.
//
// THE BAR IS THE M1A LEDGER'S: drive the real CLI/kernel into a state where a refusal is the
// correct answer, assert the refusal, assert WHAT it names, and assert THAT NOTHING MOVED — a
// refused `feature start` must leave no dossier, no worktree and no branch (the T17/R18 rule), and
// a refused `legion state` op must leave both manifests byte-identical. Every refusal group ends
// on a POSITIVE CONTROL, because a refusal test that never proves the door opens again passes just
// as well against a layer that wedged it shut.
//
// TWO CLAIMS THIS FILE EXISTS TO PIN, both from the threat model (the adversary is agent error and
// drift, not a malicious operator):
//   1. A SECONDARY IS NEVER BUILT AGAINST A STALE RECAP. The reference is re-validated on every
//      call, so a recap edited AFTER intake completed poisons the prefix for the next forward
//      stage-enter — asserted, not assumed.
//   2. NOTHING IS WRITTEN OUTSIDE THE FEATURE BEING STARTED. The primary's manifests are compared
//      byte-for-byte across a secondary's whole start, because sibling enumeration is derived by
//      SCAN and a stored siblings[] would be a cross-manifest write on a file with no CAS.
// A THIRD, equally load-bearing and easy to lose: WITHOUT `--initiative` NOTHING CHANGES. M1b is
// additive and must not destabilize M1a, so the no-flag manifest shape is asserted key-for-key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fixture } from '../helpers/fixture.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readIf = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/** A second (third, …) feature in the SAME project as the fixture's own, driven through the same
 * real bin. Returns the handles a case needs: its dossier, its worktree, a `legion` bound to that
 * worktree, and the start result itself (cases assert on refusals as often as on successes). */
function startFeature(h, name, ...extra) {
  const r = h.legionIn(h.repoRoot, 'feature', 'start', name, '--base', 'main', ...extra);
  const dossier = join(h.home, 'orgs', 'default', 'projects', h.project, 'features', name);
  const worktree = join(dirname(h.repoRoot), '.legion-worktrees', h.project, name, 'checkout');
  return {
    r,
    name,
    dossier,
    worktree,
    legion: (...argv) => h.legionIn(worktree, ...argv),
    readFeature: () => JSON.parse(readFileSync(join(dossier, 'feature.json'), 'utf8')),
    writeArtifact: (file, body) => {
      const p = join(dossier, file);
      writeFileSync(p, body);
      return p;
    },
  };
}

/** Manifest BYTES for an arbitrary dossier — fixture's own snapshot/assertUnmoved are bound to the
 * feature IT started, and half the claims here are about a DIFFERENT feature's dossier. Byte
 * comparison is the right question: a refused op must write nothing, and a revision bump with
 * every visible field unchanged is still state that moved. */
const snapOf = (dossier) => ({
  feature: readIf(join(dossier, 'feature.json')),
  tasks: readIf(join(dossier, 'tasks.json')),
});
function assertUnmoved(dossier, snap, what) {
  const now = snapOf(dossier);
  assert.equal(now.feature, snap.feature, `${what}: feature.json MOVED`);
  assert.equal(now.tasks, snap.tasks, `${what}: tasks.json MOVED`);
}

/** A refused `feature start` must leave NO trace at all (the T17/R18 rule the header states):
 * no manifest, no worktree, no feat/<name> branch to block the retry. */
function assertNothingStarted(h, s) {
  assert.ok(!existsSync(join(s.dossier, 'feature.json')), `${s.name}: a refused start wrote a manifest`);
  assert.ok(!existsSync(s.worktree), `${s.name}: a refused start created a worktree`);
  const branches = h.legionIn(h.repoRoot, 'feature', 'status').stdout;
  assert.ok(!branches.includes(`${s.name}  `), `${s.name}: a refused start registered the feature`);
}

/** The PRIMARY's half of an initiative: `state init`, then the shared recap (recorded as the
 * `intent` artifact — that is where intake records it, skills/feature/SKILL.md intake step 8) and
 * the interface CONTRACT, both hosted in the primary's own dossier and both recorded through the
 * REAL kernel op — AND the primary's own `decision-record intake`, the human's yes to the recap.
 * THAT APPROVAL IS NOT DECORATION HERE: a secondary completes intake BY REFERENCE to this recap, so
 * `feature start` refuses to link one until the primary's intake approval is hash-valid (otherwise
 * an initiative could pass intake end to end with no human agreement recorded anywhere). Cases that
 * want the primary UNAGREED pass `{agree:false}` and assert that refusal.
 * Paths come back REALPATH'D because that is what `artifact-record` stores and therefore what the
 * derived reference must name (the sandbox lives under a symlinked /tmp). */
function hostSharedArtifacts(p, {
  recap = '# recap\nwe agreed on the FE+BE change\n',
  contract = '# contract\nGET /widgets -> {id, name}\n',
  agree = true,
} = {}) {
  assert.equal(p.legion('state', 'init').code, 0);
  const recapPath = p.writeArtifact('intent.md', recap);
  const contractPath = p.writeArtifact('contract.md', contract);
  let r = p.legion('state', 'artifact-record', 'intent', 'intent.md');
  assert.equal(r.code, 0, `primary intent: ${r.stderr}`);
  r = p.legion('state', 'artifact-record', 'contract', 'contract.md');
  assert.equal(r.code, 0, `primary contract (is 'contract' an ARTIFACT_KIND?): ${r.stderr}`);
  if (agree) {
    r = p.legion('state', 'decision-record', 'intake');
    assert.equal(r.code, 0, `primary intake approval: ${r.stderr}`);
  }
  return { recapPath: realpathSync(recapPath), contractPath: realpathSync(contractPath) };
}

/** A SECOND real repository in the same sandbox, registered as a second legion project in the same
 * LEGION_HOME — the driving case §Initiatives names in as many words ("projects split into frontend
 * and backend repositories"). It has to be built here rather than in fixture(): a legion project is
 * EXACTLY ONE REPOSITORY (`project init --root` over an existing name RECONCILES the entry onto the
 * new root rather than adding a repo), so "two repos" means "two projects", and the fixture builds
 * one. Everything goes through the same real bin and the same hardened env, so nothing about the
 * harness is re-invented. Returns a `startFeature`-shaped handle factory bound to that repo.
 * `org` DEFAULTS TO THE FIXTURE'S OWN (T35): the driving case is two projects in ONE org, and that
 * is what every pre-T35 case here builds. Passing another org is how the cross-ORG cases get a
 * second tenancy — the boundary the initiative id namespace is now scoped to. Project names must
 * stay distinct across orgs regardless, because the worktree tree is keyed by project name only. */
function secondRepo(h, project = 'feproj', org = 'default') {
  const repoRoot = join(dirname(h.repoRoot), project);
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'package.json'),
    `${JSON.stringify({ name: project, private: true, version: '0.0.0', type: 'module' }, null, 2)}\n`);
  writeFileSync(join(repoRoot, 'src', 'a.mjs'), 'export const a = 1;\n');
  const gitAt = (...args) => {
    const r = spawnSync('git', ['-c', 'user.email=test@example.invalid', '-c', 'user.name=legion test', ...args],
      { cwd: repoRoot, encoding: 'utf8', env: h.env });
    assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  };
  gitAt('init', '-b', 'main');
  gitAt('add', '-A');
  gitAt('commit', '-m', 'init');
  const real = realpathSync(repoRoot);
  const init = h.legionIn(real, 'project', 'init', '--root', real, '--name', project, '--org', org);
  assert.equal(init.code, 0, `second project init: ${init.stderr}`);
  return {
    project,
    org,
    repoRoot: real,
    featureId: (name) => `${org}/${project}/${name}`,
    /** Same shape as startFeature(), but in the OTHER repository/project. */
    start(name, ...extra) {
      const r = h.legionIn(real, 'feature', 'start', name, '--base', 'main', ...extra);
      const dossier = join(h.home, 'orgs', org, 'projects', project, 'features', name);
      const worktree = join(dirname(real), '.legion-worktrees', project, name, 'checkout');
      return {
        r,
        name,
        dossier,
        worktree,
        legion: (...argv) => h.legionIn(worktree, ...argv),
        readFeature: () => JSON.parse(readFileSync(join(dossier, 'feature.json'), 'utf8')),
        writeArtifact: (file, body) => {
          const p = join(dossier, file);
          writeFileSync(p, body);
          return p;
        },
      };
    },
  };
}

/** The whole ordinary shape: `pri` is a feature started UNDER the id (so the scan finds it — the
 * primary is the feature the shared intake ran under, and it carries the block like any sibling)
 * hosting both shared artifacts; `sec` is a SECONDARY started under the same id afterwards. The
 * fixture's own f1 stays in the project carrying NO block at all, which is free coverage: a
 * non-carrier must be invisible to the derivation.
 * `primarySnap` is taken after hosting, so every case can assert the primary never moved again. */
function linkedPair(id = 'ui-refresh', opts = {}) {
  const h = fixture();
  const pri = startFeature(h, 'f2', '--initiative', id);
  assert.equal(pri.r.code, 0, `primary start: ${pri.r.stderr}`);
  const paths = hostSharedArtifacts(pri, opts);
  const primarySnap = snapOf(pri.dossier);
  const sec = startFeature(h, 'f3', '--initiative', id);
  assert.equal(sec.r.code, 0, `secondary start: ${sec.r.stderr}`);
  return { h, pri, sec, primarySnap, ...paths };
}

// =================================================================================================
// A — the vocabulary: `contract` is an artifact kind, and it binds no approval
// =================================================================================================

test('`artifact-record contract` records like any other artifact and cascades no approval', () => {
  const h = fixture();
  h.writeArtifact('intent.md', '# intent\n');
  h.writeArtifact('contract.md', '# contract v1\n');
  assert.equal(h.legion('state', 'artifact-record', 'intent', 'intent.md').code, 0);
  assert.equal(h.legion('state', 'decision-record', 'intake').code, 0);
  assert.ok(h.readTasks().approvals.intake, 'the intake approval is the control');

  const r = h.legion('state', 'artifact-record', 'contract', 'contract.md');
  assert.equal(r.code, 0, `contract must be an accepted artifact kind: ${r.stderr}`);
  const t = h.readTasks();
  assert.equal(t.artifacts.contract.path, realpathSync(join(h.dossier, 'contract.md')));
  assert.equal(t.artifacts.contract.hash, sha256(readFileSync(join(h.dossier, 'contract.md'))));
  // Like repo-brief: NO ARTIFACT_TO_APPROVAL edge, so recording (or re-recording) it drops
  // nothing. Contract drift reaches approvals through the SPEC SUBJECT (T33), never through a
  // cascade edge of its own — a cascade here would over-invalidate the primary's intake approval.
  writeFileSync(join(h.dossier, 'contract.md'), '# contract v2 — different bytes\n');
  assert.equal(h.legion('state', 'artifact-record', 'contract', 'contract.md').code, 0);
  assert.ok(h.readTasks().approvals.intake, 'a contract edit must not cascade onto the intake approval');
});

// =================================================================================================
// B — the flag surface: the role is DERIVED, the references are DERIVED, the block is OPTIONAL
// =================================================================================================

test('without --initiative the manifest carries no block and keeps exactly today\'s shape', () => {
  const h = fixture();
  const plain = startFeature(h, 'f2');
  assert.equal(plain.r.code, 0, plain.r.stderr);
  const f = plain.readFeature();
  assert.equal(f.initiative, undefined, 'the block is OPTIONAL — absence is the ordinary case');
  // Key-for-key, in write order: M1b is additive, and "byte-identical without the flag" is the
  // milestone's own red line. A new key appearing here for every feature would break it.
  assert.deepEqual(Object.keys(f), [
    'schemaVersion', 'legionVersion', 'revision', 'org', 'project', 'name', 'featureId',
    'repoRoot', 'baseBranch', 'baseSha', 'commandPolicyHash', 'commandPolicy',
    'commandPolicyPinnedAt', 'worktree', 'branch', 'profile', 'stage', 'status',
    'createdAt', 'updatedAt', 'sessionHistory',
  ]);
  assert.ok(!plain.r.stdout.includes('initiative'), 'and nothing about initiatives is printed');
});

test('the FIRST feature under an id is the PRIMARY — role derived by scan, never supplied', () => {
  const h = fixture();
  const p = startFeature(h, 'f2', '--initiative', 'ui-refresh');
  assert.equal(p.r.code, 0, p.r.stderr);
  // The primary HOSTS the files, so it references nothing: at its own start there is nothing to
  // reference yet. And no siblings[] — enumeration is derived by scan, never stored.
  assert.deepEqual(p.readFeature().initiative, { id: 'ui-refresh', role: 'primary' });
  assert.match(p.r.stdout, /initiative: ui-refresh \(primary\)/);
});

test('the SECONDARY derives role, primary and BOTH references by reading the primary\'s files', () => {
  const { h, pri, sec, primarySnap, recapPath, contractPath } = linkedPair();
  const block = sec.readFeature().initiative;
  assert.deepEqual(block, {
    id: 'ui-refresh',
    role: 'secondary',
    primary: `default/${h.project}/f2`,
    recap: { path: recapPath, hash: sha256(readFileSync(recapPath)) },
    contract: { path: contractPath, hash: sha256(readFileSync(contractPath)) },
  });
  // DERIVED, not copied: the hashes equal sha256 of the bytes on disk, computed here independently
  // of anything the primary's tasks.json recorded.
  assert.match(sec.r.stdout, /initiative: ui-refresh \(secondary\)/);
  assert.ok(sec.r.stdout.includes(`recap:    ${recapPath} (sha256 ${block.recap.hash})`),
    'the derived reference is PRINTED at the one moment the operator looks at this feature');
  // NO CROSS-MANIFEST WRITE. The primary is not told it has a sibling — it is derivable.
  assertUnmoved(pri.dossier, primarySnap, 'a secondary start');
  assert.deepEqual(JSON.parse(primarySnap.feature).initiative, { id: 'ui-refresh', role: 'primary' });
  assert.ok(!JSON.stringify(sec.readFeature()).includes('siblings'), 'no siblings[] is ever written');
  assert.ok(!primarySnap.feature.includes('siblings'), 'least of all in the PRIMARY\'s manifest');
});

test('THE DRIVING CASE: the link spans REPOSITORIES — a secondary in the FE repo finds the BE primary', () => {
  // §Initiatives' opening sentence, driven end to end: "projects split into frontend and backend
  // repositories, where one change spans both". A legion project is exactly one repository, so the
  // scan that derives the role must span projects — bounded to one, `--initiative span` typed in
  // the FE repo silently produced a SECOND PRIMARY and printed success, leaving the secondary role,
  // the references and the whole contract cascade unreachable for every real initiative.
  const h = fixture();
  const be = startFeature(h, 'be1', '--initiative', 'span'); // the BE repo hosts the shared intake
  assert.equal(be.r.code, 0, be.r.stderr);
  const { recapPath, contractPath } = hostSharedArtifacts(be);

  const fe = secondRepo(h); // a SECOND real repo, registered as a second project
  const sec = fe.start('fe1', '--initiative', 'span');
  assert.equal(sec.r.code, 0, `the FE secondary must link across repositories: ${sec.r.stderr}`);
  assert.deepEqual(sec.readFeature().initiative, {
    id: 'span',
    role: 'secondary',
    primary: `default/${h.project}/be1`,
    recap: { path: recapPath, hash: sha256(readFileSync(recapPath)) },
    contract: { path: contractPath, hash: sha256(readFileSync(contractPath)) },
  }, 'the block must reference the OTHER repository\'s primary, by path+hash');
  assert.match(sec.r.stdout, /initiative: span \(secondary\)/);
  // The other repository's feature is genuinely another repository's: different repoRoot, different
  // worktree tree, and the reference still resolves because dossier paths are machine-global.
  assert.equal(sec.readFeature().repoRoot, fe.repoRoot);
  assert.notEqual(fe.repoRoot, h.repoRoot);

  // The grouping is symmetric and names the repository each sibling lives in, from EITHER side.
  const feStatus = h.legionIn(fe.repoRoot, 'feature', 'status', 'fe1');
  assert.equal(feStatus.code, 0, feStatus.stderr);
  assert.ok(feStatus.stdout.includes(`siblings: default/${h.project}/be1 (primary)`), feStatus.stdout);
  const beStatus = h.legionIn(h.repoRoot, 'feature', 'status', 'be1');
  assert.ok(beStatus.stdout.includes('siblings: default/feproj/fe1 (secondary)'), beStatus.stdout);

  // AND THE CLAUSE THE LINK EXISTS FOR WORKS ACROSS THE REPOSITORY BOUNDARY: the FE feature
  // completes intake by reference to the BE recap, and a later edit of that recap poisons its
  // prefix. This is the cross-repo half of "the cascade is verified, not assumed".
  assert.equal(sec.legion('state', 'init').code, 0);
  sec.writeArtifact('intent.md', '# intent\nthe FE half\n');
  assert.equal(sec.legion('state', 'artifact-record', 'intent', 'intent.md').code, 0);
  assert.equal(sec.legion('state', 'escalate-profile', 'express').code, 0);
  assert.equal(sec.legion('state', 'stage-complete', 'intake').code, 0,
    'by-reference intake must work across repositories — that is the only case it is for');
  writeFileSync(recapPath, '# recap\nrenegotiated in the BE session\n');
  const hop = sec.legion('state', 'stage-enter', 'spec');
  assert.equal(hop.code, 1, 'a recap edited in the OTHER repo must poison this feature\'s prefix');
  assert.match(hop.stderr, /CHANGED/);
});

test('a restarted primary is not made a secondary of itself (its own manifest is excluded)', () => {
  const h = fixture();
  assert.equal(startFeature(h, 'f2', '--initiative', 'ui-refresh').r.code, 0);
  assert.equal(h.legionIn(h.repoRoot, 'feature', 'abandon', 'f2').code, 0);
  // `start` over an abandoned name is the documented restart path; a scan that saw the feature's
  // OWN prior manifest would find a primary and make the restart a secondary of itself.
  const again = startFeature(h, 'f2', '--initiative', 'ui-refresh');
  assert.equal(again.r.code, 0, again.r.stderr);
  assert.deepEqual(again.readFeature().initiative, { id: 'ui-refresh', role: 'primary' });
});

test('feature status renders the initiative grouping — siblings FOUND BY SCAN, read-only', () => {
  const { h, sec } = linkedPair();
  const before = snapOf(sec.dossier);
  const primary = h.legionIn(h.repoRoot, 'feature', 'status', 'f2');
  assert.equal(primary.code, 0, primary.stderr);
  assert.match(primary.stdout, /initiative: ui-refresh \(primary\)/);
  // Siblings are named org/project/name, not by bare name: they may live in ANOTHER repository, and
  // which one is the question this grouping answers.
  assert.ok(primary.stdout.includes(`siblings: default/${h.project}/f3 (secondary)`), primary.stdout);
  const secondary = h.legionIn(h.repoRoot, 'feature', 'status', 'f3');
  assert.match(secondary.stdout, new RegExp(`initiative: ui-refresh \\(secondary of default/${h.project}/f2\\)`));
  // f1 carries no block, so it appears in neither grouping and prints no initiative line itself.
  // Asserted on the SIBLINGS LINE alone: the sandbox path is a random mkdtemp suffix and may
  // legitimately contain any short string, so a whole-stdout search here would flake.
  const siblingsLine = (out) => out.split('\n').find((l) => l.trim().startsWith('siblings:'));
  assert.equal(siblingsLine(secondary.stdout).trim(), `siblings: default/${h.project}/f2 (primary)`,
    'a non-carrier is not a sibling');
  assert.ok(!h.legionIn(h.repoRoot, 'feature', 'status', 'f1').stdout.includes('initiative:'));
  // Read-only: rendering the grouping wrote nothing.
  assertUnmoved(sec.dossier, before, 'feature status');
  assert.equal(h.legionIn(h.repoRoot, 'feature', 'status', 'f2').stdout, primary.stdout,
    'status is a projection — twice gives the same answer');
});

// =================================================================================================
// B2 — THE ORG BOUNDARY (T35): the initiative id namespace is scoped to the ORG
// =================================================================================================
// Operator decision 2026-07-30, PLAN-V3 §Initiatives amendment. THE DRIVING CASE ABOVE IS THE
// CONTROL and must stay green: an initiative spans PROJECTS, and every case in this file above
// runs in one org because that is what the FE+BE case is. What is removed here is T32's
// machine-wide scan, under which a reused id anywhere on the machine made every past initiative a
// link target — and the namespace never freed, since closed and abandoned primaries keep their
// dossiers and index entries forever. T32's header claimed a cross-org collision was "refused
// loudly (two primaries)"; it was not — it LINKED, exit 0. These cases pin the new boundary at
// BOTH call sites, because a status that grouped what a start refuses to link would be a grouping
// that lies, and they pin the warning that keeps the boundary's own residual (FE and BE
// accidentally registered under different orgs) from being a silent fork.

/** A second TENANCY: another org, with its own project and its own real repository. The project
 * name must differ from every other project in the sandbox regardless of org — the worktree tree
 * is keyed by project name alone. */
const otherOrg = (h, project = 'otherfe') => secondRepo(h, project, 'acme');

test('T35: the same id under ANOTHER ORG is a FRESH PRIMARY, and the fork is warned about by name', () => {
  const h = fixture(); // org `default`
  const be = startFeature(h, 'be1', '--initiative', 'span');
  assert.equal(be.r.code, 0, be.r.stderr);
  hostSharedArtifacts(be); // a COMPLETE, linkable primary: nothing is missing, the org is the only thing between them

  const acme = otherOrg(h);
  const s = acme.start('fe1', '--initiative', 'span');
  assert.equal(s.r.code, 0, `an id reused in another org must START, not refuse: ${s.r.stderr}`);
  // THE DECISION: a fresh primary. Under the machine-wide scan this silently became a SECONDARY of
  // default/<proj>/be1 and exited 0 — the mislink the old header promised could not happen.
  assert.deepEqual(s.readFeature().initiative, { id: 'span', role: 'primary' },
    'another org\'s carrier must not be a link target');
  assert.match(s.r.stdout, /initiative: span \(primary\)/);
  // THE FORK CLOSE: the accident this boundary makes possible (FE and BE registered under
  // different orgs) is LOUD. Asserted verbatim enough to pin BOTH org names and the carrier.
  assert.match(s.r.stdout, /warning: initiative span is ALSO carried outside org acme/);
  assert.ok(s.r.stdout.includes(`default/${h.project}/be1`),
    `the warning must name the foreign carrier's featureId, org included: ${s.r.stdout}`);
  assert.match(s.r.stdout, /ORGS DO NOT LINK/);
  assert.match(s.r.stdout, /must be registered under the same org \(acme\)/);
  // A WARNING, NEVER A REFUSAL: reusing an id across tenancies is legitimate, so the feature is
  // really started and really registered.
  assert.equal(s.readFeature().featureId, 'acme/otherfe/fe1');
  assert.ok(existsSync(s.worktree), 'the start was warned about, not refused');
});

test('T35: a COMPLETE foreign initiative (primary AND secondary) is not consulted for the decision', () => {
  // The shape that most looks like "you obviously meant to join this": another org holds a fully
  // linked pair under the id. The boundary is not a heuristic — the other org is never read on the
  // decision path at all, only to compose the warning.
  const { h } = linkedPair('span'); // default: f2 primary, f3 its secondary
  const acme = otherOrg(h);
  const s = acme.start('fe1', '--initiative', 'span');
  assert.equal(s.r.code, 0, s.r.stderr);
  assert.deepEqual(s.readFeature().initiative, { id: 'span', role: 'primary' });
  // The warning REPORTS what it found across orgs; it never picks one of them.
  assert.ok(s.r.stdout.includes(`default/${h.project}/f2`) && s.r.stdout.includes(`default/${h.project}/f3`),
    `both foreign carriers must be named: ${s.r.stdout}`);

  // POSITIVE CONTROL — the namespace works, it is merely this org's: a sibling registered under
  // the SAME org links normally, and a secondary derivation carries no fork warning at all (a
  // carrier was found here, so another org's reuse of the string is not news about this link).
  hostSharedArtifacts(s);
  const sib = acme.start('fe2', '--initiative', 'span');
  assert.equal(sib.r.code, 0, `the same-org sibling must link: ${sib.r.stderr}`);
  assert.equal(sib.readFeature().initiative.role, 'secondary');
  assert.equal(sib.readFeature().initiative.primary, 'acme/otherfe/fe1');
  assert.ok(!sib.r.stdout.includes('ALSO carried outside org'), sib.r.stdout);
});

test('T35: an unreadable manifest in ANOTHER ORG cannot veto this org\'s start — the in-org one still does', () => {
  const h = fixture();
  const acme = otherOrg(h);
  const spoiled = acme.start('junk', '--initiative', 'span'); // a carrier, in the other tenancy
  assert.equal(spoiled.r.code, 0, spoiled.r.stderr);
  writeFileSync(join(spoiled.dossier, 'feature.json'), '{ this is not json\n');

  // THE VETO SHRINKS WITH THE BOUNDARY: another tenancy's corrupt dossier is not a candidate
  // primary here, so it gets no say over whether this org may start an initiative.
  const ok = startFeature(h, 'f2', '--initiative', 'span');
  assert.equal(ok.r.code, 0, `another org's corrupt dossier must not refuse this start: ${ok.r.stderr}`);
  assert.deepEqual(ok.readFeature().initiative, { id: 'span', role: 'primary' });
  // The fork warning's own read SKIPS what it cannot parse rather than dying or refusing: it is
  // advisory, and a corrupt dossier elsewhere buying a veto is the over-reach this boundary removed.
  assert.ok(!ok.r.stdout.includes('ALSO carried outside org'), ok.r.stdout);

  // POSITIVE CONTROL for the refusal that REMAINS: unreadable IN THIS ORG still fails closed,
  // because that one might be this initiative's primary.
  const mine = startFeature(h, 'f3');
  assert.equal(mine.r.code, 0, mine.r.stderr);
  writeFileSync(join(mine.dossier, 'feature.json'), '{ this is not json\n');
  const s = startFeature(h, 'f4', '--initiative', 'span2');
  assert.equal(s.r.code, 1, 'an unreadable manifest in THIS org is still the one that might be the primary');
  assert.match(s.r.stderr, /cannot read the manifest of 1 registered feature\(s\) in org default/);
  assert.match(s.r.stderr, /f3/);
  assertNothingStarted(h, s);
});

test('T35: an index entry with NO USABLE ORG is UNREADABLE, not skipped by the boundary', () => {
  // THE ORDERING TRAP the org boundary introduces, pinned so it cannot come back: an entry whose
  // `org` is absent compares unequal to every real org, so a filter applied BEFORE the identity is
  // composed drops it from rows AND from unreadable — and the entry that cannot be placed in an
  // org is exactly the one that might BE this org's primary. Fail-open, silently, in the one
  // function whose docblock promises the opposite. (`project init` always writes `org`, so this
  // needs a damaged index — which is precisely the hand-edit the fail-closed rule exists for.)
  const h = fixture(); // org `default`
  const other = secondRepo(h, 'qproj'); // SAME org, second repository: the driving FE+BE shape
  const carrier = other.start('be1', '--initiative', 'span');
  assert.equal(carrier.r.code, 0, carrier.r.stderr);

  const idxPath = join(h.home, 'projects.json');
  const idx = JSON.parse(readFileSync(idxPath, 'utf8'));
  const entry = idx.projects.find((p) => p.name === 'qproj');
  assert.ok(entry != null, 'fixture: qproj must be registered');
  delete entry.org; // the damage: an entry belonging to no org
  writeFileSync(idxPath, `${JSON.stringify(idx, null, 2)}\n`);

  const s = startFeature(h, 'f2', '--initiative', 'span');
  assert.equal(s.r.code, 1,
    `an index entry that cannot be placed in an org must REFUSE, not be skipped: ${s.r.stdout}`);
  assert.match(s.r.stderr, /cannot read the manifest of 1 registered feature\(s\) in org default/);
  assert.match(s.r.stderr, /qproj\/be1/, s.r.stderr); // named, so the operator can repair the index
  assert.match(s.r.stderr, /invalid org/, s.r.stderr); // why it could not be read
  assertNothingStarted(h, s);
});

test('T35: `feature status` groups within the org — another org\'s carrier is never a sibling', () => {
  const { h } = linkedPair('span');
  const acme = otherOrg(h);
  const s = acme.start('fe1', '--initiative', 'span');
  assert.equal(s.r.code, 0, s.r.stderr);
  const siblingsLine = (out) => out.split('\n').find((l) => l.trim().startsWith('siblings:')).trim();

  // BOTH CALL SITES MUST AGREE. Were status still machine-wide, it would render default/<proj>/f2
  // as a sibling of this feature while `feature start` here refuses to link to it — a grouping
  // that shows a relationship the tool will not create.
  const there = h.legionIn(acme.repoRoot, 'feature', 'status', 'fe1');
  assert.equal(there.code, 0, there.stderr);
  assert.equal(siblingsLine(there.stdout), 'siblings: (none found)', there.stdout);
  // Symmetric: from `default`, the acme carrier is invisible and the in-org sibling is not.
  const here = h.legionIn(h.repoRoot, 'feature', 'status', 'f2');
  assert.equal(here.code, 0, here.stderr);
  assert.equal(siblingsLine(here.stdout), `siblings: default/${h.project}/f3 (secondary)`);
  assert.ok(!here.stdout.includes('acme/'), here.stdout);
});

// --- the refusals: every one leaves no trace -----------------------------------------------------

test('a secondary is refused when the primary has recorded no recap, naming the op that records it', () => {
  const h = fixture();
  const p = startFeature(h, 'f2', '--initiative', 'ui-refresh');
  assert.equal(p.r.code, 0, p.r.stderr);

  // No tasks.json at all: the primary has recorded nothing whatsoever.
  const s1 = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(s1.r.code, 1);
  assert.match(s1.r.stderr, /has no tasks\.json/);
  assert.match(s1.r.stderr, /legion state init/);
  assertNothingStarted(h, s1);

  // tasks.json, but no intent artifact — the recap does not exist yet.
  assert.equal(p.legion('state', 'init').code, 0);
  const pSnap = snapOf(p.dossier);
  const s2 = startFeature(h, 'f4', '--initiative', 'ui-refresh');
  assert.equal(s2.r.code, 1);
  assert.match(s2.r.stderr, /recorded no recap \(intent artifact\)/);
  assert.match(s2.r.stderr, /legion state artifact-record intent <path>/);
  assertNothingStarted(h, s2);
  assertUnmoved(p.dossier, pSnap, 'a refused secondary start must not touch the primary either');
});

test('a secondary is refused when the primary has recorded no CONTRACT (the recap alone is not enough)', () => {
  const h = fixture();
  const p = startFeature(h, 'f2', '--initiative', 'ui-refresh');
  assert.equal(p.legion('state', 'init').code, 0);
  p.writeArtifact('intent.md', '# recap\n');
  assert.equal(p.legion('state', 'artifact-record', 'intent', 'intent.md').code, 0);

  const s = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(s.r.code, 1);
  assert.match(s.r.stderr, /recorded no interface contract \(contract artifact\)/);
  assert.match(s.r.stderr, /legion state artifact-record contract <path>/);
  assertNothingStarted(h, s);

  // POSITIVE CONTROL: record the contract, agree the recap, and the same start lands. (The
  // agreement is checked LAST, after both artifacts — which is why the refusal above is still the
  // contract one and not the approval one.)
  p.writeArtifact('contract.md', '# contract\n');
  assert.equal(p.legion('state', 'artifact-record', 'contract', 'contract.md').code, 0);
  assert.equal(p.legion('state', 'decision-record', 'intake').code, 0);
  const ok2 = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(ok2.r.code, 0, ok2.r.stderr);
  assert.equal(ok2.readFeature().initiative.role, 'secondary');
});

test('a secondary is refused while the primary has NOT AGREED its own recap — the human gate is not deleted', () => {
  const h = fixture();
  const pri = startFeature(h, 'f2', '--initiative', 'ui-refresh');
  assert.equal(pri.r.code, 0, pri.r.stderr);
  // Everything the primary's session records EXCEPT the one thing a human does: both shared
  // artifacts, no `decision-record intake`. The plausible agent-error sequence is mundane — the
  // sibling session starts the FE feature before the human has answered the recap.
  const { recapPath } = hostSharedArtifacts(pri, { agree: false });
  const priSnap = snapOf(pri.dossier);

  const s = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(s.r.code, 1, 'linking a secondary to an UNAGREED recap must refuse');
  assert.match(s.r.stderr, /holds no hash-valid intake approval over its recap/);
  assert.ok(s.r.stderr.includes(recapPath), 'the refusal names the recap nobody has agreed');
  assert.match(s.r.stderr, /legion state decision-record intake/, 'and the op that records the agreement');
  assertNothingStarted(h, s);
  assertUnmoved(pri.dossier, priSnap, 'a refused secondary start must not touch the primary either');

  // POSITIVE CONTROL: the human answers the recap in the primary's session and the same start
  // lands — the door is closed, not wedged shut.
  assert.equal(pri.legion('state', 'decision-record', 'intake').code, 0);
  const ok = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(ok.r.code, 0, ok.r.stderr);
  assert.equal(ok.readFeature().initiative.role, 'secondary');
});

test('a primary whose recap DRIFTED since it was agreed cannot be linked either — a stale approval is no agreement', () => {
  const h = fixture();
  const pri = startFeature(h, 'f2', '--initiative', 'ui-refresh');
  const { recapPath } = hostSharedArtifacts(pri);
  // The human agreed to the recap as it was. Rewriting it afterwards invalidates the primary's own
  // intake approval (the ordinary M0 cascade), and a secondary must not be able to reference the
  // NEW bytes on the strength of a yes given to the OLD ones.
  writeFileSync(recapPath, '# recap\nrenegotiated after the agreement\n');
  const s = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(s.r.code, 1);
  assert.match(s.r.stderr, /holds no hash-valid intake approval over its recap/);
  assertNothingStarted(h, s);

  // POSITIVE CONTROL: re-record the artifact and re-agree — both, because either alone leaves the
  // approval bound to bytes that are not on disk.
  assert.equal(pri.legion('state', 'artifact-record', 'intent', 'intent.md').code, 0);
  assert.equal(pri.legion('state', 'decision-record', 'intake').code, 0);
  const ok = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(ok.r.code, 0, ok.r.stderr);
  assert.equal(ok.readFeature().initiative.recap.hash, sha256(readFileSync(recapPath)));
});

test('a secondary is refused when the primary\'s recap FILE is gone, not merely unrecorded', () => {
  const { h, recapPath } = linkedPair();
  rmSync(recapPath);
  const s = startFeature(h, 'f4', '--initiative', 'ui-refresh');
  assert.equal(s.r.code, 1);
  assert.match(s.r.stderr, /cannot be read/);
  assert.ok(s.r.stderr.includes(recapPath), 'the refusal names the path it could not read');
  assertNothingStarted(h, s);
});

test('two features claiming to be the PRIMARY of one initiative refuse the next sibling, naming both', () => {
  const { h, sec } = linkedPair(); // f2 primary, f3 legitimately its secondary
  // DELIBERATE FORGERY, and the only way to build this state: a hand-edited manifest is exactly
  // what a corrupted or improvised dossier looks like, and the derivation must refuse rather than
  // pick one. The kernel never writes two primaries itself — that is the claim under test.
  const secPath = join(sec.dossier, 'feature.json');
  const doc = JSON.parse(readFileSync(secPath, 'utf8'));
  writeFileSync(secPath, `${JSON.stringify({ ...doc, initiative: { id: 'ui-refresh', role: 'primary' } }, null, 2)}\n`);

  const s = startFeature(h, 'f4', '--initiative', 'ui-refresh');
  assert.equal(s.r.code, 1);
  assert.match(s.r.stderr, /2 features already claim to be the PRIMARY/);
  assert.match(s.r.stderr, /f2/);
  assert.match(s.r.stderr, /f3/);
  assertNothingStarted(h, s);
});

test('carriers with NO primary refuse rather than guessing which sibling hosts the artifacts', () => {
  const h = fixture();
  const p = startFeature(h, 'f2', '--initiative', 'ui-refresh');
  const f2Path = join(p.dossier, 'feature.json');
  const doc = JSON.parse(readFileSync(f2Path, 'utf8'));
  writeFileSync(f2Path, `${JSON.stringify({ ...doc, initiative: { id: 'ui-refresh', role: 'secondary' } }, null, 2)}\n`);

  const s = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(s.r.code, 1);
  assert.match(s.r.stderr, /NONE of them is the primary/);
  assertNothingStarted(h, s);
});

test('a manifest the scan cannot READ refuses the start — it is the one that might be the primary', () => {
  const h = fixture();
  const other = startFeature(h, 'f2'); // carries no initiative at all — and that is the point
  assert.equal(other.r.code, 0, other.r.stderr);
  writeFileSync(join(other.dossier, 'feature.json'), '{ this is not json\n');

  const s = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(s.r.code, 1);
  assert.match(s.r.stderr, /cannot read the manifest of 1 registered feature/);
  assert.match(s.r.stderr, /f2/);
  assertNothingStarted(h, s);
});

test('a primary artifact edited since it was recorded binds the secondary to the LIVE bytes, loudly', () => {
  const h = fixture();
  const pri = startFeature(h, 'f2', '--initiative', 'ui-refresh');
  const { contractPath } = hostSharedArtifacts(pri);
  const recorded = sha256(readFileSync(contractPath));
  writeFileSync(contractPath, '# contract\nGET /widgets -> {id, name, colour}\n');
  const live = sha256(readFileSync(contractPath));

  const sec = startFeature(h, 'f3', '--initiative', 'ui-refresh');
  assert.equal(sec.r.code, 0, sec.r.stderr);
  // The reference is DERIVED from the bytes on disk, never copied from what the primary once
  // recorded — recording the primary's stale belief would be exactly the caller-supplied hash the
  // kernel refuses everywhere else. But it is not silent: the primary's own approvals over that
  // artifact no longer validate, and that is the first thing the operator needs to know.
  assert.equal(sec.readFeature().initiative.contract.hash, live);
  assert.ok(sec.r.stdout.includes(recorded) && sec.r.stdout.includes(live),
    'the drift warning names both the recorded and the live hash');
  assert.match(sec.r.stdout, /has CHANGED since it was recorded/);
});

test('a hand-edited block with no usable recap reference FAILS CLOSED at stage-complete intake', () => {
  const pair = linkedPair();
  const sec = secondaryAtIntake(pair);
  const p = join(sec.dossier, 'feature.json');
  const doc = JSON.parse(readFileSync(p, 'utf8'));
  // The manifest claims the role that unlocks the alternative while carrying nothing to validate.
  writeFileSync(p, `${JSON.stringify({ ...doc, initiative: { id: 'ui-refresh', role: 'secondary' } }, null, 2)}\n`);
  const snap = snapOf(sec.dossier);
  const r = sec.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 1, 'a role with no reference must never satisfy the row');
  assert.match(r.stderr, /carries no usable recap reference/);
  assertUnmoved(sec.dossier, snap, 'refused by-reference intake (malformed block)');
});

test('--initiative refuses a malformed id, and refuses to combine with --repair', () => {
  const h = fixture();
  for (const bad of ['../evil', 'has space', '.hidden', '']) {
    const s = startFeature(h, 'f2', `--initiative=${bad}`);
    assert.equal(s.r.code, 1, `--initiative '${bad}' must be refused (it becomes a path-shaped id)`);
    assert.match(s.r.stderr, /invalid initiative id/);
    assertNothingStarted(h, s);
  }
  // --repair re-derives NOTHING, and an initiative block is nothing but derived evidence, so the
  // flag is REFUSED rather than silently ignored — the same rule --add-repo already obeys.
  const r = h.legionIn(h.repoRoot, 'feature', 'start', 'f1', '--base', 'main', '--repair', '--initiative', 'ui-refresh');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--initiative cannot be combined with --repair/);
});

// =================================================================================================
// C — by-reference intake: the ONE additive prerequisite clause
// =================================================================================================
// PLAN-V3 §State `stage-complete intake`, rev 6: for a SECONDARY the recap-and-agreement half may
// be satisfied by the recap REFERENCE validating NOW. The recap happened once, with the human, in
// the primary's session; a second recap conversation is ceremony and a rubber stamp is a silent
// invariant break. What keeps the guarantee real is that the reference is re-derived on every call.

/** A secondary standing exactly where intake is completed: its OWN intent artifact recorded (that
 * clause is per-feature and untouched), its OWN profile classified, and DELIBERATELY NO intake
 * approval — the whole point of the case. */
function secondaryAtIntake(pair, { classify = 'express' } = {}) {
  const { sec } = pair;
  assert.equal(sec.legion('state', 'init').code, 0);
  sec.writeArtifact('intent.md', '# intent\nthe FE half of the agreed change\n');
  assert.equal(sec.legion('state', 'artifact-record', 'intent', 'intent.md').code, 0);
  if (classify) assert.equal(sec.legion('state', 'escalate-profile', classify).code, 0);
  assert.equal(JSON.parse(readFileSync(join(sec.dossier, 'tasks.json'), 'utf8')).approvals.intake, undefined,
    'the case is meaningless if an intake approval exists');
  return sec;
}

test('a SECONDARY completes intake with NO intake approval — the recap reference validates now', () => {
  const pair = linkedPair();
  const sec = secondaryAtIntake(pair);
  const r = sec.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 0, `by-reference intake must be accepted: ${r.stderr}`);
  assert.equal(JSON.parse(readFileSync(join(sec.dossier, 'feature.json'), 'utf8')).completedStages.at(-1).stage, 'intake');
  // THE CONTROL that keeps this from reading as a global weakening: an ORDINARY feature in exactly
  // the same state (intent recorded, profile classified, no approval) still refuses.
  const plain = startFeature(pair.h, 'f4');
  assert.equal(plain.r.code, 0, plain.r.stderr);
  assert.equal(plain.legion('state', 'init').code, 0);
  plain.writeArtifact('intent.md', '# intent\n');
  assert.equal(plain.legion('state', 'artifact-record', 'intent', 'intent.md').code, 0);
  assert.equal(plain.legion('state', 'escalate-profile', 'express').code, 0);
  const p = plain.legion('state', 'stage-complete', 'intake');
  assert.equal(p.code, 1, 'a non-initiative feature must still need its own intake approval');
  assert.match(p.stderr, /no hash-valid intake approval/);
});

test('by-reference intake REFUSES when the primary\'s recap is deleted, naming the path and the remedy', () => {
  const pair = linkedPair();
  const sec = secondaryAtIntake(pair);
  rmSync(pair.recapPath);
  const snap = snapOf(sec.dossier);
  const r = sec.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /recap REFERENCE does not validate/);
  assert.ok(r.stderr.includes(pair.recapPath), 'the refusal names the referenced path');
  assert.match(r.stderr, /GONE/);
  assert.match(r.stderr, /decision-record intake/, 'and the remedy: re-agree in THIS feature');
  assertUnmoved(sec.dossier, snap, 'refused by-reference intake (recap deleted)');

  // POSITIVE CONTROL, and the "alternative, not replacement" half: a secondary that held its own
  // recap conversation is not punished for the primary's missing file.
  sec.writeArtifact('intent.md', '# intent\nthe FE half of the agreed change\n');
  assert.equal(sec.legion('state', 'decision-record', 'intake').code, 0);
  assert.equal(sec.legion('state', 'stage-complete', 'intake').code, 0);
});

test('by-reference intake REFUSES on an EDITED recap, naming both hashes', () => {
  const pair = linkedPair();
  const sec = secondaryAtIntake(pair);
  const before = sha256(readFileSync(pair.recapPath));
  writeFileSync(pair.recapPath, '# recap\nwe agreed on something ELSE entirely\n');
  const after = sha256(readFileSync(pair.recapPath));
  const snap = snapOf(sec.dossier);

  const r = sec.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /CHANGED/);
  assert.ok(r.stderr.includes(before), 'names the hash the reference was derived against');
  assert.ok(r.stderr.includes(after), 'and the live hash it no longer matches');
  assertUnmoved(sec.dossier, snap, 'refused by-reference intake (recap edited)');

  // POSITIVE CONTROL: restore the exact bytes and the same op is accepted — the reference is a
  // claim about CONTENT, not about a file's mtime or its existence at some earlier moment.
  writeFileSync(pair.recapPath, '# recap\nwe agreed on the FE+BE change\n');
  assert.equal(sha256(readFileSync(pair.recapPath)), before, 'restored byte-for-byte');
  assert.equal(sec.legion('state', 'stage-complete', 'intake').code, 0);
});

test('CLASSIFICATION IS NEVER BY REFERENCE — a valid recap ref does not excuse an unclassified profile', () => {
  const pair = linkedPair();
  const sec = secondaryAtIntake(pair, { classify: null });
  const snap = snapOf(sec.dossier);
  const r = sec.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /profile is 'unclassified'/);
  assert.match(r.stderr, /escalate-profile/);
  assertUnmoved(sec.dossier, snap, 'refused by-reference intake (unclassified)');
  // Profiles are fully independent per sibling: the primary's classification is irrelevant here.
  assert.equal(sec.legion('state', 'escalate-profile', 'standard').code, 0);
  assert.equal(sec.legion('state', 'stage-complete', 'intake').code, 0);
});

test('the INTENT-ARTIFACT clause stays per-feature — a secondary with a valid ref still records its own', () => {
  const pair = linkedPair();
  assert.equal(pair.sec.legion('state', 'init').code, 0);
  assert.equal(pair.sec.legion('state', 'escalate-profile', 'express').code, 0);
  const r = pair.sec.legion('state', 'stage-complete', 'intake');
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no intent artifact recorded/);
});

test('a recap edited AFTER intake completed poisons the PREFIX — the next forward stage-enter refuses', () => {
  const pair = linkedPair();
  const sec = secondaryAtIntake(pair);
  assert.equal(sec.legion('state', 'stage-complete', 'intake').code, 0);

  // The stage machine re-derives the WHOLE prefix on every forward hop (PLAN-V3 §State corollary
  // 1) — completing intake once is not evidence that intake is STILL satisfied. This is the
  // threat model's centre: a secondary must never build on a recap that has since moved.
  writeFileSync(pair.recapPath, '# recap\nrenegotiated after the fact\n');
  const snap = snapOf(sec.dossier);
  const r = sec.legion('state', 'stage-enter', 'spec');
  assert.equal(r.code, 1, 'a completed stage is a fact about evidence that no longer holds');
  assert.match(r.stderr, /stage 'intake' does not re-derive satisfied/);
  assert.match(r.stderr, /CHANGED/);
  assertUnmoved(sec.dossier, snap, 'refused stage-enter after a recap edit');

  // POSITIVE CONTROL: re-agree in this feature (the human looked at the new recap) and the hop
  // lands — the door was closed, not wedged shut.
  assert.equal(sec.legion('state', 'decision-record', 'intake').code, 0);
  assert.equal(sec.legion('state', 'stage-enter', 'spec').code, 0);
});

test('the reference survives the primary being ABANDONED — abandon never deletes a dossier', () => {
  const pair = linkedPair();
  const sec = secondaryAtIntake(pair);
  const r = pair.h.legionIn(pair.h.repoRoot, 'feature', 'abandon', 'f2'); // the PRIMARY
  assert.equal(r.code, 0, r.stderr);
  // PLAN-V3 §Startup states this consequence explicitly: the dossier (and therefore every
  // referenced artifact in it) outlives the feature, which is what makes path+hash refs safe.
  assert.ok(existsSync(pair.recapPath), 'abandon must not delete the dossier');
  assert.equal(sec.legion('state', 'stage-complete', 'intake').code, 0);
});
