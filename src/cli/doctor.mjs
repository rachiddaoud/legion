// doctor.mjs — `legion doctor [--json] [--org <org>]`: env, hooks, glab, branch protection
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
// itself: the git reads it needs (which project is this cwd — asked by the glab-auth,
// branch-protection and remote-guards checks; where this repository's hooks live — asked by
// remote-guards) happen inside resolveProject and inspectPrePushHook, both of which use the
// hardened git() (kernel/git.mjs header E). node:test therefore never runs a real
// `claude` or `glab` and never touches the network. That read is taken with
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
// GLAB AUTH IS JUDGED PER HOST, NOT GLOBALLY. `glab auth status` exits non-zero
// when ANY configured host lacks a usable token, and inheriting that global code would make doctor
// red on a real, fully-authenticated target host because an unrelated token-less gitlab.com
// entry sat in the operator's glab config. A red doctor nobody can act on is a red doctor
// operators learn to ignore. So: when a registered project resolves from cwd, the host is
// DERIVED from the project's recorded remoteUrl and only that host is probed
// (`glab auth status --hostname <host>`) — a verdict about the one host every `legion finalize`
// and every branch-protection call will actually use. When NO project resolves, doctor does not
// know which host matters, so the per-host blocks are named with their
// own states and an unauthenticated host becomes a WARN that says why it could not be judged —
// never a FAIL, because failing on a host this repository may have nothing to do with is
// precisely the kind of false alarm this check exists to avoid.
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
// ONE THING HERE IS NOT A CHECK: the TICKET CONFIG INFO LINE (ticketInfoLine below). It
// reports the resolved ticket config and WHICH LEVEL each field came from, carries no verdict,
// never moves the exit code and is absent from `--json` — CHECK_IDS remains the machine-readable
// contract. Its docblock argues why information rather than a seventh check, and why even a
// corrupt org.json is printed here rather than failed on.
//
// SHAPE: doctorCore(argv, deps) returns { code, checks, ticketInfo, output } and writes NOTHING;
// run(argv) prints output and returns code. Tests assert the --json shape and the per-check levels
// off the returned value, with no stdout patching.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../kernel/args.mjs';
import { branchPatternMatches } from '../kernel/branches.mjs';
import { inspectPrePushHook } from '../kernel/githooks.mjs';
import { realRunner } from '../kernel/runner.mjs';
import { resolveProject } from './feature.mjs';
import { closingKeyword, resolveTicketConfig } from '../kernel/ticket.mjs';

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
 * layering and are read together, and this order puts the guarantee above the depth. */
export const CHECK_IDS = ['node', 'claude-version', 'plugin-manifest', 'glab-auth', 'branch-protection', 'remote-guards'];

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
  if (!/^\d+\.\d+\.\d+$/.test(String(manifest?.version ?? ''))) {
    problems.push(`version must be X.Y.Z (got ${JSON.stringify(manifest?.version ?? null)})`);
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

/** THE HOST a project's remote lives on, for `glab auth status --hostname`. Handles the three
 * forms a recorded `git remote get-url origin` actually takes: scheme URLs with an optional
 * port and userinfo (`ssh://git@host:2222/a/b.git`, `https://host/a/b.git`) and the scp-like
 * form (`git@host:a/b.git`). Anything without an unambiguous authority ⇒ null ⇒ the check falls
 * back to the unscoped probe and SAYS it could not scope: a guessed host would be a verdict
 * about a server nobody asked about. Deliberately NOT dot-requiring — a single-label internal
 * host (`https://gitlab/a/b.git`) is structurally unambiguous here. */
export function glabHost(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.trim() === '') return null;
  const url = remoteUrl.trim();
  let authority = null;
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/]+)(?:\/|$)/.exec(url);
  if (scheme) authority = scheme[1];
  // As in gitlabProjectPath: a `://` that the pattern above REFUSED (file:///path) must never
  // fall through to the scp form, which would read a local path's first segment as a host.
  else if (!url.includes('://')) {
    const scp = /^(?:[^@/]+@)?([^@/:]+):/.exec(url);
    if (scp) authority = scp[1];
  }
  if (authority == null) return null;
  const at = authority.lastIndexOf('@'); // userinfo (user:pass@host) — the LAST @ starts the host
  const host = (at === -1 ? authority : authority.slice(at + 1)).replace(/:\d+$/, '').toLowerCase();
  return /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host) ? host : null;
}

