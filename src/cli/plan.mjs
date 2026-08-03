// plan.mjs — `legion plan check --feature <name> [--import]`:
// validate the architect's candidate plan.tasks.json, and (with --import) seed it into the
// canonical tasks.json through the state layer. Invariants:
//  - validate commands are STRUCTURED ONLY ({cwd,argv,timeoutMs} or {script,sha256}) — never
//    a raw shell string. A malformed plan bounces to the
//    architect HERE, BEFORE plan approval, never to the builder.
//  - findings are DATA on stderr + a nonzero exit; the session re-plans, the kernel never
//    "fixes" a plan.
//  - the kernel DERIVES the authoritative evidence itself: plan.md's hash (via the
//    artifact-record op) and the started/done import guard (seedTasks). Task ids/titles/deps
//    are plan CONTENT the model legitimately supplies. No --hash/--head flag exists.
//  - content is not carte blanche: task and milestone IDS validate against the kernel's own
//    safeSegment shape (checkId below), because an id becomes a path segment,
//    brief text and dispatch text, and one the kernel would refuse later imports a task that is
//    unusable AND injectable. A bad id is a plan-check ERROR naming the id, never an import.
//  - RESOLUTION is by WORKTREE (git toplevel), reusing state.mjs's resolveDossier — plan
//    check runs inside the architect's feature worktree, so it must NOT resolve by main-repo
//    root the way feature.mjs does (that would refuse from a worktree).
//  - --import requires BOTH plan.tasks.json AND plan.md present: seedTasks needs tasks.json
//    (`legion state init`), and artifact-record realpaths join(dossier,'plan.md') and dies
//    loudly if absent — so plan check surfaces a clean finding first. Import order is
//    seed-then-record and the order is immaterial: the two halves of the plan subject are
//    cascaded by their own writer (tasks[] by seedTasks, plan.md bytes by artifact-record),
//    each only when its half CHANGED, and both cascade the same kind — so a re-import over an
//    existing plan approval drops it exactly once whichever way round they run.
//  - advisory checks (3-5 tasks/feature, titles <= 72 chars) are WARNINGS only — printed,
//    never fatal, never pushing the exit code to 1.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { parseArgs, requireFlags } from '../kernel/args.mjs';
import { readJson } from '../kernel/fsatomic.mjs';
import { safeSegment } from '../kernel/paths.mjs';
import { dispatch, seedTasks, sha256 } from '../kernel/state.mjs';
import { resolveDossier } from './state.mjs';

const USAGE = 'legion plan check --feature <name> [--import] [--org <org>] [--now <iso>]';

const SHA256_RE = /^[0-9a-f]{64}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A repo/dossier-relative path with no escape: reject absolute paths and any '..' segment.
const hasTraversal = (p) => isAbsolute(p) || p.split('/').includes('..');

/** Task and milestone ids validate against THE kernel segment shape — safeSegment IMPORTED, never
 * a re-declared regex. A model-authored id flows from the plan into
 * briefs, dispatch text and file paths; one safeSegment would later refuse ("T3; echo INJECTED #"
 * demonstrably imported) is a plan that seeds and can never be worked — both unusable AND
 * injectable, so it bounces to the architect HERE, as a finding NAMING the offending id.
 * safeSegment throws; a plan-check finding is data, so the throw is converted, and only for a
 * non-empty string (the emptiness finding above already locates a missing id). */
function checkId(id, what, errors) {
  if (typeof id !== 'string' || id.length === 0) return;
  try { safeSegment(id, what); }
  catch {
    errors.push(
      `${what} '${id}' is not a valid path segment (letter/digit/underscore first, then ` +
      `letters/digits/dot/dash/underscore only) — the kernel's own safeSegment would refuse it at ` +
      `every later op, so this plan would import a task that can never be worked`,
    );
  }
}

