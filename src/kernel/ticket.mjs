// ticket.mjs — THE ticket-reference validator and THE read-time config resolver family.
// SUPERSEDED DECISION, reversed 2026-08-15: this header used to state "glab is the forge, so
// there is no adapter, no second provider and no field here that anticipates one." Two forges
// exist now — gitlab (glab) and github (gh) — and the SELECTOR is one more piece of
// non-evidence-bearing operator config resolved exactly like the ticket fields: read fresh at
// the moment of use, pinned nowhere (kernel/forge.mjs holds the pure detection/validation;
// resolveForge below is the one reader of the config levels). Three things live in this
// file and nothing else: what a ticket REF may look like, where the rendering CONFIG comes
// from, and which FORGE a project talks to. All are imported by every consumer — `feature
// start --ticket`, `legion state ticket-record`, `legion project init`, `legion doctor`,
// `legion finalize` — because a second copy of any would drift, and the halves that would then
// disagree are the flag and the op (one accepting what the other refuses), the MR/PR body and
// the issue comment (one rendering what the other does not), and the CLI doctor verifies
// versus the CLI finalize drives.
//
// THE TICKET IS OPERATOR-SUPPLIED DATA, NEVER EVIDENCE, AND THAT IS THE DESIGN. Everywhere else
// in this kernel a caller-supplied identifier is refused on sight (a model
// handed `--subject-hash` could bless anything) — here the operator hands legion a string and
// legion stores it verbatim. The distinction is not a lapse, it is what a ticket IS: no approval
// binds it, no hash pins it, no gate reads it, nothing downstream trusts it to prove anything. It
// is a POINTER AT A HUMAN CONVERSATION, and the only thing this kernel can honestly judge about a
// pointer is whether it is syntactic garbage. So validateTicketRef refuses the empty string, the
// whitespace-only string, control bytes and anything outside the documented shapes — and stops
// there. A well-formed ref naming the WRONG issue is the operator's own data, indistinguishable
// from a right one by construction; naming discipline is theirs, not ours.
// AND THE KERNEL NEVER DERIVES ONE. Not from the branch name, not from the commit subjects, not
// from the MR title. A guessed ref would post process metadata onto a stranger's issue — the one
// failure that reaches a HUMAN who never opted in. Absent a supplied ref, a feature is simply
// ticket-less, and every ticket-bearing behaviour is skipped whole.
//
// CONFIG IS RESOLVED AT READ TIME — THE MOMENT OF USE — AND IS PINNED NOWHERE. Contrast the gate
// command policy, which IS pinned into feature.json at `feature start`: that pin
// exists because the policy is EVIDENCE-BEARING — a receipt certifies a tree UNDER a policy, so
// letting the policy move underneath a feature would let an agent weaken it and re-gate. A ticket
// format certifies nothing. Pinning it would buy no guarantee and cost the operator the ability to
// fix a wrong closing keyword without restarting the feature, so resolution happens on every call
// and the resolved value is written into no manifest and no receipt.
//
// THREE LEVELS, PER FIELD, IN THIS ORDER: plugin default → ~/.legion/orgs/<org>/org.json →
// ~/.legion/orgs/<org>/projects/<p>/project.json. The composition is PER FIELD, never
// whole-object: an org that sets only `ticketProject` and a project that sets only
// `ticketClosingStyle` compose into one config carrying both. `null` at a level means UNSET at
// that level and falls through — it is not "explicitly none", which is why `project init` writing
// `ticketProject: null` into every fresh project.json does not shadow an org-level value. Stated
// consequence, accepted: an org-level ticketProject cannot be un-set from the project level, only
// overridden with another value; nobody has needed the opposite and a third state ("explicitly the
// code repo's own project") would be config surface bought on speculation (decision 14).
//
// ORG.JSON: ABSENT IS FINE AND SILENT; PRESENT-BUT-UNREADABLE REFUSES LOUDLY. Most orgs will never
// have one, so its absence cannot be a warning. But a file that EXISTS and cannot be parsed, or
// carries an unknown key, or an invalid value, is NOT treated as absent: swallowing it would
// silently change what legion writes into an MR body and an issue tracker, and the operator would
// read their own override as applied while the default was in force. Unknown keys refuse by name
// for the same reason — a typo'd `ticketCloseStyle` that is silently ignored is exactly that
// failure with a friendlier face. Growing this file means growing ORG_CONFIG_KEYS deliberately.
import { existsSync } from 'node:fs';
import { DEFAULT_FORGE, detectForge, remoteHost, validateForge } from './forge.mjs';
import { readJson } from './fsatomic.mjs';
import { orgConfigPath, projectConfigPath } from './paths.mjs';

