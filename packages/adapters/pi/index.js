import { createMemoryMiddleware } from '@open-character-memory/adapter-generic';

export function createPiMemoryAdapter(options) {
  const middleware = createMemoryMiddleware(options);
  return Object.freeze({
    async prepareTurn(context) {
      const prepared = await middleware.beforeModel(context);
      return {
        memory: prepared.contextPack,
        systemContext: prepared.contextText,
        tools: prepared.tools
      };
    },

    async commitTurn(context) {
      return middleware.afterModel(context);
    }
  });
}
