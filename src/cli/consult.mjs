// consult.mjs — `legion consult`: every recipe of the second-opinion lens — codex, agy, and the
// OpenAI-compatible api — as one deterministic verb.
//
// WHY A VERB AND NOT PROSE. Each recipe of agents/consult.md used to be shell for a haiku agent
// to assemble by hand: ~50 lines for the api one (a JSON payload built with `node -e`, a curl
// line whose only safe spelling of the token was one shell expansion, a status table to read the
// outcome off), ~250 for codex and agy together (a probe, a perl alarm, a backgrounded SIGKILL
// watchdog, an event stream to read, two outcome tables with an order that mattered, and a
// translation table). Every one of those is a step a model can get subtly right and occasionally
// wrong, and the failure modes are the two this lens exists to prevent: a review that never ran
// reported as a pass, and a credential that reached a transcript. The judgement is not the
// model's to make, so it is not the model's to make: the agent passes the four userConfig values
// through as flags and reads back one JSON object whose findings are already in the return
// contract's shape.
//
// READ-ONLY, ABSOLUTELY — the same property `legion doctor` holds and for the same reason. This
// verb resolves no dossier, takes no lock, mints no evidence and records no review; the one thing
// it writes is a `mkdtempSync` directory under os.tmpdir() for the files the CLIs insist on
// (codex's `-o`, agy's `--json-schema`), removed in a `finally` before the envelope is emitted.
// Its only outputs are stdout and the exit code. (The kernel is not ignorant of consult:
// state.mjs REVIEW_RECEIPT_AGENT_ROLES maps the `consult` review ROLE, and the build loop records
// its verdict with `legion state review-record --role consult`. What the kernel owns no row for
// is a consult GATE — PROFILE_REVIEW_ROLES names none, deliberately. This verb sits on neither
// path: it fetches an opinion, and the caller does everything else with it.)
//
// EXIT CODE, AND WHY `available:false` IS A ZERO. 0 means an envelope was emitted — INCLUDING an
// `available:false` one. A missing lens is a valid, complete answer: the build loop records the
// review as degraded and continues, and it is a ZERO exit that stops the haiku caller from
// treating the answer as a broken command and "repairing" it into some other backend. 1 is
// reserved for a call that was never a review request at all — bad flags, an unreadable question
// file, a commit that does not resolve — where the router prints `legion consult: <message>` on
// stderr and NO envelope is written to stdout. Those two classes must not blur: an envelope on
// stderr is unreadable to the caller, and a non-zero exit for a quota-exhausted provider is a lie
// about whose fault it is.
//
// CODEX IS PLAIN `codex exec`, NOT `codex exec review`. MEASURED on codex-cli 0.145.0
// (2026-08-20): `exec review --commit <SHA> … "<prompt>"` exits 2 at argument parsing — `the
// argument '--commit <SHA>' cannot be used with '[PROMPT]'`, and `--base` conflicts identically —
// so the review subcommand can never carry the dispatch question or a contested-finding
// adjudication. Plain `exec` takes the prompt, and with it the same verb-assembled diff, cap,
// composed prompt and schema file the agy recipe uses; `--sandbox read-only` is the read-only
// posture, and `--dangerously-bypass-approvals-and-sandbox` is never passed. The flag set in
// codexRecipe was run on the real binary and parses (`thread.started`, then `turn.started`); its
// SUCCESS shape could not be measured that day — the note at the site says why.
//
// THE OUTCOME IS READ OFF THE BACKEND'S OWN ENVELOPE, NEVER OFF ITS EXIT CODE. codex says what
// went wrong only in the JSONL on stdout — `{"type":"error","message":…}` at the top level, or
// `{"type":"turn.failed","error":{"message":…}}` nested; both spellings are read — and its exit
// code is not the signal (a usage-limit death exited 1 under `exec` and 0 under the old
// subcommand). agy (1.1.16) says it in the `error` field of its JSON envelope, with the exit code
// as a mere echo. The one outcome no envelope can carry is the kill: kernel/runner.mjs's
// spawnSync timeout sends SIGKILL, which is the ONLY bound agy honours — measured, it survives
// SIGALRM and runs to completion under the `perl -e 'alarm N'` wrapper the old recipes used — so
// that row is read off `spawnError`.
//
// AGY: TWO BOUNDS, TWO JOBS, AND `reason` IS NEVER STDERR. `--print-timeout 900s` is the inner,
// structured deadline: it governs the post-authentication wait and returns a parseable envelope
// (`error: "timeout waiting for response"`). It does NOT reach the authentication path, which
// runs on agy's own fixed ~100 s deadline — measured with the network black-holed, the run
// returned at 1 m 40.194 s under `--print-timeout 15s` and at 1 m 40.200 s under `300s` — and
// ends in `error: "authentication failed or timed out"`. That string contains "timed out", so the
// auth row of MESSAGE_ROWS sits ABOVE the timeout row: first match wins, and inverted, a stale
// login is reported as a slow model that the loop retries instead of latching. The SIGKILL
// watchdog at AGY_WATCHDOG_MS is a BACKSTOP for a hang that neither fails auth nor completes, a
// class no measurement establishes; it stays strictly above the inner bound so it cannot pre-empt
// the structured return. And on the auth path agy writes a Google OAuth URL carrying a live
// `code_challenge` to STDERR — so `reason` is the envelope's `error` field, or a literal on the
// kill row, and stderr is never quoted on this backend.
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
// `cli-missing` IS A CLI ROW. The api path spawns nothing, so it can never emit it: its curl exit
// codes are replaced one for one, semantics preserved — 6/7/35 (DNS, refused, TLS) → a fetch
// rejection whose `cause.code` is in NETWORK_CAUSE_CODES; 28 (`--max-time`) → the AbortSignal
// below. codex and agy reach it through kernel/runner.mjs's `spawnError: 'ENOENT'`, which is the
// one signal that means "no binary" and nothing else (no shell, so no 127 to misread).
//
// PLACEHOLDER REJECTION IS AN INVARIANT, NOT A COURTESY. MEASURED on Claude Code 2.1.236: a
// userConfig option the operator never set is left in the agent prompt as the LITERAL
// `${user_config.…}` — the manifest `default` is NOT substituted in its place. The agent is told
// to pass all four values through verbatim precisely so it makes no judgement about them, which
// means unsubstituted placeholders arrive here. Any flag value matching PLACEHOLDER_RE is read as
// UNSET, and it is never echoed onward: sending `${user_config.consult_model}` to a provider as a
// model name is the exact accident this rule exists to make impossible. An unset BACKEND routes
// to codex — the manifest default, enforced here rather than left to the prompt.
//
// SHAPE: consultCore(argv, deps) is pure — it writes nothing and returns { code, envelope, output }
// — and run(argv) prints output and returns code. `deps.fetch` and `deps.run` have NO DEFAULT and
// are type-checked by name: a test that forgets to inject a fake must fail loudly rather than
// reach the network or spawn a real CLI.
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { parseArgs } from '../kernel/args.mjs';
import { git } from '../kernel/git.mjs';
import { realRunner } from '../kernel/runner.mjs';

