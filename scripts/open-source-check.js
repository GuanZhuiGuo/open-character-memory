import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const projectRoot = path.resolve(import.meta.dirname, '..');
const requiredFiles = [
  'LICENSE', 'README.md', 'README.en.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'SECURITY.md',
  'Dockerfile', 'compose.yaml', '.env.example', '.github/workflows/ci.yml'
];
const failures = [];

for (const filename of requiredFiles) {
  if (!fs.existsSync(path.join(projectRoot, filename))) failures.push(`缺少 ${filename}`);
}

let candidates = [];
try {
  candidates = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: projectRoot,
    encoding: 'utf8'
  }).trim().split(/\r?\n/).filter(Boolean);
} catch (error) {
  failures.push(`无法读取 Git 文件列表：${error.message}`);
}

const textExtensions = new Set(['.js', '.json', '.md', '.yml', '.yaml', '.html', '.css', '.example', '.txt', '']);
const secretPatterns = [
  { name: 'Ark API key', regex: /ark-[0-9a-f]{8,}(?:-[0-9a-f]{4,}){2,}/i },
  { name: 'OpenAI API key', regex: /sk-[a-z0-9_-]{24,}/i },
  { name: 'Private key', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

for (const relativePath of candidates) {
  if (relativePath === '.env.local' || relativePath.startsWith('data/') || relativePath.startsWith('output/')) {
    failures.push(`不应进入 Git：${relativePath}`);
    continue;
  }
  const absolutePath = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) continue;
  const extension = path.extname(relativePath);
  if (!textExtensions.has(extension) || fs.statSync(absolutePath).size > 1_000_000) continue;
  const content = fs.readFileSync(absolutePath, 'utf8');
  for (const pattern of secretPatterns) {
    if (pattern.regex.test(content)) failures.push(`${relativePath} 疑似包含 ${pattern.name}`);
  }
}

if (failures.length) {
  console.error('Open-source preflight failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exitCode = 1;
} else {
  console.log(`Open-source preflight passed (${candidates.length} files checked).`);
}
