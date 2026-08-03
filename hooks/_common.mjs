// _common.mjs — the shared seam for legion's Claude Code hooks (four since T26 added the
// PreToolUse guard; hooks/pre-push.mjs is git's, not Claude Code's, and does not use this file
// — it must resolve its repository from cwd under the hardened git env instead, and importing a
// module that chdir()s to a payload cwd is the opposite of that). Not itself a hook (leading
// underscore: bin/legion.mjs's CMD_RE convention for "not invokable"; nothing dispatches it).
//
// FORMAT VALIDATED AGAINST CLAUDE CODE 2.1.219 (binary at
// ~/.local/share/claude/versions/2.1.219). Every claim below was read out of that build,
// not out of memory:
//   - hook input arrives as ONE JSON object on stdin; every event carries session_id and cwd.
//   - a hook returns JSON on stdout; context injection is
//     {"hookSpecificOutput":{"hookEventName":"<Event>","additionalContext":"…"}} and the
//     hookEventName field is REQUIRED (the build errors with
//     'hookSpecificOutput is missing required field "hookEventName"' without it).
//
// THREE ENVIRONMENT FACTS drive the design, each learned the hard way elsewhere:
//
// A. `legion` IS NOT ASSUMED TO BE ON PATH. A hook is spawned by Claude Code, not by the
//    operator's login shell, so a PATH-resolved `legion` can silently not exist and every
//    kernel call would fail for a reason that has nothing to do with the feature. runKernel
//    spawns process.execPath (the very node running this hook) against bin/legion.mjs
//    resolved from import.meta.url — no PATH, no shell, no cwd dependence.
//
// B. `legion feature status` RESOLVES BY MAIN REPO ROOT and refuses from inside a linked
//    worktree (src/cli/feature.mjs resolveProject, default mode). Every session — and
//    therefore every hook — runs INSIDE the feature worktree (PLAN-V3 §Startup step 5), so
//    hooks must never shell out to `legion feature status`. They resolve with
//    resolveDossier (src/cli/state.mjs), which keys on the WORKTREE, and then read the
//    manifests directly.
//
// C. resolveDossier reads process.cwd() rather than taking a cwd argument, and a hook's
//    spawn cwd is Claude Code's, not necessarily the session's. The hook payload carries the
//    authoritative `cwd`, so resolveFeature chdir()s to it first. That is safe here and only
//    here: a hook process is single-purpose and exits within milliseconds, so there is no
//    concurrent code whose relative-path assumptions could break.
//
// FAIL-SAFE vs FAIL-CLOSED, the distinction every hook header repeats concretely:
//   - "this cwd is not a legion feature worktree" ⇒ do nothing, exit 0, print nothing. This
//     is the ONLY sanctioned silence; Claude Code loads this plugin globally and most
//     sessions are not legion features.
//   - a kernel command that RAN and REFUSED is never swallowed. Each hook surfaces it
//     through the loudest channel its event actually supports (which is not the same channel
//     for every event — see the per-hook headers).
//   - A CORRUPT DOSSIER IS THE OPPOSITE OF SILENCE, and until T12 this file CONTRADICTED the
//     invariant above (R9): resolveFeature() returned null — meaning "not a legion feature, do
//     nothing" — for an unregistered cwd, a corrupt projects.json, a corrupt feature.json and a
//     corrupt tasks.json ALIKE. A broken dossier rendered as "not a legion feature" is a session
//     running with NO GATE AT ALL. The three outcomes are now separated, and existsSync is what
//     separates ABSENT from CORRUPT — that distinction is the whole fix:
//       unregistered cwd / no index / no feature.json ⇒ null (silence, as above);
//       tasks.json ABSENT                            ⇒ {…, tasks: null} — an ordinary early
//                                                      stage, before `legion state init`;
//       ANY manifest PRESENT but unreadable or of an
//       unknown schemaVersion                        ⇒ {…, corrupt: {what, path, detail}}, and
//                                                      each hook must be LOUD on the channel its
//                                                      event actually supports.
// TWO R9 RESIDUALS, stated rather than left to be rediscovered:
//   (i)  an ABSENT feature.json in a registered worktree stays SILENT. It is asserted as silence
//        by test/hooks.test.mjs and is out of T12's scope; absent is not corrupt.
//   (ii) a cwd matching MULTIPLE features reads as unregistered here, because separating it needs
//        a second copy of resolveDossier's matcher. `legion state` refuses it loudly, and the
//        index CAS makes a duplicate registration unreachable in ordinary use.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readJson } from '../src/kernel/fsatomic.mjs';
import { projectConfigPath, projectsIndexPath } from '../src/kernel/paths.mjs';
import { resolveDossier } from '../src/cli/state.mjs';

