import { config } from '../config.js';
import { localEmbedding } from '../utils.js';
import * as anthropic from './anthropic.js';
import * as ark from './ark.js';
import * as mock from './mock.js';
import * as openai from './openai.js';

const providers = { ark, openai, anthropic, mock };

function providerFor(name) {
  const provider = providers[name];
  if (!provider) throw new Error(`Provider ${name} 不可用`);
  return provider;
}

export async function generateText(options) {
  return providerFor(config.textProvider).generateText(options);
}

export async function embedText(text) {
  const provider = providerFor(config.embeddingProvider);
  if (!provider.embedText) {
    return {
      vector: localEmbedding(text),
      model: 'local-hash-embedding-v1',
      provider: 'local',
      fallback: true,
      fallbackReason: `${config.embeddingProvider} 不提供 Embedding API`
    };
  }
  try {
    return await provider.embedText(text);
  } catch (error) {
    return {
      vector: localEmbedding(text),
      model: 'local-hash-embedding-v1',
      provider: 'local',
      fallback: true,
      fallbackReason: error.message
    };
  }
}

export function configuredModels() {
  const text = config[config.textProvider]?.textModel || config.mock.textModel;
  const embedding = config[config.embeddingProvider]?.embeddingModel || config.mock.embeddingModel;
  return { textProvider: config.textProvider, embeddingProvider: config.embeddingProvider, text, embedding };
}

export async function checkModelHealth() {
  const embedding = await embedText('记忆系统健康检查');
  const models = configuredModels();
  return {
    configured: config.textProvider === 'mock' || Boolean(config[config.textProvider]?.apiKey),
    ...models,
    embeddingModel: embedding.model,
    embeddingDimensions: embedding.vector.length,
    embeddingFallback: Boolean(embedding.fallback),
    fallbackReason: embedding.fallbackReason || ''
  };
}
