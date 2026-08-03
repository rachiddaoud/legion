// Code coloring — highlight.js, loaded LAZILY in its own chunk like mermaid: the entry budget
// (budgets.test.mjs) is a contract, and a syntax highlighter is never worth a slower first paint.
//
// SECURITY, stated once: hljs.highlight() HTML-escapes the source text it is given; the markup it
// emits is exclusively its own <span class="hljs-*"> wrappers. The diff path renders that output
// directly (thousands of lines — a per-line sanitizer pass would be pure cost over an
// already-escaped string); the markdown path additionally runs DOMPurify because it writes into a
// sanitized document and keeps that document's invariant ("everything here passed the sanitizer").
//
// Only registered grammars exist in the chunk. `has()` resolves hljs aliases (`js`, `py`, …), so
// fence names and file extensions both work; an unknown language means NO coloring — plain
// escaped text, never a guess at a grammar.

let pending: Promise<Api> | null = null;

interface Api {
  /** escaped, span-wrapped HTML for `code`, or null when the language is not registered */
  highlight(code: string, lang: string): string | null;
  has(lang: string): boolean;
}

const EXT_LANG: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  json: 'json', css: 'css', scss: 'css', less: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', java: 'java', go: 'go', rs: 'rust',
  yml: 'yaml', yaml: 'yaml', md: 'markdown', sql: 'sql',
  diff: 'diff', patch: 'diff',
};

/** The highlight language for a file path, by extension — null means "leave it plain". */
export function langOfPath(path: string): string | null {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  return EXT_LANG[ext] ?? null;
}

export function getHighlighter(): Promise<Api> {
  if (pending) return pending;
  pending = (async () => {
    const hljs = (await import('highlight.js/lib/core')).default;
    const grammars: [string, Promise<{ default: unknown }>][] = [
      ['javascript', import('highlight.js/lib/languages/javascript')],
      ['typescript', import('highlight.js/lib/languages/typescript')],
      ['json', import('highlight.js/lib/languages/json')],
      ['css', import('highlight.js/lib/languages/css')],
      ['xml', import('highlight.js/lib/languages/xml')],
      ['bash', import('highlight.js/lib/languages/bash')],
      ['python', import('highlight.js/lib/languages/python')],
      ['java', import('highlight.js/lib/languages/java')],
      ['go', import('highlight.js/lib/languages/go')],
      ['rust', import('highlight.js/lib/languages/rust')],
      ['yaml', import('highlight.js/lib/languages/yaml')],
      ['markdown', import('highlight.js/lib/languages/markdown')],
      ['sql', import('highlight.js/lib/languages/sql')],
      ['diff', import('highlight.js/lib/languages/diff')],
    ];
    for (const [name, mod] of grammars) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hljs.registerLanguage(name, (await mod).default as any);
    }
    return {
      has: (lang: string) => Boolean(lang && hljs.getLanguage(lang)),
      highlight: (code: string, lang: string) => {
        if (!lang || !hljs.getLanguage(lang)) return null;
        try {
          return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
        } catch {
          return null; // a grammar blow-up costs the coloring, never the content
        }
      },
    };
  })();
  return pending;
}