/** bin/legion.mjs, located from THIS file — never from cwd, never from PATH (fact A). */
export const KERNEL = fileURLToPath(new URL('../bin/legion.mjs', import.meta.url));

/** Read the single JSON object Claude Code writes to a hook's stdin.
 * Returns null on empty or unparseable stdin: a hook handed garbage must not crash with a
 * stack trace into the user's transcript, and null routes every caller to the fail-safe
 * exit-0 path. Synchronous fd-0 read (not a stream): the payload is complete before the
 * process starts and this keeps the hook a straight line with no async lifetime. */
export function readHookInput() {
  let raw;
  try { raw = readFileSync(0, 'utf8'); } catch { return null; }
  if (!raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** Run one kernel command; never throws. {code, stdout, stderr}.
 * code is -1 when the process could not be spawned at all, which is distinguishable from a
 * kernel REFUSAL (exit 1 with a message) — the two want different words to the operator.
 * No shell: argv is passed as an array, so a task id containing shell metacharacters is
 * inert. cwd matters because the kernel resolves the feature from it. */
export function runKernel(argv, cwd) {
  const r = spawnSync(process.execPath, [KERNEL, ...argv], {
    cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  if (r.error) return { code: -1, stdout: '', stderr: String(r.error.message ?? r.error) };
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Read a manifest that IS PRESENT, returning {doc} or {bad: <reason>}. Presence is the caller's
 * question (existsSync); this only answers "is what is there readable and of a schema we know".
 * An unknown schemaVersion is corruption from a hook's point of view for the same reason the
 * kernel dies on it: a newer/older kernel or a hand-edit, and a silent default propagates it. */
function readPresentManifest(path) {
  let doc;
  try { doc = readJson(path); } catch (e) { return { bad: String(e?.message ?? e) }; }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return { bad: 'not a JSON object' };
  if (doc.schemaVersion !== 1) {
    return { bad: `unknown schemaVersion ${JSON.stringify(doc.schemaVersion)} — this plugin reads schemaVersion 1 only` };
  }
  return { doc };
}

/** Resolve the feature this hook fired inside.
 * RETURNS null FOR EXACTLY ONE THING — "not a registered legion feature worktree, do nothing" —
 * which is the only sanctioned silence (header FAIL-SAFE). Otherwise it returns
 * {cwd, dossier, feature, tasks, corrupt}, where `corrupt` is null or {what, path, detail} and
 * EVERY caller must handle it before touching `feature`/`tasks`: on the corrupt path
 * feature/tasks may be null, because the point is that they could not be read.
 * The chdir is fact C above. Manifests are read directly rather than through a kernel
 * subprocess: this runs on every SessionStart and must stay cheap. */
export function resolveFeature(input) {
  const cwd = typeof input?.cwd === 'string' && existsSync(input.cwd) ? input.cwd : null;
  if (!cwd) return null;
  try { process.chdir(cwd); } catch { return null; }
  const corrupt = (what, path, detail) => ({ cwd, dossier: null, feature: null, tasks: null, corrupt: { what, path, detail } });

  // PRE-FLIGHT THE INDEX, because resolveDossier throws the same way for "no index" (silence) and
  // "the index is unparseable" (loud). existsSync separates them: absent ⇒ nothing is registered
  // anywhere, which is the ordinary case for most sessions; present-but-broken ⇒ every feature on
  // this machine is unresolvable and saying "not a legion feature" would be a lie.
  const idxPath = projectsIndexPath();
  if (existsSync(idxPath)) {
    let idx;
    try { idx = readJson(idxPath); } catch (e) { return corrupt('projects.json', idxPath, String(e?.message ?? e)); }
    if (idx === null || typeof idx !== 'object' || Array.isArray(idx)) {
      return corrupt('projects.json', idxPath, 'not a JSON object');
    }
    // THE SHAPE IS CHECKED, NOT MERELY THE PARSE. Parseable-but-wrong slid through to
    // resolveDossier and came back as ordinary SILENCE, which is the one thing R9 forbids for a
    // broken index: `{}` and an index carrying an unrecognised schemaVersion both read as
    // "nothing is registered anywhere". Three facts are required, each owned elsewhere, and each
    // a hand-edit or a version skew when absent:
    //   `version`       — OWNED BY kernel/casfile.mjs, which refuses a non-integer itself for
    //                     exactly this reason, so a missing one means hand-edited or corrupted;
    //   `schemaVersion` — OWNED BY cli/project.mjs; unknown ⇒ a newer or older kernel wrote it,
    //                     the same judgement readPresentManifest makes for the two manifests;
    //   `projects`      — must be PRESENT and an array, not merely "an array if defined".
    if (!Number.isInteger(idx.version)) {
      return corrupt('projects.json', idxPath,
        `\`version\` is not an integer (got ${JSON.stringify(idx.version)}) — casfile owns it, so a missing one means the index was hand-edited or corrupted`);
    }
    if (idx.schemaVersion !== 1) {
      return corrupt('projects.json', idxPath,
        `unknown schemaVersion ${JSON.stringify(idx.schemaVersion)} — this plugin reads schemaVersion 1 only`);
    }
    if (!Array.isArray(idx.projects)) {
      return corrupt('projects.json', idxPath,
        `\`projects\` is ${idx.projects === undefined ? 'missing' : 'not an array'}`);
    }
  }
  let dossier;
  try { dossier = resolveDossier({}); } catch { return null; } // unregistered cwd ⇒ silence

  // feature.json ABSENT is silence (residual (i) in the header); PRESENT but broken is corruption.
  const featurePath = join(dossier, 'feature.json');
  if (!existsSync(featurePath)) return null;
  const fRead = readPresentManifest(featurePath);
  if (fRead.bad) return corrupt('feature.json', featurePath, fRead.bad);

  // tasks.json only exists after `legion state init`; its ABSENCE is an ordinary early stage, not
  // an error, and callers render what they have. PRESENT but broken is corruption.
  const tasksPath = join(dossier, 'tasks.json');
  if (!existsSync(tasksPath)) return { cwd, dossier, feature: fRead.doc, tasks: null, corrupt: null };
  const tRead = readPresentManifest(tasksPath);
  if (tRead.bad) return { cwd, dossier, feature: fRead.doc, tasks: null, corrupt: { what: 'tasks.json', path: tasksPath, detail: tRead.bad } };
  return { cwd, dossier, feature: fRead.doc, tasks: tRead.doc, corrupt: null };
}

/** The project.json for a resolved feature, or null. feature.json records org+project
 * (src/cli/feature.mjs), so the path comes from paths.mjs rather than from walking `..`
 * out of the dossier — the layout is known in exactly one place. */
export function projectConfig(feature) {
  try { return readJson(projectConfigPath(feature.org, feature.project)); } catch { return null; }
}

/** Emit a hook result and exit 0. `extra` merges in event-specific fields.
 * hookEventName is mandatory in 2.1.219 — omitting it makes the build reject the whole
 * output, i.e. a hook that appears to run and silently injects nothing. */
export function emit(hookEventName, additionalContext, extra = {}) {
  const out = { ...extra };
  if (additionalContext) out.hookSpecificOutput = { hookEventName, additionalContext };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}
