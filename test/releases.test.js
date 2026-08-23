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
### Resolved Bad Cases
- **Missing evidence**: the answer no longer guesses when no evidence exists.
`);

  assert.equal(releases.length, 2);
  assert.equal(releases[0].isUnreleased, true);
  assert.equal(releases[0].itemCount, 1);
  assert.equal(releases[1].version, '1.2.3');
  assert.equal(releases[1].githubUrl, 'https://example.com/releases/tag/v1.2.3');
  assert.equal(releases[1].sections[0].title, '修复');
  assert.equal(releases[1].badCaseCount, 1);
  assert.equal(releases[1].sections[1].key, 'resolved-bad-cases');
  assert.equal(releases[1].sections[1].title, '解决的 Bad Case');
});

test('repository release notes expose the current version and detailed published history', () => {
  const notes = getReleaseNotes('0.6.0');
  const current = notes.releases.find((release) => release.isCurrent);
  const diagnosticRelease = notes.releases.find((release) => release.version === '0.4.4');
  const temporalGraphRelease = notes.releases.find((release) => release.version === '0.4.3');
  const baselineRelease = notes.releases.find((release) => release.version === '0.2.4');

  assert.equal(notes.currentVersion, '0.6.0');
  assert.ok(current);
  assert.ok(current.itemCount >= 10);
  assert.match(current.githubUrl, /releases\/tag\/v0\.6\.0$/);
  assert.ok(diagnosticRelease);
  assert.ok(diagnosticRelease.sections.some((section) => section.key === 'validation'));
  assert.match(temporalGraphRelease.githubUrl, /releases\/tag\/v0\.4\.3$/);
  assert.ok(baselineRelease.itemCount >= 4);
  assert.ok(notes.releases.every((release) => release.badCaseCount > 0));
});
