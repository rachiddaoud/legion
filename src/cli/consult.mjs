// consult.mjs — `legion consult`: the second-opinion lens's API recipe, as a deterministic verb.
//
// WHY A VERB AND NOT PROSE. The `api` recipe of agents/consult.md was ~50 lines of shell for a
// haiku agent to assemble by hand: a JSON payload built with `node -e`, a curl line whose only
// safe spelling of the token was one shell expansion, a 200 KiB cap enforced by an `exit 3`
// guard, and a status/curl-exit table to read the outcome off. Every one of those is a step a
// model can get subtly right and occasionally wrong, and the failure modes are the two this lens
// exists to prevent: a review that never ran reported as a pass, and a token that reached a
// transcript. The judgement is not the model's to make, so it is not the model's to make: the
// agent now passes the four userConfig values through as flags and reads back one JSON object.
//
// READ-ONLY, ABSOLUTELY — the same property `legion doctor` holds and for the same reason. This
// verb resolves no dossier, takes no lock, writes no file, mints no evidence and records no
// review. Its only outputs are stdout and the exit code. (The kernel is not ignorant of consult:
// state.mjs REVIEW_RECEIPT_AGENT_ROLES maps the `consult` review ROLE, and the build loop records
// its verdict with `legion state review-record --role consult`. What the kernel owns no row for
// is a consult GATE — PROFILE_REVIEW_ROLES names none, deliberately. This verb sits on neither
// path: it fetches an opinion, and the caller does everything else with it.)
//
// EXIT CODE, AND WHY `available:false` IS A ZERO. 0 means an envelope was emitted — INCLUDING an
// `available:false` one. A missing lens is a valid, complete answer: the build loop records the
// review as degraded and continues, and it is a ZERO exit that stops the haiku caller from
// treating the answer as a broken command and "repairing" it into some other backend. 1 is
// reserved for a call that was never a review request at all — bad flags, the wrong recipe, an
// unreadable question file, a commit that does not resolve — where the router prints
// `legion consult: <message>` on stderr and NO envelope is written to stdout. Those two classes
// must not blur: an envelope on stderr is unreadable to the caller, and a non-zero exit for a
// quota-exhausted provider is a lie about whose fault it is.
//
// ONE RESPONSE FORMAT, NO CAPABILITY COLUMN (operator decision, 2026-08-20). Every API backend
// gets `response_format: {"type":"json_object"}`. `json_schema` / `strict` is gone from this
// codebase rather than kept behind a flag or tried first with a fallback, because:
//   - the schema has to be spelled out in the PROMPT regardless (deepseek and a bare `api`
//     endpoint force `json_object`, and `json_object` is defined as "valid JSON, shape as
//     instructed"), so `json_schema` never removes that copy — it only adds a second,
//     dialect-sensitive copy of the same schema, free to drift from the first;
//   - a per-provider capability table would be five rows of which four are DOC-SOURCED CLAIMS no
//     offline suite can ever check. This repo does not ship claims it cannot substantiate.
// MEASURED, and the reason the question came up at all: DeepSeek (`api.deepseek.com/v1`,
// `deepseek-v4-flash`) answers `json_schema`+`strict` with HTTP 400 "This response_format type is
// unavailable now", and answers `json_object` with 400 "Prompt must contain the word 'json' in
// some form…" when the word is absent. The composed prompt below therefore CONTAINS the word by
// construction — the schema block opens with "Respond with EXACTLY ONE JSON object" — and a test
// pins that, because the precondition is documented identically for OpenAI and Mistral and a
// reworded block would break all three at once.
//
// THE TOKEN NEVER ENTERS A MODEL CONTEXT. Not "is not printed" — cannot be. Its whole path is
// process.env → a local in this process → the `Authorization` header → the TLS socket. The verb
// receives the env var NAME, never the value; legion stores no token anywhere. As the belt to
// that braces, every string this verb writes to stdout passes through a scrubber that deletes any
// occurrence of the value BEFORE the envelope is serialised — so a provider that echoes the key back in
// its own 400 body (they do) cannot smuggle it out through `reason`. test/cli/consult.test.mjs
// proves it against a server that does exactly that.
//
// CONTRACT NARROWING, STATED. curl has left the recipe, so this path can no longer emit
// `cli-missing`: there is no binary to be missing. That row of the step-6 table stays live for
// the codex and gemini recipes and is simply unreachable here (UNAVAILABLE_CAUSES omits it, and
// the omission is what a cross-pin checks). The curl exit codes that used to be the signal source
// are replaced one for one, semantics preserved: 6/7/35 (DNS, refused, TLS) → a fetch rejection
// whose `cause.code` is in NETWORK_CAUSE_CODES; 28 (`--max-time`) → the AbortSignal below.
//
// PLACEHOLDER REJECTION IS AN INVARIANT, NOT A COURTESY. MEASURED on Claude Code 2.1.236: a
// userConfig option the operator never set is left in the agent prompt as the LITERAL
// `${user_config.…}` — the manifest `default` is NOT substituted in its place. The agent is told
// to pass all four values through verbatim precisely so it makes no judgement about them, which
// means unsubstituted placeholders arrive here. Any flag value matching PLACEHOLDER_RE is read as
// UNSET, and it is never echoed onward: sending `${user_config.consult_model}` to a provider as a
// model name is the exact accident this rule exists to make impossible.
//
// SHAPE: consultCore(argv, deps) is pure — it writes nothing and returns { code, envelope, output }
// — and run(argv) prints output and returns code. `deps.fetch` has NO DEFAULT and is type-checked
// by name: a test that forgets to inject a fake must fail loudly rather than reach the network.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs } from '../kernel/args.mjs';
import { git } from '../kernel/git.mjs';

