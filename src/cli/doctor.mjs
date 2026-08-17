// doctor.mjs — `legion doctor [--json] [--org <org>]`: env, hooks, forge CLI, branch protection
// and version pin. CONFORMANCE CHECKS, RUN BEFORE A FEATURE STARTS.
//
// READ-ONLY, ABSOLUTELY. It writes NO file, takes NO lock, mutates NO state and touches NO
// remote: every probe is a read, and the only outputs are stdout and the exit code. That is
// the property that makes it safe to run anywhere, at any moment, including mid-feature — and
// it is asserted in test/cli/doctor.test.mjs by snapshotting the legion home and the repo
// before and after a full run.
//
// EXIT CODE: 1 if ANY check is `fail`, else 0. `warn` NEVER fails the command. The three-level
// scale is not decoration, it is the whole point of the branch-protection check: only the SERVER
// is authoritative, so "we could not verify" and "we
// verified it is safe" must not collapse into the same green. A pass here is a claim, and a
// claim doctor cannot substantiate is a WARN that says so in words.
//
// EVERY EXTERNAL PROBE GOES THROUGH deps.run — the injected kernel/runner.mjs seam, shared
// with `legion finalize`. Nothing in this file imports child_process, and nothing spawns git
// itself: the git reads it needs (which project is this cwd — asked by the forge-auth,
// branch-protection and remote-guards checks; where this repository's hooks live — asked by
// remote-guards) happen inside resolveProject and inspectPrePushHook, both of which use the
// hardened git() (kernel/git.mjs header E). node:test therefore never runs a real
// `claude`, `glab` or `gh` and never touches the network. That read is taken with
// {fromAnyWorktree:true}: doctor is run FROM A FEATURE WORKTREE more often than from the main
// checkout, and a branch-protection check that cannot resolve the
// project there is a check that verifies nothing in production while still exiting 0.
//
// WHERE THE CLAUDE CODE VERSION PIN LIVES, AND WHY HERE. The pin asserts a MINIMUM TESTED
// Claude Code version. That pin is a KERNEL assertion — "this kernel was tested
// against >= X" — so it lives in kernel source, as the constant below, NOT as a
// `legion.minClaudeVersion` field in .claude-plugin/plugin.json: (a) plugin.json's schema is
// owned by Claude Code, and an unknown `legion.*` key is at the mercy of its validator;
// (b) plugin.json is data an agent may plausibly rewrite while "fixing the plugin", and a pin
// an agent can lower is not a pin; (c) it must version with the kernel that was tested, which
// is this file's repository. A whole kernel/version.mjs for one constant is over-build.
// null = NOT PINNED ⇒ the check is a WARN and `claude --version` is not even probed — never a
// silent pass, because "no pin" and "pin satisfied" are different facts. The pin is 2.1.219:
// the build every shipped hook and skill format was validated against (hooks/hooks.json,
// hooks/_common.mjs, skills/feature/SKILL.md all name it). Moving this number is a DELIBERATE
// KERNEL CHANGE: it claims a new floor was tested, so it moves only together with
// re-validated components.
//
// THE THREE LEVELS ARE THE SAME EPISTEMICS EVERYWHERE IN THIS FILE, version pin included:
// FAIL = VERIFIED bad (a version was read and it is below the pin); PASS = VERIFIED good;
// WARN = we did not obtain a version at all (no binary, spawn error, non-zero exit,
// unparsable output). An unknown is an unknown: it must not read as green, and it must not
// read as "your Claude Code is too old" either — doctor only ever fails on evidence it holds.
//
// FORGE AUTH IS JUDGED PER HOST AND PER FORGE, NOT GLOBALLY. `<cli> auth status` exits non-zero
// when ANY configured host lacks a usable token, and inheriting that global code would make doctor
// red on a real, fully-authenticated target host because an unrelated token-less gitlab.com
// entry sat in the operator's config. A red doctor nobody can act on is a red doctor
// operators learn to ignore. So: when a registered project resolves from cwd, the host is
// DERIVED from the project's recorded remoteUrl and the CLI from its resolved FORGE, and only
// that host on that CLI is probed (`glab|gh auth status --hostname <host>`) — a verdict about the
// one host every `legion finalize` and every branch-protection call will actually use.
// WHEN NO PROJECT RESOLVES, NEITHER THE HOST NOR THE FORGE IS KNOWN, so BOTH CLIs are probed
// (2026-08-15) and the report names what each one said. The FAIL is reserved for "NEITHER glab
// nor gh is installed": before the second forge this path failed hard on a missing glab, which
// for a GitHub-only operator is a red row about a tool they will never run — the same false
// alarm the host-scoping work removed, in a new costume. Everything else is a WARN that says
// why it could not be judged.
//
// THE CHECK ID `glab-auth` BECAME `forge-auth` ON 2026-08-15. That is a breaking change to the
// `--json` contract, taken deliberately: an id naming glab while the check runs `gh auth status`
// would be a standing lie in the surface built for honesty. See CHECK_IDS.
//
// THE CHECK ID `legion-on-path` WAS ADDED 2026-08-17, when the github-marketplace install route
// landed. Two legions can now legitimately coexist on one machine — a dev checkout and the
// auto-pulled marketplace clone — so WHICH kernel a bare `legion` reaches became a question with
// a wrong answer, and every skill, agent and workflow dispatch rides that answer. Extending
// CHECK_IDS extends the `--json` contract (consumers keying on array positions after
// `plugin-manifest` see a new row) — taken deliberately, same reasoning as the rename above.
//
// BRANCH PROTECTION FORKS BY FORGE, WITH ONE SET OF EPISTEMICS. GitLab reads protected_branches
// and the identity's access level; GitHub reads what a NON-ADMIN token can actually see (the
// repo's own `permissions`, the branch's `protected` bool, the active ruleset rules) and touches
// the admin-only protection detail only when the identity is an admin. The GitHub common case —
// write access, rules unreadable without admin — is a WARN that says exactly that, because a
// green there would be a claim about rules doctor never read.
//
// THE remote-guards CHECK NOW REPORTS A RETIRED LAYER'S LEFTOVERS. Legion's local push guards
// (the pre-push hook and the plugin's PreToolUse Bash scan) were REMOVED 2026-08-07 by owner
// decision: the server-side refusal the branch-protection check verifies is the ONLY barrier to
// a raw push, and a developer is free to push and open MRs by hand. The check keeps its id (it
// is the machine-readable `--json` contract) and its two-valued shape — PASS and WARN, never
// FAIL — but its question has inverted: it now exists to catch the MIGRATION HAZARD, a
// fail-closed stub installed by an older legion whose guard file this plugin no longer ships.
// Such a stub blocks EVERY ordinary push in its repository (`legion finalize`'s included) until
// it is removed, and `legion project init` / `legion feature start` are what remove it — doctor
// is read-only absolutely and only reports. It still cannot FAIL: a leftover stub is a local
// file problem with a one-command remedy, not a red light about the project's conformance.
//
// EVERY CHECK IS FAULT-ISOLATED: an unexpected throw inside one check becomes that check's own
// fail (or warn, for branch protection, where an unknown is an unknown) instead of killing the
// command — a doctor that dies on check 2 tells you nothing about checks 3-5, which is exactly
// when you need it. The ONE loud death is a usage error, which throws before any probe runs.
//
// TWO THINGS HERE ARE NOT CHECKS: the FORGE and TICKET CONFIG INFO LINES (forgeInfoLine,
// ticketInfoLine below). Each reports resolved config and WHICH LEVEL it came from, carries no
// verdict, never moves the exit code and is absent from `--json` — CHECK_IDS remains the
// machine-readable contract. ticketInfoLine's docblock argues why information rather than a
// seventh check, and why even a corrupt org.json is printed there rather than failed on.
//
// SHAPE: doctorCore(argv, deps) returns { code, checks, ticketInfo, forgeInfo, output } and writes NOTHING;
// run(argv) prints output and returns code. Tests assert the --json shape and the per-check levels
// off the returned value, with no stdout patching.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../kernel/args.mjs';
import { branchPatternMatches } from '../kernel/branches.mjs';
import { inspectPrePushHook } from '../kernel/githooks.mjs';
import { realRunner } from '../kernel/runner.mjs';
import { isMarketplaceClone, isMarketplaceInstall, resolveProject } from './feature.mjs';
// No import cycle: setup.mjs reaches doctor only through a runtime dynamic import, so this static
// edge is one-way. Sharing legionPathState is the point — setup's PATH step and the check below
// read the SAME evidence and can never disagree about what PATH holds.
import { legionPathState } from './setup.mjs';
import { closingKeyword, resolveForge, resolveTicketConfig } from '../kernel/ticket.mjs';
// remoteHost was this file's own `glabHost` until 2026-08-15; it moved to kernel/forge.mjs
// unchanged when the second forge arrived, because deriving a host from a remote URL was never
// GitLab-specific and finalize's forge selection needs the same derivation.
import { forgeTable, remoteHost } from '../kernel/forge.mjs';