/** Validate a task's `validate` field. ABSENT is fine; otherwise EXACTLY one of the two
 * structured shapes — anything else (a raw shell string, a mixed/extra-key object) is a
 * finding. The {script,sha256} shape additionally requires the file to EXIST in the dossier
 * and its sha256 to match (the check bootstrap validation defers, done here per-task). */
function checkValidate(validate, id, dossier, errors) {
  if (validate === undefined) return;
  const shellStringMsg =
    `task '${id}' validate must be structured {cwd,argv,timeoutMs} or {script,sha256}, never a shell string`;
  if (!isObject(validate)) { errors.push(shellStringMsg); return; }
  const keys = JSON.stringify(Object.keys(validate).sort());
  if (keys === '["argv","cwd","timeoutMs"]') {
    const { cwd, argv, timeoutMs } = validate;
    if (typeof cwd !== 'string') errors.push(`task '${id}' validate.cwd must be a string`);
    else if (hasTraversal(cwd)) errors.push(`task '${id}' validate.cwd must be repo-relative with no traversal (no absolute path, no '..' segment)`);
    if (!Array.isArray(argv) || argv.length === 0 || !argv.every((a) => typeof a === 'string')) {
      errors.push(`task '${id}' validate.argv must be a non-empty array of strings`);
    }
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) errors.push(`task '${id}' validate.timeoutMs must be a positive integer`);
    return;
  }
  if (keys === '["script","sha256"]') {
    const { script, sha256: expected } = validate;
    if (typeof script !== 'string') { errors.push(`task '${id}' validate.script must be a string`); return; }
    if (hasTraversal(script)) { errors.push(`task '${id}' validate.script must be repo/dossier-relative with no traversal`); return; }
    if (typeof expected !== 'string' || !SHA256_RE.test(expected)) { errors.push(`task '${id}' validate.sha256 must be a 64-char hex string`); return; }
    const abs = join(dossier, script);
    // Must be an EXISTING REGULAR FILE: existsSync accepts a directory (and script:'' joins to
    // the dossier dir), so a bare existsSync would let sha256(readFileSync(dir)) throw EISDIR as
    // a raw CLI error instead of a finding. statSync().isFile() keeps it fail-closed as a finding.
    if (!existsSync(abs) || !statSync(abs).isFile()) { errors.push(`task '${id}' validate.script '${script}' must be an existing regular file in the dossier`); return; }
    const actual = sha256(readFileSync(abs));
    if (actual !== expected) errors.push(`task '${id}' validate.script sha256 mismatch — expected ${expected}, got ${actual}`);
    return;
  }
  errors.push(shellStringMsg);
}

/** Pure validator (exported for direct unit testing and reused by --import):
 * returns { errors, warnings, tasks } — `tasks` is the normalized flat list to seed. */
