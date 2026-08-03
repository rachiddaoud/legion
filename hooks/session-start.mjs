// session-start.mjs — SessionStart hook (PLAN-V3 §Startup). Two jobs, in this order:
//   1. record the session id into feature.json via the typed op
//      `legion state session-record --session-id <id>` (the kernel owns the write);
//   2. inject a COMPACT rendering of feature.json + tasks.json as additionalContext, so a
//      supervisor restart, a /clear, or a compaction never loses the stage.
//
// VALIDATED AGAINST CLAUDE CODE 2.1.219. Facts read out of that build:
//   - SessionStart input carries session_id, cwd, and source, where source is one of
//     startup|resume|clear|compact|fork.
//   - SessionStart supports hookSpecificOutput.additionalContext (PostCompact does NOT — it
//     only prints to the user — which is why PLAN-V3 makes PostCompact observational and puts
//     rehydration here, on source=compact).
//   - EXIT-CODE SEMANTICS, quoted from the build's own event table: "Exit code 0 - stdout
//     shown to Claude / Exit code 2 - show stderr to USER only". SessionStart therefore
//     CANNOT BLOCK ANYTHING.
//
// FAIL-SAFE vs FAIL-CLOSED, stated honestly rather than overclaimed:
//   - FAIL-SAFE (the only silence): cwd is not a registered legion feature worktree ⇒ exit 0,
//     print nothing. This plugin loads in every session; most sessions are not features.
//   - NOT FAIL-CLOSED, and it cannot be. Because exit 2 here reaches the user and not the
//     model, a `session-record` refusal cannot stop the session. It is surfaced instead as a
//     LEGION KERNEL REFUSAL block at the TOP of the injected context, where the model reads
//     it and can act. Claiming this hook fails closed would be a claim the code does not
//     deliver; the session-history write is bookkeeping, and nothing downstream gates on it.
//   - A CORRUPT MANIFEST IS LOUD IN-BAND (R9). SessionStart cannot block anything, so the
//     loudest channel it has is additionalContext — the model reads that. On corruption this hook
//     injects the corruption ALONE, naming the file and its path and saying in terms that the
//     session is running with NO GATE, and it SKIPS both the session-record call and the manifest
//     rendering: there is no stage to render (the manifest is what could not be read), and
//     recording a session into a dossier whose shape is unknown is exactly the kind of quiet
//     write this whole design refuses. Rendering it as "not a legion feature" — which is what
//     this hook used to do — is what turned a broken dossier into an ungated session.
//
// The rendering is CAPPED (CAP below). This text is prepended to a fresh context on every
// resume, so an unbounded task list would tax every session of a large feature forever.
import { emit, readHookInput, resolveFeature, runKernel } from './_common.mjs';

const CAP = 6000;          // characters of injected context, hard ceiling
const TASK_LINES = 40;     // tasks rendered in full before the tail is summarised

const input = readHookInput();
if (!input) process.exit(0);

const resolved = resolveFeature(input);
if (!resolved) process.exit(0); // fail-safe: not a legion worktree
const { cwd, dossier, feature, tasks, corrupt } = resolved;

// --- 0. a corrupt manifest pre-empts both jobs, loudly and in-band (header) -------------------
if (corrupt) {
  emit('SessionStart',
    `LEGION DOSSIER CORRUPT — ${corrupt.what} at ${corrupt.path} could not be read: ${corrupt.detail}\n` +
    `\n` +
    `This cwd IS a registered legion feature worktree, so the legion lifecycle applies — but its\n` +
    `${corrupt.what} is unreadable, so THIS SESSION IS RUNNING WITH NO GATE AND NO STAGE. Nothing was\n` +
    `recorded (the session id was deliberately NOT written into a manifest whose shape is unknown).\n` +
    `\n` +
    // No backticked command names in this text: the injected block is a REPORT, not a runbook, and
    // test/plugin-manifest.test.mjs holds every backticked legion invocation in a shipped component
    // to the router's real command list — a `legion state` span here would be a command this
    // message is explicitly telling the model NOT to run.
    `Do NOT improvise a lifecycle, do NOT hand-write a manifest, and do NOT run any legion state\n` +
    `op: report this to the operator, who must repair or restore ${corrupt.what} first. Every kernel\n` +
    `command will refuse until then, and those refusals are correct.`);
}

// --- 1. record the session -----------------------------------------------------------------
// The session id is CONTENT (the harness's own identifier), not evidence the kernel could
// derive, so it is passed as a flag — the same category as --question/--answer, and unlike a
// hash or a HEAD, for which no typed op offers a flag at all.
let refusal = null;
const sessionId = typeof input.session_id === 'string' ? input.session_id : null;
if (sessionId) {
  const r = runKernel(['state', 'session-record', '--session-id', sessionId], cwd);
  if (r.code !== 0) {
    refusal =
      `LEGION KERNEL REFUSAL — \`legion state session-record\` exited ${r.code}:\n` +
      `${(r.stderr || r.stdout).trim()}\n` +
      `The session was NOT recorded in feature.json. State below is still authoritative; ` +
      `report this to the operator before relying on session history.`;
  }
}