const USAGE = 'legion doctor [--json] [--org <org>]';

/** The pinned MINIMUM Claude Code version — see header. Pinned at M0 to the build the shipped
 * hooks and skill formats were validated against; test/cli/doctor.test.mjs holds it to that. */
export const MIN_CLAUDE_VERSION = '2.1.219';

/** package.json declares engines.node '>=22'; this is the same number, enforced at runtime. */
const MIN_NODE_MAJOR = 22;

/** A probe that hangs is a doctor that hangs. Both `claude --version` and a glab API call are
 * sub-second when healthy; 15s is generous and still bounded. */
const PROBE_TIMEOUT_MS = 15_000;

/** protected_branches paging (see checkBranchProtection). 100 is GitLab's per_page maximum, so
 * this is the fewest round trips the API allows; the page cap only bounds a pathological or
 * looping server — reaching it degrades to UNVERIFIED rather than spinning. */
const PROTECTED_PER_PAGE = 100;
const PROTECTED_MAX_PAGES = 20;

/** src/cli/doctor.mjs → the plugin root. Derived from THIS file's location, never cwd: doctor
 * checks the plugin it is part of, not whatever repo the operator happens to stand in. */
const DEFAULT_PLUGIN_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The fixed check ids, in output order. Machine-readable consumers key on these.
 * `remote-guards` sits LAST, immediately after `branch-protection`: the two are about the same
 * layering and are read together, and this order puts the guarantee above the depth.
 * RENAMED 2026-08-15, deliberately and at a cost: `glab-auth` became `forge-auth` when the check
 * started probing gh as well as glab. The id IS the `--json` contract, so renaming it is a
 * breaking change to that contract — taken because the alternative is worse: an id that says
 * `glab` while the check verifies `gh auth status` is a standing lie in the one surface built
 * for honesty. The other five ids were already forge-neutral and are untouched.
 * `legion-on-path` (added 2026-08-17, see header) sits between `plugin-manifest` and
 * `forge-auth` rather than last, because the order is the story — environment, then plugin
 * conformance, then HOW THIS PLUGIN REACHES SESSIONS, then remote safety — and appending it
 * would break the documented "remote-guards sits LAST beside branch-protection" placement. */
export const CHECK_IDS = ['node', 'claude-version', 'plugin-manifest', 'legion-on-path', 'forge-auth', 'branch-protection', 'remote-guards'];

/** GitLab access levels, for details a human can act on. */
const ACCESS_NAMES = {
  0: 'no one', 5: 'minimal', 10: 'guest', 20: 'reporter', 30: 'developer', 40: 'maintainer',
  50: 'owner', 60: 'admin',
};
const levelName = (n) => `${ACCESS_NAMES[n] ?? 'level'} (${n})`;

/** Quoted, single-line, bounded excerpt of tool output — details must stay one table row. */
function excerpt(s, max = 200) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

// --- semver -----------------------------------------------------------------------------------

/** Numeric triple compare; a prerelease/build suffix is ignored (a pin is about the release
 * line, and refusing 2.1.0-beta against a 2.1.0 pin would be a false negative nobody can fix). */
export function cmpSemver(a, b) {
  const parse = (v) => {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v));
    if (!m) return null;
    return [Number(m[1]), Number(m[2]), Number(m[3])];
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa == null || pb == null) throw new Error(`not a semver triple: ${JSON.stringify(pa == null ? a : b)}`);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  return 0;
}

// --- checks -----------------------------------------------------------------------------------

function checkNode(nodeVersion) {
  const m = /^v?(\d+)\./.exec(String(nodeVersion));
  if (!m) return { level: 'fail', detail: `could not read a major version out of ${JSON.stringify(String(nodeVersion))}` };
  const major = Number(m[1]);
  return major >= MIN_NODE_MAJOR
    ? { level: 'pass', detail: `node ${nodeVersion} (>= ${MIN_NODE_MAJOR} required)` }
    : {
        level: 'fail',
        detail: `node ${nodeVersion} is below the required >= ${MIN_NODE_MAJOR} `
          + '(package.json engines.node) — the kernel uses node:test and modern builtins; upgrade node',
      };
}

function checkClaudeVersion(run, pin) {
  if (pin == null) {
    return {
      level: 'warn',
      detail: 'no minimum Claude Code version is pinned yet (see MIN_CLAUDE_VERSION in '
        + 'src/cli/doctor.mjs) — the running version cannot be verified',
    };
  }
  // WARN, NOT FAIL, ON EVERY "no version was read" BRANCH (header: the three levels). doctor is
  // also run from a plain shell where `claude` may not be on PATH at all while Claude Code
  // itself is perfectly healthy, and it is run by an agent that must not be told "your Claude
  // Code is too old" on evidence nobody has. The unknown is stated in words, and it never
  // becomes green.
  const r = run('claude', ['--version'], { timeoutMs: PROBE_TIMEOUT_MS });
  const unknown = (why) => ({ level: 'warn', detail: `${why} — the pinned minimum ${pin} is UNVERIFIED here` });
  if (r.spawnError === 'ENOENT') {
    return unknown('claude not found on PATH (legion ships as a Claude Code plugin, so this is usually a PATH problem, not a missing install)');
  }
  if (r.spawnError) return unknown(`\`claude --version\` could not run: ${r.spawnError}`);
  if (!r.ok) return unknown(`\`claude --version\` exited ${r.code}: ${excerpt(r.stderr || r.stdout)}`);
  // Trailing build tags are normal ('2.1.220 (Claude Code)'); the first numeric triple wins.
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(r.stdout ?? '');
  if (!m) {
    return unknown(`could not parse a version out of \`claude --version\` output ${JSON.stringify(excerpt(r.stdout, 80))}`);
  }
  const found = m[0];
  return cmpSemver(found, pin) < 0
    ? { level: 'fail', detail: `Claude Code ${found} is below the pinned minimum ${pin} — upgrade Claude Code` }
    : { level: 'pass', detail: `Claude Code ${found} (>= pinned minimum ${pin})` };
}

/** Manifest fields whose value, when a string or array of strings, names a path inside the
 * plugin. Claude Code lets a plugin declare these explicitly; a declared path that does not
 * exist is a plugin that half-loads with no error anyone sees. */
const DECLARED_PATH_FIELDS = ['commands', 'agents', 'skills', 'hooks', 'mcpServers'];

/** The plugin's own conformance: manifest parses, carries the fields the plugin spec requires,
 * and every component it declares (explicitly or by the root-directory convention) exists.
 * Pure filesystem — no runner, no cwd. Mirrors test/plugin-manifest.test.mjs's RUNTIME-relevant
 * subset; that test file is the authority on the repo layout and is NOT modified here. */
