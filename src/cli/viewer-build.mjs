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
import { randomUUID } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../kernel/args.mjs';
import { runCapture } from '../kernel/runner.mjs';
import {
  LOCK_FILE, STAMP_FILE, bundleBuilt, computeSourceDigest, listViewerSources, readBundleEvidence,
} from './_viewer-bundle.mjs';

// The digest machinery lives in _viewer-bundle.mjs so `legion viewer` can ANSWER the staleness
// question read-only, behind its seal, with the same definition this command DECIDES it with.
// LOCK_FILE lives there too — its name and the digest's exclusion list are one decision, made in
// one place (that file says why). Re-exported here because this command is where operators and
// tests meet all of it.
export { LOCK_FILE, STAMP_FILE, computeSourceDigest, listViewerSources };

const USAGE = 'legion viewer-build [--force]';

/** src/cli/viewer-build.mjs → the plugin root. Derived from THIS file, never cwd — the command is
 * run from a feature worktree far more often than from this checkout (viewer.mjs's header). */
export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A cold `npm ci` (mermaid, highlight.js) plus a vite build routinely outruns setup's 120s step
 * budget, and a build killed halfway leaves a half-written dist that the viewer would then serve. */
export const BUILD_TIMEOUT_MS = 600_000;

/** The build, in order. `npm ci` and not `npm install` (header). */
export const STEPS = [['npm', ['ci']], ['npm', ['run', 'build']]];

// THE CONCURRENCY LOCK (LOCK_FILE, defined in _viewer-bundle.mjs beside the digest exclusion it
// has to agree with). On the marketplace-install route the viewer directory is SHARED across
// every session on the machine — the auto-pulled clone — and this command runs unconditionally
// from the viewer skill, so two sessions observing "stale" after the same pull would otherwise
// interleave `npm ci`'s node_modules deletion and vite's emptyOutDir in one tree and stamp a
// half-written dist as verified-fresh.

/** HOW OLD a lock must be before it counts as a dead build's leftover. DERIVED FROM THE STEP
 * LIST, never a hand-picked constant: every step gets its own BUILD_TIMEOUT_MS, so a LEGITIMATE
 * build can hold the lock for the whole list's worth of timeouts before the runner kills it — a
 * bound of one timeout would let a second builder lawfully steal the lock out from under a live
 * `npm run build` at minute 10 and hand two vites one dist. Adding a third step moves this bound
 * with it, which is the reason it is computed rather than written down.
 * PLUS SLACK, because the summed step budget is not the whole hold: taking the lock, the work
 * between steps and the stamp write all sit OUTSIDE that sum, and the comparison below is a
 * strict `<`. A minute of slack costs a genuinely dead lock one extra minute of patience; without
 * it, a build that used its full budget is reclaimable while still alive. */
export const LOCK_STALE_MS = STEPS.length * BUILD_TIMEOUT_MS + 60_000;

/** How many times takeLock re-races for a lock that vanished under it before giving up and
 * treating the contention itself as "another build is here". Small on purpose: each retry costs
 * one create attempt, and a tree where the lock appears and disappears this fast has a builder
 * in it either way. */
const LOCK_ATTEMPTS = 3;

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

/** Another build holds the lock. Age-bounded: a crashed build's leftover counts as stale once
 * older than LOCK_STALE_MS, so this refusal can never outlive the longest legitimate build — and
 * the remedy names the file so a human who KNOWS the other build is dead can act. */
export function lockRefusal(lockPath, ageMs) {
  return `legion viewer-build: another build appears to be running in this viewer/ — lock ${lockPath} is ${Math.round(ageMs / 1000)}s old\n`
    + `  wait for it to finish (a cold build takes a minute or two; a lock older than ${Math.round(LOCK_STALE_MS / 60_000)} minutes is treated as dead and reclaimed), then re-run: legion viewer-build\n`
    + '  if you are certain that build is dead, delete the lock file and re-run\n';
}

/** The lock kept CHANGING under us — appearing, vanishing and reappearing across every attempt.
 * A separate refusal from the one above on purpose: quoting an age here would either print "0s"
 * (a lock path that cannot be stat'd at all, e.g. a dangling symlink left by something else) or
 * announce a twenty-minute-old lock as "treated as dead and reclaimed" about a file that plainly
 * is not settled — and the viewer skill, reading that, would wait forever for a build that is not
 * running. So this one says what was actually observed and names both ways out. */