export const USAGE =
  'legion consult --backend <openai|google|xai|deepseek|mistral|api> --model <name> '
  + '[--base-url <url>] [--token-env <NAME>] (--commit <sha> | --base <ref>) --question-file <path>';

/** The resolved endpoint and token env var NAME per named API backend. A table of PROVIDERS,
 * never of models: the model is always `--model`. `api` is a row with both columns null — the
 * "bring your own endpoint" case — so that "an explicit flag overrides its column" is ONE rule
 * with no special case, and so the accepted-backend list is exactly Object.keys(PROVIDERS).
 * These five rows are the ones agents/consult.md carried until 2026-08-20; moving them into code
 * is what lets test/plugin-manifest.test.mjs pin them by import instead of by regexing prose. */
export const PROVIDERS = {
  openai: { baseUrl: 'https://api.openai.com/v1', tokenEnv: 'OPENAI_API_KEY' },
  google: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', tokenEnv: 'GEMINI_API_KEY' },
  xai: { baseUrl: 'https://api.x.ai/v1', tokenEnv: 'XAI_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', tokenEnv: 'DEEPSEEK_API_KEY' },
  mistral: { baseUrl: 'https://api.mistral.ai/v1', tokenEnv: 'MISTRAL_API_KEY' },
  api: { baseUrl: null, tokenEnv: null },
};

/** The two backends that are CLI recipes (agents/consult.md 3a/3b), not API ones. They are valid
 * configurations — they are simply not this verb's, and an unsubstituted `consult_backend` is a
 * third spelling of the same thing (the prompt routes an unset backend to codex). All three are a
 * USAGE error rather than a `misconfigured` envelope: nothing about the operator's config is
 * broken, the wrong tool was handed the job, and only a loud stderr line says that. */
export const CLI_RECIPE_BACKENDS = ['codex', 'gemini', 'agy'];

/** A value the plugin loader never substituted (header). Anchored at the start: a model whose
 * real name merely CONTAINS the text is not a placeholder. */
