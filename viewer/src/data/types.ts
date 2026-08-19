// types.ts — the client's mirror of the SERVER's DTOs. `src/cli/_viewer/projection.mjs` is the
// contract; this file re-states its shapes in TypeScript and states NOTHING ELSE.
//
// THE CLIENT RE-DERIVES NOTHING, AND THE TYPES ARE HOW THAT IS ENFORCED. There is no client-side
// status rule here, no attention rule, no staleness rule and no statistic — the only client-owned
// values below are the LABEL and the COLOUR CLASS for each member of the server's closed enums.
// A `RunView` with 57 fields and a client that computed half of them was legion2's shape; the
// legion3 port exists partly to delete it. If a value is not in this file, the server did not
// record it, and the answer is to render Unknown (VIEWER-REVIEW H02) rather than to compute one.
//
// THE ENUMS ARE THE SERVER'S. VIEWER_STATUSES / ATTENTION_KINDS / ACTIVITY_KINDS are declared in
// projection.mjs and activity.mjs as exported constants; the lists below are their transcriptions,
// and test/viewer/dto-contract.test.mjs pins the two against each other so a kernel-side change
// cannot silently leave a client member unlabelled.

// --- the status vocabulary (projection.mjs VIEWER_STATUSES) -----------------------------------

export type ViewerStatus =
  | 'delivered' | 'abandoned' | 'init-failed' | 'blocked' | 'active' | 'unreadable' | 'unknown';

export const VIEWER_STATUSES: ViewerStatus[] =
  ['delivered', 'abandoned', 'init-failed', 'blocked', 'active', 'unreadable', 'unknown'];

/** Rendered verbatim. `blocked` says WHY it is blocked because the projection's rule has exactly
 * one cause (an unanswered question) and a bare "Blocked" reads like a failure. */
export const STATUS_LABELS: Record<ViewerStatus, string> = {
  delivered: 'Delivered',
  abandoned: 'Abandoned',
  'init-failed': 'Init failed',
  blocked: 'Blocked — open question',
  active: 'Active',
  unreadable: 'Unreadable',
  unknown: 'Unknown',
};

/** Colour CLASS only — never colour alone: every pill renders an icon and a word too. */
export const STATUS_CLASS: Record<ViewerStatus, string> = {
  delivered: 'good',
  abandoned: 'muted',
  'init-failed': 'bad',
  blocked: 'attn',
  active: 'run',
  unreadable: 'bad',
  unknown: 'muted',
};

// --- attention (projection.mjs ATTENTION_KINDS) -------------------------------------------------

export type AttentionKind = 'open-question' | 'init-failed' | 'unreadable-manifest' | 'quiet';

export const ATTENTION_KINDS: AttentionKind[] =
  ['open-question', 'init-failed', 'unreadable-manifest', 'quiet'];

/** A discriminated union, because each kind's `detail` is a different recorded fact and rendering
 * one through another's field names would print `undefined` where a fact should be. */
export type Attention =
  | { kind: 'open-question'; detail: { count: number; taskIds: (string | null)[] } }
  | { kind: 'init-failed'; detail: { message: string | null; status: string | null } }
  | { kind: 'unreadable-manifest'; detail: { why: string } }
  | { kind: 'quiet'; detail: { ageHours: number; sinceHours: number; updatedAt: string | null } };

/** `quiet` is a FACT ABOUT A FILE'S MTIME, not a state (projection.mjs QUIET_AFTER_HOURS). It is
 * separated out of the actionable queue everywhere it is rendered, and labelled as manifest age. */
export const isActionable = (a: Attention) => a.kind !== 'quiet';

// --- feature identity ---------------------------------------------------------------------------

export interface FeatureId { org: string; project: string; name: string }

/** The row a dossier that would not read becomes (projection.mjs unreadableRow) — H06: one corrupt
 * dossier is ONE ROW, never a failed inventory. It carries its own status and attention entry so
 * the list renders it beside healthy features without the client deriving anything about it. */
export interface UnreadableRow {
  key: string;
  label: string;
  unreadable: true;
  why: string;
  viewerStatus: 'unreadable';
  attention: Attention[];
}

