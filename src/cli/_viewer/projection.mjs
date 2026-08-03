// projection.mjs — THE single read-only projection the viewer renders (PLAN-V3 decision 12;
// c13 kickoff §Architecture). FeatureSummary / FeatureView DTOs, the ONE viewer-status
// vocabulary, the attention flags, and the ONE statistics formula. No HTTP lives here.
//
// SINGLE-OPERATOR, READ-ONLY, DISPOSABLE. Nothing in this file writes: no manifest, no lock, no
// cache, no database, no file under LEGION_HOME. It reads projects.json and the two manifests of
// each dossier, stats two files for a freshness fact, and returns plain objects. legion works
// identically with the viewer closed or deleted, which is the whole point of decision 12 — so a
// mutation reached from here would not be a bug, it would be the prohibition broken.
//
// IT DERIVES NO LIFECYCLE STATE, AND THAT IS WHY THE VOCABULARY IS SO SMALL. `viewerStatus` is a
// RENDERING of the kernel's own recorded `status` (plus two facts the kernel also recorded: an
// initError, and an unanswered question), never a second opinion about where a feature is.
// THERE IS DELIBERATELY NO 'stalled' AND NO 'running':
//   - "running" would claim a live agent. Nothing in legion3 records one. `currentSession` is the
//     id of the last session that STARTED; no op writes when a session ends, so a manifest can
//     never distinguish a working agent from a closed terminal. Rendering "running" would be a
//     claim the data cannot support.
//   - "stalled" would be a judgment about elapsed time dressed up as a state. Staleness IS
//     rendered — `updatedAt`/`ageHours` are facts read off the two manifests' mtimes — and
//     Operations buckets `quiet` = active ∧ age > QUIET_AFTER_HOURS, labeled exactly that.
// An unrecognized kernel value renders `unknown` and is NEVER coerced to the nearest neighbour
// (VIEWER-REVIEW H02). A feature whose `status` or (while active) whose `stage` is not a value
// this kernel knows is a feature this projection cannot place, and saying so is the answer.
//
// RECORDED IS NOT VALID, EVERYWHERE. `approvals` renders {at, subjectHash} — the facts tasks.json
// stores — and carries APPROVALS_CAVEAT so no client can render an approval without the caveat
// hooks/session-start.mjs already prints. Validity is a HASH COMPARISON the kernel performs at
// the moment of use, so where this file needs it (the informational next-unsatisfied line) it
// CALLS approvalValid/stageSatisfied/unsatisfiedPrefix from src/kernel/state.mjs, live, on this
// request, under `lifecycleNow` — a block named for the fact that it is computed now and stored
// nowhere. Re-implementing any of those three here would be the drift the kernel's own header
// forbids: two definitions of "satisfied" is one definition too many.
//
// A WEAK RECEIPT IS NEVER A FULL ONE. `declaredCommands === 0` is a real but TIER-0-ONLY
// certificate (PLAN-V3 §Gates / R11); every receipt shape below carries `weak` so the UI cannot
// accidentally render it like a full certificate.
//
// ONE CORRUPT DOSSIER NEVER TAKES DOWN THE INVENTORY (VIEWER-REVIEW H06). Every per-feature read
// is individually guarded and becomes an `{unreadable:true, label, why}` row; the surviving
// features render normally. The one thing that DOES die loudly is a corrupt projects.json — it
// is the index of what exists, so "present but unparseable" is UNKNOWN, not "nothing registered"
// (src/kernel/projectindex.mjs draws the same line). An ABSENT projects.json is an ANSWER —
// nothing on this machine is registered — and renders as an empty inventory.
//
// THE ORG BOUNDARY IS DISPLAY-ONLY HERE. scanRegisteredFeatures is org-scoped because the
// initiative id namespace is (src/cli/feature.mjs / T35). `--org` absent means this projection
// enumerates the orgs in the index and scans each: a cross-org READ for display, which decides
// nothing, links nothing and starts nothing. No kernel decision anywhere is taken from it.
//
// ONE STATS FORMULA (VIEWER-REVIEW H01). `insights()` below IS the formula; the client renders
// its numbers verbatim and computes none of its own. Counts and denominators travel WITH every
// statistic, and nothing is smoothed, interpolated or extrapolated: over a dozen features a
// percentile is a position in a tiny sorted list, and saying `n: 3` beside it is the only honest
// way to show one. Cost and tokens are absent because no source for them exists (decision 9) —
// not rendered as zero, not rendered as a placeholder.
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { readJson } from '../../kernel/fsatomic.mjs';
import { featureDir, projectsIndexPath } from '../../kernel/paths.mjs';
// THE KERNEL'S OWN PREDICATES, imported rather than re-implemented (header). STAGES/APPROVAL_CHAIN
// come along for the same reason: the projection must not carry a second copy of the stage order
// or the approval spine.
import {
  APPROVAL_CHAIN, ARTIFACT_KINDS, STAGES, approvalValid, stageSatisfied, unsatisfiedPrefix,
} from '../../kernel/state.mjs';
import { scanRegisteredFeatures } from '../feature.mjs';
import { featureActivity } from './activity.mjs';

// --- the vocabularies (closed sets; the client styles by them) -------------------------------

/** THE viewer status vocabulary, exhaustive. Anything a manifest can say that does not map onto
 * one of the first five is `unknown`; a dossier that cannot be read at all is `unreadable`. */
export const VIEWER_STATUSES = ['delivered', 'abandoned', 'init-failed', 'blocked', 'active', 'unreadable', 'unknown'];

/** The kernel statuses feature.json is written with (src/cli/feature.mjs + `state close`). A value
 * outside this list is a hand-edit or a newer kernel; either way this projection does not know
 * what it means and says `unknown` rather than guessing. */
