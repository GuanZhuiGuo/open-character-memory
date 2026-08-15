import { inflateRawSync } from 'node:zlib';

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff];
  return (value ^ 0xffffffff) >>> 0;
}

export function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(String(entry.name).replace(/^\/+/, ''), 'utf8');
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content), 'utf8');
    const checksum = crc32(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(content.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    localParts.push(localHeader, name, content);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(content.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(name.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, name);
    offset += localHeader.length + name.length + content.length;
  }

  const centralSize = centralParts.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function zipEntryName(value) {
  const name = String(value || '');
  if (!name || name.includes('\\') || name.startsWith('/') || name.includes('\0')) {
    throw new Error('ZIP 包含无效路径');
  }
  const parts = name.split('/');
  if (parts.some((part) => part === '..' || part === '.')) throw new Error('ZIP 包含路径穿越');
  return name;
}

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP 缺少中心目录');
}

export function readZipEntries(buffer, {
  maxEntries = 32,
  maxEntryBytes = 512 * 1024,
  maxTotalBytes = 2 * 1024 * 1024
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) throw new Error('ZIP 文件无效');
  const endOffset = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (entryCount > maxEntries) throw new Error(`ZIP 文件数不能超过 ${maxEntries}`);
  if (centralOffset + centralSize > endOffset) throw new Error('ZIP 中心目录越界');

  const entries = new Map();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('ZIP 中心目录损坏');
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = zipEntryName(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'));
    cursor += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new Error('Skill ZIP 不支持加密文件');
    if (![0, 8].includes(method)) throw new Error(`Skill ZIP 不支持压缩方法 ${method}`);
    if ([compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) throw new Error('Skill ZIP 不支持 ZIP64');
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0o170000) === 0o120000) throw new Error('Skill ZIP 不允许符号链接');
    if (name.endsWith('/')) continue;
    if (uncompressedSize > maxEntryBytes) throw new Error(`Skill ZIP 单文件超过 ${maxEntryBytes} 字节`);
    totalBytes += uncompressedSize;
    if (totalBytes > maxTotalBytes) throw new Error(`Skill ZIP 解压后超过 ${maxTotalBytes} 字节`);
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Skill ZIP 本地文件头损坏');
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    if (dataOffset + compressedSize > buffer.length) throw new Error('Skill ZIP 压缩数据越界');
    const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
    const content = method === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: maxEntryBytes });
    if (content.length !== uncompressedSize || crc32(content) !== checksum) throw new Error(`Skill ZIP 文件校验失败：${name}`);
    if (entries.has(name)) throw new Error(`Skill ZIP 包含重复文件：${name}`);
    entries.set(name, content);
  }
  return entries;
}
