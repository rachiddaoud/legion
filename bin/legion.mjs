#!/usr/bin/env node
// legion — deterministic kernel CLI router (PLAN-V3 "The kernel").
// argv[2] names a command implemented at src/cli/<cmd>.mjs — resolved from THIS file's
// location via import.meta.url, never cwd — exporting run(argv) (argv = process.argv
// slice 3) which may return a numeric exit code (default 0).
// Invariants: fail closed — a missing, unknown, or unimplemented command exits 1 with
// usage + the available-command list on stderr, NEVER 0 (skills/hooks must not mistake
// a no-op for success). Command names are shape-guarded BEFORE any import URL is built,
// so `legion ../evil` can never traverse out of src/cli/. Any throw (import failure or
// run failure) dies loudly: `legion <cmd>: <message>` on stderr, exit 1.
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI_DIR = new URL('../src/cli/', import.meta.url);
// Lowercase-kebab only: rejects path separators, dots, uppercase — the traversal guard.
const CMD_RE = /^[a-z][a-z0-9-]*$/;

function availableCommands() {
  let entries;
  try { entries = readdirSync(fileURLToPath(CLI_DIR)); } catch { return []; } // ENOENT ⇒ none
  // The usage list and the dispatch check apply the SAME filter (CMD_RE) so usage never
  // advertises an uninvokable command. CMD_RE subsumes the old leading-underscore filter
  // (first char must be a lowercase letter), so _helpers stay hidden too.
  return entries
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => f.slice(0, -'.mjs'.length))
    .filter((c) => CMD_RE.test(c))
    .sort();
}

function usage() {
  const cmds = availableCommands();
  const list = cmds.length
    ? cmds.map((c) => `  legion ${c}`).join('\n')
    : '  (none implemented yet)';
  process.stderr.write(`usage: legion <command> [args]\n\navailable commands:\n${list}\n`);
}

const cmd = process.argv[2];
if (!cmd || !CMD_RE.test(cmd) || !availableCommands().includes(cmd)) {
  if (cmd) process.stderr.write(`legion: unknown command '${cmd}'\n`);
  usage();
  process.exitCode = 1;
} else {
  try {
    const mod = await import(new URL(`${cmd}.mjs`, CLI_DIR));
    const code = await mod.run(process.argv.slice(3));
    process.exitCode = typeof code === 'number' ? code : 0;
  } catch (err) {
    process.stderr.write(`legion ${cmd}: ${err?.message ?? err}\n`);
    process.exitCode = 1;
  }
}