export const KERNEL_STATUSES = ['active', 'initialization_failed', 'delivered', 'abandoned'];

/** The attention vocabulary, exhaustive — the real actionable queue Operations renders. Nothing
 * here is a judgment: each row is a recorded fact (an unanswered question, a recorded initError,
 * a manifest that would not parse) or an arithmetic fact about mtime. */
export const ATTENTION_KINDS = ['open-question', 'init-failed', 'unreadable-manifest', 'quiet'];

/** Operations' `quiet` bucket: an ACTIVE feature whose two manifests have not been written in
 * this many hours. NAMED, because an unlabelled magic number in a status rule is how "quiet"
 * becomes "stalled" in someone's head three months from now. It is not a state — the feature is
 * still `active`; this is a fact about a file's mtime, rendered as one. */
export const QUIET_AFTER_HOURS = 24;

/** The "recent outcomes" window Operations and Insights both report over. */
export const RECENT_OUTCOME_DAYS = 7;

/** The caveat every approval rendering carries, worded as hooks/session-start.mjs words it (the
 * tone precedent named by the kickoff). Shipped IN the DTO so a client cannot render approvals
 * without it and cannot invent a second wording. */
export const APPROVALS_CAVEAT =
  'recorded != valid — an artifact edit invalidates deterministically; the kernel decides at use '
  + 'time, and its refusal is the answer.';

const MS_PER_HOUR = 3_600_000;

// --- dossier reads, individually guarded (H06) ------------------------------------------------

/** The unreadable ROW — the single shape every failed read becomes. It carries `viewerStatus`
 * and an attention row of its own so the inventory can render it in the same list as a healthy
 * feature without the client re-deriving anything about it. */
const unreadableRow = (key, label, why) => ({
  key, label, unreadable: true, why,
  viewerStatus: 'unreadable',
  attention: [{ kind: 'unreadable-manifest', detail: { why } }],
});

/** Read one manifest, asserting the schema this projection understands. Returns {ok:true, doc},
 * {ok:false, why} — never throws. ABSENT is the caller's question, not this one's: tasks.json is
 * legitimately absent before `legion state init`, while feature.json's absence means the feature
 * does not exist. A schemaVersion this viewer does not know is UNREADABLE rather than rendered
 * optimistically: the kernel itself dies loudly on one (readManifest in kernel/state.mjs), and a
 * viewer that rendered a schema-2 manifest through schema-1 field names would be inventing. */
function readManifest(path) {
  let doc;
  try { doc = readJson(path); } catch (err) { return { ok: false, why: err.message }; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { ok: false, why: `${path} is not a JSON object` };
  }
  if (doc.schemaVersion !== 1) {
    return {
      ok: false,
      why: `${path} declares schemaVersion ${JSON.stringify(doc.schemaVersion ?? null)} — this viewer `
        + 'projects schemaVersion 1 only, and rendering an unknown schema through known field names '
        + 'would be invention',
    };
  }
  return { ok: true, doc };
}

/** Both manifests of one dossier. `{ok:true, dossier, feature, tasks}` where `tasks` is null when
 * tasks.json does not exist yet (the ordinary pre-plan stage), or `{ok:false, why}`. */
function loadDossier(org, project, name) {
  let dossier;
  try { dossier = featureDir(org, project, name); }
  catch (err) { return { ok: false, why: err.message }; } // unsafe identity segment: fail closed
  const fPath = join(dossier, 'feature.json');
  if (!existsSync(fPath)) return { ok: false, why: `no feature.json at ${fPath}`, missing: true };
  const f = readManifest(fPath);
  if (!f.ok) return f;
  const tPath = join(dossier, 'tasks.json');
  if (!existsSync(tPath)) return { ok: true, dossier, feature: f.doc, tasks: null };
  const t = readManifest(tPath);
  if (!t.ok) return t;
  return { ok: true, dossier, feature: f.doc, tasks: t.doc };
}

/** THE freshness fact, and the ONE place an mtime is read: the newest write of either manifest.
 * It is a FACT ABOUT FILES, not a lifecycle claim — every "no manifest write in Nh" rendering and
 * the `quiet` bucket both descend from this number and nothing else. null when neither file can
 * be stat'd (the manifest was read moments ago, so this is close to impossible — and null renders
 * as Unknown rather than as "now"). */
function manifestMtimeMs(dossier) {
  let newest = null;
  for (const f of ['feature.json', 'tasks.json']) {
    try {
      const s = statSync(join(dossier, f));
      if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
    } catch { /* absent tasks.json is ordinary; an unstattable file simply does not vote */ }
  }
  return newest;
}

// --- the status vocabulary + attention flags --------------------------------------------------

/** THE viewer status rule, in ONE place, in this order — and the order is the argument:
 *   1. a status this kernel never writes ⇒ `unknown`. Never coerced (H02).
 *   2. closed states win over everything. A delivered feature's old initError is history, and a
 *      closed feature has no open questions worth an operator's attention.
 *   3. `initialization_failed`, or an active feature still carrying an initError, ⇒ `init-failed`.
 *      Both spellings exist: `feature start` writes the status on a failed bootstrap, and
 *      `--repair` writes the error back onto the record while leaving the status where it was.
 *   4. an active feature whose STAGE is not a stage this kernel knows ⇒ `unknown`. It is still
 *      inside the lifecycle and this projection cannot place it, so it says so instead of
 *      rendering a green `active` over a manifest it does not understand.
 *   5. active ∧ an unanswered question ⇒ `blocked` — the question protocol's blocked-as-data
 *      (PLAN-V3 decision 11), which is a RECORDED fact, not an inference about an agent.
 *   6. otherwise `active`.
 * `quiet` is deliberately NOT here: it is an attention flag over an `active` feature, not a state. */
