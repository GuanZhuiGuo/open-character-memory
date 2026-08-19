import { contextText } from '@open-character-memory/sdk';

function scopeFor(configured, context) {
  return typeof configured === 'function' ? configured(context) : configured;
}

export function createMemoryMiddleware({
  client,
  scope,
  extractionMode = 'async',
  exposeReadTools = true
}) {
  if (!client?.scope) throw new TypeError('A MemoryClient instance is required');
  if (!scope) throw new TypeError('A scope object or resolver is required');
  return Object.freeze({
    async beforeModel(context) {
      const scoped = client.scope(scopeFor(scope, context));
      const pack = await scoped.recall({
        query: context.query ?? context.userMessage?.content ?? context.userText,
        options: context.memoryOptions || {}
      });
      return {
        contextPack: pack,
        contextText: contextText(pack),
        contextBlocks: pack.blocks,
        tools: exposeReadTools ? scoped.readTools() : []
      };
    },

    async afterModel(context) {
      const scoped = client.scope(scopeFor(scope, context));
      const userMessage = context.userMessage || { role: 'user', content: context.userText };
      const assistantMessage = context.assistantMessage || {
        role: 'assistant', content: context.assistantText ?? context.outputText
      };
      return scoped.observe({
        idempotencyKey: context.idempotencyKey || context.turnId,
        threadId: context.threadId || 'default',
        extractionMode: context.extractionMode || extractionMode,
        messages: [userMessage, assistantMessage],
        metadata: context.memoryMetadata || {}
      });
    }
  });
}
