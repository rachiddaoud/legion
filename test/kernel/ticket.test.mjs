// Guards src/kernel/ticket.mjs — THE ticket-ref validator and THE read-time config resolver (T36).
//
// TWO CLAIMS THIS FILE EXISTS TO PIN, both straight out of the threat model (the adversary is agent
// error and drift, not a malicious operator):
//   1. THE KERNEL JUDGES GARBAGE AND NOTHING ELSE. A ticket ref is operator-supplied DATA: the
//      validator must accept the documented shapes verbatim (never normalising them — the manifest
//      records what the operator typed) and refuse the empty string, whitespace, control bytes and
//      absurd lengths. A well-formed-but-wrong ref is NOT a case this file tries to catch; it is
//      indistinguishable from a right one by construction.
//   2. CONFIG IS RESOLVED AT READ TIME AND PINNED NOWHERE, PER FIELD, AND A BROKEN ORG.JSON IS
//      NEVER READ AS AN ABSENT ONE. The precedence cases below drive each level independently, the
//      compose case proves the merge is per-field rather than whole-object, and the corrupt case
//      proves the loud refusal — the one that a resolver "hardened" with a try/catch would silently
//      turn into "no config", changing what legion writes into an MR body with nobody the wiser.
// Hermetic: LEGION_HOME points at a temp dir per file and is restored after (paths.mjs reads it
// lazily at every call, so setting it after import is both legal and the point). No git, no
// network, no child processes — this layer touches neither.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ORG_CONFIG_KEYS, TICKET_CLOSING_STYLES, TICKET_CONFIG_DEFAULTS, TICKET_CONFIG_KEYS,
  closingKeyword, resolveForge, resolveTicketConfig, validateClosingStyle, validateConfigFields,
  validateTicketProject, validateTicketRef,
} from '../../src/kernel/ticket.mjs';

const SAVED = process.env.LEGION_HOME;
let HOME;
before(() => {
  HOME = mkdtempSync(join(tmpdir(), 'legion3-ticket-'));
  process.env.LEGION_HOME = HOME;
});
after(() => {
  if (SAVED === undefined) delete process.env.LEGION_HOME;
  else process.env.LEGION_HOME = SAVED;
  rmSync(HOME, { recursive: true, force: true });
});

const CTRL = String.fromCharCode(7); // BEL — a control byte, the kind a paste can carry invisibly
const writeJson = (p, doc) => writeFileSync(p, `${JSON.stringify(doc, null, 2)}\n`);

let n = 0;
/** A fresh org/project pair under the temp home. Neither config file is created — every case
 * writes exactly the levels it is about, so "absent" is the default rather than a leftover. */
function idents() {
  const org = `org${n++}`;
  const project = 'proj';
  mkdirSync(join(HOME, 'orgs', org, 'projects', project), { recursive: true });
  return {
    org,
    project,
    orgPath: join(HOME, 'orgs', org, 'org.json'),
    projectPath: join(HOME, 'orgs', org, 'projects', project, 'project.json'),
  };
}

// --- the ref validator -------------------------------------------------------------------------

test('the documented shapes are accepted, and the ref is stored VERBATIM', () => {
  assert.deepEqual(validateTicketRef('123', '--ticket'), { ref: '123', project: null, iid: '123' });
  assert.deepEqual(validateTicketRef('#123', '--ticket'), { ref: '#123', project: null, iid: '123' });
  // The bare and hashed forms stay DISTINCT refs: nothing normalises '123' into '#123', because the
  // manifest must show the operator what they typed.
  assert.equal(validateTicketRef('123', '--ticket').ref, '123');
  assert.deepEqual(validateTicketRef('group/project#7', '--ticket'),
    { ref: 'group/project#7', project: 'group/project', iid: '7' });
  assert.deepEqual(validateTicketRef('group/sub_group/my.proj-x#4210', '--ticket'),
    { ref: 'group/sub_group/my.proj-x#4210', project: 'group/sub_group/my.proj-x', iid: '4210' });
});