function viewerStatusOf(feature, openQuestionCount) {
  const status = feature?.status;
  if (!KERNEL_STATUSES.includes(status)) return 'unknown';
  if (status === 'delivered') return 'delivered';
  if (status === 'abandoned') return 'abandoned';
  if (status === 'initialization_failed') return 'init-failed';
  if (typeof feature.initError === 'string' && feature.initError.length > 0) return 'init-failed';
  if (!STAGES.includes(feature.stage)) return 'unknown';
  if (openQuestionCount > 0) return 'blocked';
  return 'active';
}

/** Every unanswered question in the plan: `{count, taskIds}`. `answer == null` is the open
 * question — the same predicate hooks/session-start.mjs uses, and `== null` not falsiness because
 * an intentionally empty answer is legitimate content the kernel stores verbatim (task-answer's
 * docblock). `count` counts ENTRIES (one task may hold several); `taskIds` are distinct, in plan
 * order, and are what makes this queue actionable rather than a number. */
function openQuestionsOf(tasks) {
  let count = 0;
  const taskIds = [];
  for (const t of tasks?.tasks ?? []) {
    let has = false;
    for (const a of t?.answers ?? []) if (a?.answer == null) { count += 1; has = true; }
    if (has) taskIds.push(t?.id);
  }
  return { count, taskIds };
}

/** Task counts by exclusion, never by enumerating statuses: the kernel's own build row does the
 * same ("a blocked or pending task is an unfinished build"), so a status this projection has not
 * heard of lands in `pending` rather than vanishing from the totals. */
function taskCounts(tasks, openQuestions) {
  const list = tasks?.tasks ?? [];
  const done = list.filter((t) => t?.status === 'done').length;
  const started = list.filter((t) => t?.status === 'started').length;
  return { total: list.length, done, started, pending: list.length - done - started, openQuestions };
}

// --- FeatureSummary ---------------------------------------------------------------------------

/** The summary shape, from an ALREADY-READ pair of manifests. Reads exactly one thing off the
 * filesystem itself (the mtimes) and spawns nothing — /api/features is a 5-second poll, and a
 * `git` per feature per poll is how a read-only viewer becomes a load source. */
function summaryCore({ org, project, name, dossier, feature, tasks, now }) {
  const key = `${org}/${project}/${name}`;
  const openQuestions = openQuestionsOf(tasks);
  const viewerStatus = viewerStatusOf(feature, openQuestions.count);
  const mtimeMs = manifestMtimeMs(dossier);
  const ageHours = mtimeMs === null ? null : (now - mtimeMs) / MS_PER_HOUR;

  const attention = [];
  if (openQuestions.count > 0) {
    attention.push({ kind: 'open-question', detail: { count: openQuestions.count, taskIds: openQuestions.taskIds } });
  }
  if (viewerStatus === 'init-failed') {
    attention.push({ kind: 'init-failed', detail: { message: feature.initError ?? null, status: feature.status } });
  }
  // QUIET IS AN ATTENTION FLAG OVER `active`, AND ONLY `active`. A blocked feature already has the
  // open-question row — the actionable one — and a closed feature's manifests are supposed to stop
  // moving. The number is a subtraction over two mtimes; it is never called stalled.
  if (viewerStatus === 'active' && ageHours !== null && ageHours > QUIET_AFTER_HOURS) {
    attention.push({ kind: 'quiet', detail: { ageHours, sinceHours: QUIET_AFTER_HOURS, updatedAt: isoOrNull(mtimeMs) } });
  }

  return {
    key,
    org,
    project,
    name,
    featureId: feature.featureId ?? null,
    viewerStatus,
    kernelStatus: feature.status ?? null, // VERBATIM — the client shows what the manifest says
    stage: feature.stage ?? null,         // VERBATIM; `stageKnown` says whether we could place it
    stageKnown: STAGES.includes(feature.stage),
    profile: feature.profile ?? null,
    branch: feature.branch ?? null,
    baseBranch: feature.baseBranch ?? null,
    baseSha: feature.baseSha ?? null,
    updatedAt: isoOrNull(mtimeMs),
    ageHours,
    createdAt: feature.createdAt ?? null,
    closedAt: feature.closedAt ?? null,
    ticket: feature.ticket ?? null,
    // The initiative block VERBATIM when present; absent is the ordinary single-repo case and
    // renders nothing (kernel/state.mjs: "no reader may treat that as an error").
    initiative: feature.initiative ?? null,
    mr: feature.mr ?? null,
    tasks: taskCounts(tasks, openQuestions.count),
    hasPlan: tasks !== null,
    attention,
  };
}

const isoOrNull = (ms) => (ms === null ? null : new Date(ms).toISOString());

/** The org list to scan. `org` given ⇒ exactly that one. Absent ⇒ every org named in the index
 * (the display-only cross-org read, header). An index ENTRY WITH NO USABLE ORG is not dropped:
 * scanRegisteredFeatures deliberately lets it fall through to featureDir(), which refuses to
 * compose it, so it surfaces as an unreadable row — but only if some scan actually visits it.
 * Every scan visits it, because the org filter is only applied to entries that HAVE an org; so
 * one pass is enough, and the sole edge case is an index whose entries ALL lack an org, where
 * there is no real org to pass. PROBE_ORG covers exactly that: with no placeable entry in the
 * index the value is compared against nothing, and every entry falls through to the fail-closed
 * path. It is never matched against real data. */
const PROBE_ORG = '_viewer_probe';

function orgsToScan(org, index) {
  if (org != null) return [org];
  const projects = Array.isArray(index?.projects) ? index.projects : [];
  const placeable = [...new Set(projects
    .filter((p) => typeof p?.org === 'string' && p.org.length > 0)
    .map((p) => p.org))];
  if (placeable.length > 0) return placeable;
  return projects.length > 0 ? [PROBE_ORG] : [];
}