/** A block header in `glab auth status`: an UNINDENTED hostname line, its indented lines the
 * state of that host. Parsed CONSERVATIVELY and only for the unscoped rendering path — a
 * hostname here must carry a dot, so glab's own unindented prose ('Warning:', 'No hosts
 * configured') cannot be mistaken for a host. Missing a real host degrades to "could not read
 * the per-host state", i.e. a warn: this parser can lose a host, it can never invent one. */
const AUTH_HOST_LINE = /^([A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z0-9][A-Za-z0-9-]*)(?::\d+)?:?$/;

/** [{host, authenticated}] out of `glab auth status` output, in the order glab printed them.
 * authenticated = the block carries a ✓ line AND no error line: glab marks a working host with
 * ✓ and a broken one with `x`/`✗` (plus `-` hints), and a block with neither is UNKNOWN, which
 * is not authenticated. EXPORTED for the parser table test. */
export function parseGlabAuthHosts(text) {
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
    else if (/^[x✗×]\s/.test(t)) cur.bad = true;
  }
  return blocks.map(({ host, ok, bad }) => ({ host, authenticated: ok && !bad }));
}

const GLAB_MISSING = {
  level: 'fail',
  detail: 'glab not found on PATH — install it (https://gitlab.com/gitlab-org/cli) and run `glab auth login`; '
    + '`legion finalize` and the branch-protection check both need it',
};

/** The verdict that matters: authenticated for THE host this project pushes to. Every other
 * host in the operator's glab config is irrelevant to this repository and is not consulted. */
function checkGlabAuthScoped(run, host, projectId) {
  const r = run('glab', ['auth', 'status', '--hostname', host], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.spawnError === 'ENOENT') return GLAB_MISSING;
  if (r.spawnError) return { level: 'fail', detail: `\`glab auth status --hostname ${host}\` could not run: ${r.spawnError}` };
  if (!r.ok) {
    return {
      level: 'fail',
      detail: `glab is installed but not authenticated for ${host}, the host recorded for project ${projectId} `
        + `(exit ${r.code}) — run \`glab auth login --hostname ${host}\`: ${excerpt(r.stderr || r.stdout)}`,
    };
  }
  return {
    level: 'pass',
    detail: `glab authenticated for ${host} (the remote host recorded for project ${projectId}): `
      + `${excerpt(r.stderr || r.stdout, 120)}`,
  };
}

/** No project resolves (or its remote names no host), so no host is THE host. Report per-host
 * state and refuse to fail on a host that may be nothing to do with the work at hand. */
