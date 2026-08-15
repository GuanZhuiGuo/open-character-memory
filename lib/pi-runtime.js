import { Agent } from '@earendil-works/pi-agent-core';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { streamSimple as streamProvider } from '@earendil-works/pi-ai/compat';
import { config } from './config.js';
import { generateText } from './providers/index.js';
import { redactSecrets, safeText } from './utils.js';

export const PI_AGENT_CORE_VERSION = '0.84.2';

const EMPTY_USAGE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
});

function providerSettings() {
  if (config.textProvider === 'ark') {
    return {
      api: 'openai-responses', provider: 'ark', baseUrl: config.ark.baseUrl,
      model: config.ark.textModel, apiKey: config.ark.apiKey
    };
  }
  if (config.textProvider === 'openai') {
    return {
      api: 'openai-responses', provider: 'openai', baseUrl: config.openai.baseUrl,
      model: config.openai.textModel, apiKey: config.openai.apiKey
    };
  }
  if (config.textProvider === 'anthropic') {
    return {
      api: 'anthropic-messages', provider: 'anthropic', baseUrl: config.anthropic.baseUrl,
      model: config.anthropic.textModel, apiKey: config.anthropic.apiKey,
      headers: { 'anthropic-version': config.anthropic.version }
    };
  }
  return {
    api: 'memory-agent-provider', provider: 'memory-agent-studio', baseUrl: '',
    model: config.mock.textModel, apiKey: ''
  };
}

function runtimeModel() {
  const settings = providerSettings();
  return {
    id: settings.model,
    name: `Memory Agent ${settings.provider} model`,
    api: settings.api,
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    reasoning: config.agentLoop.thinkingLevel !== 'off',
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
    ...(settings.headers ? { headers: settings.headers } : {})
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

function providerUsageFromPi(usage = EMPTY_USAGE) {
  return {
    inputTokens: Number(usage.input || 0),
    outputTokens: Number(usage.output || 0),
    cachedTokens: Number(usage.cacheRead || 0),
    cacheCreationTokens: Number(usage.cacheWrite || 0),
    totalTokens: Number(usage.totalTokens || 0)
  };
}

function contentText(content) {
  if (typeof content === 'string') return content;
  return (Array.isArray(content) ? content : [])
    .filter((item) => item?.type === 'text')
    .map((item) => item.text || '')
    .join('');
}

function toPiMessages(messages = [], model) {
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
        api: model.api,
        provider: model.provider,
        model: 'conversation_history',
        usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
        stopReason: 'stop',
        timestamp
      }];
    }
    return [];
  });
}

function compactValue(value, max = 1600) {
  try {
    return safeText(redactSecrets(JSON.stringify(value)), max);
  } catch {
    return safeText(String(value || ''), max);
  }
}

function compactRuntimeEvent(event, runtimeStartedAt, sequence) {
  const summary = {
    sequence,
    type: event.type,
    atMs: Math.max(0, Date.now() - runtimeStartedAt)
  };
  if ('message' in event && event.message?.role) summary.role = event.message.role;
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    summary.updateType = update.type;
    if (update.type === 'toolcall_end') summary.toolName = update.toolCall?.name || '';
  }
  if (event.type.startsWith('tool_execution_')) {
    summary.toolCallId = event.toolCallId;
    summary.toolName = event.toolName;
    if ('args' in event) summary.arguments = compactValue(event.args);
    if (event.type === 'tool_execution_update') summary.partialResult = compactValue(event.partialResult);
    if (event.type === 'tool_execution_end') {
      summary.isError = Boolean(event.isError);
      summary.result = compactValue(event.result, 2400);
    }
  }
  if (event.type === 'turn_end') summary.toolResultCount = event.toolResults?.length || 0;
  return summary;
}

function errorMessageStream(model, error, signal) {
  const stream = new AssistantMessageEventStream();
  const partial = {
    role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
    stopReason: signal?.aborted ? 'aborted' : 'error', errorMessage: error.message, timestamp: Date.now()
  };
  stream.push({ type: 'start', partial });
  stream.push({ type: 'error', reason: partial.stopReason, error: partial });
  stream.end();
  return stream;
}

