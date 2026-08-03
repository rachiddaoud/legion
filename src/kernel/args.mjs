// args.mjs — flag parsing for kernel CLI commands: `--name value` pairs, `--name=value`
// pairs, `--name` boolean when listed in `bools`, positionals collect in order.
// A value-taking flag with no value — end of argv, or the
// next token is itself a `--flag` — THROWS `missing value for --name` instead of storing
// undefined. Commands must never observe a silently-valueless flag (fail closed).
// The inline `--name=value` form is bound HERE, before that missing-value check, and is the
// ONLY way to express a value that itself starts with `--` (`--answer=--no-verify is fine`):
// callers must not pre-split it into two tokens, since the split value would then trip the
// startsWith('--') refusal. Split is on the FIRST `=` only, so `=` inside a value survives
// verbatim; an inline value on a declared bool THROWS rather than being silently dropped.
// Known edge, deliberate: a bare `--` token parses as a flag with empty name ('' after
// slice(2)) — it consumes the next token as that flag's value, or throws `missing value
// for --` at end of argv / before another --flag. There is no positional-terminator
// convention here; kernel commands never need positionals that look like flags.
// REPEATABLE FLAGS ARE OPT-IN: a name listed in `multi`
// collects EVERY occurrence into an array IN ARGV ORDER; an unlisted name keeps last-wins exactly
// as before, so this adds a mode rather than changing one. Three properties the callers depend on:
//   - ALWAYS AN ARRAY once seen at least once (a single occurrence is a one-element array, never a
//     bare string) — a caller that must branch on `typeof` is a caller that will get it wrong;
//   - the key is ABSENT when the flag never appeared, never `[]`. "None" and "empty" are the same
//     fact here, and absence is what lets a recorded manifest omit the field entirely;
//   - EACH OCCURRENCE IS VALUE-CHECKED INDEPENDENTLY. Both forms feed the same collector, and a
//     trailing `--name` with no value still throws — collecting `undefined` into the array would
//     be the silently-valueless flag this parser was hardened to refuse, one level deeper.
// A name listed in BOTH bools and multi throws as a CONFIG error, before any argv is looked at:
// the two are contradictory (a bool takes no value, a multi is nothing but values) and silently
// picking one meaning for a caller who declared both is how a flag ends up parsing differently
// from the way its usage string reads.
export function parseArgs(argv, { bools = [], multi = [] } = {}) {
  const both = multi.find((n) => bools.includes(n));
  if (both !== undefined) {
    throw new Error(`--${both} is declared as both a bool and a multi flag — a bool takes no value, a multi is nothing but values`);
  }
  const flags = {};
  const positional = [];
  /** Bind one occurrence: append for a multi name, overwrite (last-wins) for every other. */
  const bind = (name, value) => {
    if (!multi.includes(name)) { flags[name] = value; return; }
    if (!Array.isArray(flags[name])) flags[name] = [];
    flags[name].push(value);
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      const inline = eq < 0 ? undefined : a.slice(eq + 1);
      if (bools.includes(name)) {
        if (inline !== undefined) throw new Error(`--${name} takes no value`);
        flags[name] = true;
      } else if (inline !== undefined) bind(name, inline);
      else {
        const v = argv[i + 1];
        if (v === undefined || v.startsWith('--')) throw new Error(`missing value for --${name}`);
        bind(name, v);
        i++;
      }
    } else positional.push(a);
  }
  return { flags, positional };
}

export function requireFlags(flags, names, usage) {
  for (const n of names) {
    if (flags[n] == null) throw new Error(`missing --${n}. usage: ${usage}`);
  }
}