/** Read every registered feature of `org` (or of every org) into records the three public
 * entry points below share. Returns {records, unreadable} — records carry the parsed manifests
 * as well as the summary, because insights() needs the manifests and re-reading every dossier a
 * second time to compute them would double the IO of the one expensive endpoint.
 * DE-DUPLICATED BY KEY: an entry with no usable org is visited by every org pass, so without this
 * it would produce one unreadable row per org in the index. */
function collect({ org = null, now = Date.now() } = {}) {
  const indexPath = projectsIndexPath();
  // ABSENT IS AN ANSWER (header): nothing on this machine is registered. A CORRUPT index is
  // UNKNOWN and dies loudly here, exactly as it does for scanRegisteredFeatures and the two
  // remote-safety guards — "present but unparseable" must never render as "nothing exists".
  if (!existsSync(indexPath)) return { records: [], unreadable: [], indexPath, orgs: [] };
  const index = readJson(indexPath);

  const records = new Map();
  const unreadable = new Map();
  const orgs = orgsToScan(org, index);
  for (const o of orgs) {
    const scan = scanRegisteredFeatures({ org: o });
    for (const u of scan.unreadable) {
      if (!unreadable.has(u.label)) unreadable.set(u.label, unreadableRow(u.label, u.label, u.why));
    }
    for (const row of scan.rows) {
      const key = `${row.org}/${row.project}/${row.name}`;
      if (records.has(key) || unreadable.has(key)) continue;
      const d = loadDossier(row.org, row.project, row.name);
      if (!d.ok) { unreadable.set(key, unreadableRow(key, row.label, d.why)); continue; }
      records.set(key, {
        key,
        org: row.org,
        project: row.project,
        name: row.name,
        dossier: d.dossier,
        feature: d.feature,
        tasks: d.tasks,
        summary: summaryCore({
          org: row.org, project: row.project, name: row.name,
          dossier: d.dossier, feature: d.feature, tasks: d.tasks, now,
        }),
      });
    }
  }
  return { records: [...records.values()], unreadable: [...unreadable.values()], indexPath, orgs };
}

/**
 * `/api/features` — the inventory. `{summaries, unreadable, population}`.
 * ONE CORRUPT DOSSIER IS ONE ROW (H06): it never throws, never truncates the list, and the
 * surviving features are unaffected. No git, no kernel predicate, no spawn: this is the 5-second
 * poll, and its cost has to stay two file reads and two stats per feature.
 */
export function featureSummaries({ org = null, now = Date.now() } = {}) {
  const { records, unreadable } = collect({ org, now });
  const summaries = records.map((r) => r.summary);
  return {
    summaries,
    unreadable,
    population: { features: summaries.length + unreadable.length, readable: summaries.length, unreadable: unreadable.length },
  };
}

// --- FeatureView -------------------------------------------------------------------------------

/**
 * `/api/feature` — one feature in full. FeatureSummary + the spine, the two-level milestone
 * grouping, per-task detail, artifacts, RECORDED approvals, reviews, the boundary receipt with
 * its weak flag, the derived activity feed, and the live kernel verdicts under `lifecycleNow`.
 *
 * A feature that DOES NOT EXIST throws — that is a caller error (a bad org/project/name), and the
 * server turns it into a 404. A feature that exists but cannot be READ returns the unreadable row
 * instead: same shape the inventory uses, so the detail view renders the honest "this dossier is
 * broken, here is why" page rather than an error boundary (H02/H06).
 *
 * `commits` is INJECTED (the server reads git through the hardened seam and passes the result);
 * this module spawns nothing. Absent ⇒ the activity feed is manifest-only.
 *
 * `readCommits` IS THE SAME INJECTION, ONE STEP EARLIER, and it exists because of a genuine
 * ordering problem the array form cannot solve: the git range lives in the manifest
 * (`worktree` + `baseSha`), so a caller that wants commits must read the dossier to learn WHERE
 * to read git, and this function is the thing that reads the dossier. The array form forces the
 * caller to read both manifests a second time (or to overwrite the `git` block afterwards with a
 * verdict this function already claimed). So the server may instead hand in a CALLBACK — invoked
 * once, with the recorded {worktree, baseSha, branch} — returning the seam's own typed result
 * `{available, reason?, commits}`. THIS MODULE STILL SPAWNS NOTHING: the callback is the server's
 * hardened-seam read, and `git` below is its verdict verbatim, so a pruned worktree renders the
 * real reason instead of the generic "no commits were supplied" one. The array form is unchanged.
 */