export const USAGE =
  'legion consult --backend <codex|agy|openai|google|xai|deepseek|mistral|api> [--model <name>] '
  + '[--base-url <url>] [--token-env <NAME>] (--commit <sha> | --base <ref>) --question-file <path>';

/** The resolved endpoint and token env var NAME per named API backend. A table of PROVIDERS,
 * never of models: the model is always `--model`. `api` is a row with both columns null — the
 * "bring your own endpoint" case — so that "an explicit flag overrides its column" is ONE rule
 * with no special case, and so the API-backend list is exactly Object.keys(PROVIDERS).
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

/** Every routing value this verb accepts: the two CLI recipes, then the provider rows. Anything
 * else is a `misconfigured` envelope naming this list. */
export const BACKENDS = ['codex', 'agy', ...Object.keys(PROVIDERS)];

/** A value the plugin loader never substituted (header). Anchored at the start: a model whose
 * real name merely CONTAINS the text is not a placeholder. */
export const PLACEHOLDER_RE = /^\$\{user_config\./;

/** The `unavailable` causes this verb can emit — a SUBSET of the enum in workflows/build-loop.js
 * (today the whole of it). A cross-pin in the test file asserts the subset relation, so adding a
 * cause here that the loop's REVIEW_SCHEMA would drop cannot pass silently. */
export const UNAVAILABLE_CAUSES = [
  'cli-missing', 'misconfigured', 'not-authenticated', 'quota', 'network', 'timeout', 'other',
];

/** 256 KiB, on the composed diff exactly as it would be sent — raised from 200 KiB on 2026-08-20,
 * when the commit that built this verb measured 208 KiB and was refused. Over it the review is
 * REFUSED whole and nothing is spent — never truncated: a truncated diff buys a confident
 * "patch is correct" about code nobody read, which is the silent false pass this lens exists to
 * prevent. Every recipe hands the diff over itself, so every recipe is capped here. */
export const DIFF_CAP_BYTES = 262144;

/** 900 s, the bound the curl line carried as `--max-time 900` and the old CLI recipes as
 * `perl -e 'alarm 900'`. Not a public flag: the caller is a haiku agent, and a timeout it can
 * lower is a timeout that turns a slow reasoning model into a `timeout` envelope. Tests override
 * it through deps.timeoutMs. */
export const TIMEOUT_MS = 900_000;

/** The model agy runs when `--model` is unset. A pin, cost-first and deliberate: `--model` is
 * never omitted, because leaving the choice to the CLI's own default lets an upstream change
 * silently alter what every second opinion is worth, with nobody having decided anything. */
export const AGY_DEFAULT_MODEL = 'gemini-3.7-flash-medium';

/** agy's inner, structured deadline (header): the only bound that returns a parseable envelope. */
export const AGY_PRINT_TIMEOUT_S = 900;

/** The SIGKILL backstop, strictly above the inner bound with room for agy to write its envelope
 * and exit once `--print-timeout` has fired. A SEQUENCING requirement, not a latency budget:
 * nothing measured says how large the cushion must be, and a test pins only the order. */
export const AGY_WATCHDOG_MS = 1_080_000;

/** The JSON Schema both CLI recipes hand their binary — `--output-schema` on codex,
 * `--json-schema` on agy — the codex shape, enforced rather than asked for in prose, so the
 * answer arrives in the one shape translate() reads. */
export const REVIEW_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['findings', 'overall_correctness', 'overall_explanation'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body', 'priority', 'code_location'],
        properties: {
          title: { type: 'string' },
          body: { type: 'string' },
          priority: { type: 'integer' },
          code_location: {
            type: 'object',
            additionalProperties: false,
            required: ['absolute_file_path', 'line_range'],
            properties: {
              absolute_file_path: { type: 'string' },
              line_range: {
                type: 'object',
                additionalProperties: false,
                required: ['start', 'end'],
                properties: { start: { type: 'integer' }, end: { type: 'integer' } },
              },
            },
          },
        },
      },
    },
    overall_correctness: { type: 'string' },
    overall_explanation: { type: 'string' },
  },
};

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
// these two blocks are the contract and the local validation below is its enforcement. codex and
// agy get the same text on top of REVIEW_SCHEMA, and deliberately so: one pinned question across
// every backend is what lets ONE translate() serve every recipe, and a reworded copy would
// silently give one path a different answer shape nobody would notice until a `where` came back
// empty.

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
 * diff goes LAST so that the instructions are never pushed out of a model's attention by 256 KiB
 * of patch, and so that diff content shaped like an instruction reads as the data it is. */
