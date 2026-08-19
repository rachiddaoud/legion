// review-receipt.mjs — SubagentStop hook, scoped to the REVIEWER agents. When a reviewer
// stops, this mints the review receipt `legion state review-record` will demand and consume:
// attendance evidence (harness-supplied agent_type + agent_id) plus, when extractable, the
// verdict the reviewer actually returned. IT RUNS EXACTLY ONE COMMAND:
// `legion gate review-receipt --agent-type <t> --agent-id <id> [--verdict pass|fail]`.
//
// VALIDATED AGAINST CLAUDE CODE 2.1.219 — same facts as builder-receipt.mjs's header:
// SubagentStop input is {stop_hook_active, agent_id, agent_type, agent_transcript_path,
// last_assistant_message?, …}, the matcher compares agent_type, and a plugin agent's
// agent_type is `legion:<name>`. The manifest matcher covers the namespaced and bare forms and
// this file RE-CHECKS agent_type itself (belt-and-braces, same reasoning as builder-receipt).
//
// VERDICT AND SUBJECT EXTRACTION, honest about its limits. Reviewer agents return
// REVIEW_SCHEMA-shaped structured output ({"verdict":"pass"|"fail", "subject":"task:T1", …};
// the plan-critic's vocabulary adds "revise", which maps to fail — a plan sent back is not a
// plan that passed). Both fields are read by regex from ONE source: last_assistant_message when
// it carries a verdict literal, the transcript tail otherwise — the choice is made ONCE, by the
// verdict, and the subject is never read from the source the verdict did not come from (a
// verdict paired with another message's subject is a receipt at a subject nobody reviewed).
// Within that source the LAST match wins, DELIBERATELY — a reviewer
// quotes findings and prior drafts mid-message, but its own conclusion is emitted last. That
// rule can be fooled by malformed output (unescaped prose QUOTING a verdict literal after the
// real conclusion — well-formed JSON output cannot false-match, its quotes are escaped), and
// no self-disagreement detection is attempted: distinguishing a quote from a conclusion is
// not a regex's job, and the failure mode is a refused record, never a silent pass.
// When a source yields nothing the receipt degrades: no verdict ⇒ ATTENDANCE-ONLY (proves the
// reviewer ran, not what it concluded — existence evidence only, the anti-fold rule has
// nothing to say); no subject ⇒ UNSCOPED (fungible across subjects at its tree, exactly what
// pre-scoping receipts were). And a consult — THAT ROLE AND NO OTHER — that reports
// `"available":false` is a MISSING LENS, not a verdict: the loop deliberately never records it,
// so minting its schema-forced 'fail' would strand an unconsumable fail receipt that blocks the
// honest pass after the backend comes back; that case mints attendance-only too. The same field from
// any other reviewer is off-contract output, never a licence to drop its verdict.
//
// FAIL-SAFE vs FAIL-CLOSED — one DELIBERATE ASYMMETRY with builder-receipt.mjs:
//   - the silences are identical (not a reviewer, a payload neither cwd nor session id resolves
//     to a feature — _common.mjs fact D — no tasks.json ⇒ exit 0);
//   - but NOTHING HERE EVER EXITS 2. A corrupt dossier, and even a kernel REFUSAL of the mint,
//     are LOUD on stderr and then release the reviewer (exit 0). Blocking a reviewer's stop
//     cannot mint anything and the reviewer has no remedial action a builder has (there is no
//     "commit and re-run the gate" for a review that is already finished). The fail-closed
//     layer is `legion state review-record` itself, which refuses without a receipt — this
//     hook is the ordinary supplier of that evidence, not the guarantee.
import { readHookInput, resolveFeature, runKernel } from './_common.mjs';
import { readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { REVIEW_RECEIPT_AGENT_ROLES } from '../src/kernel/state.mjs';

// Derived from the kernel's own role map — never a hand-copied list: a copy here drifts
// silently (this hook's failure mode is exit 0), and a reviewer missing from it would mint
// nothing while review-record tells the operator "the reviewer never ran".
const REVIEWER = new RegExp(`^(legion:)?(${Object.keys(REVIEW_RECEIPT_AGENT_ROLES).join('|')})$`);

/** Last REVIEW_SCHEMA-shaped verdict in `text`, mapped to the receipt vocabulary, or null.
 * Last match wins — the conclusion is emitted last (header). `revise` → fail. */
function verdictIn(text) {
  const m = [...String(text ?? '').matchAll(/"verdict"\s*:\s*"(pass|fail|revise)"/g)];
  if (m.length === 0) return null;
  const v = m[m.length - 1][1];
  return v === 'revise' ? 'fail' : v;
}

/** Last stated review subject in `text`, or null (⇒ the receipt stays unscoped). The shape is
 * the kernel's subject vocabulary; anything else is left for the kernel to refuse, not for
 * this hook to repair. */
function subjectIn(text) {
  const m = [...String(text ?? '').matchAll(/"subject"\s*:\s*"((?:task:|milestone:)[^"\\]+|feature|plan)"/g)];
  return m.length === 0 ? null : m[m.length - 1][1];
}

/** consult's missing-lens marker: the LAST `"available":<bool>` in `text` is false. */
function unavailableIn(text) {
  const m = [...String(text ?? '').matchAll(/"available"\s*:\s*(true|false)/g)];
  return m.length > 0 && m[m.length - 1][1] === 'false';
}

/** The tail of the reviewer's transcript, bounded so a huge session cannot make a stop hook
 * slow: the structured-output call is the agent's LAST act, so 64 KiB of tail is plenty. */
function transcriptTail(path, cap = 64 * 1024) {
  try {
    const size = statSync(path).size;
    if (size <= cap) return readFileSync(path, 'utf8');
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(cap);
      readSync(fd, buf, 0, cap, size - cap);
      return buf.toString('utf8');
    } finally { closeSync(fd); }
  } catch { return ''; }
}

