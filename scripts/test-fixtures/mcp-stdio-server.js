import readline from 'node:readline';

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return;
  if (message.method === 'initialize') {
    send(message.id, {
      protocolVersion: message.params?.protocolVersion || '2025-03-26',
      capabilities: { tools: {} },
      serverInfo: { name: 'memory-agent-test-mcp', version: '1.0.0' }
    });
    return;
  }
  if (message.method === 'tools/list') {
    send(message.id, {
      tools: [{
        name: 'lookup_memory',
        title: '查找测试记忆',
        description: '返回测试记忆结果。',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query']
        }
      }]
    });
    return;
  }
  if (message.method === 'tools/call') {
    send(message.id, {
      content: [{ type: 'text', text: `MCP_RESULT:${message.params?.arguments?.query || ''}` }],
      structuredContent: { matched: true }
    });
    return;
  }
  if (message.method === 'ping') {
    send(message.id, {});
    return;
  }
  process.stdout.write(`${JSON.stringify({
    jsonrpc: '2.0', id: message.id,
    error: { code: -32601, message: `Method not found: ${message.method}` }
  })}\n`);
});
