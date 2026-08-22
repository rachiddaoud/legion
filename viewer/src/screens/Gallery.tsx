// Gallery — every state of every shared component on one page, from fixtures. A design-regression
// and browser-test surface; NOT in the primary nav, reachable at `#/gallery` only.
//
// It exists because several honest states are hard to reach on purpose in a live world: a weak
// tier-0 receipt, an unreadable dossier, an unrecognised kernel status, a feature the kernel's own
// predicates cannot be asked about. All of them are rendered here, side by side, so a change that
// makes one of them look like a healthy state is visible in one screenshot.
import type { FeatureView, Receipt } from '../data/types';
import { WORLDS } from '../data/fixtures';
import {
  AttentionRow, Empty, ErrorStrip, LifecycleNowPanel, Loading, RawStatusNote,
  ReceiptBadge, ReceiptDetail, Section, Spine, StatusPill,
} from '../components/ui';
import { VIEWER_STATUSES } from '../data/types';

const weak: Receipt = { present: true, declaredCommands: 0, weak: true, tier: 'boundary', head: 'abc123def456', treeHash: 'fed321cba654', at: new Date().toISOString() };
const full: Receipt = { present: true, declaredCommands: 4, weak: false, tier: 'task', head: 'abc123def456', treeHash: 'fed321cba654', at: new Date().toISOString() };
const absent: Receipt = { present: false, declaredCommands: null, weak: false, tier: null, head: null, treeHash: null, at: null };

export function Gallery() {
  const active = Object.values(WORLDS.active.views)[0] as FeatureView;
  const blocked = Object.values(WORLDS.blocked.views)[0] as FeatureView;
  const unreadable = WORLDS.unreadable.features.unreadable[0];

  return (
    <>
      <Section title="Status pills — the server's whole vocabulary (icon + label, never colour alone)">
        <div className="card" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {VIEWER_STATUSES.map((s) => <StatusPill key={s} status={s} />)}
        </div>
      </Section>

      <Section title="Attention rows — one rendering per recorded kind">
        <div className="card">
          <ul className="attn-list">
            <AttentionRow a={{ kind: 'open-question', detail: { count: 2, taskIds: ['T1', 'T4'] } }} />
            <AttentionRow a={{ kind: 'init-failed', detail: { message: 'worktree add failed: fatal: invalid reference: develop', status: 'initialization_failed' } }} />
            <AttentionRow a={{ kind: 'unreadable-manifest', detail: { why: 'tasks.json is not a JSON object' } }} />
            <AttentionRow a={{ kind: 'quiet', detail: { ageHours: 40, sinceHours: 24, updatedAt: new Date(Date.now() - 40 * 3600_000).toISOString() } }} />
          </ul>
        </div>
      </Section>

      <Section title="Receipts — full, WEAK (tier-0 only), and absent are three different things">
        <div className="card" style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <ReceiptBadge receipt={full} what="task" />
          <ReceiptBadge receipt={weak} what="boundary" />
          <ReceiptBadge receipt={absent} what="boundary" />
        </div>
        <div className="grid">
          <div className="card"><strong>full</strong><ReceiptDetail receipt={full} /></div>
          <div className="card"><strong>weak</strong><ReceiptDetail receipt={weak} /></div>
          <div className="card"><strong>absent</strong><ReceiptDetail receipt={absent} /></div>
        </div>
      </Section>

      <Section title="Recorded stages — an in-flight feature and a blocked one">
        <div className="grid">
          <div className="card"><Spine view={active} /></div>
          <div className="card"><Spine view={blocked} /></div>
        </div>
      </Section>

      <Section title="The kernel's verdict — asked, and unaskable">
        <div className="grid">
          <div className="card"><LifecycleNowPanel now={active.lifecycleNow} /></div>
          <div className="card"><LifecycleNowPanel now={{ available: false, why: 'tasks.json does not exist yet — the plan has not been imported, so the kernel\'s stage predicates have nothing to read' }} /></div>
        </div>
      </Section>

      <Section title="Honest absences — never a guess">
        <div className="card">
          <RawStatusNote viewerStatus="unknown" kernelStatus="in_review" stage="qa" stageKnown={false} />
          <div className="unreadable-why mono">{unreadable.why}</div>
        </div>
        <ErrorStrip error="cannot reach the legion viewer server (/api/features)" at={Date.now() - 90_000} />
        <div style={{ height: 8 }} />
        <ErrorStrip error="cannot reach the legion viewer server (/api/features)" at={null} />
        <div className="grid">
          <div className="card"><Loading what="features" /></div>
          <div className="card"><Empty title="Nothing is registered on this machine" hint="`legion project init` registers one; this is an answer, not a failure." /></div>
        </div>
      </Section>
    </>
  );
}
