// setup.mjs — `legion setup`: the one installation path made ONE
// COMMAND. Run from a CHECKOUT, it makes that checkout the installed legion: registers the
// checkout as a Claude Code marketplace, installs (or refreshes) the plugin snapshot from it,
// puts `legion` on PATH when nothing does, and finishes by running `legion doctor` — the same
// verification the README tells the operator to run after any install. Idempotent by
// construction: every step either succeeds, falls back to its refresh form, or dies loudly —
// re-running setup after upgrading the checkout IS the snapshot-refresh path the marketplace
// manifest's own description promises ("refresh it after upgrading the checkout").
//
// WHAT THIS COMMAND MAY TOUCH, exhaustively — and why it can exist outside `legion finalize`'s
// remote-write monopoly: nothing here reaches a remote. `claude plugin …`
// writes Claude Code's own config dir (~/.claude, or CLAUDE_CONFIG_DIR); `npm link` writes the
// npm prefix; both are LOCAL, operator-machine state. No git, no glab, no push, no MR. The
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
// THE CHECKOUT-ONLY REFUSAL: a legion running FROM the marketplace snapshot refuses setup.
// The snapshot is this command's OUTPUT, not its input — registering the snapshot directory as
// a marketplace would freeze the plugin at whatever the snapshot holds and detach it from the
// checkout it came from. The CLI's own location is the evidence (the launchCommand rule,
// feature.mjs): under `<config dir>/plugins` ⇒ snapshot ⇒ refuse, naming the checkout remedy.
//
// FALLBACK, NOT OUTPUT-PARSING: `claude plugin marketplace add` fails when the marketplace is
// already registered, and the failure WORDING is Claude Code's to change. So each step tries
// its create form and falls back to its refresh form (`marketplace update <name>`,
// `plugin update <name>`) on ANY failure; only when BOTH fail does setup die, reporting both
// outputs verbatim. Wording-independent, and fail-closed: a real breakage fails both forms.
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
import { isMarketplaceInstall } from './feature.mjs';

const USAGE = 'legion setup   (no arguments — run it from the legion checkout)';

/** src/cli/setup.mjs → the checkout that contains this CLI (the DEFAULT_PLUGIN_ROOT pattern:
 * derived from THIS file's location, never cwd — `npm link` resolves symlinks at load, so a
 * linked `legion setup` still names the real checkout). */
const DEFAULT_PLUGIN_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));

// Local-path marketplace operations and npm link are filesystem work, but `plugin install`
// may copy a whole snapshot; give every spawn the same generous ceiling.
const STEP_TIMEOUT_MS = 120_000;

/** Best-effort realpath (feature.mjs's realish): a PATH entry need not exist. */
const realish = (p) => { try { return realpathSync(p); } catch { return p; } };

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
    runDoctor = async () => (await import('./doctor.mjs')).run([]),
  } = deps;
  if (typeof run !== 'function') throw new Error('setupCore requires deps.run — the kernel/runner.mjs seam');

  const { flags, positional } = parseArgs(argv, { bools: [] });
  if (positional.length > 0 || Object.keys(flags).length > 0) {
    throw new Error(`legion setup takes no arguments (got '${argv.join(' ')}'). usage:\n${USAGE}`);
  }

  // --- the checkout-only refusal (header) ----------------------------------------------------
  const root = resolve(pluginRoot);
  const snapshot = marketplaceBase === undefined
    ? isMarketplaceInstall(root)
    : isMarketplaceInstall(root, marketplaceBase);
  if (snapshot) {
    throw new Error(
      `this legion runs from the INSTALLED SNAPSHOT (${root}), which is setup's output, not its input — `
      + `run \`legion setup\` from the checkout (e.g. \`cd <checkout> && ./bin/legion setup\`)`,
    );
  }
  const { marketName, pluginName } = readMarketplaceIdentity(root);

  // --- register the marketplace, install the plugin (create → refresh, fail-closed) ----------
  process.stdout.write(`setup: checkout ${root} (marketplace '${marketName}', plugin '${pluginName}')\n`);
  process.stdout.write('setup: ' + createOrRefresh(run, `registering marketplace '${marketName}'`,
    ['plugin', 'marketplace', 'add', root],
    ['plugin', 'marketplace', 'update', marketName],
    `registered marketplace '${marketName}' → ${root}`,
    `marketplace '${marketName}' already registered — refreshed from the checkout`) + '\n');
  process.stdout.write('setup: ' + createOrRefresh(run, `installing '${pluginName}@${marketName}'`,
    ['plugin', 'install', `${pluginName}@${marketName}`],
    ['plugin', 'update', pluginName],
    `installed plugin '${pluginName}@${marketName}' (the installed copy is a snapshot — re-run setup after upgrading the checkout)`,
    `plugin '${pluginName}' already installed — snapshot updated`) + '\n');

  // --- PATH (header: deliberately asymmetric) ------------------------------------------------
  const found = whichLegion(pathEnv);
  const ownBin = realish(join(root, 'bin', 'legion'));
  if (found === null) {
    const r = run('npm', ['link'], { cwd: root, timeoutMs: STEP_TIMEOUT_MS });
    if (!r.ok) {
      const detail = `${r.stdout}${r.stderr}`.trim() || r.spawnError || `exit ${r.code}`;
      throw new Error(
        `\`legion\` is not on PATH and \`npm link\` (in ${root}) failed: ${detail}\n`
        + `Link it by hand — \`cd ${root} && npm link\` — or add the checkout's bin to PATH: `
        + `export PATH="${join(root, 'bin')}:$PATH"`,
      );
    }
    process.stdout.write(`setup: linked \`legion\` onto PATH via npm link (from ${root})\n`);
  } else if (realish(found) === ownBin || realish(found).startsWith(realish(root) + sep)) {
    process.stdout.write(`setup: \`legion\` already on PATH → ${found}\n`);
  } else {
    process.stdout.write(
      `setup: WARNING — \`legion\` on PATH resolves to ${realish(found)}, which is NOT this checkout `
      + `(${root}). Left untouched: repointing PATH is your call, not setup's. `
      + `If this checkout should win: cd ${root} && npm link\n`,
    );
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