export function featureView({ org, project, name, now = Date.now(), commits = [], readCommits = null } = {}) {
  const key = `${org}/${project}/${name}`;
  const d = loadDossier(org, project, name);
  if (!d.ok && d.missing) throw new Error(`no such feature '${key}' — ${d.why}`);
  if (!d.ok) return unreadableRow(key, key, d.why);
  const { dossier, feature, tasks } = d;
  const summary = summaryCore({ org, project, name, dossier, feature, tasks, now });

  // THE GIT BLOCK, from whichever injection the caller used (docblock). Nothing here spawns.
  let rows = commits;
  let gitBlock = commits.length > 0
    ? { available: true }
    : { available: false, reason: 'no commits were read for this view (the projection never spawns git; the server supplies them)' };
  if (typeof readCommits === 'function') {
    const r = readCommits({
      worktree: feature.worktree ?? null, baseSha: feature.baseSha ?? null, branch: feature.branch ?? null,
    });
    rows = Array.isArray(r?.commits) ? r.commits : [];
    gitBlock = r?.available === true
      ? { available: true, ...(r.head == null ? {} : { head: r.head }) }
      // A callback that returned nothing usable is NOT rendered as "no commits": that would be a
      // guess about git dressed as a fact (H02). It says the seam gave no verdict.
      : { available: false, reason: r?.reason ?? 'the git seam returned no verdict for this feature' };
  }

  return {
    ...summary,
    dossier,
    // WORKTREE PRESENCE IS AN FS FACT, nothing more: the path feature.json recorded, and whether
    // something is there right now. `legion feature clean` removes worktrees of delivered
    // features, so absence is ordinary and is never rendered as an error.
    worktree: { path: feature.worktree ?? null, present: typeof feature.worktree === 'string' && existsSync(feature.worktree) },
    repoRoot: feature.repoRoot ?? null,
    // The AUDIT TRAIL, verbatim. The kernel writes these and consults them as authority nowhere
    // (kernel/state.mjs THE STAGE MACHINE) — and neither does this projection: `lifecycleNow`
    // below re-derives, it does not read a completion flag out of these arrays.
    stageHistory: feature.stageHistory ?? [],
    completedStages: feature.completedStages ?? [],
    // RECORDED session facts. `current` is the id of the last session the SessionStart hook
    // recorded; no op records an END, so this is never presence and must never be rendered as
    // "live" (kickoff: VF12 dropped, session facts fold in here as recorded facts).
    sessions: { current: feature.currentSession ?? null, history: feature.sessionHistory ?? [] },
    intakeRepos: feature.intakeRepos ?? [],
    milestones: milestonesOf(tasks),
    tasksDetail: tasksDetailOf(tasks),
    artifacts: artifactsOf(tasks, dossier),
    approvals: approvalsOf(tasks),
    approvalsCaveat: APPROVALS_CAVEAT,
    reviews: (tasks?.reviews ?? []).map((r) => ({
      role: r?.role ?? null, verdict: r?.verdict ?? null, subject: r?.subject ?? null, at: r?.at ?? null,
    })),
    boundaryReceipt: receiptShape(tasks?.receipts?.boundary),
    commandPolicyHash: feature.commandPolicyHash ?? null,
    commandPolicy: feature.commandPolicy ?? null,
    commandPolicyHistory: feature.commandPolicyHistory ?? [],
    activity: featureActivity({ feature, tasks, commits: rows }),
    lifecycleNow: lifecycleNow(feature, tasks),
    // `available:false` says the projection did not read git, and why — never a guessed commit
    // list. The SERVER fills this in when it has read commits through the seam.
    git: gitBlock,
  };
}

/** THE TWO-LEVEL PROGRESS: milestone → its tasks → its close reviews. Grouping is derived from
 * `tasks[].milestone` in PLAN ORDER (first appearance), never from a stored milestone list —
 * there is no such list, and inventing one would be a stored conclusion. Tasks with no milestone
 * group under `id: null`, which renders as "(no milestone)" rather than being hidden. Close
 * reviews are the reviews whose subject is exactly `milestone:<id>` — the scope the kernel's own
 * profile check accepts for feature-level sign-off. */
function milestonesOf(tasks) {
  const order = [];
  const byId = new Map();
  for (const t of tasks?.tasks ?? []) {
    const id = t?.milestone ?? null;
    if (!byId.has(id)) { byId.set(id, []); order.push(id); }
    byId.get(id).push(t);
  }
  const reviews = tasks?.reviews ?? [];
  return order.map((id) => {
    const list = byId.get(id);
    const done = list.filter((t) => t?.status === 'done').length;
    const started = list.filter((t) => t?.status === 'started').length;
    return {
      id,
      taskIds: list.map((t) => t?.id ?? null),
      tasks: { total: list.length, done, started, pending: list.length - done - started },
      closeReviews: reviews
        .filter((r) => r?.subject === `milestone:${id}`)
        .map((r) => ({ role: r?.role ?? null, verdict: r?.verdict ?? null, at: r?.at ?? null })),
    };
  });
}

/** Per-task detail. `answers` carries the Q&A verbatim — `answer: null` IS the open question and
 * the client renders it as one. The receipt is reduced to {present, declaredCommands, weak, ...}
 * rather than shipped whole: results[] can be large, and the only questions a reader asks of it
 * here are "did a gate run" and "was it a full certificate or a tier-0 one". */
function tasksDetailOf(tasks) {
  return (tasks?.tasks ?? []).map((t) => ({
    id: t?.id ?? null,
    title: t?.title ?? null,
    status: t?.status ?? null,
    attempt: t?.attempt ?? null,
    milestone: t?.milestone ?? null,
    depends_on: t?.depends_on ?? [],
    startedAt: t?.startedAt ?? null,
    doneAt: t?.doneAt ?? null,
    answers: (t?.answers ?? []).map((a) => ({ question: a?.question ?? null, answer: a?.answer ?? null, at: a?.at ?? null })),
    receipt: receiptShape(t?.receipt),
  }));
}

/** THE receipt rendering, one definition for the task tier and the boundary tier. `weak` is
 * `declaredCommands === 0` — a real but WEAK certificate, tier-0 self-protection only (PLAN-V3
 * §Gates / R11) — and it is a STRICT triple-equals so that a missing/garbage count can never
 * silently read as weak:false, i.e. as a full certificate. An ABSENT receipt is `present:false`
 * with `weak:false`: nothing was certified at all, which is a different (and louder) statement
 * than "certified weakly", and the UI must not conflate them. */
function receiptShape(receipt) {
  if (receipt == null || typeof receipt !== 'object') {
    return { present: false, declaredCommands: null, weak: false, tier: null, head: null, treeHash: null, at: null };
  }
  const declaredCommands = typeof receipt.declaredCommands === 'number' ? receipt.declaredCommands : null;
  return {
    present: true,
    declaredCommands,
    weak: declaredCommands === 0,
    tier: receipt.tier ?? null,
    head: receipt.head ?? null,
    treeHash: receipt.treeHash ?? null,
    at: receipt.at ?? null,
    // Presence alone is the audit signal downstream renders (receiptProvenance's docblock).
    repinnedFrom: receipt.repinnedFrom ?? null,
    allowConfig: receipt.allowConfig === true,
  };
}

