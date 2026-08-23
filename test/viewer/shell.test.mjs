// shell.test.mjs — the pure decisions in viewer/src/lib/shell.mjs. No DOM, no browser, no viewer
// deps, so this file never skips: the rendering it decides is otherwise only observable through
// browser.test.mjs, which needs viewer/dist and Playwright.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connState, parseRoute, routeHash, showNextUnsatisfied } from '../../viewer/src/lib/shell.mjs';

/** The shape `lifecycleNow` hands the panel (projection.mjs), once the kernel could be asked. */
const verdict = (stage, why, nextUnsatisfied) => ({
  available: true, stage, satisfied: false, why, nextUnsatisfied, approvalsValidNow: {},
});

test('a next-unsatisfied stage that IS the current stage restates the verdict, and is not shown', () => {
  // unsatisfiedPrefix returns the FIRST unsatisfied stage of STAGES[0..current], so when it lands
  // on the current stage it comes back with the reason the panel has already printed, word for word.
  const why = 'no hash-valid spec approval is recorded';
  assert.equal(showNextUnsatisfied(verdict('spec', why, { stage: 'spec', why })), false);
});

test('a next-unsatisfied stage EARLIER than the current one is the one thing nothing else says', () => {
  const now = verdict('build', 'task T2 is started', { stage: 'spec', why: 'no hash-valid spec approval is recorded' });
  assert.equal(showNextUnsatisfied(now), true);
});

test('a clean prefix has no second verdict to show', () => {
  assert.equal(showNextUnsatisfied(verdict('build', 'task T2 is started', null)), false);
});

test('a reachable server and an unreachable one differ in GLYPH and in label, and neither names the transport', () => {
  const ok = connState('live', 'ok');
  const dead = connState('live', 'error');
  assert.notEqual(ok.glyph, dead.glyph);
  assert.notEqual(ok.label, dead.label);
  for (const { label } of [ok, dead, connState('live', 'loading')]) {
    assert.doesNotMatch(label, /loopback|read-only/);
  }
});

test('each of the three live states is told apart from the other two, colour aside', () => {
  const states = ['ok', 'loading', 'error'].map((s) => connState('live', s));
  assert.equal(new Set(states.map((s) => s.glyph)).size, 3);
  assert.equal(new Set(states.map((s) => s.label)).size, 3);
});

test('fixture data is its own state, not a healthy live server', () => {
  assert.notEqual(connState('fixture', 'ok').label, connState('live', 'ok').label);
});

const id = { org: 'default', project: 'legion', name: 'viewer-refinements' };

test('a tab addressed by routeHash comes back as that tab, through a lowercase segment', () => {
  const hash = routeHash(id, 'Changes');
  assert.match(hash, /\/changes$/);
  const route = parseRoute(hash);
  assert.equal(route.tab, 'Changes');
  assert.equal(route.screen, 'detail');
  assert.deepEqual(route.id, id);
});

test('every tab round-trips, and the address is the tab name lowercased', () => {
  for (const tab of ['Overview', 'Artifacts', 'Activity', 'Changes']) {
    assert.equal(routeHash(id, tab), `#/features/default/legion/viewer-refinements/${tab.toLowerCase()}`);
    assert.equal(parseRoute(routeHash(id, tab)).tab, tab);
  }
});

test('an absent, capitalised or unknown tab segment renders Overview', () => {
  const base = '#/features/default/legion/viewer-refinements';
  assert.deepEqual(parseRoute(base), { screen: 'detail', id, tab: 'Overview' });
  assert.equal(parseRoute(`${base}/Changes`).tab, 'Overview');
  assert.equal(parseRoute(`${base}/nope`).tab, 'Overview');
  assert.equal(parseRoute(`${base}/changes`).tab, 'Changes');
});

test('the identifier survives the address — it is encoded going out and decoded coming back', () => {
  const odd = { org: 'acme corp', project: 'cv/ml', name: 'a b?c' };
  const route = parseRoute(routeHash(odd, 'Activity'));
  assert.deepEqual(route.id, odd);
  assert.equal(route.tab, 'Activity');
});

test('the named screens are addressable, and anything else is Operations', () => {
  for (const screen of ['operations', 'features', 'insights', 'gallery']) {
    assert.deepEqual(parseRoute(`#/${screen}`), { screen, id: null, tab: 'Overview' });
  }
  assert.equal(parseRoute('#/nowhere').screen, 'operations');
  assert.equal(parseRoute('').screen, 'operations');
  assert.deepEqual(parseRoute('#/features/default/legion'), { screen: 'features', id: null, tab: 'Overview' });
});