function checkPluginManifest(pluginRoot) {
  const manifestPath = join(pluginRoot, '.claude-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    return { level: 'fail', detail: `cannot read plugin manifest ${manifestPath}: ${e.message}` };
  }
  const problems = [];
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';
  if (!nonEmpty(manifest?.name)) problems.push('name must be a non-empty string');
  if (!nonEmpty(manifest?.description)) problems.push('description must be a non-empty string');
  if (!nonEmpty(manifest?.author?.name)) problems.push('author.name must be a non-empty string');
  // No `version`, DELIBERATELY: the plugin is versioned by git commit. Claude Code updates by
  // comparing version strings, and a static one reads as "unchanged" on every pull — installs
  // stay pinned to the cached copy and marketplace auto-update silently stops.
  if (manifest?.version !== undefined) {
    problems.push(`version must be omitted — a static version pins installs and defeats marketplace auto-update (got ${JSON.stringify(manifest.version)})`);
  }

  for (const dir of ['skills', 'agents', 'hooks', 'bin']) {
    const abs = join(pluginRoot, dir);
    let ok = false;
    try { ok = statSync(abs).isDirectory(); } catch { ok = false; }
    if (!ok) problems.push(`component directory ${dir}/ is missing at the plugin root`);
  }

  // The executable the whole kernel is: a manifest can be perfect and the plugin still ship
  // nothing runnable.
  const pkgPath = join(pluginRoot, 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const rel = pkg?.bin?.legion;
    if (!nonEmpty(rel)) problems.push('package.json bin.legion is not declared');
    else if (!existsSync(join(pluginRoot, rel))) problems.push(`package.json bin.legion points at ${rel}, which does not exist`);
  } catch (e) {
    problems.push(`cannot read ${pkgPath}: ${e.message}`);
  }

  // Explicitly declared component paths (present only once the manifest grows them).
  for (const field of DECLARED_PATH_FIELDS) {
    const v = manifest?.[field];
    const declared = typeof v === 'string' ? [v]
      : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v
      : [];
    for (const d of declared) {
      // ${CLAUDE_PLUGIN_ROOT} is the plugin spec's own placeholder for the root.
      const cleaned = d.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\/?/, '');
      const abs = isAbsolute(cleaned) ? cleaned : resolve(pluginRoot, cleaned);
      if (!existsSync(abs)) problems.push(`declared ${field} path ${d} does not exist (${abs})`);
    }
  }

  return problems.length
    ? { level: 'fail', detail: `plugin at ${pluginRoot} is malformed: ${problems.join('; ')}` }
    : { level: 'pass', detail: `plugin manifest and components valid at ${pluginRoot}` };
}

/** Does bare `legion` reach the kernel ANSWERING THIS DOCTOR? Every skill, agent and workflow
 * dispatch — and most remedies this file prints — invoke `legion` from PATH, so `legion` absent
 * is a VERIFIED broken install (fail: nothing shipped can run), and one resolving into a
 * DIFFERENT install is verified skew (warn: sessions run that kernel while this doctor speaks
 * for this one — the ordinary dev-checkout-plus-marketplace-clone hybrid, reported rather than
 * clobbered). The evidence is setup's own legionPathState, so setup's PATH step and this check
 * can never disagree. DELIBERATELY MINIMAL, zero spawns: it does NOT read
 * installed_plugins.json / known_marketplaces.json to compare snapshot commits — those files are
 * Claude Code's private schema, and a doctor keyed to them breaks silently on their next
 * migration; the on-disk layout this file couples to is the one the layout tests validate. */
function checkLegionOnPath(pathEnv, pluginRoot) {
  const s = legionPathState(pathEnv, pluginRoot);
  if (s.state === 'absent') {
    return {
      level: 'fail',
      detail: '`legion` is not on PATH — every skill, agent and workflow dispatches it from there. '
        + 'Run setup from your install: `cd <checkout> && ./bin/legion setup`, or '
        + '`node <config dir>/plugins/marketplaces/<name>/bin/legion.mjs setup` for a marketplace install',
    };
  }
  // THE ANCHOR QUESTION, ASKED FOR EVERY OUTCOME AND NOT JUST THE FOREIGN ONE: is the install
  // this doctor speaks for the SWEPT SNAPSHOT CACHE (`plugins/cache/<market>/<plugin>/<sha>`,
  // which Claude Code orphan-marks and deletes on the next update) rather than a durable home?
  // It shapes the FOREIGN branch's remedy — never prescribe `npm link` into a directory that is
  // about to be deleted — and it is the whole verdict in the OWN branch below.
  const snapshotResident = isMarketplaceInstall(pluginRoot) && !isMarketplaceClone(pluginRoot);
  if (s.state === 'foreign') {
    return {
      level: 'warn',
      detail: `\`legion\` on PATH resolves to ${s.resolved}, which is NOT this install `
        + `(${resolve(pluginRoot)}) — sessions run that kernel while this doctor speaks for this one`
        + (snapshotResident
          ? '; this doctor runs from the swept plugin snapshot — never npm link here; run doctor from the checkout or the marketplace clone instead'
          : `; if this install should win: cd ${resolve(pluginRoot)} && npm link`),
    };
  }
  // 'own' AND SNAPSHOT-RESIDENT IS THE STATE THE GUARD ABOVE WAS WRITTEN TO PREVENT, ARRIVED AT.
  // PATH's `legion` resolves INTO the swept cache — someone did npm link here, or npm's prefix
  // bin happens to point at it — so the link dangles the moment Claude Code sweeps this
  // directory, and every skill and agent dispatch dies with it. Reporting that as a green "(this
  // install)" because the two paths agree would make the check pass loudest exactly where it
  // matters most. A warn, not a fail: nothing is broken YET, and doctor does not repoint PATH.
  if (snapshotResident) {
    return {
      level: 'warn',
      // THE REMEDY MUST BE ONE SETUP WILL ACTUALLY PERFORM. "Run setup from the clone" does
      // nothing here: setup links only when `legion` is ABSENT from PATH (its asymmetric PATH
      // step), and from the clone this PATH reads 'foreign' — it would warn and touch nothing,
      // leaving the operator to follow a remedy, see no change, and distrust the check.
      detail: `\`legion\` on PATH → ${s.found} resolves into this install, but this install is the `
        + `swept plugin snapshot (${resolve(pluginRoot)}) — Claude Code deletes it on the next `
        + 'update and the link will dangle. Unlink it first, then re-link from a durable install: '
        + '`npm rm -g legion`, then run setup from the marketplace clone or your checkout',
    };
  }
  return { level: 'pass', detail: `\`legion\` on PATH → ${s.found} (this install)` };
}

/** THE HOST a project's remote lives on, for `<cli> auth status --hostname`. Moved to
 * kernel/forge.mjs on 2026-08-15 (it was `glabHost` here) and re-exported unchanged for
 * importers who reach it through doctor. */
export { remoteHost };

/** What each forge needs from DOCTOR, and only that: the two remedies an operator can act on.
 * id / cli / forgeName are NOT restated here — forgeTable merges them from kernel/forge.mjs's
 * FORGE_IDENTITY, the same base finalize's FORGE_OPS is built on, so the two tables cannot drift
 * on the identity facts and a forge missing from either throws at import (2026-08-15). */
const FORGE_PROBES = forgeTable({
  gitlab: {
    install: 'install it (https://gitlab.com/gitlab-org/cli) and run `glab auth login`',
    login: (host) => `glab auth login --hostname ${host}`,
  },
  github: {
    install: 'install it (https://cli.github.com) and run `gh auth login`',
    login: (host) => `gh auth login --hostname ${host}`,
  },
}, 'doctor FORGE_PROBES');

/** A block header in `glab auth status`: an UNINDENTED hostname line, its indented lines the
 * state of that host. Parsed CONSERVATIVELY and only for the unscoped rendering path — a
 * hostname here must carry a dot, so glab's own unindented prose ('Warning:', 'No hosts
 * configured') cannot be mistaken for a host. Missing a real host degrades to "could not read
 * the per-host state", i.e. a warn: this parser can lose a host, it can never invent one. */
const AUTH_HOST_LINE = /^([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9][A-Za-z0-9-]*)(?::\d+)?:?$/;

/** [{host, authenticated}] out of `<cli> auth status` output, in the order the CLI printed them.
 * authenticated = the block carries a ✓ line AND no error line: both CLIs mark a working host
 * with ✓ and a broken one with `x`/`X`/`✗` (plus `-` hints), and a block with neither is UNKNOWN,
 * which is not authenticated. ONE parser for both forges (2026-08-15): the marker sets are a
 * superset union, and neither CLI prints a leading `X` line to mean success — so widening cannot
 * turn a pass into a fail or the reverse, it can only read gh's blocks where before it read none.
 * EXPORTED for the parser table test. */