/** Best-effort realpath, the same spelling kernel/projectindex.mjs uses and for the same reason:
 * a recorded path that no longer exists compares verbatim rather than throwing. */
const realish = (p) => { try { return realpathSync(String(p)); } catch { return String(p); } };

/** Artifacts, with DOSSIER-RELATIVE paths — that is what `/api/artifact` accepts, and handing the
 * client an absolute path it must then convert is how a traversal bug gets invented on the far
 * side of a guard. `artifact-record` stores an absolute REALPATH and does NOT require it to live
 * in the dossier, so `inside` says which case this is: outside artifacts keep their absolute path
 * and are NOT servable by /api/artifact, and the client renders them as a path rather than a link.
 * BOTH SPELLINGS OF THE DOSSIER ARE TRIED, and that is not defensive padding: LEGION_HOME is
 * whatever the operator exported, while the recorded path went through realpathSync — and on
 * macOS /tmp is a symlink to /private/tmp, so the composed dossier and the recorded artifact
 * disagree character-for-character while naming the same file. Comparing one spelling only would
 * mark every artifact of such a home `inside: false` and quietly stop serving it. Nothing is
 * guessed and nothing is rewritten: the FIRST containment that holds wins, and if neither does,
 * the absolute path is rendered as-is. */
function artifactsOf(tasks, dossier) {
  const roots = [...new Set([dossier, realish(dossier)])];
  const out = {};
  // Lifecycle order, the kernel's own (ARTIFACT_KINDS) — recorded order is write order, which is
  // meaningless to a reader; unknown kinds append after, verbatim. The client renders this order
  // and holds no kind list of its own (frontend contract: no second vocabulary).
  const recorded = Object.entries(tasks?.artifacts ?? {});
  const ordered = [
    ...ARTIFACT_KINDS.map((k) => recorded.find(([kind]) => kind === k)).filter(Boolean),
    ...recorded.filter(([kind]) => !ARTIFACT_KINDS.includes(kind)),
  ];
  for (const [kind, a] of ordered) {
    const abs = typeof a?.path === 'string' ? a.path : null;
    let rel = null;
    for (const root of roots) {
      if (abs === null) break;
      const candidate = relative(root, abs);
      if (candidate.length > 0 && !candidate.startsWith(`..${sep}`) && candidate !== '..' && !isAbsolute(candidate)) {
        rel = candidate;
        break;
      }
    }
    out[kind] = { path: rel ?? abs, inside: rel !== null, hash: a?.hash ?? null, at: a?.at ?? null };
  }
  return out;
}

/** Approvals, RECORDED. `{at, subjectHash}` and nothing else — deliberately no `valid` key: a
 * stored approval is a fact about a hash at a moment, and whether it still binds is a comparison
 * the kernel performs at the moment of use. The live answer travels in `lifecycleNow`, where its
 * name says it was computed now. */
function approvalsOf(tasks) {
  const out = {};
  for (const [kind, a] of Object.entries(tasks?.approvals ?? {})) {
    out[kind] = { at: a?.at ?? null, subjectHash: a?.subjectHash ?? null };
  }
  return out;
}

/**
 * THE KERNEL'S OWN VERDICTS, COMPUTED NOW — the informational "next unsatisfied: X" line, plus
 * which approvals still bind. Every value here comes from CALLING stageSatisfied /
 * unsatisfiedPrefix / approvalValid (src/kernel/state.mjs); this file re-implements none of them,
 * which is the point of importing them at all. It is stored nowhere and cached nowhere: the block
 * is recomputed on every request, exactly like the kernel recomputes it at every gate.
 *
 * `available:false` is the honest outcome whenever the predicates cannot be asked — no tasks.json
 * (the plan has not been imported, so there is nothing for them to read) or a stage this kernel
 * does not know (stageSatisfied throws on one, by design). Rendering a green "satisfied" in
 * either case would be exactly the guess H02 forbids.
 *
 * These predicates DO read live evidence: approvalValid re-hashes artifacts, and the review row
 * derives the worktree tree through the kernel's hardened git seam. That is deliberate and is
 * why this block exists only in the DETAIL view — never in the inventory poll.
 */
function lifecycleNow(feature, tasks) {
  if (tasks === null) {
    return {
      available: false,
      why: 'tasks.json does not exist yet — the plan has not been imported, so the kernel\'s stage predicates have nothing to read',
    };
  }
  if (!STAGES.includes(feature?.stage)) {
    return {
      available: false,
      why: `stage ${JSON.stringify(feature?.stage ?? null)} is not a stage this kernel knows (${STAGES.join(', ')}) — the manifest has been hand-edited`,
    };
  }
  try {
    const satisfied = stageSatisfied(feature.stage, tasks, feature);
    const next = unsatisfiedPrefix(feature.stage, tasks, feature);
    const approvalsValidNow = Object.fromEntries(
      APPROVAL_CHAIN.map((kind) => [kind, approvalValid(kind, tasks, feature)]),
    );
    return {
      available: true,
      stage: feature.stage,
      satisfied: satisfied.ok,
      why: satisfied.ok ? null : satisfied.why,
      nextUnsatisfied: next, // {stage, why} or null — the kernel's own words, verbatim
      approvalsValidNow,
    };
  } catch (err) {
    return { available: false, why: `the kernel's stage predicates could not be re-derived: ${err.message}` };
  }
}

// --- initiative grouping (derived by scan, never stored) ---------------------------------------

