// fixtures.ts — deterministic worlds shaped EXACTLY like the server's DTOs. They exist for three
// jobs and no others: the component Gallery, the browser tests (T42, which must be able to reach
// every state without forging a LEGION_HOME per case), and `?fixtures` when a designer wants the UI
// without a running kernel.
//
// THEY ARE NOT A SECOND PROJECTION. Every field below is a literal — nothing here computes a
// status, an attention flag or a statistic; the values are what a real `/api/…` response would
// have contained, typed against data/types.ts so a server DTO change breaks the fixtures at
// `tsc --noEmit` rather than in a browser.
//
// THE WORLDS, and the honest state each one exists to prove renderable:
//   active      an ordinary in-flight feature: plan imported, one task done, one started
//   blocked     an unanswered question — the projection's ONE cause of `blocked`
//   quiet       active, but no manifest write in 40h: manifest AGE, never "stalled"
//   unreadable  a corrupt dossier beside two healthy features (H06)
//   delivered   closed, with an MR, a boundary receipt and commits
//   weak        delivered on a `declaredCommands: 0` receipt — TIER-0 ONLY, never a full one
//   empty       nothing registered on this machine — an ANSWER, not a failure
//   unreachable every read throws: the honest "cannot reach the server" state
import type {
  ActivityResponse, CommitsResponse, DiffResponse, FeatureSummary, FeatureView, FeaturesResponse,
  InsightsResponse, Receipt, UnreadableRow,
} from './types';

export const FIXTURE_NOW = '2026-07-31T11:00:00.000Z';
const T = (hoursAgo: number) => new Date(Date.parse(FIXTURE_NOW) - hoursAgo * 3_600_000).toISOString();

export const CAVEAT =
  'recorded != valid — an artifact edit invalidates deterministically; the kernel decides at use '
  + 'time, and its refusal is the answer.';

const noReceipt: Receipt = {
  present: false, declaredCommands: null, weak: false, tier: null, head: null, treeHash: null, at: null,
};
const fullReceipt: Receipt = {
  present: true, declaredCommands: 3, weak: false, tier: 'task', head: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3',
  treeHash: 'aa11bb22cc33dd44ee55ff6607182930', at: T(3),
};
const weakReceipt: Receipt = {
  present: true, declaredCommands: 0, weak: true, tier: 'boundary', head: '5d4c3b2a19f8e7d6c5b4a39281706f5e4d3c2b1a',
  treeHash: 'bb22cc33dd44ee55ff660718293a4b5c', at: T(2),
};

function summary(over: Partial<FeatureSummary> & Pick<FeatureSummary, 'org' | 'project' | 'name'>): FeatureSummary {
  const key = `${over.org}/${over.project}/${over.name}`;
  return {
    key,
    featureId: key,
    viewerStatus: 'active',
    kernelStatus: 'active',
    stage: 'build',
    stageKnown: true,
    profile: 'standard',
    branch: `feat/${over.name}`,
    baseBranch: 'develop',
    baseSha: '1a2b3c4d5e6f7081920a1b2c3d4e5f6071829304',
    updatedAt: T(1),
    ageHours: 1,
    createdAt: T(30),
    closedAt: null,
    ticket: null,
    initiative: null,
    mr: null,
    tasks: { total: 3, done: 1, started: 1, pending: 1, openQuestions: 0 },
    hasPlan: true,
    attention: [],
    ...over,
  };
}

