import assert from 'node:assert/strict';
import test from 'node:test';

import { getReleaseNotes, parseChangelog } from '../lib/releases.js';

test('release notes parse linked, historical, and unreleased changelog entries', () => {
  const releases = parseChangelog(`# Changelog

## Unreleased
### Added
- Pending entry.

## [1.2.3](https://example.com/releases/tag/v1.2.3) - 2026-08-18
### Fixed
- Fixed entry.
`);

  assert.equal(releases.length, 2);
  assert.equal(releases[0].isUnreleased, true);
  assert.equal(releases[0].itemCount, 1);
  assert.equal(releases[1].version, '1.2.3');
  assert.equal(releases[1].githubUrl, 'https://example.com/releases/tag/v1.2.3');
  assert.equal(releases[1].sections[0].title, '修复');
});

test('repository release notes expose the current version and detailed published history', () => {
  const notes = getReleaseNotes('0.5.0');
  const current = notes.releases.find((release) => release.isCurrent);
  const diagnosticRelease = notes.releases.find((release) => release.version === '0.4.4');
  const temporalGraphRelease = notes.releases.find((release) => release.version === '0.4.3');
  const baselineRelease = notes.releases.find((release) => release.version === '0.2.4');

  assert.equal(notes.currentVersion, '0.5.0');
  assert.ok(current);
  assert.ok(current.itemCount >= 10);
  assert.match(current.githubUrl, /releases\/tag\/v0\.5\.0$/);
  assert.ok(diagnosticRelease);
  assert.ok(diagnosticRelease.sections.some((section) => section.key === 'validation'));
  assert.match(temporalGraphRelease.githubUrl, /releases\/tag\/v0\.4\.3$/);
  assert.equal(baselineRelease.itemCount, 4);
});
