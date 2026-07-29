import type {
  AgentId,
} from '@novakai/foundation/dist/contract/brands.js';
import type {
  ProviderName,
  SessionRef,
  TranscriptDiagnostic,
  TranscriptSourceItem,
} from '../contract/schemas.js';

export type ProviderSessionResolver = (
  provider: ProviderName,
  nativeSessionId: string,
) => SessionRef | undefined;

export type ProviderAgentResolver = (
  provider: ProviderName,
  nativeAgentId: string,
) => AgentId | undefined;

export type JsonRecord = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonRecord {
  return (
    typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
  );
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0
    ? value
    : undefined;
}

export function identityValue(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0) return value;
  return Number.isSafeInteger(value) && Number(value) >= 0
    ? String(value)
    : undefined;
}

export function numericUsage(
  value: unknown,
): Record<string, number> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      Number.isInteger(entry[1]) && Number(entry[1]) >= 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function messageText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return undefined;
  return typeof value.content === 'string'
    ? value.content
    : undefined;
}

export function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (isRecord(part) && typeof part.text === 'string') {
      return [part.text];
    }
    return [];
  });
  return text.length > 0 ? text.join('\n') : undefined;
}

export function serializedText(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === 'string' && serialized.length > 0
      ? serialized
      : undefined;
  } catch {
    return undefined;
  }
}

export function diagnostic(
  code: TranscriptDiagnostic['code'],
  message: string,
): TranscriptDiagnostic {
  return { code, message };
}

export function unsupported(
  offset: number,
  nextOffset: number,
  provider: ProviderName,
): TranscriptSourceItem {
  return {
    kind: 'skip',
    offset,
    nextOffset,
    reason: {
      code: 'unsupported_shape',
      message: `${provider} row does not expose a supported transcript message shape`,
    },
  };
}

export function nonMessage(
  offset: number,
  nextOffset: number,
  provider: ProviderName,
): TranscriptSourceItem {
  return {
    kind: 'skip',
    offset,
    nextOffset,
    reason: {
      code: 'non_message',
      message: `${provider} row is well-formed provider metadata`,
    },
  };
}