export function validatePlan(candidate, dossier) {
  const errors = [];
  const warnings = [];
  const flat = [];

  if (!isObject(candidate)) {
    errors.push('plan must be a JSON object with a milestones[] array');
    return { errors, warnings, tasks: [] };
  }
  if (!Array.isArray(candidate.milestones) || candidate.milestones.length === 0) {
    errors.push('plan.milestones must be a non-empty array');
    return { errors, warnings, tasks: [] };
  }

  // --- shape + flatten (a finding per violation names the milestone/task index + id) ---
  let totalTasks = 0;
  candidate.milestones.forEach((m, mi) => {
    if (!isObject(m)) { errors.push(`milestone[${mi}] must be an object`); return; }
    if (typeof m.id !== 'string' || m.id.length === 0) errors.push(`milestone[${mi}].id must be a non-empty string`);
    checkId(m.id, 'milestone id', errors);
    if (typeof m.title !== 'string' || m.title.length === 0) errors.push(`milestone[${mi}] (${m.id ?? '?'}) title must be a non-empty string`);
    if (!Array.isArray(m.tasks) || m.tasks.length === 0) {
      errors.push(`milestone[${mi}] (${m.id ?? '?'}) must have a non-empty tasks[] array`);
      return;
    }
    totalTasks += m.tasks.length;
    m.tasks.forEach((task, ti) => {
      const where = `milestone[${mi}].tasks[${ti}]`;
      if (!isObject(task)) { errors.push(`${where} must be an object`); return; }
      const id = task.id;
      const idLabel = typeof id === 'string' && id.length > 0 ? id : where;
      if (typeof id !== 'string' || id.length === 0) errors.push(`${where}.id must be a non-empty string`);
      checkId(id, 'task id', errors);
      if (typeof task.title !== 'string' || task.title.length === 0) errors.push(`task ${idLabel} title must be a non-empty string`);
      if (task.status !== 'pending') errors.push(`task ${idLabel} status must be 'pending', got ${JSON.stringify(task.status)}`);
      if (task.attempt !== 0) errors.push(`task ${idLabel} attempt must be 0, got ${JSON.stringify(task.attempt)}`);
      checkValidate(task.validate, idLabel, dossier, errors);
      if (typeof task.title === 'string' && task.title.length > 72) {
        warnings.push(`task ${idLabel} title is ${task.title.length} chars (> 72 recommended)`);
      }
      // Normalized/flattened for seeding from an EXPLICIT WHITELIST — never `...task`. A blanket
      // spread would carry ANY model-supplied field verbatim into canonical tasks.json, including
      // `receipt`: a pre-baked receipt.treeHash = the base tree makes task-done pass with no gate
      // ever run — the kernel DERIVES authoritative evidence; callers NEVER
      // supply it. The kernel owns status/attempt/receipt; the model supplies only content
      // (id/title/depends_on/validate) + advisory `notes` (mirror/gotcha) briefs keep.
      const seeded = { id: task.id, title: task.title, status: 'pending', attempt: 0, depends_on: task.depends_on ?? [], milestone: m.id };
      if (task.validate !== undefined) seeded.validate = task.validate;
      if (task.notes !== undefined) seeded.notes = task.notes;
      flat.push(seeded);
    });
  });

  // --- unique ids across ALL milestones ---
  const ids = [];
  for (const m of candidate.milestones) {
    // Re-check isObject(m): a null/non-object milestone was already recorded as a finding above,
    // but reading m.tasks here would throw a TypeError (fail-open crash) instead of returning it.
    if (isObject(m) && Array.isArray(m.tasks)) for (const task of m.tasks) if (isObject(task) && typeof task.id === 'string') ids.push(task.id);
  }
  const seen = new Set();
  const dups = new Set();
  for (const id of ids) { if (seen.has(id)) dups.add(id); seen.add(id); }
  for (const id of dups) errors.push(`duplicate task id '${id}' — task ids must be unique across all milestones`);
  const idSet = new Set(ids);

  // --- depends_on: absent or an array of existing-id strings; the graph must be ACYCLIC ---
  const adj = new Map(); // id -> [dep ids that exist] (edges only to real nodes)
  for (const m of candidate.milestones) {
    if (!isObject(m) || !Array.isArray(m.tasks)) continue; // isObject(m): null milestone must not throw
    for (const task of m.tasks) {
      if (!isObject(task) || typeof task.id !== 'string') continue;
      const dep = task.depends_on;
      if (dep === undefined) { if (!adj.has(task.id)) adj.set(task.id, []); continue; }
      if (!Array.isArray(dep) || !dep.every((d) => typeof d === 'string')) {
        errors.push(`task '${task.id}' depends_on must be an array of task-id strings`);
        if (!adj.has(task.id)) adj.set(task.id, []);
        continue;
      }
      for (const d of dep) if (!idSet.has(d)) errors.push(`task '${task.id}' depends_on references unknown task '${d}'`);
      adj.set(task.id, dep.filter((d) => idSet.has(d)));
    }
  }
  // DFS with WHITE/GRAY/BLACK colors: a back-edge into a GRAY node (on the current stack) is a
  // cycle — catches self-loops (T1→T1) and multi-node cycles a visited-only scan would miss.
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map([...adj.keys()].map((k) => [k, WHITE]));
  const stack = [];
  const cycles = new Set();
  const dfs = (u) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of adj.get(u) ?? []) {
      if (color.get(v) === GRAY) cycles.add([...stack.slice(stack.indexOf(v)), v].join(' -> '));
      else if (color.get(v) === WHITE) dfs(v);
    }
    stack.pop();
    color.set(u, BLACK);
  };
  for (const id of adj.keys()) if (color.get(id) === WHITE) dfs(id);
  for (const c of cycles) errors.push(`dependency cycle detected: ${c}`);

  // --- advisory WARNINGS (never fatal) ---
  if (totalTasks < 3 || totalTasks > 5) warnings.push(`plan has ${totalTasks} task(s); 3-5 tasks per feature is recommended`);

  return { errors, warnings, tasks: flat };
}