function view(s: FeatureSummary, over: Partial<FeatureView> = {}): FeatureView {
  return {
    ...s,
    dossier: `/tmp/legion-home/orgs/${s.org}/${s.project}/${s.name}`,
    worktree: { path: `/tmp/work/${s.project}--${s.name}`, present: true },
    repoRoot: `/tmp/work/${s.project}`,
    stageHistory: [
      { stage: 'intake', at: T(30) }, { stage: 'spec', at: T(26) },
      { stage: 'plan', at: T(20) }, { stage: 'build', at: T(12) },
    ],
    completedStages: [{ stage: 'intake', at: T(27) }, { stage: 'spec', at: T(21) }, { stage: 'plan', at: T(13) }],
    sessions: { current: 'sess-7f3a', history: [{ sessionId: 'sess-1b2c', at: T(30) }, { sessionId: 'sess-7f3a', at: T(12) }] },
    intakeRepos: [],
    milestones: [
      {
        id: 'M1',
        taskIds: ['T1', 'T2'],
        tasks: { total: 2, done: 1, started: 1, pending: 0 },
        closeReviews: [{ role: 'code-reviewer', verdict: 'pass', at: T(6) }],
      },
      { id: 'M2', taskIds: ['T3'], tasks: { total: 1, done: 0, started: 0, pending: 1 }, closeReviews: [] },
    ],
    tasksDetail: [
      {
        id: 'T1', title: 'Port the shell', status: 'done', attempt: 1, milestone: 'M1',
        depends_on: [], startedAt: T(11), doneAt: T(9), answers: [], receipt: fullReceipt,
      },
      {
        id: 'T2', title: 'Reshape the data layer', status: 'started', attempt: 2, milestone: 'M1',
        depends_on: ['T1'], startedAt: T(4), doneAt: null,
        answers: [{ question: 'Which base branch should the diff render against?', answer: 'the pinned baseSha', at: T(5) }],
        receipt: noReceipt,
      },
      {
        id: 'T3', title: 'Budgets', status: 'pending', attempt: 0, milestone: 'M2',
        depends_on: ['T2'], startedAt: null, doneAt: null, answers: [], receipt: noReceipt,
      },
    ],
    artifacts: {
      intent: { path: 'intent.md', inside: true, hash: 'h-intent-1', at: T(28) },
      spec: { path: 'specs/spec.md', inside: true, hash: 'h-spec-1', at: T(22) },
      plan: { path: 'plan.md', inside: true, hash: 'h-plan-1', at: T(14) },
    },
    approvals: {
      intake: { at: T(27), subjectHash: 'sub-intake-aaaa' },
      spec: { at: T(21), subjectHash: 'sub-spec-bbbb' },
      plan: { at: T(13), subjectHash: 'sub-plan-cccc' },
    },
    approvalsCaveat: CAVEAT,
    reviews: [
      { role: 'code-reviewer', verdict: 'fail', subject: 'task:T1', at: T(10) },
      { role: 'code-reviewer', verdict: 'pass', subject: 'task:T1', at: T(9) },
      { role: 'code-reviewer', verdict: 'pass', subject: 'milestone:M1', at: T(6) },
    ],
    boundaryReceipt: noReceipt,
    // TIER-KEYED, exactly as feature.json records it. A fixture that agreed with a WRONG client
    // type is why the object-as-React-child crash reached a commit: eight worlds and a Gallery all
    // rendered the shape the type declared instead of the shape the kernel writes.
    commandPolicyHash: { task: 'pol-1234abcd', boundary: 'pol-5678ef90' },
    commandPolicy: null,
    commandPolicyHistory: [],
    activity: [
      { at: T(30), kind: 'stage-enter', label: 'entered stage intake' },
      { at: T(27), kind: 'approval', label: 'intake decision recorded' },
      { at: T(12), kind: 'stage-enter', label: 'entered stage build' },
      { at: T(11), kind: 'task-start', label: 'task T1 started' },
      { at: T(10), kind: 'review', label: 'code-reviewer: fail on task:T1' },
      { at: T(9), kind: 'task-done', label: 'task T1 done' },
      { at: T(6), kind: 'review', label: 'code-reviewer: pass on milestone:M1' },
      { at: T(4), kind: 'task-start', label: 'task T2 started' },
    ],
    lifecycleNow: {
      available: true,
      stage: 'build',
      satisfied: false,
      why: 'task T2 is started and task T3 is pending — a blocked or pending task is an unfinished build',
      nextUnsatisfied: { stage: 'build', why: 'not every task is done' },
      approvalsValidNow: { intake: true, spec: true, plan: true, preview: false, 'pre-merge': false },
    },
    git: { available: true, head: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3' },
    ...over,
  };
}

const unreadableRow = (key: string, why: string): UnreadableRow => ({
  key,
  label: key,
  unreadable: true,
  why,
  viewerStatus: 'unreadable',
  attention: [{ kind: 'unreadable-manifest', detail: { why } }],
});

// --- the worlds ------------------------------------------------------------------------------------

const active = summary({ org: 'intech', project: 'cv-mf', name: 'cv41-viewer' });

const blocked = summary({
  org: 'intech', project: 'cv-mf', name: 'cv42-export',
  viewerStatus: 'blocked', stage: 'build',
  tasks: { total: 2, done: 0, started: 1, pending: 1, openQuestions: 1 },
  attention: [{ kind: 'open-question', detail: { count: 1, taskIds: ['T1'] } }],
  updatedAt: T(2), ageHours: 2,
});

const quiet = summary({
  org: 'intech', project: 'cv', name: 'cv12-print-layout',
  updatedAt: T(40), ageHours: 40,
  attention: [{ kind: 'quiet', detail: { ageHours: 40, sinceHours: 24, updatedAt: T(40) } }],
});

const initFailed = summary({
  org: 'intech', project: 'cv', name: 'cv13-broken-start',
  viewerStatus: 'init-failed', kernelStatus: 'initialization_failed', stage: 'intake', hasPlan: false,
  tasks: { total: 0, done: 0, started: 0, pending: 0, openQuestions: 0 },
  attention: [{
    kind: 'init-failed',
    detail: { message: 'worktree add failed: fatal: invalid reference: develop', status: 'initialization_failed' },
  }],
});

const delivered = summary({
  org: 'intech', project: 'cv-mf', name: 'cv39-ticket-link',
  viewerStatus: 'delivered', kernelStatus: 'delivered', stage: 'finalize',
  closedAt: T(20), updatedAt: T(20), ageHours: 20, ticket: 'intech/cv-mf#412',
  tasks: { total: 4, done: 4, started: 0, pending: 0, openQuestions: 0 },
  mr: {
    iid: 77, url: 'https://gitlab.example.com/intech/cv-mf/-/merge_requests/77',
    targetBranch: 'develop', headSha: '5d4c3b2a19f8e7d6c5b4a39281706f5e4d3c2b1a', at: T(21),
  },
});

const initiativeA = summary({
  org: 'intech', project: 'cv-api', name: 'cv40-export-api',
  initiative: { id: 'exports-2026q3', role: 'primary' },
});
const initiativeB = summary({
  org: 'intech', project: 'cv-mf', name: 'cv40-export-ui',
  initiative: { id: 'exports-2026q3', role: 'secondary', primary: 'intech/cv-api/cv40-export-api' },
});

export interface FixtureWorld {
  features: FeaturesResponse;
  views: Record<string, FeatureView>;
  activity: ActivityResponse;
  insights: InsightsResponse;
  commits: CommitsResponse;
  diff: DiffResponse;
}

const FIXTURE_DIFF = `diff --git a/src/App.tsx b/src/App.tsx
index 1a2b3c4..5d6e7f8 100644
--- a/src/App.tsx
+++ b/src/App.tsx
@@ -12,7 +12,7 @@ export default function App() {
   const hash = useHash();
-  const [source] = useState(new LegionDataSource(token));
+  const [source] = useState(new LegionDataSource());
   return (
     <div className="shell">
 `;

function world(
  summaries: FeatureSummary[],
  unreadable: UnreadableRow[],
  views: Record<string, FeatureView>,
): FixtureWorld {
  return {
    features: {
      v: 1,
      summaries,
      unreadable,
      population: {
        features: summaries.length + unreadable.length,
        readable: summaries.length,
        unreadable: unreadable.length,
      },
    },
    views,
    activity: {
      v: 1,
      rows: summaries.flatMap((s) => (views[s.key]?.activity ?? []).slice(-3).map((r) => ({
        ...r, key: s.key, org: s.org, project: s.project, name: s.name,
      }))).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
      total: 24,
      limit: 200,
      truncated: false,
      unreadable,
      population: {
        features: summaries.length + unreadable.length,
        readable: summaries.length,
        unreadable: unreadable.length,
        org: null,
      },
    },
    insights: {
      v: 1,
      population: {
        features: summaries.length + unreadable.length,
        readable: summaries.length,
        unreadable: unreadable.length,
        org: null,
        tasks: summaries.reduce((n, s) => n + s.tasks.total, 0),
      },
      outcomes: {
        delivered: summaries.filter((s) => s.viewerStatus === 'delivered').length,
        abandoned: 0,
        'init-failed': summaries.filter((s) => s.viewerStatus === 'init-failed').length,
        blocked: summaries.filter((s) => s.viewerStatus === 'blocked').length,
        active: summaries.filter((s) => s.viewerStatus === 'active').length,
        unreadable: unreadable.length,
        unknown: 0,
      },
      recentOutcomes: {
        windowDays: 7,
        delivered: summaries.filter((s) => s.viewerStatus === 'delivered').length,
        abandoned: 0,
        features: summaries.filter((s) => s.viewerStatus === 'delivered').map((s) => s.key),
      },
      featureDuration: {
        n: 2, p50Ms: 34 * 3_600_000, p90Ms: 51 * 3_600_000, minMs: 20 * 3_600_000, maxMs: 51 * 3_600_000,
        excluded: { noStart: 1, noEnd: 2, negative: 0 },
      },
      stageDuration: {
        intake: { n: 3, p50Ms: 4 * 3_600_000, p90Ms: 6 * 3_600_000, minMs: 2 * 3_600_000, maxMs: 6 * 3_600_000 },
        spec: { n: 3, p50Ms: 6 * 3_600_000, p90Ms: 9 * 3_600_000, minMs: 5 * 3_600_000, maxMs: 9 * 3_600_000 },
        build: { n: 2, p50Ms: 12 * 3_600_000, p90Ms: 18 * 3_600_000, minMs: 8 * 3_600_000, maxMs: 18 * 3_600_000 },
      },
      attempts: { tasks: 7, features: summaries.length, distribution: { '0': 1, '1': 4, '2': 2 } },
      reviewRounds: {
        features: 2,
        reviews: 5,
        fixRounds: 1,
        unresolvedFails: 0,
        byFeature: [{ key: active.key, reviews: 3, fixRounds: 1, unresolvedFails: 0 }],
      },
    },
    commits: {
      v: 1,
      available: true,
      baseSha: '1a2b3c4d5e6f7081920a1b2c3d4e5f6071829304',
      head: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3',
      commits: [
        { sha: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3', at: T(9), subject: 'feat(m1): the shell and the poll loop' },
        { sha: '3e4f5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5', at: T(20), subject: 'chore: gitignore the viewer build outputs' },
      ],
    },
    diff: {
      v: 1,
      available: true,
      baseSha: '1a2b3c4d5e6f7081920a1b2c3d4e5f6071829304',
      head: '9c1f2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3',
      files: [{ status: 'M', path: 'src/App.tsx' }, { status: 'A', path: 'src/data/types.ts' }],
      file: null,
      diff: FIXTURE_DIFF,
    },
  };
}

const activeView = view(active);
const blockedView = view(blocked, {
  viewerStatus: 'blocked',
  tasksDetail: [
    {
      id: 'T1', title: 'Export selector', status: 'started', attempt: 1, milestone: 'M1',
      depends_on: [], startedAt: T(6), doneAt: null,
      answers: [{ question: 'Should the export include archived rows? The spec is silent.', answer: null, at: T(3) }],
      receipt: noReceipt,
    },
    {
      id: 'T2', title: 'CSV writer', status: 'pending', attempt: 0, milestone: 'M1',
      depends_on: ['T1'], startedAt: null, doneAt: null, answers: [], receipt: noReceipt,
    },
  ],
  milestones: [{ id: 'M1', taskIds: ['T1', 'T2'], tasks: { total: 2, done: 0, started: 1, pending: 1 }, closeReviews: [] }],
  activity: [
    { at: T(8), kind: 'stage-enter', label: 'entered stage build' },
    { at: T(6), kind: 'task-start', label: 'task T1 started' },
    { at: T(3), kind: 'question', label: 'task T1: question recorded' },
  ],
  reviews: [],
  git: { available: false, reason: 'the recorded worktree /tmp/work/cv-mf--cv42-export is absent — pruned by `legion feature clean`, or removed by hand' },
});
const deliveredView = view(delivered, {
  worktree: { path: '/tmp/work/cv-mf--cv39-ticket-link', present: false },
  boundaryReceipt: fullReceipt,
  lifecycleNow: {
    available: true, stage: 'finalize', satisfied: true, why: null, nextUnsatisfied: null,
    approvalsValidNow: { intake: true, spec: true, plan: true, preview: false, 'pre-merge': true },
  },
});
const weakView = view(
  summary({
    org: 'intech', project: 'cv', name: 'cv14-typo-fix',
    viewerStatus: 'delivered', kernelStatus: 'delivered', stage: 'finalize', profile: 'express',
    closedAt: T(48), updatedAt: T(48), ageHours: 48,
    tasks: { total: 1, done: 1, started: 0, pending: 0, openQuestions: 0 },
  }),
  { boundaryReceipt: weakReceipt },
);

const CORRUPT = unreadableRow(
  'intech/cv/cv09-legacy',
  '/tmp/legion-home/orgs/intech/cv/cv09-legacy/tasks.json is not a JSON object',
);

export const WORLDS: Record<string, FixtureWorld> = {
  active: world(
    [active, blocked, quiet, delivered, initiativeA, initiativeB],
    [],
    {
      [active.key]: activeView,
      [blocked.key]: blockedView,
      [quiet.key]: view(quiet),
      [delivered.key]: deliveredView,
      [initiativeA.key]: view(initiativeA),
      [initiativeB.key]: view(initiativeB),
    },
  ),
  blocked: world([blocked], [], { [blocked.key]: blockedView }),
  quiet: world([quiet], [], { [quiet.key]: view(quiet) }),
  'init-failed': world([initFailed], [], { [initFailed.key]: view(initFailed) }),
  unreadable: world([active, delivered], [CORRUPT], { [active.key]: activeView, [delivered.key]: deliveredView }),
  delivered: world([delivered], [], { [delivered.key]: deliveredView }),
  weak: world([weakView], [], { [weakView.key]: weakView }),
  empty: world([], [], {}),
};

export const SCENARIOS = [...Object.keys(WORLDS), 'unreachable'];

/** Inline artifact bodies the fixture serves instead of `/api/artifact` — enough markdown to prove
 * the digest render, the mermaid upgrade and the relative-screenshot rewrite are all wired. */
export const FIXTURE_ARTIFACTS: Record<string, string> = {
  'intent.md': '# Intent\n\nPort the v2 viewer, read-only. Every control surface is deleted rather than disabled.\n',
  'specs/spec.md': '## Digest\n\nThe viewer renders the ONE server projection verbatim.\n\n| rule | where |\n|---|---|\n| one status vocabulary | `_viewer/projection.mjs` |\n| one stats formula | `insights()` |\n',
  'plan.md': '## Digest\n\nMV1 server → MV2 frontend → MV3 docs.\n\n```mermaid\ngraph TD;\n  T39[T39 projection] --> T40[T40 server];\n  T40 --> T41[T41 frontend];\n  T41 --> T42[T42 browser];\n```\n',
  'review-visual.md': '## Visual review\n\nOperations at 1280px:\n\n![operations](visual/M1/operations@1280.png)\n\nVerdict: pass.\n',
};
