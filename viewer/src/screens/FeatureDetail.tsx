// FeatureDetail — one feature, in four tabs: Overview / Artifacts / Activity / Changes.
//
// FOUR TABS, NOT FIVE. legion2 had a Diagnostics tab tailing the driver's stream-json log; legion3
// has no driver and no log, and the operator dropped VF11 outright (c13 kickoff). There is no
// placeholder for it, because a tab that says "unavailable" teaches that the data exists somewhere.
//
// EVERY CONTROL IS GONE, AND ITS ABSENCE IS STRUCTURAL. legion2's version rendered run controls
// (retry / abandon / reconcile / stop / resume) from server-supplied action descriptors, a steering
// composer, an answer form and a recovery panel. None of that is disabled here — the descriptors
// are not in the DTO, the mutation methods are not on the data source, and the routes do not exist
// on the server. Orchestration lives in the session (PLAN-V3 decision 12a).
//
// APPROVALS RENDER AS RECORDED. The panel shows `{at, subjectHash}` — what tasks.json stores — under
// the server's own caveat string, and beside it, separately labelled, the kernel's LIVE verdict from
// `lifecycleNow.approvalsValidNow`, which was computed by CALLING approvalValid on this request. The
// two are never merged into one green tick: a recorded approval is a fact about a hash at a moment,
// and whether it still binds is a comparison the kernel performs at the moment of use.
//
// THE OPEN-QUESTION LIST READS `answer === null`. That is not a client-side status rule — it is the
// predicate the kernel's own manifest format defines and hooks/session-start.mjs prints from, and
// the projection already counted it into `attention`. The count comes from the server; the TEXT of
// each question comes from `tasksDetail[].answers`, because a queue of ids is not actionable.
//
// GIT IS READ ONLY IN THIS VIEW, and only when the Changes tab is opened. The cross-feature feed is
// manifest-only by design (a `git log` per feature per poll is how a read-only viewer becomes a
// load source), so commits and diffs are fetched here, lazily, per feature.
import { useEffect, useMemo, useState } from 'react';
import type {
  ActivityKind, CommitsResponse, DiffFileRow, DiffResponse, FeatureId, FeatureDetailView, FeatureView,
  Loaded, TaskDetail, UnreadableRow, ViewerDataSource,
} from '../data/types';
import { ACTIVITY_KINDS, isUnreadable, mrRef } from '../data/types';
import {
  ApprovalsCaveat, AttentionRow, Empty, LifecycleNowPanel, Loading, RawStatusNote, ReceiptBadge,
  ReceiptDetail, RelTime, Section, Spine, StatusPill, exactTime,
} from '../components/ui';
import { Markdown } from '../components/Markdown';
import { artifactUrl, isHtml, isMarkdown, isServableImage, resolveArtifactPath } from '../lib/artifact-url.mjs';
import { clipNote, clipRows, diffSummary, fileStatus, parsePatch } from '../lib/diff-view.mjs';
import { getHighlighter, langOfPath } from '../lib/highlight';
import { safeHref } from '../lib/safe-href.mjs';

const TABS = ['Overview', 'Artifacts', 'Activity', 'Changes'] as const;
type Tab = (typeof TABS)[number];

/** A dossier that would not parse still gets a page — the same honest "here is why" the inventory
 * row shows, never an error boundary and never a blank feature (H02 / H06). */
function UnreadablePage({ row, onBack }: { row: UnreadableRow; onBack: () => void }) {
  return (
    <>
      <button className="btn btn-ghost" onClick={onBack}>← Operations</button>
      <div className="mission-head" style={{ margin: '0.5rem 0 1rem' }}>
        <div>
          <h1 className="detail-title">{row.label}</h1>
          <p className="mission-sub">This dossier could not be read.</p>
        </div>
        <div className="mission-right"><StatusPill status="unreadable" /></div>
      </div>
      <div className="card" style={{ borderColor: 'var(--bad-fg)' }}>
        <p style={{ marginTop: 0 }}>The read failed with:</p>
        <p className="mono unreadable-why">{row.why}</p>
      </div>
    </>
  );
}

// --- Overview -----------------------------------------------------------------------------------