/**
 * Sibling groups, DERIVED at read time by scanning summaries that share an `initiative.id`
 * WITHIN one org — the same posture and the same boundary as initiativeStatusLines in
 * src/cli/feature.mjs (T35): siblings live in other repositories but never in another org, and
 * there is no stored siblings[] anywhere, by design (a stored list is the stored conclusion the
 * kernel's design exists to kill).
 * IT NAMES WHAT IT COULD NOT READ. The unreadable rows are carried through untouched, because a
 * dossier that would not parse might have been a sibling, and silently omitting it would render
 * a group that looks complete and is not.
 * Pure: it takes the summaries it is given and reads nothing.
 */
export function groupByInitiative(summaries = [], unreadable = []) {
  const groups = new Map();
  const ungrouped = [];
  for (const s of summaries) {
    const id = s?.initiative?.id;
    if (typeof id !== 'string' || id.length === 0) { ungrouped.push(s.key); continue; }
    const gk = `${s.org} ${id}`; // ORG-SCOPED: two orgs may legitimately use the same id
    if (!groups.has(gk)) groups.set(gk, { id, org: s.org, members: [], primary: null });
    const g = groups.get(gk);
    g.members.push({ key: s.key, featureId: s.featureId, role: s.initiative.role ?? null, viewerStatus: s.viewerStatus });
    if (s.initiative.role === 'primary') g.primary = s.key;
    else if (g.primary === null && typeof s.initiative.primary === 'string') g.primary = s.initiative.primary;
  }
  return { groups: [...groups.values()], ungrouped, unreadable: unreadable.map((u) => ({ key: u.key, label: u.label, why: u.why })) };
}

// --- the cross-feature activity feed (Operations) ------------------------------------------------

/** The default page of `/api/activity`. A cap exists because the feed is unbounded in principle
 * (every recorded timestamp of every feature on the machine) and a poll that grows without limit
 * is how a read-only viewer becomes a load source. */
export const ACTIVITY_FEED_LIMIT = 200;

/**
 * `/api/activity` — the CROSS-FEATURE feed, MANIFEST-ONLY (kickoff §Activity + freshness). It is
 * activity.mjs's per-feature fold run over every readable feature and merged; each row carries the
 * feature it came from, so Operations can render "which feature" without a second lookup.
 *
 * NO GIT, deliberately: this is the cheap global poll, and a `git log` per feature per poll is the
 * load source the detail view is allowed to be and this endpoint is not. Commit rows exist only in
 * the DETAIL view, which is exactly where the kickoff puts them.
 *
 * NEWEST FIRST — the one place this projection reverses activity.mjs's chronological order, and
 * the reason is `limit`: a truncated ascending feed would return the OLDEST N rows, i.e. the page
 * nobody asked for. `total`/`truncated` travel with it so a truncated feed can never read like a
 * complete one. Undated rows sort last in insertion order, exactly as in the per-feature fold.
 * Unreadable dossiers are carried, not dropped (H06): a feed that silently omitted a broken
 * feature would look like a feature with nothing happening.
 */
export function activityFeed({ org = null, limit = ACTIVITY_FEED_LIMIT, now = Date.now() } = {}) {
  const { records, unreadable } = collect({ org, now });
  const rows = [];
  for (const r of records) {
    for (const row of featureActivity({ feature: r.feature, tasks: r.tasks })) {
      rows.push({ ...row, key: r.key, org: r.org, project: r.project, name: r.name });
    }
  }
  const n = Number.isFinite(limit) && limit >= 0 ? Math.trunc(limit) : ACTIVITY_FEED_LIMIT;
  const sorted = rows
    .map((row, i) => ({ row, i, t: ms(row.at) }))
    .sort((a, b) => {
      if (a.t === null && b.t === null) return a.i - b.i;
      if (a.t === null) return 1;
      if (b.t === null) return -1;
      return a.t === b.t ? a.i - b.i : b.t - a.t;
    })
    .map((x) => x.row);
  return {
    rows: sorted.slice(0, n),
    total: sorted.length,
    limit: n,
    truncated: sorted.length > n,
    unreadable,
    population: { features: records.length + unreadable.length, readable: records.length, unreadable: unreadable.length, org: org ?? null },
  };
}

// --- insights: THE one stats formula (H01) ------------------------------------------------------

/** NEAREST-RANK percentile over an ascending list, defined here once and used for every
 * percentile this module reports. NO INTERPOLATION AND NO SMOOTHING: with n=3 the "p90" is simply
 * the largest of three numbers, and pretending otherwise by interpolating would manufacture a
 * value no feature ever had. Every reported percentile ships beside its own `n` so the reader can
 * see that (VIEWER-REVIEW H01 / kickoff "render counts, no smoothing"). */
function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return null;
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, rank - 1))];
}

/** {n, p50, p90, min, max} over a list of durations in ms. n IS the denominator and travels with
 * the numbers, always — a percentile without its population is the kind of number VIEWER-REVIEW
 * H01 was written about. */
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50Ms: percentile(sorted, 50),
    p90Ms: percentile(sorted, 90),
    minMs: sorted.length > 0 ? sorted[0] : null,
    maxMs: sorted.length > 0 ? sorted[sorted.length - 1] : null,
  };
}

const ms = (at) => {
  const t = Date.parse(at ?? '');
  return Number.isNaN(t) ? null : t;
};

