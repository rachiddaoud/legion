// Markdown — digest-first artifact rendering (VF14), ported from legion2 with the marked →
// DOMPurify → lazy-mermaid chain intact and one addition.
//
// THE CHAIN, unchanged: renderMarkdown drops raw HTML and allowlists URLs by construction
// (lib/markdown.mjs, node-tested); DOMPurify re-sanitizes the result at runtime; mermaid renders
// LAZILY in its own chunk with `securityLevel: 'strict'` and its SVG is sanitized before it is
// mounted. On any render failure the fence stays visible AS CODE — an honest fallback, never
// dropped content. Dossier artifacts are model-authored and therefore untrusted input rendered in
// the same origin as the read-only API; nothing about that changed in v3.
//
// THE ADDITION: RELATIVE ARTIFACT REFERENCES. `review-visual.md` points at its screenshots
// relatively (`visual/M1/home@1280.png`), and inside a single-page app those srcs would resolve
// against the page URL. `resolveHref` — supplied by the caller, which knows WHICH artifact this
// text came from — turns each one into an `/api/artifact?…` URL. A reference it refuses (an
// escape, a dotfile, an unservable extension) has its element replaced by the reference AS TEXT,
// because a broken image frame reads as a missing screenshot and this one is a missing rewrite.
// The resolution runs on the SANITIZED DOM: nothing here can reintroduce a URL the sanitizer just
// removed, and no href/src it writes is anything but a same-origin /api/artifact query.
//
// WHO OWNS THE CHILDREN OF THIS DIV, and why both rules below are load-bearing. React writes the
// markdown ONCE per distinct `html` and the two effects then MUTATE that DOM in place — a split
// ownership that only works while React is not writing over them:
//
//   1. THE `__html` OBJECT IS MEMOISED. react-dom-client diffs props by IDENTITY
//      (`nextProp !== lastProp`) and re-runs `setInnerHTML` for `dangerouslySetInnerHTML` whenever
//      it differs, so a fresh `{__html}` literal in the JSX re-wrote this element's innerHTML on
//      EVERY render. The port polls (detail 3s, features 5s, health 30s), so every rendered mermaid
//      diagram was wiped back to its code fence within a second of appearing and never returned:
//      the mermaid effect keys on `html`, which had not changed, so it never re-ran. Memoising the
//      object is what makes "React writes it once" true.
//   2. THE REWRITE IS IDEMPOTENT. Its deps include `resolveHref`, which callers legitimately pass
//      as an inline arrow, so it re-runs on renders where the DOM was NOT rewritten. A second pass
//      over an already-rewritten element would feed `/api/artifact?…` back to the resolver, which
//      refuses it (absolute) — replacing live images and links with inert text. `data-md-resolved`
//      marks what has been handled; a genuine `html` change replaces the nodes and the marks with
//      them.

import { useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { renderMarkdown } from '../lib/markdown.mjs';
import { getHighlighter } from '../lib/highlight';

export interface MarkdownProps {
  text: string;
  /** dossier-relative reference → a servable URL, or null to render it as inert text */
  resolveHref?: (ref: string) => string | null;
}

export function Markdown({ text, resolveHref }: MarkdownProps) {
  const html = useMemo(
    () => DOMPurify.sanitize(renderMarkdown(text), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'form'] }),
    [text],
  );
  // Header rule 1: one object per distinct `html`, so React writes innerHTML once per document and
  // never over the effects' work.
  const htmlProp = useMemo(() => ({ __html: html }), [html]);
  const ref = useRef<HTMLDivElement>(null);

  // Relative-reference rewriting. Runs before the mermaid pass so a failed rewrite never leaves a
  // half-rendered document, and is a no-op when the caller supplied no resolver. Header rule 2:
  // `:not([data-md-resolved])` is what makes a re-run (an inline `resolveHref`) a no-op instead of
  // a demolition of the links it rewrote last time.
  useEffect(() => {
    const el = ref.current;
    if (!el || !resolveHref) return;
    for (const img of Array.from(el.querySelectorAll('img:not([data-md-resolved])'))) {
      img.setAttribute('data-md-resolved', '');
      const raw = img.getAttribute('src') ?? '';
      if (/^(https?:|data:)/i.test(raw)) continue; // absolute: left exactly as the sanitizer left it
      const url = resolveHref(raw);
      if (url === null) {
        const note = document.createElement('span');
        note.className = 'mono muted';
        note.textContent = `[${img.getAttribute('alt') || 'image'}: ${raw} — not servable from this dossier]`;
        img.replaceWith(note);
        continue;
      }
      img.setAttribute('src', url);
      img.setAttribute('loading', 'lazy');
      img.classList.add('md-img');
    }
    for (const a of Array.from(el.querySelectorAll('a:not([data-md-resolved])'))) {
      a.setAttribute('data-md-resolved', '');
      const raw = a.getAttribute('href') ?? '';
      if (/^(https?:|mailto:|#)/i.test(raw)) continue;
      const url = resolveHref(raw);
      if (url === null) { a.replaceWith(document.createTextNode(a.textContent ?? raw)); continue; }
      a.setAttribute('href', url);
    }
  }, [html, resolveHref]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const blocks = el.querySelectorAll('code.language-mermaid');
    if (!blocks.length) return;
    let dead = false;
    import('mermaid')
      .then(async ({ default: mermaid }) => {
        if (dead) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: document.documentElement.dataset.theme === 'dark' ? 'dark' : 'neutral',
        });
        let i = 0;
        for (const code of Array.from(blocks)) {
          try {
            const { svg } = await mermaid.render(`mmd-${i++}-${Math.random().toString(36).slice(2, 7)}`, code.textContent || '');
            const holder = document.createElement('div');
            holder.className = 'mermaid-holder';
            holder.innerHTML = DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true, html: true } });
            code.closest('pre')?.replaceWith(holder);
          } catch { /* leave the fence as code — visible, honest */ }
        }
      })
      .catch(() => { /* chunk unavailable: fences stay as code */ });
    return () => { dead = true; };
  }, [html]);

  // Code coloring for fenced blocks (c13b): the same lazy hljs chunk the diff panes use. Mermaid
  // fences are the diagram pass's property and are skipped; `data-hl-done` keeps the pass
  // idempotent under the same re-render rules as the reference rewrite above. The highlighted
  // markup goes back through DOMPurify — this document's invariant is "everything here passed the
  // sanitizer", and one cheap pass per block keeps it true rather than argued.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const blocks = Array.from(el.querySelectorAll('pre code[class*="language-"]:not([data-hl-done])'))
      .filter((c) => !c.classList.contains('language-mermaid'));
    if (!blocks.length) return;
    let dead = false;
    getHighlighter()
      .then((h) => {
        if (dead) return;
        for (const code of blocks) {
          code.setAttribute('data-hl-done', '');
          const lang = [...code.classList].find((c) => c.startsWith('language-'))?.slice('language-'.length) ?? '';
          const colored = h.highlight(code.textContent ?? '', lang);
          if (colored === null) continue; // unknown language: plain, never guessed
          code.innerHTML = DOMPurify.sanitize(colored, { USE_PROFILES: { html: true } });
          code.classList.add('hljs');
        }
      })
      .catch(() => { /* chunk unavailable: fences stay plain */ });
    return () => { dead = true; };
  }, [html]);

  return <div className="md" ref={ref} dangerouslySetInnerHTML={htmlProp} />;
}
