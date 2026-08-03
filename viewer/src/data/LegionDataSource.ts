// LegionDataSource.ts — the live source: plain GET fetches against `legion viewer`'s read-only API.
//
// WHAT LEGION2 HAD HERE AND WHAT IS GONE. Its class carried an `EventSource`, a cursor map, a
// coalescing emit timer, a per-process CSRF token and a private `post()` that every mutation
// (`answer`, `control`, `steer`, `startIntake`, `startWatchdog`) went through. None of it is
// ported, and none of it can be re-enabled by a flag: there is no POST method on this class, no
// token field to send one with, and no server route to send it to (the method guard in
// src/cli/_viewer/server.mjs refuses everything but GET and HEAD before it routes). Deleting the
// orchestration surface is the reason this port exists (PLAN-V3 decision 12a).
//
// FRESHNESS IS POLLING, AND THE POLL LIVES IN App.tsx. This class holds NO timer, NO subscription
// and NO cached state — every method is one `fetch`, awaited, returning the server's JSON verbatim.
// legion3 has no event log to stream (src/cli/_viewer/activity.mjs's header says why), the server
// is stateless and recomputes per request, so a subscription would be a poll wearing a costume.
//
// ERRORS ARE VALUES, NOT SILENCE. Every failure — transport, non-2xx, unparseable body — is thrown
// with a message that names what was asked and what came back; the caller turns it into the honest
// `error` state that keeps the last good read on screen and says how old it is. legion2's
// `listRuns()` swallowed failures into `return []`, which renders an unreachable server as an empty
// machine; that is precisely the guess VIEWER-REVIEW H02 forbids and it is not carried over.
//
// TYPED DEGRADED READS ARE NOT ERRORS. `/api/commits` and `/api/diff` answer 200 with
// `{available:false, reason}` when a worktree was pruned — a recorded fact about a feature, not a
// failed request. They pass straight through, and the Changes tab renders the reason.
import type {
  ActivityResponse, CommitsResponse, DiffResponse, FeatureId, FeatureResponse, FeaturesResponse,
  Health, InsightsResponse, ViewerDataSource,
} from './types';

const idParams = (id: FeatureId) =>
  new URLSearchParams({ org: id.org, project: id.project, name: id.name });

/** The server's own error envelope: `{error: "..."}` on every refusal it composes. */
type ErrorBody = { error?: unknown };

export class LegionDataSource implements ViewerDataSource {
  readonly mode = 'live' as const;

  /** ONE read. `no-store` because the whole point is a fresh recompute; a conditional request that
   * hit a browser cache would render a poll interval as progress. */
  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(path, { method: 'GET', cache: 'no-store', signal });
    } catch (e) {
      if (signal?.aborted) throw e; // an aborted poll is not a failure — the caller discards it
      throw new Error(`cannot reach the legion viewer server (${path}): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      // The server's own message, verbatim where it sent one — it names the dossier, the path or
      // the parameter that was wrong, and rewriting that into "request failed" loses the answer.
      let detail = '';
      try {
        const body = (await res.json()) as ErrorBody;
        if (typeof body?.error === 'string') detail = ` — ${body.error}`;
      } catch { /* a non-JSON error body (a proxy, an early close): the status is the whole answer */ }
      throw new Error(`${path} answered ${res.status}${detail}`);
    }
    try {
      return (await res.json()) as T;
    } catch (e) {
      throw new Error(`${path} answered 200 with a body that is not JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  health(signal?: AbortSignal) { return this.get<Health>('/api/health', signal); }

  features(signal?: AbortSignal) { return this.get<FeaturesResponse>('/api/features', signal); }

  feature(id: FeatureId, signal?: AbortSignal) {
    return this.get<FeatureResponse>(`/api/feature?${idParams(id)}`, signal);
  }

  activity(limit: number, signal?: AbortSignal) {
    return this.get<ActivityResponse>(`/api/activity?limit=${encodeURIComponent(String(limit))}`, signal);
  }

  commits(id: FeatureId, signal?: AbortSignal) {
    return this.get<CommitsResponse>(`/api/commits?${idParams(id)}`, signal);
  }

  diff(id: FeatureId, file: string | null, signal?: AbortSignal) {
    const p = idParams(id);
    if (file != null && file !== '') p.set('file', file);
    return this.get<DiffResponse>(`/api/diff?${p}`, signal);
  }

  insights(signal?: AbortSignal) { return this.get<InsightsResponse>('/api/insights', signal); }

  /** Artifact bodies are TEXT, not JSON — `/api/artifact` serves the dossier file with its own
   * content-type, and a markdown digest must arrive as the bytes the model wrote. */
  async artifactText(id: FeatureId, path: string, signal?: AbortSignal): Promise<string> {
    const url = this.artifactHref(id, path);
    let res: Response;
    try {
      res = await fetch(url, { method: 'GET', cache: 'no-store', signal });
    } catch (e) {
      if (signal?.aborted) throw e;
      throw new Error(`cannot reach the legion viewer server: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as ErrorBody;
        if (typeof body?.error === 'string') detail = ` — ${body.error}`;
      } catch { /* the status stands alone */ }
      throw new Error(`${path} answered ${res.status}${detail}`);
    }
    return res.text();
  }

  artifactHref(id: FeatureId, path: string): string {
    const p = idParams(id);
    p.set('path', path);
    return `/api/artifact?${p}`;
  }
}