// --- 2. render the stage --------------------------------------------------------------------
const L = [];
if (refusal) L.push(refusal, '');
L.push(`# legion feature ${feature.featureId}`);
L.push('');
L.push(`Resumed via SessionStart(${input.source ?? 'unknown'}). This is the authoritative stage;`);
L.push('re-derive nothing from the transcript. The dossier below is the durable memory.');
L.push('');
L.push(`- stage:    ${feature.stage}   (status ${feature.status}, profile ${feature.profile})`);
L.push(`- branch:   ${feature.branch}  (base ${feature.baseBranch} @ ${feature.baseSha})`);
L.push(`- worktree: ${feature.worktree}`);
L.push(`- dossier:  ${dossier}`);
// ATTACHED INTAKE REPOSITORIES (T23), when the manifest has any. A resumed session is handed this
// block and nothing else, so without this line it has no way to learn that the launch put other
// repositories in its reach — and an intake that cannot see them silently degrades to single-repo.
// ONE LINE, paths only: the block is CAP-capped and this sits high enough to survive truncation.
// Absence is the ordinary single-repo case and renders nothing.
if ((feature.intakeRepos ?? []).length > 0) {
  L.push(`- intake repos (attached at feature start, already in reach via --add-dir): ${feature.intakeRepos.join(', ')}`);
}
if (feature.initError) L.push(`- initError: ${feature.initError}`);
if (feature.mr) L.push(`- mr: !${feature.mr.iid} @ ${feature.mr.headSha}`);

if (!tasks) {
  L.push('');
  L.push('tasks.json does not exist yet — the plan has not been imported.');
} else {
  const approvals = Object.keys(tasks.approvals ?? {});
  L.push('');
  L.push(`- artifacts: ${Object.keys(tasks.artifacts ?? {}).join(', ') || 'none'}`);
  L.push(`- approvals recorded: ${approvals.join(', ') || 'none'}`);
  // A receipt is DISPLAYED here, so its provenance must be legible: `declaredCommands: 0` is a
  // real but WEAK certificate (tier-0 self-protection only) and must never read like a full one
  // (PLAN-V3 §Gates / R11). Same rule as `gate run`'s GREEN line and finalize's MR comment.
  const b = tasks.receipts?.boundary;
  const boundaryLine = b
    ? `yes (${b.declaredCommands ?? '?'} declared boundary command(s)` +
      `${b.declaredCommands === 0 ? ' — TIER-0 ONLY, a real but WEAK certificate' : ''}` +
      `${typeof b.repinnedFrom === 'string' ? ', GATE POLICY RE-PINNED MID-FEATURE' : ''})`
    : 'no';
  L.push(`- reviews: ${(tasks.reviews ?? []).length}   boundary receipt: ${boundaryLine}`);
  // Approvals are rendered as RECORDED, never as VALID: validity is a hash comparison the
  // kernel performs at the moment of use (approvalValid in src/kernel/state.mjs). A hook
  // that printed "plan: approved" would be asserting something it did not check, and the
  // session would act on it.
  L.push('  (recorded != valid — an artifact edit invalidates deterministically; the kernel');
  L.push('   decides at use time, and its refusal is the answer.)');
  const list = tasks.tasks ?? [];
  L.push('');
  L.push(`## tasks (${list.filter((t) => t.status === 'done').length}/${list.length} done)`);
  for (const t of list.slice(0, TASK_LINES)) {
    const flags = [];
    if (t.receipt) flags.push('receipt');
    if ((t.answers ?? []).length) flags.push(`${t.answers.length} answered`);
    L.push(`- ${t.id} [${t.status ?? 'pending'}] ${t.title ?? ''}${flags.length ? `  (${flags.join(', ')})` : ''}`);
  }
  if (list.length > TASK_LINES) L.push(`- … ${list.length - TASK_LINES} more (read tasks.json)`);
  const blocked = list.filter((t) => (t.answers ?? []).some((a) => a.answer == null));
  if (blocked.length) L.push(`- OPEN QUESTIONS on: ${blocked.map((t) => t.id).join(', ')}`);
}
L.push('');
L.push('Resume by re-entering `/legion:feature` at the stage above. Never create infrastructure.');

let context = L.join('\n');
if (context.length > CAP) context = `${context.slice(0, CAP)}\n… (truncated; read feature.json and tasks.json in the dossier)`;

emit('SessionStart', context);
