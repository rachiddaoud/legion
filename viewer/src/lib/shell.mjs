// shell.mjs — the decisions the app shell takes, as pure functions a node test can reach
// (test/viewer/shell.test.mjs). The precedent is lib/safe-href.mjs: a rule that decides what a
// screen shows is worth falsifying without a browser in the way.
//
// THE KERNEL'S SECOND VERDICT IS RENDERED ONLY WHERE IT IS NOT A RESTATEMENT. `lifecycleNow`
// carries the current stage's verdict AND `nextUnsatisfied`, which is `unsatisfiedPrefix` in
// src/kernel/state.mjs: the FIRST unsatisfied stage of STAGES[0..current]. When that is the
// current stage its `why` is the `why` already on the screen, word for word. When it names an
// EARLIER stage it is the one thing nothing else says — you are in build and the spec approval
// stopped binding — so that is the only case it is worth a paragraph.

/**
 * @param {{ stage: string, nextUnsatisfied: { stage: string, why: string } | null }} now
 * @returns {boolean} true when `nextUnsatisfied` names a stage other than the one it was asked about
 */
export const showNextUnsatisfied = (now) => Boolean(now?.nextUnsatisfied)
  && now.nextUnsatisfied.stage !== now.stage;

/** The feature detail's tabs, in order, and the ONE place they are spelled — the route derives its segment from them. */
export const TABS = /** @type {const} */ (['Overview', 'Artifacts', 'Activity', 'Changes']);
/** @typedef {(typeof TABS)[number]} Tab */

const SCREENS = /** @type {const} */ (['operations', 'features', 'insights', 'gallery']);

/** @param {{ org: string, project: string, name: string }} id @param {Tab} [tab] */
export const routeHash = (id, tab = TABS[0]) =>
  `#/features/${[id.org, id.project, id.name].map(encodeURIComponent).join('/')}/${tab.toLowerCase()}`;

/** The hash, read. An absent, unrecognised or CAPITALISED tab segment is `Overview`. @param {string} hash */
export function parseRoute(hash) {
  const parts = String(hash ?? '').replace(/^#\/?/, '').split('/').filter(Boolean);
  if (parts[0] === 'features' && parts.length >= 4) {
    return {
      screen: 'detail',
      id: {
        org: decodeURIComponent(parts[1]),
        project: decodeURIComponent(parts[2]),
        name: decodeURIComponent(parts[3]),
      },
      tab: TABS.find((t) => t.toLowerCase() === parts[4]) ?? TABS[0],
    };
  }
  return { screen: SCREENS.find((s) => s === parts[0]) ?? 'operations', id: null, tab: TABS[0] };
}

/** ui.tsx's STATUS_ICON vocabulary: the three states differ by GLYPH and by label, never by colour alone. */
const CONN = {
  ok: { glyph: '✓', label: 'connected' },
  loading: { glyph: '◐', label: 'connecting' },
  error: { glyph: '■', label: 'unreachable' },
};

/** @param {'live'|'fixture'} mode @param {'ok'|'loading'|'error'} healthState */
export const connState = (mode, healthState) =>
  (mode === 'fixture' ? { glyph: '○', label: 'fixtures' } : CONN[healthState]);
