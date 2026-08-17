// state.mjs — `legion state <typed-op>`: the thin CLI shell around the
// state machine in ../kernel/state.mjs. Its ONLY jobs are (1) resolve WHICH feature this
// invocation targets — from the worktree, never a caller-supplied identity — and (2)
// forward the op to the kernel, which derives and validates all evidence itself.
//
// FEATURE RESOLUTION keys on the worktree — the worktree path is the
// durable anchor: realpath(git rev-parse --show-toplevel of cwd) must equal a feature's
// recorded worktree in ~/.legion/projects.json. --org/--feature disambiguate; an
// unresolved cwd refuses loudly (never fall back to a guessed feature). --now <iso> sets
// deterministic timestamps (validated via Date.parse; timestamps are non-authoritative so
// a flag is acceptable — unlike hashes/HEADs, which have NO flag).
//
// Flag surface, deliberately minimal: --role/--verdict/--subject/--no-receipt-attest
// (review-record),
// --session-id (session-record), --question/--answer (task-answer — the session's recorded Q&A
// is CONTENT, like plan text, not authoritative evidence), plus --org/--feature/--now. There is
// NO --hash/--sha/--subject-hash/--head: authoritative identifiers are derived by the kernel, so
// no flag can inject one. `--no-receipt-attest '<reason>'` clears that bar from the other side:
// it injects no evidence — it MARKS THE ABSENCE of a review receipt, audited (the kernel writes
// a synthetic `waived` receipt carrying the reason). It is the human's flag: the build loop
// never emits it and the kernel-op agent's closed command set refuses it, both test-pinned. `ticket-record <ref>` adds NO flag either — the ref is a POSITIONAL, like
// `escalate-profile <profile>` and `close <mode>`: it is the op's subject, not a modifier, and the
// kernel's only judgment over it is refusing garbage (kernel/ticket.mjs: a ticket is operator
// DATA, never evidence — which is why supplying it is not the `--subject-hash` hazard above).
// --task/--boundary ARE GONE FROM THIS SURFACE: they belonged to
// `receipt-record`, which no longer exists as an op, and they now live only on `legion gate`.
// Nothing here writes a receipt, so `legion state` cannot advertise or dispatch one — a bare
// `legion state` prints STATE_OPS, generated from the kernel's own table, so the two cannot
// drift. Consequently the boolean-flag list is EMPTY; a stray `--boundary` is now an ordinary
// value flag and, with nothing following it, parseArgs refuses it loudly.
// Free-form CONTENT (question/answer) is stored verbatim, so it must be expressible even
// when it starts with `--`: argv is handed to parseArgs UNSPLIT so it binds `--answer=--x`
// inline (splitting it here into two tokens would trip parseArgs's fail-closed
// `missing value for --answer` refusal on a `--`-leading value). The two-token
// `--answer --x` form has no representation, by design — that refusal is the hardening.
import { existsSync, realpathSync } from 'node:fs';
import { parseArgs } from '../kernel/args.mjs';
import { git } from '../kernel/git.mjs';
import { readJson } from '../kernel/fsatomic.mjs';
import { projectsIndexPath } from '../kernel/paths.mjs';
import { dispatch, STATE_OPS } from '../kernel/state.mjs';

const USAGE =
  `legion state <op> [args] [--org <org>] [--feature <name>] [--now <iso>]\n` +
  `  ops: ${STATE_OPS.join(', ')}\n` +
  `  op flags: review-record --role <r> --verdict <pass|fail> --subject <s> [--no-receipt-attest <reason>] · ` +
  `session-record --session-id <id> · task-answer --question <q> --answer <a>\n` +
  `  op args:  ticket-record <ref>   (the issue reference: 123, #123 or group/project#123)`;

/** Resolve the dossier for the feature whose worktree is cwd's git toplevel.
 * Exported so `legion plan check` (src/cli/plan.mjs) resolves the SAME way — by worktree,
 * since the architect runs plan check from inside the feature worktree, not the main repo
 * root (which is how feature.mjs resolves, and would refuse here). Importing this module
 * has no import-time side effects; run() only executes on call. */
export function resolveDossier(flags) {
  const idxPath = projectsIndexPath();
  if (!existsSync(idxPath)) {
    throw new Error(`no project index at ${idxPath} — run \`legion project init\` in the target repo first`);
  }
  const idx = readJson(idxPath); // corrupt index dies loudly
  // git() is HARDENED (kernel/git.mjs header E): with GIT_DIR/GIT_WORK_TREE exported in the
  // ambient environment, an UNHARDENED read here resolves a DIFFERENT repository's toplevel
  // and every command downstream (`legion state`, `legion plan check`, `legion gate`) would
  // then act on another feature's dossier. Resolution is evidence; it is derived under a
  // neutralised env.
  const worktree = realpathSync(git(['rev-parse', '--show-toplevel'], process.cwd()));
  let matches = [];
  for (const p of idx.projects ?? []) {
    for (const feat of p.features ?? []) {
      let fwt;
      try { fwt = realpathSync(feat.worktree); } catch { continue; } // vanished worktree ⇒ skip
      if (fwt === worktree) matches.push({ org: p.org, project: p.name, feat });
    }
  }
  if (flags.org != null) matches = matches.filter((m) => m.org === flags.org);
  if (flags.feature != null) matches = matches.filter((m) => m.feat.name === flags.feature);
  if (matches.length === 0) {
    throw new Error(`cwd ${worktree} is not a registered legion feature worktree — run \`legion state\` from inside a feature worktree`);
  }
  if (matches.length > 1) {
    const ids = matches.map((m) => `${m.org}/${m.project}/${m.feat.name}`).join(', ');
    throw new Error(`cwd ${worktree} matches multiple features (${ids}) — disambiguate with --org/--feature`);
  }
  return matches[0].feat.dossier;
}

export async function run(argv) {
  // parseArgs speaks both `--flag value` and `--flag=value`; pass argv through untouched so
  // an inline value keeps its `--`-leading bytes. No op here takes a boolean flag any more
  // (--boundary went with receipt-record — header).
  const { flags, positional } = parseArgs(argv, { bools: [] });
  const op = positional[0];
  if (!op) throw new Error(`missing state op. usage:\n${USAGE}`);

  const now = flags.now ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(now))) throw new Error(`invalid --now '${flags.now}' — must be a parseable timestamp`);

  const dossier = resolveDossier(flags);
  const msg = dispatch(op, dossier, { flags, positional }, now);
  process.stdout.write(`${msg}\n`);
  return 0;
}