export async function run(argv) {
  // parseArgs only speaks `--flag value`; accept `--flag=value` by pre-splitting (as
  // state.mjs/feature.mjs do). --import is the sole boolean flag.
  const split = argv.flatMap((a) => {
    if (!a.startsWith('--')) return [a];
    const eq = a.indexOf('=');
    return eq < 0 ? [a] : [a.slice(0, eq), a.slice(eq + 1)];
  });
  const { flags, positional } = parseArgs(split, { bools: ['import'] });
  if (positional[0] !== 'check' || positional.length !== 1) {
    throw new Error(`unknown or malformed subcommand '${positional.join(' ')}'. usage: ${USAGE}`);
  }
  requireFlags(flags, ['feature'], USAGE);

  const now = flags.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error(`invalid --now '${flags.now}' — must be a parseable timestamp`);

  const dossier = resolveDossier(flags);
  const candPath = join(dossier, 'plan.tasks.json');
  if (!existsSync(candPath)) {
    process.stderr.write(
      `plan check FAILED (1 finding):\n` +
      `  - no candidate plan at ${candPath} — the architect must write plan.tasks.json alongside plan.md\n`,
    );
    return 1;
  }
  const candidate = readJson(candPath); // corrupt JSON dies loudly through the router

  const { errors, warnings, tasks } = validatePlan(candidate, dossier);
  for (const w of warnings) process.stdout.write(`warning: ${w}\n`);
  if (errors.length > 0) {
    process.stderr.write(`plan check FAILED (${errors.length} finding(s)):\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    return 1;
  }

  if (flags.import) {
    // artifact-record realpaths join(dossier,'plan.md') and dies loudly if absent — surface a
    // clean finding first so the architect knows plan.md, not the plan tasks, is missing.
    if (!existsSync(join(dossier, 'plan.md'))) {
      process.stderr.write(
        `plan check --import FAILED (1 finding):\n` +
        `  - no plan.md in ${dossier} — the architect writes plan.md alongside plan.tasks.json; --import records both\n`,
      );
      return 1;
    }
    const { reset, removed } = seedTasks(dossier, tasks, now); // refuses over recorded gate evidence
    dispatch('artifact-record', dossier, { flags: {}, positional: ['artifact-record', 'plan', 'plan.md'] }, now);
    process.stdout.write(`plan imported: ${tasks.length} task(s) seeded into tasks.json; plan.md recorded\n`);
    // Never silent: a Q&A was answered about text that no longer exists, and a session that does
    // not know it went will not think to ask the question again.
    if (reset.length > 0) {
      process.stdout.write(
        `warning: ${reset.length} task(s) had their plan text rewritten (${reset.join(', ')}) — ` +
        `they are back to 'pending' and any recorded answers were cleared, since both described the old text\n`,
      );
    }
    if (removed.length > 0) {
      process.stdout.write(
        `warning: ${removed.length} task(s) are gone from the plan (${removed.join(', ')}) — ` +
        `any recorded answers went with them\n`,
      );
    }
    return 0;
  }

  process.stdout.write(`plan check OK (${tasks.length} task(s))\n`);
  return 0;
}