/**
 * `/api/insights` — THE statistics formula, and the only one in this codebase (H01). The client
 * renders these numbers verbatim and computes nothing of its own; a second formula on the client
 * is the defect this design was written to prevent.
 *
 * WHAT IS COMPUTED, and out of which recorded field:
 *   outcomes            counts of viewerStatus over the whole population, unreadable included.
 *   recentOutcomes      delivered/abandoned whose closedAt falls inside RECENT_OUTCOME_DAYS.
 *   featureDuration     first stageHistory[].at → (closedAt ?? mr.at). Features missing either end
 *                       are EXCLUDED AND COUNTED, by reason, so the denominator is never silently
 *                       smaller than the population.
 *   stageDuration       consecutive stageHistory deltas, attributed to the stage being LEFT. A
 *                       backward re-entry produces a second interval for that stage; both count,
 *                       because both happened. The CURRENT stage has no closing timestamp and is
 *                       therefore not measured — an open interval is not a duration.
 *   attempts            histogram of tasks[].attempt across every readable feature.
 *   reviewRounds        fail → re-judged transitions per (role, subject): a `fail` followed by any
 *                       later verdict for the same key is one round; a `fail` with nothing after
 *                       it is UNRESOLVED and is reported separately rather than folded in.
 * COST AND TOKENS ARE ABSENT because nothing records them (PLAN-V3 decision 9). They are not
 * rendered as zero and not rendered as a placeholder: being honest means not rendering them.
 */
export function insights({ org = null, now = Date.now() } = {}) {
  const { records, unreadable } = collect({ org, now });

  const outcomes = Object.fromEntries(VIEWER_STATUSES.map((s) => [s, 0]));
  for (const r of records) outcomes[r.summary.viewerStatus] += 1;
  outcomes.unreadable += unreadable.length;

  const recentCutoff = now - RECENT_OUTCOME_DAYS * 24 * MS_PER_HOUR;
  const recent = { windowDays: RECENT_OUTCOME_DAYS, delivered: 0, abandoned: 0, features: [] };

  const durations = [];
  const excluded = { noStart: 0, noEnd: 0, negative: 0 };
  const stageDurations = new Map();
  const attempts = new Map();
  let taskRows = 0;
  const reviewRounds = { features: 0, reviews: 0, fixRounds: 0, unresolvedFails: 0, byFeature: [] };

  for (const r of records) {
    const { feature, tasks, summary } = r;

    // --- recent outcomes -------------------------------------------------------------------
    const closedMs = ms(feature.closedAt);
    if ((summary.viewerStatus === 'delivered' || summary.viewerStatus === 'abandoned')
        && closedMs !== null && closedMs >= recentCutoff) {
      recent[summary.viewerStatus] += 1;
      recent.features.push(r.key);
    }

    // --- feature duration ------------------------------------------------------------------
    const history = Array.isArray(feature.stageHistory) ? feature.stageHistory : [];
    const startMs = history.length > 0 ? ms(history[0]?.at) : null;
    const endMs = closedMs ?? ms(feature.mr?.at);
    if (startMs === null) excluded.noStart += 1;
    else if (endMs === null) excluded.noEnd += 1;
    else if (endMs < startMs) excluded.negative += 1; // hand-edited timestamps; counted, never clamped
    else durations.push(endMs - startMs);

    // --- per-stage durations ---------------------------------------------------------------
    for (let i = 0; i + 1 < history.length; i += 1) {
      const a = ms(history[i]?.at);
      const b = ms(history[i + 1]?.at);
      const stage = history[i]?.stage;
      if (a === null || b === null || b < a || typeof stage !== 'string') continue;
      if (!stageDurations.has(stage)) stageDurations.set(stage, []);
      stageDurations.get(stage).push(b - a);
    }

    // --- attempts ---------------------------------------------------------------------------
    for (const t of tasks?.tasks ?? []) {
      taskRows += 1;
      const key = Number.isInteger(t?.attempt) ? String(t.attempt) : 'unknown';
      attempts.set(key, (attempts.get(key) ?? 0) + 1);
    }

    // --- review fail → pass rounds -----------------------------------------------------------
    const reviews = tasks?.reviews ?? [];
    if (reviews.length > 0) {
      reviewRounds.features += 1;
      reviewRounds.reviews += reviews.length;
      const byKey = new Map();
      for (const rev of reviews) {
        const k = `${rev?.role} ${rev?.subject}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(rev?.verdict);
      }
      let fixRounds = 0;
      let unresolved = 0;
      for (const verdicts of byKey.values()) {
        for (let i = 0; i < verdicts.length; i += 1) {
          if (verdicts[i] !== 'fail') continue;
          if (i + 1 < verdicts.length) fixRounds += 1; else unresolved += 1;
        }
      }
      reviewRounds.fixRounds += fixRounds;
      reviewRounds.unresolvedFails += unresolved;
      reviewRounds.byFeature.push({ key: r.key, reviews: reviews.length, fixRounds, unresolvedFails: unresolved });
    }
  }

  return {
    // THE DENOMINATORS, first and unconditional. Every number below is over this population.
    population: {
      features: records.length + unreadable.length,
      readable: records.length,
      unreadable: unreadable.length,
      org: org ?? null,
      tasks: taskRows,
    },
    outcomes,
    recentOutcomes: recent,
    featureDuration: { ...stats(durations), excluded },
    stageDuration: Object.fromEntries(
      [...stageDurations.entries()]
        .sort((a, b) => sortStages(a[0], b[0]))
        .map(([stage, values]) => [stage, stats(values)]),
    ),
    attempts: {
      tasks: taskRows,
      features: records.length,
      distribution: Object.fromEntries([...attempts.entries()].sort(sortAttemptKeys)),
    },
    reviewRounds,
  };
}

/** STAGES order first (it is the lifecycle order, which is what a reader expects), then any
 * stage name this kernel does not know, alphabetically — never dropped, because a hand-edited
 * stage that produced real durations is still a fact. */
function sortStages(a, b) {
  const ia = STAGES.indexOf(a);
  const ib = STAGES.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Numeric attempt keys ascending, with the `unknown` bucket last. */
function sortAttemptKeys(a, b) {
  if (a[0] === 'unknown') return 1;
  if (b[0] === 'unknown') return -1;
  return Number(a[0]) - Number(b[0]);
}
