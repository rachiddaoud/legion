// project.mjs — `legion project init`: discovers and
// records project config into the legion home. Evidence is DERIVED, never supplied:
// repoRoot via `git rev-parse --show-toplevel` (realpath'd — macOS /tmp symlinks),
// remoteUrl via `git remote get-url origin` (optional ⇒ null), defaultBranch via
// origin/HEAD symbolic-ref with local-HEAD fallback. Config lives at
// <home>/orgs/<org>/projects/<name>/project.json; the machine-local index at
// <home>/projects.json is updated via lock+CAS (updateJsonCas) so concurrent inits from
// separate processes never lose a registration.
// Re-init RECONCILES, never blind-overwrites: only derived fields (repoRoot, remoteUrl,
// defaultBranch) plus explicitly flagged fields (--protected/--no-protected/--gates/
// --bootstrap/--ticket-project/--ticket-closing-style/--notify) are diffed and updated; unflagged gates, bootstrap
// and createdAt are preserved untouched; an unchanged config writes NOTHING (byte-identical
// no-op, index untouched). An EMPTY protected set is only ever explicit: --no-protected; a
// --protected value that parses to nothing ('', ' ', ',,') is rejected loudly, never a silent [].
// bootstrap entries are STRUCTURED ONLY — {cwd, argv[], timeoutMs} or {script, sha256};
// no raw shell strings, ever; re-init validates existing
// entries and dies loudly on violations rather than carrying them forward.
// CONFIGURATION IS ONBOARDING: `--gates <path.json>` and `--bootstrap <path.json>` read a JSON file and put the
// safe configuration one flag away, so declaring a project's real gate is not hand-editing
// project.json in ~/.legion. Both go through THE existing validators — gate.mjs's
// validateGatesConfig and this file's validateBootstrap, imported, never re-implemented — so a
// flag file and a hand-edited config are judged by exactly one definition of valid, and a
// violation dies naming the offending key AND the file it came from. NO PROMPTING, ever: a
// kernel CLI that blocks on a TTY cannot be driven by an agent or a script, so flags plus the
// documented file shape (README) are the onboarding. The gates block is stored NORMALIZED
// (validateGatesConfig's {commands, task, boundary} triple) because that is precisely the value
// commandPolicyPin hashes at `feature start` — storing the raw text would leave the pinned
// policy one normalization away from what the operator read.
// A FAILED INIT LEAVES NO TRACE: index registration is the COMMIT
// POINT, and it is the LAST step. Everything written before it (a fresh project dir + project.json,
// or a reconciled project.json) is rolled back when registration fails — for ANY cause, not just a
// corrupt index — and the refusal says exactly what was undone. Two reasons this matters beyond
// tidiness: an orphan project.json makes the NEXT init take the re-init branch, so a retry
// silently reconciles against config that was never registered; and success is announced only
// after the commit point, so `initialized project …` is never printed for an init that failed.
// THE ROLLBACK'S WINDOW IS THE WHOLE REACHABLE ONE, which is why it hangs off registration alone:
// every derivation and every validation runs before the first mkdir (a bad --gates file or a
// non-git --root writes nothing at all), and the only step between creating the project dir and
// the commit point is the project.json write — atomic (temp+rename) into a directory this run just
// created writable, so its failure leaves at most an empty directory and only on a filesystem that
// broke underneath us. Registration is where a real init fails with a real config already on disk.
// All four derivations below (repoRoot, remoteUrl, originHead, defaultBranch) are written
// into project.json and the authoritative projects index, so they are EVIDENCE and run
// through the hardened git()/gitTry() (kernel/git.mjs header E) — the operator's global
// config and GIT_* environment cannot steer them. Repo-local .git/config is still read, so
// `remote get-url origin` and the symbolic-ref fallbacks work exactly as before.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../kernel/args.mjs';
import { git, gitTry } from '../kernel/git.mjs';
import { updateJsonCas } from '../kernel/casfile.mjs';
import { ensurePrePushHook, hookReportLine } from '../kernel/githooks.mjs';
import { readJson, writeAtomic, writeJson } from '../kernel/fsatomic.mjs';
import {
  ensureDir, legionHome, projectDir, projectConfigPath, projectsIndexPath, safeSegment,
} from '../kernel/paths.mjs';
import { validateGatesConfig } from './gate.mjs';
// The ticket config's field validators, IMPORTED for the reason the gates/bootstrap ones are: a
// flag value and a hand-edited project.json must be judged by ONE definition of valid, and that
// definition belongs beside the resolver that reads the field back (kernel/ticket.mjs).
import { validateClosingStyle, validateTicketFields, validateTicketProject } from '../kernel/ticket.mjs';