/** The lock changed hands after this build took it (holdsLock said no). Not an error in this
 * build's own conduct and not a state anyone needs to repair — another builder owns the tree and
 * is doing the same work — so the message says what happened and stops before writing anything. */
export function lockStolenRefusal(lockPath) {
  return `legion viewer-build: another build took over the lock ${lockPath} — stopping before this one writes anything\n`
    + '  that build is doing the same work; re-run when it finishes: legion viewer-build\n';
}

export function lockContendedRefusal(lockPath) {
  return `legion viewer-build: could not take the build lock ${lockPath} — it kept changing under us\n`
    + '  another build may be starting and stopping here; re-run: legion viewer-build\n'
    + `  if nothing else is building in this viewer/, remove ${lockPath} and re-run\n`;
}

/** What this process writes into the lock: its pid, for the human the refusal sends to look, and
 * a uuid, for the machine. THE UUID IS WHY THE PID IS NOT ENOUGH — pids are reused, and the drop
 * side has to answer "is the lock sitting here still MINE?" across a window in which the file may
 * have been reclaimed and re-taken by a build this process knows nothing about. */
const lockToken = () => `${process.pid} ${randomUUID()}\n`;

/** Is the file now at `path` the SAME FILE as the one `judged` was stat'd from? Inode and mtime
 * together: inode alone can be reused after an unlink, and a reused inode carrying the identical
 * millisecond mtime is not a case this guard needs to survive. */
const sameFile = (a, b) => a.ino === b.ino && a.mtimeMs === b.mtimeMs;

/**
 * Take away the stale lock that `judged` was stat'd from — and NOTHING ELSE. This is the one
 * operation the whole protocol turns on, so it is worth being explicit about why it is shaped
 * this way.
 *
 * THE OBVIOUS RECLAIM IS WRONG, AND SO IS ITS OBVIOUS FIX. Overwriting a stale lock in place is a
 * check-then-act race with itself (two waiters both "win"). Unlinking it and re-creating with
 * `wx` looks like the fix, but `rmSync(lockPath)` deletes whatever is AT THAT PATH — including
 * the fresh lock a racer created a microsecond earlier, after which both builders hold "the"
 * lock and build in one tree. That failure was reproduced: twelve spin-synchronised processes
 * against one stale lock produced two winners in roughly one round in seven.
 *
 * SO THE STEAL CLAIMS A FILE, NOT A PATH. `renameSync` moves a specific inode to a name only this
 * process can produce, and it is atomic: of N racers, exactly one can move that inode away, and
 * the losers get ENOENT and re-race. Then the moved file is VERIFIED to be the one we judged
 * stale; if it is not — we caught a racer's fresh lock — it is put back with `linkSync`, which
 * fails EEXIST rather than clobbering if a newer lock has already appeared. The only path this
 * function ever unlinks is its own uniquely-named tombstone, which no other process can name.
 *
 * WHAT THIS STILL CANNOT PROMISE, and why the promise is made elsewhere instead: between the
 * rename and the restore the lock is briefly absent from its path, so a THIRD racer arriving
 * inside that window can `wx` its way in, after which the restore finds a newer lock and the
 * displaced one is lost — its owner walks away believing it holds a lock that no longer exists.
 * Measured, not theorised: eight concurrent reclaimers hit it about once in five rounds. No
 * filesystem-only protocol closes it (POSIX conditions on EXISTENCE, never on identity, and Node
 * exposes no flock), so the guarantee is moved to the only place it has to hold — holdsLock,
 * checked immediately before each spawn and before the stamp. Taking the lock is a claim; the
 * file on disk is the fact, and exactly one token can be in it.
 */
export function stealStaleLock(lockPath, judged) {
  const tomb = `${lockPath}.stale-${randomUUID()}`;
  try {
    renameSync(lockPath, tomb);
  } catch (e) {
    if (e?.code === 'ENOENT') return; // another racer moved it first — re-race for their lock
    throw e;
  }
  let moved;
  try { moved = statSync(tomb); } catch { return; } // vanished under us; nothing to restore
  if (sameFile(moved, judged)) {
    rmSync(tomb, { force: true }); // OUR tombstone: the only name this code ever unlinks
    return;
  }
  // Not the file we judged: we just took a live lock away from its owner. Put it back.
  try {
    linkSync(tomb, lockPath); // EEXIST ⇒ a newer lock already sits there; leave it alone
  } catch (e) {
    // A filesystem without hard links (or an EEXIST) — rename back rather than lose the lock.
    if (e?.code !== 'EEXIST') { try { renameSync(tomb, lockPath); } catch { /* nothing left to try */ } return; }
  }
  rmSync(tomb, { force: true });
}

