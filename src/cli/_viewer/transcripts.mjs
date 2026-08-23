// transcripts.mjs — the model, the token counts and the agent reuse of one feature, read out of
// Claude Code's own transcripts. Nothing else on this machine records them.
//
// READ-ONLY, and injected rather than imported: this file opens files under ~/.claude and returns
// plain objects, while the projection that shapes the DTO never reaches it — the server hands it
// in, exactly as it hands in the git reads, so no projection test can walk the operator's home.
//
// A DISPATCH AND A COORDINATOR SESSION ARE TWO DIFFERENT THINGS, AND THEY ARE RETURNED SEPARATELY.
// A dispatch is `<projects>/<enc>/<sid>/subagents/**/agent-*.jsonl` — read RECURSIVELY, because
// the build loop's dispatches sit one level deeper and are 911 of this machine's 1550. Its role
// comes free and authoritative from the sibling `agent-*.meta.json`, which is how only legion's own
// dispatches are kept. The coordinator's transcript is the SIBLING `<enc>/<sid>.jsonl` — no
// agentId, no agentType, its work interleaved across every task — so it contributes tokens only,
// under `session`, where no caller can mistake it for a dispatch. IT CAN BE ABSENT (a session still
// being written, a transcript pruned): a value with a named reason, never a throw and never a zero.
//
// EVERY UNAVAILABLE BRANCH NAMES ITS REASON. "No dispatch was found" and "there was nowhere to
// look" are different answers, and neither degrades to a silent empty list.
//
// "REUSED" MEANS MORE THAN ONE REAL PROMPT, AND `EXCLUDED_PROMPTS` IS WHAT MAKES `REAL` HONEST:
// counting `type: "user"` records reports 1535 of this machine's 1550 dispatches as reused, the six
// shapes below — tool results and harness notices nobody typed — take that to 162, and every one of
// the 911 build-loop dispatches then reads fresh, which is what the loop does. The markers are
// ANCHORED at the start of the body left once `<system-reminder>` blocks are stripped, so a prompt
// that merely quotes one later on stays real. Both the list and the predicate are exported because
// they are the fragile part: a marker Claude Code rewords must be pinnable per entry.
//
// THE FORMAT IS UNDOCUMENTED, NOT UNSTABLE — 86924 assistant records across 18 Claude Code versions
// carry `message.usage`, `message.model` and `agentId` at 100%. It is still read defensively: an
// unparseable line and an unreadable file are skipped, and a figure nobody recorded stays null.
//
// THE MEMO IS KEYED ON (mtimeMs, size) — file identity, never a conclusion, so a stale digest
// cannot survive its file. One feature's read is 174 ms cold over its 63 transcripts and 10 ms
// warm; a pass over all 811 MB on this machine is 8.2 s cold and 0.5 s warm.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AGENT_FILE = /^agent-.+\.jsonl$/;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
const ABS_PATH = /\/[^\s'"`,;)\]}]+/g;
const PATH_TAIL = /[.,;:)\]}'"`]+$/;

/** The text a human (or the coordinator) would have typed, with the harness's `<system-reminder>`
 * blocks removed. `null` — not `''` — when the record carries no text at all, which is what keeps
 * a tool-result record out of the second exclusion entry's business. */
function promptBody(record) {
  const content = record?.message?.content;
  if (typeof content === 'string') return content.replace(SYSTEM_REMINDER, '').trim();
  if (!Array.isArray(content)) return null;
  const text = content.filter((b) => b?.type === 'text').map((b) => String(b?.text ?? ''));
  if (text.length === 0) return null;
  return text.join('\n').replace(SYSTEM_REMINDER, '').trim();
}

/** The six shapes a `type: "user"` record can have without a human or a coordinator having sent
 * anything, in the order they are tried. Each entry answers for ONE shape so a reworded marker is
 * one row and one fixture. */