export function composePrompt(question, diff) {
  return `${REVIEWER_PREAMBLE}\n${question.trim()}\n${SCHEMA_BLOCK}\n\n${diff}`;
}

// --- classification ------------------------------------------------------------------------------
// The lookup the agent used to read off a table, in code. It is a LOOKUP, never a judgement: the
// build loop LATCHES the lens off for the rest of the run on a durable cause (cli-missing,
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

/** The CLI recipes' message table, ORDERED — first match wins, and the order is part of the rule
 * (header: agy's `authentication failed or timed out` contains "timed out", so the auth row must
 * precede the timeout row). One table for codex and agy: both hand this verb their own sentence
 * about what went wrong, and the rows are the classes the loop's latch distinguishes. No row
 * matched is `other`, which the latch reads as transient — the safe direction for an unknown. */
const MESSAGE_ROWS = [
  ['not-authenticated', /authenticat|not logged in|unauthori[sz]ed|invalid api key|\blog ?in\b/i],
  ['timeout', /timeout waiting for response|\btimed out\b/i],
  ['quota', /usage limit|rate limit|quota|too many requests/i],
  ['network', /\bnetwork\b|connection|\bdns\b|\btls\b|certificate|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN/i],
  ['misconfigured', /unknown model|unsupported model|model .{0,40}not found|not a valid model/i],
];
const classifyMessage = (message) => MESSAGE_ROWS.find(([, re]) => re.test(message))?.[0] ?? 'other';

/** The reason on the one agy row that has no envelope to quote: a SIGKILLed run wrote no
 * `error` field, and the only text left is the stderr that may carry the OAuth challenge. */
const AGY_WATCHDOG_REASON = `agy exceeded the ${AGY_WATCHDOG_MS / 1000} s watchdog and was killed; no envelope was written`;

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

/** Markdown fences off: `json_object` is honoured by every provider measured, but a model that
 * ignores it answers with a fenced block, and refusing that as unparsable would throw away a
 * review that was in fact returned. */
