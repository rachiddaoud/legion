// notify.mjs — Notification hook: the ntfy push path, harvested from legion2
// src/capabilities/providers/notify-ntfy.mjs (PLAN-V3 decision 13).
//
// PLAN-V3 §Digest is explicit about what this is worth: "Mobile push is best-effort (Claude
// decides when to push); ntfy via Notification hook is the deterministic channel; ntfy cannot
// answer remotely". So: DETERMINISTIC that it fires when the session blocks, BEST-EFFORT that
// the phone ever sees it, and LOAD-BEARING FOR NOTHING. No decision anywhere in legion reads
// the result of this hook. A dead topic, an offline laptop or a 500 from the relay changes
// no state and blocks no flow — which is why every failure path below still exits 0.
//
// VALIDATED AGAINST CLAUDE CODE 2.1.219. Facts read out of that build:
//   - Notification input is {message, title?, notification_type, session_id, cwd, …}.
//   - the matcher is compared against notification_type, whose enum in this build is
//     permission_prompt | idle_prompt | auth_success | elicitation_dialog |
//     elicitation_complete | elicitation_response | agent_needs_input | agent_completed.
//     The manifest subscribes to agent_needs_input|idle_prompt — the two that mean "a human
//     is being waited on", which is exactly the blocked state PLAN-V3 wants pushed.
//   - EXIT-CODE SEMANTICS: "Exit code 0 - stdout/stderr not shown". A Notification hook has
//     no channel back into the session at all, so there is nothing here to fail closed WITH;
//     saying so is more useful than pretending otherwise.
//
// PRIVACY, carried over verbatim from v2's provider: ntfy.sh is a PUBLIC relay. Unless the
// project config declares `notify.private` (a self-hosted server), the pushed body is an
// opaque feature id and a generic title — never the message text, never a question, never a
// path. The local dossier resolves an id into meaning; the notification channel never does.
//
// FAIL-SAFE (the complete list of silences, and it is three, not two): not a legion feature
// worktree; no notify topic configured; or a CORRUPT dossier — a push whose whole payload is a
// feature id cannot say anything true about a feature it could not read, and this hook has no
// channel back into the session, so there is nothing louder available to it than stderr. The
// corrupt case is handled EXPLICITLY rather than left to `projectConfig`'s try/catch, which used
// to swallow the resulting TypeError on `feature.org` and produce the right outcome for the wrong
// reason — safety by accident is not safety, and _common.mjs's contract says every caller of
// resolveFeature handles the discriminator before touching feature/tasks. SessionStart and
// SubagentStop are the hooks that make corruption loud where a human will see it.
import { projectConfig, readHookInput, resolveFeature } from './_common.mjs';

const TIMEOUT_MS = 4000; // a push must never hold a session's notification path open

const input = readHookInput();
if (!input) process.exit(0);

const resolved = resolveFeature(input);
if (!resolved) process.exit(0); // fail-safe: not a legion worktree
if (resolved.corrupt) {
  // Loud on the only channel this event has, then release: a notification about a feature whose
  // manifests are unreadable would be a claim this hook cannot support. `feature` is null here.
  // The prefix deliberately does NOT begin with the kernel binary's name followed by a word:
  // test/plugin-manifest.test.mjs reads any such pair in a shipped component as a router
  // invocation, so a log line that merely looks like one is a false claim that a matching kernel
  // command exists. (This comment is scanned too — as it should be, since a comment naming a
  // command that does not exist misleads a reader exactly as much as code does.)
  process.stderr.write(
    `notify hook: ${resolved.corrupt.what} at ${resolved.corrupt.path} is unreadable `
    + `(${resolved.corrupt.detail}) — no push sent. SessionStart/SubagentStop surface this in-session.\n`,
  );
  process.exit(0);
}
const { feature } = resolved;

// `legion project init --notify <topic>` records a bare topic string; an object form
// {topic|url, private?, tokenEnv?} is accepted too so a self-hosted server needs no kernel
// change. Anything else is treated as unconfigured.
const cfg = projectConfig(feature)?.notify ?? null;
const notify = typeof cfg === 'string' ? { topic: cfg } : (cfg && typeof cfg === 'object' ? cfg : null);
if (!notify || (!notify.topic && !notify.url)) process.exit(0); // fail-safe: push not configured

const url = notify.url || `https://ntfy.sh/${notify.topic}`;
const private_ = notify.private === true;
const title = private_
  ? `Legion ${feature.featureId} — ${input.notification_type ?? 'attention'}`
  : 'Legion: attention needed';
const body = private_
  ? String(input.message ?? '(no message)')
  : `feature ${feature.featureId} needs input`;

const headers = { Title: title, Priority: 'high', Tags: 'robot' };
// The token is read from the ENVIRONMENT by name; project.json records the variable name,
// never the secret (quality-rules: never write secrets into state or git).
if (notify.tokenEnv && process.env[notify.tokenEnv]) {
  headers.Authorization = `Bearer ${process.env[notify.tokenEnv]}`;
}

try {
  await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
} catch {
  // Best-effort by contract: a failed push is not an event, not a state change, and not
  // something to report into a session that has no channel to receive it.
}
process.exit(0);
