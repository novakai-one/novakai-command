import { providerNameValues, type ProviderName } from './types.js';

const providers = new Set<string>(providerNameValues);

/** Parses provider vocabulary from untrusted runtime/query input. */
export function parseProviderName(value: unknown): ProviderName | undefined {
  return typeof value === 'string' && providers.has(value)
    ? value as ProviderName : undefined;
}