export const PLACEHOLDER_RE = /^\$\{user_config\./;

/** The `unavailable` causes this verb can emit — a strict SUBSET of the enum in
 * workflows/build-loop.js, short by `cli-missing`, which the header explains is unreachable once
 * curl leaves the recipe. A cross-pin in the test file asserts the subset relation, so adding a
 * cause here that the loop's REVIEW_SCHEMA would drop cannot pass silently. */
export const UNAVAILABLE_CAUSES = [
  'misconfigured', 'not-authenticated', 'quota', 'network', 'timeout', 'other',
];

/** 200 KiB, measured on the composed diff exactly as it would be sent. Over it the review is
 * REFUSED whole and no HTTP call is made — never truncated: a truncated diff buys a confident
 * "patch is correct" about code nobody read, which is the silent false pass this lens exists to
 * prevent. The gemini recipe enforces the same number with its `exit 3` guard. */
export const DIFF_CAP_BYTES = 204800;

/** 900 s, the bound the curl line carried as `--max-time 900` and the CLI recipes carry as
 * `perl -e 'alarm 900'`. Not a public flag: the caller is a haiku agent, and a timeout it can
 * lower is a timeout that turns a slow reasoning model into a `timeout` envelope. Tests override
 * it through deps.timeoutMs. */
export const TIMEOUT_MS = 900_000;

/** Ceiling for the `git show`/`git diff` read. It exists only so an OVER-CAP diff can still be
 * MEASURED and named in the refusal; 8 MiB is 40x the cap and matches kernel/runner.mjs's own
 * default. A diff past even this dies loudly at the seam (ENOBUFS) rather than arriving
 * truncated — the same refusal in a louder costume, which is the right direction to fail. */
const DIFF_MAX_BUFFER = 8 * 1024 * 1024;

/** The diff FORMAT pins — flags, because a flag is the one layer that beats everything below it
 * (kernel/git.mjs header B), and every entry here closes a way the bytes a reviewer is asked to
 * judge can differ from the bytes that were committed:
 *   --no-ext-diff  MEASURED, and MANDATORY, not belt-and-braces: GIT_PIN_ARGS neutralises
 *                  diff.external by setting it EMPTY, and `git diff` then tries to execute the
 *                  empty string — `error: cannot run : No such file or directory / fatal:
 *                  external diff died` (git 2.50.1). Every hardened `git diff` in this repo needs
 *                  this flag; `git show` happens not to, since the log family ignores external
 *                  diff drivers unless asked, but one list serves both scopes.
 *   --no-textconv  a textconv driver replaces the content wholesale — a review of a rendering.
 *   --text         a committed `.gitattributes` saying `*.mjs -diff` turns the patch into
 *                  "Binary files … differ", i.e. a confident review of nothing. The SILENT one.
 *   --no-renames   git's rename detection prints only a rename's DESTINATION, so `git mv
 *                  .eslintrc.json eslint-old.txt` shows a reviewer a new .txt and never the lost
 *                  lint config. Off, a rename is a delete plus an add and both paths are visible.
 *   --no-color / --src-prefix / --dst-prefix  the schema block asks the model to "cite file and
 *                  line from the diff", and `+++ b/<path>` is where that citation comes from;
 *                  explicit prefixes override every prefix knob at once, present or future.
 * A SECOND LIST, DELIBERATELY, next to gate.mjs's DIFF_FORMAT — not copy-drift. The gate's is an
 * input to a PARSER (SECTION_RE backreferences the pinned prefixes) over a range it always
 * computes itself; this one governs `git show` as well and exists so a HUMAN-equivalent reader
 * sees the committed bytes. Importing gate.mjs to share the array would drag resolveDossier and
 * the whole dossier layer into a verb that resolves no dossier and takes no lock, which is a
 * worse coupling than two five-word lists that are allowed to answer different questions. */
const DIFF_FORMAT = [
  '--no-ext-diff', '--no-textconv', '--text', '--no-color', '--no-renames',
  '--src-prefix=a/', '--dst-prefix=b/',
];

// --- the composed prompt ------------------------------------------------------------------------
// THE ANSWER'S SHAPE IS BOUGHT BY THIS TEXT, not by `response_format` (header). `json_object`
// guarantees only that the bytes parse; WHICH keys come back is whatever the prompt asked for, so
// these two blocks are the contract and the local validation below is its enforcement. They are
// the gemini recipe's wording verbatim (agents/consult.md 3b), and deliberately so: one pinned
// question across gemini and every API backend is what lets ONE translation table in the agent
// serve all three recipes, and a reworded copy here would silently give the api path a different
// answer shape from the CLI path nobody would notice until a `where` came back empty.

/** Block 1 — who the model is. */
const REVIEWER_PREAMBLE = 'You are reviewing a unified diff as an independent second-opinion code reviewer.';

/** Block 3 — the codex schema, the priority legend, and the sentence that makes an empty review a
 * legitimate answer (without it a model invents a finding rather than return nothing).
 * IT OPENS WITH THE WORD "JSON", AND THAT IS LOAD-BEARING, NOT STYLE: measured on DeepSeek,
 * `response_format: json_object` is refused with HTTP 400 "Prompt must contain the word 'json' in
 * some form to use 'response_format' of type 'json_object'." when the word is absent, and OpenAI
 * and Mistral document the same precondition. Satisfying it by CONSTRUCTION — rather than by a
 * sentence appended somewhere for the purpose — is why a test pins /json/i on the composed
 * prompt: a future rewording that dropped the word would break all three providers at once, at
 * runtime, in production. */
const SCHEMA_BLOCK = [
  'Respond with EXACTLY ONE JSON object and nothing else - no prose, no markdown fences:',
  '{"findings":[{"title":"…","body":"…; cite file and line from the diff","priority":0,"code_location":{"absolute_file_path":"…","line_range":{"start":1,"end":1}}}],"overall_correctness":"patch is correct","overall_explanation":"…"}',
  'overall_correctness is exactly "patch is correct" or "patch is incorrect".',
  'priority: 0 = blocking defect, 1 = must fix before merge, 2 = should fix, 3 = informational.',
  'An empty findings array with "patch is correct" is a legitimate answer.',
].join('\n');

/** The ONE user message: preamble, the dispatch's question, the schema block, then the diff. The
 * diff goes LAST so that the instructions are never pushed out of a model's attention by 200 KiB
 * of patch, and so that diff content shaped like an instruction reads as the data it is. */
export function composePrompt(question, diff) {
  return `${REVIEWER_PREAMBLE}\n${question.trim()}\n${SCHEMA_BLOCK}\n\n${diff}`;
}

// --- classification ------------------------------------------------------------------------------
// The step-6 table of agents/consult.md, in code. It is a LOOKUP, never a judgement: the build
// loop LATCHES the lens off for the rest of the run on a durable cause (cli-missing,
// not-authenticated, quota, misconfigured) and re-dispatches on a transient one (network,
// timeout, other), so a guessed cause either buys a run of pointless ~26k-token dispatches or
// silently drops every later second opinion over one DNS blip.

/** The `cause.code`s that mean the request NEVER REACHED A SERVER — the replacement, one for one,
 * for curl exits 6 (DNS), 7 (connection refused) and 35 (TLS). node's fetch rejects with a
 * TypeError whose `cause` carries the underlying system/TLS error, which is the only place the
 * distinction survives: the message is always the same "fetch failed". `ERR_TLS_*` is matched by
 * PREFIX because node names a family of them and enumerating today's spellings would silently
 * reclassify tomorrow's as `other` — i.e. as retryable, which a bad certificate is not. */
const NETWORK_CAUSE_CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENETUNREACH',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED',
]);
const isNetworkCause = (code) =>
  typeof code === 'string' && (NETWORK_CAUSE_CODES.has(code) || code.startsWith('ERR_TLS_'));