export interface MrRecord {
  iid: number | string;
  url: string | null;
  targetBranch: string | null;
  headSha: string | null;
  at: string | null;
  /** which forge opened it — decides `#42` (github) vs `!42` (gitlab). Absent on records
   * written before 2026-08-15, which are GitLab merge requests by construction. */
  forge?: 'gitlab' | 'github' | null;
  /** THE MERGE CERTIFICATE, written by `legion feature merged` from what the forge answered —
   * absent until something asked, which is the ordinary state of an open MR. `headSha` is the
   * head the forge reported as merged; `legion feature clean` compares it to this record's own
   * `headSha` and to the local branch tip before it will delete a worktree its containment
   * formula would otherwise retain. */
  merged?: { at: string | null; headSha: string | null } | null;
}

/** The forge's own notation for a merge/pull request id. */
export const mrRef = (mr: MrRecord): string => `${mr.forge === 'github' ? '#' : '!'}${mr.iid}`;

export interface InitiativeBlock {
  id: string;
  role?: string | null;
  primary?: string | null;
  [k: string]: unknown; // the block is rendered verbatim; the kernel owns its growth
}

export interface FeatureSummary {
  unreadable?: false;
  key: string;
  org: string;
  project: string;
  name: string;
  featureId: string | null;
  viewerStatus: ViewerStatus;
  /** the manifest's own `status`, VERBATIM — shown beside the viewer status when they differ */
  kernelStatus: string | null;
  /** the manifest's own `stage`, VERBATIM; `stageKnown` says whether the kernel knows that name */
  stage: string | null;
  stageKnown: boolean;
  profile: string | null;
  branch: string | null;
  baseBranch: string | null;
  baseSha: string | null;
  /** max mtime of the two manifests — THE staleness fact, and the only one */
  updatedAt: string | null;
  ageHours: number | null;
  createdAt: string | null;
  closedAt: string | null;
  /** a REFERENCE STRING (`#42`, `group/proj#42`) — never a URL; see lib/safe-href.mjs */
  ticket: string | null;
  initiative: InitiativeBlock | null;
  mr: MrRecord | null;
  tasks: { total: number; done: number; started: number; pending: number; openQuestions: number };
  hasPlan: boolean;
  attention: Attention[];
}

export type FeatureRow = FeatureSummary | UnreadableRow;

export const isUnreadable = (r: FeatureRow | FeatureDetailView): r is UnreadableRow =>
  (r as UnreadableRow).unreadable === true;

/** `org/project/name` → the id the API takes, or null when the key is not one. An UNREADABLE row's
 * key is whatever `scanRegisteredFeatures` could compose from a broken index entry, so it may not
 * name three real segments — and a row that cannot be addressed renders as text rather than as a
 * link that would 400. */
export const idOfKey = (key: string): FeatureId | null => {
  const parts = String(key ?? '').split('/');
  if (parts.length !== 3 || parts.some((p) => p === '' || p === 'undefined' || p === 'null')) return null;
  return { org: parts[0], project: parts[1], name: parts[2] };
};

export const keyOfId = (id: FeatureId) => `${id.org}/${id.project}/${id.name}`;

// --- the detail view ------------------------------------------------------------------------------

export interface StageStamp { stage: string; at: string }
export interface SessionStamp { sessionId: string; at: string }

export interface Review { role: string | null; verdict: string | null; subject: string | null; at: string | null }
export interface CloseReview { role: string | null; verdict: string | null; at: string | null }

export interface Milestone {
  id: string | null;
  taskIds: (string | null)[];
  tasks: { total: number; done: number; started: number; pending: number };
  closeReviews: CloseReview[];
}

/** `weak` is `declaredCommands === 0`: a real but TIER-0-ONLY certificate (PLAN-V3 §Gates / R11).
 * `present:false` is a THIRD thing — nothing was certified at all — and the UI never conflates the
 * two, because "no gate ran" is a louder statement than "a weak gate ran". */
