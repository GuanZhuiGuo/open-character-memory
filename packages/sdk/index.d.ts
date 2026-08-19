export interface MemoryScope {
  tenantId?: string;
  subjectId: string;
  agentId: string;
  spaceId?: string;
  branchId?: string;
}

export interface MemoryMessage {
  id?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ContextBlock {
  kind: string;
  content: string;
  priority: number;
}

export interface ContextPack {
  contractVersion: string;
  query: string;
  scope: Required<MemoryScope>;
  generatedAt: string;
  blocks: ContextBlock[];
  facts: Record<string, unknown>[];
  events: Record<string, unknown>[];
  relations: Record<string, unknown>[];
  provenance: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
}

export interface MemoryCapabilities {
  contractVersion: string;
  service: string;
  mode: string;
  operations: Array<'observe' | 'recall' | 'expand' | 'mutate' | 'forget'>;
  extractionModes: Array<'async' | 'sync' | 'none'>;
  features: Record<string, boolean>;
  scope: {
    fields: string[];
    tenantId: string;
    serverAuthoritative: boolean;
  };
}

export interface MemoryJobReceipt {
  id: string;
  status: 'pending' | 'running' | 'succeeded' | 'dead';
  attempts: number;
  availableAt: string;
  startedAt: string;
  completedAt: string;
  result: Record<string, unknown>;
  error: string;
}

export interface ObservationReceipt {
  contractVersion: string;
  id: string;
  idempotencyKey: string;
  status: string;
  duplicate: boolean;
  scope: Required<MemoryScope>;
  threadId: string;
  extractionMode: 'async' | 'sync' | 'none';
  evidenceIds: string[];
  result: Record<string, unknown>;
  error: string;
  job: MemoryJobReceipt | null;
  createdAt: string;
  updatedAt: string;
}

export interface OperationReceipt {
  contractVersion: string;
  id: string;
  idempotencyKey: string;
  operationType: 'mutate' | 'forget';
  status: string;
  duplicate: boolean;
  result: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface MutationCommon {
  scope: MemoryScope;
  idempotencyKey: string;
  reason?: string;
  sourceEvidenceId?: string;
}

export type MemoryMutationInput = MutationCommon & ({
  recordType: 'structured';
  operation?: 'set' | 'merge' | 'delta';
  payload: { key: string; value?: unknown; delta?: number };
} | {
  recordType: 'event';
  operation?: 'create' | 'enrich' | 'update' | 'supersede' | 'retract';
  payload: Record<string, unknown> & { event_key: string };
});

interface ForgetCommon {
  scope: MemoryScope;
  idempotencyKey: string;
  mode?: 'retract' | 'erase';
  reason?: string;
}

export type MemoryForgetInput = ForgetCommon & ({
  recordType: 'structured';
  key: string;
} | {
  recordType: 'event';
  recordId: string;
});

type WithoutScope<T> = T extends unknown ? Omit<T, 'scope'> : never;

export class MemoryClientError extends Error {
  status: number;
  code: string;
  details: unknown;
}

export class MemoryClient {
  constructor(options: {
    baseUrl: string;
    apiKey?: string;
    fetch?: typeof globalThis.fetch;
    timeoutMs?: number;
    headers?: Record<string, string>;
  });
  capabilities(): Promise<MemoryCapabilities>;
  observe(input: {
    scope: MemoryScope;
    idempotencyKey: string;
    threadId?: string;
    extractionMode?: 'async' | 'sync' | 'none';
    messages: MemoryMessage[];
    metadata?: Record<string, unknown>;
  }): Promise<ObservationReceipt>;
  recall(input: { scope: MemoryScope; query: string; options?: Record<string, unknown> }): Promise<ContextPack>;
  expand(input: {
    scope: MemoryScope;
    eventIds?: string[];
    entityNames?: string[];
    graphHops?: number;
  }): Promise<Record<string, unknown>>;
  mutate(input: MemoryMutationInput): Promise<OperationReceipt>;
  forget(input: MemoryForgetInput): Promise<OperationReceipt>;
  getJob(jobId: string, scope: MemoryScope): Promise<MemoryJobReceipt & { contractVersion: string }>;
  waitForJob(jobId: string, scope: MemoryScope, options?: { intervalMs?: number; timeoutMs?: number }): Promise<MemoryJobReceipt & { contractVersion: string }>;
  scope(scope: MemoryScope): ScopedMemoryClient;
}

export class ScopedMemoryClient {
  readonly scope: Required<MemoryScope>;
  observe(input: Omit<Parameters<MemoryClient['observe']>[0], 'scope'>): ReturnType<MemoryClient['observe']>;
  recall(input: Omit<Parameters<MemoryClient['recall']>[0], 'scope'>): ReturnType<MemoryClient['recall']>;
  expand(input: Omit<Parameters<MemoryClient['expand']>[0], 'scope'>): ReturnType<MemoryClient['expand']>;
  mutate(input: WithoutScope<MemoryMutationInput>): ReturnType<MemoryClient['mutate']>;
  forget(input: WithoutScope<MemoryForgetInput>): ReturnType<MemoryClient['forget']>;
  getJob(jobId: string): Promise<MemoryJobReceipt & { contractVersion: string }>;
  waitForJob(jobId: string, options?: { intervalMs?: number; timeoutMs?: number }): Promise<MemoryJobReceipt & { contractVersion: string }>;
  readTools(options?: { maxQueries?: number }): Record<string, unknown>[];
}

export const MEMORY_CONTRACT_VERSION: string;
export function contextText(pack: ContextPack): string;
