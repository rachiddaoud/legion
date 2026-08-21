// Insights (VF18) — the numbers from `/api/insights`, RENDERED VERBATIM.
//
// THERE IS EXACTLY ONE STATS FORMULA IN THIS CODEBASE AND IT IS NOT HERE (VIEWER-REVIEW H01). The
// server's `insights()` is the formula; this screen formats what it returns — milliseconds into
// hours, a record into table rows — and computes no average, no percentage, no ratio and no
// percentile of its own. legion2's Insights screen already obeyed that rule for `legion stats`;
// keeping it is the whole reason the projection owns the arithmetic.
//
// EVERY NUMBER SHOWS ITS DENOMINATOR. `n` travels with each percentile because over a dozen
// features a p90 is the largest of a handful of numbers, and a percentile without its population is
// the number H01 was written about. The exclusion counts are shown for the same reason: a duration
// sample of 2 out of 6 features is honest only if the 4 that were excluded are visible.
//
// MONEY IS ABSENT AND STAYS ABSENT, WITH NO PLACEHOLDER. No rate is recorded anywhere, so a cost is
// the one number this screen could only invent, and a tile reading "—" would imply a value that
// could arrive. TOKEN COUNTS ARE THE OPPOSITE CASE: the transcripts record them, the server
// distributes them over the tasks, and the four figures are four rows — never summed into one here.
import type { InsightsResponse, Stats, TokenStats, ViewerStatus } from '../data/types';
import { STATUS_LABELS, VIEWER_STATUSES } from '../data/types';
import { Section, fmtDuration, fmtTokens } from '../components/ui';

function StatsRow({ label, s }: { label: string; s: Stats }) {
  return (
    <tr>
      <td className="mono">{label}</td>
      <td className="mono">{s.n}</td>
      <td className="mono">{fmtDuration(s.p50Ms)}</td>
      <td className="mono">{fmtDuration(s.p90Ms)}</td>
      <td className="mono">{fmtDuration(s.minMs)}</td>
      <td className="mono">{fmtDuration(s.maxMs)}</td>
    </tr>
  );
}

function TokenStatsRow({ label, s }: { label: string; s: TokenStats }) {
  return (
    <tr>
      <td className="mono">{label}</td>
      <td className="mono">{s.n}</td>
      <td className="mono">{fmtTokens(s.p50)}</td>
      <td className="mono">{fmtTokens(s.p90)}</td>
      <td className="mono">{fmtTokens(s.min)}</td>
      <td className="mono">{fmtTokens(s.max)}</td>
    </tr>
  );
}

