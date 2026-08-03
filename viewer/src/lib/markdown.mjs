// markdown.mjs — the ONE markdown→HTML pipeline, PORTED VERBATIM from legion2's viewer (its B01
// fix). Dossier artifacts are authored by models and by the operator's projects, so they are
// UNTRUSTED input rendered in the same origin as the read-only API. Safety is by CONSTRUCTION
// here, testable in plain node (test/viewer/markdown.test.mjs); components/Markdown.tsx adds a
// DOMPurify pass on top as the runtime belt.
//
// Rules: raw HTML never passes through (dropped, block and inline); link/image URLs must match a
// strict protocol allowlist (no javascript:, data:, vbscript:, protocol-relative); everything
// interpolated into an attribute is escaped. Mermaid fences stay ordinary <pre><code> blocks —
// the component upgrades them separately, lazily, in its own chunk.
//
// RELATIVE IMAGE AND LINK URLS SURVIVE ON PURPOSE. A dossier's `review-visual.md` references its
// screenshots as `visual/M1/home@1280.png`, relative to the document. Dropping those would erase
// the evidence; resolving them to a filesystem path would be a traversal surface. They are kept
// verbatim here and rewritten to `/api/artifact?...` by lib/artifact-url.mjs at render time, where
// the dossier-relative containment rule lives in ONE place and the server re-checks it anyway.
import { Marked } from 'marked';

const SAFE_LINK = /^(https?:|mailto:|#|\/(?!\/)|\.\/|\.\.\/)/i;
const SAFE_IMAGE = /^(https?:|\/(?!\/)|\.\/|\.\.\/)/i;

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** A bare relative reference (`visual/x.png`, `specs/a.md`) is neither absolute nor dot-prefixed,
 * so the two allowlists above reject it. It is exactly the shape a dossier artifact uses, so it is
 * admitted here — and ONLY here, as a relative path with no scheme, no leading slash and no `..`
 * escape decided later by artifact-url.mjs (which the server re-validates regardless). */
const BARE_RELATIVE = /^(?![a-z][a-z0-9+.-]*:)(?!\/)(?!#)[^\s]/i;
const relativeOk = (href) => BARE_RELATIVE.test(href);

const md = new Marked({
  renderer: {
    html() { return ''; },
    link(token) {
      const text = this.parser.parseInline(token.tokens);
      const href = String(token.href ?? '').trim();
      if (!href || !(SAFE_LINK.test(href) || relativeOk(href))) return text;
      const title = token.title ? ` title="${esc(token.title)}"` : '';
      return `<a href="${esc(token.href)}"${title} rel="noopener noreferrer" target="_blank">${text}</a>`;
    },
    image(token) {
      const href = String(token.href ?? '').trim();
      if (!href || !(SAFE_IMAGE.test(href) || relativeOk(href))) return esc(token.text || '');
      const title = token.title ? ` title="${esc(token.title)}"` : '';
      return `<img src="${esc(token.href)}" alt="${esc(token.text || '')}"${title}>`;
    },
  },
});

/** @param {string} text @returns {string} HTML with raw HTML dropped and URLs allowlisted */
export function renderMarkdown(text) {
  return /** @type {string} */ (md.parse(String(text ?? ''), { async: false }));
}
