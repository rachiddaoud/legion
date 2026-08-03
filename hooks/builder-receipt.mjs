// builder-receipt.mjs — SubagentStop hook, scoped to the BUILDER (PLAN-V3 §Gates:
// "a builder-scoped SubagentStop hook only *verifies* receipts (blocks stop when
// missing/stale), never runs the gate itself").
//
// IT RUNS EXACTLY ONE COMMAND: `legion gate verify-receipt --task <id>`. That subcommand
// executes no gate tier, loads no gates config, spawns no project command and writes no state
// (src/cli/gate.mjs verifyReceipt). Running the real gate from a stop hook would put an
// expensive, repo-mutating step on the subagent-exit path, which the plan forbids and which
// would also let the hook, not the builder, be the thing that produced the receipt.
//
// VALIDATED AGAINST CLAUDE CODE 2.1.219. Facts read out of that build:
//   - SubagentStop input is {stop_hook_active, agent_id, agent_type, agent_transcript_path,
//     last_assistant_message?, …}.
//   - the matcher for SubagentStop is compared against agent_type (the event-to-field switch
//     in the hook dispatcher).
//   - EXIT-CODE SEMANTICS, quoted from the build's own event table: "Exit code 2 - show
//     stderr to subagent and continue having it run". Exit 2 IS the block, and the stderr we
//     write is what the builder reads. Exit 0 lets it stop; any other code only reaches the
//     user, so it must never be used to try to block.
//   - a plugin agent's agent_type is `<plugin>:<name>` (the plugin agent loader joins plugin
//     name, subdirectory segments and the frontmatter name with ':'), i.e. `legion:builder`.
//
// The manifest matcher is the regex ^(legion:)?builder$ and this file RE-CHECKS agent_type
// itself. That is deliberate belt-and-braces: a hook that silently never fires is the worst
// outcome here, so the matcher is written to match whether or not the runtime namespaces the
// type, and the in-process check keeps the hook inert for any other subagent that slips past.
//
// FAIL-SAFE vs FAIL-CLOSED:
//   - FAIL-SAFE (the only silence): not a legion feature worktree, or not the builder, or no
//     task is currently started ⇒ exit 0, print nothing. An ABSENT tasks.json is part of this:
//     it means `legion state init` has not run, so nothing was under construction.
//   - A CORRUPT DOSSIER IS LOUD, AND BLOCKS (R9). A manifest that is PRESENT but unreadable used
//     to reach this hook as "not a legion feature" and released the builder silently — a session
//     running with no gate at all. It now exits 2 naming the file and its path, and deliberately
//     never says "not a legion feature". The check sits AFTER the agent_type test (this hook stays
//     inert for every other subagent, corrupt dossier or not) and BEFORE any read of tasks.tasks.
//     Under stop_hook_active it reports just as loudly and RELEASES, matching the recursion-cap
//     honesty below: blocking a second time cannot mend a manifest.
//   - FAIL-CLOSED-ISH, stated honestly: a missing or stale receipt exits 2 and blocks. But
//     Claude Code caps stop-hook recursion via stop_hook_active, so a builder that keeps
//     trying WILL eventually be allowed to stop. THIS HOOK IS DEFENCE IN DEPTH, NOT THE
//     GUARANTEE. The real fail-closed layer is `legion state task-done`, which re-derives
//     HEAD's tree itself and refuses unless the task receipt keys to it AND carries gate
//     provenance under the pinned policy (src/kernel/state.mjs taskDone) — no hook, no agent and
//     no prompt can talk past that.
import { readHookInput, resolveFeature, runKernel } from './_common.mjs';

const BUILDER = /^(legion:)?builder$/;

const input = readHookInput();
if (!input) process.exit(0);
if (!BUILDER.test(String(input.agent_type ?? ''))) process.exit(0); // fail-safe: not the builder

const resolved = resolveFeature(input);
if (!resolved) process.exit(0); // fail-safe: not a legion worktree
const { cwd, tasks, corrupt } = resolved;

// LOUD, and it BLOCKS: a dossier that exists but cannot be read means nothing here can tell
// whether a task is under construction or whether its gate ever ran. Naming the file and the path
// is the whole point — "not a legion feature" would be a lie, and silence would release a builder
// into a session with no gate.
if (corrupt) {
  process.stderr.write(
    `legion: DOSSIER CORRUPT — ${corrupt.what} at ${corrupt.path} could not be read: ${corrupt.detail}\n` +
    `This is a REGISTERED legion feature worktree, so the gate applies; the manifest is broken, not absent.\n` +
    `Do not work around it and do not hand-write a manifest: report it to the operator, who must repair\n` +
    `or restore ${corrupt.what} before any task can be gated or closed.\n` +
    (input.stop_hook_active === true
      ? 'Releasing (this hook already blocked once and blocking again cannot mend a manifest).\n'
      : ''),
  );
  process.exit(input.stop_hook_active === true ? 0 : 2);
}
if (!tasks) process.exit(0); // no tasks.json ⇒ nothing was under construction

// WHICH TASK: the one currently started. `legion state task-start` sets status='started' and
// stamps startedAt, and `task-done` clears it to 'done', so at most one task is normally open;
// when several are (a deferred build, a re-run), the LATEST start is the one this builder was
// dispatched for. Ties fall back to manifest order, which is the plan's order.
const started = (tasks.tasks ?? []).filter((t) => t.status === 'started');
if (started.length === 0) process.exit(0); // fail-safe: builder ran outside a task
const task = started.reduce((a, b) => ((b.startedAt ?? '') >= (a.startedAt ?? '') ? b : a));

const r = runKernel(['gate', 'verify-receipt', '--task', task.id], cwd);
if (r.code === 0) process.exit(0);

// stop_hook_active means this hook already blocked this stop once. Blocking again cannot make
// the receipt appear and only spends the builder's turns, so let it stop and let `task-done`
// refuse — see the header. Say so on stderr rather than exiting silently: the refusal was
// real and must not be swallowed.
if (input.stop_hook_active === true) {
  process.stderr.write(
    `legion: receipt still not valid for task ${task.id} after a block; releasing the builder.\n` +
    `${(r.stderr || r.stdout).trim()}\n` +
    `\`legion state task-done ${task.id}\` will refuse until the gate is re-run — that is the real gate.\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `legion: task ${task.id} has no valid gate receipt for the current tree — you cannot stop yet.\n` +
  `${(r.stderr || r.stdout).trim()}\n` +
  `The protocol is edit -> self-test -> COMMIT -> gate (a dirty worktree is itself a refusal):\n` +
  `  1. commit your work in ${resolved.feature.worktree}\n` +
  `  2. run \`legion gate run --task ${task.id}\` from that worktree\n` +
  `  3. red gate? fix forward with a fixup commit and re-run it — never amend past a receipt\n` +
  `Do NOT hand-write a receipt: \`legion gate run --task ${task.id}\` records it through the ` +
  `typed op itself, and nothing else can.\n`,
);
process.exit(2); // 2 = show stderr to the subagent and keep it running (2.1.219 semantics)
