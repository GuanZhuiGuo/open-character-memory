import fs from 'node:fs';
import { readZipEntries } from './zip.js';

function identifier(value, label) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{2,59}$/.test(normalized)) {
    throw new Error(`${label}需为 3-60 位小写字母、数字、下划线或短横线`);
  }
  return normalized;
}

function objectSchema(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}必须是 JSON Schema 对象`);
  const schema = structuredClone(value);
  schema.type ||= 'object';
  schema.properties ||= {};
  if (schema.type !== 'object' || typeof schema.properties !== 'object' || Array.isArray(schema.properties)) {
    throw new Error(`${label}顶层必须是 object`);
  }
  if (JSON.stringify(schema).length > 30000) throw new Error(`${label}过大`);
  return schema;
}

function validateSkillTool(tool, index) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error(`Skill tools[${index}] 无效`);
  const execution = tool.execution || {};
  if (!['template', 'http'].includes(execution.type)) {
    throw new Error(`Skill tools[${index}].execution.type 仅支持 template 或 http`);
  }
  if (execution.type === 'template' && typeof execution.template !== 'string') {
    throw new Error(`Skill tools[${index}] 缺少 execution.template`);
  }
  if (execution.type === 'http' && typeof execution.url !== 'string') {
    throw new Error(`Skill tools[${index}] 缺少 execution.url`);
  }
  return {
    ...tool,
    name: identifier(tool.name, `Skill tools[${index}].name`),
    description: String(tool.description || '').trim().slice(0, 1000),
    input_schema: objectSchema(tool.input_schema || tool.parameters || {}, `Skill tools[${index}].input_schema`),
    execution: structuredClone(execution),
    confirmation: String(tool.confirmation || 'none'),
    read_only: tool.read_only !== false
  };
}

export function parseSkillPackage(buffer, expectedKey = '') {
  const entries = readZipEntries(buffer);
  const manifestEntry = entries.get('skill.json');
  if (!manifestEntry) throw new Error('Skill ZIP 缺少 skill.json');
  let manifest;
  try {
    manifest = JSON.parse(manifestEntry.toString('utf8'));
  } catch {
    throw new Error('Skill ZIP 的 skill.json 不是有效 JSON');
  }
  if (manifest?.schema_version !== 'memory-agent.skill/v1') {
    throw new Error('Skill schema_version 必须是 memory-agent.skill/v1');
  }
  const key = identifier(manifest.key, 'Skill key');
  if (expectedKey && key !== expectedKey) throw new Error(`Skill key ${key} 与道具 Key ${expectedKey} 不一致`);
  const entry = String(manifest.entry || 'SKILL.md');
  const instructionsEntry = entries.get(entry);
  if (!instructionsEntry) throw new Error(`Skill ZIP 缺少入口文件 ${entry}`);
  const instructions = instructionsEntry.toString('utf8').trim();
  if (!instructions || instructions.length > 100000) throw new Error('Skill 入口说明为空或过大');
  const tools = Array.isArray(manifest.tools) ? manifest.tools.map(validateSkillTool) : [];
  if (tools.length > 12) throw new Error('Skill 最多声明 12 个工具');
  return {
    manifest: {
      ...manifest,
      key,
      name: String(manifest.name || key).slice(0, 100),
      version: String(manifest.version || '1.0.0').slice(0, 30),
      entry,
      tools
    },
    instructions,
    files: [...entries.keys()]
  };
}

export function loadSkillPackage(storagePath, expectedKey = '') {
  if (!storagePath || !fs.existsSync(storagePath)) throw new Error('Skill 包文件不存在');
  return parseSkillPackage(fs.readFileSync(storagePath), expectedKey);
}
