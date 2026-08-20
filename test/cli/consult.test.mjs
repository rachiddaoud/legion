// End-to-end guard for `legion consult` — the api recipe of the second-opinion lens, moved out
// of agents/consult.md and into a verb (src/cli/consult.mjs's header says why).
//
// THIS SUITE NEVER TOUCHES THE NETWORK, AND CANNOT. consultCore takes `deps.fetch` with NO
// DEFAULT and throws by name when it is missing, so a case that forgets to inject a fake fails
// loudly instead of dialling a provider. Every fake here RECORDS its calls, which is what makes
// "no HTTP call was made" an observation (`calls.length === 0`) rather than an inference — the
// difference matters for the two refusals whose whole point is that nothing was spent: a
// misconfigured backend and an over-cap diff.
//
// THE ONE PLACE A SOCKET IS OPENED is a loopback `http.createServer` on 127.0.0.1:0 — the viewer
// suite's pattern — used where an injected function cannot answer the question: that a real abort
// at the 900 s bound classifies as `timeout`, that a real response body carrying the token comes
// back scrubbed, and that the whole thing works through bin/legion.mjs as a child process.
//
// GIT IS REAL AND HERMETIC: applyHardenedGitEnv purges the operator's GIT_* and points
// global/system config at /dev/null, and the diff cases build a throwaway repo with real commits.
// A faked git would prove nothing about the one property the diff path has — that the bytes the
// provider receives are the bytes `git show` produced.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyHardenedGitEnv } from '../../src/kernel/git.mjs';
import {
  CLI_RECIPE_BACKENDS, DIFF_CAP_BYTES, PLACEHOLDER_RE, PROVIDERS, TIMEOUT_MS, UNAVAILABLE_CAUSES,
  USAGE, composePrompt, consultCore, isEmptyScope,
} from '../../src/cli/consult.mjs';

applyHardenedGitEnv(process.env, { identity: { name: 'legion test', email: 'test@example.invalid' } });

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url)))); // test/cli/x -> repo root
const BIN = join(ROOT, 'bin', 'legion.mjs');
const NODE = process.execPath;

let TMP;
let QUESTION;
before(() => {
  TMP = mkdtempSync(join(tmpdir(), 'legion3-consult-'));
  QUESTION = join(TMP, 'q.txt');
  writeFileSync(QUESTION, 'Does this task commit do what its brief says, and is the error handling right?\n');
});
after(() => { rmSync(TMP, { recursive: true, force: true }); });

/** The token every case configures. Distinctive on purpose: the hygiene test greps whole outputs
 * for these bytes, and a value like 'x' would match by accident. */
const TOKEN = 'sk-legion-test-3f9a2c17-never-leaves-the-process';
const TOKEN_ENV = { DEEPSEEK_API_KEY: TOKEN };

/**
 * A recording fetch fake. `responder(url, init)` returns the Response (or throws to simulate a
 * rejection); the default responder FAILS the case, so a test that did not expect a call and got
 * one says so at the call site instead of silently passing.
 */
function fetchFake(responder) {
  const fn = async (url, init) => {
    fn.calls.push({ url, init, body: init?.body === undefined ? null : JSON.parse(init.body) });
    if (responder === undefined) throw new Error(`unexpected HTTP call to ${url}`);
    return responder(url, init);
  };
  fn.calls = [];
  return fn;
}

/** A minimal Response-alike: enough of the surface consultCore reads, built by hand because a
 * real `new Response()` cannot carry a non-standard status and the verb only ever asks for
 * `.status` and `.text()`. */
const reply = (status, body) => ({ status, text: async () => body });

/** The argv every case starts from — a complete, valid invocation — with `over` replacing or
 * (with a null value) DELETING individual flags. Building argv from a map rather than an array
 * keeps each case's diff from the valid call visible in one line. */
function argvFor(over = {}) {
  const flags = {
    '--backend': 'deepseek',
    '--model': 'deepseek-v4-flash',
    '--commit': 'HEAD',
    '--question-file': QUESTION,
    ...over,
  };
  return Object.entries(flags).flatMap(([k, v]) => (v === null ? [] : [k, v]));
}

/** consultCore with the hermetic defaults: an injected fetch, an env holding only the token, and
 * a cwd that is a temp dir rather than this repo (nothing here may read the legion checkout). */
const call = (over = {}, deps = {}) => consultCore(argvFor(over), {
  fetch: deps.fetch ?? fetchFake(),
  env: deps.env ?? TOKEN_ENV,
  cwd: deps.cwd ?? TMP,
  ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }),
});

// --- the dependency seam -------------------------------------------------------------------

test('consultCore refuses to run without the injected fetch seam', async () => {
  // The doctor rule, applied to the one dep whose absence would be answered by the REAL network:
  // a default of globalThis.fetch would make "the test forgot to inject" indistinguishable from
  // "the test meant to use the network", and only one of those may ever happen here.
  await assert.rejects(() => consultCore(argvFor(), {}), /requires deps\.fetch/);
});

// --- §5.1 the usage class: exit 1, no envelope, nothing probed ------------------------------
// Every case here is a call that was never a review request. The router turns the throw into
// `legion consult: <message>` on stderr and exit 1; stdout stays empty, which is the property
// the caller keys on — an envelope on stderr would be unreadable to it.

test('a missing scope flag is a usage error, not an envelope', async () => {
  const f = fetchFake();
  await assert.rejects(() => call({ '--commit': null }, { fetch: f }), /exactly one of --commit <sha> or --base <ref>/);
  assert.equal(f.calls.length, 0);
});

test('BOTH scope flags is a usage error — a review of an ambiguity is not a review', async () => {
  const f = fetchFake();
  await assert.rejects(() => call({ '--base': 'main' }, { fetch: f }), /exactly one of --commit <sha> or --base <ref>/);
  assert.equal(f.calls.length, 0);
});

test('a missing --question-file is a usage error, and the message carries the usage line', async () => {
  await assert.rejects(() => call({ '--question-file': null }), /missing --question-file <path>.*usage: legion consult/s);
});

test('an unreadable --question-file is a usage error naming the path', async () => {
  const missing = join(TMP, 'no-such-question.txt');
  await assert.rejects(() => call({ '--question-file': missing }), new RegExp(`--question-file ${missing} is unreadable`));
});

test('an unexpected positional dies before anything is read', async () => {
  const f = fetchFake();
  await assert.rejects(() => consultCore([...argvFor(), 'stray'], { fetch: f, env: TOKEN_ENV, cwd: TMP }),
    /unexpected argument 'stray'/);
  assert.equal(f.calls.length, 0);
});

test('a valueless flag still fails closed at the parser — the kernel/args.mjs invariant holds here too', async () => {
  await assert.rejects(() => consultCore(['--backend'], { fetch: fetchFake(), env: TOKEN_ENV, cwd: TMP }),
    /missing value for --backend/);
});