function emitProviderResult(stream, partial, providerResult) {
  const text = String(providerResult.text || '');
  const toolCalls = Array.isArray(providerResult.toolCalls) ? providerResult.toolCalls : [];
  partial.provider = providerResult.provider || partial.provider;
  partial.model = providerResult.model || partial.model;
  partial.responseId = providerResult.responseId || undefined;
  partial.usage = usageFromProvider(providerResult.usage);
  if (text) {
    const contentIndex = partial.content.length;
    const textBlock = { type: 'text', text: '' };
    partial.content.push(textBlock);
    stream.push({ type: 'text_start', contentIndex, partial });
    textBlock.text = text;
    stream.push({ type: 'text_delta', contentIndex, delta: text, partial });
    stream.push({ type: 'text_end', contentIndex, content: text, partial });
  }
  for (const [index, requested] of toolCalls.entries()) {
    const contentIndex = partial.content.length;
    const toolCall = {
      type: 'toolCall',
      id: requested.id || `tool_call_${Date.now()}_${index}`,
      name: requested.name,
      arguments: requested.arguments && typeof requested.arguments === 'object' ? requested.arguments : {}
    };
    partial.content.push(toolCall);
    stream.push({ type: 'toolcall_start', contentIndex, partial });
    stream.push({
      type: 'toolcall_delta', contentIndex, delta: JSON.stringify(toolCall.arguments), partial
    });
    stream.push({ type: 'toolcall_end', contentIndex, toolCall, partial });
  }
  partial.stopReason = toolCalls.length ? 'toolUse' : 'stop';
  stream.push({ type: 'done', reason: partial.stopReason, message: partial });
  stream.end();
}

