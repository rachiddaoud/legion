// activity.mjs — the derived activity feed of one feature, folded out of the timestamps the
// kernel already recorded.
//
// THERE IS NO EVENT LOG HERE, AND THIS FILE DOES NOT INVENT ONE. Every entry below is a field that
// EXISTS in feature.json/tasks.json — `at` is copied verbatim from the record it came from, never
// synthesised, never interpolated, never back-filled from a neighbouring entry. If the kernel
// recorded no timestamp for something, this feed has no row for it, and that silence is the
// honest rendering: missing data is never guessed into valid-looking state.
//
// PURE, AND THAT IS WHY GIT COMMITS ARE AN ARGUMENT. `git log` is the one activity source that is
// not in a manifest, and reading it means spawning a process against a worktree that may be gone.
// Folding that in here would make this module untestable without a repository and would put a
// spawn inside the cheap cross-feature feed. So the caller (the server, detail view only) passes
// `commits` in; this module never imports node:child_process and never touches the filesystem.
// The global /api/activity feed simply passes nothing, which is exactly this manifest-only shape.
//
// SORT ORDER: ASCENDING by `at` (oldest first) — the chronological order the lifecycle happened
// in. The client reverses it for a newest-first feed; doing that here would make "the order the
// facts occurred" a client concern. Ties keep INSERTION order (the emit order below), so two
// records sharing a `--now` timestamp — which is every op in a fixture, and any two ops in the
// same second in real life — render in a stable, reproducible sequence rather than one that
// depends on the engine's sort. Entries whose `at` DOES NOT PARSE are neither dropped nor
// repaired: they sort LAST, in insertion order, carrying the unparseable value verbatim, because
// dropping a recorded fact and inventing a date for one are both lies.
//
// NOTHING HERE IS LIFECYCLE STATE. A row says "this was recorded at this time"; it never says a
// feature is running, stalled, waiting or live. Those words have no source in this codebase.

/** The closed vocabulary of activity rows. A `kind` outside this list is a bug, not a feature:
 * the client styles by kind, and an unknown kind renders as an unstyled row rather than being
 * silently dropped — but nothing in this module emits one. */
export const ACTIVITY_KINDS = [
  'stage-enter', 'stage-complete', 'task-start', 'task-done', 'question', 'answer',
  'review', 'approval', 'gate-receipt', 'session', 'mr', 'commit',
];

/** A recorded timestamp is a non-empty STRING in every manifest the kernel writes (ISO 8601 via
 * `--now`/new Date().toISOString()). Anything else is a hand-edit; it still gets a row. */
const dated = (v) => (typeof v === 'string' && v.length > 0 ? v : null);

/** Sort key: epoch ms, or null when the value is not a parseable date. Never throws. */
const epoch = (at) => {
  const t = Date.parse(at);
  return Number.isNaN(t) ? null : t;
};

/**
 * Fold ONE feature's recorded timestamps into a time-sorted [{at, kind, label}] list.
 *
 *   feature  parsed feature.json (required — it carries the stage/session/MR timeline)
 *   tasks    parsed tasks.json, or null when the plan has not been imported yet (an ordinary
 *            early stage, not an error: the task/review/approval/receipt rows simply do not exist)
 *   commits  optional [{sha, at, subject}] the CALLER read through the hardened git seam. Absent
 *            ⇒ no commit rows; this module never spawns anything (header).
 *
 * Every field access is defensive (`?.`, `?? []`): this is a projection over files an operator
 * can hand-edit, and a missing array must render as "nothing recorded", never as a crash that
 * takes the whole detail view down.
 */