export function Insights({ data }: { data: InsightsResponse }) {
  const stages = Object.keys(data.stageDuration);
  const attempts = Object.entries(data.attempts.distribution);

  return (
    <>
      <div className="tiles">
        {VIEWER_STATUSES.filter((s: ViewerStatus) => data.outcomes[s] > 0).map((s) => (
          <div className="tile" key={s}>
            <div className="tile-label">{STATUS_LABELS[s]}</div>
            <div className="tile-value">{data.outcomes[s]}</div>
            <div className="tile-note">of {data.population.features} features</div>
          </div>
        ))}
        <div className="tile">
          <div className="tile-label">Closed in {data.recentOutcomes.windowDays}d</div>
          <div className="tile-value">{data.recentOutcomes.features.length}</div>
          <div className="tile-note">{data.recentOutcomes.delivered} delivered · {data.recentOutcomes.abandoned} abandoned</div>
        </div>
      </div>

      <Section title="Feature duration — first recorded stage to close">
        <div className="card tbl-wrap" style={{ padding: 0 }}>
          <table className="tbl">
            <thead><tr><th>Measure</th><th>n</th><th>p50</th><th>p90</th><th>min</th><th>max</th></tr></thead>
            <tbody><StatsRow label="feature" s={data.featureDuration} /></tbody>
          </table>
        </div>
        <p className="mission-sub">
          Excluded: {data.featureDuration.excluded.noStart} without a recorded start · {data.featureDuration.excluded.noEnd} still
          open · {data.featureDuration.excluded.negative} with end before start.
        </p>
      </Section>

      <Section title="Stage duration — measured between consecutive recorded stage entries">
        {stages.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>No feature has recorded two stage entries yet.</p></div> : (
          <div className="card tbl-wrap" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>Stage</th><th>n</th><th>p50</th><th>p90</th><th>min</th><th>max</th></tr></thead>
              <tbody>{stages.map((s) => <StatsRow key={s} label={s} s={data.stageDuration[s]} />)}</tbody>
            </table>
          </div>
        )}
        <p className="mission-sub">Open (current) stages are not measured.</p>
      </Section>

      <Section title="Task attempts">
        {attempts.length === 0 ? <div className="card"><p className="muted" style={{ margin: 0 }}>No task is recorded yet.</p></div> : (
          <div className="card tbl-wrap" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>Attempt</th><th>Tasks</th></tr></thead>
              <tbody>{attempts.map(([k, n]) => (
                <tr key={k}><td className="mono">{k}</td><td className="mono">{n}</td></tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="mission-sub">
          {data.attempts.tasks} task{data.attempts.tasks === 1 ? '' : 's'} across {data.attempts.features} readable
          feature{data.attempts.features === 1 ? '' : 's'}.
        </p>
      </Section>

      <Section title="Review rounds — a fail followed by a re-judgement">
        <div className="card">
          <dl className="kv">
            <div><dt>features with reviews</dt><dd className="mono">{data.reviewRounds.features}</dd></div>
            <div><dt>recorded verdicts</dt><dd className="mono">{data.reviewRounds.reviews}</dd></div>
            <div><dt>fix rounds</dt><dd className="mono">{data.reviewRounds.fixRounds}</dd></div>
            <div><dt>unresolved fails</dt><dd className="mono">{data.reviewRounds.unresolvedFails}</dd></div>
          </dl>
          <p className="mission-sub" style={{ marginBottom: 0 }}>
            One fix round = a fail with a later verdict for the same role and subject.
          </p>
        </div>
        {data.reviewRounds.byFeature.length > 0 && (
          <div className="card tbl-wrap" style={{ padding: 0 }}>
            <table className="tbl">
              <thead><tr><th>Feature</th><th>Verdicts</th><th>Fix rounds</th><th>Unresolved</th></tr></thead>
              <tbody>{data.reviewRounds.byFeature.map((f) => (
                <tr key={f.key}>
                  <td className="mono">{f.key}</td>
                  <td className="mono">{f.reviews}</td>
                  <td className="mono">{f.fixRounds}</td>
                  <td className="mono">{f.unresolvedFails}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </Section>

      <Section title="Tokens per task — what one task's dispatches recorded">
        {!data.taskTokens.available ? (
          <div className="card"><p className="muted" style={{ margin: 0 }}>{data.taskTokens.reason}</p></div>
        ) : (
          <>
            <div className="card tbl-wrap" style={{ padding: 0 }}>
              <table className="tbl">
                <thead><tr><th>Figure</th><th>n</th><th>p50</th><th>p90</th><th>min</th><th>max</th></tr></thead>
                <tbody>
                  <TokenStatsRow label="input" s={data.taskTokens.input} />
                  <TokenStatsRow label="output" s={data.taskTokens.output} />
                  <TokenStatsRow label="cache read" s={data.taskTokens.cacheRead} />
                  <TokenStatsRow label="cache write" s={data.taskTokens.cacheCreate} />
                </tbody>
              </table>
            </div>
            <p className="mission-sub">
              Over {data.taskTokens.features} feature{data.taskTokens.features === 1 ? '' : 's'} whose transcripts were
              read. Excluded: {data.taskTokens.excluded.noTranscript} with no transcript to
              read, holding {data.taskTokens.excluded.noTranscriptTasks} tasks
              · {data.taskTokens.excluded.noDispatch} tasks with no dispatch attributable to a recorded window. A
              coordinator session is per feature, not per task, and is in none of these rows.
            </p>
          </>
        )}
      </Section>
    </>
  );
}