export const EXCLUDED_PROMPTS = [
  {
    why: 'a tool result the harness fed back into the conversation',
    refuses: (record) => {
      const content = record?.message?.content;
      return Array.isArray(content) && content.some((b) => b?.type === 'tool_result');
    },
  },
  {
    why: 'nothing but the <system-reminder> blocks the harness injects',
    refuses: (record) => promptBody(record) === '',
  },
  {
    why: 'the notice the harness writes when a tool call is interrupted',
    refuses: (record) => promptBody(record)?.startsWith('[Request interrupted by user') === true,
  },
  {
    why: 'the harness reminding the agent to call its structured-output tool',
    refuses: (record) => promptBody(record)?.startsWith('[structured-output-enforce]') === true,
  },
  {
    why: 'a background-task event the harness marks as not being user input',
    refuses: (record) => promptBody(record)?.startsWith('[SYSTEM NOTIFICATION - NOT USER INPUT]') === true,
  },
  {
    why: 'the caption the harness attaches to an image it downscaled',
    refuses: (record) => promptBody(record)?.startsWith('[Image: original ') === true,
  },
];

/** A record somebody actually sent this agent: a `user` record with words of its own that matches
 * none of the six shapes above. */
export function isRealPrompt(record) {
  if (record?.type !== 'user') return false;
  if (EXCLUDED_PROMPTS.some((entry) => entry.refuses(record))) return false;
  const body = promptBody(record);
  return typeof body === 'string' && body.length > 0;
}

/** A model name, as opposed to the harness's marker for a record no model produced: Claude Code
 * writes `<synthetic>` where the model goes on an API-error envelope and on a "No response
 * requested." stub, both with all-zero usage. A marker in a model's slot is not a model, so it is
 * skipped and the next assistant record decides — 5 dispatches here open on one, none of the five
 * recorded a model at all, and their `null` is what the viewer says out loud. */
const isModelName = (value) => typeof value === 'string' && value.length > 0 && value !== '<synthetic>';

function noTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

function addTokens(tokens, more) {
  tokens.input += more.input;
  tokens.output += more.output;
  tokens.cacheRead += more.cacheRead;
  tokens.cacheCreate += more.cacheCreate;
}

function addUsage(tokens, usage) {
  if (usage === null || typeof usage !== 'object') return;
  tokens.input += Number(usage.input_tokens) || 0;
  tokens.output += Number(usage.output_tokens) || 0;
  tokens.cacheRead += Number(usage.cache_read_input_tokens) || 0;
  tokens.cacheCreate += Number(usage.cache_creation_input_tokens) || 0;
}

/** The absolute paths a dispatch's brief names — the only key that says which feature it belongs
 * to. `gitBranch` is not that key: it agrees with the feature's branch in 75 of 993 dispatches,
 * because a session sitting on one branch dispatches for another feature all day. */
function pathsIn(body) {
  const found = new Set();
  for (const raw of body.match(ABS_PATH) ?? []) {
    const path = raw.replace(PATH_TAIL, '');
    if (path.length > 1) found.add(path);
  }
  return [...found];
}

/** One transcript, folded into the facts it records. Used for a dispatch and for a coordinator
 * session alike — the session simply has no agentId and its `reused` means nothing.
 * Usage folds once per `message.id`: one message is written as several records that repeat it. */
function readDigest(file) {
  const out = { agentId: null, model: null, at: null, tokens: noTokens(), reused: false, paths: [] };
  const usagePerMessage = new Map();
  let prompts = 0;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line === '') continue;
    let record;
    try { record = JSON.parse(line); } catch { continue; }
    if (out.at === null && typeof record?.timestamp === 'string') out.at = record.timestamp;
    if (out.agentId === null && typeof record?.agentId === 'string') out.agentId = record.agentId;
    if (record?.type === 'assistant') {
      if (out.model === null && isModelName(record?.message?.model)) out.model = record.message.model;
      const id = record?.message?.id;
      if (typeof id === 'string' && id.length > 0) usagePerMessage.set(id, record?.message?.usage);
      else addUsage(out.tokens, record?.message?.usage);
      continue;
    }
    if (!isRealPrompt(record)) continue;
    prompts += 1;
    if (prompts === 1) out.paths = pathsIn(promptBody(record));
  }
  for (const usage of usagePerMessage.values()) addUsage(out.tokens, usage);
  out.reused = prompts > 1;
  return out;
}

const digests = new Map();

/** `readDigest` behind the (mtimeMs, size) memo. `null` when the file cannot be read at all. */
function digestOf(file) {
  let stat;
  try { stat = statSync(file); } catch { return null; }
  const seen = digests.get(file);
  if (seen !== undefined && seen.mtimeMs === stat.mtimeMs && seen.size === stat.size) return seen.digest;
  let digest;
  try { digest = readDigest(file); } catch { return null; }
  digests.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, digest });
  return digest;
}