function checkGlabAuthUnscoped(run, why) {
  const r = run('glab', ['auth', 'status'], { timeoutMs: PROBE_TIMEOUT_MS });
  if (r.spawnError === 'ENOENT') return GLAB_MISSING;
  if (r.spawnError) return { level: 'fail', detail: `\`glab auth status\` could not run: ${r.spawnError}` };
  const hosts = parseGlabAuthHosts(`${r.stdout ?? ''}\n${r.stderr ?? ''}`);
  const good = hosts.filter((h) => h.authenticated).map((h) => h.host);
  const bad = hosts.filter((h) => !h.authenticated).map((h) => h.host);
  const scope = `${why}, so doctor cannot tell which host matters here`;
  const remedy = 'run doctor from a registered project checkout to have its host verified, or '
    + '`glab auth login --hostname <host>`';
  if (hosts.length === 0) {
    return {
      level: 'warn',
      detail: `\`glab auth status\` exited ${r.code} and no per-host state could be read out of it `
        + `(${excerpt(r.stderr || r.stdout, 120)}) — ${scope}; ${remedy}`,
    };
  }
  if (bad.length > 0) {
    return {
      level: 'warn',
      detail: `glab is authenticated for ${good.length ? good.join(', ') : 'no configured host'} and NOT for `
        + `${bad.join(', ')} — ${scope}, and an unauthenticated host this repository may never touch is not a `
        + `failure; ${remedy}`,
    };
  }
  // The parse says every host it READ is fine, yet glab itself exited non-zero: the two disagree,
  // and the parser is the lossy one (AUTH_HOST_LINE drops single-label hosts and any block header
  // upstream prints unindented but unlike a hostname — glabHost, one screen up, accepts exactly
  // the single-label hosts this parser refuses). A pass here would assert "every configured host"
  // with contradicting evidence in hand. The exit code is honoured in the GREEN direction ONLY:
  // it can withhold a pass, it can never become the fail this check exists to stop inheriting.
  if (!r.ok) {
    return {
      level: 'warn',
      detail: `\`glab auth status\` exited ${r.code} but every host doctor could read out of it is authenticated `
        + `(${good.join(', ')}) — a host it could not read may be the failing one, so this is not a pass; `
        + `${scope}; ${remedy}`,
    };
  }
  return {
    level: 'pass',
    detail: `glab authenticated for every configured host (${good.join(', ')}) — ${why}, so no single host was verified as the target`,
  };
}

/** Host-aware (header). Resolution mirrors checkBranchProtection's, including fromAnyWorktree:
 * doctor runs inside feature worktrees, and a check that silently unscopes itself there would
 * be host-blind exactly where every push happens. */
function checkGlabAuth(run, flags) {
  let projectId = null;
  let host = null;
  let why = null;
  try {
    const { entry, cfg } = resolveProject(flags, { fromAnyWorktree: true });
    projectId = `${entry.org}/${entry.name}`;
    host = glabHost(cfg?.remoteUrl);
    if (host == null) {
      why = `project ${projectId} records no host-bearing remote (${JSON.stringify(cfg?.remoteUrl ?? null)})`;
    }
  } catch (e) {
    // excerpt: git's own refusals are multi-line, and a detail is one table row.
    why = `no registered project resolves from this cwd (${excerpt(e.message, 160)})`;
  }
  return host == null ? checkGlabAuthUnscoped(run, why) : checkGlabAuthScoped(run, host, projectId);
}

// --- branch protection -------------------------------------------------------------------------

const BEST_EFFORT =
  'only the server is authoritative, so while this is unverified the guarantee is best-effort';

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

/** One `glab api` call, parsed. Returns {value} or {error} — never throws, because EVERY
 * failure mode here (no network, 403, glab version drift, HTML error page) means the same
 * thing to the caller: unverifiable. */
function glabJson(run, args, cwd) {
  const r = run('glab', args, { cwd, timeoutMs: PROBE_TIMEOUT_MS });
  if (r.spawnError) return { error: `\`glab ${args.join(' ')}\` could not run: ${r.spawnError}` };
  if (!r.ok) return { error: `\`glab ${args.join(' ')}\` exited ${r.code}: ${excerpt(r.stderr || r.stdout)}` };
  try {
    return { value: JSON.parse(r.stdout) };
  } catch (e) {
    return { error: `\`glab ${args.join(' ')}\` did not return JSON (${e.message}): ${excerpt(r.stdout, 120)}` };
  }
}

/** THE server-side check (layer 1). Three-valued on purpose:
 *   fail — VERIFIED bad: a recorded branch is unprotected, or the agent identity CAN push/merge it;
 *   pass — VERIFIED good: every recorded branch is protected and the identity is excluded;
 *   warn — UNVERIFIABLE: no glab, no network, an API error, an unresolvable project, a rule
 *          granted to a GROUP whose membership we cannot evaluate, or an empty recorded set.
 * Ambiguity NEVER becomes a pass: a green that really means "could not tell" is the single
 * outcome this check refuses to produce. */
