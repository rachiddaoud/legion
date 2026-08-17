// viewer-build.mjs — `legion viewer-build [--force]`. Builds the viewer's frontend bundle into
// <checkout>/viewer/dist, and does nothing else. This is the ONE deterministic answer to the
// dist-missing refusal `legion viewer` prints.
//
// WHY THIS IS A SIBLING COMMAND AND NOT `legion viewer --build`. src/cli/viewer.mjs is SEALED by
// test/cli/viewer.test.mjs's PROHIBITION scan: that file may not import node:child_process or
// kernel/runner.mjs, and may not name a single filesystem write call — which is what makes "the
// viewer writes nothing, anywhere" a measured property rather than a promise. A build is a spawn
// and two directories' worth of writes, so putting it behind a flag on that command would mean
// weakening the seal for the convenience of one flag. The seal is worth more. `legion viewer`
// therefore still refuses when the bundle is absent, and now names ONE command as the remedy.
//
// SHAPE (the doctor.mjs / viewer.mjs / setup.mjs pattern): viewerBuildCore(argv, deps) validates
// and PLANS — it writes nothing, spawns nothing, and returns everything an executor needs;
// buildViewer(run, plan, deps) executes that plan through the injected runner seam. Every refusal
// and the whole step list are therefore testable without ever invoking npm, which is why
// test/cli/viewer-build.test.mjs drives real npm exactly zero times.
//
// npm, NOT pnpm — deliberate, and the reason the repo carries ONE lockfile. This build runs on the
// OPERATOR's machine, so it may only depend on what a legion install already requires: npm ships
// with Node (package.json pins >=22), pnpm does not. pnpm additionally blocks postinstall scripts
// by default, which esbuild needs, so a pnpm route makes every operator answer an approval prompt
// before the viewer works at all. viewer/package-lock.json is the committed reproducibility
// contract (.gitignore says so), so `npm ci` is the install form — `npm install` would quietly
// resolve new versions and make the bundle a different artifact on every machine.
//
// SPAWNS GO THROUGH kernel/runner.mjs, the one non-git process seam (no shell, purged redirection
// env). Its runCapture is spawnSync with piped stdio, so NOTHING STREAMS: a two-minute build looks
// frozen at the terminal. Answered by announcing it before the first spawn rather than by opening
// a second process seam — one seam that occasionally looks slow beats two that drift.
//
// A FAILED STEP IS REPORTED VERBATIM AND STOPS THE BUILD. npm's own output is the diagnosis; a
// re-worded summary of it is how an operator loses the one line that said which dependency failed.
//
// STALENESS: a present bundle is only as good as the sources it was built FROM. On the
// github-marketplace install route, Claude Code auto-pulls the clone this command runs from —
// nothing else would ever rebuild a present-but-stale dist, and `legion viewer` would serve it
// silently. So a successful build stamps dist with a CONTENT DIGEST of the viewer/ sources
// (never git state: kernel/runner.mjs structurally refuses git, and half the places a legion
// runs from carry no .git at all), and a bare `legion viewer-build` rebuilds when the digest no
// longer matches the stamp. FAILURE DIRECTION: an uncomputable digest (unreadable tree) or an
// unreadable/absent stamp falls back to the old skip-if-built semantics or to a rebuild — the
// staleness machinery may cost a spare rebuild, but it can never CAUSE a stale serve that the
// pre-stamp behavior would have caught. The stamp lives IN dist because vite empties dist before
// refilling it: an interrupted rebuild destroys the stale stamp along with the stale bundle.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../kernel/args.mjs';
import { runCapture } from '../kernel/runner.mjs';
import { bundleBuilt } from './_viewer-bundle.mjs';

const USAGE = 'legion viewer-build [--force]';

/** src/cli/viewer-build.mjs → the plugin root. Derived from THIS file, never cwd — the command is
 * run from a feature worktree far more often than from this checkout (viewer.mjs's header). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A cold `npm ci` (mermaid, highlight.js) plus a vite build routinely outruns setup's 120s step
 * budget, and a build killed halfway leaves a half-written dist that the viewer would then serve. */
export const BUILD_TIMEOUT_MS = 600_000;

/** The build, in order. `npm ci` and not `npm install` (header). */
export const STEPS = [['npm', ['ci']], ['npm', ['run', 'build']]];

/** The build stamp, IN dist (header: STALENESS). One line: the source digest the bundle was
 * built from. */
export const STAMP_FILE = '.legion-build-stamp';

/** The bundle's INPUTS: every file under viewer/, sorted, as relative paths — excluding the two
 * top-level trees that are outputs, not inputs (`dist/` is what the build writes, `node_modules/`
 * is what `npm ci` materializes from the lockfile, which IS hashed). The exclusion list is what
 * keeps the digest milliseconds instead of a 200MB walk. EXPORTED for its own determinism test. */