function openQuestions(view: FeatureView): { task: TaskDetail; index: number }[] {
  const out: { task: TaskDetail; index: number }[] = [];
  for (const t of view.tasksDetail) {
    t.answers.forEach((a, i) => { if (a.answer === null) out.push({ task: t, index: i }); });
  }
  return out;
}

/** THE GATE-POLICY PIN IS TIER-KEYED, AND THIS RETURNS A STRING BECAUSE OF IT. `feature start`
 * writes `commandPolicyHash: {task, boundary}` (kernel/state.mjs commandPolicyPin) and the
 * projection passes it through verbatim, so handing the field straight to JSX rendered an OBJECT as
 * a React child — error #31, the whole screen into the boundary, on every readable feature.
 *
 * The tiers are read OFF THE RECORDED OBJECT, never from a client-side tier list: GATE_TIERS is the
 * kernel's, and a copy here would be a second vocabulary. Anything that is not a tier map (a
 * hand-written manifest, an older dossier that recorded a bare string) renders AS TEXT rather than
 * reaching React as an object — one unusual field must not cost the operator the page. Hashes are
 * sha256; they are truncated for the line and the ellipsis says so. */
function policyPins(pins: FeatureView['commandPolicyHash']): string {
  if (pins === null || pins === undefined) return '—';
  if (typeof pins !== 'object') return String(pins);
  const entries = Object.entries(pins as Record<string, unknown>);
  if (entries.length === 0) return '—';
  return entries
    .map(([tier, hash]) => {
      const h = String(hash);
      return `${tier} ${h.length > 16 ? `${h.slice(0, 16)}…` : h}`;
    })
    .join(' · ');
}

