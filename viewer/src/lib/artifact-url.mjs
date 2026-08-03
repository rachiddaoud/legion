// artifact-url.mjs — the dossier-artifact address, and the ONE place a markdown-relative reference
// becomes one. Pure, no DOM, node-testable (test/viewer/artifact-url.test.mjs).
//
// WHAT `/api/artifact` ACCEPTS (src/cli/_viewer/server.mjs): org, project, name and a
// DOSSIER-RELATIVE `path`. The projection already hands the client dossier-relative paths for every
// artifact it recorded INSIDE the dossier (`artifacts[kind].inside === true`); an artifact recorded
// outside it keeps its absolute path, is not servable, and the UI renders it as a path rather than
// as a link. Nothing here invents an address for one.
//
// WHY THE RESOLVER EXISTS. `review-visual.md` references its screenshots relatively
// (`visual/M1/home@1280.png` — agents/visual-reviewer.md writes them there). Rendered inside a
// single-page app those srcs would resolve against the page URL and 404 in a way that looks like a
// missing screenshot rather than a missing rewrite. So the renderer resolves each one against the
// DIRECTORY OF THE DOCUMENT IT CAME FROM and turns it into an /api/artifact URL.
//
// THE RESOLVER REFUSES RATHER THAN CLIMBS. `..` that escapes the dossier, an absolute path, a
// scheme, a dotfile segment and a NUL byte all return null, and null renders as inert text. This is
// NOT the security boundary — the server re-checks every one of these rules and owns the realpath
// containment — it exists so the UI never renders a link it knows the server will refuse.

/** @typedef {{org:string, project:string, name:string}} FeatureId */

/**
 * The URL for one dossier-relative artifact path.
 * @param {FeatureId} id
 * @param {string} path dossier-relative (never absolute — see the header)
 * @returns {string}
 */
export function artifactUrl(id, path) {
  const p = new URLSearchParams({
    org: String(id?.org ?? ''), project: String(id?.project ?? ''), name: String(id?.name ?? ''), path: String(path ?? ''),
  });
  return `/api/artifact?${p.toString()}`;
}

/**
 * Resolve a reference found INSIDE `docPath` (itself dossier-relative) to a dossier-relative path,
 * or null when it is not a dossier reference at all or would escape.
 * @param {string} docPath e.g. 'review-visual.md' or 'specs/T3.md'
 * @param {string} ref e.g. 'visual/M1/home.png' or './a.png' or '../plan.md'
 * @returns {string|null}
 */
export function resolveArtifactPath(docPath, ref) {
  const raw = String(ref ?? '');
  if (raw === '' || raw.includes('\0')) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return null; // http(s), data:, mailto: — not a dossier path
  if (raw.startsWith('/') || raw.startsWith('#')) return null;
  // The document's own directory. A doc at the dossier root has none.
  const dir = String(docPath ?? '').split('/').slice(0, -1).filter((s) => s !== '' && s !== '.');
  const out = [...dir];
  for (const seg of raw.split(/[/\\]+/)) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null; // escapes the dossier — refused, never clamped to the root
      out.pop();
      continue;
    }
    if (seg.startsWith('.')) return null; // dotfiles are not served (server.mjs artifactRelPath)
    out.push(seg);
  }
  return out.length === 0 ? null : out.join('/');
}

/** The extensions `/api/artifact` will serve as an image (server.mjs ARTIFACT_TYPES — `.svg` is
 * deliberately absent there and therefore absent here). Anything else in a markdown `img` is a
 * reference the server would answer 415 to, so the UI renders its text instead of a broken frame. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];

/** @param {string} path @returns {boolean} */
export const isServableImage = (path) => IMAGE_EXTENSIONS.some((e) => String(path ?? '').toLowerCase().endsWith(e));

/** Markdown is the only artifact kind rendered as a DIGEST rather than as a link. Everything else
 * (a .json contract, a .png screenshot) is offered as a link, because rendering JSON as prose or a
 * PNG as text would be a worse lie than making the operator click. */
export const isMarkdown = (path) => /\.(md|markdown|txt)$/i.test(String(path ?? ''));