const REDACTED = '[redacted]';

/** Delete every occurrence of the token from a string, in BOTH the raw and the JSON-escaped
 * spelling — the escaped one because a provider's error body can arrive with the token already
 * escaped inside it, and that spelling would otherwise survive unrecognised. Deleting rather than
 * masking-by-prefix is deliberate: a "first 4 characters" style hint is still key material in a
 * transcript. This function is only ever run over a STRING VALUE, never over serialised JSON —
 * see scrubDeep for why that distinction is load-bearing rather than stylistic. */
function scrubber(token) {
  const escaped = JSON.stringify(token).slice(1, -1);
  return (s) => {
    const once = s.split(token).join(REDACTED);
    return escaped === token ? once : once.split(escaped).join(REDACTED);
  };
}

/** Apply `scrub` to every string in a JSON-shaped value, leaving the shape untouched. This is
 * the whole reason the emitted envelope cannot be broken by its own redaction: a token is an
 * arbitrary string, so the ONE place it must never be deleted from is the serialised form, where
 * its bytes may be structure rather than content. Keys are scrubbed too — this verb never builds
 * one from a token, and a walk that skipped them would be a hole left open on the strength of
 * that habit holding forever. */
function scrubDeep(value, scrub) {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, scrub));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [scrub(k), scrubDeep(v, scrub)]));
  }
  return value;
}