/** Every `agent-*.jsonl` under `dir`, at ANY depth, because the build loop's own dispatches sit
 * deeper than the rest, under `subagents/workflows/…`. */
function* agentTranscripts(dir) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* agentTranscripts(path);
    else if (AGENT_FILE.test(entry.name)) yield path;
  }
}

function agentTypeOf(file) {
  try {
    const meta = JSON.parse(readFileSync(file.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    return typeof meta?.agentType === 'string' ? meta.agentType : null;
  } catch { return null; }
}

function isPath(value) {
  return typeof value === 'string' && value.length > 0;
}

function named(paths, claim) {
  if (!isPath(claim)) return null;
  return paths.some((p) => p === claim || p.startsWith(`${claim}/`)) ? claim : null;
}

/** THE read: every legion dispatch of these sessions that names this feature, plus the tokens of
 * their coordinator transcripts. Returns the git seam's typed shape —
 * `{available, reason?, agents, session}` — where `session` is `{tokens, sessionId}` or `null` with
 * a `sessionReason`, and `sessionId` is null when several sessions are summed into one block.
 * The caller decides whether a coordinator session may be counted at all (a session two features
 * record belongs to neither); this only reports what it read. */
export function readFeatureAgents({ sessions = [], worktree = null, dossier = null } = {}) {
  const none = (reason) => ({ available: false, reason, agents: [], session: null, sessionReason: reason });
  const root = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  const projects = join(root, 'projects');
  if (!existsSync(projects)) {
    return none(`${projects} does not exist, so Claude Code recorded no transcript on this machine`);
  }
  const ids = [...new Set((Array.isArray(sessions) ? sessions : []).filter((s) => typeof s === 'string' && s.length > 0))];
  if (ids.length === 0) {
    return none('feature.json records no session, so there is no transcript to read');
  }
  if (!isPath(worktree) && !isPath(dossier)) {
    return none('feature.json records neither a worktree nor a dossier path, so no dispatch could be attributed to this feature');
  }
  let encoded;
  try { encoded = readdirSync(projects, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(projects, e.name)); }
  catch (err) { return none(`${projects} could not be listed: ${err.message}`); }

  const dispatchDirs = [];
  const coordinators = [];
  for (const id of ids) {
    for (const dir of encoded) {
      if (existsSync(join(dir, id))) dispatchDirs.push(join(dir, id));
      if (existsSync(join(dir, `${id}.jsonl`))) coordinators.push({ id, file: join(dir, `${id}.jsonl`) });
    }
  }
  if (dispatchDirs.length === 0 && coordinators.length === 0) {
    return none(`none of the ${ids.length} session(s) this feature recorded has a transcript under ${projects}`);
  }

  const agents = [];
  for (const dir of dispatchDirs) {
    for (const file of agentTranscripts(join(dir, 'subagents'))) {
      const agentType = agentTypeOf(file);
      if (agentType === null || !agentType.startsWith('legion:')) continue;
      const digest = digestOf(file);
      if (digest === null) continue;
      const onWorktree = named(digest.paths, worktree);
      const onDossier = named(digest.paths, dossier);
      if (onWorktree === null && onDossier === null) continue;
      agents.push({
        agentId: digest.agentId,
        agentType,
        model: digest.model,
        at: digest.at,
        tokens: { ...digest.tokens },
        reused: digest.reused,
        worktree: onWorktree,
        dossier: onDossier,
      });
    }
  }

  const tokens = noTokens();
  const read = [];
  for (const { id, file } of coordinators) {
    const digest = digestOf(file);
    if (digest === null) continue;
    addTokens(tokens, digest.tokens);
    read.push(id);
  }
  const unread = ids.filter((id) => !read.includes(id));
  const sessionReason = unread.length === 0 ? null
    : `no coordinator transcript was read for ${unread.join(', ')} — a session still being written, or a transcript pruned since`;
  if (read.length === 0) return { available: true, agents, session: null, sessionReason };
  const session = { tokens, sessionId: read.length === 1 ? read[0] : null };
  return sessionReason === null ? { available: true, agents, session } : { available: true, agents, session, sessionReason };
}
