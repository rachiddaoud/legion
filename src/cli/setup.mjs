// setup.mjs — `legion setup`: the one installation path made ONE
// COMMAND, from either of the TWO LEGITIMATE HOMES a legion may run from:
//   - a CHECKOUT (development): registers the checkout as a directory-source marketplace,
//     installs (or refreshes) the plugin snapshot from it;
//   - the MARKETPLACE CLONE (`<config dir>/plugins/marketplaces/<name>`, the git clone Claude
//     Code keeps for a github-source marketplace and auto-pulls): refreshes the registration
//     and snapshot from the clone's own registered source.
// Both modes then put `legion` on PATH when nothing does (npm link FROM the running root — in
// clone mode that is what makes the PATH kernel follow Claude Code's pulls), build the viewer
// bundle, and finish by running `legion doctor` — the same verification the README tells the
// operator to run after any install.
// Idempotent by construction: every step either succeeds, falls back to its refresh form, or dies
// loudly — re-running setup after upgrading the checkout IS the snapshot-refresh path the
// marketplace manifest's own description promises ("refresh it after upgrading the checkout").
// EXACTLY ONE STEP IS EXEMPT from that succeed/fallback/die rule, and it says so at its own site:
// the viewer bundle WARNS and setup carries on, because the kernel runs features with no viewer at
// all and doctor — not a frontend toolchain — owns this command's verdict.
//
// WHAT THIS COMMAND MAY TOUCH, exhaustively — and why it can exist outside `legion finalize`'s
// remote-write monopoly: nothing here WRITES to a remote. `claude plugin …`
// writes Claude Code's own config dir (~/.claude, or CLAUDE_CONFIG_DIR); `npm link` writes the
// npm prefix; the viewer step writes viewer/node_modules and viewer/dist INSIDE the checkout;
// all three are LOCAL, operator-machine state. No git, no glab, no push, no MR. One step READS a
// remote — `npm ci` fetches from the npm registry, which is why a failure there is reported as an
// environment fact and never as a kernel fault. The
// spawns go through kernel/runner.mjs — the one non-git process seam (no shell, purged
// redirection env) — and git is structurally refused there.
//
// EVERY IDENTITY IS DERIVED, NEVER HARDCODED: callers never supply authoritative
// identifiers, and neither does this file's author. The marketplace name and the plugin name
// are READ from the checkout's own .claude-plugin/marketplace.json, so the `<plugin>@<market>`
// install spec can never drift from the manifest that defines it. A missing or malformed
// manifest refuses loudly — a setup that guessed 'legion@legion' would keep working until the
// day the manifest moved, and then install something else.
//
// THE SNAPSHOT REFUSAL, FAIL-CLOSED: a legion running from under `<config dir>/plugins` but NOT
// from a marketplace clone refuses setup. That covers the plugin snapshot cache
// (`plugins/cache/<market>/<plugin>/<sha>` — per-commit directories Claude Code orphan-marks and
// sweeps; anchoring a PATH link or a viewer build there dies with the next update) and any
// plugins-dir layout this build does not know: an unrecognized subtree refuses rather than being
// treated as a checkout, because the wrong guess would run `marketplace add` against a directory
// Claude Code owns. The CLI's own location is the evidence (the launchCommand rule, feature.mjs).
//
// WHY CLONE MODE NEVER RUNS THE CREATE FORM: the clone's existence IS Claude Code's own record
// that the marketplace is registered — and `marketplace add <clone path>`, were it accepted,
// would re-register the marketplace as a DIRECTORY source pointing into the config dir, silently
// ending the auto-pull that is this install route's whole point. So clone mode runs
// `marketplace update <name>` only, and a failure there is loud with a re-add-from-the-repository
// remedy instead of any fallback.
//
// FALLBACK, NOT OUTPUT-PARSING (checkout mode): `claude plugin marketplace add` fails when the
// marketplace is already registered, and the failure WORDING is Claude Code's to change. So each
// step tries its create form and falls back to its refresh form (`marketplace update <name>`,
// `plugin update <name>`) on ANY failure; only when BOTH fail does setup die, reporting both
// outputs verbatim. Wording-independent, and fail-closed: a real breakage fails both forms.
// The refresh form updates from the marketplace's REGISTERED source, which need not be this
// checkout — the ok-line says so instead of claiming a checkout refresh it cannot verify.
//
// THE DOCTOR MODULE IS IMPORTED BEFORE THE FIRST SPAWN: in clone mode, `marketplace update`
// git-pulls the very tree this process was loaded from; importing doctor.mjs lazily AFTER that
// pull would graft post-pull modules onto a pre-pull graph. Resolving the import up front pins
// the whole run to one version of the code.
//
// THE PATH STEP IS DELIBERATELY ASYMMETRIC. `legion` absent from PATH ⇒ run `npm link` in the
// checkout (idempotent, and already the README's documented route). `legion` present and
// resolving INTO this checkout ⇒ nothing to do. `legion` present but resolving SOMEWHERE ELSE
// ⇒ WARN naming both paths and touch nothing: a second checkout or an old link is the
// operator's arrangement, and silently repointing their PATH at this checkout is exactly the
// kind of helpful clobbering this kernel refuses everywhere else.
//
// DOCTOR RUNS LAST AND ITS VERDICT IS THE EXIT CODE. The install steps succeeding is not the
// claim that legion WORKS here — doctor owns that judgment (version pin, hooks, glab, branch
// protection). Printing "setup complete" over a red doctor would be a claim of success the
// machine does not deliver, so setup's exit is doctor's exit once the install steps are done.
import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { delimiter, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../kernel/args.mjs';
import { readJson } from '../kernel/fsatomic.mjs';
import { runCapture } from '../kernel/runner.mjs';
import { isMarketplaceClone, isMarketplaceInstall } from './feature.mjs';
import { buildViewer, viewerBuildCore } from './viewer-build.mjs';

const USAGE = 'legion setup   (no arguments — run it from the legion checkout or the installed marketplace clone)';

/** src/cli/setup.mjs → the checkout that contains this CLI (the DEFAULT_PLUGIN_ROOT pattern:
 * derived from THIS file's location, never cwd — `npm link` resolves symlinks at load, so a
 * linked `legion setup` still names the real checkout). */
const DEFAULT_PLUGIN_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

// Local-path marketplace operations and npm link are filesystem work, but `plugin install`
// may copy a whole snapshot; give every spawn the same generous ceiling.
const STEP_TIMEOUT_MS = 120_000;

/** Best-effort realpath (feature.mjs's realish): a PATH entry need not exist. */
const realish = (p) => { try { return realpathSync(p); } catch { return p; } };

/** How bare `legion` reaches (or fails to reach) the install at `root`:
 * `{found, resolved, state}` where state is 'absent' (nothing on PATH), 'own' (resolves into
 * `root`) or 'foreign' (resolves somewhere else — another checkout, an old link). `found` is the
 * raw PATH hit (null when absent), `resolved` its best-effort realpath. EXPORTED so doctor's
 * legion-on-path check reads the exact same evidence as setup's PATH step — the two can never
 * disagree about what PATH holds. */
export function legionPathState(pathEnv, root) {
  const found = whichLegion(pathEnv);
  if (found === null) return { found: null, resolved: null, state: 'absent' };
  const resolved = realish(found);
  const own = resolved === realish(join(root, 'bin', 'legion'))
    || resolved.startsWith(realish(resolve(root)) + sep);
  return { found, resolved, state: own ? 'own' : 'foreign' };
}

/** First executable named `legion` on PATH, or null. Scanned segment by segment — never a
 * shelled-out `command -v`, for the same no-shell reason as everything else here. */
export function whichLegion(pathEnv) {
  for (const dir of String(pathEnv ?? '').split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, 'legion');
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch { /* not here — keep scanning */ }
  }
  return null;
}