/** Does this scope carry anything a reviewer could actually judge?
 *
 * The cap at the other end of the scale refuses a diff too big to review. This refuses one with
 * nothing IN it — and "nothing" has more than one spelling here, which is why it is a predicate
 * and not a length check:
 *   - `--base HEAD` resolves to an empty range and yields the empty string;
 *   - `git show --cc` on a clean merge prints ~138 bytes of `commit`/`Merge:`/`Author:`/`Date:`
 *     header and then NO patch at all — non-empty by any byte count, and still nothing to read.
 * Both would otherwise be sent, and both come back `available:true` with an empty findings array:
 * a clean second opinion, fabricated about nothing, recorded by the loop as a real one.
 *
 * @param {string} diff the bytes `git` returned for the scope
 * @returns {boolean} true when there is no patch here to review */
export function isEmptyScope(diff) {
  // Keyed on the PATCH MARKERS git writes, not on a length: `diff --git` for an ordinary diff,
  // `diff --cc` / `diff --combined` for a merge shown with --cc, and `@@` / `@@@` for the hunks
  // themselves — the hunk arm is what keeps a header-format change from silently disarming this.
  // The coupling to git's output shape is real and accepted: DIFF_FORMAT above already pins the
  // format these bytes come back in, so the two live or die together.
  // The direction of the residual error is the reason it is written this way round. No marker
  // found ⇒ refuse: if git ever renamed both markers, this refuses EVERY scope, which is a lens
  // that visibly stops working. The inverse spelling (look for emptiness, send otherwise) would
  // fail by sending header-only bytes and recording the fabricated "patch is correct" that this
  // guard exists to prevent — the failure nobody sees.
  return !/^(?:diff --|@@)/m.test(diff);
}

/** Markdown fences off, parity with the gemini recipe: `json_object` is honoured by every
 * provider measured, but a model that ignores it answers with a fenced block, and refusing that
 * as unparsable would throw away a review that was in fact returned. */
