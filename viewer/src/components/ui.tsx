// ui.tsx — the small shared vocabulary: status pill (icon + label, never colour alone), the
// recorded stage spine, attention rows, receipt and approval badges, honest load/empty states, and
// the time formatters. ONE truthful state type feeds all of them.
//
// WHAT WAS DELETED FROM legion2's VERSION, and why it could not be ported: `QuestionCard` (a form
// that POSTed an answer), `GateEvidencePanel` (the approve/reject consequence table a human gate
// rendered above two buttons), `SimulatedBanner`'s "every control transitions fixtures only" copy,
// and `fmtCost`/`fmtTokens`. The first three are the orchestration surface decision 12a deletes
// outright. The last two are honesty: legion3 records no cost and no token count anywhere
// (decision 9), so there is no `—` placeholder for them either — a dash implies a number that
// could arrive, and none can.
//
// `ApprovalsCaveat` IS GONE THE SAME WAY, and the fact it carried is not: it rendered a paragraph
// warning that a recorded approval may no longer bind, above a table whose last column answers
// exactly that, per row, from the kernel asked on this request. A preamble that repeats a column
// is space the rows were owed.
//
// NOTHING HERE DERIVES LIFECYCLE STATE. Every component takes recorded facts and renders them.
// The spine in particular is built from `stageHistory` / `completedStages` / the current `stage` /
// the KERNEL's own `nextUnsatisfied` verdict — it does NOT carry a copy of the kernel's STAGES
// list. legion2's spine did (`STAGE_ORDER` was a literal in this file) and it could only ever be
// right by coincidence; a client-side stage order is exactly the "viewer-derived lifecycle state"
// the prohibitions name. The consequence is deliberate and stated in the UI: the spine shows the
// stages this feature has actually been in, plus the one the kernel says is next.
import type { ReactNode } from 'react';
import type {
  Attention, FeatureView, LifecycleNow, Receipt, ViewerStatus,
} from '../data/types';
import { STATUS_CLASS, STATUS_LABELS } from '../data/types';
import { showNextUnsatisfied } from '../lib/shell.mjs';

const STATUS_ICON: Record<string, string> = { attn: '●', bad: '■', good: '✓', muted: '○', run: '◐' };

