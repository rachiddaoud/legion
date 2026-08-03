// App — the shell, the hash router, and THE POLL LOOP. Ported from legion2's App with the data
// boundary re-pointed and three behaviours deliberately changed.
//
// 1. NO FIXTURE FALLBACK ON A FAILED PROBE. legion2 probed `/api/health` and, if it failed, quietly
//    constructed a FixtureDataSource — so an unreachable server rendered a fabricated world that
//    looked exactly like a real one. That is the defect VIEWER-REVIEW H02 exists about. Here the
//    live source is used unless `?fixtures` was asked for EXPLICITLY, and an unreachable server
//    renders the unreachable state, by name, with the time of the last successful read.
//
// 2. FRESHNESS IS POLLING, AND THE INTERVALS ARE NAMED. legion3 has no event log and no SSE
//    (src/cli/_viewer/activity.mjs's header says why), and the server is stateless — it recomputes
//    per request. So: the inventory every 5s, the open feature every 3s, and BOTH PAUSED while
//    `document.hidden`, because a background tab polling a local server forever is a load source
//    with no reader. Coming back to the tab fetches immediately rather than waiting out the timer.
//
// 3. NO START-FEATURE BUTTON, NO BELL, NO WATCHDOG STRIP, NO SCENARIO-DRIVEN MUTATIONS. VF01's
//    shell is retained minus the Start affordance; VF17's notification bell was dropped (the ntfy
//    Notification hook is the channel); the watchdog does not exist in legion3. The `#/intake`
//    routes are gone with the screen — a route that 404s into Operations would still be a URL an
//    operator could bookmark and expect something from.
//
// ONE SCREEN CRASHING MUST NOT TAKE DOWN THE SHELL. The error boundary is ported verbatim in
// spirit: it resets on navigation, and it says which screen died rather than blanking the page.
import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FixtureDataSource } from './data/FixtureDataSource';
import { LegionDataSource } from './data/LegionDataSource';
import type {
  ActivityResponse, FeatureId, FeatureResponse, FeaturesResponse, Health, InsightsResponse, Loaded,
  ViewerDataSource,
} from './data/types';
import { keyOfId, loadedData } from './data/types';
import { SCENARIOS } from './data/fixtures';
import { ErrorStrip, Loading } from './components/ui';
import { Operations } from './screens/Operations';
import { Features } from './screens/Features';
import { FeatureDetail } from './screens/FeatureDetail';
import { Insights } from './screens/Insights';
import { Gallery } from './screens/Gallery';

/** THE two poll intervals, named (header). Both are paused while the tab is hidden. */
export const FEATURES_POLL_MS = 5000;
export const DETAIL_POLL_MS = 3000;
/** The cross-feature feed's page. The server caps it too; asking for less than it will give is the
 * client saying what it can render, not a second truncation rule. */
const ACTIVITY_LIMIT = 100;

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * ONE polled read. `key` identifies WHAT is being read: when it changes the state resets to
 * loading, because the previous answer was about something else. When a poll FAILS the last good
 * data is kept and the error is reported beside it — never blanked, and never re-rendered as fresh.
 */
