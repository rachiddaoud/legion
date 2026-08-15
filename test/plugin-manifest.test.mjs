// Guards the T1 skeleton invariants (PLAN-V3 digest + Claude Code plugin spec):
// manifest well-formed in .claude-plugin/ which holds ONLY the manifest; components
// (skills/agents/hooks/bin) live at plugin ROOT; package.json = plain ESM, Node >= 22,
// zero runtime dependencies, bin.legion resolves to a real executable file.
// Hermetic: node builtins only, paths derived from import.meta.url — never cwd.
//
// T10 extends this with the plugin SURFACE: skill, agents, hooks manifest, build workflow.
//
// WHAT THESE TESTS CANNOT CHECK — say it plainly rather than implying coverage:
//   - THAT THE HOOKS ACTUALLY FIRE. Nothing here starts a Claude Code session. The manifest
//     shape and matchers were read out of the installed 2.1.219 build, but the only proof is
//     a live run: `claude --debug` in a feature worktree should log
//     `Matched 1 unique hooks for query "resume"` on start and
//     `Matched 1 unique hooks for query "legion:builder"` when a builder subagent stops.
//     Verify once per Claude Code upgrade; a hook that silently never fires is the worst
//     outcome in this task and no unit test can see it.
//   - THAT A PLUGIN AGENT'S RUNTIME agent_type IS LITERALLY `legion:builder`. Derived from
//     the loader's `[pluginName, ...subdirs, name].join(':')`, but only a live session proves
//     it. The SubagentStop matcher is written to match with or without the namespace, and
//     hooks/builder-receipt.mjs re-checks agent_type itself, so both spellings are covered.
//   - THAT THE `Workflow` TOOL EXISTS in the operator's build (org policy and the "Dynamic
//     workflows" setting can disable it). `--build=sequential` is the documented fallback.
//   - THAT THE MODEL FOLLOWS the skill's judgement and approval flow. Prose is not testable;
//     what IS testable is that every command the prose names actually exists, which is test 8.
//   - THAT THE ntfy TOPIC IS REACHABLE. Tests never touch the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, statSync, accessSync, constants, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { STATE_OPS, ARTIFACT_KINDS } from '../src/kernel/state.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// --- zero-dependency frontmatter parser -----------------------------------------------------
// Deliberately strict and loud: it accepts only what the Claude Code loader accepts of our own
// files — a leading `---\n`, a closing `\n---\n`, and `key: value` lines where a value may be a
// `[a, b]` array. A lenient parser here would let a malformed skill/agent file pass this suite
// and then fail to load at runtime, which is the exact silent-dead-end this test exists to stop.
function parseFrontmatter(text, what) {
  if (!text.startsWith('---\n')) throw new Error(`${what}: missing opening --- frontmatter fence`);
  const end = text.indexOf('\n---\n', 3);
  if (end < 0) throw new Error(`${what}: missing closing --- frontmatter fence`);
  const out = {};
  for (const line of text.slice(4, end).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i < 0) throw new Error(`${what}: malformed frontmatter line ${JSON.stringify(line)}`);
    const key = line.slice(0, i).trim();
    const raw = line.slice(i + 1).trim();
    out[key] = raw.startsWith('[') && raw.endsWith(']')
      ? raw.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean)
      : raw;
  }
  return { frontmatter: out, body: text.slice(end + 5) };
}

const AGENT_NAMES = [
  'architect', 'builder', 'code-reviewer', 'codex-consult', 'kernel-op', 'plan-critic', 'product-reviewer',
  'visual-reviewer',
];
const read = (...p) => readFileSync(join(ROOT, ...p), 'utf8');

test('plugin.json parses and matches the manifest schema shape', () => {
  const raw = readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.name, 'legion');
  // No version field, DELIBERATELY: the repo is its own marketplace and the plugin is versioned
  // by git commit. Updates compare version strings, so a static version reads as "unchanged" on
  // every pull and installs keep the cached copy — auto-update silently stops.
  assert.equal(manifest.version, undefined, 'a static version pins installs and defeats auto-update');
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0, 'description must be non-empty');
  assert.equal(typeof manifest.author?.name, 'string');
  assert.ok(manifest.author.name.length > 0, 'author.name must be non-empty');
});

test('.claude-plugin/ contains only the two manifests — components never nest inside it', () => {
  // Assert against git's index, not the working directory — Finder's .DS_Store (and any
  // other untracked junk) must not flake the invariant, while an accidentally COMMITTED
  // extra file is exactly what this should catch. Requires git + a work tree (true for
  // this repo and CI; an exported tarball would fail here, acceptably.)
  // marketplace.json joined plugin.json on 2026-07-30 (PLAN-V3 §Installation R19's missing
  // half: the repo is its own private marketplace, so `claude plugin marketplace add
  // <checkout>` works). Exactly these two; anything else here is still a defect.
  const tracked = execFileSync('git', ['ls-files', '.claude-plugin'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean);
  assert.deepEqual(tracked, ['.claude-plugin/marketplace.json', '.claude-plugin/plugin.json']);
});

test('marketplace.json parses and offers exactly this repo as the legion plugin', () => {
  const m = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.equal(m.name, 'legion');
  assert.equal(typeof m.owner?.name, 'string');
  assert.ok(m.owner.name.length > 0, 'owner.name must be non-empty');
  assert.equal(m.plugins.length, 1, 'this marketplace offers exactly the one plugin');
  assert.equal(m.plugins[0].name, 'legion');
  assert.equal(m.plugins[0].source, './', 'the plugin source is this repo itself');
  assert.ok(m.plugins[0].description.length > 0, 'description must be non-empty');
  // A marketplace-entry version pins installs exactly like a plugin.json one would — it sits
  // ABOVE the git commit SHA in Claude Code's version resolution, so its presence would defeat
  // auto-update the same way. Guarded here because the doctor's manifest check reads plugin.json.
  assert.equal(m.plugins[0].version, undefined, 'a marketplace-entry version pins installs and defeats auto-update');
});

test('component dirs exist at plugin root', () => {
  for (const dir of ['skills', 'agents', 'hooks', 'bin']) {
    assert.ok(statSync(join(ROOT, dir)).isDirectory(), `${dir}/ must be a directory at plugin root`);
  }
});

test('package.json enforces the house invariants', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'legion');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.engines?.node, '>=22');
  assert.equal(pkg.scripts?.test, 'node --test');
  assert.ok(!('dependencies' in pkg), 'zero runtime dependencies is an invariant');
  // T15a (R19): bin.legion points at the POSIX shim `bin/legion`, which npm link symlinks
  // onto PATH; the shim resolves itself and execs the node router beside it.
  const binPath = join(ROOT, pkg.bin.legion);
  assert.ok(statSync(binPath).isFile(), 'bin.legion must point at an existing file');
  accessSync(binPath, constants.X_OK); // throws if not executable
  const src = readFileSync(binPath, 'utf8');
  assert.ok(src.startsWith('#!/bin/sh\n'), 'the PATH shim must carry the POSIX sh shebang');
  // The router the shim execs must still exist beside it, executable, under the node shebang.
  const routerPath = join(ROOT, 'bin', 'legion.mjs');
  assert.ok(statSync(routerPath).isFile(), 'bin/legion.mjs router must exist');
  accessSync(routerPath, constants.X_OK);
  assert.ok(readFileSync(routerPath, 'utf8').startsWith('#!/usr/bin/env node\n'),
    'the router must carry the node shebang');
});

// --- T10: the plugin surface ----------------------------------------------------------------

test('the /legion:feature skill exists and is well-formed', () => {
  const src = read('skills', 'feature', 'SKILL.md');
  const { frontmatter: fm, body } = parseFrontmatter(src, 'skills/feature/SKILL.md');
  // The invocation name is the frontmatter name, not the directory: /legion:feature.
  assert.equal(fm.name, 'feature');
  assert.ok(typeof fm.description === 'string' && fm.description.length > 40, 'description must be substantive');
  assert.ok(Array.isArray(fm['allowed-tools']), 'allowed-tools must be a list');
  // Without these two the skill cannot do its job at all: Agent dispatches every role, and
  // Workflow runs the shipped build stage (PLAN-V3 decision 11).
  for (const tool of ['Agent', 'Workflow', 'Bash', 'Read']) {
    assert.ok(fm['allowed-tools'].includes(tool), `allowed-tools must include ${tool}`);
  }
  assert.ok(body.length > 2000, 'the skill body carries the whole lifecycle — it cannot be a stub');
  // PLAN-V3 §Startup, the skill's rule 0. Stated, in those words, or the rule has rotted out.
  assert.match(body, /never creates infrastructure/i);
  assert.match(body, /--build=sequential/, 'the in-session fallback must stay documented');
});