export function StatusPill({ status, note }: { status: ViewerStatus; note?: string }) {
  const cls = STATUS_CLASS[status] ?? 'muted';
  return (
    <span className={`pill pill-${cls}`} role="status" aria-label={STATUS_LABELS[status] ?? status} title={note}>
      <span aria-hidden="true" className="pill-ico">{STATUS_ICON[cls]}</span>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

/** The kernel's `status` beside the viewer's, but ONLY when the viewer could not place it. A
 * feature whose manifest says something this kernel never writes renders Unknown AND says what the
 * manifest actually said — coercing it to the nearest neighbour is what H02 forbids. */
export function RawStatusNote({ viewerStatus, kernelStatus, stage, stageKnown }: {
  viewerStatus: ViewerStatus; kernelStatus: string | null; stage: string | null; stageKnown: boolean;
}) {
  if (viewerStatus !== 'unknown') return null;
  return (
    <p className="dq dq-partial" role="note">
      This dossier records <span className="mono">status: {JSON.stringify(kernelStatus)}</span>
      {!stageKnown && <> and <span className="mono">stage: {JSON.stringify(stage)}</span></>}
      {' '}— values this viewer does not know. It is shown as Unknown rather than placed in the
      lifecycle by guesswork.
    </p>
  );
}

// --- attention ------------------------------------------------------------------------------------

/** ONE rendering per attention kind, each naming the RECORDED fact it came from. `quiet` says
 * "manifest age" in words: it is a subtraction over two file mtimes, and it is never called
 * stalled, because nothing in legion3 records whether an agent is alive. */
export function AttentionRow({ a }: { a: Attention }) {
  switch (a.kind) {
    case 'open-question':
      return (
        <li className="attn-row attn-open-question">
          <span className="pill pill-attn"><span className="pill-ico" aria-hidden="true">●</span>open question</span>
          <span>
            {a.detail.count} unanswered question{a.detail.count === 1 ? '' : 's'} recorded on{' '}
            {a.detail.taskIds.length === 0 ? 'no task' : <span className="mono">{a.detail.taskIds.join(', ')}</span>}
          </span>
        </li>
      );
    case 'init-failed':
      return (
        <li className="attn-row attn-init-failed">
          <span className="pill pill-bad"><span className="pill-ico" aria-hidden="true">■</span>init failed</span>
          <span>{a.detail.message ?? 'no message was recorded'} <span className="chip">status {a.detail.status ?? '—'}</span></span>
        </li>
      );
    case 'unreadable-manifest':
      return (
        <li className="attn-row attn-unreadable">
          <span className="pill pill-bad"><span className="pill-ico" aria-hidden="true">■</span>unreadable</span>
          <span className="mono">{a.detail.why}</span>
        </li>
      );
    case 'quiet':
      return (
        <li className="attn-row attn-quiet">
          <span className="pill pill-muted"><span className="pill-ico" aria-hidden="true">○</span>manifest age</span>
          <span>
            no manifest write in {Math.round(a.detail.ageHours)}h (the quiet threshold is{' '}
            {a.detail.sinceHours}h) — last write <RelTime iso={a.detail.updatedAt} />. This is a
            fact about a file, not a claim about an agent.
          </span>
        </li>
      );
    default:
      return null;
  }
}

// --- the spine ------------------------------------------------------------------------------------

export interface SpineStage { stage: string; enteredAt: string | null; completedAt: string | null; current: boolean; next: boolean }

/**
 * The spine's rows, from RECORDED facts alone (header). Order is the order the feature entered the
 * stages; a stage entered twice keeps its FIRST position and its LAST entry time, because a
 * re-entry is the same stage revisited, not a new one. The kernel's `nextUnsatisfied` stage is
 * appended when it is not already on the list — that is the kernel's verdict, computed on this
 * request, not a lifecycle table this client carries.
 */
export function spineRows(view: FeatureView): SpineStage[] {
  const order: string[] = [];
  const entered = new Map<string, string>();
  const completed = new Map<string, string>();
  for (const h of view.stageHistory ?? []) {
    if (typeof h?.stage !== 'string') continue;
    if (!entered.has(h.stage)) order.push(h.stage);
    entered.set(h.stage, h.at);
  }
  for (const c of view.completedStages ?? []) {
    if (typeof c?.stage !== 'string') continue;
    if (!entered.has(c.stage) && !completed.has(c.stage)) order.push(c.stage);
    completed.set(c.stage, c.at);
  }
  if (typeof view.stage === 'string' && !order.includes(view.stage)) order.push(view.stage);
  const nextStage = view.lifecycleNow.available ? view.lifecycleNow.nextUnsatisfied?.stage ?? null : null;
  if (nextStage && !order.includes(nextStage)) order.push(nextStage);
  return order.map((stage) => ({
    stage,
    enteredAt: entered.get(stage) ?? null,
    completedAt: completed.get(stage) ?? null,
    current: view.stage === stage,
    next: nextStage === stage && view.stage !== stage,
  }));
}

export function Spine({ view, compact = false }: { view: FeatureView; compact?: boolean }) {
  const rows = spineRows(view);
  if (rows.length === 0) return <p className="muted">No stage has been recorded for this feature yet.</p>;
  return (
    <ol className="spine" aria-label="recorded stages">
      {rows.map((r) => {
        const cls = r.completedAt ? 'done' : r.current ? 'current' : r.next ? 'next' : 'todo';
        const at = r.completedAt ?? r.enteredAt;
        return (
          <li key={r.stage} className={`spine-stage spine-${cls}`} style={{ ['--stage' as string]: `var(--stage-${r.stage}, var(--accent))` }}>
            <span className="spine-dot" aria-hidden="true" />
            <span className="spine-name">{r.stage}</span>
            {r.current && <span className="spine-now">current</span>}
            {r.next && <span className="spine-next">next unsatisfied</span>}
            {r.completedAt && <span className="chip">completed</span>}
            {!compact && <span className="spine-time"><RelTime iso={at} /></span>}
          </li>
        );
      })}
    </ol>
  );
}

/** The kernel's verdicts, computed on THIS request and stored nowhere — labelled as such, because
 * a stale "satisfied" would be worse than none. */
export function LifecycleNowPanel({ now }: { now: LifecycleNow }) {
  if (!now.available) {
    return (
      <p className="dq dq-partial" role="note">
        The kernel's stage predicates could not be asked here — {now.why}.
      </p>
    );
  }
  const next = showNextUnsatisfied(now) ? now.nextUnsatisfied : null;
  return (
    <div className="lifecycle-now">
      <p>
        Stage <span className="mono">{now.stage}</span>{' '}
        {now.satisfied
          ? <span className="verdict-badge verdict-pass">satisfied</span>
          : <><span className="verdict-badge verdict-fail">not satisfied</span> — {now.why}</>}
      </p>
      {next && (
        <p>Next unsatisfied: <span className="mono">{next.stage}</span> — {next.why}</p>
      )}
    </div>
  );
}

// --- receipts and approvals -------------------------------------------------------------------------

/** A `declaredCommands: 0` receipt is a REAL but WEAK certificate — tier-0 self-protection only —
 * and it must never render like a full one. An ABSENT receipt is a third, louder statement. */
export function ReceiptBadge({ receipt, what }: { receipt: Receipt; what: string }) {
  if (!receipt.present) {
    return <span className="pill pill-muted" title={`no ${what} gate receipt is recorded`}><span className="pill-ico" aria-hidden="true">○</span>no receipt</span>;
  }
  if (receipt.weak) {
    return (
      <span className="pill pill-attn" title="0 declared commands — a real but WEAK certificate, tier-0 self-protection only">
        <span className="pill-ico" aria-hidden="true">●</span>TIER-0 ONLY — weak receipt
      </span>
    );
  }
  return (
    <span className="pill pill-good" title={`${receipt.declaredCommands} declared command(s)`}>
      <span className="pill-ico" aria-hidden="true">✓</span>receipt · {receipt.declaredCommands} cmd
    </span>
  );
}

export function ReceiptDetail({ receipt }: { receipt: Receipt }) {
  if (!receipt.present) return <p className="muted" style={{ margin: 0 }}>No gate receipt is recorded here.</p>;
  return (
    <dl className="kv">
      <div><dt>tier</dt><dd className="mono">{receipt.tier ?? '—'}</dd></div>
      <div><dt>declared commands</dt><dd className="mono">{receipt.declaredCommands ?? 'unknown'}</dd></div>
      <div><dt>head</dt><dd className="mono">{receipt.head ? receipt.head.slice(0, 12) : '—'}</dd></div>
      <div><dt>tree</dt><dd className="mono">{receipt.treeHash ? receipt.treeHash.slice(0, 12) : '—'}</dd></div>
      <div><dt>recorded</dt><dd><RelTime iso={receipt.at} /></dd></div>
      {receipt.repinnedFrom && <div><dt>re-pinned from</dt><dd className="mono">{receipt.repinnedFrom}</dd></div>}
      {receipt.allowConfig && <div><dt>allowConfig</dt><dd className="mono">true</dd></div>}
    </dl>
  );
}

// --- load / empty states (VF19) ----------------------------------------------------------------------

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {hint && <p className="empty-hint">{hint}</p>}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="empty"><p className="empty-title">Loading {what}…</p><p className="empty-hint">Reading the local legion viewer API.</p></div>;
}

/** The unreachable / failed-read strip. It NAMES the failure and says how old what you are looking
 * at is; it never blanks the screen and never re-renders stale data as fresh. */
export function ErrorStrip({ error, at, onRetry }: { error: string; at: number | null; onRetry?: () => void }) {
  return (
    <div className="sync-strip" role="alert">
      <span>
        {error}
        {at != null
          ? <> — showing the last successful read from {new Date(at).toLocaleTimeString()}; nothing here is guessed.</>
          : <> — nothing has been read yet.</>}
      </span>
      {onRetry && <button className="btn" onClick={onRetry}>Retry now</button>}
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="sect">
      <header className="sect-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

// --- time -------------------------------------------------------------------------------------------

/** Relative to the REAL clock. `null` renders an em dash: an absent timestamp is absent, and
 * "just now" for a missing value is the guess H02 forbids. */
export const rel = (iso: string | null) => {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso; // an unparseable recorded value is shown VERBATIM, never dropped
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 0) return 'in the future';
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}h ${min % 60}m ago` : `${Math.floor(h / 24)}d ago`;
};

export const exactTime = (iso: string | null) => {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString();
};

export function RelTime({ iso }: { iso: string | null }) {
  if (!iso) return <>—</>;
  return <time dateTime={iso} title={exactTime(iso)}>{rel(iso)}</time>;
}

/** A DURATION the server measured, in human units. This is FORMATTING, not arithmetic over the
 * population: the number arrives from `/api/insights` and is divided by 1000/60/60 to be readable.
 * No average, no percentage and no ratio is computed anywhere on this client (H01). */
export const fmtDuration = (ms: number | null) => {
  if (ms == null) return '—';
  const min = ms / 60000;
  if (min < 1) return `${Math.round(ms / 1000)}s`;
  if (min < 60) return `${Math.round(min)}m`;
  const h = min / 60;
  return h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`;
};
