import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const changelogPath = path.join(projectDir, 'CHANGELOG.md');

const SECTION_LABELS = {
  Added: '新增',
  Changed: '调整',
  Fixed: '修复',
  Removed: '移除',
  Security: '安全',
  Validation: '验证'
};

const RELEASE_HEADING = /^##\s+(?:\[v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\]\((https?:\/\/[^)]+)\)|v?([0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?))(?:\s+-\s+(\d{4}-\d{2}-\d{2}))?\s*$/;

function finishSection(release, section) {
  if (release && section?.items.length) release.sections.push(section);
}

function finishRelease(releases, release, section) {
  if (!release) return;
  finishSection(release, section);
  release.itemCount = release.sections.reduce((total, item) => total + item.items.length, 0);
  release.summary = release.sections.flatMap((item) => item.items)[0] || '';
  releases.push(release);
}

export function parseChangelog(markdown) {
  const releases = [];
  let release = null;
  let section = null;

  for (const line of String(markdown || '').split(/\r?\n/)) {
    if (/^##\s+Unreleased\s*$/i.test(line)) {
      finishRelease(releases, release, section);
      release = {
        version: 'unreleased', date: '', githubUrl: '', isUnreleased: true, sections: []
      };
      section = null;
      continue;
    }

    const releaseMatch = line.match(RELEASE_HEADING);
    if (releaseMatch) {
      finishRelease(releases, release, section);
      release = {
        version: releaseMatch[1] || releaseMatch[3],
        date: releaseMatch[4] || '',
        githubUrl: releaseMatch[2] || '',
        isUnreleased: false,
        sections: []
      };
      section = null;
      continue;
    }

    const sectionMatch = line.match(/^###\s+(.+?)\s*$/);
    if (release && sectionMatch) {
      finishSection(release, section);
      const sourceTitle = sectionMatch[1];
      section = {
        key: sourceTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title: SECTION_LABELS[sourceTitle] || sourceTitle,
        sourceTitle,
        items: []
      };
      continue;
    }

    const itemMatch = line.match(/^[-*]\s+(.+?)\s*$/);
    if (release && itemMatch) {
      section ||= {
        key: 'changed', title: '变更', sourceTitle: 'Changed', items: []
      };
      section.items.push(itemMatch[1]);
      continue;
    }

    if (release && section?.items.length && /^\s{2,}\S/.test(line)) {
      section.items[section.items.length - 1] += ` ${line.trim()}`;
    }
  }

  finishRelease(releases, release, section);
  return releases;
}

export function getReleaseNotes(currentVersion) {
  const releases = parseChangelog(fs.readFileSync(changelogPath, 'utf8'))
    .map((release) => ({
      ...release,
      isCurrent: release.version === currentVersion
    }));
  return {
    currentVersion,
    source: 'CHANGELOG.md',
    repositoryUrl: 'https://github.com/GuanZhuiGuo/open-character-memory',
    releasesUrl: 'https://github.com/GuanZhuiGuo/open-character-memory/releases',
    releases
  };
}