for (const backend of CLI_RECIPE_BACKENDS) {
  test(`backend '${backend}' is refused as a USAGE error naming the CLI recipe that owns it`, async () => {
    // Not `misconfigured`: the operator's config is perfectly valid, it was handed to the wrong
    // tool. An envelope here would have the loop record a degraded review and latch a lens that
    // is in fact installed and working.
    const f = fetchFake();
    await assert.rejects(() => call({ '--backend': backend }, { fetch: f }),
      /is not an API backend.*codex, gemini, agy are the CLI recipes in agents\/consult\.md \(3a\/3b\/3d\)/s);
    assert.equal(f.calls.length, 0);
  });
}

test('an UNSUBSTITUTED backend placeholder is the same refusal — unset routes to codex', async () => {
  // MEASURED (src/cli/consult.mjs header): Claude Code leaves an option the operator never set as
  // the literal placeholder. The agent passes it through verbatim by design, so the verb is where
  // it must be read as "unset", and unset means the codex recipe.
  await assert.rejects(() => call({ '--backend': '${user_config.consult_backend}' }),
    /is not an API backend.*unset.*routes to codex/s);
});

test('a missing --backend is refused the same way — routing is settled before anything else', async () => {
  await assert.rejects(() => call({ '--backend': null }), /\(missing --backend\).*is not an API backend/s);
});

// --- §5.2 the misconfigured class: exit 0, an envelope, and ZERO HTTP -----------------------
// A broken config is an ABSENCE of a second opinion, which is a complete answer and therefore a
// zero exit. The loop latches the lens off for the run on it (CONSULT_DURABLE), correctly: plugin
// config cannot change under a running loop, so re-asking only re-bills.

/** Assert the unavailable-envelope invariants shared by every case below, and hand back the
 * envelope for the case's own assertion about `reason`. */
async function misconfigured(over, deps = {}) {
  const f = deps.fetch ?? fetchFake();
  const r = await call(over, { ...deps, fetch: f });
  assert.equal(r.code, 0, 'a missing lens is a valid answer, never a process failure');
  assert.equal(r.envelope.available, false);
  assert.equal(r.envelope.unavailable, 'misconfigured');
  assert.ok(UNAVAILABLE_CAUSES.includes(r.envelope.unavailable));
  assert.equal(r.output, `${JSON.stringify(r.envelope)}\n`, 'stdout is exactly one JSON object');
  assert.equal(f.calls.length, 0, 'a config refusal must not spend a request');
  return r.envelope;
}

test('an unknown backend value names what it received and lists what is accepted', async () => {
  const e = await misconfigured({ '--backend': 'perplexity' });
  assert.equal(e.backend, 'perplexity', 'the routing value rides back verbatim, even when it is the problem');
  assert.match(e.reason, /unknown backend 'perplexity'/);
  for (const known of Object.keys(PROVIDERS)) assert.ok(e.reason.includes(known), `the accepted list must offer ${known}`);
});

test('a missing --model is misconfigured — an API backend has no default of its own', async () => {
  const e = await misconfigured({ '--model': null });
  assert.match(e.reason, /consult_model \(--model\) is not configured/);
});

test('a PLACEHOLDER --model is read as unset, and is never echoed onward', async () => {
  const e = await misconfigured({ '--model': '${user_config.consult_model}' });
  assert.match(e.reason, /consult_model \(--model\) is not configured/);
  assert.ok(!e.reason.includes('${user_config'), 'the placeholder must not reappear in the reason it caused');
});

test('an EMPTY --model= is the same fact as an absent one', async () => {
  // `--model=` is the only spelling kernel/args.mjs accepts for an empty value (a bare `--model`
  // with nothing after it throws). Empty, absent and placeholder share one remedy, so one row.
  const argv = ['--backend', 'deepseek', '--model=', '--commit', 'HEAD', '--question-file', QUESTION];
  const r = await consultCore(argv, { fetch: fetchFake(), env: TOKEN_ENV, cwd: TMP });
  assert.equal(r.envelope.unavailable, 'misconfigured');
  assert.match(r.envelope.reason, /consult_model \(--model\) is not configured/);
});

for (const model of ['claude-opus-4-6', 'Claude-Sonnet-4-5', 'us.anthropic.claude-3-7-sonnet-20250219-v1:0']) {
  test(`the independence guard refuses '${model}' — enforcement, not instruction`, async () => {
    const e = await misconfigured({ '--model': model });
    assert.match(e.reason, /is a Claude model/);
    assert.ok(e.reason.includes(model), 'the operator must be told which value tripped it');
  });
}

test("backend 'api' without --base-url is misconfigured — there is no row to fall back on", async () => {
  const e = await misconfigured({ '--backend': 'api', '--token-env': 'DEEPSEEK_API_KEY' });
  assert.equal(e.backend, 'api');
  assert.match(e.reason, /consult_base_url \(--base-url\) is not configured/);
});

test("backend 'api' without --token-env is misconfigured", async () => {
  const e = await misconfigured({ '--backend': 'api', '--base-url': 'https://proxy.invalid/v1' });
  assert.match(e.reason, /consult_token_env \(--token-env\) is not configured/);
});

test("backend 'api' with PLACEHOLDER base-url and token-env is the same as having neither", async () => {
  const e = await misconfigured({
    '--backend': 'api',
    '--base-url': '${user_config.consult_base_url}',
    '--token-env': '${user_config.consult_token_env}',
  });
  assert.match(e.reason, /consult_base_url \(--base-url\) is not configured/);
  assert.ok(!e.reason.includes('${user_config'));
});

test('an UNSET token env var is misconfigured, and the reason names the NAME only', async () => {
  const e = await misconfigured({}, { env: {} });
  assert.match(e.reason, /the environment variable DEEPSEEK_API_KEY is unset or empty/);
});

test('an EMPTY token env var is the same row — one remedy, one row', async () => {
  const e = await misconfigured({}, { env: { DEEPSEEK_API_KEY: '' } });
  assert.match(e.reason, /the environment variable DEEPSEEK_API_KEY is unset or empty/);
  assert.ok(!e.reason.includes(TOKEN));
});

test('the token env var NAME is what --token-env renames, and the refusal names the new one', async () => {
  const e = await misconfigured({ '--token-env': 'MY_PROXY_KEY' }, { env: TOKEN_ENV });
  assert.match(e.reason, /the environment variable MY_PROXY_KEY is unset or empty/,
    'an explicit --token-env overrides the provider row even when the row would have worked');
});

// --- the constants the rest of the system pins ----------------------------------------------

test('the exported constants are the ones the recipes and the loop were written against', () => {
  assert.equal(DIFF_CAP_BYTES, 204800, '200 KiB — the same number the gemini recipe enforces with exit 3');
  assert.equal(TIMEOUT_MS, 900_000, 'the bound curl carried as --max-time 900 and the CLI recipes as alarm 900');
  assert.match(USAGE, /^legion consult --backend /);
  assert.ok(PLACEHOLDER_RE.test('${user_config.consult_model}'));
  assert.ok(!PLACEHOLDER_RE.test('a-model-mentioning-${user_config.x}-mid-string'),
    'anchored: a real name that merely contains the text is not an unsubstituted placeholder');
});

