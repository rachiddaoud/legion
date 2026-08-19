// merged-sweep.mjs — SessionStart hook, the ONE thing in legion that notices a merge.
//
// THE GAP IT CLOSES. `legion finalize` opens the MR/PR and records it; then the feature session
// ends and nothing ever learns that a human merged it. `legion state close delivered` is never
// run, `legion feature clean` refuses (closed features only) and the worktree lives forever.
// NO PUSH CHANNEL CAN FIX THAT, and the reason is structural rather than missing work: a webhook,
// a GitHub Action on `pull_request: closed`, a GitLab merge job — all of them run ON THE FORGE,
// and the worktree is on this machine. So the merge must be PULLED, and the only question worth
// arguing about is WHEN.
//
// WHY SessionStart IN THE MAIN REPO, and not the obvious place. The obvious place is the feature
// worktree — but after finalize nobody ever opens a session there again; that is the whole point
// of being finished. A sweep bound to the feature would fire exactly where it is useless. This
// hook therefore resolves the PROJECT from the payload cwd (never a feature) and sweeps every
// feature of it, so it fires where an operator actually is on the day after the merge: the
// repository they went back to work in.
//
// IT DOES NOT BLOCK THE SESSION, and that is a property of the MANIFEST, not of this file:
// hooks/hooks.json declares this entry `asyncRewake`, whose schema text in the 2.1.235 build is
// "If true, hook runs in background and wakes the model on exit code 2 (blocking error). Implies
// async." Backgrounding is decided in the harness's shared hook executor (`e.async ||
// e.asyncRewake`), not per event, so it applies to SessionStart — which is otherwise awaited
// during session init (the build times it as `hooks_init_ms`). A forge round-trip on the critical
// path of every session opening would be a tax nobody agreed to pay.
//
// THE TWO CHANNELS, and why exit 2 is the interesting one. On code 2 the build composes
// `${rewakeMessage} ${stderr || stdout}` and wakes the model with it, while `rewakeSummary` from
// the manifest is the single line shown to the OPERATOR in the terminal. That is the one place in
// this plugin where both audiences are reachable at once: the human sees that something is
// cleanable, the model receives the feature names and the exact next command. STDERR IS THE
// CHANNEL — `stderr || stdout` prefers it — and stdout is left for the harness's own JSON.
//
// FAIL-SAFE, and the list is deliberately short because everything here is a convenience:
//   - the payload cwd is not a registered legion project ⇒ exit 0, silent (this plugin loads in
//     every session; almost none of them are in a legion repo);
//   - the sweep printed nothing — nothing merged, no MR recorded, no CLI on PATH, offline ⇒
//     exit 0, silent. `legion feature merged` owns that judgement and stays quiet by design;
//   - the kernel could not run or refused ⇒ exit 0, silent. NOT A CONTRADICTION of the rule that
//     a kernel refusal is never swallowed: the other hooks surface refusals because their
//     commands are EVIDENCE (a receipt, a session record) whose loss changes what the session may
//     do. Nothing reads the result of this sweep. Waking the model to report that an optional
//     convenience did not run would be noise at the top of every session in a broken repo.
// The one LOUD path is the one that found something, and it is the only state change this hook
// can cause: a message.
//
// IT WRITES NOTHING ITSELF. `legion feature merged` is what asks the forge and what records
// `mr.merged` in feature.json — the kernel stays the writer, exactly as session-start.mjs records
// the session id through a typed op rather than touching the manifest.
import { existsSync } from 'node:fs';
import { readHookInput, runKernel } from './_common.mjs';

const input = readHookInput();
if (!input) process.exit(0);

// NOT resolveFeature(): that answers "which FEATURE is this session", and this hook fires in
// repositories where no feature session is running at all. The cwd only has to be a real
// directory the kernel can resolve a project from — `legion feature merged` refuses loudly on an
// unregistered repo, and that refusal is one of the silences above.
const cwd = typeof input.cwd === 'string' && existsSync(input.cwd) ? input.cwd : null;
if (!cwd) process.exit(0);

const r = runKernel(['feature', 'merged'], cwd);
if (r.code !== 0) process.exit(0);
const found = r.stdout.trim();
if (!found) process.exit(0);

process.stderr.write(`${found}\n`);
process.exit(2);