const input = readHookInput();
if (!input) process.exit(0);
if (!REVIEWER.test(String(input.agent_type ?? ''))) process.exit(0); // fail-safe: not a reviewer

const resolved = resolveFeature(input);
if (!resolved) process.exit(0); // fail-safe: not a legion worktree
const { cwd, tasks, corrupt } = resolved;

// LOUD but RELEASING (header asymmetry): a broken manifest means no receipt can be minted, and
// the operator must hear that from the surface that refuses — review-record — with this stderr
// as the explanation of why the receipt is missing.
if (corrupt) {
  process.stderr.write(
    `legion: DOSSIER CORRUPT — ${corrupt.what} at ${corrupt.path} could not be read: ${corrupt.detail}\n` +
    `No review receipt was minted for this ${input.agent_type} run; \`legion state review-record\` ` +
    `will refuse until the manifest is repaired and the reviewer is re-dispatched.\n`,
  );
  process.exit(0);
}
if (!tasks) process.exit(0); // no tasks.json ⇒ nothing to receive a receipt yet

const tail = input.agent_transcript_path ? transcriptTail(input.agent_transcript_path) : '';
// ONE source, chosen once by the verdict, read for ALL THREE fields (header). Reading the
// subject from the other source would pair a verdict with a subject nobody reviewed: a message
// that merely QUOTES `"subject":"task:T1"` while the real conclusion
// {"verdict":"fail","subject":"milestone:M1"} sits in the tail would mint a fail receipt at
// task:T1 — which then anti-fold-blocks the honest task:T1 pass at that tree, while the
// milestone record is refused for want of evidence. A subject absent from the chosen source
// degrades to UNSCOPED, which is a receipt's documented weak form, not a wrong one.
const source = verdictIn(input.last_assistant_message) !== null ? input.last_assistant_message : tail;
// `available` belongs to the CONSULT LENS ALONE (REVIEW_SCHEMA says so), and so does the reason
// its false value voids the verdict: the loop never records an unavailable consult, so minting
// its schema-forced 'fail' strands an unconsumable fail receipt. No other reviewer has that
// escape — for them `available:false` is off-contract output, its `fail` is the honest half of
// it, and dropping the verdict would quietly retire the anti-fold rule for that run.
const consultLens = REVIEW_RECEIPT_AGENT_ROLES[String(input.agent_type).replace(/^legion:/, '')] === 'consult';
const verdict = consultLens && unavailableIn(source) ? null : verdictIn(source);
const subject = subjectIn(source);

const argv = [
  'gate', 'review-receipt',
  '--agent-type', String(input.agent_type),
  '--agent-id', String(input.agent_id ?? ''),
  ...(verdict ? ['--verdict', verdict] : []),
  ...(subject ? ['--subject', subject] : []),
];
const r = runKernel(argv, cwd);
if (r.code !== 0) {
  // A kernel command that RAN and REFUSED is never swallowed (_common.mjs header) — but per the
  // header asymmetry it does not block the stop either.
  process.stderr.write(
    `legion: review receipt mint refused for ${input.agent_type} (${(r.stderr || r.stdout).trim()})\n` +
    `\`legion state review-record\` will refuse for this run — re-dispatch the reviewer after fixing the cause.\n`,
  );
}
process.exit(0);
