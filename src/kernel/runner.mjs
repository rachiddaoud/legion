// runner.mjs — THE process seam for NON-GIT external tools (`glab`, `claude`, …).
// Exactly one such seam exists on purpose: `legion finalize` and `legion doctor` both probe
// the outside world, and two independent seams would drift in the two properties that matter
// (no shell, purged redirection env) exactly where nobody is looking.
//
// GIT IS EXPLICITLY REFUSED HERE. kernel/git.mjs is the ONLY door to git (its header E), and
// test/kernel/git-seam.audit.test.mjs enforces that as a class by scanning src/ for a literal
// `spawnSync('git', …)`. A GENERIC runner is a latent bypass of that scan — `run(file, args)`
// with file computed at runtime is invisible to a source scan — so the refusal is enforced
// here at RUNTIME instead: file === 'git' throws. (The comparison is not a call, so it cannot
// itself trip the audit regex.) Both callers inject a FAKE run(), so nothing in the suite
// would execute this module by accident: test/kernel/runner.test.mjs drives it directly, and
// the audit file itself asserts the refusal, since a control that is only prose is no control.
//
// NO SHELL, EVER: spawnSync with an argv array. Nothing here interpolates a string command,
// so no quoting/word-splitting question exists to get wrong.
//
// ENVIRONMENT: process.env MINUS every name in GIT_REDIRECT_VARS. This is not git paranoia
// leaking into non-git code — `glab` resolves the GitLab project from the git remote of its
// cwd, so an ambient GIT_DIR (git itself exports one when running hooks) aims it at a
// DIFFERENT repository. That is the
// same hazard finalize's header documents, closed in one place. Everything else survives —
// PATH and GITLAB_TOKEN in particular, without which every probe is a false negative.
//
// NON-THROWING BY CONSTRUCTION: the result is always an object, never an exception, because
// the CALLER classifies the outcome and the classifications differ. doctor maps a missing
// binary to `fail` and an API error to `warn`; finalize maps every non-zero to a loud throw.
// A seam that threw would force both to reconstruct the distinction from a message string.
// `spawnError` is the spawn-level failure (ENOENT ⇒ the binary is absent, ETIMEDOUT ⇒ killed
// at timeoutMs); `code`/`signal`/`stdout`/`stderr` describe a process that did start.
import { spawnSync } from 'node:child_process';
import { GIT_REDIRECT_VARS } from './git.mjs';

/** Default: generous enough for a slow API round trip, short enough that a hung probe cannot
 * wedge a workflow forever. Callers override per probe. */
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 8 * 1024 * 1024;

/** process.env with the repo/index/object REDIRECTION variables removed (header). */
export function runnerEnv(base = process.env) {
  const env = { ...base };
  for (const k of GIT_REDIRECT_VARS) delete env[k];
  return env;
}

/**
 * Run `file` with argv `args`, capturing stdout/stderr. Never uses a shell; never throws for
 * a failed command (see header).
 * @returns {{ok: boolean, code: number|null, signal: string|null, stdout: string,
 *            stderr: string, spawnError: string|null}}
 */
export function runCapture(file, args = [], { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  if (file === 'git') {
    throw new Error(
      'kernel/runner.mjs must never spawn git — use kernel/git.mjs (pinned config + purged GIT_* env). '
      + 'This runner is the seam for glab/claude only.',
    );
  }
  const r = spawnSync(file, args, {
    cwd,
    env: env ?? runnerEnv(),
    encoding: 'utf8',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  });
  return {
    ok: r.error == null && r.status === 0,
    code: r.status ?? null,
    signal: r.signal ?? null,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    spawnError: r.error ? (r.error.code ?? r.error.message) : null,
  };
}

/** The object injected as `deps.run` in production. A named factory (rather than passing
 * runCapture around) keeps the injection site identical in shape to the fakes tests build. */
export function realRunner() {
  return { run: runCapture };
}
