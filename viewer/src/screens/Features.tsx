// Features — the searchable/filterable/sortable inventory (VF04) with lifecycle separation.
//
// THE GROUPS ARE THE SERVER'S ENUM, ONE GROUP PER MEMBER, in a fixed reading order. That is the
// whole of the "lifecycle separation": there is no client-side predicate deciding what counts as
// active, because `viewerStatus` already decided it in the one module that is allowed to
// (src/cli/_viewer/projection.mjs). An enum member with no features renders no group; an enum
// member this file did not anticipate could not exist, since the list below IS the server's.
//
// UNREADABLE ROWS RENDER DISTINCTLY AND CARRY THEIR REASON (H06 / VIEWER-REVIEW). They get their
// own group at the END — a corrupt dossier is not an outcome, it is a broken read — with the
// parser's own message shown verbatim in monospace. They are never dropped and never merged into
// "unknown", which means something different: a manifest that PARSED and said something this
// kernel does not write.
//
// SORTING AND SEARCHING ARE PRESENTATION. `updated` sorts on the server's `updatedAt` (the mtime
// fact), `name` on the key, `stage` on the recorded stage string. No sort derives a rank of its
// own — the two-level task numbers shown in the table are the server's counts, verbatim.
import { useMemo, useState } from 'react';
import type { FeatureId, FeatureRow, FeaturesResponse, ViewerStatus } from '../data/types';
import { VIEWER_STATUSES, idOfKey, isUnreadable } from '../data/types';
import { Empty, RelTime, Section, StatusPill } from '../components/ui';

/** Reading order: what needs you, what is moving, what is closed, what could not be placed. Every
 * member of the server's enum appears exactly once — `VIEWER_STATUSES` is asserted to match. */
const GROUP_ORDER: ViewerStatus[] = ['blocked', 'init-failed', 'active', 'delivered', 'abandoned', 'unknown', 'unreadable'];

const GROUP_TITLE: Record<ViewerStatus, string> = {
  blocked: 'Blocked — an open question is recorded',
  'init-failed': 'Initialization failed',
  active: 'Active',
  delivered: 'Delivered',
  abandoned: 'Abandoned',
  unknown: 'Unknown — the manifest says something this kernel does not write',
  unreadable: 'Unreadable — the dossier would not parse',
};

type Sort = 'updated' | 'name' | 'stage';

export function Features({ features, onOpen }: { features: FeaturesResponse; onOpen: (id: FeatureId) => void }) {
  const [q, setQ] = useState('');
  const [project, setProject] = useState('all');
  const [sort, setSort] = useState<Sort>('updated');

  const rows: FeatureRow[] = useMemo(
    () => [...features.summaries, ...features.unreadable],
    [features],
  );
  const projects = useMemo(
    () => ['all', ...new Set(features.summaries.map((s) => `${s.org}/${s.project}`))],
    [features],
  );

  const filtered = rows.filter((r) => {
    const inProject = project === 'all' || (!isUnreadable(r) && `${r.org}/${r.project}` === project);
    const text = isUnreadable(r) ? `${r.label} ${r.why}` : `${r.key} ${r.stage ?? ''} ${r.profile ?? ''} ${r.branch ?? ''} ${r.ticket ?? ''}`;
    return inProject && (q === '' || text.toLowerCase().includes(q.toLowerCase()));
  });

  const sorted = [...filtered].sort((a, b) => {
    if (sort === 'name') return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    if (sort === 'stage') {
      const sa = isUnreadable(a) ? '' : a.stage ?? '';
      const sb = isUnreadable(b) ? '' : b.stage ?? '';
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    }
    const ta = isUnreadable(a) ? 0 : Date.parse(a.updatedAt ?? '') || 0;
    const tb = isUnreadable(b) ? 0 : Date.parse(b.updatedAt ?? '') || 0;
    return tb - ta;
  });

  return (
    <>
      <div className="searchrow">
        <input
          className="input" style={{ maxWidth: 340 }} placeholder="Search features…"
          value={q} onChange={(e) => setQ(e.target.value)} aria-label="search features"
        />
        {projects.map((p) => (
          <button key={p} className={`btn ${project === p ? 'btn-option' : ''}`} onClick={() => setProject(p)}>{p}</button>
        ))}
        <span className="topbar-spacer" />
        <label className="chip" htmlFor="sort">sort</label>
        <select id="sort" className="input" style={{ maxWidth: '9em' }} value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
          <option value="updated">last write</option>
          <option value="name">name</option>
          <option value="stage">stage</option>
        </select>
      </div>

      <p className="muted" style={{ marginTop: 0 }}>
        {features.population.readable} readable · {features.population.unreadable} unreadable ·{' '}
        {features.population.features} registered on this machine.
      </p>

      {sorted.length === 0 && <Empty title="No feature matches" hint="Adjust the search, or clear the project filter." />}

      {GROUP_ORDER.map((status) => {
        const group = sorted.filter((r) => r.viewerStatus === status);
        if (group.length === 0) return null;
        return (
          <Section key={status} title={`${GROUP_TITLE[status]} (${group.length})`}>
            <div className="card tbl-wrap" style={{ padding: 0 }}>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Feature</th><th>Status</th><th>Stage</th><th>Profile</th>
                    <th>Tasks</th><th>Open Q</th><th>Last manifest write</th>
                  </tr>
                </thead>
                <tbody>
                  {group.map((r) => {
                    if (isUnreadable(r)) {
                      const id = idOfKey(r.key);
                      return (
                        <tr key={r.key} className="row-unreadable">
                          <td>
                            {id
                              ? <button className="mission-name" onClick={() => onOpen(id)}>{r.label}</button>
                              : <span className="mission-name mission-name-dead">{r.label}</span>}
                            <div className="unreadable-why mono">{r.why}</div>
                          </td>
                          <td><StatusPill status="unreadable" /></td>
                          <td colSpan={5} className="muted">
                            No other field is shown for this row — the manifest did not parse, so there is nothing
                            recorded here that could be rendered honestly.
                          </td>
                        </tr>
                      );
                    }
                    return (
                      <tr key={r.key} className="click" onClick={() => onOpen({ org: r.org, project: r.project, name: r.name })}>
                        <td>
                          <button className="mission-name" onClick={(e) => { e.stopPropagation(); onOpen({ org: r.org, project: r.project, name: r.name }); }}>{r.name}</button>
                          <div className="chip">{r.org}/{r.project}</div>
                          {r.initiative?.id && <div className="chip">initiative {r.initiative.id}</div>}
                        </td>
                        <td><StatusPill status={r.viewerStatus} /></td>
                        <td className="mono">{r.stage ?? '—'}{r.stageKnown ? '' : ' (unknown)'}</td>
                        <td className="mono">{r.profile ?? '—'}</td>
                        <td className="mono">{r.hasPlan ? `${r.tasks.done}/${r.tasks.total}` : 'no plan'}</td>
                        <td className="mono">{r.tasks.openQuestions || '—'}</td>
                        <td className="mono"><RelTime iso={r.updatedAt} /></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Section>
        );
      })}

      {GROUP_ORDER.length !== VIEWER_STATUSES.length && (
        <p className="dq dq-partial" role="alert">
          This build knows {GROUP_ORDER.length} status groups and the server reports {VIEWER_STATUSES.length} —
          rebuild the viewer bundle.
        </p>
      )}
    </>
  );
}
