// viewer-transcripts.test.mjs — the transcript reader (src/cli/_viewer/transcripts.mjs): what
// counts as a real prompt, and therefore whether an agent was reused or fresh.
//
// HERMETIC, AND THAT IS THE POINT. Every scenario forges its own `~/.claude` under a temp
// directory and points CLAUDE_CONFIG_DIR at it for the duration of the call; the operator's real
// home is never read. The records below are copied from real transcripts (the interruption notice,
// the structured-output nudge, the background-task notification and the image caption are verbatim)
// because a fixture invented from the prose would pin the prose rather than the format.
//
// THE EXCLUSION LIST IS GRADED IN BOTH DIRECTIONS, per entry. Six cold fixtures — one real prompt
// plus one instance of each excluded shape — must read `reused: false`, and each excluded record
// must be refused by EXACTLY ONE entry, which is per-entry coverage without mutating the module.
// Against them stand a warm fixture (two plain prompts) and an over-fire fixture: a second real
// prompt that carries a system-reminder block alongside its own words AND opens with a bracketed
// task id. An exclusion greedy enough to swallow that one reports a reused agent as fresh, and a
// reader that never looks reports every agent as fresh — the two failures this file exists to tell
// apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXCLUDED_PROMPTS, isRealPrompt, readFeatureAgents } from '../../src/cli/_viewer/transcripts.mjs';

const SID = 'b06eb4d9-cc13-4712-8c80-2c78070c1d61';
const WORKTREE = '/forged/Work/.legion-worktrees/legion/f1/checkout';
const DOSSIER = '/forged/.legion/orgs/default/projects/legion/features/f1';
const AT = '2026-08-20T10:00:00.000Z';

/** Run `fn` with CLAUDE_CONFIG_DIR pinned at a forged root, always restored. The reader resolves
 * the root on every call, so this is all the isolation it needs. */
function withRoot(root, fn) {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved;
  }
}