function stripFences(content) {
  const t = content.trim();
  const m = /^```[A-Za-z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/.exec(t);
  return m ? m[1].trim() : t;
}

/** The LOCAL enforcement of the answer shape — the half `response_format: {"type":"json_object"}`
 * does not buy (header): it guarantees the bytes parse, never which keys they carry. Returns the
 * violation in words, or null. Only the fields translate() actually reads are required: a
 * stricter check here would reject a usable review over an absent `code_location`, which the
 * translation already handles by saying the finding cites nothing. */
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

// --- translation --------------------------------------------------------------------------------
// The codex schema → the return contract's findings, in code rather than in a table the agent
// applied by hand. Fixed so that no tiering judgement is ever the agent's: every recipe asks for
// (codex, api) or enforces (agy) the same object with the same priority polarity, so ONE mapping
// serves them all.

const TITLE_TAG_RE = /^\s*\[P([0-3])\]\s*/;

/** What a "cite" looks like in a finding's body: a path or file name with an extension (and an
 * optional `:line`), a spoken `line N`, or a `name()` call. The extension is two letters or more
 * so that `e.g.` and `i.e.` do not pass as files. */
const CITE_RE = /\b[\w-]+(?:\/[\w.-]+)*\.[a-z]{2,5}\b(?::\d+)?|\bline\s+\d+|\b[\w.]+\(\)/i;

/** `priority` wins when the backend set it; the `[Pn]` title tag is the fallback for a backend
 * that only spoke the tier in the title. 0 ⇒ block, 1 ⇒ must-fix, everything else — 2, 3,
 * null, absent — ⇒ note. */
function tierOf(finding, tagPriority) {
  const priority = Number.isInteger(finding.priority) ? finding.priority : tagPriority;
  if (priority === 0) return 'block';
  if (priority === 1) return 'must-fix';
  return 'note';
}

/** The realpath of `p` through its deepest EXISTING ancestor, so that a cited file the patch
 * deleted (or the model misremembered) still has the symlink in its directory resolved. */
function realpathDeep(p) {
  const tail = [];
  let head = p;
  for (;;) {
    try { return join(realpathSync(head), ...tail); } catch { /* climb */ }
    const parent = dirname(head);
    if (parent === head) return p;
    tail.unshift(basename(head));
    head = parent;
  }
}

/** `file` relative to the worktree, through whichever spelling of either path lands inside it.
 * MEASURED: macOS spells a temp worktree `/var/…` while `process.cwd()` reports its realpath
 * `/private/var/…`, and a backend cites whichever it resolved — a naive `relative()` then walks
 * up eight `../` to cross the symlink. A file inside no spelling falls back to the plain relative
 * path, which is at least honest about where it points. */
function relativeToWorktree(cwd, file) {
  const roots = new Set([cwd, realpathDeep(cwd)]);
  const candidates = new Set([file, realpathDeep(file)]);
  for (const root of roots) {
    for (const candidate of candidates) {
      const rel = relative(root, candidate);
      if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return rel;
    }
  }
  return relative(cwd, file);
}

/** `file:line`, repo-relative. A path the model already gave relative stays as given — resolving
 * it against the process cwd would invent a `../..` prefix for nothing. */
function whereOf(location, cwd) {
  const file = location?.absolute_file_path;
  if (typeof file !== 'string' || file === '') return '';
  const rel = isAbsolute(file) ? relativeToWorktree(cwd, file) : file;
  const start = location?.line_range?.start;
  return Number.isInteger(start) ? `${rel}:${start}` : rel;
}

/** The first sentence of the body that cites something, else the one sentence the contract
 * requires in its place — so a vague finding is kept vague and SAYS so, rather than sharpened. */
function proofOf(body) {
  const sentence = body.split(/(?<=[.!?])\s+|\n+/).find((s) => CITE_RE.test(s));
  return sentence === undefined ? 'cites no file, line or function' : sentence.trim();
}

/**
 * Translate a review in the codex schema into the return contract's `verdict`, `findings` and
 * `raw`. `fix` is always empty: no backend has a fix field, and a remedy invented here would be
 * the verb's, not the second opinion's. The verdict is the backend's — "patch is incorrect", or
 * any finding at a blocking tier — never a judgement of this function's.
 * @param {{findings: object[], overall_correctness: string, overall_explanation?: string}} review
 * @param {string} cwd the worktree, for repo-relative `where`
 */
export function translate(review, cwd) {
  const findings = review.findings.map((f) => {
    const tag = TITLE_TAG_RE.exec(f.title);
    return {
      tier: tierOf(f, tag === null ? null : Number(tag[1])),
      title: f.title.replace(TITLE_TAG_RE, '').trim(),
      where: whereOf(f.code_location, cwd),
      issue: f.body,
      proof: proofOf(f.body),
      fix: '',
    };
  });
  const blocking = findings.some((f) => f.tier !== 'note');
  return {
    verdict: review.overall_correctness === 'patch is incorrect' || blocking ? 'fail' : 'pass',
    findings,
    raw: typeof review.overall_explanation === 'string' ? review.overall_explanation.trim() : '',
  };
}

// --- envelopes ----------------------------------------------------------------------------------
// The stdout contract is EXACTLY ONE JSON object, on every path that exits 0. Both shapes are
// built here rather than at their call sites so that no branch can invent a fourth field or drop
// `backend` — which every envelope carries, unavailable ones included, because the review
// artifact and the pre-merge human are entitled to know which second opinion they did not get.

/** The routing value VERBATIM (`google` stays `google`, never the `api` recipe it rode). */
const unavailable = (backend, cause, reason) => ({ available: false, backend, unavailable: cause, reason });

/** A recipe's refusal, before it becomes an envelope: the cause off the table and the reason. */
const absent = (cause, reason) => ({ cause, reason });

// --- the shared pieces ----------------------------------------------------------------------------

/** The bytes a reviewer is handed, through the kernel git seam and never a private spawn:
 * kernel/git.mjs is the only door (its header E), the pinned config is what stops `diff.external`
 * or a global attributes file rewriting the bytes a reviewer is asked to judge, and
 * test/kernel/git-seam.audit.test.mjs fails the suite on a raw spawnSync('git', …) anywhere in
 * src/. A scope that does not resolve is a USAGE error, not an `other` envelope: the caller named
 * a commit or a ref that is not there, which is a fact about the invocation and not about the
 * backend — classifying it as a lens failure would have the loop record a degraded review for a
 * provider it never called. */
function deriveDiff({ commit, base, label }, cwd) {
  const scope = commit === null
    ? ['diff', ...DIFF_FORMAT, `${base}..HEAD`]
    : ['show', ...DIFF_FORMAT, commit];
  try {
    return git(scope, cwd, { maxBuffer: DIFF_MAX_BUFFER });
  } catch (e) {
    throw new Error(
      `could not derive the diff for ${label} in ${cwd} `
      + `— the scope must name something that resolves in this worktree: ${e?.message ?? e}`,
    );
  }
}

/** The two refusals made BEFORE anything is spent, measured on the bytes that would actually be
 * sent: over the cap, and nothing in the scope at all. Null when the diff is reviewable. The
 * whole value of both is that a refused review costs nothing, so the assertion the tests make is
 * that the recording fake saw zero calls. */
function scopeRefusal(diff, label) {
  const diffBytes = Buffer.byteLength(diff, 'utf8');
  if (diffBytes > DIFF_CAP_BYTES) {
    return absent('other',
      `the diff is ${diffBytes} bytes, over the ${DIFF_CAP_BYTES}-byte cap — refused whole and nothing was sent. `
      + 'Never truncated: a truncated diff invites a confident "patch is correct" about code nobody read');
  }
  if (isEmptyScope(diff)) {
    return absent('other',
      `the ${label} scope carries no patch to review (${diffBytes} bytes, none of them a diff) — refused `
      + 'before the request. Sending it would buy a confident "patch is correct" about nothing at all');
  }
  return null;
}

/** The independence guard, enforced instead of merely instructed. The lens exists to be a
 * second, NON-Claude opinion; a Claude model here buys the same blind spots twice at the price
 * of an extra dispatch. `/claude/i` catches the bare ids and the vendor-prefixed ones
 * (`us.anthropic.claude-…`) alike, which is why it is a substring test and not an equality one.
 * Codex is exempt: it serves no Claude model, so there is nothing for the guard to catch. */
function claudeGuard(model) {
  if (model === null || !/claude/i.test(model)) return null;
  return absent('misconfigured',
    `consult_model '${model}' is a Claude model — this lens is the SECOND, non-Claude opinion, so a Claude model here is not one`);
}

/** The backend's answer text as a review object, or the `other` refusal that says it was not one. */
function parseReview(text, who) {
  let review;
  try { review = JSON.parse(stripFences(text)); } catch {
    return absent('other', `${who} answered with something that is not one JSON object: ${excerpt(text)}`);
  }
  return { review };
}

/** A scratch directory under os.tmpdir() for the run, removed whatever happens inside — the
 * worktree stays byte-identical and nothing of the verb's outlives the envelope. */
function withScratch(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'legion-consult-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** REVIEW_SCHEMA written into the scratch dir, for the flag that takes a file path. */
function schemaFile(dir) {
  const path = join(dir, 'schema.json');
  writeFileSync(path, JSON.stringify(REVIEW_SCHEMA));
  return path;
}

/** The JSONL events on a stdout, one object per parseable line; anything else is skipped. */
function jsonLines(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try { events.push(JSON.parse(line)); } catch { /* not an event */ }
  }
  return events;
}

// --- recipe: codex --------------------------------------------------------------------------------

/** Plain `codex exec` in the worktree (the runner's cwd; no `-C`), the composed prompt on argv
 * (macOS ARG_MAX is 1 MiB; the 256 KiB cap sits inside it, the margin agy relies on too), the
 * answer shape enforced by `--output-schema` and read back through `-o`. `--sandbox read-only` is
 * the read-only posture. `-m` rides along only when a model is configured; otherwise the default
 * in `~/.codex/config.toml` applies, and the envelope's `model` is null because that default is
 * not knowable from here. */
function codexRecipe(run, { cwd, model, prompt, timeoutMs }) {
  return withScratch((dir) => {
    const last = join(dir, 'last.txt');
    const r = run('codex', [
      'exec', '--json', '--sandbox', 'read-only', '--output-schema', schemaFile(dir), '-o', last,
      ...(model === null ? [] : ['-m', model]), prompt,
    ], { cwd, timeoutMs });
    if (r.spawnError === 'ENOENT') return absent('cli-missing', 'codex is not on PATH — the codex CLI is not installed, or not where this shell can see it');
    if (r.spawnError === 'ETIMEDOUT' || r.signal === 'SIGKILL') {
      return absent('timeout', `codex gave no answer within ${timeoutMs} ms and was killed; no envelope was written`);
    }

    // The outcome is in the event stream (header). `error` carries `message` at the top level,
    // `turn.failed` nests it under `error.message` — MEASURED, both spellings — and codex is not
    // paraphrased. ONE DELIBERATE LOSS: an answer item FOLLOWED by a failure is real findings from
    // a review that did not finish — `other`, and none of those findings are kept. A truncated
    // "patch is correct" is exactly the silent false pass this lens exists to prevent; partial
    // findings cost a degradation note, a truncated pass costs a bad merge.
    let answer = null;
    for (const ev of jsonLines(r.stdout)) {
      if (ev.type === 'error' || ev.type === 'turn.failed') {
        const message = typeof ev.message === 'string' ? ev.message : (ev.error?.message ?? excerpt(JSON.stringify(ev)));
        if (answer !== null) {
          return absent('other', `codex produced an answer and then failed the turn — its findings are discarded whole: ${message}`);
        }
        return absent(classifyMessage(message), message);
      }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
        answer = ev.item.text;
      }
    }

    // DOCUMENTED, NOT MEASURED (2026-08-20): the success shape. The account's codex quota was
    // exhausted until 2026-08-22 02:20, so what is built here is codex's documented `--json`
    // contract — `-o` receives the final agent message, which under `--output-schema` is the
    // schema-conforming JSON, and the same text arrives as the LAST `item.completed` of type
    // `agent_message`. The first live pass should confirm both; parseReview and reviewViolation
    // refuse anything that is not a review either way.
    let text;
    try { text = readFileSync(last, 'utf8'); } catch { text = answer; }
    if (text === null) {
      // No event named a cause and no answer was written, so codex's stderr is the one text
      // left — and unlike agy's it was measured to carry no credential: `Reading additional
      // input from stdin...` (the runner closes stdin; harmless) and cache log lines.
      const tail = excerpt(r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`);
      return absent(classifyMessage(tail), `codex wrote no review (exit ${r.code}): ${tail}`);
    }
    return { ...parseReview(text, 'codex'), model };
  });
}

// --- recipe: agy ----------------------------------------------------------------------------------

/** Antigravity in print mode, the whole prompt on argv. agy denies every tool by default —
 * measured: asked to run `git log` it came back exit 1, `error: "permission check failed … user
 * denied permission"` — so the diff is this verb's to derive, as it is for codex too now that
 * `exec review` takes no prompt — and the flag that would let it
 * (`--dangerously-skip-permissions`) is one this lens never passes: default-deny IS the
 * read-only posture, and once the diff is in the prompt the lens needs no tool at all. argv,
 * not stdin: agy reads stdin only under `--input-format stream-json`, which drags
 * `--output-format stream-json` along with it and costs the envelope this recipe reads;
 * measured, a 191 KiB prompt through argv returned SUCCESS, and macOS ARG_MAX is 1 MiB, so the
 * 256 KiB cap sits inside a 4x margin. `--mode plan` is never added: measured, it is silently
 * inert beside `--disable-slash-commands`, and it is the latter we keep — it closes the surface
 * where a diff line beginning with `/` expands into a command. */
function agyRecipe(run, { cwd, model, prompt }) {
  return withScratch((dir) => {
    const r = run('agy', [
      '-p', prompt, '--model', model, '--output-format', 'json', '--json-schema', schemaFile(dir),
      '--print-timeout', `${AGY_PRINT_TIMEOUT_S}s`, '--disable-slash-commands',
    ], { cwd, timeoutMs: AGY_WATCHDOG_MS });

    // The outcome table, in its measured ORDER (header). stderr is never read on this backend.
    if (r.spawnError === 'ENOENT') return absent('cli-missing', 'agy is not on PATH — the Antigravity CLI is not installed, or not where this shell can see it');
    if (r.spawnError === 'ETIMEDOUT' || r.signal === 'SIGKILL') return absent('timeout', AGY_WATCHDOG_REASON);
    let envelope = null;
    try { envelope = JSON.parse(r.stdout); } catch { /* not an envelope */ }
    if (envelope === null || typeof envelope !== 'object') {
      return absent('other', `agy wrote no JSON envelope (exit ${r.code}); stdout: ${excerpt(r.stdout) || '<empty>'}`);
    }
    if (typeof envelope.error === 'string' && envelope.error !== '') {
      return absent(classifyMessage(envelope.error), envelope.error);
    }
    if (envelope.status !== 'SUCCESS') {
      return absent('other', `agy returned status ${JSON.stringify(envelope.status ?? null)} with no error field`);
    }
    // `structured_output` is the schema-conforming answer; `response` wraps it in
    // toolAction/toolSummary noise and is never read.
    const out = envelope.structured_output;
    if (out === undefined) return absent('other', 'agy returned SUCCESS without a structured_output — the --json-schema answer is absent');
    return { ...(typeof out === 'string' ? parseReview(out, 'agy') : { review: out }), model };
  });
}

// --- recipe: api ----------------------------------------------------------------------------------

/** One POST to `<baseUrl>/chat/completions`. OPTION A, WITHOUT EXCEPTION (header):
 * `response_format: {"type":"json_object"}` for every API backend. NO temperature AND NO
 * max_tokens — several providers reject them outright, the recipe this replaces sent neither,
 * and a low max_tokens on a reasoning model was MEASURED to return HTTP 200 with EMPTY content,
 * i.e. a review that silently did not happen. Three fields is the whole body, and a test asserts
 * nothing else is in it. `onToken` is called the moment the token VALUE is read, so the caller
 * can install the scrubber before any envelope that could carry it exists. */
async function apiRecipe(fetchImpl, { baseUrl, tokenEnv, model, env, prompt, timeoutMs, onToken }) {
  // The NAME is config; the VALUE is the operator's shell's business. The reason names the NAME
  // and stops there — an empty and an unset variable are the same remedy, so they are one row.
  const token = env[tokenEnv];
  if (typeof token !== 'string' || token === '') {
    return absent('misconfigured',
      `the environment variable ${tokenEnv} is unset or empty — legion stores no token, so the operator's shell must export one`);
  }
  onToken(token);

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
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
      // The 900 s bound, replacing curl's `--max-time 900` with the same semantics. AbortSignal
      // .timeout rejects with a DOMException named TimeoutError, which is what the row below reads.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
      return absent('timeout', `no answer within ${timeoutMs} ms — the request was aborted at the bound`);
    }
    const code = e?.cause?.code ?? e?.code;
    if (isNetworkCause(code)) {
      return absent('network', `${code} reaching ${url}: ${excerpt(e?.cause?.message ?? e?.message ?? e)}`);
    }
    // A rejection this verb cannot name is `other` — transient by the latch's reading, which is
    // the safe direction for an unknown: it costs one more dispatch, never a whole run of them.
    return absent('other', `the request to ${url} failed: ${excerpt(e?.message ?? e)}`);
  }

  const httpStatus = res.status;
  // Read once, for both the error excerpt and the success parse: a body can only be consumed once,
  // and a second read would turn a real 200 into an `other` about a stream that was already gone.
  let text;
  try { text = await res.text(); } catch (e) { text = `<the response body could not be read: ${e?.message ?? e}>`; }

  if (httpStatus === 401 || httpStatus === 403) return absent('not-authenticated', `HTTP ${httpStatus}: ${excerpt(text)}`);
  if (httpStatus === 429) return absent('quota', `HTTP ${httpStatus}: ${excerpt(text)}`);
  if (httpStatus !== 200) return absent('other', `HTTP ${httpStatus}: ${excerpt(text)}`);

  let payload;
  try { payload = JSON.parse(text); } catch {
    return absent('other', `HTTP 200 with a body that is not JSON: ${excerpt(text)}`);
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    // MEASURED: an empty `content` on a 200 is what a truncated reasoning run looks like. Reading
    // it as "no findings" would be the silent false pass this whole lens exists to prevent.
    return absent('other', `HTTP 200 with no usable choices[0].message.content: ${excerpt(text)}`);
  }
  return { ...parseReview(content, 'the model'), model, baseUrl, tokenEnv, httpStatus };
}

