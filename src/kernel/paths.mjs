// paths.mjs — the ONLY place the path layout is known. All state lives under the
// legion home — default ~/.legion (deliberately NOT the engine checkout) — org-nested:
//   <home>/orgs/<org>/projects/<project>/features/<name>/   (the feature dossier)
//   <home>/projects.json                                    (machine-local index)
// LEGION_HOME overrides the home and is read LAZILY at every call (functions, never
// module-load constants) so tests can repoint it after import; it MUST be absolute —
// a relative value is rejected loudly (never resolve()d: it would silently depend on
// the invoking process's cwd, and these paths are persisted durably into projects.json).
// Set-but-empty is an error, not a fallback — an empty env var is almost always a broken
// export, and falling back to the real ~/.legion from a test would be catastrophic.
// Every identity segment passes safeSegment before joining — the engine-wide traversal
// guard. All paths absolute.
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

// Identity segments (org/project/feature ids) become filesystem path components; a strict
// shape here is what keeps `../x` out of every derived path engine-wide.
// First char is a letter/digit/underscore (orgs like `_fixture-acme` are legitimate); the rest adds
// dot and dash. `.` can never be first, so `.` and `..` stay rejected — the traversal guard holds.
const SEGMENT_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
export function safeSegment(v, what) {
  if (typeof v !== 'string' || !SEGMENT_RE.test(v)) {
    throw new Error(`invalid ${what} '${v}' — letter/digit/underscore then letters/digits/dot/dash/underscore only (no path separators)`);
  }
  return v;
}

export const legionHome = () => {
  const env = process.env.LEGION_HOME;
  if (env === undefined) return join(homedir(), '.legion');
  if (!isAbsolute(env)) { // isAbsolute('') is false — set-but-empty dies here too
    throw new Error(`LEGION_HOME must be an absolute path, got '${env}' — set but empty or relative would depend on the invoking cwd (or silently fall back to the real ~/.legion) and persist bad paths into projects.json`);
  }
  return env;
};

export const orgsRoot = () => join(legionHome(), 'orgs');
export const orgDir = (org) => join(orgsRoot(), safeSegment(org, 'org'));
export const projectsDir = (org) => join(orgDir(org), 'projects');
export const projectDir = (org, project) => join(projectsDir(org), safeSegment(project, 'project'));
export const featuresDir = (org, project) => join(projectDir(org, project), 'features');
/** The feature dossier: <home>/orgs/<org>/projects/<project>/features/<feature>/ */
export const featureDir = (org, project, feature) =>
  join(featuresDir(org, project), safeSegment(feature, 'feature'));
export const projectsIndexPath = () => join(legionHome(), 'projects.json');
/** The per-project config manifest written by `legion project init`. */
export const projectConfigPath = (org, project) => join(projectDir(org, project), 'project.json');
/** The OPTIONAL per-org config file (kernel/ticket.mjs): defaults shared by every project of one
 * org. Nothing writes it — there is no `legion org init`; the operator creates it by hand or not at
 * all, which is why its ABSENCE is the ordinary case and silent. Only its path is owned here. */
export const orgConfigPath = (org) => join(orgDir(org), 'org.json');

/** mkdir -p; returns the path so call sites create-and-use in one expression. Idempotent. */
export function ensureDir(p) {
  mkdirSync(p, { recursive: true });
  return p;
}