/**
 * Take the build lock. `{ok: true, owner}` when this process holds it, `{ok: false, ageMs}` when
 * another build does, `{ok: false, contended: true}` when the lock kept changing under us.
 * Throws only on filesystem surprises — the CALLER degrades those to building unlocked, because
 * lock machinery failing must never block the build it protects.
 *
 * EVERY ACQUISITION IS `wx`. The stale case never writes over anything: it steals the file out
 * from under the path (stealStaleLock) and then competes for the empty path exclusively like
 * everyone else, so two racers cannot both come away holding a lock.
 *
 * A LOCK THAT VANISHES MID-CHECK IS A RETRY, NOT A CRASH. Between the failed `wx` and the stat,
 * the holder may finish and drop it — statSync then throws ENOENT, and letting that escape would
 * degrade a perfectly ordinary hand-off into an UNLOCKED build (the caller's catch treats any
 * throw as "lock machinery unavailable"). The loop re-races instead, bounded by LOCK_ATTEMPTS.
 */
export function defaultTakeLock(lockPath, { attempts = LOCK_ATTEMPTS } = {}) {
  // Age, never negative: mtime is the OTHER process's clock (or a filesystem's, or an NFS
  // server's), so a lock stamped in the future would otherwise read as fresh for the whole skew
  // AND print `-4231s old` at the operator. Clamped at zero, skew merely costs patience.
  const ageOf = (st) => Math.max(0, Date.now() - st.mtimeMs);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const owner = lockToken();
    try {
      writeFileSync(lockPath, owner, { flag: 'wx' });
      return { ok: true, owner };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      let held;
      try {
        held = statSync(lockPath);
      } catch (statErr) {
        if (statErr?.code !== 'ENOENT') throw statErr;
        continue; // the holder dropped it between our write and our stat — race for it again
      }
      const ageMs = ageOf(held);
      if (ageMs < LOCK_STALE_MS) return { ok: false, ageMs };
      stealStaleLock(lockPath, held); // then loop back to the exclusive create
    }
  }
  // Contention this persistent is not a lock we can describe by age — quoting the age of a lock
  // that kept moving would print "20 minutes old, treated as dead" about a file that is anything
  // but settled. It is reported as its own state, with its own remedy. Fail closed either way.
  return { ok: false, contended: true };
}

/**
 * DOES THIS PROCESS STILL HOLD THE LOCK? The file's content is the only authority: exactly one
 * token can be in it, so of any number of processes that believe they took the lock, at most one
 * can pass this check. Called immediately before every spawn and before the stamp write, which
 * turns the acquire side's unavoidable residual (stealStaleLock's docblock) into a lost race
 * rather than two concurrent builds — the loser stops before it writes anything.
 *
 * An UNDEFINED owner is a seam that reports none (an injected takeLock in tests): nothing to
 * verify, so nothing is claimed. An UNREADABLE lock is not ours either — fail closed.
 */
export function holdsLock(lockPath, owner) {
  if (owner === undefined) return true;
  try { return readFileSync(lockPath, 'utf8') === owner; } catch { return false; }
}

/**
 * Drop the lock — but only the one this process actually took, and by the same steal-the-file
 * route the acquire side uses. A build that overran the stale bound has already had its lock
 * reclaimed by someone else, and reading the token then unlinking BY PATH is check-then-act: the
 * successor's lock can appear between the read and the unlink and be deleted by a build that is
 * on its way out. Renaming first makes the removal atomic and the ownership question answerable
 * on a file nobody else can reach; a lock that turns out not to be ours is put back untouched
 * (same inode, same mtime — `linkSync`, not a rewrite).
 */
