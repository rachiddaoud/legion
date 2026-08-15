// artifact-url.test.mjs — the client's dossier-relative address rules. Pure, no viewer deps, so it
// never skips.
//
// WHAT THIS DOES AND DOES NOT PROVE. It is NOT the traversal boundary — that lives in
// src/cli/_viewer/server.mjs (`artifactRelPath` + `containedRealpath`), is pinned by
// test/cli/viewer.test.mjs, and re-checks every rule below on every request regardless of what this
// module produced. What it proves is that the CLIENT never renders a link it already knows the
// server will refuse, so a screenshot reference that escapes the dossier reads as inert text rather
// than as an image that 403s.
//
// THE RULES ARE THE SERVER'S, deliberately: absolute paths, `..` escapes, dotfiles, NUL bytes and
// anything carrying a scheme are refused. Two definitions of "dossier-relative" would be one too
// many, exactly as the projection says of "satisfied".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  IMAGE_EXTENSIONS, artifactUrl, isHtml, isMarkdown, isServableImage, resolveArtifactPath,
} from '../../viewer/src/lib/artifact-url.mjs';

const ID = { org: 'acme', project: 'cv-mf', name: 'cv41-viewer' };

test('artifactUrl builds an encoded query — never a raw path in the URL path', () => {
  const url = artifactUrl(ID, 'visual/M1/home page@1280.png');
  assert.ok(url.startsWith('/api/artifact?'), 'the path is the endpoint, the file is a parameter');
  const q = new URLSearchParams(url.slice('/api/artifact?'.length));
  assert.equal(q.get('org'), 'acme');
  assert.equal(q.get('project'), 'cv-mf');
  assert.equal(q.get('name'), 'cv41-viewer');
  assert.equal(q.get('path'), 'visual/M1/home page@1280.png', 'the space round-trips through the encoding');
  assert.ok(!url.includes(' '), 'nothing unencoded rides in the URL');
});

test('resolveArtifactPath resolves against the DOCUMENT it came from', () => {
  // a doc at the dossier root
  assert.equal(resolveArtifactPath('review-visual.md', 'visual/M1/home.png'), 'visual/M1/home.png');
  assert.equal(resolveArtifactPath('review-visual.md', './visual/M1/home.png'), 'visual/M1/home.png');
  // a doc in a subdirectory: siblings resolve beside it, not at the root
  assert.equal(resolveArtifactPath('specs/T3.md', 'diagram.png'), 'specs/diagram.png');
  assert.equal(resolveArtifactPath('specs/T3.md', '../plan.md'), 'plan.md');
  assert.equal(resolveArtifactPath('specs/deep/T4.md', '../shots/a.png'), 'specs/shots/a.png');
  // redundant segments collapse
  assert.equal(resolveArtifactPath('a/b/c.md', './x/./y.png'), 'a/b/x/y.png');
});

test('resolveArtifactPath REFUSES rather than climbing — every refusal is null, never a clamp', () => {
  // escapes: one `..` too many from the root, and from a subdirectory
  assert.equal(resolveArtifactPath('review-visual.md', '../secrets.md'), null);
  assert.equal(resolveArtifactPath('specs/T3.md', '../../../../etc/passwd'), null);
  // absolute paths and schemes are not dossier references at all
  assert.equal(resolveArtifactPath('a.md', '/etc/passwd'), null);
  assert.equal(resolveArtifactPath('a.md', 'https://evil.example/x.png'), null);
  assert.equal(resolveArtifactPath('a.md', 'data:text/html,<script>alert(1)</script>'), null);
  assert.equal(resolveArtifactPath('a.md', 'javascript:alert(1)'), null);
  assert.equal(resolveArtifactPath('a.md', '#anchor'), null);
  // dotfiles are not served by the server, so they are not linked by the client either
  assert.equal(resolveArtifactPath('a.md', '.env'), null);
  assert.equal(resolveArtifactPath('a.md', 'sub/.git/config'), null);
  // NUL bytes and empties
  assert.equal(resolveArtifactPath('a.md', 'x\0.png'), null);
  assert.equal(resolveArtifactPath('a.md', ''), null);
  assert.equal(resolveArtifactPath('a.md', undefined), null);
  assert.equal(resolveArtifactPath('a.md', '.'), null, 'a reference naming no file resolves to nothing');
  // backslashes are treated as separators too — a Windows-shaped escape must not slip past
  assert.equal(resolveArtifactPath('a.md', '..\\..\\x'), null);
});

test('the servable-image list mirrors the server, and excludes .svg deliberately', () => {
  assert.ok(isServableImage('visual/M1/home@1280.png'));
  assert.ok(isServableImage('SHOT.JPG'), 'the extension test is case-insensitive');
  assert.ok(isServableImage('a.webp'));
  // .svg is NOT in src/cli/_viewer/server.mjs's ARTIFACT_TYPES: an SVG is a script container and a
  // dossier artifact is model-authored. The server answers 415, so the client must not render one.
  assert.ok(!isServableImage('diagram.svg'));
  assert.ok(!IMAGE_EXTENSIONS.includes('.svg'));
  assert.ok(!isServableImage('notes.md'));
});

test('isMarkdown decides what is rendered as a digest and what is offered as a link', () => {
  assert.ok(isMarkdown('plan.md'));
  assert.ok(isMarkdown('specs/T3.MARKDOWN'));
  assert.ok(isMarkdown('notes.txt'));
  assert.ok(!isMarkdown('contract.json'), 'JSON rendered as prose would be a worse lie than a link');
  assert.ok(!isMarkdown('shot.png'));
  assert.ok(!isMarkdown(null));
});

test('isHtml decides what is framed as a sandboxed mock — .html only, like the server', () => {
  assert.ok(isHtml('mockups/mission-modal-mock.html'));
  assert.ok(isHtml('MOCK.HTML'), 'the extension test is case-insensitive');
  assert.ok(!isHtml('mock.htm'), 'the server serves .html only — .htm would 415');
  assert.ok(!isHtml('plan.md'));
  assert.ok(!isHtml(null));
});

test('the mock iframe never grants allow-same-origin — the token that would collapse the design', async () => {
  // A source pin, not a render test: no assertion anywhere else covers the iframe ATTRIBUTE, and
  // adding allow-same-origin there (the obvious "fix" for a mock that cannot use localStorage)
  // hands model-authored HTML the viewer's API while every behavioural test stays green.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../viewer/src/screens/FeatureDetail.tsx', import.meta.url), 'utf8');
  const m = src.match(/<iframe[^>]*\ssandbox="([^"]*)"/);
  assert.ok(m, 'the mock preview iframe carries an explicit sandbox attribute');
  assert.match(m[1], /\ballow-scripts\b/);
  assert.doesNotMatch(m[1], /allow-same-origin/);
});