test('garbage is refused — empty, whitespace, control bytes, and everything outside the shapes', () => {
  const bad = [
    '', ' ', '  ', '\t', '\n', '#', '#0', '0', '007', '#007', 'abc', '#12a', '12a',
    ' 123', '123 ', '#123 ', 'proj#1', '/proj#1', 'a//b#1', 'a/b#0', 'a/b#', 'a/b',
    `a${CTRL}b#1`, `12${CTRL}`, `#${'1'.repeat(300)}`, 'x'.repeat(400),
    undefined, null, 42, {}, ['123'],
  ];
  for (const v of bad) {
    assert.throws(
      () => validateTicketRef(v, '--ticket'),
      (e) => {
        assert.match(e.message, /^--ticket: /, `the refusal must name the surface for ${JSON.stringify(v)}`);
        assert.match(e.message, /'123', '#123' or 'group\/project#123'/,
          `the refusal must name the accepted shapes for ${JSON.stringify(v)}`);
        return true;
      },
      `${JSON.stringify(v)} must be refused`,
    );
  }
});

test('the refusal says the kernel never DERIVES a ref — refusing to guess is the design', () => {
  assert.throws(() => validateTicketRef('', 'ticket-record <ref>'),
    /ticket-record <ref>: the reference is empty.*never derives one from the branch, the commits or the MR/s);
});

// --- the config field validators ---------------------------------------------------------------

test('the closing style is a small ENUM, never a free template string', () => {
  assert.deepEqual(TICKET_CLOSING_STYLES, ['closes', 'fixes', 'resolves', 'refs']);
  for (const s of TICKET_CLOSING_STYLES) assert.equal(validateClosingStyle(s, 'x'), s);
  assert.equal(closingKeyword('closes'), 'Closes');
  assert.equal(closingKeyword('refs'), 'Refs');
  // A template would be an injection surface into the MR body — the whole reason for the enum.
  for (const bad of ['Closes', 'CLOSES', 'closes #{n}', 'closes\nX-Evil: 1', '', null, 7, undefined]) {
    assert.throws(() => validateClosingStyle(bad, 'org.json ticketClosingStyle'),
      /invalid ticket closing style.*closes\|fixes\|resolves\|refs/s, `${JSON.stringify(bad)} must be refused`);
  }
  assert.throws(() => closingKeyword('nope'), /unknown ticket closing style 'nope'/);
});

test('the ticket project is judged for GARBAGE only — glab is the authority on what resolves', () => {
  for (const ok of ['ABC', 'group/project', 'group/sub/project', 'A-B_c.d']) {
    assert.equal(validateTicketProject(ok, 'x'), ok);
  }
  for (const bad of ['', ' ', 'a b', `a${CTRL}b`, 'x'.repeat(400), null, undefined, 7, {}]) {
    assert.throws(() => validateTicketProject(bad, '--ticket-project'),
      /--ticket-project: invalid ticket project/, `${JSON.stringify(bad)} must be refused`);
  }
});

// --- the resolver: precedence, per field ---------------------------------------------------------

test('with no org.json and no project.json the PLUGIN DEFAULT applies, and says so', () => {
  const { org, project } = idents();
  const r = resolveTicketConfig(org, project);
  assert.deepEqual(r, {
    ticketProject: { value: null, from: 'plugin default' },
    ticketClosingStyle: { value: 'closes', from: 'plugin default' },
  });
  // null ticketProject means "the code repo's own project" — the kernel does not spell out a path
  // the forge already knows.
  assert.equal(TICKET_CONFIG_DEFAULTS.ticketProject, null);
  assert.equal(TICKET_CONFIG_DEFAULTS.ticketClosingStyle, 'closes');
});

test('org.json overrides the default; project.json overrides org — and each field says WHICH', () => {
  const { org, project, orgPath, projectPath } = idents();
  writeJson(orgPath, { ticketProject: 'acme/issues', ticketClosingStyle: 'fixes' });
  let r = resolveTicketConfig(org, project);
  assert.deepEqual(r, {
    ticketProject: { value: 'acme/issues', from: 'org' },
    ticketClosingStyle: { value: 'fixes', from: 'org' },
  });

  writeJson(projectPath, { schemaVersion: 1, ticketProject: 'acme/other', ticketClosingStyle: 'refs' });
  r = resolveTicketConfig(org, project);
  assert.deepEqual(r, {
    ticketProject: { value: 'acme/other', from: 'project' },
    ticketClosingStyle: { value: 'refs', from: 'project' },
  });
});

test('the merge is PER FIELD: an org ticketProject and a project style compose', () => {
  const { org, project, orgPath, projectPath } = idents();
  writeJson(orgPath, { ticketProject: 'acme/issues' });
  writeJson(projectPath, { schemaVersion: 1, ticketClosingStyle: 'resolves' });
  assert.deepEqual(resolveTicketConfig(org, project), {
    ticketProject: { value: 'acme/issues', from: 'org' },
    ticketClosingStyle: { value: 'resolves', from: 'project' },
  });
});