/** A GitLab issue iid starts at 1, so `0` and zero-padded forms are refused rather than passed
 * through to a lookup that can only fail later, further from the operator who typed it. The digit
 * cap keeps a pathological ref out of an MR body line and out of a refusal message. */
const IID = String.raw`[1-9][0-9]{0,9}`;
/** GitLab path segments, loosely (decision 14 — glab is the authority on what actually resolves;
 * this is a garbage filter, not a re-implementation of GitLab's routing). Letter/digit/underscore
 * first, then letters/digits/dot/dash/underscore. Two or more segments: `group/project`,
 * `group/sub/project`. A single bare segment is refused because `foo#1` is far more likely to be a
 * typo than a real cross-project reference. */
const SEG = String.raw`[A-Za-z0-9_][A-Za-z0-9._-]*`;
const BARE_REF_RE = new RegExp(`^#?(${IID})$`);
const QUALIFIED_REF_RE = new RegExp(`^(${SEG}(?:/${SEG})+)#(${IID})$`);
/** Bounded so a refusal message, an MR body line and an issue comment all stay one readable line. */
const MAX_REF_LEN = 200;

/** Whitespace of any kind plus the C0 controls and DEL — the 'garbage' half of the only
 * judgment this kernel makes about operator-supplied ticket data (header). */
const CTRL_OR_SPACE_RE = /[\s\u0000-\u001f\u007f]/;

export const TICKET_REF_SHAPES = "'123', '#123' or 'group/project#123'";

/**
 * THE one validator (header). Returns `{ref, project, iid}` — `ref` VERBATIM as supplied (never
 * normalised: what the operator typed is what the manifest records and what every later refusal
 * quotes back), `project` the cross-project path or null, `iid` the issue number as a string.
 * Throws naming `where` (the flag or op that supplied it) and the accepted shapes.
 * @param {unknown} value the operator-supplied reference
 * @param {string} where the surface that supplied it, quoted in the refusal
 */
export function validateTicketRef(value, where) {
  const bad = (why) => new Error(
    `${where}: ${why} — a ticket reference is ${TICKET_REF_SHAPES}. `
    + 'It is operator-supplied DATA: legion never derives one from the branch, the commits or the MR, '
    + 'so a missing or malformed ref is refused rather than guessed.',
  );
  if (typeof value !== 'string') throw bad(`expected a string, got ${value === undefined ? 'nothing' : JSON.stringify(value)}`);
  if (value.length === 0) throw bad('the reference is empty');
  if (value.length > MAX_REF_LEN) throw bad(`the reference is ${value.length} characters (max ${MAX_REF_LEN})`);
  const bare = BARE_REF_RE.exec(value);
  if (bare) return { ref: value, project: null, iid: bare[1] };
  const qualified = QUALIFIED_REF_RE.exec(value);
  if (qualified) return { ref: value, project: qualified[1], iid: qualified[2] };
  throw bad(`${JSON.stringify(value)} is not a ticket reference`);
}

// --- config ------------------------------------------------------------------------------------

/** The closing-reference KEYWORD is an ENUM, never a free template string. A template would be an
 * injection surface into the MR body — the one place a kernel-appended line meets a human reviewer
 * — and the body's contract is "session prose plus EXACTLY ONE kernel-appended line". Four
 * keywords cover what GitLab actually does: the first three are in GitLab's default
 * closing pattern and auto-close the issue on merge; `refs` deliberately is NOT, and exists for the
 * operator who wants the link and the trail without the auto-close. */
export const TICKET_CLOSING_STYLES = ['closes', 'fixes', 'resolves', 'refs'];
const CLOSING_KEYWORDS = { closes: 'Closes', fixes: 'Fixes', resolves: 'Resolves', refs: 'Refs' };
/** The rendered keyword for a style. Throws on an unknown style rather than defaulting: a silent
 * fallback here would put a line the operator did not choose in front of the merging human. */