export interface Receipt {
  present: boolean;
  declaredCommands: number | null;
  weak: boolean;
  tier: string | null;
  head: string | null;
  treeHash: string | null;
  at: string | null;
  repinnedFrom?: string | null;
  allowConfig?: boolean;
}

export interface Answer { question: string | null; answer: string | null; at: string | null }

export interface TaskDetail {
  id: string | null;
  title: string | null;
  status: string | null;
  attempt: number | null;
  milestone: string | null;
  depends_on: string[];
  startedAt: string | null;
  doneAt: string | null;
  /** `answer === null` IS the open question (projection.mjs / hooks/session-start.mjs) */
  answers: Answer[];
  receipt: Receipt;
}

/** `inside:false` = recorded outside the dossier: real, rendered as a path, NOT servable.
 *  `recorded:false` = a conventional draft file found in the dossier that no op has recorded —
 *  hash and at are null, and nothing about its bytes is claimed. */
export interface ArtifactRef { path: string | null; inside: boolean; hash: string | null; at: string | null; recorded: boolean }

/** RECORDED, never valid. There is deliberately no `valid` key — see `approvalsCaveat`. */
export interface ApprovalRef { at: string | null; subjectHash: string | null }

export type ActivityKind =
  | 'stage-enter' | 'stage-complete' | 'task-start' | 'task-done' | 'question' | 'answer'
  | 'review' | 'approval' | 'gate-receipt' | 'session' | 'mr' | 'commit';

export const ACTIVITY_KINDS: ActivityKind[] = [
  'stage-enter', 'stage-complete', 'task-start', 'task-done', 'question', 'answer',
  'review', 'approval', 'gate-receipt', 'session', 'mr', 'commit',
];

export interface ActivityRow { at: string; kind: ActivityKind; label: string }
export interface FeedRow extends ActivityRow { key: string; org: string; project: string; name: string }

/** The kernel's own predicates, CALLED on this request and stored nowhere (projection.mjs
 * lifecycleNow). `available:false` when they cannot be asked, with the reason — never a green
 * "satisfied" over a question the kernel was never given. */
export type LifecycleNow =
  | { available: false; why: string }
  | {
      available: true;
      stage: string;
      satisfied: boolean;
      why: string | null;
      nextUnsatisfied: { stage: string; why: string } | null;
      approvalsValidNow: Record<string, boolean>;
    };

export interface GitBlock { available: boolean; reason?: string; head?: string }

export interface FeatureView extends FeatureSummary {
  dossier: string;
  worktree: { path: string | null; present: boolean };
  repoRoot: string | null;
  stageHistory: StageStamp[];
  completedStages: StageStamp[];
  /** RECORDED session facts. `current` is the last session that STARTED — no op records an end, so
   * this is never presence and is never rendered as "live". */
  sessions: { current: string | null; history: SessionStamp[] };
  intakeRepos: unknown[];
  milestones: Milestone[];
  tasksDetail: TaskDetail[];
  artifacts: Record<string, ArtifactRef>;
  approvals: Record<string, ApprovalRef>;
  /** shipped IN the DTO so no client can render an approval without it (projection.mjs) */
  approvalsCaveat: string;
  reviews: Review[];
  boundaryReceipt: Receipt;
  /** TIER-KEYED, and NOT a string: `feature start` pins one hash PER GATE TIER
   * (kernel/state.mjs commandPolicyPin writes `{task, boundary}` into feature.json) and the
   * projection passes that object through verbatim. It is declared `Record<string, string>` rather
   * than `Record<'task'|'boundary', string>` because GATE_TIERS is the kernel's list and a client
   * copy of it would be a second vocabulary; the screen renders the recorded entries, whatever they
   * are. test/viewer/dto-types.test.mjs checks this field's DECLARED type against a live payload —
   * it was `string | null` here for one commit, and rendering the object as a React child took the
   * whole feature screen down with error #31. */
  commandPolicyHash: Record<string, string> | null;
  commandPolicy: unknown;
  commandPolicyHistory: unknown[];
  activity: ActivityRow[];
  lifecycleNow: LifecycleNow;
  git: GitBlock;
}

export type FeatureDetailView = FeatureView | UnreadableRow;