test('the provider table resolves five named providers plus the bring-your-own row', () => {
  assert.deepEqual(Object.keys(PROVIDERS).sort(), ['api', 'deepseek', 'google', 'mistral', 'openai', 'xai']);
  assert.deepEqual(PROVIDERS.api, { baseUrl: null, tokenEnv: null },
    "the `api` row is null/null on purpose: it makes 'an explicit flag overrides its column' one rule with no special case");
  for (const [name, r] of Object.entries(PROVIDERS)) {
    if (name === 'api') continue;
    assert.match(r.baseUrl, /^https:\/\//, `${name}: a base URL, over TLS`);
    assert.match(r.tokenEnv, /^[A-Z][A-Z0-9_]*$/, `${name}: an env var NAME, never a token`);
  }
});

// --- the composed prompt: the contract `json_object` does NOT buy ---------------------------
// `response_format: {"type":"json_object"}` guarantees only that the bytes parse. WHICH keys come
// back is bought by this text and nothing else, which is why it is pinned by import rather than
// left to a regex over prose — and why the /json/i assertion below is a production invariant
// (measured: DeepSeek refuses json_object outright when the word is absent) and not a style rule.

const DIFF_SAMPLE = 'diff --git a/x.txt b/x.txt\n+++ b/x.txt\n@@ -0,0 +1 @@\n+hello\n';

test('the composed prompt is preamble, question, schema, diff — in that order', () => {
  const q = 'MARKER-QUESTION: is the retry loop bounded?';
  const p = composePrompt(q, DIFF_SAMPLE);
  const iPre = p.indexOf('You are reviewing a unified diff as an independent second-opinion code reviewer.');
  const iQ = p.indexOf('MARKER-QUESTION');
  const iSchema = p.indexOf('Respond with EXACTLY ONE JSON object');
  const iDiff = p.indexOf(DIFF_SAMPLE);
  assert.equal(iPre, 0, 'the preamble opens the message — the model learns what it is before what it reads');
  assert.ok(iPre < iQ && iQ < iSchema && iSchema < iDiff, `order was ${[iPre, iQ, iSchema, iDiff]}`);
  assert.ok(p.endsWith(DIFF_SAMPLE), 'the diff goes last: 200 KiB of patch must not push the instructions out of attention');
});

test('the composed prompt contains the word "json" — the measured DeepSeek/OpenAI/Mistral precondition', () => {
  // Not decoration: json_object is REFUSED with HTTP 400 when the prompt lacks the word. A
  // rewording that dropped it would break every API backend at once, at runtime, in production.
  assert.match(composePrompt('anything', ''), /json/i);
});

test('the composed prompt carries the codex schema, the priority legend and the empty-review licence', () => {
  const p = composePrompt('q', DIFF_SAMPLE);
  // The same four keys the codex CLI emits, so the agent's ONE translation table serves all three
  // recipes: a differently-shaped answer here would need a second table nobody would write.
  for (const key of ['findings', 'title', 'body', 'priority', 'code_location', 'absolute_file_path',
    'line_range', 'overall_correctness', 'overall_explanation']) {
    assert.ok(p.includes(key), `the schema block must name ${key}`);
  }
  assert.match(p, /0 = blocking defect, 1 = must fix before merge, 2 = should fix, 3 = informational/,
    'the priority polarity is the translation table\'s input — an unstated legend is an inverted tier');
  assert.match(p, /An empty findings array with "patch is correct" is a legitimate answer/,
    'without this licence a model invents a finding rather than return none');
});

// --- §5.7 diff derivation and the 200 KiB cap ------------------------------------------------

const sh = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

let repoN = 0;
/** A throwaway repo with two commits: `base` (a.txt) and HEAD (b.txt). `bytes` sizes b.txt, which
 * is how the over-cap case is built — a real commit whose real `git show` is over 200 KiB, rather
 * than a faked measurement of a diff that never existed. */
function repoWith(bytes) {
  const dir = join(TMP, `repo${repoN++}`);
  mkdirSync(dir, { recursive: true });
  sh(dir, 'init', '-b', 'main');
  writeFileSync(join(dir, 'a.txt'), 'first\n');
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-m', 'base');
  const baseSha = sh(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'b.txt'), `${'MARKER-DIFF-LINE\n'.repeat(Math.ceil(bytes / 17))}`);
  sh(dir, 'add', '-A');
  sh(dir, 'commit', '-m', 'change');
  return { dir, baseSha, headSha: sh(dir, 'rev-parse', 'HEAD') };
}

test('an over-cap --commit is refused WHOLE, naming the byte count, and spends no request', async () => {
  const r = repoWith(300 * 1024);
  const f = fetchFake();
  const out = await call({ '--commit': r.headSha }, { fetch: f, cwd: r.dir });
  assert.equal(out.code, 0, 'a refusal is still a complete answer');
  assert.equal(out.envelope.available, false);
  assert.equal(out.envelope.unavailable, 'other', 'no config is broken and no provider failed — this is the residual row');
  assert.match(out.envelope.reason, new RegExp(`the diff is (\\d+) bytes, over the ${DIFF_CAP_BYTES}-byte cap`));
  const measured = Number(out.envelope.reason.match(/is (\d+) bytes/)[1]);
  assert.ok(measured > DIFF_CAP_BYTES, `the count must be the REAL size, got ${measured}`);
  assert.match(out.envelope.reason, /Never truncated/, 'the refusal states why it is not a truncation');
  assert.equal(f.calls.length, 0, 'the cap is worthless if the bytes were already sent when it fired');
});

test('an over-cap --base range is refused identically — the cap is on the scope, not on the flag', async () => {
  const r = repoWith(300 * 1024);
  const f = fetchFake();
  const out = await call({ '--commit': null, '--base': r.baseSha }, { fetch: f, cwd: r.dir });
  assert.equal(out.envelope.unavailable, 'other');
  assert.match(out.envelope.reason, /over the 204800-byte cap/);
  assert.equal(f.calls.length, 0);
});