export async function runPiAgent({
  systemPrompt,
  stableSystemPrompt = '',
  dynamicSystemPrompt = '',
  messages,
  tools = [],
  temperature = 0.7,
  maxOutputTokens = 1200,
  cache = null,
  sessionId = ''
}) {
  const runtimeStartedAt = Date.now();
  const providerCalls = [];
  let providerResult = null;
  let toolCallCount = 0;
  let stoppedByLimit = '';
  const model = runtimeModel();
  const settings = providerSettings();

  function beginProviderCall(context, bridgeMode) {
    const startedAt = Date.now();
    const call = {
      sequence: providerCalls.length + 1,
      bridgeMode,
      status: 'running',
      requestAtMs: Math.max(0, startedAt - runtimeStartedAt),
      responseAtMs: null,
      durationMs: null,
      provider: config.textProvider,
      model: model.id,
      inputRoles: context.messages.map((message) => message.role),
      toolNames: (context.tools || []).map((tool) => tool.name),
      startedAt
    };
    providerCalls.push(call);
    return call;
  }

  function finishProviderCall(call, status, message = null, error = null) {
    const finishedAt = Date.now();
    call.status = status;
    call.responseAtMs = Math.max(0, finishedAt - runtimeStartedAt);
    call.durationMs = Math.max(0, finishedAt - call.startedAt);
    delete call.startedAt;
    if (message) {
      call.provider = message.provider || call.provider;
      call.model = message.model || call.model;
      call.responseId = message.responseId || '';
      call.stopReason = message.stopReason;
      call.usage = message.usage || { ...EMPTY_USAGE };
      call.outputTypes = (message.content || []).map((item) => item.type);
      providerResult = {
        text: contentText(message.content),
        provider: call.provider,
        model: call.model,
        usage: providerUsageFromPi(message.usage),
        cache: {
          mode: 'provider_managed_tool_loop',
          status: Number(message.usage?.cacheRead || 0) > 0 ? 'hit' : 'miss',
          cachedTokens: Number(message.usage?.cacheRead || 0),
          inputTokens: Number(message.usage?.input || 0)
        },
        responseId: message.responseId || ''
      };
    }
    if (error) call.error = safeText(error.message, 1000);
  }

  function nativeProviderStream(context, options) {
    const call = beginProviderCall(context, 'pi_native_tool_stream');
    let upstream;
    try {
      upstream = streamProvider(model, context, {
        apiKey: settings.apiKey,
        signal: options.signal,
        temperature: options.temperature ?? temperature,
        maxTokens: options.maxTokens ?? maxOutputTokens,
        reasoning: config.agentLoop.thinkingLevel === 'off' ? undefined : config.agentLoop.thinkingLevel,
        sessionId,
        timeoutMs: 60000
      });
    } catch (error) {
      finishProviderCall(call, options.signal?.aborted ? 'aborted' : 'error', null, error);
      return errorMessageStream(model, error, options.signal);
    }
    const stream = new AssistantMessageEventStream();
    void (async () => {
      let started = false;
      let terminal = false;
      try {
        for await (const event of upstream) {
          if (event.type === 'start') started = true;
          if (event.type === 'done') {
            terminal = true;
            finishProviderCall(call, 'success', event.message);
          } else if (event.type === 'error') {
            terminal = true;
            finishProviderCall(
              call, event.reason === 'aborted' ? 'aborted' : 'error', event.error,
              new Error(event.error?.errorMessage || '模型流执行失败')
            );
          }
          stream.push(event);
        }
        if (!terminal) throw new Error('模型流在终止事件前结束');
        stream.end();
      } catch (error) {
        finishProviderCall(call, options.signal?.aborted ? 'aborted' : 'error', null, error);
        const partial = {
          role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
          usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } },
          stopReason: options.signal?.aborted ? 'aborted' : 'error',
          errorMessage: error.message, timestamp: Date.now()
        };
        if (!started) stream.push({ type: 'start', partial });
        stream.push({ type: 'error', reason: partial.stopReason, error: partial });
        stream.end();
      }
    })();
    return stream;
  }

  function adapterProviderStream(context, options) {
    const call = beginProviderCall(context, 'memory_agent_provider_adapter');
    const stream = new AssistantMessageEventStream();
    const partial = {
      role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { ...EMPTY_USAGE, cost: { ...EMPTY_USAGE.cost } }, stopReason: 'pending', timestamp: Date.now()
    };
    stream.push({ type: 'start', partial });
    void (async () => {
      try {
        const providerMessages = context.messages.map((message) => ({
          role: message.role,
          content: contentText(message.content),
          ...(message.role === 'toolResult' ? {
            toolName: message.toolName, toolCallId: message.toolCallId, isError: message.isError
          } : {})
        }));
        providerResult = await generateText({
          systemPrompt: context.systemPrompt || systemPrompt,
          stableSystemPrompt,
          dynamicSystemPrompt,
          messages: providerMessages,
          tools: context.tools || [],
          temperature: options.temperature ?? temperature,
          maxOutputTokens: options.maxTokens ?? maxOutputTokens,
          cache
        });
        emitProviderResult(stream, partial, providerResult);
        finishProviderCall(call, 'success', partial);
      } catch (error) {
        partial.stopReason = options.signal?.aborted ? 'aborted' : 'error';
        partial.errorMessage = error.message;
        finishProviderCall(call, partial.stopReason, partial, error);
        stream.push({ type: 'error', reason: partial.stopReason, error: partial });
        stream.end();
      }
    })();
    return stream;
  }

  const streamFn = (_model, context, options = {}) => {
    if (config.textProvider !== 'mock' && (context.tools || []).length) {
      return nativeProviderStream(context, options);
    }
    return adapterProviderStream(context, options);
  };

  const lifecycle = [];
  const agent = new Agent({
    initialState: {
      systemPrompt,
      model,
      thinkingLevel: config.agentLoop.thinkingLevel,
      tools,
      messages: toPiMessages(messages, model)
    },
    streamFn,
    sessionId,
    toolExecution: config.agentLoop.toolExecution,
    beforeToolCall: async () => {
      toolCallCount += 1;
      if (toolCallCount <= config.agentLoop.maxToolCalls) return undefined;
      stoppedByLimit = `单次请求最多执行 ${config.agentLoop.maxToolCalls} 次工具调用`;
      return { block: true, reason: stoppedByLimit };
    },
    shouldStopAfterTurn: async ({ toolResults }) => {
      if (!toolResults.length || providerCalls.length < config.agentLoop.maxModelTurns) return false;
      stoppedByLimit = `单次请求最多进行 ${config.agentLoop.maxModelTurns} 次模型推理`;
      return true;
    }
  });
  const unsubscribe = agent.subscribe((event) => {
    lifecycle.push(compactRuntimeEvent(event, runtimeStartedAt, lifecycle.length + 1));
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
  const text = contentText(finalMessage.content).trim();
  if (!text) throw new Error(stoppedByLimit || '工具执行后，主模型未生成最终文本回复');
  const lastCall = providerCalls.at(-1) || {};
  return {
    ...(providerResult || {}),
    text,
    runtime: {
      name: 'pi-agent-core',
      version: PI_AGENT_CORE_VERSION,
      sessionId,
      loopPattern: config.agentLoop.pattern,
      thinkingLevel: config.agentLoop.thinkingLevel,
      lifecycle,
      eventCount: lifecycle.length,
      durationMs: Math.max(0, Date.now() - runtimeStartedAt),
      providerBridge: {
        name: 'memory-agent-provider',
        ...lastCall,
        requestCount: providerCalls.length,
        calls: providerCalls
      },
      toolLoopEnabled: tools.length > 0,
      exposedTools: tools.map((tool) => tool.name),
      toolCallCount,
      stoppedByLimit,
      toolExecution: config.agentLoop.toolExecution,
      toolBoundary: 'unlocked capabilities resolved server-side; Pi selects and executes exposed tools'
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
        loopPattern: 'single_model_call', toolLoopEnabled: false,
        capabilitiesSkipped: (options.tools || []).map((tool) => tool.name),
        toolBoundary: 'legacy runtime does not execute dynamic capabilities'
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
    loopPattern: config.agentRuntime === 'pi' ? config.agentLoop.pattern : 'single_model_call',
    thinkingLevel: config.agentLoop.thinkingLevel,
    toolExecution: config.agentLoop.toolExecution,
    maxToolCalls: config.agentLoop.maxToolCalls,
    maxModelTurns: config.agentLoop.maxModelTurns,
    statefulTurnLoop: config.agentRuntime === 'pi',
    lifecycleEvents: config.agentRuntime === 'pi',
    providerBridge: 'memory-agent-provider + pi-ai native tool stream',
    toolLoopEnabled: config.agentRuntime === 'pi' && config.capabilityRuntime.enabled,
    toolExposure: 'dynamic_per_turn_from_unlocked_props',
    existingFeaturesPreserved: true
  };
}