/** Read the checkout's marketplace manifest and derive {marketName, pluginName}. Refuses
 * loudly on absence or shape — the header says why guessing would be worse. */
function readMarketplaceIdentity(pluginRoot) {
  const path = join(pluginRoot, '.claude-plugin', 'marketplace.json');
  if (!existsSync(path)) {
    throw new Error(`no marketplace manifest at ${path} — \`legion setup\` runs from a legion CHECKOUT, and the manifest is what defines the marketplace being registered`);
  }
  const doc = readJson(path); // corrupt JSON dies loudly naming the path
  const marketName = doc?.name;
  const pluginName = Array.isArray(doc?.plugins) ? doc.plugins[0]?.name : undefined;
  if (typeof marketName !== 'string' || marketName.length === 0
    || typeof pluginName !== 'string' || pluginName.length === 0) {
    throw new Error(`${path} does not carry a marketplace name and a first plugin name — the install spec is derived from the manifest, never guessed`);
  }
  return { marketName, pluginName };
}

/** One create-then-refresh step (header: FALLBACK, NOT OUTPUT-PARSING). Returns the line to
 * print; throws with BOTH outputs when both forms fail. */
function createOrRefresh(run, what, createArgv, refreshArgv, okCreate, okRefresh) {
  const c = run('claude', createArgv, { timeoutMs: STEP_TIMEOUT_MS });
  if (c.ok) return okCreate;
  const r = run('claude', refreshArgv, { timeoutMs: STEP_TIMEOUT_MS });
  if (r.ok) return okRefresh;
  const detail = (x) => `${x.stdout}${x.stderr}`.trim() || x.spawnError || `exit ${x.code}`;
  throw new Error(
    `${what} failed both ways:\n`
    + `  claude ${createArgv.join(' ')} → ${detail(c)}\n`
    + `  claude ${refreshArgv.join(' ')} → ${detail(r)}\n`
    + `Is the \`claude\` CLI installed and current? Fix that and re-run \`legion setup\`.`,
  );
}