// --- endpoint envelopes ---------------------------------------------------------------------------

export interface Population { features: number; readable: number; unreadable: number; org?: string | null; tasks?: number }

export interface Health { ok: boolean; v: number; mode: string; legionHome: string; readOnly: boolean; methods: string[] }
export interface FeaturesResponse { v: number; summaries: FeatureSummary[]; unreadable: UnreadableRow[]; population: Population }
export interface FeatureResponse { v: number; feature: FeatureDetailView }
export interface ActivityResponse {
  v: number; rows: FeedRow[]; total: number; limit: number; truncated: boolean;
  unreadable: UnreadableRow[]; population: Population;
}

export interface Commit { sha: string; at: string; subject: string }
export type CommitsResponse =
  | { v: number; available: true; commits: Commit[]; head?: string; baseSha?: string }
  | { v: number; available: false; reason: string; commits: Commit[]; head?: string };

export interface DiffFileRow { status: string; path: string }
export type DiffResponse =
  | { v: number; available: true; baseSha: string; head: string; files: DiffFileRow[]; file: string | null; diff: string }
  | { v: number; available: false; reason: string; files: DiffFileRow[]; diff: null; file: string | null };

/** THE stats formula's output, rendered VERBATIM (VIEWER-REVIEW H01). The client computes no
 * number of its own from it — not a percentage, not an average, not a ratio. */
export interface Stats { n: number; p50Ms: number | null; p90Ms: number | null; minMs: number | null; maxMs: number | null }

export interface InsightsResponse {
  v: number;
  population: Population;
  outcomes: Record<ViewerStatus, number>;
  recentOutcomes: { windowDays: number; delivered: number; abandoned: number; features: string[] };
  featureDuration: Stats & { excluded: { noStart: number; noEnd: number; negative: number } };
  stageDuration: Record<string, Stats>;
  attempts: { tasks: number; features: number; distribution: Record<string, number> };
  reviewRounds: {
    features: number; reviews: number; fixRounds: number; unresolvedFails: number;
    byFeature: { key: string; reviews: number; fixRounds: number; unresolvedFails: number }[];
  };
}

// --- the data boundary ----------------------------------------------------------------------------

/** The ONE replaceable boundary. Every method is a READ; there is no mutation method to implement,
 * and that is structural rather than disciplinary — legion2's interface had `answer`, `control`,
 * `steer` and `startIntake`, and deleting them from HERE is what makes a mutation affordance
 * impossible to add to a screen without adding it to the contract first (PLAN-V3 decision 12). */
export interface ViewerDataSource {
  readonly mode: 'live' | 'fixture';
  health(signal?: AbortSignal): Promise<Health>;
  features(signal?: AbortSignal): Promise<FeaturesResponse>;
  feature(id: FeatureId, signal?: AbortSignal): Promise<FeatureResponse>;
  activity(limit: number, signal?: AbortSignal): Promise<ActivityResponse>;
  commits(id: FeatureId, signal?: AbortSignal): Promise<CommitsResponse>;
  diff(id: FeatureId, file: string | null, signal?: AbortSignal): Promise<DiffResponse>;
  insights(signal?: AbortSignal): Promise<InsightsResponse>;
  /** dossier-relative artifact text; rejects with the server's own message */
  artifactText(id: FeatureId, path: string, signal?: AbortSignal): Promise<string>;
  /** the `src`/`href` for an artifact, or null when this source cannot serve one (fixtures) */
  artifactHref(id: FeatureId, path: string): string | null;
}

/** THE honest load state (VF19). A failed poll after a successful one keeps the last data and says
 * so — "showing the last read at HH:MM, nothing here is guessed" — rather than blanking the screen
 * or, worse, rendering stale numbers as if they were fresh. */
export type Loaded<T> =
  | { state: 'loading' }
  | { state: 'ok'; data: T; at: number }
  | { state: 'error'; error: string; last: T | null; at: number | null };

export const loadedData = <T>(l: Loaded<T>): T | null =>
  (l.state === 'ok' ? l.data : l.state === 'error' ? l.last : null);