const USAGE =
  'legion project init [--root <path>] [--org <org>] [--name <name>] ' +
  '[--protected <branch,branch>] [--no-protected] [--gates <path.json>] [--bootstrap <path.json>] ' +
  '[--ticket-project <path>] [--ticket-closing-style <closes|fixes|resolves|refs>] [--notify <topic>]';

const SHA256_RE = /^[0-9a-f]{64}$/;

/** Structured bootstrap entries ONLY; a raw shell string anywhere is a hard error.
 * Strict keys: an entry is EXACTLY one shape — {cwd, argv[], timeoutMs} or
 * {script, sha256} — no extra fields, no mixed shapes (extra keys would silently ride
 * along into execution; a both-shapes entry is ambiguous about what runs).
 * Exported: `legion feature start` re-validates before EXECUTING entries (fail closed
 * even if project.json was hand-edited after init). */
export function validateBootstrap(bootstrap, configPath) {
  if (!Array.isArray(bootstrap)) {
    throw new Error(`invalid bootstrap in ${configPath}: must be an array of structured entries`);
  }
  bootstrap.forEach((e, i) => {
    const isObj = e !== null && typeof e === 'object' && !Array.isArray(e);
    const keys = isObj ? JSON.stringify(Object.keys(e).sort()) : null;
    const exec = isObj
      && keys === '["argv","cwd","timeoutMs"]'
      && typeof e.cwd === 'string'
      && Array.isArray(e.argv) && e.argv.length > 0 && e.argv.every((s) => typeof s === 'string')
      && Number.isInteger(e.timeoutMs) && e.timeoutMs > 0;
    const script = isObj
      && keys === '["script","sha256"]'
      && typeof e.script === 'string' && typeof e.sha256 === 'string' && SHA256_RE.test(e.sha256);
    if (!exec && !script) {
      throw new Error(
        `invalid bootstrap[${i}] in ${configPath}: entries must be exactly ` +
        `{cwd, argv[], timeoutMs} or exactly {script, sha256} — no extra fields, no mixed shapes; ` +
        `raw shell strings are forbidden`,
      );
    }
  });
}

/** Read a flag-supplied JSON config file. The path is resolved against cwd (an operator types
 * these), and readJson's loud failures — missing file, corrupt JSON — are re-thrown naming the
 * FLAG too, so `--gates ./gates.json` never fails with a bare path the operator has to trace back
 * to which flag produced it. Returns {abs, doc}; `abs` becomes the `configPath` the validators
 * name in their errors, because the offending key is in THAT file, not in project.json. */
function readFlagJson(flagName, value) {
  const abs = resolve(value);
  try {
    return { abs, doc: readJson(abs) };
  } catch (e) {
    throw new Error(`--${flagName}: ${e.message}`, { cause: e });
  }
}

/** Project name: --name wins; else package.json name (scoped ⇒ tail); else dirname. */
function deriveName(flags, repoRoot) {
  if (flags.name != null) return flags.name; // safeSegment enforced downstream by projectConfigPath
  let name;
  const pkgPath = join(repoRoot, 'package.json');
  const pkgName = existsSync(pkgPath) ? (readJson(pkgPath).name ?? null) : null; // corrupt pkg ⇒ readJson dies loudly
  if (typeof pkgName === 'string' && pkgName.length > 0) {
    name = pkgName.includes('/') ? pkgName.slice(pkgName.lastIndexOf('/') + 1) : pkgName;
  } else {
    name = basename(repoRoot);
  }
  try { safeSegment(name, 'project name'); }
  catch (e) { throw new Error(`derived project name is unusable — pass --name explicitly. ${e.message}`); }
  return name;
}