test('every role subagent exists, parses, and declares its tools', () => {
  const files = readdirSync(join(ROOT, 'agents')).filter((f) => f.endsWith('.md')).sort();
  assert.deepEqual(files, AGENT_NAMES.map((n) => `${n}.md`));
  for (const name of AGENT_NAMES) {
    const what = `agents/${name}.md`;
    const { frontmatter: fm, body } = parseFrontmatter(read('agents', `${name}.md`), what);
    // The loader derives the runtime agent type from the frontmatter name (falling back to the
    // basename). A drift between the two would silently rename `legion:builder` and unhook the
    // SubagentStop matcher, so they must agree.
    assert.equal(fm.name, name, `${what}: frontmatter name must equal the filename stem`);
    assert.ok(typeof fm.description === 'string' && fm.description.length > 30, `${what}: description`);
    assert.ok(typeof fm.tools === 'string' && fm.tools.trim().length > 0, `${what}: tools must be declared`);
    assert.ok(body.length > 400, `${what}: body must carry the role, not a stub`);
    assert.match(body, /## Return contract|Return contract/i, `${what}: must state its return contract`);
  }
  // kernel-op's whole safety argument is that it can do nothing but run a shell command from a
  // closed set. Any other tool would widen it into a general-purpose escape hatch.
  const kernelOp = parseFrontmatter(read('agents', 'kernel-op.md'), 'kernel-op').frontmatter;
  assert.equal(kernelOp.tools, 'Bash', 'kernel-op must have Bash and nothing else');
  // The reviewers and the critic are read-only by contract; a write tool would break it.
  for (const ro of ['plan-critic', 'code-reviewer', 'product-reviewer', 'codex-consult', 'visual-reviewer']) {
    const tools = parseFrontmatter(read('agents', `${ro}.md`), ro).frontmatter.tools;
    for (const banned of ['Edit', 'Write', 'NotebookEdit']) {
      assert.ok(!tools.split(',').map((s) => s.trim()).includes(banned), `${ro} must stay read-only (${banned})`);
    }
  }
});

test('hooks/hooks.json matches the 2.1.219 plugin hook shape — exactly three events, no Stop', () => {
  const manifest = JSON.parse(read('hooks', 'hooks.json'));
  assert.deepEqual(Object.keys(manifest).sort(), ['description', 'hooks'],
    'plugin hooks.json is the wrapper form {description?, hooks:{…}}');
  const events = Object.keys(manifest.hooks).sort();
  // The set is asserted EXACTLY, so a new event cannot arrive without someone reading this line.
  assert.deepEqual(events, ['Notification', 'SessionStart', 'SubagentStop']);
  // PLAN-V3 §Gates forbids a global Stop hook — it would interfere with the approval and
  // orchestration stages. Assert the absence explicitly so it cannot be added casually.
  assert.ok(!('Stop' in manifest.hooks), 'no global Stop hook (PLAN-V3 §Gates)');
  // T26's PreToolUse Bash guard was REMOVED 2026-08-07 together with the pre-push git hook
  // (server-only decision — src/kernel/githooks.mjs header). Asserted absent so the local deny
  // layer cannot come back casually either.
  assert.ok(!('PreToolUse' in manifest.hooks), 'the Bash remote-write guard was removed — server-only');
  for (const [event, entries] of Object.entries(manifest.hooks)) {
    assert.ok(Array.isArray(entries) && entries.length === 1, `${event}: one matcher entry`);
    for (const entry of entries) {
      assert.deepEqual(Object.keys(entry).sort(), ['hooks', 'matcher'], `${event}: {matcher, hooks}`);
      assert.ok(typeof entry.matcher === 'string' && entry.matcher.length > 0, `${event}: matcher`);
      assert.ok(Array.isArray(entry.hooks) && entry.hooks.length === 1, `${event}: one hook`);
      for (const h of entry.hooks) {
        assert.equal(h.type, 'command', `${event}: command hook`);
        assert.equal(h.command, 'node', `${event}: exec-form command`);
        // args PRESENT is what selects the exec form. Its absence would route the command
        // through a shell, where ${CLAUDE_PLUGIN_ROOT} expansion meets a parser.
        assert.ok(Array.isArray(h.args) && h.args.length === 1, `${event}: exec-form args`);
        const extra = Object.keys(h).filter((k) => !['type', 'command', 'args', 'timeout', 'statusMessage'].includes(k));
        assert.deepEqual(extra, [], `${event}: unexpected hook keys ${extra.join(',')}`);
      }
    }
  }
  // The matchers are compared against source / agent_type / notification_type respectively.
  assert.equal(manifest.hooks.SessionStart[0].matcher, 'startup|resume|clear|compact');
  assert.match(manifest.hooks.SubagentStop[0].matcher, /builder/);
  assert.ok(new RegExp(manifest.hooks.SubagentStop[0].matcher).test('legion:builder'),
    'the SubagentStop matcher must match the namespaced plugin agent type');
  assert.ok(new RegExp(manifest.hooks.SubagentStop[0].matcher).test('builder'),
    'and the bare type, in case the runtime does not namespace it');
  assert.ok(!new RegExp(manifest.hooks.SubagentStop[0].matcher).test('legion:code-reviewer'),
    'it must NOT catch other legion agents');
});

test('every hook command resolves to a real executable and every hook script parses', () => {
  // `command: "node"` is PATH-resolved by the harness. That is the same assumption bin/legion.mjs
  // already makes with its `#!/usr/bin/env node` shebang, so it is not a new dependency — but a
  // hook whose interpreter is missing never fires, so prove it here.
  assert.equal(spawnSync(process.execPath, ['-v']).status, 0, 'process.execPath must run');
  assert.equal(spawnSync('node', ['-v'], { shell: false }).status, 0, '`node` must resolve on PATH');

  const manifest = JSON.parse(read('hooks', 'hooks.json'));
  const scripts = [];
  for (const entries of Object.values(manifest.hooks)) {
    for (const entry of entries) {
      for (const h of entry.hooks) {
        for (const a of h.args) {
          // ${CLAUDE_PLUGIN_ROOT} is substituted per-element as a plain string; the plugin root
          // is this repo.
          assert.ok(a.startsWith('${CLAUDE_PLUGIN_ROOT}/'), `hook arg must be plugin-root-relative: ${a}`);
          const abs = join(ROOT, a.replace('${CLAUDE_PLUGIN_ROOT}/', ''));
          assert.ok(statSync(abs).isFile(), `hook script must exist: ${abs}`);
          scripts.push(abs);
        }
      }
    }
  }
  assert.equal(scripts.length, 3); // SessionStart, SubagentStop, Notification
  for (const abs of [...scripts, join(ROOT, 'hooks', '_common.mjs')]) {
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
    assert.equal(r.status, 0, `node --check ${abs}: ${r.stderr}`);
  }
});

test('workflows/build-loop.js parses under the workflow runtime contract and declares meta first', () => {
  const src = read('workflows', 'build-loop.js');
  // The runtime parses workflow scripts as sourceType:module WITH allowAwaitOutsideFunction and
  // allowReturnOutsideFunction, and requires `export const meta` to be the FIRST statement and a
  // pure literal. `node --check` on a .mjs allows top-level await but NOT top-level return, so
  // the body is wrapped in an async function — which permits exactly those two constructs —
  // after demoting the one `export` that only means anything at module scope. Both are
  // mechanical single-token transforms; nothing else about the source is altered.
  assert.ok(src.trimStart().startsWith('export const meta = {'), 'meta must be the first statement');
  const tmp = mkdtempSync(join(tmpdir(), 'legion-wf-'));
  const wrapped = join(tmp, 'build-loop.mjs');
  writeFileSync(wrapped,
    `async function __wf(args, agent, parallel, pipeline, phase, log, budget) {\n` +
    `${src.replace(/^export const meta/, 'const meta')}\n}\n`);
  const r = spawnSync(process.execPath, ['--check', wrapped], { encoding: 'utf8' });
  assert.equal(r.status, 0, `workflow does not parse: ${r.stderr}`);

  const metaSrc = src.slice(0, src.indexOf('\n}\n') + 2);
  assert.match(metaSrc, /description:/);
  assert.match(metaSrc, /phases:\s*\[/);
  assert.ok((metaSrc.match(/title:/g) ?? []).length >= 3, 'meta.phases must name its phases');

  // A plugin workflow is REGISTERED AS `<pluginName>:<meta.name>` and invoked by that name.
  // Rename either half alone and the skill's build stage silently resolves nothing, which is
  // exactly the dead end this suite exists to prevent — so bind them here.
  const metaName = metaSrc.match(/name:\s*'([^']+)'/)?.[1];
  assert.ok(metaName, 'meta.name must be a plain string literal');
  const registered = `${JSON.parse(read('.claude-plugin', 'plugin.json')).name}:${metaName}`;
  assert.equal(registered, 'legion:build-loop');
  assert.ok(read('skills', 'feature', 'SKILL.md').includes(`name: "${registered}"`),
    `the skill must invoke the workflow as name: "${registered}"`);
});

test('plugin.json declares no component paths — declaring one DISABLES the default folder', () => {
  // Validated against Claude Code 2.1.219: hooks/, agents/, skills/ and workflows/ are
  // auto-discovered at plugin root, and a `hooks`/`agents`/`skills`/`workflows` field in
  // plugin.json REPLACES that discovery rather than adding to it. Adding one "for clarity"
  // would silently unload every component that is not also listed.
  const manifest = JSON.parse(read('.claude-plugin', 'plugin.json'));
  for (const key of ['hooks', 'agents', 'skills', 'workflows', 'commands']) {
    assert.ok(!(key in manifest), `plugin.json must not declare a '${key}' path`);
  }
});

test('the build loop contains NO per-task planning agent — the rule must not rot', () => {
  const src = read('workflows', 'build-loop.js');
  // PLAN-V3 decision 11 + this file's header: an LLM planning step inside the gated build loop
  // can author task content that no approval covers, while the plan approval still reads valid.
  // That is the drift the kernel exists to prevent, so the prohibition is asserted, not trusted.
  assert.match(src, /NO PER-TASK LLM RE-PLANNING/,
    'the header sentinel is what a future editor reads before adding a planner');
  assert.doesNotMatch(src, /agentType\s*:\s*['"][^'"]*(plan|architect|design|spec)/i,
    'no planning/architect/spec agent may be dispatched from inside the build loop');
  assert.doesNotMatch(src, /phase\s*:\s*['"][^'"]*plan/i, 'no phase may be a planning phase');
  const dispatched = new Set([...src.matchAll(/agentType\s*:\s*'([^']+)'/g)].map((m) => m[1]));
  assert.ok(dispatched.size > 0, 'the loop must dispatch something (a regex matching nothing cannot pass)');
  // T28 widened this by exactly one: the milestone close runs the PRODUCT review per milestone
  // (PLAN-V3 decision 11's 2026-07-29 amendment / S-008), so `legion:product-reviewer` is now
  // dispatched from inside the loop. Everything the set excludes it still excludes — above all a
  // planner. Widen it only when the loop genuinely gains a role, never to quiet a failure.
  // Widened by exactly one again (after T28's product-reviewer): the milestone close dispatches
  // `legion:visual-reviewer` for a milestone whose tasks carry `notes.visual` in the approved
  // plan. Still no planner. Widen it only when the loop genuinely gains a role, never to quiet a
  // failure.
  const allowed = new Set([
    'legion:builder', 'legion:code-reviewer', 'legion:codex-consult', 'legion:product-reviewer', 'legion:kernel-op',
    'legion:visual-reviewer',
  ]);
  for (const a of dispatched) assert.ok(allowed.has(a), `unexpected agent in the build loop: ${a}`);
  // Every agent the loop dispatches must actually exist as a shipped component.
  for (const a of dispatched) {
    assert.ok(AGENT_NAMES.includes(a.replace(/^legion:/, '')), `dispatched agent has no file: ${a}`);
  }
});

test('the design-concern channels stay DATA — schema-borne, aggregated, never dispatched', () => {
  // The decision grammar's build-side half rides two data channels through this loop. The pins
  // hold what a later edit would silently break: the sentinel a future editor reads before
  // gating control flow on the signal, and the two schema fields — schema presence is the ONLY
  // thing that lets a field survive the runtime's drop-unlisted-fields behaviour, so deleting
  // either drops the channel while every prompt still promises it. The no-planner test above
  // already proves neither channel grew a dispatch.
  const src = read('workflows', 'build-loop.js');
  const code = codeOnly(src);
  assert.match(src, /DESIGN CONCERNS BOUNCE UP AS DATA/, 'the header sentinel');
  assert.match(code, /enum:\s*\['question',\s*'design'\]/,
    "BUILDER_SCHEMA carries kind — without it a design concern arrives as an ordinary question");
  assert.match(code, /category:\s*\{\s*type:\s*'string'/,
    'REVIEW_SCHEMA carries category — without it no recurrence is ever countable');
  assert.match(code, /designSignals/, 'the aggregation must reach the return value');
});

test('build-loop dispatch: ids are validated to the KERNEL segment shape and quoted at the shell seam — no raw interpolation (T14/R4)', () => {
  const src = read('workflows', 'build-loop.js');
  const code = codeOnly(src);
  // (1) THE SHAPE IS THE KERNEL'S. The workflow sandbox has no imports, so build-loop carries a
  // mirror of paths.mjs SEGMENT_RE — bound here byte-for-byte so the two sources cannot drift.
  const kernelRe = read('src', 'kernel', 'paths.mjs').match(/const SEGMENT_RE = (\/[^;]+\/);/)?.[1];
  const loopRe = src.match(/const ID_RE = (\/[^;\n]+\/)/)?.[1];
  assert.ok(kernelRe, 'paths.mjs must declare SEGMENT_RE where this test can read it');
  assert.ok(loopRe, 'build-loop must declare ID_RE (the validation half of the R4 fix)');
  assert.equal(loopRe, kernelRe, 'build-loop ID_RE must equal the kernel SEGMENT_RE byte for byte');
  // (2) VALIDATED BEFORE COMPOSING, in code — and the refusal must be reachable (a filter that
  // feeds a throw), not a comment about one.
  assert.match(code, /ID_RE\.test/, 'every task id must be tested against ID_RE');
  assert.ok(code.indexOf('ID_RE.test') < code.indexOf('function brief'),
    'validation must precede every composition site (briefs included)');
  // (3) QUOTED AT THE SEAM: inside every kernel(`…`) dispatch template, every interpolation must
  // go through sq(). A raw `${task.id}` here is exactly the regression this test exists to stop —
  // the id lands in a Bash-capable agent's command string as syntax.
  const templates = [...code.matchAll(/\bkernel\(\s*`([^`]+)`/g)].map((m) => m[1]);
  assert.ok(templates.length >= 4, `the loop must dispatch through kernel(), found ${templates.length}`);
  for (const t of templates) {
    for (const hole of t.matchAll(/\$\{([^}]*)\}/g)) {
      assert.match(hole[1].trim(), /^sq\(/, `unquoted interpolation \${${hole[1]}} in kernel dispatch: ${t}`);
    }
  }
  // …and the one shell string kernel() itself composes quotes the worktree path the same way.
  assert.match(code, /cd \$\{sq\(worktree\)\} && legion/, 'the cd path in the dispatch must be sq()-quoted');
});

test('done tasks skip — the re-runnability filter lives in the workflow, not in prose', () => {
  const src = read('workflows', 'build-loop.js');
  // "Skip what is already done" must never be a model's judgement: it is what makes a re-run in
  // any session safe (PLAN-V3 decision 11).
  assert.match(src, /\.filter\(\s*t\s*=>\s*t\.status\s*!==\s*'done'\s*\)/);
});

/** Every kernel command the build loop dispatches, as a `<family> <sub>` pair. The loop has no
 * shell: each one is a template literal handed to kernel(), which prefixes `legion `. */
function loopCommands(src) {
  const found = new Set();
  for (const m of src.matchAll(/\bkernel\(\s*`([^`]+)`/g)) {
    found.add(m[1].split(/\s+/).filter(Boolean).slice(0, 2).join(' '));
  }
  return found;
}

test("kernel-op's closed set covers every command the build loop dispatches", () => {
  // The two files are two halves of one contract and they drift silently: a loop dispatching a
  // command the agent is instructed to REFUSE gets `{"exitCode": 1, "refused: …"}` back and
  // fails a task for no reason — a working system that stops working after an edit to one file.
  const dispatched = loopCommands(read('workflows', 'build-loop.js'));
  assert.ok(dispatched.size >= 4, `the loop must dispatch kernel commands, found ${[...dispatched]}`);
  const closedSet = [...read('agents', 'kernel-op.md').matchAll(FENCE)]
    .flatMap((m) => m[1].split('\n'))
    .map((l) => l.trim())
    .filter((l) => l.startsWith('legion '))
    .map((l) => l.split(/\s+/).slice(1, 3).join(' '));
  for (const cmd of dispatched) {
    assert.ok(closedSet.includes(cmd), `build-loop dispatches \`legion ${cmd}\`, absent from kernel-op's closed set`);
  }
  // The inverse: the gate's WRITE path is never handed to the agent that has the shell.
  assert.ok(!closedSet.includes('gate run'), 'kernel-op must never be allowed to record a receipt');
});

/** The source with every comment stripped. The assertions below are about CODE: matching a
 * header paragraph that promises the behaviour is how a test goes green against a file that
 * stopped doing it — three of these did exactly that on their first pass. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ');
}

test('the build loop VERIFIES the gate receipt with the kernel; a builder self-report is not evidence', () => {
  const src = codeOnly(read('workflows', 'build-loop.js'));
  // Without this, two review lenses spend a full round on a tree the gate never certified and
  // the only thing between an ungated tree and a done task is the very last op.
  assert.match(src, /gate verify-receipt --task \$\{/, 'the loop must ask the kernel, not the builder');
  // Verification must precede the lenses — verifying afterwards still spends the round. Anchored
  // to the CALL SITE: the command string also appears in the header, far above everything.
  const firstCall = src.indexOf('receiptOk(task.id');
  const firstLens = src.indexOf("agentType: 'legion:code-reviewer'");
  assert.ok(firstCall > 0 && firstLens > 0, 'both anchors must exist');
  assert.ok(firstCall < firstLens, 'the receipt is verified before the first review lens is dispatched');
  // `build.receipt` is the builder's CLAIM. It may be reported, never believed — so it may
  // appear in a log line or a failure payload, but never in a condition.
  assert.doesNotMatch(src, /(if|while)\s*\([^)]*\bbuild\.receipt\b[^)]*\)\s*\{/,
    'the builder self-report must not gate control flow');
});

test('every review verdict is recorded in state — an unrecorded review did not happen', () => {
  const src = codeOnly(read('workflows', 'build-loop.js'));
  // finalize counts tasks.reviews and the pre-merge subject HASHES that array, so a verdict the
  // loop kept only in memory is a hole in the evidence chain a resumed session cannot see.
  assert.match(src, /state review-record --role \$\{[^}]+\} --verdict \$\{[^}]+\} --subject task:\$\{/);
  // Every lens, not just the primary: `recorded` must ACCUMULATE, or the durable-evidence rule
  // is enforced for one lens and quietly waived for the codex lens and the re-review.
  const records = [...src.matchAll(/recordVerdict\(/g)].length;
  assert.ok(records >= 3, `all three verdict sites must record, found ${records}`);
  const overwrites = [...src.matchAll(/\brecorded = await recordVerdict\(/g)].length;
  assert.equal(overwrites, 1, 'only the FIRST verdict may assign the flag; later ones must fold into it');
  assert.match(src, /recorded = recorded && /, 'the flag accumulates across every recorded verdict');
  // Fail closed: a pass whose verdict the kernel never accepted must not reach task-done. The
  // existence guard is the point — a bare indexOf comparison stays green when the whole gate is
  // DELETED (-1 < anything), which is the same vacuity this file was already caught on once.
  const iGate = src.indexOf('if (!recorded)');
  assert.ok(iGate > 0, 'the unrecorded-verdict gate must exist, not merely be described');
  assert.ok(iGate < src.indexOf('state task-done'), 'and it must precede task-done');
});

test('the brief reads the CANONICAL task shape — invented fields make silently empty briefs', () => {
  const src = read('workflows', 'build-loop.js');
  // `plan check --import` seeds a strict whitelist (src/cli/plan.mjs): the architect's mirror,
  // gotcha and acceptance rows arrive inside `notes`. Reading them as top-level fields drops
  // exactly the per-task context the brief exists to carry, and drops it without a sound.
  assert.match(src, /task\.notes/, 'the brief must read the canonical notes field');
  for (const phantom of ['task.note', 'task.mirror', 'task.gotcha', 'task.acceptance']) {
    assert.ok(!new RegExp(`${phantom.replace('.', '\\.')}\\b(?!s)`).test(src),
      `${phantom} is not a field on a canonical task row — it is seeded under task.notes`);
  }
});

// --- kernel-command references are real -----------------------------------------------------
// A skill or agent telling a model to run a command the router does not dispatch is a silent
// dead end: the model runs it, gets exit 1 and a usage dump, and improvises. So every `legion …`
// invocation in every shipped component is checked against the ROUTER'S OWN command list and the
// kernel's OWN op tables — not against a list copied into this test.

const FENCE = /```[^\n]*\n([\s\S]*?)```/g;

/** Every legion invocation a model could copy out of a component file: inline `backticked`
 * spans plus command lines inside fenced code blocks (with a leading `cd … &&` stripped). */
function invocations(src) {
  const found = [];
  for (const m of src.matchAll(FENCE)) {
    for (const line of m[1].split('\n')) {
      const cmd = line.trim().replace(/^cd\s+\S+\s*&&\s*/, '');
      if (cmd.startsWith('legion ')) found.push(cmd.slice(7).trim());
    }
  }
  for (const m of src.matchAll(/`legion ([^`]+)`/g)) found.push(m[1].trim());
  return found;
}

function componentFiles() {
  return [
    ['skills', 'feature', 'SKILL.md'],
    // T30 (S-007): /legion:start. Listed here BEFORE its own shape test below, because this is the
    // list that makes the command-conformance and artifact-kind scans cover it — a shipped skill
    // absent from this array is prose no test reads, and its whole job is naming real commands.
    ['skills', 'start', 'SKILL.md'],
    // /legion:viewer. Absent from this array until 2026-08-15, and it drifted exactly as the
    // comment above predicts: it carried its own copy of the bundle-build commands, pinned to
    // `npm install`, which nothing executed and nothing checked. The build is a kernel command now
    // (src/cli/viewer-build.mjs) and the skill is a trigger; listing it here is what keeps it one.
    ['skills', 'viewer', 'SKILL.md'],
    ...AGENT_NAMES.map((n) => ['agents', `${n}.md`]),
    ['hooks', 'hooks.json'],
    ['hooks', '_common.mjs'],
    ['hooks', 'session-start.mjs'],
    ['hooks', 'builder-receipt.mjs'],
    ['hooks', 'notify.mjs'],
    // (Until 2026-08-07 the two remote-write guards — hooks/bash-remote-write.mjs and
    // hooks/pre-push.mjs — were scanned here too; they were removed with the layer, server-only
    // decision. What survives of that surface is githooks.mjs's removal report lines, which name
    // kernel commands an operator is told to run, so the scan follows the prose there.)
    ['src', 'kernel', 'githooks.mjs'],
    ['workflows', 'build-loop.js'],
  ];
}

test('every kernel command a component names is one the router actually dispatches', () => {
  // The router's own usage output is the authority: `legion` with no args exits 1 and lists
  // "  legion <cmd>" per available command.
  const home = mkdtempSync(join(tmpdir(), 'legion-home-')); // never the real ~/.legion
  const r = spawnSync(process.execPath, [join(ROOT, 'bin', 'legion.mjs')], {
    encoding: 'utf8', env: { ...process.env, LEGION_HOME: home },
  });
  assert.equal(r.status, 1, 'a bare `legion` must fail closed');
  const ROUTER = new Set([...r.stderr.matchAll(/^ {2}legion (\S+)$/gm)].map((m) => m[1]));
  assert.ok(ROUTER.size >= 7, `router advertised too few commands: ${[...ROUTER]}`);

  const SUBS = {
    state: new Set(STATE_OPS),            // imported from the kernel, never copied
    gate: new Set(['run', 'verify-receipt']),
    // Hand-maintained mirror of `legion feature`'s dispatch table (src/cli/feature.mjs `run`) —
    // and it WENT STALE: T19 landed `clean` on the router and in USAGE (PLAN-V3 §The kernel,
    // §Startup) while this set kept three entries. The staleness was latent only because no
    // shipped component named `legion feature clean` until T22's SKILL.md worktree paragraph did.
    // Widened here to match the surface the router actually dispatches; a set NARROWER than the
    // router rejects true prose and teaches the next author to delete a correct sentence.
    feature: new Set(['start', 'status', 'abandon', 'clean']),
    plan: new Set(['check']),
    project: new Set(['init']),
  };

  let checked = 0;
  for (const parts of componentFiles()) {
    const what = parts.join('/');
    for (const inv of invocations(read(...parts))) {
      checked += 1;
      const tokens = inv.split(/\s+/).filter(Boolean);
      const cmd = tokens[0];
      assert.ok(ROUTER.has(cmd), `${what}: \`legion ${inv}\` — '${cmd}' is not a router command`);
      // A bare family reference (`legion doctor`, `legion finalize`) has no subcommand to check.
      if (SUBS[cmd] && tokens.length > 1) {
        const sub = tokens[1].replace(/[\\`]+$/, ''); // trailing escape from a JS template literal
        assert.ok(SUBS[cmd].has(sub), `${what}: \`legion ${inv}\` — '${cmd} ${sub}' is not a real op`);
      }
    }
  }
  // A regex that silently matched nothing would make this whole test vacuous.
  assert.ok(checked >= 30, `expected the surface to name many kernel commands, found ${checked}`);
});

// --- T12: receipts have exactly ONE minter, on the surface as well as in the kernel ------------
// A skill or agent telling a model to run a receipt-writing `legion state` op would be a silent
// dead end (the router no longer dispatches one), and — worse — an instruction to reach for a
// capability the design deliberately removed. The conformance test above catches the dead end
// automatically because SUBS.state is built from STATE_OPS; these assertions make the INTENT
// explicit, so a future re-addition fails naming the rule rather than a missing op.

test('no `legion state` op writes a receipt, and no shipped component names one', () => {
  assert.ok(!STATE_OPS.includes('receipt-record'),
    'PLAN-V3 §State: there is NO receipt-record op — a caller that can write a receipt can certify a tree no gate ran on (R1)');
  assert.deepEqual(STATE_OPS.filter((op) => /receipt/.test(op)), [],
    '`legion gate` is the only minter; no state op may write a receipt under any name');
  for (const parts of componentFiles()) {
    const what = parts.join('/');
    const src = read(...parts);
    for (const inv of invocations(src)) {
      assert.doesNotMatch(inv, /^state\s+receipt/,
        `${what}: \`legion ${inv}\` — receipts are minted by \`legion gate\` alone`);
    }
    // Prose too, not only backticked invocations: an unbacked mention would still be copied.
    assert.doesNotMatch(src, /legion\s+state\s+receipt/,
      `${what}: names a receipt-writing \`legion state\` op, which does not exist`);
  }
  // kernel-op's CLOSED SET is the one place a shell-holding agent's vocabulary is enumerated.
  const closedSet = [...read('agents', 'kernel-op.md').matchAll(FENCE)]
    .flatMap((m) => m[1].split('\n'))
    .map((l) => l.trim())
    .filter((l) => l.startsWith('legion '))
    .map((l) => l.split(/\s+/).slice(1, 3).join(' '));
  assert.ok(closedSet.length > 0, 'the closed set must be non-empty (a regex matching nothing proves nothing)');
  for (const cmd of closedSet) {
    assert.ok(!/^state receipt/.test(cmd), `kernel-op's closed set must not contain '${cmd}'`);
  }
});

test('backtick discipline — no bare legion invocation escapes the check above', () => {
  // Test above only validates invocations that are inline-backticked or inside a fenced block.
  // A bare one in prose would therefore be unchecked, so bare ones are forbidden outright.
  // Applied to the Markdown components (what a model reads and copies); the .mjs/.js files use
  // backticks inside template literals, where naive span-stripping does not pair reliably.
  // Matches only INVOCATION shapes, never the English word: "a legion feature through its
  // lifecycle" is prose, `legion feature start` is a command.
  const BARE = /\blegion\s+(state|gate|finalize|doctor|plan\s+check|project\s+init|feature\s+(start|status|abandon))\b/;
  for (const parts of componentFiles().filter((p) => p.at(-1).endsWith('.md'))) {
    const stripped = read(...parts).replace(FENCE, ' ').replace(/`[^`]*`/g, ' ');
    const m = stripped.match(BARE);
    assert.equal(m, null, `${parts.join('/')}: un-backticked "${m?.[0]}" — backtick it or fence it`);
  }
});

// --- T24: code-informed intake ---------------------------------------------------------------
// The intake stage's ORDER is the rule (PLAN-V3 decision 4, §Approval flows item 4): classify,
// then read the target repo at the depth that classification sets, then author the brief, then
// recap against what the code said. Prose is not executable, so these assert the two things that
// ARE checkable and that a later edit would silently break: that the ordered rule is still there
// in that order, and that the kind the stage tells the session to record is a kind the kernel
// accepts — a skill instructing `artifact-record <kind>` for a kind ARTIFACT_KINDS dropped is the
// same silent dead end the command-conformance test above exists to stop, one argument deeper.

/** The `### <heading>` stage section of the skill body, up to the next `### `. */
function stageSection(body, heading) {
  const start = body.indexOf(`\n### ${heading}\n`);
  assert.ok(start >= 0, `SKILL.md has no '### ${heading}' stage section`);
  const rest = body.slice(start + 1);
  const end = rest.indexOf('\n### ', 1);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Index of an anchor, asserted present first. An absent anchor is -1, and -1 is less than
 * everything — which is exactly how an ordering assertion goes green against a file that lost
 * the rule altogether. */
function anchor(section, needle, what) {
  const i = typeof needle === 'string' ? section.indexOf(needle) : section.search(needle);
  assert.ok(i >= 0, `intake stage: ${what} is missing (${needle})`);
  return i;
}

test('every artifact kind a component names is one `legion state artifact-record` accepts', () => {
  let literals = 0;
  let menus = 0;
  for (const parts of componentFiles()) {
    const what = parts.join('/');
    for (const inv of invocations(read(...parts))) {
      const [cmd, op, kind] = inv.split(/\s+/).filter(Boolean);
      if (cmd !== 'state' || op !== 'artifact-record' || !kind) continue;
      if (kind.startsWith('<')) {
        // The MENU form `<a\|b\|c>` (the stage table row) is what a session picks its kind from,
        // so it must be the kernel's list itself: a kind missing from it is a capability no
        // session ever reaches, and one it lists that the kernel dropped is a refused op.
        const listed = kind.replace(/^<|>$/g, '').split(/\\?\|/).filter(Boolean);
        assert.deepEqual([...listed].sort(), [...ARTIFACT_KINDS].sort(),
          `${what}: the artifact-kind menu must equal the kernel's ARTIFACT_KINDS`);
        menus += 1;
      } else {
        assert.ok(ARTIFACT_KINDS.includes(kind),
          `${what}: \`legion ${inv}\` — '${kind}' is not an artifact kind the kernel accepts`);
        literals += 1;
      }
    }
  }
  assert.ok(menus >= 1, 'the stage table must still carry the artifact-kind menu row');
  assert.ok(literals >= 1, 'no literal kind was checked — the loop would be vacuous');
  assert.ok(ARTIFACT_KINDS.includes('repo-brief'), 'intake records its read under this kind');
});

test('the intake stage reads the code BEFORE the recap, at the depth the profile sets', () => {
  const { body } = parseFrontmatter(read('skills', 'feature', 'SKILL.md'), 'skills/feature/SKILL.md');
  const s = stageSection(body, 'intake');
  const iClassify = anchor(s, 'escalate-profile', 'the profile classification');
  const iRead = anchor(s, /READ THE TARGET REPOSITORY/, 'the repository read');
  const iBrief = anchor(s, 'artifact-record repo-brief', 'the repo-brief authoring step');
  const iRecap = anchor(s, 'INTAKE RECAP', 'the recap gate');
  const iAgreed = anchor(s, 'decision-record intake', 'the recorded agreement');
  assert.ok(iClassify < iRead, "the read's depth is the profile's, so classification precedes it");
  assert.ok(iRead < iBrief, 'the brief is written from the read, not before it');
  assert.ok(iBrief < iRecap, 'the recap is judged against a brief that already exists');
  assert.ok(iRecap < iAgreed, 'the agreement is recorded after the recap, never before');
  // Both depths, each bound to the profiles it belongs to — a read whose depth is a vibe is the
  // failure this slice exists to close.
  assert.match(s, /express ⇒ COMPACT/, 'express reads compact');
  assert.match(s, /standard and full ⇒ COMPLETE/, 'standard and full read complete');
  // The escalation door: a read that changes the classification deepens rather than shipping the
  // shallower profile's read.
  assert.match(s.slice(iRead), /escalate-profile/, 'the read must be able to re-classify');
  // The recap carries what the code said, or the read informed nothing.
  assert.match(s.slice(iRecap), /contradicted/i, 'the recap plays back what the code contradicted');
  // ...and the correction must land in the artifact the approval BINDS. The kernel hashes
  // intent.md and nothing else for the intake subject (ARTIFACT_TO_APPROVAL: intent→intake;
  // repo-brief deliberately binds none), so a stage that recaps a corrected framing and records
  // the yes over the pre-read intent produces a hash-valid approval of a framing the code
  // refuted. The re-record has to sit after the recap and before the agreement, in that order.
  const iReRecord = iRecap + anchor(s.slice(iRecap), 'artifact-record intent',
    're-recording the intent the recap corrected');
  assert.ok(iReRecord < iAgreed,
    'the corrected intent is re-recorded BEFORE the agreement that binds its hash');
});

test('the multi-repo intake form lands the mechanics and fences M1b out', () => {
  const { body } = parseFrontmatter(read('skills', 'feature', 'SKILL.md'), 'skills/feature/SKILL.md');
  const s = stageSection(body, 'intake');
  assert.match(s, /intakeRepos/, 'the multi-repo form triggers on the manifest key T23 records');
  assert.match(s, /specs\/<repo basename>\.md/, 'the per-repo spec drafts are named by path');
  assert.match(s, /exactly \*\*one\*\* spec artifact/,
    'the drafts must not read as this feature\'s spec — one recorded spec artifact per feature');
  // THE FENCE MOVED, AND THIS PIN MOVED WITH IT (T34). Until c10 the fence read "create no
  // sibling features, no initiative links, no by-reference intake records and no interface
  // contract — that is M1b", and this assertion pinned that sentence. T32/T33 BUILT the layer, so
  // that sentence became false prose and the pin became a pin on a lie. What still has to be
  // fenced is not the mechanics but the CLAIM: M1b's attended FE+BE proving run is deferred, the
  // layer ships dark, its acceptance stays OPEN (PLAN-V3 §Milestones M1b, amended 2026-07-29). So
  // the assertion is RE-AIMED at the live mechanics plus the ships-dark fence — three checks
  // where there was one, and nothing here is satisfied by prose that predates the build.
  assert.match(s, /artifact-record contract/,
    'the primary hosts the interface contract, recorded through the real op');
  assert.match(s, /--initiative <id>/,
    'and the siblings are started by the OPERATOR through the real flag');
  assert.match(s, /SHIPS DARK[\s\S]{0,600}(DEFERRED|deferred)/,
    'the fence that remains: the attended proving run is deferred and the layer ships dark');
  assert.match(s, /acceptance stays \*\*open\*\*/i,
    'and M1b\'s acceptance is stated as OPEN — a skill that claims it delivered is the one thing this pin exists to catch');
});

// The express mini-spec (2026-08-07): the spec STAGE stays — it anchors the acceptance
// yardstick, the Amendments route and the initiative contract — but on express its authoring and
// approval fuse into the intake recap (one reading, one yes). These pin the protocol rules whose
// loss ships a broken walk: the fused block SUBORDINATES steps 7–9 rather than following them (a
// block read as additional runs the intake ops twice, and the second `stage-complete intake` is
// refused mid-flow), a corrected yes must land in the mini-spec bytes before they are approved,
// the op ORDER inside the chain (artifact before decision — reversed, `decision-record spec`
// refuses with no artifact on record, and a changed re-record after the approval cascades it
// away; loud either way, but a kernel refusal in the middle of the one flow fusion exists to
// streamline), and the spec section's carve-out (without it a session walks an express feature
// into a second full spec interview, the very cost the fusion removes).
test('express fuses the mini-spec into the intake recap, artifact before decision', () => {
  const { body } = parseFrontmatter(read('skills', 'feature', 'SKILL.md'), 'skills/feature/SKILL.md');
  const intake = stageSection(body, 'intake');
  const iFused = anchor(intake, /EXPRESS, the spec stage is FUSED/, 'the express fused block');
  const fused = intake.slice(iFused);
  assert.match(fused, /replace — never precede/,
    'the fused forms SUBORDINATE steps 7–9 — read as additional, the intake ops run twice');
  assert.match(fused, /acceptance rows/, 'the mini-spec still carries the acceptance yardstick');
  assert.match(fused, /named explicitly/, 'and a schema change is still named, never hidden');
  assert.match(fused, /yes covers both/, 'the single yes covers recap AND mini-spec digest');
  assert.match(fused, /`intent\.md` \*\*and\s+the mini-spec\*\*/,
    'a corrected yes is folded into BOTH artifacts before anything is approved');
  const iArtifact = anchor(fused, 'artifact-record spec', 'the mini-spec artifact record');
  const iDecision = anchor(fused, 'decision-record spec', 'the mini-spec decision record');
  assert.ok(iArtifact < iDecision,
    'the artifact is recorded BEFORE the approval — reversed, the chain breaks mid-flow');
  assert.match(fused, /minus\s+`legion state decision-record intake`/,
    'the by-reference secondary keeps its exemption inside the fused chain');
  assert.match(fused, /again, against the changed\s+recap/,
    'a recap that moved re-collects the mini-spec yes — its approval subject never binds the recap');
  const spec = stageSection(body, 'spec');
  assert.match(spec, /EXPRESS profile this stage is normally already satisfied/,
    'the spec stage names the express traversal — else express features get a second spec pass');
  assert.match(spec, /at the mini-spec format defined at intake/,
    'the repair path points at the ONE canonical format definition, not a drifting copy');
});

// --- T30: /legion:start, the in-session creation wrapper --------------------------------------
// PLAN-V3 §Startup's 2026-07-29 S-007 amendment. The skill is prose, so what these assert is the
// small set of things whose LOSS would make it dangerous rather than merely worse: that it is
// loadable at all (frontmatter + the invocation name the user types), that it cannot create
// infrastructure with a tool (Rule 0's mechanical half), that the name shape it teaches is the
// kernel's own, and that the four steps whose ORDER is the whole amendment are still in that
// order. The command-conformance and artifact-kind scans above already cover it via
// componentFiles(); that is where "every command it names is real" is enforced, not here.

test('the /legion:start skill exists, is well-formed, and cannot create infrastructure', () => {
  const src = read('skills', 'start', 'SKILL.md');
  const { frontmatter: fm, body } = parseFrontmatter(src, 'skills/start/SKILL.md');
  // The invocation name is the frontmatter name, not the directory: /legion:start.
  assert.equal(fm.name, 'start');
  assert.ok(typeof fm.description === 'string' && fm.description.length > 40, 'description must be substantive');
  assert.ok(Array.isArray(fm['allowed-tools']), 'allowed-tools must be a list');
  // Bash runs the one-shot, the read tools inspect the repo and the manifests, AskUserQuestion is
  // the confirmation gate, and Skill is the hand-over to /legion:feature. Without any one of them
  // a step of the flow is unreachable.
  for (const tool of ['Bash', 'Read', 'Glob', 'Grep', 'AskUserQuestion', 'Skill']) {
    assert.ok(fm['allowed-tools'].includes(tool), `allowed-tools must include ${tool}`);
  }
  // RULE 0's MECHANICAL HALF. The skill promises it never writes a manifest, never creates a
  // dossier and never creates a worktree or branch; withholding the editing tools is what makes
  // that promise more than prose. Granting one back would be the second creation path S-007
  // exists to NOT be, so it fails here rather than in a review someday.
  for (const banned of ['Write', 'Edit', 'NotebookEdit']) {
    assert.ok(!fm['allowed-tools'].includes(banned),
      `${banned} would make /legion:start able to hand-build the infrastructure only the CLI may create`);
  }
  assert.ok(body.length > 2000, 'the skill body carries the whole flow — it cannot be a stub');
  // Rule 0 in the words PLAN-V3 §Startup uses, and the wrapper claim it rests on.
  assert.match(body, /naming-and-invocation wrapper, never a second creation path/i);
  // THE NAME SHAPE IS THE KERNEL'S. The skill teaches the operator-visible rule; a shape that
  // drifts from safeSegment() teaches a name `feature start` will refuse. Bound byte-for-byte to
  // paths.mjs, the same way build-loop's ID_RE is above.
  const kernelRe = read('src', 'kernel', 'paths.mjs').match(/const SEGMENT_RE = \/([^;]+)\/;/)?.[1];
  assert.ok(kernelRe, 'paths.mjs must declare SEGMENT_RE where this test can read it');
  assert.ok(body.includes(kernelRe),
    `the skill must quote the kernel segment shape verbatim (${kernelRe})`);
});

test('/legion:start keeps the amendment ORDER: confirm, create, then become the feature session', () => {
  const { body } = parseFrontmatter(read('skills', 'start', 'SKILL.md'), 'skills/start/SKILL.md');
  /** Index of an anchor, asserted present — an absent one is -1, and -1 precedes everything, which
   * is exactly how an ordering assertion passes against a file that lost the step. */
  const at = (needle, what) => {
    const i = typeof needle === 'string' ? body.indexOf(needle) : body.search(needle);
    assert.ok(i >= 0, `skills/start/SKILL.md: ${what} is missing (${needle})`);
    return i;
  };
  const iRule0 = at(/## Rule 0/, 'Rule 0');
  const iCwd = at(/MAIN REPO ROOT/, 'the main-repo-root precondition');
  const iConfirm = at(/confirm the name AND the base/i, 'the explicit name+base confirmation');
  const iStart = at('legion feature start <name> --base <branch>', 'the one-shot');
  const iSession = at('state session-record --session-id', 'the explicit session-record step');
  const iInit = at('legion state init', 'the intake step-0 pointer');
  // Anchored to the STEP, not to the string `/legion:feature` — that name also appears in the
  // file's leading format comment, which sits above everything and would make this vacuous.
  const iHandover = at('## Step 5', 'the hand-over step');
  const iResidual = at(/soft isolation/, 'the accepted residual');
  assert.match(body.slice(iHandover), /\/legion:feature/,
    'the hand-over step must name the skill it hands over to');
  // Rule 0 leads, because everything below it is only safe under it.
  assert.ok(iRule0 < iCwd, 'Rule 0 is stated first');
  // Nothing is created before the cwd is checked and the user has confirmed the name and base:
  // a wrong name is not editable afterwards (dossier path + branch + manifest identity).
  assert.ok(iCwd < iStart, 'the precondition precedes the one-shot');
  assert.ok(iConfirm < iStart, 'name and base are confirmed BEFORE anything is created');
  // The one-session amendment: the session-record step and the manifest reads are what replace the
  // SessionStart injection that could not have fired, so they follow creation and precede the
  // lifecycle. Handing over first would enter intake as a session the feature has no record of.
  assert.ok(iStart < iSession, 'the session is recorded after the feature exists');
  assert.ok(iSession < iHandover, 'the session-record step precedes the lifecycle hand-over');
  assert.ok(iSession < iInit, "and precedes `state init` — it needs only feature.json");
  assert.ok(iHandover < iResidual, 'the residual is recorded after the flow it qualifies');
  // The cwd discipline is the one instruction every later op depends on. `legion feature status`
  // is the documented exception; everything else carries the prefix.
  assert.match(body, /cd <worktree> && legion state init/,
    'the cwd discipline must appear as a copyable command, not only as advice');
  // The residual must name what still holds, or it reads as a shrug. finalize is the intended
  // remote-write path, and since 2026-08-07 the residual must also state the server-only
  // layering — claiming a local deny that no longer exists would be the worse failure.
  const residual = body.slice(iResidual);
  assert.match(residual, /only remote-write path/, 'the residual names finalize as the intended path');
  assert.match(residual, /only barrier/i, 'and states the server-only decision — no local guard layer');
  // Resumes are NOT this skill's path — losing that sentence is how the printed launch command
  // stops being used and every later session re-enters through here.
  assert.match(body, /Resumes are unaffected/, 'the resume path must stay documented');
});

// A NEW repository is the ordinary case for this skill: the operator types /legion:start in a repo
// legion has never seen, and the one-shot refuses on registration. The skill onboards it itself
// rather than handing the operator a command to type — safe only under two conditions, and both
// are what this test pins, because losing either turns the convenience into the destructive
// worktree re-registration resolveProject's docblock warns about.
test('/legion:start onboards an unregistered repository itself, under the main-root guard', () => {
  const { body } = parseFrontmatter(read('skills', 'start', 'SKILL.md'), 'skills/start/SKILL.md');
  const at = (needle, what) => {
    const i = typeof needle === 'string' ? body.indexOf(needle) : body.search(needle);
    assert.ok(i >= 0, `skills/start/SKILL.md: ${what} is missing (${needle})`);
    return i;
  };
  const iRule0 = at(/## Rule 0/, 'Rule 0');
  const iCwd = at(/MAIN REPO ROOT/, 'the main-repo-root precondition');
  const iStep = at('## Step 3a', 'the onboarding step');
  const iSession = at('state session-record --session-id', 'the session-record step');
  // The remedy is the CLI's own, --root included: a bare `legion project init` typed inside a
  // linked worktree RECONCILES the real project entry onto that worktree (repoRoot and
  // defaultBranch rewritten), breaking every feature of the project. The flag is not decoration.
  assert.match(body.slice(iStep), /legion project init --root <main repo root>/,
    'the onboarding step must carry --root, never a bare init that could register a worktree path');
  // …and it is gated on the cwd being the main root, established by the one read that establishes
  // it — `git worktree list`'s first line. Without this the skill auto-registers whatever checkout
  // it happens to stand in.
  assert.match(body.slice(iStep, iSession), /git worktree list/,
    'the main-root check must be a command the skill actually runs, not an assumption');
  assert.ok(iCwd < iStep, 'the cwd precondition is stated before the step that acts on it');
  assert.ok(iStep < iSession, 'onboarding happens on the way to creation, not after it');
  // The refusal it fixes is ONE refusal. A skill reading `project init` as the general answer to a
  // failing `feature start` would run it against not-a-git-repo, a taken name or a failed
  // bootstrap — none of which registration fixes.
  assert.match(body.slice(iStep), /is the answer to exactly one refusal/i,
    'the step must bound itself to the registration refusal');
  // THERE ARE TWO unregistered-repository refusals, and a skill that knows only one dead-ends on
  // the other. Bound to the kernel's own strings (src/cli/feature.mjs resolveProject), the way the
  // segment shape above is bound to paths.mjs — this was found by running it, not by reading it:
  // the FIRST project on a machine hits the no-index branch, so the commonest real /legion:start
  // is precisely the one the narrower trigger misses. That branch also names a BARE init (it has
  // no resolution to report a root from), which is why the skill supplies --root itself.
  const featureSrc = read('src', 'cli', 'feature.mjs');
  for (const phrase of ['is not a registered project', 'no project index at']) {
    assert.ok(featureSrc.includes(phrase), `feature.mjs must still refuse with "${phrase}"`);
    assert.ok(body.includes(phrase), `skills/start/SKILL.md must name the "${phrase}" refusal`);
  }
  // Registration scaffolds gates to {}, so the one-shot's no-gate warning is TRUE for every
  // repository onboarded this way. Reassuring past it would land features that gate on nothing.
  assert.match(body.slice(iStep), /EMPTY gate policy/,
    'the empty-gate consequence of a fresh registration must be surfaced, not smoothed over');
  // Rule 0 must not read as forbidding the step: it forbids a second CREATION path, not a second
  // CLI call. Losing this is how a later author deletes step 3a as a Rule 0 violation.
  assert.match(body.slice(iRule0, iCwd), /second \*\*creation\*\* path/,
    'Rule 0 must scope itself to creation paths, or it contradicts step 3a');
});

test('the architect actually consumes the brief that intake now guarantees', () => {
  const src = read('agents', 'architect.md');
  const iInputs = src.indexOf('## Inputs');
  const iDo = src.indexOf('## Do');
  assert.ok(iInputs > 0 && iDo > iInputs, 'architect.md must keep its Inputs and Do sections');
  assert.match(src.slice(iInputs, iDo), /repo-brief\.md/,
    'the brief is named as an input by the filename intake writes');
  assert.match(src.slice(iDo), /repo-brief/,
    'an input the exploration step never mentions is an input that gets skipped');
});

// --- Decision grammar: the proof-gated grammar covers decisions, not only facts ----------------
// The failure mode this closes (the cv-mf incident): an architect's measurement, valid for one
// problem, was carried over to a different problem; the plan showed one approach with no
// alternatives, so the critic had nothing to attack, and the builder's only exit was an
// answerable question — so every round re-fixed the symptom locally and the wrong premise
// survived. Prose is not executable; what is pinned is the vocabulary of the grammar, whose
// silent loss from any one surface re-opens exactly that hole.

test('the decision grammar is declared across the plan surface', () => {
  const architect = read('agents', 'architect.md');
  assert.match(architect, /## Decisions/, 'the architect owns a Decisions section of plan.md');
  assert.match(architect, /none — no structuring choice/,
    'the empty form is explicitly valid — proportionality is the rule, not ceremony');
  assert.match(architect, /notes\.decision/, 'tasks link to decisions through the hashed notes channel');
  assert.match(architect, /next-change/i, 'the under-design probe is asked, not a method imposed');
  assert.match(architect, /deletion test/i, 'the over-design probe likewise');
  assert.match(architect, /none — new pattern[\s\S]{0,120}must cite/,
    'a new pattern with no declared decision is the undeclared choice the critic hunts');
  assert.doesNotMatch(architect, /knowledge corpus/,
    'the dangling corpus input is gone — lessons.md is the real, named input');
  const iInputs = architect.indexOf('## Inputs');
  assert.match(architect.slice(iInputs, architect.indexOf('## Do')), /lessons\.md/,
    'the architect reads the project lessons file whole');

  const critic = read('agents', 'plan-critic.md');
  assert.match(critic, /always present/,
    'codex F1 on this chunk: presence gated on a linking task lets a no-new-pattern plan drop the section unflagged');
  assert.match(critic, /notes\.decision/, 'the critic verifies the task↔decision linkage');
  assert.match(critic, /[Ss]trawman/, 'rejected options must be ones an engineer might actually pick');
  assert.match(critic, /Evidence-scope check/,
    'the cv-mf check: a measurement for one problem justifies nothing about another');
  assert.match(critic, /next-change/i, 'the critic runs the under-design probe itself');
  assert.match(critic, /[Dd]eletion/, 'and the over-design probe');
  assert.match(critic, /[Uu]ndeclared structuring choice/,
    'a structuring choice visible in the tree with no block is a finding');

  const builder = read('agents', 'builder.md');
  assert.match(builder, /"kind":\s*"design"/, 'the builder can contest a plan premise as typed data');
  assert.match(builder, /premise/, 'with the contested premise named');
  assert.match(builder, /alternative/, 'and the simpler route named');
  assert.match(builder, /plan stage/, 'and told where the concern routes — never to a task answer');

  assert.match(read('agents', 'code-reviewer.md'), /category/,
    'reviewer findings can carry the recurrence slug');
  assert.match(read('agents', 'codex-consult.md'), /category/,
    'the codex translation carries it too — recurrence counting needs both lenses');
});

test('the build stage routes design signals through the PLAN stage, never task-answer', () => {
  const { body } = parseFrontmatter(read('skills', 'feature', 'SKILL.md'), 'skills/feature/SKILL.md');
  const s = stageSection(body, 'build — by default, the shipped workflow');
  const at = (needle, what) => {
    const i = typeof needle === 'string' ? s.indexOf(needle) : s.search(needle);
    assert.ok(i >= 0, `build stage: ${what} is missing (${needle})`);
    return i;
  };
  // ORDER: the kind check opens the question protocol (an answered design concern is a plan
  // problem settled inside the very plan it contests), the light task-rewrite path stays for
  // ordinary plan problems, and the design route follows it as the explicit exception.
  const iProtocol = at('QUESTION PROTOCOL', 'the question protocol');
  const iKind = at(/First check `kind`/, 'the kind check');
  const iLight = at(/When the workflow returns failed tasks/, 'the light task-rewrite path');
  const iRoute = at(/the DESIGN\s+ROUTE/, 'the design route');
  assert.ok(iProtocol < iKind, 'the kind check opens the question protocol');
  assert.ok(iKind < iLight && iLight < iRoute, 'the design route is the exception AFTER the light path');
  const route = s.slice(iRoute);
  assert.match(route, /stage-enter plan/, 'the route re-enters the plan stage through the real op');
  assert.match(route, /plan check --feature <name> --import/, 'and re-imports through the guard');
  assert.match(route, /[Pp]lan-critic/, 'the critic reviews the amendment (express excused, as at plan)');
  assert.match(route, /decision-record plan/, 'and the human re-approves through the real op');
  assert.match(route, /never the light task-rewrite/,
    'the route must name what it is NOT — the one-task rewrite that lets a shared premise survive');
  assert.match(route, /explicitly overrules/,
    'the operator carve-out: an overruled concern settles as a recorded answer, an upheld one never does');
  // The signal must be named where the return value is persisted AND in the completion gate —
  // an all-green run with a recurring class is exactly the entrenchment shape.
  assert.match(s, /`designSignals`[\s\S]{0,500}design route/,
    'designSignals is listed among the return fields that exist only in the return');
  assert.match(s, /designSignals` came back empty or every signal was routed/,
    'and the stage-completion gate refuses to close over an unrouted signal');
});

test('lessons.md is wired: intake and the architect read it, the session writes it', () => {
  const { body } = parseFrontmatter(read('skills', 'feature', 'SKILL.md'), 'skills/feature/SKILL.md');
  const intake = stageSection(body, 'intake');
  const iLessons = intake.indexOf('lessons.md');
  assert.ok(iLessons >= 0, 'intake reads the project lessons file');
  assert.ok(iLessons < intake.indexOf('INTAKE RECAP'),
    'and reads it BEFORE the recap — a contradicted lesson surfaces exactly like contradicted code');
  assert.match(stageSection(body, 'plan'), /lessons\.md/,
    'the architect dispatch names the lessons path — an input the dispatch omits is an input the agent never gets');
  assert.match(body, /## Lessons — project memory/, 'the writing rules have a section of their own');
  const lessons = body.slice(body.indexOf('## Lessons — project memory'));
  assert.match(lessons, /non-obvious, reusable, actionable, and not already captured/,
    'the S-002 quality bar survives verbatim — without it the file silts up and stops being read');
  assert.match(lessons, /scope it holds under/,
    'decisions land WITH their scope — an unscoped lesson is the cv-mf transfer error waiting to recur');
});
