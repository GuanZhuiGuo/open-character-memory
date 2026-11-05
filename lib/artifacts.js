import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { db } from './db.js';
import { json, nowIso, safeText, uid } from './utils.js';

const MIME_BY_EXTENSION = Object.freeze({
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
});

const ALLOWED_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));
const UPLOAD_EXTENSIONS = Object.freeze(['.txt', '.md', '.html', '.json', '.csv', '.pdf', '.docx']);
export const MAX_ARTIFACTS_PER_MESSAGE = 4;

function normalizedFileName(value) {
  const name = path.basename(safeText(value, 160).normalize('NFKC').trim())
    .replace(/[\u0000-\u001f\u007f]/g, '').replace(/[\\/:*?"<>|]/g, '_');
  if (!name || name === '.' || name === '..') throw new Error('文件名无效');
  const extension = path.extname(name).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`不支持的文件类型：${extension || '无扩展名'}`);
  }
  return name;
}

function scopedDirectory(userId) {
  const scope = crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 24);
  return path.join(config.sandboxRuntime.artifactRoot, scope);
}

export function artifactMimeType(fileName, supplied = '') {
  const expected = MIME_BY_EXTENSION[path.extname(fileName).toLowerCase()] || 'application/octet-stream';
  const normalized = String(supplied || '').split(';')[0].trim().toLowerCase();
  if (!normalized || normalized === 'application/octet-stream') return expected;
  if (expected.startsWith(normalized) || normalized.startsWith(expected.split(';')[0])) return expected;
  throw new Error('文件扩展名与 MIME 类型不一致');
}

export function saveArtifact({
  userId,
  agentId = '',
  conversationId = '',
  traceId = '',
  subagentTaskId = '',
  sourceType = 'generated',
  fileName,
  mimeType = '',
  sandboxPath = '',
  bytes,
  metadata = {}
}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buffer.length) throw new Error('不能保存空文件');
  if (buffer.length > config.sandboxRuntime.maxArtifactBytes) {
    throw new Error(`文件超过 ${Math.ceil(config.sandboxRuntime.maxArtifactBytes / 1024 / 1024)}MB 上限`);
  }
  const safeName = normalizedFileName(fileName);
  const resolvedMime = artifactMimeType(safeName, mimeType);
  const id = uid('artifact');
  const directory = scopedDirectory(userId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const storagePath = path.join(directory, `${id}_${safeName}`);
  fs.writeFileSync(storagePath, buffer, { mode: 0o600 });
  const timestamp = nowIso();
  db.prepare(`INSERT INTO artifacts
    (id, user_id, agent_id, conversation_id, trace_id, subagent_task_id, source_type,
     file_name, storage_path, sandbox_path, mime_type, size_bytes, content_hash, status,
     metadata_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'available', ?, ?)`).run(
    id, userId, agentId, conversationId, traceId, subagentTaskId, sourceType,
    safeName, storagePath, safeText(sandboxPath, 500), resolvedMime, buffer.length,
    crypto.createHash('sha256').update(buffer).digest('hex'), json(metadata), timestamp
  );
  return publicArtifact(db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id));
}

export function publicArtifact(row) {
  if (!row) return null;
  return {
    id: row.id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: Number(row.size_bytes || 0),
    sourceType: row.source_type,
    sandboxPath: row.sandbox_path || '',
    status: row.status,
    createdAt: row.created_at,
    downloadUrl: `${config.basePath}/api/artifacts/${encodeURIComponent(row.id)}/download`
  };
}

export function getArtifact(artifactId) {
  return db.prepare("SELECT * FROM artifacts WHERE id = ? AND status = 'available'").get(artifactId) || null;
}

export function getArtifactsForUser(artifactIds, userId) {
  const ids = [...new Set((artifactIds || []).map(String).filter(Boolean))].slice(0, 8);
  if (!ids.length) return [];
  const statement = db.prepare(`SELECT * FROM artifacts
    WHERE id = ? AND user_id = ? AND status = 'available'`);
  return ids.map((id) => statement.get(id, userId)).filter(Boolean);
}

export function readArtifactBytes(row) {
  if (!row || !row.storage_path) throw new Error('产物不存在');
  const resolved = path.resolve(row.storage_path);
  const root = path.resolve(config.sandboxRuntime.artifactRoot);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error('产物路径越界');
  return fs.readFileSync(resolved);
}

export function artifactUploadContract() {
  return {
    maxBytes: config.sandboxRuntime.maxArtifactBytes,
    maxFilesPerMessage: MAX_ARTIFACTS_PER_MESSAGE,
    allowedExtensions: [...UPLOAD_EXTENSIONS]
  };
}