export function closingKeyword(style) {
  const k = CLOSING_KEYWORDS[style];
  if (k === undefined) throw new Error(`unknown ticket closing style '${style}' — one of ${TICKET_CLOSING_STYLES.join('|')}`);
  return k;
}

/** The two ticket config keys, exhaustively (header: growing this is deliberate, never
 * incidental). */
export const TICKET_CONFIG_KEYS = ['ticketProject', 'ticketClosingStyle'];
/** EVERYTHING org.json may carry: the ticket fields plus the forge selector. Grown 2026-08-15
 * when the second forge arrived — org.json stays key-strict, so the growth is here, named,
 * never incidental. */
export const ORG_CONFIG_KEYS = [...TICKET_CONFIG_KEYS, 'forge'];
/** LEVEL 1 — the plugin default. `ticketProject: null` means "the code repo's own GitLab project",
 * i.e. whatever glab derives from the worktree's remote; the kernel does not spell it out, because
 * spelling it out would mean deriving a project path the forge already knows. */
export const TICKET_CONFIG_DEFAULTS = { ticketProject: null, ticketClosingStyle: 'closes' };

/** Deliberately LOOSE (decision 14): a GitLab project path is whatever glab resolves, and the
 * pre-existing `--ticket-project` values in the wild are not all paths. The kernel's judgment is
 * the same one it makes about a ref — garbage only: a non-string, an empty/whitespace value, an
 * embedded control byte or an absurd length. */
export function validateTicketProject(value, where) {
  if (typeof value !== 'string' || value === '' || CTRL_OR_SPACE_RE.test(value) || value.length > MAX_REF_LEN) {
    throw new Error(
      `${where}: invalid ticket project ${JSON.stringify(value)} — it names the GitLab project the ISSUES live in `
      + `(e.g. 'group/project'), may differ from the code repository, and must be a non-empty value with no whitespace`,
    );
  }
  return value;
}

/** ONE definition of a valid closing style — used by `project init`'s flag, by org.json and by
 * project.json alike, so a flag and a hand-edited config are judged identically. */
export function validateClosingStyle(value, where) {
  if (typeof value !== 'string' || !TICKET_CLOSING_STYLES.includes(value)) {
    throw new Error(
      `${where}: invalid ticket closing style ${JSON.stringify(value)} — one of ${TICKET_CLOSING_STYLES.join('|')} `
      + `(the keyword that opens the MR body's closing-reference line; ${TICKET_CLOSING_STYLES.slice(0, 3).join('/')} `
      + 'auto-close the issue on merge, refs only links)',
    );
  }
  return value;
}

/** Validate the CONFIG FIELDS of an already-parsed config document, in place, naming the file.
 * (Named validateTicketFields until 2026-08-15; it validates `forge` too now, and calling it
 * "ticket" made a reader trust a name that had stopped being true.) EXPORTED for `legion project init`, which judges its own flags and the config it carries
 * forward with exactly these validators — one definition of valid, never a second copy in the CLI.
 * `strictKeys` is org.json's rule and org.json's alone: that file exists ONLY for the
 * ORG_CONFIG_KEYS, so an unknown one is a typo the operator must see (header). project.json
 * carries a dozen unrelated keys and is never key-checked here. */
export function validateConfigFields(doc, path, { strictKeys = false } = {}) {
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error(`${path}: expected a JSON object of ticket config, got ${Array.isArray(doc) ? 'an array' : JSON.stringify(doc)}`);
  }
  if (strictKeys) {
    const unknown = Object.keys(doc).filter((k) => !ORG_CONFIG_KEYS.includes(k));
    if (unknown.length > 0) {
      throw new Error(
        `${path}: unknown key(s) ${unknown.join(', ')} — this file configures exactly `
        + `${ORG_CONFIG_KEYS.join(', ')}, and an unrecognised key is a typo that would be silently ignored`,
      );
    }
  }
  if (doc.ticketProject != null) validateTicketProject(doc.ticketProject, `${path} ticketProject`);
  if (doc.ticketClosingStyle != null) validateClosingStyle(doc.ticketClosingStyle, `${path} ticketClosingStyle`);
  if (doc.forge != null) validateForge(doc.forge, `${path} forge`);
  return doc;
}