/** One refresh-only step — clone mode's marketplace refresh, which deliberately has NO create
 * fallback (header: WHY CLONE MODE NEVER RUNS THE CREATE FORM). Returns the line to print;
 * throws with the verbatim output plus the caller's remedy when the one form fails. */
function refreshOnly(run, what, refreshArgv, okLine, remedy) {
  const r = run('claude', refreshArgv, { timeoutMs: STEP_TIMEOUT_MS });
  if (r.ok) return okLine;
  const detail = `${r.stdout}${r.stderr}`.trim() || r.spawnError || `exit ${r.code}`;
  throw new Error(`${what} failed:\n  claude ${refreshArgv.join(' ')} → ${detail}\n${remedy}`);
}

/**
 * The testable core. `deps.run` is the kernel/runner.mjs seam (required); `pluginRoot`,
 * `marketplaceBase`, `pathEnv` and `runDoctor` exist so tests drive every layout without
 * touching the real machine — production passes none of them.
 */
export async function setupCore(argv, deps = {}) {
  const {
    run,
    pluginRoot = DEFAULT_PLUGIN_ROOT,
    marketplaceBase = undefined, // isMarketplaceInstall's own default when undefined
    pathEnv = process.env.PATH,
  } = deps;
  if (typeof run !== 'function') throw new Error('setupCore requires deps.run — the kernel/runner.mjs seam');

  const { flags, positional } = parseArgs(argv, { bools: [] });
  if (positional.length > 0 || Object.keys(flags).length > 0) {
    throw new Error(`legion setup takes no arguments (got '${argv.join(' ')}'). usage:\n${USAGE}`);
  }

  // --- the snapshot refusal, fail-closed (header) --------------------------------------------
  const root = resolve(pluginRoot);
  const underPlugins = marketplaceBase === undefined
    ? isMarketplaceInstall(root)
    : isMarketplaceInstall(root, marketplaceBase);
  const clonesBase = marketplaceBase === undefined
    ? undefined // isMarketplaceClone's own default
    : join(marketplaceBase, 'marketplaces');
  const fromClone = clonesBase === undefined
    ? isMarketplaceClone(root)
    : isMarketplaceClone(root, clonesBase);
  if (underPlugins && !fromClone) {
    throw new Error(
      `this legion runs from the INSTALLED SNAPSHOT (${root}), which is setup's output, not its input — `
      + `run \`legion setup\` from the marketplace clone `
      + `(e.g. \`node <config dir>/plugins/marketplaces/<name>/bin/legion.mjs setup\`) `
      + `or from a checkout (e.g. \`cd <checkout> && ./bin/legion setup\`)`,
    );
  }
  const { marketName, pluginName } = readMarketplaceIdentity(root);

  // --- doctor, resolved BEFORE the first spawn (header: the pre-pull import) -----------------
  const runDoctor = deps.runDoctor
    ?? await import('./doctor.mjs').then((doctor) => () => doctor.run([]));

  // --- register/refresh the marketplace, install the plugin (fail-closed) --------------------
  process.stdout.write(`setup: ${fromClone ? 'marketplace clone' : 'checkout'} ${root} (marketplace '${marketName}', plugin '${pluginName}')\n`);
  if (fromClone) {
    process.stdout.write('setup: ' + refreshOnly(run, `refreshing marketplace '${marketName}'`,
      ['plugin', 'marketplace', 'update', marketName],
      `marketplace '${marketName}' refreshed from its registered source`,
      `Is the marketplace still registered? Re-add it from its repository — `
      + `\`claude plugin marketplace add <owner>/<repo>\` — then re-run setup. `
      + `(Never \`marketplace add\` this clone's path: a directory-source re-registration would end auto-update.)`) + '\n');
  } else {
    process.stdout.write('setup: ' + createOrRefresh(run, `registering marketplace '${marketName}'`,
      ['plugin', 'marketplace', 'add', root],
      ['plugin', 'marketplace', 'update', marketName],
      `registered marketplace '${marketName}' → ${root}`,
      `marketplace '${marketName}' already registered — refreshed from its registered source `
      + `(if that is not this checkout, \`claude plugin marketplace remove ${marketName}\` and re-add it from here)`) + '\n');
  }
  process.stdout.write('setup: ' + createOrRefresh(run, `installing '${pluginName}@${marketName}'`,
    ['plugin', 'install', `${pluginName}@${marketName}`],
    ['plugin', 'update', pluginName],
    `installed plugin '${pluginName}@${marketName}' (the installed copy is a snapshot — re-run setup after upgrading the checkout)`,
    `plugin '${pluginName}' already installed — snapshot updated`) + '\n');

  // --- PATH (header: deliberately asymmetric; same policy in both modes) ---------------------
  const path = legionPathState(pathEnv, root);
  if (path.state === 'absent') {
    const r = run('npm', ['link'], { cwd: root, timeoutMs: STEP_TIMEOUT_MS });
    if (!r.ok) {
      const detail = `${r.stdout}${r.stderr}`.trim() || r.spawnError || `exit ${r.code}`;
      throw new Error(
        `\`legion\` is not on PATH and \`npm link\` (in ${root}) failed: ${detail}\n`
        + `Link it by hand — \`cd ${root} && npm link\` — or add this install's bin to PATH: `
        + `export PATH="${join(root, 'bin')}:$PATH"`,
      );
    }
    process.stdout.write(`setup: linked \`legion\` onto PATH via npm link (from ${root})\n`);
  } else if (path.state === 'own') {
    process.stdout.write(`setup: \`legion\` already on PATH → ${path.found}\n`);
  } else {
    process.stdout.write(
      `setup: WARNING — \`legion\` on PATH resolves to ${path.resolved}, which is NOT this install `
      + `(${root}). Left untouched: repointing PATH is your call, not setup's. `
      + `If this install should win: cd ${root} && npm link\n`,
    );
  }

  // --- the viewer bundle: BUILT HERE, BUT NEVER FATAL (header) -------------------------------
  // Building at install time is what stops the first `/legion:viewer` of a fresh checkout from
  // paying for an npm install. It runs with force:true because setup IS the refresh path ("re-run
  // setup after upgrading the checkout") and an upgraded checkout may carry new viewer sources.
  // A failure WARNS and setup carries on: the kernel runs features with no viewer at all, so
  // letting a frontend toolchain fail a kernel install would be the tail wagging the dog. It is
  // not silent either — the warning names `legion viewer-build` as the retry.
  const viewerPlan = viewerBuildCore(['--force'], { pluginRoot: root });
  if (!viewerPlan.haveSource) {
    process.stdout.write(`setup: no viewer/ frontend source in ${root} — skipping the bundle build\n`);
  } else {
    const built = buildViewer(run, viewerPlan, { write: (s) => process.stdout.write(s) });
    if (!built.ok) {
      process.stdout.write(
        // --force on the retry, deliberately: this build was forced, so a dist from BEFORE the
        // upgrade may still be sitting there intact, and an unforced retry would skip on it and
        // report success for the bundle that just failed to rebuild.
        'setup: WARNING — the viewer bundle did not build. The kernel is installed and works '
        + 'without it; run `legion viewer-build --force` to retry.\n'
        + built.failure,
      );
    }
  }

  // --- verification: doctor owns the verdict (header) ----------------------------------------
  process.stdout.write('setup: install steps complete — running `legion doctor`\n');
  const code = await runDoctor();
  return typeof code === 'number' ? code : 0;
}

/** The router entry point: the real runner, wired. */
export async function run(argv) {
  return setupCore(argv, { run: runCapture });
}
