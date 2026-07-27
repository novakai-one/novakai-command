// §6 agents-lite typed errors. Values, never throws (A §11).
import type { ContractError, StoreError } from '@novakai/foundation/dist/contract/errors.js';

export type UnsupportedOperationError = ContractError<'UnsupportedOperation',
  { operation: string; reason: string; blockedBy?: string }>;
export type ProviderUnavailableError = ContractError<'ProviderUnavailable',
  { provider: string; cause: string }>;
export type SpawnFailedError = ContractError<'SpawnFailed',
  { provider: string; agentId: string; cause: string }>;

export type AgentsError =
  | StoreError | UnsupportedOperationError | ProviderUnavailableError | SpawnFailedError;

export const unsupportedOperation = (
  operation: string, reason: string, blockedBy?: string,
): UnsupportedOperationError => ({
  code: 'UnsupportedOperation',
  message: `${operation}: ${reason}`,
  details: { operation, reason, ...(blockedBy ? { blockedBy } : {}) },
  retryable: false,
});

export const providerUnavailable = (provider: string, cause: string): ProviderUnavailableError => ({
  code: 'ProviderUnavailable',
  message: `provider "${provider}" is unavailable: ${cause}`,
  details: { provider, cause },
  retryable: true,
});

export const spawnFailed = (provider: string, agentId: string, cause: string): SpawnFailedError => ({
  code: 'SpawnFailed',
  message: `spawn of agent "${agentId}" via provider "${provider}" failed: ${cause}`,
  details: { provider, agentId, cause },
  retryable: false,
});
