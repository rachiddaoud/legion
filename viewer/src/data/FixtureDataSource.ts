// FixtureDataSource.ts — the deterministic source. Same interface, same DTOs, no server.
//
// WHAT LEGION2's FIXTURE SOURCE DID AND THIS ONE CANNOT. Its version was a small state machine:
// `answer()` resolved questions, `control()` transitioned runs, `startIntake()` drove a scripted
// journey — SIMULATED mutations, honestly labelled, but mutations, because the UI they backed had
// controls. This UI has none, the ViewerDataSource interface has no mutation method, and so this
// class is a lookup table with an artificial failure mode. That is the whole diff, and it is the
// point (PLAN-V3 decision 12a).
//
// THE 'unreachable' SCENARIO IS A FEATURE. Every method rejects with the message the live source
// composes on a transport failure, so the honest "cannot reach the server, showing the last read"
// path is reachable in the Gallery and in a browser test without stopping a real process.
import { FIXTURE_ARTIFACTS, WORLDS } from './fixtures';
import type {
  ActivityResponse, CommitsResponse, DiffResponse, FeatureId, FeatureResponse, FeaturesResponse,
  Health, InsightsResponse, ViewerDataSource,
} from './types';

const UNREACHABLE = 'cannot reach the legion viewer server (fixture scenario "unreachable")';

export class FixtureDataSource implements ViewerDataSource {
  readonly mode = 'fixture' as const;
  private scenario: string;

  constructor(scenario = 'active') { this.scenario = scenario; }

  setScenario(s: string) { this.scenario = s; }
  currentScenario() { return this.scenario; }

  private world() {
    if (this.scenario === 'unreachable') throw new Error(UNREACHABLE);
    return WORLDS[this.scenario] ?? WORLDS.active;
  }

  private async ok<T>(value: () => T): Promise<T> { return value(); }

  async health(): Promise<Health> {
    this.world();
    return { ok: true, v: 1, mode: 'fixture', legionHome: '/tmp/legion-home (fixture)', readOnly: true, methods: ['GET', 'HEAD'] };
  }

  features(): Promise<FeaturesResponse> { return this.ok(() => this.world().features); }

  feature(id: FeatureId): Promise<FeatureResponse> {
    return this.ok(() => {
      const key = `${id.org}/${id.project}/${id.name}`;
      const w = this.world();
      const found = w.views[key];
      if (found) return { v: 1, feature: found };
      const row = w.features.unreadable.find((u) => u.key === key);
      // A key that is in neither table is what the server answers 404 for; the honest client-side
      // equivalent is a rejection, not an empty page that looks like a feature with no content.
      if (!row) throw new Error(`/api/feature answered 404 — no such feature '${key}'`);
      return { v: 1, feature: row };
    });
  }

  activity(limit: number): Promise<ActivityResponse> {
    return this.ok(() => {
      const a = this.world().activity;
      return { ...a, rows: a.rows.slice(0, limit), limit, truncated: a.rows.length > limit };
    });
  }

  commits(): Promise<CommitsResponse> { return this.ok(() => this.world().commits); }

  diff(_id: FeatureId, file: string | null, rev: string | null): Promise<DiffResponse> {
    return this.ok(() => {
      const d = this.world().diff;
      if (!d.available) return { ...d, rev };
      const files = rev === null ? d.files : d.files.slice(1);
      return { ...d, file, rev, files };
    });
  }

  insights(): Promise<InsightsResponse> { return this.ok(() => this.world().insights); }

  artifactText(_id: FeatureId, path: string): Promise<string> {
    return this.ok(() => {
      this.world();
      const text = FIXTURE_ARTIFACTS[path];
      if (text === undefined) throw new Error(`${path} answered 404 — no artifact '${path}' in this fixture dossier`);
      return text;
    });
  }

  /** Fixtures serve no bytes, so there is no image URL to hand out. null renders the reference as
   * text — the same honest fallback a real artifact recorded OUTSIDE its dossier gets. */
  artifactHref(): string | null { return null; }
}