export function defaultDropLock(lockPath, owner) {
  // No token: an injected takeLock seam that reports no owner (tests, fakes). Nothing to verify.
  if (owner === undefined) { rmSync(lockPath, { force: true }); return; }
  const tomb = `${lockPath}.drop-${randomUUID()}`;
  try {
    renameSync(lockPath, tomb);
  } catch (e) {
    if (e?.code === 'ENOENT') return; // already gone: nothing to drop
    throw e;
  }
  let held = null;
  try { held = readFileSync(tomb, 'utf8'); } catch { /* unreadable ⇒ treat as not ours */ }
  if (held === owner) { rmSync(tomb, { force: true }); return; }
  try {
    linkSync(tomb, lockPath); // a successor's lock, restored exactly as it was
  } catch (e) {
    if (e?.code !== 'EEXIST') { try { renameSync(tomb, lockPath); } catch { /* nothing left to try */ } return; }
  }
  rmSync(tomb, { force: true });
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

  // THE STALENESS QUESTION (header): does the present bundle match the present sources? The
  // EVIDENCE is gathered by _viewer-bundle.mjs's readBundleEvidence, the same call `legion
  // viewer` makes — the POLICY below is this command's own. A refused plan gathers nothing: it
  // is not going to build, and walking a tree whose package.json is missing would only be a slow
  // way to reach the same nulls.
  const { digest, stampDigest } = refusal === null
    ? readBundleEvidence(viewerDir, distDir, { listSources, readFile })
    : { digest: null, stampDigest: null };
  const stampPath = join(distDir, STAMP_FILE);
  // THE POLICY: anything unreadable on the stamp side counts as STALE and rebuilds, which is the
  // cheap direction — the opposite of `legion viewer`'s, which stays quiet on the same unknown
  // rather than warning on every pre-stamp install. An UNCOMPUTABLE digest (null) is the one
  // unknown that cannot decide anything, so it falls back to the old skip-if-built semantics.
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
  takeLock = defaultTakeLock,
  dropLock = defaultDropLock,
  checkLock = holdsLock,
} = {}) {
  if (plan.refusal !== null) return { ok: false, skipped: false, ran: [], failure: plan.refusal };
  if (plan.skip) {
    // A skip with a computed digest is a VERIFIED skip — the message may say so; the pinned
    // "already built" + "--force" shape stays either way.
    write(`legion viewer-build: bundle already built at ${plan.distDir}`
      + `${plan.digest !== null ? ' and up to date with viewer/ sources' : ''} — --force to rebuild it\n`);
    return { ok: true, skipped: true, ran: [], failure: null };
  }
  // The concurrency lock (LOCK_FILE): held-and-fresh ⇒ refuse before the first spawn; the lock
  // machinery itself failing (odd fs, fake trees in tests) degrades to building UNLOCKED — a
  // best-effort guard must never block the build it protects.
  const lockPath = join(plan.viewerDir, LOCK_FILE);
  let lock;
  try { lock = takeLock(lockPath); } catch { lock = { ok: true, unlocked: true }; }
  if (!lock.ok) {
    const failure = lock.contended === true
      ? lockContendedRefusal(lockPath)
      : lockRefusal(lockPath, lock.ageMs ?? 0);
    return { ok: false, skipped: false, ran: [], failure };
  }
  try {
    write(`legion viewer-build: building in ${plan.viewerDir} — a minute or two, and each step`
      + ' prints only once it has finished\n');
    const ran = [];
    // HOLDING THE LOCK IS RE-ESTABLISHED BEFORE EVERY SPAWN, never assumed from the take. The
    // acquire side can hand two processes a "yes" in one narrow interleaving (stealStaleLock's
    // docblock) — but only one token can be in the file, so this check is where that becomes a
    // lost race instead of two concurrent `npm ci`s in one tree. It costs one small read per step.
    const lost = () => ({ ok: false, skipped: false, ran, failure: lockStolenRefusal(lockPath) });
    for (const [file, args] of plan.steps) {
      if (!checkLock(lockPath, lock.owner)) return lost();
      write(`legion viewer-build: ${file} ${args.join(' ')}\n`);
      const r = run(file, args, { cwd: plan.viewerDir, timeoutMs: BUILD_TIMEOUT_MS });
      ran.push(`${file} ${args.join(' ')}`);
      // FAIL CLOSED: `npm run build` after a failed `npm ci` would either fail confusingly or, worse,
      // succeed against a stale node_modules and ship a bundle nobody asked for.
      if (!r.ok) return { ok: false, skipped: false, ran, failure: stepFailure(file, args, plan.viewerDir, r) };
    }
    // AND ONCE MORE BEFORE THE STAMP, which is this command's claim that dist matches the sources.
    // If the lock changed hands during the build, another builder is writing this same dist right
    // now and stamping it "verified fresh" would be the exact lie the stamp exists to prevent.
    if (!checkLock(lockPath, lock.owner)) return lost();
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
  } finally {
    // The owner token goes back so the drop can verify the lock is still THIS build's (see
    // defaultDropLock): a build that overran the stale bound must not delete its successor's lock.
    if (lock.unlocked !== true) { try { dropLock(lockPath, lock.owner); } catch { /* the age bound reclaims it */ } }
  }
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