test('null at a level is UNSET and falls through — a scaffolded project.json cannot shadow an org', () => {
  const { org, project, orgPath, projectPath } = idents();
  writeJson(orgPath, { ticketProject: 'acme/issues', ticketClosingStyle: 'fixes' });
  // Exactly what `legion project init` scaffolds when neither flag was passed.
  writeJson(projectPath, { schemaVersion: 1, ticketProject: null, ticketClosingStyle: null });
  assert.deepEqual(resolveTicketConfig(org, project), {
    ticketProject: { value: 'acme/issues', from: 'org' },
    ticketClosingStyle: { value: 'fixes', from: 'org' },
  });
});

test('resolution is at READ TIME: editing org.json changes the NEXT call, nothing is pinned', () => {
  const { org, project, orgPath } = idents();
  writeJson(orgPath, { ticketClosingStyle: 'fixes' });
  assert.equal(resolveTicketConfig(org, project).ticketClosingStyle.value, 'fixes');
  writeJson(orgPath, { ticketClosingStyle: 'refs' });
  assert.equal(resolveTicketConfig(org, project).ticketClosingStyle.value, 'refs',
    'a ticket format is not evidence-bearing, so it is resolved at the moment of use — never pinned');
  rmSync(orgPath);
  assert.equal(resolveTicketConfig(org, project).ticketClosingStyle.value, 'closes');
});

// --- the resolver: absent is silent, BROKEN is loud ------------------------------------------------

test('an absent org.json is silent — most orgs will never have one', () => {
  const { org, project, projectPath } = idents();
  writeJson(projectPath, { schemaVersion: 1, ticketProject: 'acme/x' });
  assert.deepEqual(resolveTicketConfig(org, project).ticketProject, { value: 'acme/x', from: 'project' });
});

test('a PRESENT but unparseable org.json REFUSES loudly naming the path — never read as absent', () => {
  const { org, project, orgPath } = idents();
  writeFileSync(orgPath, '{ this is not json\n');
  assert.throws(() => resolveTicketConfig(org, project), (e) => {
    assert.ok(e.message.includes(orgPath), 'the refusal must name the file');
    assert.match(e.message, /NOT treated as absent/);
    return true;
  });
});

test('a present org.json with an unknown KEY refuses by name — a typo must not be ignored', () => {
  const { org, project, orgPath } = idents();
  writeJson(orgPath, { ticketCloseStyle: 'fixes' }); // the plausible typo
  assert.throws(() => resolveTicketConfig(org, project),
    /unknown key\(s\) ticketCloseStyle .* configures exactly ticketProject, ticketClosingStyle, forge/s);
  assert.deepEqual(TICKET_CONFIG_KEYS, ['ticketProject', 'ticketClosingStyle']);
  assert.deepEqual(ORG_CONFIG_KEYS, ['ticketProject', 'ticketClosingStyle', 'forge']);
});

test('a present org.json with an INVALID value refuses, naming the file and the field', () => {
  const { org, project, orgPath } = idents();
  writeJson(orgPath, { ticketClosingStyle: 'Closes' });
  assert.throws(() => resolveTicketConfig(org, project),
    (e) => e.message.includes(orgPath) && /ticketClosingStyle: invalid ticket closing style/.test(e.message));
  writeJson(orgPath, { ticketProject: '' });
  assert.throws(() => resolveTicketConfig(org, project),
    (e) => e.message.includes(orgPath) && /ticketProject: invalid ticket project/.test(e.message));
});

test('an org.json that is not a JSON OBJECT refuses too', () => {
  const { org, project, orgPath } = idents();
  for (const doc of [['ticketProject'], 'acme/x', 42, null]) {
    writeJson(orgPath, doc);
    assert.throws(() => resolveTicketConfig(org, project),
      (e) => e.message.includes(orgPath), `${JSON.stringify(doc)} must be refused`);
  }
});

test('a project.json carrying an invalid ticket field refuses at the project level as well', () => {
  const { org, project, projectPath } = idents();
  writeJson(projectPath, { schemaVersion: 1, ticketClosingStyle: 'nope' });
  assert.throws(() => resolveTicketConfig(org, project),
    (e) => e.message.includes(projectPath) && /invalid ticket closing style/.test(e.message));
});