test('a --commit that does not resolve is a USAGE error — a fact about the call, not about the lens', async () => {
  const r = repoWith(64);
  const f = fetchFake();
  await assert.rejects(() => call({ '--commit': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, { fetch: f, cwd: r.dir }),
    /could not derive the diff for --commit deadbeef.*must name something that resolves in this worktree/s);
  assert.equal(f.calls.length, 0);
});

test('a cwd that is not a git repository at all is the same usage error', async () => {
  const notARepo = join(TMP, `bare${repoN++}`);
  mkdirSync(notARepo, { recursive: true });
  await assert.rejects(() => call({}, { cwd: notARepo }), /could not derive the diff for --commit HEAD/);
});

// --- §5.3 the provider table ------------------------------------------------------------------
// Losing a row silently turns a named backend into a misconfiguration for an operator who spelled
// it exactly as the plugin manifest told them to. Asserted off the RECORDED REQUEST, so what is
// pinned is where the bytes went, not what a constant says.

/** A 200 carrying `content` as an OpenAI-shaped chat completion. */
const okBody = (content) => JSON.stringify({
  id: 'chatcmpl-legion-test',
  object: 'chat.completion',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

const REVIEW = {
  findings: [{
    title: '[P1] the retry loop is unbounded',
    body: 'src/x.mjs:12 retries forever when the socket resets; cite file and line from the diff',
    priority: 1,
    code_location: { absolute_file_path: '/repo/src/x.mjs', line_range: { start: 12, end: 14 } },
  }],
  overall_correctness: 'patch is incorrect',
  overall_explanation: 'the patch adds a retry with no bound',
};

for (const [name, row] of Object.entries(PROVIDERS)) {
  if (name === 'api') continue;
  test(`backend '${name}' posts to its documented endpoint with its documented token env var`, async () => {
    const r = repoWith(64);
    const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
    const out = await call({ '--backend': name, '--commit': r.headSha },
      { fetch: f, cwd: r.dir, env: { [row.tokenEnv]: TOKEN } });
    assert.equal(out.envelope.available, true, out.envelope.reason);
    assert.equal(f.calls[0].url, `${row.baseUrl}/chat/completions`);
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(out.envelope.backend, name, 'a named provider stays named — it never reports as the `api` recipe it rode');
    assert.equal(out.envelope.tokenEnv, row.tokenEnv);
  });
}

test('an explicit --base-url overrides its column and leaves the token column alone', async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  const out = await call({ '--base-url': 'https://proxy.internal.invalid/openai/v1', '--commit': r.headSha },
    { fetch: f, cwd: r.dir });
  assert.equal(f.calls[0].url, 'https://proxy.internal.invalid/openai/v1/chat/completions',
    'that is how a named provider reaches a proxy');
  assert.equal(out.envelope.tokenEnv, PROVIDERS.deepseek.tokenEnv, 'the other column is untouched');
});

test('an explicit --token-env overrides its column and leaves the URL alone', async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  const out = await call({ '--token-env': 'WORK_DEEPSEEK_KEY', '--commit': r.headSha },
    { fetch: f, cwd: r.dir, env: { WORK_DEEPSEEK_KEY: TOKEN, DEEPSEEK_API_KEY: 'the-wrong-one' } });
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`, 'the renamed key is the one that is read');
  assert.equal(f.calls[0].url, `${PROVIDERS.deepseek.baseUrl}/chat/completions`);
  assert.equal(out.envelope.tokenEnv, 'WORK_DEEPSEEK_KEY');
});

test("backend 'api' resolves entirely from the two explicit flags", async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  const out = await call({
    '--backend': 'api', '--base-url': 'https://llm.corp.invalid/v1', '--token-env': 'CORP_LLM_TOKEN',
    '--commit': r.headSha,
  }, { fetch: f, cwd: r.dir, env: { CORP_LLM_TOKEN: TOKEN } });
  assert.equal(out.envelope.available, true, out.envelope.reason);
  assert.equal(f.calls[0].url, 'https://llm.corp.invalid/v1/chat/completions');
  assert.equal(out.envelope.backend, 'api');
});

test('a trailing slash on the base URL does not produce a doubled path separator', async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  await call({ '--base-url': 'https://proxy.internal.invalid/v1/', '--commit': r.headSha }, { fetch: f, cwd: r.dir });
  assert.equal(f.calls[0].url, 'https://proxy.internal.invalid/v1/chat/completions');
});

test('a placeholder --base-url on a NAMED provider falls back to the table, it does not refuse', async () => {
  // The override rule reads "a non-empty value overrides its column". A placeholder is not a
  // value, so `deepseek` keeps its own endpoint instead of being broken by config the operator
  // never set — which is the whole reason the placeholder rule exists.
  const r = repoWith(64);
  const f = fetchFake(() => reply(429, '{"error":{"message":"rate limited"}}'));
  const out = await call({ '--base-url': '${user_config.consult_base_url}', '--commit': r.headSha },
    { fetch: f, cwd: r.dir });
  assert.equal(out.envelope.unavailable, 'quota', 'it reached the provider, so the URL resolved off the table');
  assert.equal(f.calls[0].url, `${PROVIDERS.deepseek.baseUrl}/chat/completions`);
});

// --- §5.4 the happy path, and the exact bytes of the request ---------------------------------

test('a 200 with an OpenAI-shaped body yields available:true and the review in the codex schema', async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  const out = await call({ '--commit': r.headSha }, { fetch: f, cwd: r.dir });

  assert.equal(out.code, 0);
  assert.deepEqual(out.envelope, {
    available: true,
    backend: 'deepseek',
    model: 'deepseek-v4-flash',
    baseUrl: PROVIDERS.deepseek.baseUrl,
    tokenEnv: 'DEEPSEEK_API_KEY',
    httpStatus: 200,
    review: REVIEW,
  }, 'the envelope is exactly these seven fields — `review` verbatim, so ONE translation table serves all three recipes');
  assert.equal(out.output, `${JSON.stringify(out.envelope)}\n`, 'stdout is exactly one JSON object and a newline');
});

test('the request body is model + one user message + json_object, and NOTHING else', async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  await call({ '--commit': r.headSha }, { fetch: f, cwd: r.dir });
  const { init, body } = f.calls[0];

  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'application/json');
  assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(Object.keys(body).sort(), ['messages', 'model', 'response_format'],
    'no temperature and no max_tokens: several providers reject them, and a low max_tokens on a '
    + 'reasoning model was MEASURED to return HTTP 200 with empty content — a review that never happened');
  assert.equal(body.model, 'deepseek-v4-flash');
  assert.deepEqual(body.response_format, { type: 'json_object' },
    'OPTION A: json_object for every API backend, no capability column, no fallback');
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0].role, 'user');
});

test('the one user message is preamble + question + schema + diff, and contains the word json', async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  await call({ '--commit': r.headSha }, { fetch: f, cwd: r.dir });
  const content = f.calls[0].body.messages[0].content;

  assert.match(content, /json/i, 'the measured DeepSeek/OpenAI/Mistral precondition for json_object');
  assert.match(content, /^You are reviewing a unified diff as an independent second-opinion code reviewer\./);
  assert.match(content, /Does this task commit do what its brief says/, "the dispatch's own question");
  assert.match(content, /Respond with EXACTLY ONE JSON object/);
  assert.match(content, /MARKER-DIFF-LINE/, 'and the diff itself');
  assert.ok(content.indexOf('Respond with EXACTLY ONE JSON') < content.indexOf('MARKER-DIFF-LINE'),
    'the diff goes last');
});

test('--commit sends `git show` bytes and --base sends the range diff', async () => {
  const r = repoWith(64);
  const fCommit = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  await call({ '--commit': r.headSha }, { fetch: fCommit, cwd: r.dir });
  const shown = fCommit.calls[0].body.messages[0].content;
  assert.match(shown, new RegExp(`commit ${r.headSha}`), '`git show` carries the commit header');
  assert.match(shown, /diff --git a\/b\.txt b\/b\.txt/, 'and the pinned a\\//b\\/ prefixes the citation depends on');

  const fBase = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  await call({ '--commit': null, '--base': r.baseSha }, { fetch: fBase, cwd: r.dir });
  const ranged = fBase.calls[0].body.messages[0].content;
  assert.doesNotMatch(ranged, /^commit [0-9a-f]{40}$/m, 'a range diff carries no commit header');
  assert.match(ranged, /diff --git a\/b\.txt b\/b\.txt/, 'but the same patch');
});

test('a diff UNDER the cap is not refused — the guard fires on size, not on existence', async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  const out = await call({ '--commit': r.headSha }, { fetch: f, cwd: r.dir });
  assert.equal(out.envelope.available, true, 'the cap let it through');
});

// --- §5.5 the classification table -------------------------------------------------------------
// The build loop LATCHES the lens off on a durable cause and re-dispatches on a transient one, so
// every row here is the difference between one wasted dispatch and a whole run of them (or, the
// other way, between a lost second opinion and a network blip nobody noticed).

/** The two MEASURED DeepSeek 400s, verbatim in the part that was measured: the `message`. Both
 * are the reason `json_schema` left this codebase and the reason the schema block opens with the
 * word "JSON" — kept as fixtures so a rewrite that reintroduces either failure has a test that
 * describes exactly what the provider said. */
const DEEPSEEK_400_RESPONSE_FORMAT = `{"error":{"message":"This response_format type is unavailable now","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}`;
const DEEPSEEK_400_NO_JSON_WORD = `{"error":{"message":"Prompt must contain the word 'json' in some form to use 'response_format' of type 'json_object'.","type":"invalid_request_error","param":null,"code":"invalid_request_error"}}`;

/** Reach the transport with a real under-cap diff and hand it `outcome` (a Response-alike, or a
 * thrown error for a rejection). Returns the envelope. */
async function outcome(responder) {
  const r = repoWith(64);
  const f = fetchFake(responder);
  const out = await call({ '--commit': r.headSha }, { fetch: f, cwd: r.dir });
  assert.equal(out.code, 0, 'every classified absence is still a zero exit');
  assert.ok(UNAVAILABLE_CAUSES.includes(out.envelope.unavailable) || out.envelope.available === true);
  return out.envelope;
}

test('the measured DeepSeek json_schema 400 classifies as `other` and quotes what it said', async () => {
  const e = await outcome(() => reply(400, DEEPSEEK_400_RESPONSE_FORMAT));
  assert.equal(e.available, false);
  assert.equal(e.unavailable, 'other', 'a 400 is not auth, not quota and not a connection failure');
  assert.match(e.reason, /^HTTP 400: /);
  assert.match(e.reason, /This response_format type is unavailable now/);
});

test('the measured DeepSeek missing-"json"-word 400 classifies as `other` and quotes what it said', async () => {
  const e = await outcome(() => reply(400, DEEPSEEK_400_NO_JSON_WORD));
  assert.equal(e.unavailable, 'other');
  assert.match(e.reason, /Prompt must contain the word 'json' in some form/);
});

for (const status of [401, 403]) {
  test(`HTTP ${status} is not-authenticated — a durable cause the loop latches on`, async () => {
    const e = await outcome(() => reply(status, '{"error":{"message":"Invalid API key"}}'));
    assert.equal(e.unavailable, 'not-authenticated');
    assert.match(e.reason, new RegExp(`^HTTP ${status}: `));
  });
}

test('HTTP 429 is quota, not a network problem and not a retryable unknown', async () => {
  const e = await outcome(() => reply(429, '{"error":{"message":"Rate limit reached, retry after 2026-08-21"}}'));
  assert.equal(e.unavailable, 'quota');
  assert.match(e.reason, /retry after/);
});

test('HTTP 500 and any other non-200 fall to `other` — transient by the latch\'s reading', async () => {
  const e = await outcome(() => reply(500, '<html><body>Bad Gateway</body></html>'));
  assert.equal(e.unavailable, 'other');
  assert.match(e.reason, /^HTTP 500: /);
});

test('a 202 is NOT a success — only 200 carries a completion', async () => {
  const e = await outcome(() => reply(202, okBody(JSON.stringify(REVIEW))));
  assert.equal(e.unavailable, 'other', 'a body that looks right under a status that is not 200 is still not an answer');
});

/** node's fetch rejects with a TypeError whose `cause` carries the real code — the shape the
 * classifier reads, reproduced here rather than described. */
const rejectWith = (code) => () => {
  const cause = new Error(`${code} reproduction`);
  cause.code = code;
  throw Object.assign(new TypeError('fetch failed'), { cause });
};

for (const code of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH',
  'ENETUNREACH', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
  test(`a rejection whose cause.code is ${code} classifies as network`, async () => {
    const e = await outcome(rejectWith(code));
    assert.equal(e.unavailable, 'network',
      'the message is always "fetch failed" — cause.code is the only place the distinction survives');
    assert.match(e.reason, new RegExp(`^${code} reaching https://`));
  });
}

test('a rejection with no recognisable cause is `other`, never guessed into `network`', async () => {
  const e = await outcome(() => { throw new TypeError('fetch failed'); });
  assert.equal(e.unavailable, 'other');
});

test('a TimeoutError rejection is `timeout` — curl exit 28, one for one', async () => {
  const e = await outcome(() => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); });
  assert.equal(e.unavailable, 'timeout');
  assert.match(e.reason, /aborted at the bound/);
});

test('an AbortError rejection is the same row', async () => {
  const e = await outcome(() => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); });
  assert.equal(e.unavailable, 'timeout');
});

// --- §5.8 content robustness -------------------------------------------------------------------
// `json_object` guarantees the bytes parse. It guarantees nothing about WHICH keys come back, and
// a model that answers with prose, or with a plausible object that is not a review, must never be
// read as "no findings" — that is the silent false pass the lens exists to prevent.

test('a fenced ```json block is accepted — a review that was returned is not thrown away over a fence', async () => {
  const e = await outcome(() => reply(200, okBody(`\`\`\`json\n${JSON.stringify(REVIEW)}\n\`\`\``)));
  assert.equal(e.available, true, e.reason);
  assert.deepEqual(e.review, REVIEW);
});

test('a bare ``` fence with no language tag is accepted too', async () => {
  const e = await outcome(() => reply(200, okBody(`\`\`\`\n${JSON.stringify(REVIEW)}\n\`\`\``)));
  assert.equal(e.available, true, e.reason);
});

test('prose instead of JSON is `other` with an excerpt of what came back', async () => {
  const e = await outcome(() => reply(200, okBody('Sure! Overall the patch looks correct to me.')));
  assert.equal(e.unavailable, 'other');
  assert.match(e.reason, /not one JSON object.*Sure! Overall the patch looks correct/s);
});

test('EMPTY content on a 200 is `other`, never an empty pass', async () => {
  // MEASURED: this is what a truncated reasoning run returns. Reading it as "no findings" would
  // certify a review that never happened.
  const e = await outcome(() => reply(200, okBody('   ')));
  assert.equal(e.unavailable, 'other');
  assert.match(e.reason, /no usable choices\[0\]\.message\.content/);
});

test('a 200 with no choices at all is `other`', async () => {
  const e = await outcome(() => reply(200, '{"id":"x","choices":[]}'));
  assert.equal(e.unavailable, 'other');
  assert.match(e.reason, /no usable choices\[0\]\.message\.content/);
});

test('a 200 whose body is not JSON at all is `other`', async () => {
  const e = await outcome(() => reply(200, '<html>upstream proxy error</html>'));
  assert.equal(e.unavailable, 'other');
  assert.match(e.reason, /body that is not JSON/);
});

for (const [what, value] of [
  ['findings is not an array', { findings: {}, overall_correctness: 'patch is correct' }],
  ['overall_correctness is not a string', { findings: [], overall_correctness: true }],
  ['findings[0].title is not a string', { findings: [{ title: 7, body: 'x' }], overall_correctness: 'patch is correct' }],
  ['findings[0].body is not a string', { findings: [{ title: 'x' }], overall_correctness: 'patch is correct' }],
  ['findings[0] is not an object', { findings: ['just a string'], overall_correctness: 'patch is correct' }],
  ['not a JSON object', [1, 2, 3]],
]) {
  test(`a well-formed JSON answer that is not a review is \`other\` (${what})`, async () => {
    const e = await outcome(() => reply(200, okBody(JSON.stringify(value))));
    assert.equal(e.unavailable, 'other');
    assert.match(e.reason, /is not a review/);
    assert.ok(e.reason.includes(what), `the violation must be named, got: ${e.reason}`);
  });
}

test('an EMPTY findings array with "patch is correct" is a legitimate, available answer', async () => {
  const clean = { findings: [], overall_correctness: 'patch is correct', overall_explanation: 'nothing to raise' };
  const e = await outcome(() => reply(200, okBody(JSON.stringify(clean))));
  assert.equal(e.available, true, e.reason);
  assert.deepEqual(e.review, clean);
});

// --- the loopback cases: where an injected function cannot answer the question ----------------
// Three properties are about the REAL transport, not about the classifier: that node's own abort
// at the bound arrives shaped the way the `timeout` row expects, that a real response body
// carrying the token comes back scrubbed, and (§5.10) that the whole thing works as a child
// process through the router. 127.0.0.1:0 only — this is a socket, never a network.

/** Start `handler` on a free loopback port; returns {base, close}. */
async function loopback(handler) {
  const server = createServer(handler);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  return {
    base: `http://127.0.0.1:${server.address().port}/v1`,
    close: () => new Promise((res) => { server.closeAllConnections?.(); server.close(() => res()); }),
  };
}

test('a server that never answers hits the bound and classifies as timeout — the real abort, not a faked one', async () => {
  const r = repoWith(64);
  const srv = await loopback(() => { /* deliberately never responds */ });
  try {
    const out = await call(
      { '--backend': 'api', '--base-url': srv.base, '--token-env': 'DEEPSEEK_API_KEY', '--commit': r.headSha },
      { fetch: globalThis.fetch, cwd: r.dir, timeoutMs: 100 },
    );
    assert.equal(out.code, 0);
    assert.equal(out.envelope.unavailable, 'timeout',
      'AbortSignal.timeout rejects with a DOMException named TimeoutError — the shape the row reads');
    assert.match(out.envelope.reason, /no answer within 100 ms/);
  } finally { await srv.close(); }
});

// --- §5.6 token hygiene, proved against a server that echoes the key back ---------------------

test('a provider that echoes the token in its 401 body cannot smuggle it into the envelope', async () => {
  // Providers really do this. The scrubber is what makes the claim "the token never enters a
  // model context" a property of the code rather than a rule the code is asked to follow.
  const r = repoWith(64);
  const srv = await loopback((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization}. You can find your API key at …` } }));
  });
  try {
    const out = await call(
      { '--backend': 'api', '--base-url': srv.base, '--token-env': 'DEEPSEEK_API_KEY', '--commit': r.headSha },
      { fetch: globalThis.fetch, cwd: r.dir },
    );
    assert.equal(out.envelope.unavailable, 'not-authenticated', 'it is still classified correctly');
    assert.match(out.envelope.reason, /Incorrect API key provided/, 'and the provider is still quoted');
    assert.ok(!out.output.includes(TOKEN), 'the ENTIRE stdout carries zero occurrences of the token bytes');
    assert.ok(!JSON.stringify(out.envelope).includes(TOKEN), 'and so does the returned envelope');
    assert.match(out.envelope.reason, /\[redacted\]/, 'deleted outright — not masked to a prefix, which is still key material');
  } finally { await srv.close(); }
});

test('a success envelope carries the token env var NAME and no value anywhere', async () => {
  const r = repoWith(64);
  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  const out = await call({ '--commit': r.headSha }, { fetch: f, cwd: r.dir });
  assert.equal(out.envelope.tokenEnv, 'DEEPSEEK_API_KEY');
  assert.ok(!out.output.includes(TOKEN));
  assert.ok(!Object.values(out.envelope).some((v) => String(v).includes(TOKEN)));
});

test('a token that only survives JSON escaping is scrubbed too', async () => {
  // A token carrying a quote or a backslash is escaped by JSON.stringify before the scrubber sees
  // the text, so matching the raw spelling alone would let it through. Contrived on purpose: the
  // point is that the property holds for the CLASS, not for well-behaved keys.
  const hostile = 'sk-"quote\\slash-3f9a2c17';
  const r = repoWith(64);
  const srv = await loopback((req, res) => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end(`rejected key ${req.headers.authorization}`);
  });
  try {
    const out = await call(
      { '--backend': 'api', '--base-url': srv.base, '--token-env': 'HOSTILE_KEY', '--commit': r.headSha },
      { fetch: globalThis.fetch, cwd: r.dir, env: { HOSTILE_KEY: hostile } },
    );
    assert.equal(out.envelope.unavailable, 'not-authenticated');
    assert.ok(!out.output.includes(hostile), 'raw spelling absent');
    assert.ok(!out.output.includes(JSON.stringify(hostile).slice(1, -1)), 'JSON-escaped spelling absent too');
  } finally { await srv.close(); }
});

// --- §5.9 the read-only claim, tested rather than asserted in prose --------------------------

/** Every file under `dir` as rel → {size, mtimeMs, bytes} — doctor's measurement, unchanged. */
function snapshot(dir) {
  const out = {};
  for (const p of readdirSync(dir, { recursive: true })) {
    const abs = join(dir, String(p));
    let st;
    try { st = statSync(abs); } catch { continue; }
    if (!st.isFile()) continue;
    out[relative(dir, abs)] = { size: st.size, mtimeMs: st.mtimeMs, bytes: readFileSync(abs, 'base64') };
  }
  return out;
}

test('consult writes NOTHING — the worktree and a legion home are byte-identical after a full run', async () => {
  const r = repoWith(64);
  const home = join(TMP, `home${repoN++}`);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'sentinel.json'), '{"nothing":"may touch this"}\n');
  const beforeRepo = snapshot(r.dir);
  const beforeHome = snapshot(home);
  assert.ok(Object.keys(beforeRepo).length > 0, 'the snapshot must actually see files');

  const f = fetchFake(() => reply(200, okBody(JSON.stringify(REVIEW))));
  const out = await call({ '--commit': r.headSha }, { fetch: f, cwd: r.dir });
  assert.equal(out.envelope.available, true, out.envelope.reason);

  assert.deepEqual(snapshot(r.dir), beforeRepo, 'the verb resolves no dossier, takes no lock and mints no evidence');
  assert.deepEqual(snapshot(home), beforeHome);
});

// --- §5.10 the real bin: router wiring, the stdout contract, the exit codes -------------------
// Everything above drives consultCore in-process. What that cannot see is the half the agent
// actually depends on: that bin/legion.mjs finds the verb at all (registration is drop-in — the
// router readdirs src/cli/ and there is no list to forget), that an envelope goes to STDOUT while
// a usage error goes to STDERR, and that the exit code is what the agent's `echo "EXIT:$?"` will
// read. A child process is the only thing that proves those.
//
// spawn, NOT spawnSync: the loopback server lives in THIS process, and spawnSync blocks this
// process's event loop — the child's connection would never be accepted and the case would hang
// until the bound fired. The property being tested is unaffected; the plumbing is not.

function runBin(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE, [BIN, ...args], { cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const childEnv = (extra = {}) => ({ ...process.env, DEEPSEEK_API_KEY: TOKEN, ...extra });

test('the router finds `consult` without being told — creating the file IS the registration', async () => {
  const r = await runBin([], { cwd: ROOT, env: process.env });
  assert.equal(r.code, 1, 'a missing command exits 1, never 0');
  assert.match(r.stderr, /^\s*legion consult$/m, 'and the usage list advertises the new verb');
});

test('a real run through bin/legion.mjs: one JSON object on stdout, exit 0, nothing on stderr', async () => {
  const r = repoWith(64);
  let seen = null;
  const srv = await loopback((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen = { auth: req.headers.authorization, url: req.url, body: JSON.parse(body) };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okBody(JSON.stringify(REVIEW)));
    });
  });
  try {
    const out = await runBin([
      'consult', '--backend', 'api', '--model', 'an-independent-model',
      '--base-url', srv.base, '--token-env', 'DEEPSEEK_API_KEY',
      '--commit', r.headSha, '--question-file', QUESTION,
    ], { cwd: r.dir, env: childEnv() });

    assert.equal(out.code, 0, `stderr was: ${out.stderr}`);
    assert.equal(out.stderr, '', 'stdout is the contract; stderr must stay empty on an answered call');
    assert.equal(out.stdout.split('\n').filter((l) => l !== '').length, 1, 'EXACTLY one JSON object');
    const envelope = JSON.parse(out.stdout);
    assert.equal(envelope.available, true);
    assert.deepEqual(envelope.review, REVIEW);
    // The token reached the socket from the CHILD's environment — the path the operator's shell
    // actually provides — and appears nowhere in what the agent gets back.
    assert.equal(seen.auth, `Bearer ${TOKEN}`);
    assert.equal(seen.url, '/v1/chat/completions');
    assert.deepEqual(seen.body.response_format, { type: 'json_object' });
    assert.ok(!out.stdout.includes(TOKEN));
  } finally { await srv.close(); }
});

test('an available:false answer still exits 0 through the router — a missing lens is not a failed command', async () => {
  const r = repoWith(64);
  const srv = await loopback((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end('{"error":{"message":"Rate limit reached"}}');
  });
  try {
    const out = await runBin([
      'consult', '--backend', 'api', '--model', 'an-independent-model',
      '--base-url', srv.base, '--token-env', 'DEEPSEEK_API_KEY',
      '--commit', r.headSha, '--question-file', QUESTION,
    ], { cwd: r.dir, env: childEnv() });
    assert.equal(out.code, 0, 'a zero exit is what stops the haiku caller "repairing" a valid answer');
    const envelope = JSON.parse(out.stdout);
    assert.equal(envelope.available, false);
    assert.equal(envelope.unavailable, 'quota');
    assert.equal(envelope.backend, 'api');
  } finally { await srv.close(); }
});

test('a misconfigured run needs no server at all, and still exits 0 with an envelope', async () => {
  const r = repoWith(64);
  const out = await runBin([
    'consult', '--backend', 'deepseek', '--model', 'deepseek-v4-flash',
    '--commit', r.headSha, '--question-file', QUESTION,
  ], { cwd: r.dir, env: childEnv({ DEEPSEEK_API_KEY: '' }) });
  assert.equal(out.code, 0);
  const envelope = JSON.parse(out.stdout);
  assert.equal(envelope.unavailable, 'misconfigured');
  assert.match(envelope.reason, /DEEPSEEK_API_KEY is unset or empty/);
});

test('a usage error exits 1 with a `legion consult:` line on STDERR and an EMPTY stdout', async () => {
  const r = repoWith(64);
  const out = await runBin([
    'consult', '--backend', 'codex', '--model', 'gpt-5',
    '--commit', r.headSha, '--question-file', QUESTION,
  ], { cwd: r.dir, env: childEnv() });
  assert.equal(out.code, 1);
  assert.equal(out.stdout, '', 'an envelope must never be emitted for a call that was not a review request');
  assert.match(out.stderr, /^legion consult: /, 'the router formats it — the agent relays that line as the reason');
  assert.match(out.stderr, /CLI recipes in agents\/consult\.md \(3a\/3b\/3d\)/);
});

test('an unsubstituted placeholder survives the shell and is read as unset, not sent onward', async () => {
  // The prompt tells the agent to pass all four values single-quoted and verbatim, placeholders
  // included. This is that exact argv, arriving the way bash would deliver it.
  const r = repoWith(64);
  const out = await runBin([
    'consult', '--backend', 'deepseek', '--model', '${user_config.consult_model}',
    '--base-url', '${user_config.consult_base_url}', '--token-env', '${user_config.consult_token_env}',
    '--commit', r.headSha, '--question-file', QUESTION,
  ], { cwd: r.dir, env: childEnv() });
  assert.equal(out.code, 0);
  const envelope = JSON.parse(out.stdout);
  assert.equal(envelope.unavailable, 'misconfigured');
  assert.match(envelope.reason, /consult_model \(--model\) is not configured/);
  assert.ok(!out.stdout.includes('${user_config'), 'the placeholder is never echoed onward');
});

// --- §5.11 cross-pins: the verb, the loop's schema, and the prompt cannot drift apart --------

test('every `unavailable` the verb can emit is in the loop\'s REVIEW_SCHEMA enum', () => {
  // An `unavailable` value missing from that enum is DROPPED by the runtime and arrives at the
  // latch as nothing — which reads exactly like a lens that never classified its absence, i.e.
  // like a transient failure worth re-dispatching. A cause invented here without the enum knowing
  // it is therefore not a new row, it is a silently deleted one.
  const loop = readFileSync(join(ROOT, 'workflows', 'build-loop.js'), 'utf8');
  const m = /unavailable: \{[^}]*enum: \[([^\]]+)\]/.exec(loop);
  assert.ok(m, 'the unavailable enum must still be findable in workflows/build-loop.js');
  const enumValues = m[1].split(',').map((v) => v.trim().replace(/^'|'$/g, ''));
  for (const cause of UNAVAILABLE_CAUSES) {
    assert.ok(enumValues.includes(cause), `the loop's enum must carry '${cause}'`);
  }
  assert.ok(!UNAVAILABLE_CAUSES.includes('cli-missing'),
    'curl left the recipe, so this path has no binary to be missing — the row stays live for the CLI recipes only');
  assert.ok(enumValues.includes('cli-missing'), 'and it stays in the enum, because 3a and 3b still emit it');
});

test('agents/consult.md pins the invocation, and names every flag the verb reads', () => {
  // The prompt is the only caller. A flag the verb requires and the prompt never mentions is a
  // `misconfigured` envelope in production that no test here would ever produce, and a flag the
  // prompt passes that the verb does not read is an argument silently dropped.
  const md = readFileSync(join(ROOT, 'agents', 'consult.md'), 'utf8');
  assert.match(md, /legion consult --backend/, 'the pinned invocation');
  for (const flag of ['--backend', '--model', '--base-url', '--token-env', '--commit', '--base', '--question-file']) {
    assert.ok(md.includes(flag), `the 3c recipe must name ${flag}`);
    assert.ok(USAGE.includes(flag), `and the verb's usage line must offer ${flag}`);
  }
  assert.match(md, /verbatim and single-quoted/,
    'the four configured values go through UNTOUCHED — including an unsubstituted placeholder, which the verb reads as unset');
  assert.match(md, /EXIT 1/, 'and the prompt must know that exit 1 is a wrong invocation, never a lens verdict');
});

// --- the cap's other half, and the redaction that must not break its own envelope -------------
// Both of these are review findings from the first pass, and both are the same shape of bug: a
// guard whose text claims more than its code does. The empty-scope tests exercise a path the
// 94 tests above never reached (an inert guard passes every test that does not call it), and the
// structural-token test covers a class the hostile-token case at the top of this file CANNOT —
// its escaped spelling stays inside a JSON string, so it never touches the shape.

test('isEmptyScope reads the patch markers, not the byte count', () => {
  assert.equal(isEmptyScope(''), true, 'an empty range is the plainest spelling of nothing');
  assert.equal(isEmptyScope('   \n\n'), true, 'and whitespace is the same fact');
  // The measured case: `git show --cc` on a clean merge prints a header and NO patch. Non-empty
  // by any length test, and still nothing a reviewer could read.
  assert.equal(isEmptyScope([
    'commit 0f1e2d3c4b5a69788796a5b4c3d2e1f001234567',
    'Merge: 1111111 2222222',
    'Author: legion test <test@example.invalid>',
    'Date:   Thu Aug 20 09:15:00 2026 +0200',
    '',
    '    merge',
    '',
  ].join('\n')), true, 'a merge header with no patch body is an empty scope');
  assert.equal(isEmptyScope('diff --git a/f.txt b/f.txt\n@@ -1 +1 @@\n-a\n+b\n'), false);
  assert.equal(isEmptyScope('diff --cc f.txt\n@@@ -1,1 -1,1 +1,1 @@@\n- a\n +b\n'), false,
    'a combined diff IS a patch — refusing it would throw away a real merge review');
});

test('an EMPTY --base range is refused before the request, like an over-cap one', async () => {
  const r = repoWith(64);
  const f = fetchFake();
  const out = await call({ '--commit': null, '--base': 'HEAD' }, { fetch: f, cwd: r.dir });
  assert.equal(out.code, 0, 'an absent review is still a complete answer');
  assert.equal(out.envelope.available, false);
  assert.equal(out.envelope.unavailable, 'other');
  assert.match(out.envelope.reason, /carries no patch to review/);
  assert.equal(f.calls.length, 0, 'nothing may be spent on a scope with nothing in it');
});

test('a MERGE commit whose combined diff is empty is refused too — the measured 138-byte case', async () => {
  const r = repoWith(64);
  // Two branches that touch different files: the merge is clean, so `git show --cc` prints its
  // header and stops. Built for real rather than asserted from a string, because the property
  // under test is what git actually emits for this shape of commit.
  sh(r.dir, 'checkout', '-q', '-b', 'side', r.baseSha);
  writeFileSync(join(r.dir, 'side.txt'), 'side\n');
  sh(r.dir, 'add', '-A');
  sh(r.dir, 'commit', '-m', 'side');
  sh(r.dir, 'checkout', '-q', 'main');
  sh(r.dir, 'merge', '--no-ff', '-m', 'merge side', 'side');
  const mergeSha = sh(r.dir, 'rev-parse', 'HEAD');
  const f = fetchFake();
  const out = await call({ '--commit': mergeSha }, { fetch: f, cwd: r.dir });
  assert.equal(out.envelope.unavailable, 'other', 'a header with no patch is not a passing review');
  assert.match(out.envelope.reason, /carries no patch to review/);
  assert.equal(f.calls.length, 0);
});

test('a token whose bytes are JSON STRUCTURE still yields an envelope, not a SyntaxError', async () => {
  // Scrubbing the SERIALISED envelope deleted whatever the token's bytes happened to be — and a
  // token is an arbitrary string. `","` cut the structure between two fields and JSON.parse threw
  // out of emit(), i.e. exit 1 and no envelope on a path whose contract is "an envelope, always".
  // Scrubbing the values before serialising is what makes the shape unreachable.
  const hostile = '","';
  const r = repoWith(64);
  const f = fetchFake(() => new Response(`upstream echoed the key: ${hostile}`, { status: 500 }));
  const out = await call({}, { fetch: f, cwd: r.dir, env: { DEEPSEEK_API_KEY: hostile } });
  assert.equal(out.code, 0, 'the envelope survives its own redaction');
  assert.equal(out.envelope.available, false);
  assert.equal(out.envelope.unavailable, 'other', 'a 500 is the residual row, as it would be for any token');
  assert.deepEqual(JSON.parse(out.output), out.envelope, 'stdout still parses, and to the same object');
  // Asserted on the VALUES, not on the raw output: these bytes are also legitimate JSON
  // punctuation, and every envelope contains them as structure. That indistinguishability is the
  // whole bug — which is why the scrub has to happen where the two can still be told apart.
  const strings = JSON.stringify(out.envelope).match(/"(?:[^"\\]|\\.)*"/g) ?? [];
  assert.ok(!strings.some((s) => JSON.parse(s).includes(hostile)),
    `the echoed key survived in a value: ${out.envelope.reason}`);
  assert.match(out.envelope.reason, /\[redacted\]/, 'and it was deleted rather than merely absent');
});