/** Read ONE level. Absent ⇒ null (silent, header). Present-but-unreadable or present-but-invalid
 * ⇒ THROWS naming the path and what is wrong — never null, because "absent" and "broken" must not
 * collapse into the same silence. */
function readLevel(path, opts) {
  if (!existsSync(path)) return null;
  let doc;
  try {
    doc = readJson(path);
  } catch (e) {
    throw new Error(
      `${path} exists but cannot be read as JSON (${e.message}) — it is NOT treated as absent: `
      + 'a config that reads as "no config" would silently change what legion writes into your MR '
      + 'and your issue tracker. Fix the file or delete it.',
      { cause: e },
    );
  }
  return validateConfigFields(doc, path, opts);
}

/**
 * THE resolver (header). Reads every level FRESH on every call and pins nothing.
 * @param {string} org
 * @param {string} project
 * @returns {{ticketProject: {value: string|null, from: string}, ticketClosingStyle: {value: string, from: string}}}
 *   each field carrying WHERE it came from ('plugin default' | 'org' | 'project') — `doctor`
 *   renders it, and an operator who cannot see which level won cannot debug an override.
 */
export function resolveTicketConfig(org, project) {
  const resolved = {
    ticketProject: { value: TICKET_CONFIG_DEFAULTS.ticketProject, from: 'plugin default' },
    ticketClosingStyle: { value: TICKET_CONFIG_DEFAULTS.ticketClosingStyle, from: 'plugin default' },
  };
  const levels = [
    ['org', readLevel(orgConfigPath(org), { strictKeys: true })],
    // A project with no project.json is not an error here: doctor and finalize both resolve for
    // registered projects, and an unregistered one simply has nothing to override with.
    ['project', readLevel(projectConfigPath(org, project), {})],
  ];
  for (const [level, doc] of levels) {
    if (doc === null) continue;
    // PER FIELD, and `null` is UNSET rather than "explicitly none" (header).
    for (const key of TICKET_CONFIG_KEYS) {
      if (doc[key] != null) resolved[key] = { value: doc[key], from: level };
    }
  }
  return resolved;
}

/**
 * WHICH FORGE this project talks to, resolved fresh at the moment of use like every other
 * non-evidence-bearing value here (header). Precedence, most specific wins: project.json
 * `forge` → org.json `forge` → URL detection over the project's recorded `remoteUrl` (or the
 * caller-supplied one, for contexts that carry a URL before/without a registered project) →
 * DEFAULT_FORGE. Each level is read through the SAME readLevel as the ticket config, so
 * "absent is silent, present-but-broken refuses loudly" has exactly one definition — a corrupt
 * org.json refuses a forge resolution just as it refuses a ticket one, because a config that
 * reads as "no config" would silently point finalize's remote writes at the wrong CLI.
 * @param {string} org
 * @param {string} project
 * @param {{remoteUrl?: string|null}} [opts] fallback URL when project.json records none
 * @returns {{value: 'gitlab'|'github', from: string}} `from` ∈ 'project' | 'org' |
 *   'remote url (<host>)' | 'default' — doctor renders it, and an operator who cannot see
 *   which level won cannot debug an override.
 */
export function resolveForge(org, project, { remoteUrl = null } = {}) {
  const orgDoc = readLevel(orgConfigPath(org), { strictKeys: true });
  const projDoc = readLevel(projectConfigPath(org, project), {});
  if (projDoc?.forge != null) return { value: projDoc.forge, from: 'project' };
  if (orgDoc?.forge != null) return { value: orgDoc.forge, from: 'org' };
  // Pre-forge-field project.json files (and unregistered contexts) land here: detection over
  // the recorded remote keeps every existing GitLab project resolving 'gitlab' with no
  // migration, and makes a GitHub remote work without any config at all.
  const url = projDoc?.remoteUrl ?? remoteUrl;
  const detected = detectForge(url);
  if (detected !== null) return { value: detected, from: `remote url (${remoteHost(url)})` };
  return { value: DEFAULT_FORGE, from: 'default' };
}