function usePoll<T>(key: string, load: (signal: AbortSignal) => Promise<T>, intervalMs: number, enabled: boolean) {
  const [state, setState] = useState<Loaded<T>>({ state: 'loading' });
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const seenKey = useRef<string | null>(null);

  useEffect(() => {
    if (seenKey.current !== key) { seenKey.current = key; setState({ state: 'loading' }); }
    if (!enabled) return;
    let alive = true;
    let timer: number | undefined;
    let ac: AbortController | null = null;

    const schedule = () => { if (alive) timer = window.setTimeout(tick, intervalMs); };
    const tick = async () => {
      if (!alive) return;
      if (document.hidden) { schedule(); return; } // paused, not polled and not guessed
      ac = new AbortController();
      try {
        const data = await loadRef.current(ac.signal);
        if (alive) setState({ state: 'ok', data, at: Date.now() });
      } catch (e) {
        if (alive && !ac.signal.aborted) {
          setState((prev) => ({
            state: 'error',
            error: msg(e),
            last: loadedData(prev),
            at: prev.state === 'ok' ? prev.at : prev.state === 'error' ? prev.at : null,
          }));
        }
      }
      schedule();
    };

    void tick();
    const onVisible = () => {
      if (document.hidden) return;
      window.clearTimeout(timer);
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      window.clearTimeout(timer);
      ac?.abort();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, intervalMs, enabled, nonce]);

  return [state, useCallback(() => setNonce((n) => n + 1), [])] as const;
}

function useHash() {
  const [hash, setHash] = useState(window.location.hash || '#/operations');
  useEffect(() => {
    const on = () => setHash(window.location.hash || '#/operations');
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
}

const nav = (to: string) => { window.location.hash = to; };
const detailHash = (id: FeatureId) =>
  `#/features/${encodeURIComponent(id.org)}/${encodeURIComponent(id.project)}/${encodeURIComponent(id.name)}`;

/** One screen crashing must not take down the shell — the boundary resets on navigation. */
class ScreenBoundary extends Component<{ resetKey: string; children: ReactNode }, { err: Error | null }> {
  state: { err: Error | null } = { err: null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.err) this.setState({ err: null });
  }
  render() {
    if (this.state.err) {
      return (
        <div className="card" role="alert" style={{ borderColor: 'var(--bad-fg)' }}>
          <strong>This screen crashed.</strong>
          <p className="mission-sub">{String(this.state.err.message || this.state.err)}</p>
          <button className="btn" onClick={() => this.setState({ err: null })}>Reload panel</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  const hash = useHash();
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const wantFixtures = params.has('fixtures');
  const [scenario, setScenario] = useState(params.get('fixtures') || 'active');
  const [theme, setTheme] = useState<string>(() => localStorage.getItem('legion-viewer-theme') ?? 'light');

  // The source is chosen ONCE, EXPLICITLY (header): live unless fixtures were asked for.
  const source: ViewerDataSource = useMemo(
    () => (wantFixtures ? new FixtureDataSource(scenario) : new LegionDataSource()),
    [wantFixtures, scenario],
  );

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('legion-viewer-theme', theme);
  }, [theme]);

  const route = useMemo(() => {
    const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    if (parts[0] === 'features' && parts.length >= 4) {
      return {
        screen: 'detail' as const,
        id: {
          org: decodeURIComponent(parts[1]),
          project: decodeURIComponent(parts[2]),
          name: decodeURIComponent(parts[3]),
        },
      };
    }
    if (['operations', 'features', 'insights', 'gallery'].includes(parts[0])) {
      return { screen: parts[0] as 'operations' | 'features' | 'insights' | 'gallery', id: null };
    }
    return { screen: 'operations' as const, id: null };
  }, [hash]);

  const sourceKey = `${source.mode}:${scenario}`;

  const [health] = usePoll<Health>(
    `health:${sourceKey}`, (s) => source.health(s), 30_000, true,
  );
  const [features, retryFeatures] = usePoll<FeaturesResponse>(
    `features:${sourceKey}`, (s) => source.features(s), FEATURES_POLL_MS, true,
  );
  const [activity] = usePoll<ActivityResponse>(
    `activity:${sourceKey}`, (s) => source.activity(ACTIVITY_LIMIT, s), FEATURES_POLL_MS,
    route.screen === 'operations',
  );
  const [insights] = usePoll<InsightsResponse>(
    `insights:${sourceKey}`, (s) => source.insights(s), FEATURES_POLL_MS,
    route.screen === 'insights',
  );
  const detailKey = route.id ? keyOfId(route.id) : '';
  const routeId = route.id;
  const [detail, retryDetail] = usePoll<FeatureResponse>(
    `feature:${sourceKey}:${detailKey}`,
    (s) => (routeId ? source.feature(routeId, s) : Promise.reject(new Error('no feature selected'))),
    DETAIL_POLL_MS,
    routeId !== null,
  );

  const featuresData = loadedData(features);
  const detailData = loadedData(detail);
  const attention = featuresData
    ? [...featuresData.summaries, ...featuresData.unreadable]
      .filter((r) => r.attention.some((a) => a.kind !== 'quiet')).length
    : 0;

  return (
    <div className="shell">
      {source.mode === 'fixture' && (
        <div className="sim-banner" role="note">
          Fixture data — nothing below was read from a legion home. The viewer is read-only in every mode; this mode
          simply has no server behind it.
        </div>
      )}
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="topbar">
        <span className="brand"><span className="brand-dot" aria-hidden="true" />Legion</span>
        <nav className="nav" aria-label="primary">
          <a href="#/operations" className={route.screen === 'operations' || route.screen === 'detail' ? 'active' : ''}>
            Operations{attention > 0 ? ` (${attention})` : ''}
          </a>
          <a href="#/features" className={route.screen === 'features' ? 'active' : ''}>Features</a>
          <a href="#/insights" className={route.screen === 'insights' ? 'active' : ''}>Insights</a>
        </nav>
        <span className="topbar-spacer" />
        <button className="btn btn-ghost" onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')} aria-label="toggle theme">
          {theme === 'light' ? '◐' : '◑'}<span className="theme-label"> {theme === 'light' ? 'dark' : 'light'}</span>
        </button>
        <span className="conn" title={health.state === 'ok' ? `legion home ${health.data.legionHome}` : undefined}>
          {source.mode === 'fixture'
            ? 'fixtures'
            : health.state === 'ok' ? 'read-only · loopback' : health.state === 'loading' ? 'connecting…' : 'unreachable'}
        </span>
      </header>

      {source.mode === 'fixture' && (
        <div className="scenario-bar" role="group" aria-label="fixture scenario">
          <label>Scenario</label>
          {SCENARIOS.map((s) => (
            <button key={s} className={scenario === s ? 'on' : ''} onClick={() => { setScenario(s); nav('#/operations'); }}>{s}</button>
          ))}
          <a href="#/gallery" style={{ marginLeft: 'auto' }} className="chip">component gallery</a>
        </div>
      )}

      {features.state === 'error' && (
        <ErrorStrip error={features.error} at={features.at} onRetry={retryFeatures} />
      )}
      {route.screen === 'detail' && detail.state === 'error' && (
        <ErrorStrip error={detail.error} at={detail.at} onRetry={retryDetail} />
      )}

      <main className="main" id="main">
        <ScreenBoundary resetKey={hash}>
          {route.screen === 'gallery' ? <Gallery />
            : route.screen === 'insights' ? (
              insights.state === 'loading' ? <Loading what="insights" />
                : loadedData(insights) ? <Insights data={loadedData(insights)!} />
                  : <ErrorStrip error={insights.state === 'error' ? insights.error : 'insights were not read'} at={null} />
            )
              : route.screen === 'detail' ? (
                detail.state === 'loading' ? <Loading what={detailKey} />
                  : detailData ? <FeatureDetail view={detailData.feature} id={route.id!} source={source} onBack={() => nav('#/operations')} />
                    : <Loading what={detailKey} />
              )
                : featuresData === null ? <Loading what="the feature inventory" />
                  : route.screen === 'features' ? <Features features={featuresData} onOpen={(id) => nav(detailHash(id))} />
                    : <Operations features={featuresData} activity={loadedData(activity)} onOpen={(id) => nav(detailHash(id))} />}
        </ScreenBoundary>
      </main>
    </div>
  );
}
