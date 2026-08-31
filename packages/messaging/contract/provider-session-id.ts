import { idPatterns, type ProviderSessionId } from './types.js';

const providerSessionIdPattern = new RegExp(idPatterns.ProviderSessionId, 'u');

/** The single runtime parser for Provider Session IDs accepted by the contract. */
export function parseProviderSessionId(value: unknown): ProviderSessionId | undefined {
  return typeof value === 'string' && providerSessionIdPattern.test(value)
    ? value as ProviderSessionId
    : undefined;
}