export function listViewerSources(viewerDir) {
  const out = [];
  const walk = (rel) => {
    for (const entry of readdirSync(rel === '' ? viewerDir : join(viewerDir, rel), { withFileTypes: true })) {
      if (rel === '' && (entry.name === 'dist' || entry.name === 'node_modules')) continue;
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk('');
  return out.sort();
}

/** sha256 over `relPath NUL bytes NUL` in sorted order. The path is part of the hash input on
 * purpose: a rename with identical bytes IS a different bundle input (vite resolves by path).
 * Throws on any unreadable entry — the CALLER maps that to digest:null and the fallback semantics. */
export function computeSourceDigest(viewerDir, { listSources = listViewerSources, readFile = readFileSync } = {}) {
  const hash = createHash('sha256');
  for (const rel of listSources(viewerDir)) {
    hash.update(rel);
    hash.update('\0');
    hash.update(readFile(join(viewerDir, rel)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** The flag surface, exhaustive — an unlisted flag is a typo, and building anyway while ignoring
 * it is worse than refusing (viewerCore's rule, same reasoning). */
const KNOWN_FLAGS = ['force'];

/** No viewer/ at all: this legion has no frontend source to build. Never "helpfully" fetched — a
 * checkout missing its own subdirectory is a broken checkout, and naming it is the whole remedy. */
export function sourceRefusal(viewerDir) {
  // Names the FILE it looked for, not "the viewer/ directory": the predicate is package.json, and
  // telling an operator whose viewer/ plainly exists that it does not is how a correct refusal
  // gets distrusted and worked around.
  return `legion viewer-build: no frontend source at ${join(viewerDir, 'package.json')}\n`
    + '  this checkout carries no buildable viewer/ — re-clone or update it, then run this again\n'
    + '  (the viewer is optional: the kernel runs features without it)\n';
}

/** The committed lockfile is gone. Refusing beats falling back to `npm install`: the fallback
 * would succeed and quietly produce a bundle nobody can reproduce (.gitignore states the contract). */
export function lockfileRefusal(viewerDir) {
  // `git -C <viewerDir>`, never a cwd-relative path. This command resolves its checkout from
  // import.meta.url precisely BECAUSE it is usually run from somewhere else (a feature worktree),
  // so a remedy that assumes cwd would restore some other repository's file — or nothing at all —
  // while the lockfile this refusal is about stays missing.
  return `legion viewer-build: no lockfile at ${join(viewerDir, 'package-lock.json')}\n`
    + '  it is committed on purpose — the bundle is reproducible only when the install is pinned\n'
    + `  restore it: git -C ${viewerDir} checkout -- package-lock.json\n`
    + '  (reaching for an unpinned install instead would build a bundle nobody else can reproduce)\n';
}

/** A step that ran and failed, or never started. npm's own output, verbatim (header). */
export function stepFailure(file, args, cwd, r) {
  const cmd = `${file} ${args.join(' ')}`;
  if (r.spawnError === 'ENOENT') {
    return `legion viewer-build: \`${cmd}\` could not start — '${file}' is not on PATH\n`
      + '  npm ships with Node (this repo pins node >= 22); install or repair Node, then run this again\n';
  }
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
  // A TIMEOUT IS THE ONE FAILURE THAT LEAVES A HALF-WRITTEN dist (vite empties the directory before
  // refilling it), so it is named as a kill rather than printed as the bare errno, and its remedy
  // carries --force: the entry-file predicate catches an EMPTY dist, but a build killed after
  // index.html landed would otherwise skip on the retry.
  const timedOut = r.spawnError === 'ETIMEDOUT';
  const why = timedOut
    ? `killed after ${Math.round(BUILD_TIMEOUT_MS / 60_000)} minutes`
    : (r.spawnError !== null && r.spawnError !== undefined
      ? r.spawnError
      : `exit ${r.code}${r.signal ? ` (${r.signal})` : ''}`);
  return `legion viewer-build: \`${cmd}\` failed in ${cwd} — ${why}\n`
    + `${output === '' ? '  (the command produced no output)' : output}\n`
    + `  fix the cause above and re-run: legion viewer-build${timedOut ? ' --force' : ''}\n`;
}

/**
 * The testable core. Writes NOTHING, spawns NOTHING, returns the whole plan.
 * @param {string[]} argv unsplit argv (kernel/args.mjs invariant)
 * @param {{exists?: Function, pluginRoot?: string}} deps
 */
export function viewerBuildCore(argv, {
  exists = existsSync, pluginRoot = REPO_ROOT, listSources = listViewerSources, readFile = readFileSync,
} = {}) {
  const { flags, positional } = parseArgs(argv, { bools: ['force'] });
  // Usage errors die BEFORE anything is resolved: a typo must not be answered with a build.
  if (positional.length > 0) {
    throw new Error(`unexpected argument '${positional[0]}'. usage: ${USAGE}`);
  }
  for (const name of Object.keys(flags)) {
    if (!KNOWN_FLAGS.includes(name)) throw new Error(`unknown flag '--${name}'. usage: ${USAGE}`);
  }
  const force = flags.force === true;
  const viewerDir = join(pluginRoot, 'viewer');
  const distDir = join(viewerDir, 'dist');
  const haveSource = exists(join(viewerDir, 'package.json'));
  const haveLock = exists(join(viewerDir, 'package-lock.json'));
  // The ENTRY FILE, not the directory — an interrupted build leaves dist/ present and empty, and
  // skipping on that would make this command a no-op exactly when it is the named remedy
  // (_viewer-bundle.mjs). Shared with `legion viewer`, so both answer the question the same way.
  const haveDist = bundleBuilt(exists, distDir);

  let refusal = null;
  if (!haveSource) refusal = sourceRefusal(viewerDir);
  else if (!haveLock) refusal = lockfileRefusal(viewerDir);

  // THE STALENESS QUESTION (header): does the present bundle match the present sources? Any
  // failure to answer — unreadable tree, absent/unreadable stamp — degrades toward the OLD
  // semantics or a rebuild, never toward serving a bundle known to be stale.
  let digest = null;
  if (refusal === null) {
    try { digest = computeSourceDigest(viewerDir, { listSources, readFile }); } catch { digest = null; }
  }
  const stampPath = join(distDir, STAMP_FILE);
  let stampDigest = null;
  if (haveDist) {
    try { stampDigest = String(readFile(stampPath)).trim(); } catch { stampDigest = null; }
  }
  const stale = digest !== null && digest !== stampDigest;

  return {
    viewerDir,
    distDir,
    force,
    haveSource,
    haveLock,
    haveDist,
    digest,
    stampPath,
    stampDigest,
    stale,
    // ALREADY BUILT IS NOT AN ERROR. It makes the command cheap to call unconditionally, which is
    // exactly what /legion:viewer does — the alternative is a skill that has to decide, and that
    // decision is what this command exists to take away from it. Built-but-STALE, though, is what
    // this command exists to repair — a stale plan never skips.
    skip: refusal === null && haveDist && !force && !stale,
    steps: refusal === null ? STEPS : [],
    refusal,
  };
}

/**
 * Execute a plan from viewerBuildCore through the runner seam. Shared verbatim with `legion setup`,
 * which is why the runner and the output sink are both injected rather than reached for.
 * @param {Function} run kernel/runner.mjs's runCapture, or a fake
 * @param {ReturnType<typeof viewerBuildCore>} plan
 */
export function buildViewer(run, plan, {
  write = (s) => process.stdout.write(s),
  writeStamp = (path, digest) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${digest}\n`); },
} = {}) {
  if (plan.refusal !== null) return { ok: false, skipped: false, ran: [], failure: plan.refusal };
  if (plan.skip) {
    // A skip with a computed digest is a VERIFIED skip — the message may say so; the pinned
    // "already built" + "--force" shape stays either way.
    write(`legion viewer-build: bundle already built at ${plan.distDir}`
      + `${plan.digest !== null ? ' and up to date with viewer/ sources' : ''} — --force to rebuild it\n`);
    return { ok: true, skipped: true, ran: [], failure: null };
  }
  write(`legion viewer-build: building in ${plan.viewerDir} — a minute or two, and each step`
    + ' prints only once it has finished\n');
  const ran = [];
  for (const [file, args] of plan.steps) {
    write(`legion viewer-build: ${file} ${args.join(' ')}\n`);
    const r = run(file, args, { cwd: plan.viewerDir, timeoutMs: BUILD_TIMEOUT_MS });
    ran.push(`${file} ${args.join(' ')}`);
    // FAIL CLOSED: `npm run build` after a failed `npm ci` would either fail confusingly or, worse,
    // succeed against a stale node_modules and ship a bundle nobody asked for.
    if (!r.ok) return { ok: false, skipped: false, ran, failure: stepFailure(file, args, plan.viewerDir, r) };
  }
  // The stamp records what this bundle was built FROM (header: STALENESS) — only after BOTH steps,
  // and only when the digest was computable. A failed stamp write degrades to a warning: the next
  // run rebuilds a fresh bundle, which is the cheap direction.
  if (plan.digest !== null) {
    try {
      writeStamp(plan.stampPath, plan.digest);
    } catch (e) {
      write(`legion viewer-build: WARNING — could not record the build stamp at ${plan.stampPath}`
        + ` (${e?.message ?? e}); the next run will rebuild\n`);
    }
  }
  write(`legion viewer-build: bundle ready at ${plan.distDir}\n`);
  return { ok: true, skipped: false, ran, failure: null };
}

export async function run(argv) {
  const plan = viewerBuildCore(argv);
  const result = buildViewer(runCapture, plan);
  if (!result.ok) {
    process.stderr.write(result.failure);
    return 1; // a build that did not happen must never look like one that did
  }
  return 0;
}