export function parseForgeAuthHosts(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (!/^\s/.test(line)) {
      const m = AUTH_HOST_LINE.exec(line.trim());
      cur = m ? { host: m[1].toLowerCase(), ok: false, bad: false } : null;
      if (cur) blocks.push(cur);
      continue;
    }
    if (cur == null) continue;
    const t = line.trim();
    if (t.startsWith('✓')) cur.ok = true;
    else if (/^[xX✗×]\s/.test(t)) cur.bad = true;
  }
  return blocks.map(({ host, ok, bad }) => ({ host, authenticated: ok && !bad }));
}

const missingCli = (p) => ({
  level: 'fail',
  detail: `${p.cli} not found on PATH — ${p.install}; `
    + '`legion finalize` and the branch-protection check both need it',
});

/** The verdict that matters: authenticated for THE host this project pushes to, with THE CLI
 * that project's forge drives. Every other host in the operator's CLI config is irrelevant to
 * this repository and is not consulted. */
function checkForgeAuthScoped(run, p, host, projectId) {
  const r = run(p.cli, ['auth', 'status', '--hostname', host], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.spawnError === 'ENOENT') return missingCli(p);
  if (r.spawnError) return { level: 'fail', detail: `\`${p.cli} auth status --hostname ${host}\` could not run: ${r.spawnError}` };
  if (!r.ok) {
    return {
      level: 'fail',
      detail: `${p.cli} is installed but not authenticated for ${host}, the host recorded for project ${projectId} `
        + `(exit ${r.code}) — run \`${p.login(host)}\`: ${excerpt(r.stderr || r.stdout)}`,
    };
  }
  return {
    level: 'pass',
    detail: `${p.cli} authenticated for ${host} (the remote host recorded for project ${projectId}): `
      + `${excerpt(r.stderr || r.stdout, 120)}`,
  };
}

/** ONE CLI's unscoped state, as a sentence — or null when that CLI is not installed at all.
 * Returns {good, text}. `good` is the ONE bit the caller can act on: every host this CLI printed
 * is authenticated AND it exited 0. Everything else — a host that is verifiably unauthenticated,
 * output no parser could read, a nonzero exit whose cause doctor could not see — is `false`, and
 * WHICH of them it was lives in `text`, which is what a human reads.
 * IT WAS A THREE-VALUED 'good'|'bad'|'unknown' UNTIL 2026-08-15 AND THE THIRD VALUE WAS A LIE:
 * this is the UNSCOPED path, which never fails on a per-host verdict (the whole reason it
 * exists), so 'bad' and 'unknown' produced an identical level and an identical remedy — a
 * distinction the type asserted and no branch honoured. Collapsed rather than given a behaviour
 * it does not deserve; the nuance was never lost, because it was always carried in the prose. */
