#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { MemoryClient } from '@open-character-memory/sdk';

function scopeFromEnvironment() {
  try {
    return JSON.parse(process.env.MEMORY_SCOPE_JSON || '{}');
  } catch {
    throw new Error('MEMORY_SCOPE_JSON must be valid JSON');
  }
}

export function createMemoryMcpServer({ client, scope }) {
  const scoped = client.scope(scope);
  const server = new McpServer({ name: 'open-character-memory', version: '0.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Read-only active long-term memory. The application has locked tenant and subject scope.'
  });
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };

  server.registerTool('memory_search', {
    title: 'Search long-term memory',
    description: 'Search current active memory when existing context is insufficient. The model cannot change scope.',
    inputSchema: z.object({
      query: z.string().min(1).max(12000),
      alternative_queries: z.array(z.string().min(1).max(1000)).max(2).optional(),
      reason: z.string().max(500).optional()
    }),
    annotations
  }, async (input) => {
    const tool = scoped.readTools().find((item) => item.name === 'memory_search');
    const result = await tool.execute('mcp_memory_search', input);
    return {
      content: result.content,
      structuredContent: result.details.structuredContent
    };
  });

  server.registerTool('memory_expand', {
    title: 'Expand memory evidence',
    description: 'Expand known event IDs or entity names into current claims and graph evidence.',
    inputSchema: z.object({
      event_ids: z.array(z.string().min(1).max(160)).max(8).optional(),
      entity_names: z.array(z.string().min(1).max(160)).max(8).optional(),
      graph_hops: z.number().int().min(0).max(2).optional(),
      reason: z.string().max(500).optional()
    }).refine((value) => Boolean(value.event_ids?.length || value.entity_names?.length), {
      message: 'event_ids or entity_names is required'
    }),
    annotations
  }, async (input) => {
    const tool = scoped.readTools().find((item) => item.name === 'memory_expand');
    const result = await tool.execute('mcp_memory_expand', input);
    return {
      content: result.content,
      structuredContent: result.details.structuredContent
    };
  });
  return server;
}

export function serveMemoryMcpFromEnvironment() {
  const baseUrl = process.env.MEMORY_SERVICE_URL || 'http://127.0.0.1:4173';
  const client = new MemoryClient({
    baseUrl,
    apiKey: process.env.MEMORY_SERVICE_API_KEY || ''
  });
  const scope = scopeFromEnvironment();
  return serveStdio(() => createMemoryMcpServer({ client, scope }), {
    onerror: (error) => process.stderr.write(`[open-character-memory-mcp] ${error.message}\n`)
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) serveMemoryMcpFromEnvironment();