test('project.json is NOT key-strict — it carries a dozen unrelated keys by design', () => {
  const { org, project, projectPath } = idents();
  writeJson(projectPath, {
    schemaVersion: 1, org, name: project, gates: {}, bootstrap: [], notify: null,
    ticketClosingStyle: 'refs',
  });
  assert.deepEqual(resolveTicketConfig(org, project).ticketClosingStyle, { value: 'refs', from: 'project' });
  // …while validateConfigFields with strictKeys IS org.json's rule, and only org.json's.
  assert.throws(() => validateConfigFields({ gates: {} }, '/x/org.json', { strictKeys: true }), /unknown key/);
  assert.doesNotThrow(() => validateConfigFields({ gates: {} }, '/x/project.json'));
});

// --- resolveForge (2026-08-15 — the second forge) ------------------------------------------------
// The same read-time, per-level, loud-on-broken contract as the ticket config above, plus the
// URL-detection fallback that keeps every pre-forge-field project resolving exactly as before.

test('an ORG-WIDE forge survives a project.json that `legion project init` actually writes', () => {
  // THE HOLE THIS PINS (2026-08-15): init used to record a concrete detected `forge`, which sits
  // ABOVE org.json — so for every project registered after that change the documented org-wide
  // override was dead config, and the precedence test below could not see it because it wrote a
  // project.json shape init no longer produced. The fixture here is init's REAL output: every
  // operator-owned field scaffolded as null.
  const { org, project, orgPath, projectPath } = idents();
  writeJson(orgPath, { forge: 'github' }); // the GHES-on-its-own-domain hatch, org-wide
  writeJson(projectPath, {
    schemaVersion: 1, org, name: project, remoteUrl: 'git@ghes.acme.invalid:acme/svc.git',
    forge: null, ticketProject: null, ticketClosingStyle: null, notify: null,
  });
  // Detection cannot see GHES and would say 'gitlab'; the org override is what must win.
  assert.deepEqual(resolveForge(org, project), { value: 'github', from: 'org' });
});

test('resolveForge precedence: project.json forge wins over org.json, org over detection, detection over default', () => {
  const { org, project, orgPath, projectPath } = idents();
  // Nothing anywhere: the plugin default.
  assert.deepEqual(resolveForge(org, project), { value: 'gitlab', from: 'default' });
  // A recorded github remote, no forge field anywhere (the pre-existing-file case): detection.
  writeJson(projectPath, { schemaVersion: 1, remoteUrl: 'git@github.com:acme/proj.git' });
  assert.deepEqual(resolveForge(org, project), { value: 'github', from: 'remote url (github.com)' });
  // An org override beats detection (the GHES-on-its-own-domain escape hatch, org-wide).
  writeJson(orgPath, { forge: 'gitlab' });
  assert.deepEqual(resolveForge(org, project), { value: 'gitlab', from: 'org' });
  // A project field beats the org.
  writeJson(projectPath, { schemaVersion: 1, remoteUrl: 'git@github.com:acme/proj.git', forge: 'github' });
  assert.deepEqual(resolveForge(org, project), { value: 'github', from: 'project' });
});

test('resolveForge falls back to a caller-supplied remoteUrl only when project.json records none', () => {
  const { org, project, projectPath } = idents();
  // No project.json at all: the caller's URL decides.
  assert.deepEqual(
    resolveForge(org, project, { remoteUrl: 'https://github.com/acme/proj.git' }),
    { value: 'github', from: 'remote url (github.com)' },
  );
  // project.json's own recorded remote wins over the caller's.
  writeJson(projectPath, { schemaVersion: 1, remoteUrl: 'git@gitlab.invalid:acme/proj.git' });
  assert.deepEqual(
    resolveForge(org, project, { remoteUrl: 'https://github.com/acme/proj.git' }),
    { value: 'gitlab', from: 'remote url (gitlab.invalid)' },
  );
});

test('resolveForge refuses loudly on a broken level — never reads it as absent', () => {
  const { org, project, orgPath, projectPath } = idents();
  writeFileSync(orgPath, '{ not json\n');
  assert.throws(() => resolveForge(org, project), (e) => e.message.includes(orgPath));
  writeJson(orgPath, { forge: 'bitbucket' });
  assert.throws(() => resolveForge(org, project), /forge: invalid forge "bitbucket"/);
  writeJson(orgPath, { forje: 'github' }); // org.json stays key-strict for the new key too
  assert.throws(() => resolveForge(org, project), /unknown key\(s\) forje/);
  rmSync(orgPath);
  writeJson(projectPath, { schemaVersion: 1, forge: 'gh' }); // the plausible wrong spelling
  assert.throws(() => resolveForge(org, project), /invalid forge "gh".*gitlab\|github/s);
});