export function featureActivity({ feature, tasks = null, commits = [] } = {}) {
  const rows = [];
  const push = (at, kind, label) => { if (at !== null) rows.push({ at, kind, label }); };

  // --- feature.json: the stage timeline, the sessions, the recorded MR ---------------------
  for (const h of feature?.stageHistory ?? []) {
    push(dated(h?.at), 'stage-enter', `entered stage ${h?.stage}`);
  }
  for (const h of feature?.completedStages ?? []) {
    push(dated(h?.at), 'stage-complete', `completed stage ${h?.stage}`);
  }
  // RECORDED session facts, never presence. `sessionHistory` says a SessionStart hook ran and the
  // kernel wrote the id down; it says nothing about whether that session is alive now, and this
  // label must never suggest otherwise.
  for (const s of feature?.sessionHistory ?? []) {
    push(dated(s?.at), 'session', `session recorded: ${s?.sessionId}`);
  }
  if (feature?.mr) {
    // GitHub PRs are `#42`, GitLab MRs `!42`; a record with no `forge` predates the marker
    // (2026-08-15) and is a GitLab MR by construction.
    const gh = feature.mr.forge === 'github';
    push(dated(feature.mr.at), 'mr',
      `${gh ? 'PR' : 'MR'} ${gh ? '#' : '!'}${feature.mr.iid} recorded at ${feature.mr.headSha}`);
  }

  // --- tasks.json: tasks, questions, reviews, approvals, receipts --------------------------
  for (const t of tasks?.tasks ?? []) {
    push(dated(t?.startedAt), 'task-start', `task ${t?.id} started`);
    push(dated(t?.doneAt), 'task-done', `task ${t?.id} done`);
    for (const a of t?.answers ?? []) {
      // `answer == null` is the OPEN question (the same predicate hooks/session-start.mjs uses).
      // One record carries both halves, so an answered question emits the ANSWER row alone: the
      // manifest records only one timestamp, and emitting a second row at the same `at` would
      // claim the question was asked at the moment it was answered.
      push(dated(a?.at), a?.answer == null ? 'question' : 'answer',
        a?.answer == null ? `task ${t?.id}: question recorded` : `task ${t?.id}: answer recorded`);
    }
    if (t?.receipt) {
      push(dated(t.receipt.at), 'gate-receipt', receiptLabel(`task ${t?.id}`, t.receipt));
    }
  }
  for (const r of tasks?.reviews ?? []) {
    push(dated(r?.at), 'review', `${r?.role}: ${r?.verdict} on ${r?.subject}`);
  }
  // Approvals are RECORDED facts here exactly as everywhere else in this viewer: the row says one
  // was recorded at a time, and says nothing about whether it still validates (that is a hash
  // comparison the kernel performs at the moment of use, reported per approval under
  // `lifecycleNow.approvalsValidNow`).
  for (const [kind, appr] of Object.entries(tasks?.approvals ?? {})) {
    push(dated(appr?.at), 'approval', `${kind} decision recorded`);
  }
  if (tasks?.receipts?.boundary) {
    push(dated(tasks.receipts.boundary.at), 'gate-receipt', receiptLabel('boundary', tasks.receipts.boundary));
  }

  // --- git, injected only (header) ----------------------------------------------------------
  for (const c of commits ?? []) {
    push(dated(c?.at), 'commit', `${String(c?.sha ?? '').slice(0, 8)} ${c?.subject ?? ''}`.trim());
  }

  // Stable ascending sort; unparseable dates last in insertion order (header SORT ORDER).
  return rows
    .map((row, i) => ({ row, i, t: epoch(row.at) }))
    .sort((a, b) => {
      if (a.t === null && b.t === null) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return a.t === b.t ? a.i - b.i : a.t - b.t;
    })
    .map((x) => x.row);
}

/** A receipt row names its DECLARED COMMAND COUNT, and a count of 0 is called what it is. A
 * `declaredCommands: 0` receipt is a real but weak certificate (tier-0 self-protection only)
 * and must never read like a full one — the same rule the session-start hook, `gate run`'s
 * GREEN line and finalize's MR comment already obey. */
function receiptLabel(what, receipt) {
  const n = receipt?.declaredCommands;
  const weak = n === 0 ? ' — TIER-0 ONLY, a real but WEAK certificate' : '';
  return `${what} gate receipt (${n ?? '?'} declared command(s)${weak})`;
}