function OverviewTab({ view }: { view: FeatureView }) {
  const questions = openQuestions(view);
  const approvalKinds = Object.keys(view.approvals);
  const validNow = view.lifecycleNow.available ? view.lifecycleNow.approvalsValidNow : null;

  return (
    <>
      <RawStatusNote
        viewerStatus={view.viewerStatus} kernelStatus={view.kernelStatus}
        stage={view.stage} stageKnown={view.stageKnown}
      />

      {view.attention.length > 0 && (
        <Section title="Attention">
          <div className="card"><ul className="attn-list">{view.attention.map((a, i) => <AttentionRow key={i} a={a} />)}</ul></div>
        </Section>
      )}

      {questions.length > 0 && (
        <Section title={`Open questions (${questions.length})`}>
          <div className="card">
            {questions.map(({ task, index }) => (
              <div key={`${task.id}-${index}`} className="qrow">
                <span className="chip">{task.id}</span>
                <div>
                  <p className="qrow-prompt">{task.answers[index].question ?? '(no question text was recorded)'}</p>
                  <p className="mission-sub" style={{ margin: 0 }}>recorded <RelTime iso={task.answers[index].at} /></p>
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      <Section title="Stages">
        <div className="card">
          <Spine view={view} />
        </div>
      </Section>

      <Section title="The kernel's verdict, right now">
        <div className="card"><LifecycleNowPanel now={view.lifecycleNow} /></div>
      </Section>

      <Section title="Progress — milestones and tasks">
        {view.milestones.length === 0 ? (
          <div className="card"><p className="muted" style={{ margin: 0 }}>
            {view.hasPlan ? 'The plan records no tasks.' : 'No plan has been imported yet — tasks.json does not exist.'}
          </p></div>
        ) : view.milestones.map((m) => (
          <div key={String(m.id)} className="card">
            <div className="mission-head">
              <div>
                <strong>{m.id ?? '(no milestone)'}</strong>
                <p className="mission-sub">
                  {m.tasks.done}/{m.tasks.total} done · {m.tasks.started} started · {m.tasks.pending} pending
                </p>
              </div>
              <div className="mission-right">
                {m.closeReviews.length === 0
                  ? <span className="chip">no close review recorded</span>
                  : m.closeReviews.map((r, i) => (
                    <span key={i} className={`verdict-badge verdict-${r.verdict === 'pass' ? 'pass' : 'fail'}`}>{r.role}: {r.verdict}</span>
                  ))}
              </div>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Task</th><th>Status</th><th>Attempt</th><th>Depends on</th><th>Gate receipt</th><th>Done</th></tr></thead>
                <tbody>
                  {view.tasksDetail.filter((t) => t.milestone === m.id).map((t) => (
                    <tr key={String(t.id)}>
                      <td><span className="mono">{t.id}</span> {t.title}</td>
                      <td className="mono">{t.status ?? '—'}</td>
                      <td className="mono">{t.attempt ?? '—'}</td>
                      <td className="mono">{t.depends_on.length ? t.depends_on.join(', ') : '—'}</td>
                      <td><ReceiptBadge receipt={t.receipt} what={`task ${t.id}`} /></td>
                      <td><RelTime iso={t.doneAt} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
      </Section>

      <Section title="Approvals — recorded">
        <div className="card">
          <ApprovalsCaveat caveat={view.approvalsCaveat} />
          {approvalKinds.length === 0 ? <p className="muted" style={{ margin: 0 }}>No approval is recorded for this feature.</p> : (
            <div className="tbl-wrap">
              <table className="tbl">
                <thead><tr><th>Decision</th><th>Recorded at</th><th>Subject hash</th><th>The kernel, asked just now</th></tr></thead>
                <tbody>
                  {approvalKinds.map((k) => (
                    <tr key={k}>
                      <td className="mono">{k}</td>
                      <td>{exactTime(view.approvals[k].at)}</td>
                      <td className="mono">{view.approvals[k].subjectHash?.slice(0, 16) ?? '—'}</td>
                      <td>
                        {validNow === null
                          ? <span className="chip">not asked — the predicates were unavailable</span>
                          : validNow[k]
                            ? <span className="verdict-badge verdict-pass">still binds</span>
                            : <span className="verdict-badge verdict-fail">does not bind now</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Section>

      <Section title="Sessions and freshness">
        <div className="card">
          <dl className="kv">
            <div><dt>last manifest write</dt><dd>{exactTime(view.updatedAt)} (<RelTime iso={view.updatedAt} />)</dd></div>
            <div><dt>last session recorded</dt><dd className="mono">{view.sessions.current ?? '—'}</dd></div>
            <div><dt>sessions recorded</dt><dd className="mono">{view.sessions.history.length}</dd></div>
            <div><dt>worktree</dt><dd className="mono">{view.worktree.path ?? '—'} {view.worktree.present ? '' : '(absent)'}</dd></div>
            <div><dt>command policy</dt><dd className="mono">{policyPins(view.commandPolicyHash)}</dd></div>
          </dl>
        </div>
      </Section>

      {view.initiative && (
        <Section title="Initiative">
          <div className="card">
            <dl className="kv">
              <div><dt>id</dt><dd className="mono">{view.initiative.id}</dd></div>
              {view.initiative.role && <div><dt>role</dt><dd className="mono">{String(view.initiative.role)}</dd></div>}
              {view.initiative.primary && <div><dt>primary</dt><dd className="mono">{String(view.initiative.primary)}</dd></div>}
            </dl>
          </div>
        </Section>
      )}
    </>
  );
}

// --- Artifacts ------------------------------------------------------------------------------------

function ArtifactDigest({ source, id, kind, path }: {
  source: ViewerDataSource; id: FeatureId; kind: string; path: string;
}) {
  const [state, setState] = useState<Loaded<string>>({ state: 'loading' });
  useEffect(() => {
    const ac = new AbortController();
    setState({ state: 'loading' });
    source.artifactText(id, path, ac.signal)
      .then((text) => { if (!ac.signal.aborted) setState({ state: 'ok', data: text, at: Date.now() }); })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setState({ state: 'error', error: e instanceof Error ? e.message : String(e), last: null, at: null });
      });
    return () => ac.abort();
  }, [source, id.org, id.project, id.name, path]);

  if (state.state === 'loading') return <p className="muted">Loading {kind}…</p>;
  if (state.state === 'error') {
    return <p className="dq dq-partial" role="note">Could not read <span className="mono">{path}</span> — {state.error}</p>;
  }
  return (
    <div className="digest">
      <Markdown
        text={state.data}
        resolveHref={(ref) => {
          const rel = resolveArtifactPath(path, ref);
          return rel === null ? null : artifactUrl(id, rel);
        }}
      />
    </div>
  );
}

function ArtifactsTab({ view, id, source }: { view: FeatureView; id: FeatureId; source: ViewerDataSource }) {
  // The server emits artifacts in the kernel's lifecycle order (projection.mjs artifactsOf),
  // recorded entries and conventional drafts alike — the picker renders that order and holds
  // no kind list of its own.
  const kinds = Object.keys(view.artifacts);
  const [picked, setPicked] = useState<string | null>(null);
  const sel = picked !== null && kinds.includes(picked) ? picked
    : kinds.includes('spec') ? 'spec' : kinds[0] ?? null;
  const a = sel === null ? null : view.artifacts[sel];
  const path = a?.path ?? '';
  return (
    <>
      <Section title="Artifacts">
        {sel === null || a === null ? <div className="card"><p className="muted" style={{ margin: 0 }}>No artifact is recorded or drafted for this feature.</p></div> : (
          <>
            <div className="searchrow" role="tablist" aria-label="pick an artifact">
              {kinds.map((k) => (
                <button key={k} role="tab" aria-selected={k === sel} className={`btn ${k === sel ? 'btn-option' : ''}`} onClick={() => setPicked(k)}>{k}{view.artifacts[k].recorded ? '' : ' · draft'}</button>
              ))}
            </div>
            <div className="card">
              <div className="mission-head">
                <p className="mission-sub" style={{ margin: 0 }}>
                  <span className="mono">{path || '(no path recorded)'}</span>
                  {a.recorded
                    ? <> · recorded <RelTime iso={a.at} /> · hash <span className="mono">{a.hash ? a.hash.slice(0, 12) : '—'}</span></>
                    : <> · draft — not yet recorded</>}
                </p>
                <div className="mission-right">
                  {a.inside
                    ? <a className="chip" href={artifactUrl(id, path)} target="_blank" rel="noopener noreferrer">open raw</a>
                    : <span className="chip" title="recorded outside the dossier — the viewer serves dossier files only">outside the dossier</span>}
                </div>
              </div>
              {!a.inside ? (
                <p className="muted" style={{ margin: 0 }}>Recorded outside the dossier — not served here; the path above is the pointer.</p>
              ) : isMarkdown(path) ? (
                <ArtifactDigest source={source} id={id} kind={sel} path={path} />
              ) : isServableImage(path) ? (
                <img className="preview-img" src={artifactUrl(id, path)} alt={`${sel} artifact`} loading="lazy" />
              ) : isHtml(path) ? (
                // sandbox here AND in the server's CSP on the response — two layers, because
                // "open raw" bypasses this attribute entirely; never allow-same-origin, the one
                // token that would hand model-authored HTML the viewer's API. key remounts the
                // frame per document — mutating src on a live iframe pushes joint history
                // entries and hijacks Back.
                <iframe key={path} className="preview-frame" sandbox="allow-scripts allow-forms allow-popups allow-modals" src={artifactUrl(id, path)} title={`${sel} mock`} />
              ) : (
                <p className="muted" style={{ margin: 0 }}>Not markdown or a servable image — open it raw above.</p>
              )}
            </div>
          </>
        )}
      </Section>

      <Section title="Review verdicts">
        {view.reviews.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>No review verdict is recorded.</p></div> : (
          <div className="card tbl-wrap" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>Role</th><th>Verdict</th><th>Subject</th><th>Recorded</th></tr></thead>
              <tbody>
                {view.reviews.map((r, i) => (
                  <tr key={i}>
                    <td className="mono">{r.role ?? '—'}</td>
                    <td><span className={`verdict-badge verdict-${r.verdict === 'pass' ? 'pass' : 'fail'}`}>{r.verdict ?? '—'}</span></td>
                    <td className="mono">{r.subject ?? '—'}</td>
                    <td><RelTime iso={r.at} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

    </>
  );
}

// --- Activity ---------------------------------------------------------------------------------------

/** The feed grouped into lifecycle chapters: everything between one `stage-enter` and the next
 * belongs to that stage's span. Entries before the first enter (feature start, the first session)
 * open the timeline. Durations come from the two boundary timestamps and nothing else. */
type StageSpan = { stage: string | null; enteredAt: string | null; completedAt: string | null; entries: FeatureView['activity'] };

function stageSpans(activity: FeatureView['activity']): StageSpan[] {
  const spans: StageSpan[] = [];
  let cur: StageSpan = { stage: null, enteredAt: null, completedAt: null, entries: [] };
  for (const a of activity) {
    if (a.kind === 'stage-enter') {
      if (cur.entries.length > 0 || cur.stage !== null) spans.push(cur);
      const stage = a.label.replace(/^entered stage\s+/, '');
      cur = { stage, enteredAt: a.at, completedAt: null, entries: [] };
      continue;
    }
    if (a.kind === 'stage-complete') {
      // The first stage is entered at creation, so its span has no `stage-enter` — name it from
      // the completion entry rather than leaving the chapter untitled.
      if (cur.stage === null) cur.stage = a.label.replace(/^completed stage\s+/, '');
      cur.completedAt = a.at;
      continue;
    }
    cur.entries.push(a);
  }
  spans.push(cur);
  return spans;
}

function spanDuration(from: string | null, to: string | null): string | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return null;
  const m = Math.round(ms / 60_000);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

const shortTime = (iso: string) => iso.slice(5, 16).replace('T', ' ');

function ActivityTab({ view }: { view: FeatureView }) {
  const present = ACTIVITY_KINDS.filter((k) => view.activity.some((a) => a.kind === k));
  const [hidden, setHidden] = useState<Set<ActivityKind>>(new Set());
  const toggle = (k: ActivityKind) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });
  const spans = stageSpans(view.activity);

  return (
    <Section title="Timeline">
      <div className="searchrow" role="group" aria-label="filter activity by kind">
        {present.map((k) => (
          <button key={k} className={`btn ${hidden.has(k) ? '' : 'btn-option'}`} aria-pressed={!hidden.has(k)} onClick={() => toggle(k)}>{k}</button>
        ))}
      </div>
      {view.activity.length === 0 ? (
        <div className="card"><p className="muted" style={{ margin: 0 }}>Nothing is recorded yet.</p></div>
      ) : spans.map((s, si) => {
        const rows = s.entries.filter((a) => !hidden.has(a.kind));
        const dur = spanDuration(s.enteredAt, s.completedAt);
        return (
          <div key={si} className="card" style={{ padding: '0.5rem 1rem' }}>
            <div className="mission-head" style={{ marginBottom: rows.length ? '0.35rem' : 0 }}>
              <div>
                <strong>{s.stage ?? 'started'}</strong>
                <p className="mission-sub" style={{ margin: 0 }}>
                  {s.enteredAt && <>entered {shortTime(s.enteredAt)}</>}
                  {s.completedAt
                    ? <> · <strong>completed {shortTime(s.completedAt)}</strong>{dur && <> ({dur})</>}</>
                    : s.stage !== null && <> · open</>}
                </p>
              </div>
              {s.completedAt
                ? <span className="verdict-badge verdict-pass">done</span>
                : s.stage !== null && <span className="chip">in progress</span>}
            </div>
            {rows.map((a, i) => (
              <div key={i} className="feed-line">
                <span className="console-ts mono" title={exactTime(a.at)}>{shortTime(a.at)}</span>
                <span className="chip act-kind">{a.kind}</span>
                <span>{a.label}</span>
              </div>
            ))}
          </div>
        );
      })}
    </Section>
  );
}

// --- Changes ------------------------------------------------------------------------------------------

function PatchPane({ diff, path }: { diff: DiffResponse; path: string }) {
  // Coloring is per-line with the FILE's grammar (hljs, lazy chunk — lib/highlight.ts). A line is
  // less context than a real parser wants, so a string spanning lines may miscolor — accepted:
  // the text itself is always exact, the colors are advisory. Until the chunk lands (or for an
  // unmapped extension) lines render plain — content first, coloring when it arrives.
  const lang = langOfPath(path);
  const [hl, setHl] = useState<((code: string) => string | null) | null>(null);
  useEffect(() => {
    if (!lang) { setHl(null); return; }
    let dead = false;
    getHighlighter()
      .then((h) => { if (!dead && h.has(lang)) setHl(() => (code: string) => h.highlight(code, lang)); })
      .catch(() => { /* chunk unavailable: plain text stays */ });
    return () => { dead = true; };
  }, [lang]);

  // The row ELEMENTS are memoised, not just the strings: the detail view polls every 3s and each
  // re-render with fresh `{__html}` literals would re-write every line's innerHTML (the Markdown
  // component's rule 1, same lesson). Stable elements let React bail out of the whole table.
  const body = useMemo(() => {
    if (!diff.available) return null;
    const clip = clipRows(parsePatch(diff.diff));
    const sign = (k: string) => (k === 'add' ? '+' : k === 'del' ? '-' : k === 'hunk' ? '' : ' ');
    const rows = clip.rows.map((r, i) => {
      const html = hl !== null && r.kind !== 'hunk' ? hl(r.text) : null;
      return (
        <tr key={i} className={`diff-row diff-${r.kind}`}>
          <td className="diff-ln" aria-hidden="true">{r.oldNo ?? ''}</td>
          <td className="diff-ln" aria-hidden="true">{r.newNo ?? ''}</td>
          <td className="diff-code">{sign(r.kind)}{html !== null
            ? <span dangerouslySetInnerHTML={{ __html: html }} />
            : r.text}</td>
        </tr>
      );
    });
    return { clip, rows };
  }, [diff, hl]);

  if (!diff.available) return <p className="muted">No diff — {diff.reason}</p>;
  if (body === null || body.clip.total === 0) return <p className="muted">git printed no hunks for this file in this range.</p>;
  const note = clipNote(body.clip, path);
  return (
    <div className="diff-pane tbl-wrap">
      <table className="diff-table">
        <tbody>{body.rows}</tbody>
      </table>
      {note && <p className="diff-truncation" role="note">{note}</p>}
    </div>
  );
}

function FileDiff({ source, id, path }: { source: ViewerDataSource; id: FeatureId; path: string }) {
  const [state, setState] = useState<Loaded<DiffResponse>>({ state: 'loading' });
  useEffect(() => {
    const ac = new AbortController();
    setState({ state: 'loading' });
    source.diff(id, path, ac.signal)
      .then((d) => { if (!ac.signal.aborted) setState({ state: 'ok', data: d, at: Date.now() }); })
      .catch((e: unknown) => {
        if (ac.signal.aborted) return;
        setState({ state: 'error', error: e instanceof Error ? e.message : String(e), last: null, at: null });
      });
    return () => ac.abort();
  }, [source, id.org, id.project, id.name, path]);
  if (state.state === 'loading') return <p className="muted">Loading the diff for {path}…</p>;
  if (state.state === 'error') return <p className="dq dq-partial" role="note">{state.error}</p>;
  return <PatchPane diff={state.data} path={path} />;
}

/** The changed-file tree, GitLab-review-shaped: directories collapsible, files selectable. */
type DirNode = { name: string; path: string; dirs: DirNode[]; files: DiffFileRow[] };

function buildTree(files: DiffFileRow[]): DirNode {
  const root: DirNode = { name: '', path: '', dirs: [], files: [] };
  for (const f of files) {
    const parts = f.path.split('/');
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let next = node.dirs.find((d) => d.name === part);
      if (!next) {
        next = { name: part, path: node.path ? `${node.path}/${part}` : part, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(f);
  }
  return root;
}

function ChangedFiles({ files, id, source }: { files: DiffResponse & { available: true }; id: FeatureId; source: ViewerDataSource }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const list = files.files;
  const selected = picked !== null && list.some((f) => f.path === picked) ? picked : list[0]?.path ?? null;
  const selRow = list.find((f) => f.path === selected);
  const tree = buildTree(list);
  const toggleDir = (p: string) => setCollapsed((c) => {
    const next = new Set(c);
    if (next.has(p)) next.delete(p); else next.add(p);
    return next;
  });

  const renderNode = (node: DirNode, depth: number): React.ReactNode => (
    <>
      {node.dirs.map((d) => (
        <div key={d.path}>
          <button
            className="difftree-dir"
            style={{ paddingLeft: `${depth * 0.8}rem` }}
            aria-expanded={!collapsed.has(d.path)}
            onClick={() => toggleDir(d.path)}
          >
            <span className="difftree-chevron" aria-hidden="true">{collapsed.has(d.path) ? '▸' : '▾'}</span>
            <span className="mono">{d.name}/</span>
          </button>
          {!collapsed.has(d.path) && renderNode(d, depth + 1)}
        </div>
      ))}
      {node.files.map((f) => {
        const st = fileStatus(f.status);
        return (
          <button
            key={f.path}
            className="difftree-file"
            style={{ paddingLeft: `${depth * 0.8}rem` }}
            aria-current={f.path === selected}
            title={f.path}
            onClick={() => setPicked(f.path)}
          >
            <span className={`diff-status diff-status-${st.cls}`} aria-label={st.label}>{st.code}</span>
            <span className="diff-path mono">{f.path.split('/').pop()}</span>
          </button>
        );
      })}
    </>
  );

  return (
    <div className="card" style={{ padding: '0.5rem 0.75rem' }}>
      <p className="mission-sub diff-totals" style={{ marginTop: 0 }}>{diffSummary(files)}</p>
      <div className="diff-layout">
        <nav className="diff-tree" aria-label="changed files">{renderNode(tree, 0)}</nav>
        <div className="diff-content">
          {selected !== null && selRow && (
            <>
              <div className="diff-content-head">
                <span className={`diff-status diff-status-${fileStatus(selRow.status).cls}`} aria-hidden="true">{fileStatus(selRow.status).code}</span>
                <span className="diff-path mono">{selected}</span>
              </div>
              <FileDiff source={source} id={id} path={selected} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ChangesTab({ view, id, source }: { view: FeatureView; id: FeatureId; source: ViewerDataSource }) {
  const [commits, setCommits] = useState<Loaded<CommitsResponse>>({ state: 'loading' });
  const [files, setFiles] = useState<Loaded<DiffResponse>>({ state: 'loading' });
  const mrHref = safeHref(view.mr?.url);

  useEffect(() => {
    const ac = new AbortController();
    setCommits({ state: 'loading' });
    setFiles({ state: 'loading' });
    source.commits(id, ac.signal)
      .then((c) => { if (!ac.signal.aborted) setCommits({ state: 'ok', data: c, at: Date.now() }); })
      .catch((e: unknown) => { if (!ac.signal.aborted) setCommits({ state: 'error', error: e instanceof Error ? e.message : String(e), last: null, at: null }); });
    source.diff(id, null, ac.signal)
      .then((d) => { if (!ac.signal.aborted) setFiles({ state: 'ok', data: d, at: Date.now() }); })
      .catch((e: unknown) => { if (!ac.signal.aborted) setFiles({ state: 'error', error: e instanceof Error ? e.message : String(e), last: null, at: null }); });
    return () => ac.abort();
  }, [source, id.org, id.project, id.name]);

  return (
    <>
      <Section title="Delivery">
        <div className="card">
          <dl className="kv">
            <div><dt>branch</dt><dd className="mono">{view.branch ?? '—'}</dd></div>
            <div><dt>base</dt><dd className="mono">{view.baseBranch ?? '—'} @ {view.baseSha ? view.baseSha.slice(0, 12) : '—'}</dd></div>
            <div><dt>{view.mr?.forge === 'github' ? 'pull request' : 'merge request'}</dt><dd>{view.mr
              ? (mrHref
                ? <a className="mono" href={mrHref} target="_blank" rel="noopener noreferrer">{mrRef(view.mr)} {mrHref}</a>
                : <span className="mono">{mrRef(view.mr)} (the recorded url is not an http(s) address, so it is not linked)</span>)
              : <span className="muted">none recorded</span>}</dd></div>
            <div><dt>ticket</dt><dd className="mono">{view.ticket ?? '—'}</dd></div>
          </dl>
        </div>
      </Section>

      <Section title="Boundary gate receipt">
        <div className="card">
          <div className="mission-head">
            <div><strong>The certificate this tree carries</strong></div>
            <div className="mission-right"><ReceiptBadge receipt={view.boundaryReceipt} what="boundary" /></div>
          </div>
          <ReceiptDetail receipt={view.boundaryReceipt} />
          {view.boundaryReceipt.weak && (
            <p className="caveat" role="note">
              <strong>TIER-0 ONLY.</strong> 0 declared commands — not a full gate run and must not be read as one.
            </p>
          )}
        </div>
      </Section>

      <Section title="Commits">
        <p className="mission-sub" style={{ marginTop: 0 }}>
          <span className="mono">{view.baseSha ? `${view.baseSha.slice(0, 12)}..HEAD` : '—'}</span> · squashed per milestone
        </p>
        {commits.state === 'loading' ? <Loading what="commits" />
          : commits.state === 'error' ? <div className="card"><p className="dq dq-partial" role="note">{commits.error}</p></div>
            : !commits.data.available ? <div className="card"><p className="muted" style={{ margin: 0 }}>No commits could be read — {commits.data.reason}</p></div>
              : commits.data.commits.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>
                Nothing has been committed on this branch yet — this feature is in <span className="mono">{view.stage ?? 'an unknown stage'}</span>.
              </p></div>
                : (
                  <div className="card tbl-wrap" style={{ padding: 0 }}>
                    <table className="tbl">
                      <thead><tr><th>SHA</th><th>When</th><th>Subject</th></tr></thead>
                      <tbody>{commits.data.commits.map((c) => (
                        <tr key={c.sha}>
                          <td className="mono">{c.sha.slice(0, 12)}</td>
                          <td><RelTime iso={c.at} /></td>
                          <td>{c.subject}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                )}
      </Section>

      <Section title="Changed files">
        {files.state === 'loading' ? <Loading what="the file list" />
          : files.state === 'error' ? <div className="card"><p className="dq dq-partial" role="note">{files.error}</p></div>
            : !files.data.available ? <div className="card"><p className="muted" style={{ margin: 0 }}>No diff could be read — {files.data.reason}</p></div>
              : files.data.files.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>
                No file differs from the base yet — this feature is in <span className="mono">{view.stage ?? 'an unknown stage'}</span>.
              </p></div>
                : <ChangedFiles files={files.data} id={id} source={source} />}
      </Section>
    </>
  );
}

// --- the screen ---------------------------------------------------------------------------------------

export function FeatureDetail({ view, id, source, onBack }: {
  view: FeatureDetailView;
  id: FeatureId;
  source: ViewerDataSource;
  onBack: () => void;
}) {
  const [tab, setTab] = useState<Tab>('Overview');
  if (isUnreadable(view)) return <UnreadablePage row={view} onBack={onBack} />;

  const onTabKey = (e: React.KeyboardEvent, i: number) => {
    const n = TABS.length;
    const j = e.key === 'ArrowRight' ? (i + 1) % n
      : e.key === 'ArrowLeft' ? (i - 1 + n) % n
        : e.key === 'Home' ? 0
          : e.key === 'End' ? n - 1 : -1;
    if (j < 0) return;
    e.preventDefault();
    setTab(TABS[j]);
  };

  return (
    <>
      <button className="btn btn-ghost" onClick={onBack}>← Operations</button>
      <div className="mission-head" style={{ margin: '0.5rem 0 1rem' }}>
        <div>
          <h1 className="detail-title">{view.name}</h1>
          <p className="mission-sub">
            <span className="mono">{view.org}/{view.project}</span> · profile <span className="mono">{view.profile ?? '—'}</span>
            {view.branch && <> · <span className="mono">{view.branch}</span></>}
            {view.ticket && <> · ticket <span className="mono">{view.ticket}</span></>}
          </p>
        </div>
        <div className="mission-right"><StatusPill status={view.viewerStatus} /></div>
      </div>

      <div className="tabs" role="tablist" aria-label="feature detail sections">
        {TABS.map((t, i) => (
          <button
            key={t}
            id={`tab-${t}`}
            role="tab"
            aria-selected={tab === t}
            aria-controls="detail-panel"
            tabIndex={tab === t ? 0 : -1}
            onKeyDown={(e) => onTabKey(e, i)}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="detail-panel" aria-labelledby={`tab-${tab}`} tabIndex={0}>
        {tab === 'Overview' && <OverviewTab view={view} />}
        {tab === 'Artifacts' && <ArtifactsTab view={view} id={id} source={source} />}
        {tab === 'Activity' && <ActivityTab view={view} />}
        {tab === 'Changes' && <ChangesTab view={view} id={id} source={source} />}
      </div>
    </>
  );
}

/** Exported for the Gallery, which renders the honest empty detail without a data source. */
export const DetailNotFound = ({ what }: { what: string }) => (
  <Empty title="Feature not found here" hint={`${what} — it may have been closed and cleaned, or the address is stale.`} />
);
