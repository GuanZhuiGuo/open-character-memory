import { nowIso, safeText } from './utils.js';

export const OPEN_TEMPORAL_BOUND = '';

export function normalizeTemporalInstant(value, fallback = '') {
  const text = safeText(value || '', 80).trim();
  if (!text) return fallback;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : fallback;
}

export function temporalVersion(item = {}, transactionTime = nowIso()) {
  const transactionFrom = normalizeTemporalInstant(item.transaction_from, transactionTime);
  const validFrom = normalizeTemporalInstant(item.valid_from, transactionFrom);
  const validTo = normalizeTemporalInstant(item.valid_to, OPEN_TEMPORAL_BOUND);
  return {
    validFrom,
    validTo: validTo && validTo > validFrom ? validTo : OPEN_TEMPORAL_BOUND,
    transactionFrom,
    transactionTo: OPEN_TEMPORAL_BOUND
  };
}

export function closeTemporalVersion({ operation, nextValidFrom, transactionTime = nowIso() }) {
  return {
    validTo: operation === 'update'
      ? normalizeTemporalInstant(nextValidFrom, transactionTime)
      : OPEN_TEMPORAL_BOUND,
    transactionTo: normalizeTemporalInstant(transactionTime, nowIso())
  };
}

export function temporalAsOfClause(alias, { validAt = '', knownAt = '' } = {}, params = []) {
  const clauses = [];
  const normalizedValidAt = normalizeTemporalInstant(validAt);
  const normalizedKnownAt = normalizeTemporalInstant(knownAt);
  if (normalizedValidAt) {
    clauses.push(`${alias}.valid_from <= ? AND (${alias}.valid_to = '' OR ${alias}.valid_to > ?)`);
    params.push(normalizedValidAt, normalizedValidAt);
  }
  if (normalizedKnownAt) {
    clauses.push(`${alias}.transaction_from <= ? AND (${alias}.transaction_to = '' OR ${alias}.transaction_to > ?)`);
    params.push(normalizedKnownAt, normalizedKnownAt);
  }
  return { clause: clauses.join(' AND '), params, validAt: normalizedValidAt, knownAt: normalizedKnownAt };
}

export function currentTransactionClause(alias) {
  return `${alias}.transaction_to = ''`;
}