const jsonl = (records) => `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

/** A forged transcript tree: one encoded-project directory, sessions and dispatches written into
 * it by hand. `under` is where a dispatch's file goes, because the build loop's own dispatches sit
 * one level deeper than the rest. */
function forge() {
  const root = mkdtempSync(join(tmpdir(), 'legion3-transcripts-'));
  const enc = join(root, 'projects', '-forged-Work-legion3');
  mkdirSync(enc, { recursive: true });
  return {
    root,
    session(sid = SID) { mkdirSync(join(enc, sid, 'subagents'), { recursive: true }); return this; },
    coordinator(records, sid = SID) { writeFileSync(join(enc, `${sid}.jsonl`), jsonl(records)); return this; },
    dispatch({ id = 'a1', agentType = 'legion:builder', under = ['subagents'], sid = SID, records }) {
      const dir = join(enc, sid, ...under);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `agent-${id}.jsonl`), jsonl(records));
      writeFileSync(join(dir, `agent-${id}.meta.json`), `${JSON.stringify({ agentType, spawnDepth: 1 })}\n`);
      return this;
    },
    read(over = {}) {
      return withRoot(root, () => readFeatureAgents({ sessions: [SID], worktree: WORKTREE, dossier: DOSSIER, ...over }));
    },
    cleanup() { rmSync(root, { recursive: true, force: true }); },
  };
}

const prompt = (text) => ({ type: 'user', timestamp: AT, agentId: 'a1', message: { role: 'user', content: text } });
const blocks = (content) => ({ type: 'user', timestamp: AT, agentId: 'a1', message: { role: 'user', content } });
const brief = () => prompt(`Implement the reader.\nWorktree (build here, never in the main clone): ${WORKTREE}\n`);
const reply = (usage = {}, id) => ({
  type: 'assistant',
  timestamp: AT,
  agentId: 'a1',
  message: {
    id,
    model: 'claude-opus-5',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  },
});

/** One record per exclusion entry, in the list's order, each copied from a real transcript. */
const EXCLUDED = [
  { what: 'a tool result', record: blocks([{ tool_use_id: 'toolu_01VK4pkm6iJhcLwrRBQw3SeZ', type: 'tool_result', content: 'da0ecb9 fix(close): stop asserting a squash' }]) },
  { what: 'a body that is nothing but a system reminder', record: prompt('<system-reminder>\nOther agents active in this session, addressable via SendMessage({to: name, message}): main, code-review.\n</system-reminder>') },
  { what: 'an interruption notice', record: prompt('[Request interrupted by user for tool use]') },
  { what: 'a structured-output nudge', record: prompt('[structured-output-enforce] You MUST call the StructuredOutput tool to complete this request. Call this tool now.') },
  { what: 'a background-task notification', record: prompt('[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.') },
  { what: 'an image caption', record: prompt('[Image: original 390x2820, displayed at 277x2000. Multiply coordinates by 1.41 to map to original image.]') },
];

test('the exclusion list has six entries and each excluded shape is refused by exactly one', () => {
  assert.equal(EXCLUDED_PROMPTS.length, 6);
  for (const [i, { what, record }] of EXCLUDED.entries()) {
    const refusing = EXCLUDED_PROMPTS.filter((entry) => entry.refuses(record));
    assert.equal(refusing.length, 1, `${what} is refused by ${refusing.length} entries, not by one`);
    assert.equal(refusing[0], EXCLUDED_PROMPTS[i], `${what} is refused by the wrong entry`);
    assert.equal(isRealPrompt(record), false, `${what} reads as a real prompt`);
  }
  assert.equal(isRealPrompt(brief()), true);
});

for (const [i, { what, record }] of EXCLUDED.entries()) {
  test(`${what} is not a prompt, so the agent that received it reads fresh`, () => {
    const t = forge().session().coordinator([reply()]).dispatch({ id: `cold${i}`, records: [brief(), record, reply()] });
    try {
      const out = t.read();
      assert.equal(out.available, true);
      assert.equal(out.agents.length, 1);
      assert.equal(out.agents[0].reused, false);
    } finally { t.cleanup(); }
  });
}

test('two plain prompts are two prompts, so the agent reads reused', () => {
  const t = forge().session().coordinator([reply()]).dispatch({
    records: [brief(), prompt('One more thing before you commit: sweep the docs.'), reply()],
  });
  try {
    const out = t.read();
    assert.equal(out.agents.length, 1);
    assert.equal(out.agents[0].reused, true);
  } finally { t.cleanup(); }
});

test('a second prompt carrying a system reminder and opening with a bracketed id still counts', () => {
  const t = forge().session().coordinator([reply()]).dispatch({
    records: [
      brief(),
      prompt('[T4] the fix round found one thing: the reason is unnamed.\n<system-reminder>\nRemember the gate.\n</system-reminder>'),
      reply(),
    ],
  });
  try {
    const out = t.read();
    assert.equal(out.agents.length, 1);
    assert.equal(out.agents[0].reused, true, 'the exclusion over-fired and swallowed a real prompt');
  } finally { t.cleanup(); }
});

test('a dispatch the build loop recorded one level deeper is found, and reads fresh', () => {
  const t = forge().session().coordinator([reply()]).dispatch({
    under: ['subagents', 'workflows', 'wf_01K2QX'],
    records: [brief(), reply()],
  });
  try {
    const out = t.read();
    assert.equal(out.agents.length, 1, 'the walk stopped at subagents/ and missed the build loop');
    assert.equal(out.agents[0].reused, false);
  } finally { t.cleanup(); }
});

test('tokens, model and role are read off the records, and the session is returned separately', () => {
  const t = forge().session()
    .coordinator([prompt('carry on'), reply({ output_tokens: 7, cache_read_input_tokens: 11 })])
    .dispatch({
      records: [
        brief(),
        reply({ input_tokens: 2, output_tokens: 20, cache_read_input_tokens: 200, cache_creation_input_tokens: 30 }),
        reply({ input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 1 }),
      ],
    });
  try {
    const out = t.read();
    assert.equal(out.agents.length, 1);
    const [agent] = out.agents;
    assert.deepEqual(Object.keys(agent).sort(), ['agentId', 'agentType', 'at', 'dossier', 'model', 'reused', 'tokens', 'worktree']);
    assert.deepEqual(agent.tokens, { input: 5, output: 25, cacheRead: 300, cacheCreate: 31 });
    assert.equal(agent.model, 'claude-opus-5');
    assert.equal(agent.agentType, 'legion:builder');
    assert.equal(agent.agentId, 'a1');
    assert.equal(agent.at, AT);
    assert.equal(agent.worktree, WORKTREE);
    assert.equal(agent.dossier, null);
    assert.deepEqual(out.session, { tokens: { input: 0, output: 7, cacheRead: 11, cacheCreate: 0 }, sessionId: SID });
  } finally { t.cleanup(); }
});

test('one message written as several records is counted once, not once per record', () => {
  const streamed = (output) => reply(
    { input_tokens: 4, output_tokens: output, cache_read_input_tokens: 900, cache_creation_input_tokens: 60 },
    'msg_01ARmsdG2m5wMdrQL8n5Q3Ge',
  );
  const t = forge().session().coordinator([reply()])
    .dispatch({ records: [brief(), streamed(1), streamed(37)] });
  try {
    const out = t.read();
    assert.deepEqual(out.agents[0].tokens, { input: 4, output: 37, cacheRead: 900, cacheCreate: 60 });
  } finally { t.cleanup(); }
});

test('a dispatch of another agent type, and one naming neither path, are not attributed', () => {
  const t = forge().session().coordinator([reply()])
    .dispatch({ id: 'kept', records: [prompt(`review the dossier at ${DOSSIER}/plan.md`), reply()] })
    .dispatch({ id: 'other', agentType: 'general-purpose', records: [brief(), reply()] })
    .dispatch({ id: 'elsewhere', records: [prompt('build in /forged/Work/.legion-worktrees/legion/f2/checkout'), reply()] });
  try {
    const out = t.read();
    assert.equal(out.agents.length, 1);
    assert.equal(out.agents[0].dossier, DOSSIER);
    assert.equal(out.agents[0].worktree, null);
  } finally { t.cleanup(); }
});

test('two sessions of one feature are summed into a block that claims no single session', () => {
  const second = '5daa52b4-d275-4cf2-9e3e-e64acd26a8a8';
  const t = forge().session().session(second)
    .coordinator([reply({ output_tokens: 7 })])
    .coordinator([reply({ output_tokens: 5 })], second)
    .dispatch({ records: [brief(), reply()] })
    .dispatch({ id: 'a2', sid: second, records: [brief(), reply()] });
  try {
    const out = t.read({ sessions: [SID, second] });
    assert.equal(out.agents.length, 2);
    assert.equal(out.session.tokens.output, 12);
    assert.equal(out.session.sessionId, null);
  } finally { t.cleanup(); }
});

test('a transcript that grew since it was read is read again, not remembered', () => {
  const t = forge().session().coordinator([reply()]).dispatch({ records: [brief(), reply()] });
  try {
    assert.equal(t.read().agents[0].reused, false);
    t.dispatch({ records: [brief(), reply(), prompt('one more thing before you commit'), reply()] });
    assert.equal(t.read().agents[0].reused, true, 'the memo returned a digest older than its file');
  } finally { t.cleanup(); }
});

test('a session whose coordinator transcript is absent names the absence and keeps its agents', () => {
  const t = forge().session().dispatch({ records: [brief(), reply()] });
  try {
    const out = t.read();
    assert.equal(out.available, true);
    assert.equal(out.agents.length, 1);
    assert.equal(out.session, null);
    assert.match(out.sessionReason, new RegExp(SID));
  } finally { t.cleanup(); }
});

test('nowhere to look is an answer with a reason, never an empty success', () => {
  const empty = mkdtempSync(join(tmpdir(), 'legion3-transcripts-empty-'));
  try {
    const out = withRoot(empty, () => readFeatureAgents({ sessions: [SID], worktree: WORKTREE, dossier: DOSSIER }));
    assert.equal(out.available, false);
    assert.match(out.reason, /projects does not exist, so Claude Code recorded no transcript/);
    assert.deepEqual(out.agents, []);
    assert.equal(out.session, null);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('a feature that recorded no session, and a session with no transcript, each say so', () => {
  const t = forge().session().coordinator([reply()]).dispatch({ records: [brief(), reply()] });
  try {
    assert.match(t.read({ sessions: [] }).reason, /records no session/);
    const unknown = t.read({ sessions: ['5daa52b4-d275-4cf2-9e3e-e64acd26a8a8'] });
    assert.equal(unknown.available, false);
    assert.match(unknown.reason, /transcript/);
    assert.match(t.read({ worktree: null, dossier: null }).reason, /neither a worktree nor a dossier/);
  } finally { t.cleanup(); }
});