// --- core ---------------------------------------------------------------------------------------

/**
 * The testable core. Writes NOTHING and returns everything.
 * @param {string[]} argv unsplit argv (kernel/args.mjs invariant)
 * @param {{fetch: Function, run: Function, env?: object, cwd?: string, timeoutMs?: number}} deps
 * @returns {Promise<{code: number, envelope: object, output: string}>}
 */
export async function consultCore(argv, deps = {}) {
  const {
    fetch: fetchImpl,
    run: runImpl,
    env = process.env,
    cwd = process.cwd(),
    timeoutMs = TIMEOUT_MS,
  } = deps;
  if (typeof fetchImpl !== 'function') {
    throw new Error('consultCore requires deps.fetch — node 22\'s global fetch, injected so a test can never reach the network');
  }
  if (typeof runImpl !== 'function') {
    throw new Error('consultCore requires deps.run — the kernel/runner.mjs seam, injected so a test can never spawn codex or agy');
  }

  const { flags, positional } = parseArgs(argv);

  // --- usage class: raised BEFORE any git read, any file read, any spawn and any HTTP call -----
  // A malformed invocation must not be answered with an envelope. An envelope is a REVIEW RESULT,
  // and "the caller typed the command wrong" is not a fact about the backend — reporting it as
  // one would have the loop record a degraded review and latch a lens that was never asked.
  if (positional.length > 0) throw new Error(`unexpected argument '${positional[0]}'. usage: ${USAGE}`);

  // Routing is settled FIRST, before anything else is looked at. Unset — absent, empty or an
  // unsubstituted placeholder — is the manifest default, codex (header).
  const backend = configured(flags.backend) ?? 'codex';

  // Exactly one scope. Neither is a review of nothing; both is a review of an ambiguity, and
  // silently preferring one would make the caller's typo invisible in the artifact.
  const commit = flags.commit == null ? null : String(flags.commit);
  const base = flags.base == null ? null : String(flags.base);
  if ((commit === null) === (base === null)) {
    throw new Error(`exactly one of --commit <sha> or --base <ref> is required. usage: ${USAGE}`);
  }
  const scope = { commit, base, label: commit === null ? `--base ${base}` : `--commit ${commit}` };

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
  // Everything below is a fact about the operator's plugin config or about the backend, i.e.
  // about whether a second opinion CAN be obtained. A config fact is the `misconfigured` absence,
  // and the loop latches the lens off for the run when it sees one — correctly, since plugin
  // config cannot change mid-run.
  // The scrubber is installed the moment a token VALUE is read (the api recipe's onToken) and is
  // identity until then — which is not a gap: before that line no token exists in this process,
  // so no envelope can contain one.
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
  const refuse = ({ cause, reason }) => emit(unavailable(backend, cause, reason));

  const model = configured(flags.model);
  let result;
  if (backend === 'codex') {
    const diff = deriveDiff(scope, cwd);
    const refused = scopeRefusal(diff, scope.label);
    if (refused !== null) return refuse(refused);
    result = codexRecipe(runImpl, { cwd, model, prompt: composePrompt(question, diff), timeoutMs });
  } else if (backend === 'agy') {
    const guarded = claudeGuard(model);
    if (guarded !== null) return refuse(guarded);
    const diff = deriveDiff(scope, cwd);
    const refused = scopeRefusal(diff, scope.label);
    if (refused !== null) return refuse(refused);
    result = agyRecipe(runImpl, { cwd, model: model ?? AGY_DEFAULT_MODEL, prompt: composePrompt(question, diff) });
  } else {
    const row = PROVIDERS[backend];
    if (row === undefined) {
      return refuse(absent('misconfigured', `unknown backend '${backend}' — accepted: ${BACKENDS.join(', ')}`));
    }
    if (model === null) {
      return refuse(absent('misconfigured',
        'consult_model (--model) is not configured, and an API backend has no default of its own to fall back on'));
    }
    const guarded = claudeGuard(model);
    if (guarded !== null) return refuse(guarded);
    // An explicit flag OVERRIDES its column of the provider row — that is how a named provider
    // reaches a proxy or a differently-named key. For `api` both columns are null, so the same
    // expression makes them required without a branch of their own.
    const baseUrl = configured(flags['base-url']) ?? row.baseUrl;
    if (baseUrl === null) {
      return refuse(absent('misconfigured',
        "consult_base_url (--base-url) is not configured, and backend 'api' has no provider-table row to resolve one from"));
    }
    const tokenEnv = configured(flags['token-env']) ?? row.tokenEnv;
    if (tokenEnv === null) {
      return refuse(absent('misconfigured',
        "consult_token_env (--token-env) is not configured, and backend 'api' has no provider-table row to resolve one from"));
    }
    const diff = deriveDiff(scope, cwd);
    const refused = scopeRefusal(diff, scope.label);
    if (refused !== null) return refuse(refused);
    result = await apiRecipe(fetchImpl, {
      baseUrl, tokenEnv, model, env, prompt: composePrompt(question, diff), timeoutMs,
      onToken: (token) => { scrub = scrubber(token); },
    });
  }

  if (result.cause !== undefined) return refuse(result);
  const { review, ...extras } = result;
  const violation = reviewViolation(review);
  if (violation !== null) {
    return refuse(absent('other', `the model's JSON is not a review (${violation}): ${excerpt(JSON.stringify(review))}`));
  }
  return emit({ available: true, backend, ...extras, ...translate(review, cwd) });
}

export async function run(argv) {
  const r = await consultCore(argv, { fetch: globalThis.fetch, run: realRunner().run });
  process.stdout.write(r.output);
  return r.code;
}
