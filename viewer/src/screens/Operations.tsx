// Operations — the default destination (VF02): what needs me → what has gone quiet → what closed
// recently → what was recorded lately.
//
// THE QUEUE IS THE SERVER'S. Every row below comes from an `attention[]` entry the projection
// computed; this screen groups them by feature and renders each one's recorded detail. It does not
// decide what deserves attention, and it cannot — legion2's Operations filtered on a client-side
// `ATTN` status set, which is exactly the second opinion about lifecycle the prohibitions forbid.
//
// QUIET IS ITS OWN LIST, LABELLED AS MANIFEST AGE. It is not in the actionable queue because
// nothing is asked of the operator by it: it is a subtraction over two file mtimes. Calling it
// "stalled" would claim an agent died, and no source in legion3 records whether one is alive.
//
// UNREADABLE DOSSIERS APPEAR HERE, not instead of everything else (H06). They arrive as their own
// rows carrying `unreadable-manifest`, so a corrupt dossier is one line in the queue while every
// healthy feature renders normally. A row whose key does not name three real segments is not
// clickable: the index entry it came from could not be addressed, and a link that 400s is worse
// than plain text.
//
// WHAT IS ABSENT AND WHY: legion2's "Live agents" fleet table (nothing records a live agent — VF12
// was dropped by the operator, and its session facts moved into the feature detail as RECORDED
// facts), the per-row Answer form, and the cost column.
import type { ActivityResponse, Attention, FeatureId, FeatureRow, FeaturesResponse } from '../data/types';
import { idOfKey, isActionable, isUnreadable, mrRef } from '../data/types';
import { AttentionRow, Empty, RelTime, Section, StatusPill } from '../components/ui';

const closedAtOf = (r: FeatureRow) => (isUnreadable(r) ? null : r.closedAt);

/** The feature's name as a button when it can be addressed, as plain text when it cannot. */
function FeatureLink({ row, onOpen }: { row: FeatureRow; onOpen: (id: FeatureId) => void }) {
  const text = isUnreadable(row) ? row.label : row.key;
  const id = isUnreadable(row) ? idOfKey(row.key) : { org: row.org, project: row.project, name: row.name };
  if (id === null) return <span className="mission-name mission-name-dead" title="this index entry does not name a feature this viewer can address">{text}</span>;
  return <button className="mission-name" onClick={(e) => { e.stopPropagation(); onOpen(id); }}>{text}</button>;
}

export function Operations({ features, activity, onOpen }: {
  features: FeaturesResponse;
  activity: ActivityResponse | null;
  onOpen: (id: FeatureId) => void;
}) {
  const rows: FeatureRow[] = [...features.summaries, ...features.unreadable];

  const withAttention = rows
    .map((r) => ({ row: r, flags: r.attention.filter(isActionable) }))
    .filter((x) => x.flags.length > 0);
  const quiet = rows
    .map((r) => ({ row: r, flags: r.attention.filter((a: Attention) => a.kind === 'quiet') }))
    .filter((x) => x.flags.length > 0);
  const closed = rows
    .filter((r) => !isUnreadable(r) && (r.viewerStatus === 'delivered' || r.viewerStatus === 'abandoned'))
    .sort((a, b) => (Date.parse(closedAtOf(b) ?? '') || 0) - (Date.parse(closedAtOf(a) ?? '') || 0));

  const open = (row: FeatureRow) => {
    const id = isUnreadable(row) ? idOfKey(row.key) : { org: row.org, project: row.project, name: row.name };
    if (id) onOpen(id);
  };

  return (
    <>
      <Section title={`Needs your attention${withAttention.length ? ` (${withAttention.length})` : ''}`}>
        {withAttention.length === 0 ? (
          <div className="card"><p className="muted" style={{ margin: 0 }}>All clear — no feature on this machine records an open question, a failed init or an unreadable manifest.</p></div>
        ) : withAttention.map(({ row, flags }) => (
          <article key={row.key} className="card click" onClick={() => open(row)}>
            <div className="mission-head">
              <div>
                <FeatureLink row={row} onOpen={onOpen} />
                <p className="mission-sub">
                  {isUnreadable(row)
                    ? 'this dossier could not be read'
                    : <>stage <span className="mono">{row.stage ?? '—'}</span> · <span className="mono">{row.profile ?? 'unclassified'}</span> · last manifest write <RelTime iso={row.updatedAt} /></>}
                </p>
              </div>
              <div className="mission-right"><StatusPill status={row.viewerStatus} /></div>
            </div>
            <ul className="attn-list">{flags.map((a, i) => <AttentionRow key={i} a={a} />)}</ul>
          </article>
        ))}
      </Section>

      <Section title={`Quiet — manifest age${quiet.length ? ` (${quiet.length})` : ''}`}>
        {quiet.length === 0 ? (
          <div className="card"><p className="muted" style={{ margin: 0 }}>No active feature has gone without a manifest write past the quiet threshold.</p></div>
        ) : (
          <div className="card" style={{ padding: '0.6rem 1rem' }}>
            {quiet.map(({ row, flags }) => (
              <div key={row.key} className="quiet-row">
                <FeatureLink row={row} onOpen={onOpen} />
                <ul className="attn-list">{flags.map((a, i) => <AttentionRow key={i} a={a} />)}</ul>
              </div>
            ))}
          </div>
        )}
      </Section>

      <Section title="Recent outcomes">
        {closed.length === 0 ? (
          <div className="card"><p className="muted" style={{ margin: 0 }}>No feature on this machine has been closed yet.</p></div>
        ) : (
          <div className="card tbl-wrap" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>Feature</th><th>Outcome</th><th>Closed</th><th>Tasks</th><th>MR</th></tr></thead>
              <tbody>
                {closed.slice(0, 12).map((r) => (
                  <tr key={r.key} className="click" onClick={() => open(r)}>
                    <td><FeatureLink row={r} onOpen={onOpen} /></td>
                    <td><StatusPill status={r.viewerStatus} /></td>
                    <td><RelTime iso={closedAtOf(r)} /></td>
                    <td className="mono">{isUnreadable(r) ? '—' : `${r.tasks.done}/${r.tasks.total}`}</td>
                    <td className="mono">{!isUnreadable(r) && r.mr ? mrRef(r.mr) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Recently recorded">
        {activity === null ? <Empty title="Activity has not been read yet" /> : activity.rows.length === 0 ? (
          <div className="card"><p className="muted" style={{ margin: 0 }}>Nothing is recorded in any manifest on this machine.</p></div>
        ) : (
          <div className="card" style={{ padding: '0.5rem 1rem' }}>
            <p className="mission-sub" style={{ marginTop: 0 }}>
              {activity.rows.length} of {activity.total} entries{activity.truncated ? ' (truncated)' : ''}
            </p>
            {activity.rows.slice(0, 25).map((a, i) => {
              const id = idOfKey(a.key);
              return (
                <div key={i} className="feed-line">
                  <span className="console-ts mono"><RelTime iso={a.at} /></span>
                  <span className="chip act-kind">{a.kind}</span>
                  {id
                    ? <button className="mission-name" onClick={() => onOpen(id)}>{a.key}</button>
                    : <span className="mission-name mission-name-dead">{a.key}</span>}
                  <span>{a.label}</span>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </>
  );
}
