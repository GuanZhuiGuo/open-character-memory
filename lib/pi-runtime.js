import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { config } from './config.js';
import { generateText } from './providers/index.js';

export const PI_AGENT_CORE_VERSION = '0.84.2';

const EMPTY_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
});

function runtimeModel() {
  return {
    id: 'configured_text_model',
    name: 'Memory Agent configured text model',
    api: 'memory-agent-provider',
    provider: 'memory-agent-studio',
    baseUrl: '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096
  };
}

function usageFromProvider(usage = {}) {
  const input = Number(usage.inputTokens || 0);
  const output = Number(usage.outputTokens || 0);
  const cacheRead = Number(usage.cachedTokens || 0);
  const cacheWrite = Number(usage.cacheCreationTokens || 0);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: Number(usage.totalTokens || input + output),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
  };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text || '')
    .join('');
}

function toPiMessages(messages = []) {
  let timestamp = Date.now() - messages.length * 10;
  return messages.flatMap((message) => {
    timestamp += 10;
    if (message.role === 'user') {
      return [{ role: 'user', content: String(message.content || ''), timestamp }];
    }
    if (message.role === 'assistant') {
      return [{
        role: 'assistant',
        content: [{ type: 'text', text: String(message.content || '') }],
        api: 'memory-agent-provider',
        provider: 'memory-agent-studio',
        model: 'conversation_history',
        usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
        stopReason: 'stop',
        timestamp
      }];
    }
    return [];
  });
}

function compactRuntimeEvent(event) {
  const summary = { type: event.type };
  if ('message' in event && event.message?.role) summary.role = event.message.role;
  if (event.type === 'message_update') summary.updateType = event.assistantMessageEvent.type;
  if (event.type.startsWith('tool_execution_')) summary.toolName = event.toolName;
  return summary;
}

export async function runPiAgent({
  systemPrompt,
  stableSystemPrompt = '',
  dynamicSystemPrompt = '',
  messages,
  temperature = 0.7,
  maxOutputTokens = 1200,
  cache = null,
  sessionId = ''
}) {
  let providerResult = null;
  const model = runtimeModel();
  const streamFn = (_model, context, options = {}) => {
    const stream = new AssistantMessageEventStream();
    const partial = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
      stopReason: 'pending',
      timestamp: Date.now()
    };
    stream.push({ type: 'start', partial });
    void (async () => {
      try {
        const providerMessages = context.messages.map((message) => ({
          role: message.role === 'toolResult' ? 'user' : message.role,
          content: contentText(message.content)
        }));
        providerResult = await generateText({
          systemPrompt: context.systemPrompt || systemPrompt,
          stableSystemPrompt,
          dynamicSystemPrompt,
          messages: providerMessages,
          temperature: options.temperature ?? temperature,
          maxOutputTokens: options.maxTokens ?? maxOutputTokens,
          cache
        });
        const text = String(providerResult.text || '');
        partial.content = [{ type: 'text', text: '' }];
        partial.provider = providerResult.provider || model.provider;
        partial.model = providerResult.model || model.id;
        partial.responseId = providerResult.responseId || undefined;
        partial.usage = usageFromProvider(providerResult.usage);
        stream.push({ type: 'text_start', contentIndex: 0, partial });
        partial.content[0].text = text;
        stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial });
        stream.push({ type: 'text_end', contentIndex: 0, content: text, partial });
        partial.stopReason = 'stop';
        stream.push({ type: 'done', reason: 'stop', message: partial });
        stream.end();
      } catch (error) {
        partial.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        partial.errorMessage = error.message;
        stream.push({ type: 'error', reason: partial.stopReason, error: partial });
        stream.end();
      }
    })();
    return stream;
  };

  const lifecycle = [];
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: 'off',
      tools: [],
      messages: toPiMessages(messages)
    },
    streamFn,
    sessionId,
    toolExecution: 'parallel'
  });
  const unsubscribe = agent.subscribe((event) => {
    lifecycle.push(compactRuntimeEvent(event));
  });
  try {
    await agent.continue();
  } finally {
    unsubscribe();
  }
  const finalMessage = [...agent.state.messages].reverse().find((message) => message.role === 'assistant');
  if (!finalMessage || finalMessage.stopReason === 'error' || finalMessage.stopReason === 'aborted') {
    throw new Error(finalMessage?.errorMessage || 'Pi Agent Runtime 未生成回复');
  }
  return {
    ...(providerResult || {}),
    text: contentText(finalMessage.content),
    runtime: {
      name: 'pi-agent-core',
      version: PI_AGENT_CORE_VERSION,
      sessionId,
      lifecycle,
      eventCount: lifecycle.length,
      toolLoopEnabled: false,
      toolBoundary: 'existing triggers and props remain server-side'
    }
  };
}

export async function runAgentModel(options) {
  if (config.agentRuntime === 'legacy') {
    const result = await generateText(options);
    return {
      ...result,
      runtime: {
        name: 'legacy', version: '', lifecycle: [], eventCount: 0,
        toolLoopEnabled: false, toolBoundary: 'server-side'
      }
    };
  }
  return runPiAgent(options);
}

export function getAgentRuntimeStatus() {
  return {
    mode: config.agentRuntime,
    name: config.agentRuntime === 'pi' ? 'pi-agent-core' : 'legacy',
    version: config.agentRuntime === 'pi' ? PI_AGENT_CORE_VERSION : '',
    statefulTurnLoop: config.agentRuntime === 'pi',
    lifecycleEvents: config.agentRuntime === 'pi',
    providerBridge: 'memory-agent-provider',
    toolLoopEnabled: false,
    existingFeaturesPreserved: true
  };
}