function checkBranchProtection(run, flags, glabOk) {
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
  if (!glabOk) {
    // "not VERIFIED authenticated", not "unauthenticated": since the glab-auth check became
    // host-aware it also warns when it could not decide WHICH host to judge, and that is not
    // the same fact as a missing token. Either way the server is not reachable with proof.
    return { level: 'warn', detail: `glab is not verified authenticated (see the glab-auth check), so server-side protection is UNVERIFIED (${recorded}); ${BEST_EFFORT}` };
  }
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
      + `code repository's own GitLab project, closing line \`${closingKeyword('closes')} #<iid>\``;
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
    ? "the code repository's own GitLab project"
    : cfg.ticketProject.value;
  return `${prefix}  issues in ${project_} [${cfg.ticketProject.from}]; closing line `
    + `\`${closingKeyword(cfg.ticketClosingStyle.value)} #<iid>\` [${cfg.ticketClosingStyle.from}] `
    + '— resolved fresh at every use, pinned nowhere';
}

// --- core --------------------------------------------------------------------------------------

/** Human table: level, check id, detail — plus a count line, plus a verdict line when red, plus the
 * ONE ticket info line (ticketInfoLine: information, not a check — it sits after the verdict so a
 * red doctor's remedy is never pushed off the last line a reader looks at). */
function renderTable(checks, ticketInfo) {
  const w = Math.max(...checks.map((c) => c.check.length));
  const count = (level) => checks.filter((c) => c.level === level).length;
  const lines = checks.map((c) => `${c.level.toUpperCase().padEnd(4)}  ${c.check.padEnd(w)}  ${c.detail}`);
  lines.push('', `doctor: ${count('pass')} pass, ${count('warn')} warn, ${count('fail')} fail`);
  if (count('fail') > 0) lines.push('FAIL — fix the failing checks before starting a feature');
  if (ticketInfo != null) lines.push('', ticketInfo);
  return `${lines.join('\n')}\n`;
}

/**
 * The testable core. Writes NOTHING and returns everything.
 * @param {string[]} argv unsplit argv (kernel/args.mjs invariant)
 * @param {{run: Function, minClaudeVersion?: string|null, nodeVersion?: string, pluginRoot?: string}} deps
 * @returns {Promise<{code: number, checks: Array<{check: string, level: string, detail: string}>, output: string}>}
 */
export async function doctorCore(argv, deps = {}) {
  const {
    run,
    minClaudeVersion = MIN_CLAUDE_VERSION,
    nodeVersion = process.version,
    pluginRoot = DEFAULT_PLUGIN_ROOT,
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
  const glab = add('glab-auth', () => checkGlabAuth(run, flags));
  // glab absent/unauthed makes the server unreachable: branch protection is then UNVERIFIABLE
  // (warn), not unprotected (fail). The overall exit is already 1 from glab-auth itself.
  add('branch-protection', () => checkBranchProtection(run, flags, glab.level === 'pass'), 'warn');
  // 'warn' on throw for the same reason the check never fails: a depth layer whose state could
  // not be read is an unknown, and an unknown here must not turn doctor red.
  add('remote-guards', () => checkRemoteGuards(flags), 'warn');

  const code = checks.some((c) => c.level === 'fail') ? 1 : 0;
  // Fault-isolated like every check: a surprise in config resolution must not cost the operator
  // the five conformance verdicts they actually ran doctor for.
  let ticketInfo;
  try { ticketInfo = ticketInfoLine(flags); }
  catch (e) { ticketInfo = `info  ticket config  could not be reported: ${excerpt(e?.message ?? e, 200)}`; }
  // --json IS THE CHECK ARRAY and stays exactly that: consumers key on CHECK_IDS and on the array
  // shape, and the ticket line is not a check (ticketInfoLine's docblock). It rides the human
  // render, and the returned object carries it for anything that wants it structurally.
  const output = flags.json ? `${JSON.stringify(checks, null, 2)}\n` : renderTable(checks, ticketInfo);
  return { code, checks, ticketInfo, output };
}

export async function run(argv) {
  const r = await doctorCore(argv, { run: realRunner().run });
  process.stdout.write(r.output);
  return r.code;
}