export async function run(argv) {
  const { flags, positional } = parseArgs(argv, { bools: ['no-protected'] });
  if (positional.length !== 1 || positional[0] !== 'init') {
    throw new Error(`unknown or missing subcommand '${positional.join(' ')}'. usage: ${USAGE}`);
  }
  // An empty protected set must be EXPLICIT (--no-protected), never a parse accident.
  if (flags.protected != null && flags['no-protected']) {
    throw new Error(`--protected and --no-protected are mutually exclusive. usage: ${USAGE}`);
  }
  const protectedList = flags.protected != null
    ? flags.protected.split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  if (protectedList !== null && protectedList.length === 0) {
    throw new Error(
      `--protected '${flags.protected}' would silently disable branch protection — ` +
      `an empty protected set must be requested explicitly with --no-protected`,
    );
  }

  // --- flag-supplied config files, validated by THE existing validators (header) ---
  // Read and validated BEFORE any evidence is derived and long before anything is written: a
  // malformed gates file must cost nothing and must not be able to half-write a project.
  let gatesFlag = null;      // null ⇒ flag absent ⇒ preserve/scaffold
  let bootstrapFlag = null;
  if (flags.gates != null) {
    const { abs, doc } = readFlagJson('gates', flags.gates);
    gatesFlag = validateGatesConfig(doc, abs); // throws naming gates.<key>; returns the normalized triple
  }
  if (flags.bootstrap != null) {
    const { abs, doc } = readFlagJson('bootstrap', flags.bootstrap);
    validateBootstrap(doc, abs);              // throws naming bootstrap[i]
    bootstrapFlag = doc;
  }
  // --- the ticket config's two operator-owned fields, validated the same way and at the same
  // moment (header): a bad value must cost nothing and must not half-write a project. THE
  // VALIDATORS ARE THE RESOLVER'S OWN (kernel/ticket.mjs), so `--ticket-closing-style refs` and a
  // hand-edited `"ticketClosingStyle": "refs"` are one definition of valid, not two.
  // NEITHER IS PINNED ANYWHERE: this file RECORDS the project-level override, and `legion
  // finalize`/`legion doctor` RESOLVE it fresh at the moment of use — a ticket format is not
  // evidence-bearing, so pinning it into a feature would be ceremony (contrast the gate policy
  // pin, which is evidence-bearing and therefore pinned at `feature start`).
  const ticketProjectFlag = flags['ticket-project'] != null
    ? validateTicketProject(flags['ticket-project'], '--ticket-project')
    : null;
  const ticketStyleFlag = flags['ticket-closing-style'] != null
    ? validateClosingStyle(flags['ticket-closing-style'], '--ticket-closing-style')
    : null;

  // --- derive evidence (kernel-owned; callers never supply it) ---
  const root = resolve(flags.root ?? process.cwd());
  const repoRoot = realpathSync(git(['rev-parse', '--show-toplevel'], root));
  const remoteUrl = gitTry(['remote', 'get-url', 'origin'], repoRoot);
  const originHead = gitTry(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot);
  const defaultBranch = originHead
    ? originHead.replace(/^refs\/remotes\/origin\//, '')
    : git(['symbolic-ref', '--short', 'HEAD'], repoRoot);

  const org = flags.org ?? 'default';
  const name = deriveName(flags, repoRoot);
  const legionVersion = readJson(fileURLToPath(new URL('../../package.json', import.meta.url))).version;
  const configPath = projectConfigPath(org, name); // safeSegment guards org + name here
  const now = new Date().toISOString();

  ensureDir(legionHome()); // projects.json + its .lock need the home to exist

  const dir = projectDir(org, name);
  const dirExisted = existsSync(dir);
  // Undo for everything written before the commit point (header R18). Returns the human
  // sentence the refusal quotes; a no-op init leaves it at "nothing was written".
  let rollback = () => 'nothing was written';
  // Success is ANNOUNCED only after the commit point — an init that fails registration must
  // never have printed `initialized project …` on its way there.
  const say = [];

  if (!existsSync(configPath)) {
    // --- fresh init ---
    const protectedBranches = flags['no-protected'] ? [] : (protectedList ?? [defaultBranch]);
    const doc = {
      schemaVersion: 1,
      legionVersion,
      revision: 0,
      org,
      name,
      repoRoot,
      remoteUrl,
      defaultBranch,
      protectedBranches,
      gates: gatesFlag ?? {},          // scaffold unless --gates declared one (validated above)
      bootstrap: bootstrapFlag ?? [],  // scaffold — structured entries only, see validateBootstrap
      ticketProject: ticketProjectFlag,
      // null = UNSET at this level, not "explicitly the default" — the resolver falls through to
      // ~/.legion/orgs/<org>/org.json and then to the plugin default, which is exactly why a fresh
      // project.json scaffolding both keys as null cannot shadow an org-wide setting.
      ticketClosingStyle: ticketStyleFlag,
      notify: flags.notify ?? null,
      createdAt: now,
      updatedAt: now,
    };
    ensureDir(dir);
    writeJson(configPath, doc);
    rollback = () => {
      rmSync(configPath, { force: true });
      if (!dirExisted) rmSync(dir, { recursive: true, force: true });
      return dirExisted ? `removed ${configPath}` : `removed ${dir}`;
    };
    say.push(`initialized project ${org}/${name}\n  config: ${configPath}\n`);
  } else {
    // --- re-init: reconcile (diff + update), never blind overwrite ---
    const existing = readJson(configPath);
    validateBootstrap(existing.bootstrap, configPath);
    validateGatesConfig(existing.gates, configPath); // carried-forward config is judged too, not just flagged config
    validateTicketFields(existing, configPath);      // …including the two ticket fields (never key-strict here: project.json carries a dozen unrelated keys)
    // Derived fields always reconcile; operator-owned fields reconcile ONLY when the
    // flag was passed (re-init without --protected must not reset a curated list).
    const nextFields = { repoRoot, remoteUrl, defaultBranch };
    if (flags['no-protected']) nextFields.protectedBranches = [];
    else if (protectedList !== null) nextFields.protectedBranches = protectedList;
    if (gatesFlag !== null) nextFields.gates = gatesFlag;
    if (bootstrapFlag !== null) nextFields.bootstrap = bootstrapFlag;
    if (ticketProjectFlag !== null) nextFields.ticketProject = ticketProjectFlag;
    if (ticketStyleFlag !== null) nextFields.ticketClosingStyle = ticketStyleFlag;
    if (flags.notify != null) nextFields.notify = flags.notify;

    const changed = Object.entries(nextFields)
      .filter(([k, v]) => JSON.stringify(existing[k]) !== JSON.stringify(v));
    if (changed.length === 0) {
      say.push(`project ${org}/${name} up to date\n  config: ${configPath}\n`);
    } else {
      // Byte-exact restore: the previous file is put back as it was found, not re-serialized
      // from the parsed doc (a hand-formatted config must survive a rolled-back re-init).
      const before = readFileSync(configPath);
      for (const [k, v] of changed) {
        say.push(`  ${k}: ${JSON.stringify(existing[k])} -> ${JSON.stringify(v)}\n`);
      }
      const updated = {
        ...existing,           // unflagged gates/bootstrap, createdAt, identity preserved untouched
        ...Object.fromEntries(changed),
        revision: existing.revision + 1,
        updatedAt: now,
      };
      writeJson(configPath, updated);
      rollback = () => { writeAtomic(configPath, before); return `restored ${configPath} to its previous contents`; };
      say.push(`reconciled project ${org}/${name} (revision ${updated.revision})\n  config: ${configPath}\n`);
    }
  }

  // --- THE COMMIT POINT: register in the machine-local index under lock+CAS ---
  const entry = { org, name, repoRoot, configPath };
  try {
    await updateJsonCas(projectsIndexPath(), (doc) => {
      if (doc === null) return { schemaVersion: 1, projects: [entry] }; // version owned by casfile
      const projects = [...(doc.projects ?? [])];
      const i = projects.findIndex((p) => p.org === org && p.name === name);
      if (i >= 0 && JSON.stringify(projects[i]) === JSON.stringify(entry)) return null; // true no-op
      if (i >= 0) projects[i] = entry; else projects.push(entry);
      return { ...doc, projects };
    });
  } catch (e) {
    // A rollback that itself fails must not hide the registration failure NOR the debris it
    // leaves: both are reported, and the operator is told what to remove by hand.
    let undone;
    try { undone = rollback(); }
    catch (re) { undone = `ROLLBACK FAILED (${re.message}) — remove ${dir} by hand`; }
    throw new Error(
      `project init failed at registration in ${projectsIndexPath()}: ${e.message}\n` +
      `  rolled back — ${undone}; the project is NOT initialized, so re-run once the index is readable`,
      { cause: e },
    );
  }
  // --- remote-safety layer 3, AFTER the commit point ---
  // Installed here and nowhere earlier for the reason stated above: everything before
  // registration is rolled back on failure, and a hook written into the operator's repository is
  // not something this file rolls back. It is also why ensurePrePushHook never throws — a repo
  // that cannot take the guard is still an initialized project, and DEPTH THAT CANNOT BE ADDED
  // MUST NOT FAIL ONBOARDING. The line it prints carries the caveat (kernel/githooks.mjs
  // hookReportLine): this layer blocks the ordinary raw push, it does not prevent one.
  const hook = ensurePrePushHook(repoRoot);
  process.stdout.write(say.join(''));
  process.stdout.write(`  registered in ${projectsIndexPath()}\n`);
  process.stdout.write(hookReportLine(hook));
  return 0;
}