function stripFences(content) {
  const t = content.trim();
  const m = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

/** The LOCAL enforcement of the answer shape — the half `response_format: {"type":"json_object"}`
 * does not buy (header): it guarantees the bytes parse, never which keys they carry. Returns the
 * violation in words, or null. Only the fields the agent's translation table actually reads are
 * required: a stricter check here would reject a usable review over an absent
 * `code_location`, which the table already handles by saying the finding cites nothing. */
function reviewViolation(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return 'not a JSON object';
  if (!Array.isArray(v.findings)) return 'findings is not an array';
  if (typeof v.overall_correctness !== 'string') return 'overall_correctness is not a string';
  for (const [i, f] of v.findings.entries()) {
    if (f === null || typeof f !== 'object' || Array.isArray(f)) return `findings[${i}] is not an object`;
    if (typeof f.title !== 'string') return `findings[${i}].title is not a string`;
    if (typeof f.body !== 'string') return `findings[${i}].body is not a string`;
  }
  return null;
}

/** Whitespace-collapsed, length-bounded — the shape every `reason` excerpt takes, so a provider
 * that answers with a 40 KB HTML error page costs one line and not a screenful. */
function excerpt(s, max = 300) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

/** A flag the operator never configured: absent, empty, or an unsubstituted placeholder are the
 * SAME fact (header). Returns the value or null — callers must never branch on which of the
 * three it was, because the operator's remedy is identical for all three. */
function configured(value) {
  if (value == null) return null;
  const v = String(value).trim();
  if (v === '' || PLACEHOLDER_RE.test(v)) return null;
  return v;
}

// --- envelopes ----------------------------------------------------------------------------------
// The stdout contract is EXACTLY ONE JSON object, on every path that exits 0. Both shapes are
// built here rather than at their call sites so that no branch can invent a fourth field or drop
// `backend` — which every envelope carries, unavailable ones included, because the review
// artifact and the pre-merge human are entitled to know which second opinion they did not get.

/** The routing value VERBATIM (`google` stays `google`, never the `api` recipe it rode). */
const unavailable = (backend, cause, reason) => ({ available: false, backend, unavailable: cause, reason });

// --- core ---------------------------------------------------------------------------------------

/**
 * The testable core. Writes NOTHING and returns everything.
 * @param {string[]} argv unsplit argv (kernel/args.mjs invariant)
 * @param {{fetch: Function, env?: object, cwd?: string, timeoutMs?: number}} deps
 * @returns {Promise<{code: number, envelope: object, output: string}>}
 */
export async function consultCore(argv, deps = {}) {
  const {
    fetch: fetchImpl,
    env = process.env,
    cwd = process.cwd(),
    timeoutMs = TIMEOUT_MS,
  } = deps;
  if (typeof fetchImpl !== 'function') {
    throw new Error('consultCore requires deps.fetch — node 22\'s global fetch, injected so a test can never reach the network');
  }

  const { flags, positional } = parseArgs(argv);

  // --- usage class: raised BEFORE any git read, any file read and any HTTP call ----------------
  // A malformed invocation must not be answered with an envelope. An envelope is a REVIEW RESULT,
  // and "the caller typed the command wrong" is not a fact about the backend — reporting it as
  // one would have the loop record a degraded review and latch a lens that was never asked.
  if (positional.length > 0) throw new Error(`unexpected argument '${positional[0]}'. usage: ${USAGE}`);

  // Routing is resolved FIRST, mirroring the prompt's step-1 RESOLVE-FIRST rule: which recipe
  // this is must be settled before anything else is looked at.
  const backendRaw = flags.backend == null ? null : String(flags.backend).trim();
  const backend = configured(backendRaw);
  if (backend === null || CLI_RECIPE_BACKENDS.includes(backend)) {
    throw new Error(
      `backend ${backendRaw === null ? '(missing --backend)' : `'${backendRaw}'`} is not an API backend. `
      + `${CLI_RECIPE_BACKENDS.join(', ')} are the CLI recipes in agents/consult.md (3a/3b/3d) — run them there; `
      + 'an unsubstituted ${user_config.consult_backend} means "unset", which routes to codex for the same reason. '
      + `legion consult implements the api recipe only. usage: ${USAGE}`,
    );
  }

  // Exactly one scope. Neither is a review of nothing; both is a review of an ambiguity, and
  // silently preferring one would make the caller's typo invisible in the artifact.
  const commit = flags.commit == null ? null : String(flags.commit);
  const base = flags.base == null ? null : String(flags.base);
  if ((commit === null) === (base === null)) {
    throw new Error(`exactly one of --commit <sha> or --base <ref> is required. usage: ${USAGE}`);
  }

  // The question is the DISPATCH's review question and nothing else — the preamble and the schema
  // block are this verb's to compose. Read through deps.cwd so a relative path means the same
  // thing to an in-process test as it does to the child process the agent actually spawns.
  if (flags['question-file'] == null) {
    throw new Error(`missing --question-file <path>. usage: ${USAGE}`);
  }
  const questionPath = String(flags['question-file']);
  let question;
  try {
    question = readFileSync(isAbsolute(questionPath) ? questionPath : join(cwd, questionPath), 'utf8');
  } catch (e) {
    throw new Error(`--question-file ${questionPath} is unreadable: ${e?.message ?? e}. usage: ${USAGE}`);
  }

  // --- config law: from here on every refusal is an ENVELOPE, exit 0 ---------------------------
  // Everything below is a fact about the operator's plugin config, i.e. about whether a second
  // opinion CAN be obtained. That is the `misconfigured` absence, and the loop latches the lens
  // off for the run when it sees one — correctly, since plugin config cannot change mid-run.
  // Installed the moment the token VALUE is read, below, and identity until then — which is not a
  // gap: before that line no token exists in this process, so no envelope can contain one.
  let scrub = (s) => s;
  const emit = (envelope) => {
    // SCRUBBED ON THE VALUES, THEN SERIALISED — not the reverse. Scrubbing the serialised text
    // deletes whatever the token's bytes happen to be, and a token IS an arbitrary string: one
    // spelled `","` deleted the structure between two fields, and JSON.parse then threw out of
    // the one function whose entire contract is "an envelope, always" (measured 2026-08-20).
    // Walking the values first means a deletion can only ever land inside a string, so no token
    // can reach the shape that carries it. The object is still parsed back out of the emitted
    // text, so no caller holds a copy of the envelope that stdout did not carry.
    const text = JSON.stringify(scrubDeep(envelope, scrub));
    return { code: 0, envelope: JSON.parse(text), output: `${text}\n` };
  };

  const row = PROVIDERS[backend];
  if (row === undefined) {
    return emit(unavailable(backend, 'misconfigured',
      `unknown backend '${backend}' — accepted: ${Object.keys(PROVIDERS).join(', ')}`));
  }

  const model = configured(flags.model);
  if (model === null) {
    return emit(unavailable(backend, 'misconfigured',
      'consult_model (--model) is not configured, and an API backend has no default of its own to fall back on'));
  }
  // The independence guard, enforced instead of merely instructed. The lens exists to be a
  // second, NON-Claude opinion; a Claude model here buys the same blind spots twice at the price
  // of an extra dispatch. `/claude/i` catches the bare ids and the vendor-prefixed ones
  // (`us.anthropic.claude-…`) alike, which is why it is a substring test and not an equality one.
  if (/claude/i.test(model)) {
    return emit(unavailable(backend, 'misconfigured',
      `consult_model '${model}' is a Claude model — this lens is the SECOND, non-Claude opinion, so a Claude model here is not one`));
  }

  // An explicit flag OVERRIDES its column of the provider row — that is how a named provider
  // reaches a proxy or a differently-named key. For `api` both columns are null, so the same
  // expression makes them required without a branch of their own.
  const baseUrl = configured(flags['base-url']) ?? row.baseUrl;
  if (baseUrl === null) {
    return emit(unavailable(backend, 'misconfigured',
      "consult_base_url (--base-url) is not configured, and backend 'api' has no provider-table row to resolve one from"));
  }
  const tokenEnv = configured(flags['token-env']) ?? row.tokenEnv;
  if (tokenEnv === null) {
    return emit(unavailable(backend, 'misconfigured',
      "consult_token_env (--token-env) is not configured, and backend 'api' has no provider-table row to resolve one from"));
  }

  // The NAME is config; the VALUE is the operator's shell's business. The reason names the NAME
  // and stops there — an empty and an unset variable are the same remedy, so they are one row.
  const token = env[tokenEnv];
  if (typeof token !== 'string' || token === '') {
    return emit(unavailable(backend, 'misconfigured',
      `the environment variable ${tokenEnv} is unset or empty — legion stores no token, so the operator's shell must export one`));
  }
  scrub = scrubber(token);

  // --- the diff -------------------------------------------------------------------------------
  // Through the kernel git seam, never a private spawn: kernel/git.mjs is the only door (its
  // header E), the pinned config is what stops `diff.external` or a global attributes file
  // rewriting the bytes a reviewer is asked to judge, and test/kernel/git-seam.audit.test.mjs
  // fails the suite on a raw spawnSync('git', …) anywhere in src/.
  // A scope that does not resolve is a USAGE error, not an `other` envelope: the caller named a
  // commit or a ref that is not there, which is a fact about the invocation and not about the
  // backend — classifying it as a lens failure would have the loop record a degraded review for a
  // provider it never called.
  const scope = commit === null
    ? ['diff', ...DIFF_FORMAT, `${base}..HEAD`]
    : ['show', ...DIFF_FORMAT, commit];
  let diff;
  try {
    diff = git(scope, cwd, { maxBuffer: DIFF_MAX_BUFFER });
  } catch (e) {
    throw new Error(
      `could not derive the diff for ${commit === null ? `--base ${base}` : `--commit ${commit}`} in ${cwd} `
      + `— the scope must name something that resolves in this worktree: ${e?.message ?? e}`,
    );
  }
  // Measured on the bytes that would actually be sent, and refused BEFORE the request is built:
  // the whole value of the cap is that an over-cap review costs nothing, so the assertion the
  // test makes is that the recording fetch fake saw zero calls.
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  if (diffBytes > DIFF_CAP_BYTES) {
    return emit(unavailable(backend, 'other',
      `the diff is ${diffBytes} bytes, over the ${DIFF_CAP_BYTES}-byte cap — refused whole and nothing was sent. `
      + 'Never truncated: a truncated diff invites a confident "patch is correct" about code nobody read'));
  }
  // The cap's other half (isEmptyScope): refused BEFORE the request for the same reason and at
  // the same cost. A scope with no patch in it is not a passing review, it is an absent one.
  if (isEmptyScope(diff)) {
    return emit(unavailable(backend, 'other',
      `the ${commit === null ? `--base ${base}` : `--commit ${commit}`} scope carries no patch to review `
      + `(${diffBytes} bytes, none of them a diff) — refused before the request. Sending it would buy `
      + 'a confident "patch is correct" about nothing at all'));
  }

  // --- the one request ---------------------------------------------------------------------
  // OPTION A, WITHOUT EXCEPTION (header): `response_format: {"type":"json_object"}` for every API
  // backend. NO temperature AND NO max_tokens — several providers reject them outright, the
  // recipe this replaces sent neither, and a low max_tokens on a reasoning model was MEASURED to
  // return HTTP 200 with EMPTY content, i.e. a review that silently did not happen. Three fields
  // is the whole body, and a test asserts nothing else is in it.
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        // The token's ONLY appearance anywhere in this process. It is not logged, not echoed and
        // not carried in any other structure — header, "the token never enters a model context".
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: composePrompt(question, diff) }],
        response_format: { type: 'json_object' },
      }),
      // The 900 s bound, replacing curl's `--max-time 900` with the same semantics. AbortSignal
      // .timeout rejects with a DOMException named TimeoutError, which is what the row below reads.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return emit(unavailable(backend, 'timeout', `no answer within ${timeoutMs} ms — the request was aborted at the bound`));
    }
    const code = e?.cause?.code ?? e?.code;
    if (isNetworkCause(code)) {
      return emit(unavailable(backend, 'network', `${code} reaching ${url}: ${excerpt(e?.cause?.message ?? e?.message ?? e)}`));
    }
    // A rejection this verb cannot name is `other` — transient by the latch's reading, which is
    // the safe direction for an unknown: it costs one more dispatch, never a whole run of them.
    return emit(unavailable(backend, 'other', `the request to ${url} failed: ${excerpt(e?.message ?? e)}`));
  }

  const httpStatus = res.status;
  // Read once, for both the error excerpt and the success parse: a body can only be consumed once,
  // and a second read would turn a real 200 into an `other` about a stream that was already gone.
  let text;
  try { text = await res.text(); } catch (e) { text = `<the response body could not be read: ${e?.message ?? e}>`; }

  if (httpStatus === 401 || httpStatus === 403) {
    return emit(unavailable(backend, 'not-authenticated', `HTTP ${httpStatus}: ${excerpt(text)}`));
  }
  if (httpStatus === 429) return emit(unavailable(backend, 'quota', `HTTP ${httpStatus}: ${excerpt(text)}`));
  if (httpStatus !== 200) return emit(unavailable(backend, 'other', `HTTP ${httpStatus}: ${excerpt(text)}`));

  let payload;
  try { payload = JSON.parse(text); } catch {
    return emit(unavailable(backend, 'other', `HTTP 200 with a body that is not JSON: ${excerpt(text)}`));
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    // MEASURED: an empty `content` on a 200 is what a truncated reasoning run looks like. Reading
    // it as "no findings" would be the silent false pass this whole lens exists to prevent.
    return emit(unavailable(backend, 'other', `HTTP 200 with no usable choices[0].message.content: ${excerpt(text)}`));
  }
  let review;
  try { review = JSON.parse(stripFences(content)); } catch {
    return emit(unavailable(backend, 'other', `the model answered with something that is not one JSON object: ${excerpt(content)}`));
  }
  const violation = reviewViolation(review);
  if (violation !== null) {
    return emit(unavailable(backend, 'other', `the model's JSON is not a review (${violation}): ${excerpt(content)}`));
  }

  // `review` rides back in the CODEX SCHEMA, untouched: the agent's existing translation step is
  // one table for all three recipes, and reshaping it here would need a second one.
  return emit({ available: true, backend, model, baseUrl, tokenEnv, httpStatus, review });
}

export async function run(argv) {
  const r = await consultCore(argv, { fetch: globalThis.fetch });
  process.stdout.write(r.output);
  return r.code;
}