function unscopedCliState(run, cli) {
  const r = run(cli, ['auth', 'status'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.spawnError === 'ENOENT') return null;
  if (r.spawnError) return { good: false, text: `\`${cli} auth status\` could not run: ${r.spawnError}` };
  const hosts = parseForgeAuthHosts(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  const good = hosts.filter((h) => h.authenticated).map((h) => h.host);
  const bad = hosts.filter((h) => !h.authenticated).map((h) => h.host);
  if (hosts.length === 0) {
    return {
      good: false,
      text: `\`${cli} auth status\` exited ${r.code} and no per-host state could be read out of it `
        + `(${excerpt(r.stderr || r.stdout, 120)})`,
    };
  }
  if (bad.length > 0) {
    return {
      good: false,
      text: `${cli} is authenticated for ${good.length ? good.join(', ') : 'no configured host'} and NOT for ${bad.join(', ')}`,
    };
  }
  // The parse says every host it READ is fine, yet the CLI itself exited non-zero: the two
  // disagree, and the parser is the lossy one (AUTH_HOST_LINE drops single-label hosts and any
  // block header upstream prints unindented but unlike a hostname — remoteHost accepts exactly
  // the single-label hosts this parser refuses). A pass here would assert "every configured
  // host" with contradicting evidence in hand. The exit code is honoured in the GREEN direction
  // ONLY: it can withhold a pass, it can never become the fail this check exists to stop
  // inheriting.
  if (!r.ok) {
    return {
      good: false,
      text: `\`${cli} auth status\` exited ${r.code} but every host doctor could read out of it is authenticated `
        + `(${good.join(', ')}), so a host it could not read may be the failing one`,
    };
  }
  return { good: true, text: `${cli} authenticated for every configured host (${good.join(', ')})` };
}

/** No project resolves (or its remote names no host), so neither the host NOR THE FORGE is
 * known. BOTH CLIs are probed (2026-08-15) and the report is per CLI: before the second forge
 * this path failed hard on a missing glab, which for a GitHub-only operator is a red row about
 * a tool they will never run — exactly the false alarm the host-scoping work removed. The fail
 * is now reserved for "NEITHER forge CLI is installed", which is the one state that leaves
 * `legion finalize` with nothing to drive whichever forge turns out to matter. Everything else
 * is a warn that says which CLI reported what and why nothing could be scoped. */
function checkForgeAuthUnscoped(run, why, knownForge = null) {
  // KNOWN FORGE, UNKNOWN HOST is a different ignorance from knowing neither: the project resolved
  // and told us which CLI `legion finalize` will drive, only its remote names no host to scope to.
  // Probing the OTHER forge's CLI there would report on a tool this project will never run — and,
  // since 2026-08-15, an absent CLI withholds the pass, so it would also manufacture a warn out of
  // an irrelevance. One forge known ⇒ one CLI probed, and a missing one is the same FAIL the
  // scoped path gives, because this project genuinely needs it.
  const probes = knownForge === null ? Object.values(FORGE_PROBES) : [FORGE_PROBES[knownForge]];
  const probed = probes.map((p) => [p, unscopedCliState(run, p.cli)]);
  const missing = probed.filter(([, s]) => s === null).map(([p]) => p.cli);
  const states = probed.filter(([, s]) => s !== null);
  const scope = `${why}, so doctor cannot tell which host or forge matters here`;
  const remedy = 'run doctor from a registered project checkout to have its host verified, or '
    + '`glab auth login --hostname <host>` / `gh auth login --hostname <host>`';
  if (states.length === 0) {
    return knownForge === null
      ? {
        level: 'fail',
        detail: 'neither glab nor gh was found on PATH — install the one your forge uses '
          + '(https://gitlab.com/gitlab-org/cli, https://cli.github.com) and authenticate it; '
          + '`legion finalize` and the branch-protection check both need it',
      }
      : missingCli(FORGE_PROBES[knownForge]);
  }
  const report = [
    ...states.map(([, s]) => s.text),
    ...missing.map((cli) => `${cli} is not installed`),
  ].join('; ');
  // A PASS HERE CLAIMS "authenticated for the forge that matters", AND NOTHING KNOWS WHICH THAT
  // IS. So an absent CLI withholds the pass (2026-08-15): with glab missing and gh healthy, a
  // GitLab project in this cwd has nothing to finalize with, and reporting green because the
  // OTHER forge's CLI is fine would be the false alarm's mirror image — a false all-clear. Both
  // installed and both good is the only shape that can honestly pass unscoped.
  if (missing.length === 0 && states.every(([, s]) => s.good)) {
    return { level: 'pass', detail: `${report} — ${why}, so no single host was verified as the target` };
  }
  return {
    level: 'warn',
    detail: `${report} — ${scope}, and an unauthenticated host this repository may never touch is not a `
      + `failure; ${remedy}`,
  };
}

/** Host-aware AND forge-aware (header). Resolution mirrors checkBranchProtection's, including
 * fromAnyWorktree: doctor runs inside feature worktrees, and a check that silently unscopes
 * itself there would be host-blind exactly where every push happens.
 * Returns {result, forge} — the forge is handed to checkBranchProtection so the two checks
 * cannot disagree about which server they are talking about. */
function checkForgeAuth(run, flags) {
  let projectId = null;
  let host = null;
  let why = null;
  let forge = null;
  let unresolved = null;
  try {
    const { entry, cfg } = resolveProject(flags, { fromAnyWorktree: true });
    projectId = `${entry.org}/${entry.name}`;
    host = remoteHost(cfg?.remoteUrl);
    // A RESOLVER FAILURE IS AN UNKNOWN, NOT A LICENCE TO GUESS (2026-08-15). This used to fall
    // back to `detectForge`, which can disagree with the project's own recorded override — doctor
    // would then verify gh, pass, and finalize would drive glab. An unknown forge is reported as
    // one: both this check and branch-protection go non-green, naming the resolver's own refusal,
    // which is also the refusal finalize will hit.
    try { forge = resolveForge(entry.org, entry.name, { remoteUrl: cfg?.remoteUrl }).value; }
    catch (e) { unresolved = excerpt(e.message, 200); }
    if (unresolved !== null) {
      return {
        result: {
          level: 'warn',
          detail: `the forge for project ${projectId} could not be resolved (${unresolved}) — doctor will not `
            + `guess which CLI to verify, and \`legion finalize\` refuses on the same error until the file is fixed`,
        },
        forge: null,
      };
    }
    if (host == null) {
      why = `project ${projectId} records no host-bearing remote (${JSON.stringify(cfg?.remoteUrl ?? null)})`;
    }
  } catch (e) {
    // excerpt: git's own refusals are multi-line, and a detail is one table row.
    why = `no registered project resolves from this cwd (${excerpt(e.message, 160)})`;
  }
  const probe = FORGE_PROBES[forge] ?? null;
  if (host == null || probe === null) {
    return { result: checkForgeAuthUnscoped(run, why, probe === null ? null : forge), forge };
  }
  return { result: checkForgeAuthScoped(run, probe, host, projectId), forge };
}

// --- branch protection -------------------------------------------------------------------------

const BEST_EFFORT =
  'only the server is authoritative, so while this is unverified the guarantee is best-effort';

/** owner/repo from a git remote URL, for GitHub's two-segment API paths. The general parser
 * below is deliberately loose (GitLab nests arbitrarily); GitHub does not, and a three-segment
 * path handed to `repos/{owner}/{repo}` would query something else entirely. Anything that is
 * not exactly two segments ⇒ null ⇒ the check WARNS rather than auditing the wrong repository. */
export function githubRepoPath(remoteUrl) {
  const p = gitlabProjectPath(remoteUrl);
  return p !== null && p.split('/').length === 2 ? p : null;
}

/** owner/sub/repo from a git remote URL. Handles scheme URLs (https://host/a/b.git) and the
 * scp-like form (git@host:a/b.git). Anything else ⇒ null ⇒ the check WARNS: guessing a project
 * path would audit the wrong project and report a pass for a repository nobody asked about. */
export function gitlabProjectPath(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') return null;
  const url = remoteUrl.trim();
  let p = null;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]+\/(.+)$/.exec(url);
  if (scheme) p = scheme[1];
  // `//` after the colon means a scheme URL that the pattern above REFUSED (no host, e.g.
  // file:///path). Falling through to the scp form would read the local path as owner/repo —
  // exactly the guess this function exists not to make.
  else if (!url.includes('://')) {
    const scp = /^(?:[^@/]+@)?[^@/:]+:(.+)$/.exec(url);
    if (scp) p = scp[1];
  }
  if (p == null) return null;
  p = p.replace(/^\/+/, '').replace(/\/+$/, '');
  if (p.endsWith('.git')) p = p.slice(0, -'.git'.length);
  return p !== '' && p.includes('/') ? p : null;
}

/** GitLab protected-branch wildcard semantics, re-exported here unchanged from kernel/branches.mjs
 * for importers who reach it through doctor. (Until 2026-08-07 the local pre-push guard was the
 * second consumer, kept in lockstep through this same kernel module; the guard is gone and the
 * server is now the only enforcement of these semantics.) */
export { branchPatternMatches };

/** One forge-CLI api call, parsed. Returns {value} or {error} — never throws, because EVERY
 * failure mode here (no network, 403, CLI version drift, HTML error page) means the same
 * thing to the caller: unverifiable. */
function forgeJson(run, cli, args, cwd) {
  const r = run(cli, args, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.spawnError) return { error: `\`${cli} ${args.join(' ')}\` could not run: ${r.spawnError}` };
  if (!r.ok) return { error: `\`${cli} ${args.join(' ')}\` exited ${r.code}: ${excerpt(r.stderr || r.stdout)}` };
  try {
    return { value: JSON.parse(r.stdout) };
  } catch (e) {
    return { error: `\`${cli} ${args.join(' ')}\` did not return JSON (${e.message}): ${excerpt(r.stdout, 120)}` };
  }
}
const glabJson = (run, args, cwd) => forgeJson(run, 'glab', args, cwd);
/** `gh api` with the host PINNED (2026-08-15). Without `--hostname` gh sends a literal endpoint to
 * its DEFAULT host — github.com whenever more than one host is authenticated — so on a GHE tenant
 * doctor would audit `github.com/<owner>/<repo>`: a repository nobody asked about, and a green
 * there is exactly the verdict this check refuses to produce. The host is the one the auth check
 * scoped to, derived from the same recorded remote. */
const ghJson = (run, host, args, cwd) => forgeJson(run, 'gh', [...args, '--hostname', host], cwd);

/** THE GITHUB half of the server-side check (2026-08-15), with GitLab's epistemics preserved
 * exactly: fail = VERIFIED bad, pass = VERIFIED good, warn = UNVERIFIABLE, and ambiguity never
 * becomes a pass.
 * WHAT MAKES GITHUB DIFFERENT, and it is not a shortcoming of this code: the classic protection
 * DETAIL endpoint (`repos/{o}/{r}/branches/{b}/protection`) requires ADMIN. A non-admin agent
 * identity — the ordinary, CORRECT setup — cannot read the rules that bind it. So the probes
 * used here are the ones a plain read token can see:
 *   - `repos/{o}/{r}` → `permissions` for THIS identity (push/admin booleans);
 *   - `repos/{o}/{r}/branches/{b}` → `protected`, a bool that says a rule EXISTS;
 *   - `repos/{o}/{r}/rules/branches/{b}` → the active RULESET rules that apply to the branch,
 *     readable with read access and the modern replacement for classic protection.
 * The detail endpoint is consulted ONLY when the identity is admin (i.e. when it is readable at
 * all), and admin is also the case where a `pull_request` rule alone proves nothing — an admin
 * can bypass unless the rule says otherwise, which is precisely what cannot be read without
 * enumerating bypass actors. That case is a WARN naming the reason, never a green. */
function checkGithubBranchProtection(run, cfg, repoRoot, branches, recorded) {
  const path = githubRepoPath(cfg?.remoteUrl);
  const host = remoteHost(cfg?.remoteUrl);
  if (host == null) {
    return {
      level: 'warn',
      detail: `cannot derive a host from the recorded remote ${JSON.stringify(cfg?.remoteUrl ?? null)}, and an `
        + `unscoped \`gh api\` would query gh's DEFAULT host instead — protection UNVERIFIED (${recorded}); ${BEST_EFFORT}`,
    };
  }
  if (path == null) {
    return {
      level: 'warn',
      detail: `cannot derive an owner/repo path from the recorded remote ${JSON.stringify(cfg?.remoteUrl ?? null)} `
        + `— protection UNVERIFIED (${recorded}); ${BEST_EFFORT}`,
    };
  }
  const unverified = (why) => ({ level: 'warn', detail: `${why} — protection of ${path} UNVERIFIED (${recorded}); ${BEST_EFFORT}` });

  const repo = ghJson(run, host, ['api', `repos/${path}`], repoRoot);
  if (repo.error) return unverified(repo.error);
  const perms = repo.value?.permissions;
  if (perms === null || typeof perms !== 'object' || Array.isArray(perms)) {
    // The same rule as GitLab's both-absent case: two unknowns must not compute a green.
    return unverified(`\`gh api repos/${path}\` reported no permissions object, so the agent identity's access is unknown`);
  }
  // ABSENT IS NOT FALSE (the rule GitLab's branch states as "ABSENT IS NOT EMPTY"). A `{}` or a
  // partial permissions object would make `push === true` false and read as "this identity cannot
  // push" — an UNKNOWN turned into the very fact the pass verdict rests on. Both booleans must be
  // present and boolean before anything is derived from them.
  if (typeof perms.push !== 'boolean' || typeof perms.admin !== 'boolean') {
    return unverified(
      `\`gh api repos/${path}\` returned a permissions object without boolean push/admin fields `
      + `(${JSON.stringify(perms).slice(0, 120)}), so the agent identity's access is unknown`,
    );
  }
  const canPush = perms.push === true || perms.maintain === true || perms.admin === true;
  const isAdmin = perms.admin === true;

  const bad = [];
  const unknown = [];
  for (const branch of branches) {
    // GitLab's protected-branch WILDCARDS have no per-branch GitHub query: `release/*` names a
    // pattern, and `repos/.../branches/release/*` is not a branch. Refusing to answer is the
    // only honest option — inventing a match would be a verdict about branches nobody named.
    if (branch.includes('*')) {
      unknown.push(`'${branch}' is a wildcard pattern, and GitHub protection cannot be queried per pattern from here`);
      continue;
    }
    const enc = branch.split('/').map(encodeURIComponent).join('/');
    const b = ghJson(run, host, ['api', `repos/${path}/branches/${enc}`], repoRoot);
    if (b.error) { unknown.push(b.error); continue; }
    const classic = b.value?.protected === true;

    const rules = ghJson(run, host, ['api', `repos/${path}/rules/branches/${enc}`], repoRoot);
    if (rules.error) { unknown.push(rules.error); continue; }
    if (!Array.isArray(rules.value)) { unknown.push(`\`gh api repos/${path}/rules/branches/${enc}\` did not return a list`); continue; }
    const types = rules.value.map((r) => r?.type).filter((t) => typeof t === 'string');
    const ruleProtected = types.includes('pull_request') || types.includes('non_fast_forward');

    if (!classic && !ruleProtected) {
      bad.push(`'${branch}' is NOT protected on ${path} (no branch protection and no ruleset rule applies to it)`);
      continue;
    }
    // PROTECTED — but protected against WHOM? That is the question a pass has to answer.
    if (!canPush) continue; // VERIFIED: this identity cannot push the branch at all
    if (!isAdmin) {
      unknown.push(
        `'${branch}' is protected on ${path} and the agent identity has write access, but the rules that bind it `
        + '(required reviews, push restrictions, bypass actors) need admin to read — the common GitHub case',
      );
      continue;
    }
    const prot = ghJson(run, host, ['api', `repos/${path}/branches/${enc}/protection`], repoRoot);
    if (prot.error) { unknown.push(prot.error); continue; }
    const requiresPr = prot.value?.required_pull_request_reviews != null;
    const enforceAdmins = prot.value?.enforce_admins?.enabled === true;
    if (requiresPr && enforceAdmins) continue; // VERIFIED: admins included in the requirement
    bad.push(
      `the agent identity is an ADMIN of ${path} and '${branch}' does not bind it — `
      + `${requiresPr ? 'enforce_admins is off' : 'no pull-request requirement is configured'}, so it CAN push directly`,
    );
  }
  if (bad.length) {
    return {
      level: 'fail',
      detail: `${bad.join('; ')} — fix it in GitHub: Settings → Branches (or Rules → Rulesets) (${recorded})`,
    };
  }
  if (unknown.length) return unverified(unknown.join('; '));
  return {
    level: 'pass',
    detail: `server-side protection VERIFIED on ${path}: every recorded branch is protected and the agent identity `
      + `cannot push ${branches.join(', ')} directly`,
  };
}

/** THE server-side check (layer 1). Three-valued on purpose:
 *   fail — VERIFIED bad: a recorded branch is unprotected, or the agent identity CAN push/merge it;
 *   pass — VERIFIED good: every recorded branch is protected and the identity is excluded;
 *   warn — UNVERIFIABLE: no glab, no network, an API error, an unresolvable project, a rule
 *          granted to a GROUP whose membership we cannot evaluate, or an empty recorded set.
 * Ambiguity NEVER becomes a pass: a green that really means "could not tell" is the single
 * outcome this check refuses to produce. */
function checkBranchProtection(run, flags, authOk, forge) {
  let resolved;
  try {
    // fromAnyWorktree: doctor must answer in the cwd sessions RUN IN. Every feature session
    // launches inside a linked worktree, where resolution by checkout
    // finds no registered entry — this check would then warn "unverified" on every real
    // invocation, i.e. the one hard boundary of remote safety would be inert in production
    // while doctor still exited 0. Read-only, so resolving by REPOSITORY is safe here in a way
    // it is not for the feature commands (see resolveProject's docblock).
    resolved = resolveProject(flags, { fromAnyWorktree: true });
  } catch (e) {
    // Not a git repo, or a repository nobody registered. Unverifiable, not broken.
    return { level: 'warn', detail: `cannot resolve a registered project from cwd: ${e.message} — protection UNVERIFIED; ${BEST_EFFORT}` };
  }
  const { entry, cfg, repoRoot } = resolved;
  const id = `${entry.org}/${entry.name}`;
  const branches = Array.isArray(cfg?.protectedBranches) ? cfg.protectedBranches : [];
  if (branches.length === 0) {
    return {
      level: 'warn',
      detail: `project ${id} records no protected branches (\`legion project init --no-protected\`) — `
        + `there is nothing to verify; ${BEST_EFFORT}`,
    };
  }
  const recorded = `recorded by \`legion project init\`: ${branches.join(', ')}`;
  const cli = FORGE_PROBES[forge]?.cli ?? 'the forge CLI';
  if (!authOk) {
    // "not VERIFIED authenticated", not "unauthenticated": since the auth check became
    // host-aware it also warns when it could not decide WHICH host to judge, and that is not
    // the same fact as a missing token. Either way the server is not reachable with proof.
    return { level: 'warn', detail: `${cli} is not verified authenticated (see the forge-auth check), so server-side protection is UNVERIFIED (${recorded}); ${BEST_EFFORT}` };
  }
  if (forge === 'github') return checkGithubBranchProtection(run, cfg, repoRoot, branches, recorded);
  const path = gitlabProjectPath(cfg?.remoteUrl);
  if (path == null) {
    return {
      level: 'warn',
      detail: `cannot derive a GitLab project path from the recorded remote ${JSON.stringify(cfg?.remoteUrl ?? null)} `
        + `— protection UNVERIFIED (${recorded}); ${BEST_EFFORT}`,
    };
  }
  const enc = encodeURIComponent(path);
  const unverified = (why) => ({ level: 'warn', detail: `${why} — protection of ${path} UNVERIFIED (${recorded}); ${BEST_EFFORT}` });

  const me = glabJson(run, ['api', 'user'], repoRoot);
  if (me.error) return unverified(me.error);
  const myId = me.value?.id;
  if (typeof myId !== 'number') return unverified('`glab api user` returned no numeric id, so the agent identity is unknown');

  const proj = glabJson(run, ['api', `projects/${enc}`], repoRoot);
  if (proj.error) return unverified(proj.error);
  const projectAccess = proj.value?.permissions?.project_access?.access_level;
  const groupAccess = proj.value?.permissions?.group_access?.access_level;
  if (typeof projectAccess !== 'number' && typeof groupAccess !== 'number') {
    // DELIBERATE (stricter than max(?? 0)): with both absent we do not know our own level, and
    // computing 0 from two unknowns would turn "cannot tell" into "cannot push" — a false pass.
    return unverified(`\`glab api projects/${enc}\` reported neither permissions.project_access nor .group_access, so the agent identity's access level is unknown`);
  }
  const level = Math.max(typeof projectAccess === 'number' ? projectAccess : 0, typeof groupAccess === 'number' ? groupAccess : 0);

  // PAGED EXPLICITLY, because a PARTIAL list read as complete is a verified-sounding lie in the
  // FAIL direction: GitLab REST lists default to 20 per page, and a project whose per-release
  // wildcards push the recorded branch's rule onto page 2 would be reported "NOT protected" —
  // evidence we never established.
  // WHY NOT `glab api --paginate`: not because it cannot be parsed — glab 1.105.0 documents
  // `--output json` (its default) as emitting arrays as ONE JSON array, so glabJson's single
  // JSON.parse would cope. We page ourselves for two reasons it does not give us: the work stays
  // BOUNDED (--paginate walks until the server stops, and doctor is a fast preflight, not a
  // crawler), and the request shape stops depending on one CLI version's pagination output
  // default — a silent switch to ndjson upstream would turn this check into a parse error.
  // A list we cannot finish reading is UNKNOWN, never a verdict in either direction — the same
  // rule as the access-level lists below.
  const protRules = [];
  for (let page = 1; ; page += 1) {
    if (page > PROTECTED_MAX_PAGES) {
      // "AT LEAST", not "more than": all we proved is that PROTECTED_MAX_PAGES full pages came
      // back — the next page could well be empty. Overstating here would be the same
      // claim-beyond-the-evidence this check exists to refuse.
      return unverified(
        `${path} has at least ${PROTECTED_MAX_PAGES * PROTECTED_PER_PAGE} protected-branch rules `
        + `(the ${PROTECTED_MAX_PAGES}-page read cap), so the list could not be read completely`,
      );
    }
    const q = `projects/${enc}/protected_branches?per_page=${PROTECTED_PER_PAGE}&page=${page}`;
    const prot = glabJson(run, ['api', q], repoRoot);
    if (prot.error) return unverified(prot.error);
    if (!Array.isArray(prot.value)) return unverified(`\`glab api ${q}\` did not return a list`);
    protRules.push(...prot.value);
    // A SHORT page is the only proof of exhaustion we have; a full one means "maybe more".
    if (prot.value.length < PROTECTED_PER_PAGE) break;
  }

  const bad = [];
  const unknown = [];
  for (const branch of branches) {
    const rules = protRules.filter((e) => typeof e?.name === 'string' && branchPatternMatches(e.name, branch));
    if (rules.length === 0) {
      bad.push(`'${branch}' is NOT protected on ${path}`);
      continue;
    }
    for (const rule of rules) {
      for (const [kind, list] of [['push', rule.push_access_levels], ['merge', rule.merge_access_levels]]) {
        if (!Array.isArray(list)) {
          // ABSENT IS NOT EMPTY (the same rule as permissions.project_access above). An empty
          // array is an answer — nobody is allowed — but a missing or non-array one means the
          // server never told us who may ${kind}, and iterating nothing would fall through to
          // "VERIFIED: can neither push nor merge": a permission list we did not read reported
          // as proven safe. Degrade to UNVERIFIED instead.
          unknown.push(`rule '${rule.name}' on '${branch}' carries no ${kind}_access_levels list, so who may ${kind} it could not be read`);
          continue;
        }
        for (const a of list) {
          if (a?.user_id != null) {
            if (a.user_id === myId) bad.push(`the agent identity (user ${myId}) is an explicit ${kind} exception on '${branch}' (rule '${rule.name}')`);
            continue; // some OTHER user's exception is not our problem to report
          }
          if (a?.group_id != null) {
            unknown.push(`rule '${rule.name}' grants ${kind} on '${branch}' to group ${a.group_id}, whose membership cannot be evaluated from here`);
            continue; // never assume we are NOT in that group
          }
          const allowed = a?.access_level;
          if (typeof allowed !== 'number') {
            unknown.push(`rule '${rule.name}' carries a ${kind} entry with no access_level on '${branch}'`);
            continue;
          }
          if (allowed === 0) continue; // GitLab's "No one"
          if (level >= allowed) {
            bad.push(`the agent identity (${levelName(level)}) CAN ${kind} '${branch}' — rule '${rule.name}' allows ${levelName(allowed)} and above`);
          }
        }
      }
    }
  }
  if (bad.length) {
    return {
      level: 'fail',
      detail: `${bad.join('; ')} — fix it in GitLab: Settings → Repository → Protected branches (${recorded})`,
    };
  }
  if (unknown.length) return unverified(unknown.join('; '));
  return {
    level: 'pass',
    detail: `server-side protection VERIFIED on ${path}: the agent identity (${levelName(level)}) can neither push nor merge ${branches.join(', ')}`,
  };
}

// --- remote guards (retired layer — leftover-stub migration check) -------------------------------

/** THE framing every remote-guards detail carries, pass and warn alike (header): the local
 * guards are GONE, and the server refusal — the one the branch-protection check above verifies —
 * is the only barrier to a raw push. Named here once so the pass and every warn make the same
 * claim an operator cannot read past. */
const SERVER_ONLY =
  'legion\'s local push guards were REMOVED (the pre-push hook and the PreToolUse Bash guard) — '
  + 'the server-side refusal the branch-protection check above verifies is the ONLY barrier to a '
  + 'raw push';

/** THE RETIRED LAYER, REPORTED HONESTLY. PASS = no leftover legion stub routes this repository's
 * pushes into a dead guard (absent, or the operator's own hook — which is none of legion's
 * business now). WARN = a leftover legion stub is present (git will run it and fail every push —
 * remedy named), it is inert litter, or the state is unreadable. NEVER fail (header). Resolution
 * mirrors its neighbours, `fromAnyWorktree` included: doctor is run from feature worktrees more
 * than anywhere else, and the hook lives in the shared common dir, so a check that went blind
 * there would be silent exactly where every push happens. */
function checkRemoteGuards(flags) {
  let resolved;
  try {
    resolved = resolveProject(flags, { fromAnyWorktree: true });
  } catch (e) {
    return {
      level: 'warn',
      detail: `cannot resolve a registered project from cwd: ${excerpt(e.message, 200)} — whether a `
        + `leftover pre-push stub is present here is UNKNOWN; ${SERVER_ONLY}`,
    };
  }
  const { entry, repoRoot } = resolved;
  const id = `${entry.org}/${entry.name}`;
  const r = inspectPrePushHook(repoRoot);
  const warn = (detail) => ({ level: 'warn', detail: `${detail}; ${SERVER_ONLY}` });
  switch (r.status) {
    case 'clean':
      return {
        level: 'pass',
        detail: `no leftover legion pre-push stub for ${id} — ${SERVER_ONLY}`,
      };
    case 'foreign':
      return {
        level: 'pass',
        detail: `${r.path} holds the operator's own pre-push hook (not legion's, untouched) — ${SERVER_ONLY}`,
      };
    case 'leftover':
      // THE REMEDY MUST BE TRUE FOR THE PATH IT NAMES: the remover acts on the DEFAULT hooks dir
      // only (githooks.mjs decision B), so a stub git reads through a core.hooksPath redirect is
      // one no legion command will ever delete — prescribing `legion project init` there would
      // send the operator down the one path guaranteed to change nothing, silently.
      return warn(`${r.path} is a legion pre-push stub from a version that shipped local guards; its `
        + `guard file no longer exists, so EVERY ordinary push in ${id} (\`legion finalize\`'s `
        + 'included) fails inside it — '
        + (r.redirected
          ? 'it sits in a core.hooksPath-redirected directory legion never touches: delete the file by hand'
          : 'run `legion project init` in that repository to remove it, or delete the file by hand'));
    case 'leftover-inert':
      return warn(`${r.path} is a leftover legion pre-push stub (${r.detail ?? 'not executable'}) — it `
        + 'blocks nothing, but '
        + (r.redirected
          ? 'it sits in a core.hooksPath-redirected directory legion never touches: clear the litter by hand'
          : 'run `legion project init` in that repository to clear the litter'));
    default:
      return warn(`the pre-push hook state of ${id} could not be read (${r.detail ?? 'unknown'})`);
  }
}

// --- ticket config: INFORMATION, NOT A CHECK -----------------------------------------------------

/** THE one ticket line. It is deliberately NOT a doctor check, and the distinction is the
 * point rather than an implementation convenience: a check carries a VERDICT, and doctor's verdicts
 * are about conformance — things that can be wrong and must be fixed before a feature starts. Ticket
 * config cannot be wrong in that sense. Every value it can hold is a legitimate operator choice, and
 * a project with no ticket config at all is the ordinary, healthy case. Rendering it as a `pass`
 * would claim a verification nobody performed; as a `warn` it would push a permanent yellow row at
 * every operator who does not use the ticket track. So it is an INFO line under the table, it never
 * moves the exit code, and CHECK_IDS — the machine-readable contract `--json` serves — is unchanged.
 * WHAT IT MUST SHOW IS THE LEVEL EACH FIELD CAME FROM. Three-level config (plugin default / org /
 * project, kernel/ticket.mjs) is undebuggable when you can see only the winner: an operator whose
 * org.json override "did nothing" needs to be told that project.json outranked it.
 * A CORRUPT org.json SURFACES HERE AS TEXT AND NEVER AS A FAIL. Doctor's own rule is that it fails
 * only on evidence it holds about conformance (header: the three levels), and this is not that —
 * but the resolver refuses loudly rather than silently defaulting, so the refusal is printed
 * verbatim. Silence would be the one unacceptable outcome. */
function ticketInfoLine(flags) {
  const prefix = 'info  ticket config';
  let org;
  let project;
  try {
    const { entry } = resolveProject(flags, { fromAnyWorktree: true });
    org = entry.org;
    project = entry.name;
  } catch (e) {
    // Not a defect: doctor runs from plain shells too. Say which levels were not consulted rather
    // than printing a resolved-looking line that consulted nothing.
    return `${prefix}  no registered project resolves from this cwd (${excerpt(e.message, 120)}), so `
      + 'neither the org nor the project level was read — the plugin default applies: issues in the '
      + `code repository's own forge project, closing line \`${closingKeyword('closes')} #<iid>\``;
  }
  const id = `${org}/${project}`;
  let cfg;
  try {
    cfg = resolveTicketConfig(org, project);
  } catch (e) {
    return `${prefix}  UNRESOLVED for ${id}: ${excerpt(e.message, 260)} `
      + '(doctor does not fail on this: ticket config gates nothing and certifies nothing — but '
      + 'nothing that renders a ticket line can run until the file is fixed or removed)';
  }
  const project_ = cfg.ticketProject.value === null
    ? "the code repository's own forge project"
    : cfg.ticketProject.value;
  return `${prefix}  issues in ${project_} [${cfg.ticketProject.from}]; closing line `
    + `\`${closingKeyword(cfg.ticketClosingStyle.value)} #<iid>\` [${cfg.ticketClosingStyle.from}] `
    + '— resolved fresh at every use, pinned nowhere';
}

/** THE forge line — information, not a check, for exactly ticketInfoLine's reasons: every value
 * it can hold is a legitimate operator choice, so a verdict would claim a verification nobody
 * performed. What it must show is WHICH LEVEL decided (project.json, org.json, URL detection or
 * the plugin default), because a four-level resolution is undebuggable when you can see only the
 * winner — an operator whose GHES override "did nothing" needs to be told that detection never
 * ran. Absent from `--json`: CHECK_IDS remains the machine-readable contract. */
function forgeInfoLine(flags) {
  const prefix = 'info  forge';
  let org;
  let project;
  let remoteUrl = null;
  try {
    const { entry, cfg } = resolveProject(flags, { fromAnyWorktree: true });
    org = entry.org;
    project = entry.name;
    remoteUrl = cfg?.remoteUrl ?? null;
  } catch (e) {
    return `${prefix}  no registered project resolves from this cwd (${excerpt(e.message, 120)}), so no forge was `
      + 'resolved — `legion project init` records one, detected from the origin remote';
  }
  const id = `${org}/${project}`;
  let r;
  try { r = resolveForge(org, project, { remoteUrl }); }
  catch (e) {
    return `${prefix}  UNRESOLVED for ${id}: ${excerpt(e.message, 260)} `
      + '(doctor does not fail on this, but `legion finalize` refuses until the file is fixed or removed)';
  }
  const cli = FORGE_PROBES[r.value]?.cli ?? '(no CLI)';
  return `${prefix}  ${r.value} — \`${cli}\` drives the merge/pull request for ${id} [${r.from}]`
    + '; override with `legion project init --forge <gitlab|github>`';
}

// --- core --------------------------------------------------------------------------------------

/** Human table: level, check id, detail — plus a count line, plus a verdict line when red, plus the
 * TWO info lines (forge + ticket: information, not checks — they sit after the verdict so a
 * red doctor's remedy is never pushed off the last line a reader looks at). */
function renderTable(checks, ticketInfo, forgeInfo) {
  const w = Math.max(...checks.map((c) => c.check.length));
  const count = (level) => checks.filter((c) => c.level === level).length;
  const lines = checks.map((c) => `${c.level.toUpperCase().padEnd(4)}  ${c.check.padEnd(w)}  ${c.detail}`);
  lines.push('', `doctor: ${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail`);
  if (count('fail') > 0) lines.push('FAIL — fix the failing checks before starting a feature');
  const info = [forgeInfo, ticketInfo].filter((l) => l != null);
  if (info.length > 0) lines.push('', ...info);
  return `${lines.join('\n')}\n`;
}

/**
 * The testable core. Writes NOTHING and returns everything.
 * @param {string[]} argv unsplit argv (kernel/args.mjs invariant)
 * @param {{run: Function, minClaudeVersion?: string|null, nodeVersion?: string, pluginRoot?: string, pathEnv?: string}} deps
 * @returns {Promise<{code: number, checks: Array<{check: string, level: string, detail: string}>, output: string}>}
 */
export async function doctorCore(argv, deps = {}) {
  const {
    run,
    minClaudeVersion = MIN_CLAUDE_VERSION,
    nodeVersion = process.version,
    pluginRoot = DEFAULT_PLUGIN_ROOT,
    pathEnv = process.env.PATH,
  } = deps;
  if (typeof run !== 'function') throw new Error('doctorCore requires deps.run — the kernel/runner.mjs seam');

  const { flags, positional } = parseArgs(argv, { bools: ['json'] });
  // Usage errors die BEFORE any probe: a typo must not be answered with a report.
  if (positional.length > 0) {
    throw new Error(`unexpected argument '${positional[0]}'. usage: ${USAGE}`);
  }

  const checks = [];
  /** Fault isolation (header): one check's surprise never silences the other four. */
  const add = (check, fn, onThrow = 'fail') => {
    let r;
    try {
      r = fn();
    } catch (e) {
      r = { level: onThrow, detail: `check threw: ${e?.message ?? e}` };
    }
    checks.push({ check, level: r.level, detail: r.detail });
    return r;
  };

  add('node', () => checkNode(nodeVersion));
  add('claude-version', () => checkClaudeVersion(run, minClaudeVersion));
  add('plugin-manifest', () => checkPluginManifest(pluginRoot));
  add('legion-on-path', () => checkLegionOnPath(pathEnv, pluginRoot));
  // The forge the auth check resolved is REUSED by branch protection: two checks that resolved
  // it independently could disagree about which server they are describing.
  let forge = null;
  const auth = add('forge-auth', () => {
    const r = checkForgeAuth(run, flags);
    forge = r.forge;
    return r.result;
  });
  // The CLI absent/unauthed makes the server unreachable: branch protection is then UNVERIFIABLE
  // (warn), not unprotected (fail). The overall exit is already 1 from forge-auth itself.
  add('branch-protection', () => checkBranchProtection(run, flags, auth.level === 'pass', forge), 'warn');
  // 'warn' on throw for the same reason the check never fails: a depth layer whose state could
  // not be read is an unknown, and an unknown here must not turn doctor red.
  add('remote-guards', () => checkRemoteGuards(flags), 'warn');

  const code = checks.some((c) => c.level === 'fail') ? 1 : 0;
  // Fault-isolated like every check: a surprise in config resolution must not cost the operator
  // the five conformance verdicts they actually ran doctor for.
  let ticketInfo;
  try { ticketInfo = ticketInfoLine(flags); }
  catch (e) { ticketInfo = `info  ticket config  could not be reported: ${excerpt(e?.message ?? e, 200)}`; }
  let forgeInfo;
  try { forgeInfo = forgeInfoLine(flags); }
  catch (e) { forgeInfo = `info  forge  could not be reported: ${excerpt(e?.message ?? e, 200)}`; }
  // --json IS THE CHECK ARRAY and stays exactly that: consumers key on CHECK_IDS and on the array
  // shape, and the info lines are not checks (ticketInfoLine's docblock). They ride the human
  // render, and the returned object carries them for anything that wants them structurally.
  const output = flags.json ? `${JSON.stringify(checks, null, 2)}\n` : renderTable(checks, ticketInfo, forgeInfo);
  return { code, checks, ticketInfo, forgeInfo, output };
}

export async function run(argv) {
  const r = await doctorCore(argv, { run: realRunner().run });
  process.stdout.write(r.output);
  return r.code;
}
