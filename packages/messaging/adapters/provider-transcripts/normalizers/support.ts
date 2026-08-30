import type {
  NormalizedProviderLine,
  ProviderLineExtent,
} from '../../../contract/ports/provider-transcript-source.js';
import type { TranscriptRole } from '../../../contract/types.js';
import { messageCorrelationHint } from '../../../contract/correlation.js';
import { present } from '../../../core/sparse.js';

/** One parsed JSONL record — the shared row type every normalizer reads. */
export type JsonObject = Record<string, unknown>;

export const isObject = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const textValue = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

export const jsonText = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
};

/** The Novakai context prefix is harness bookkeeping, never shown as user text. */
export const displayUserText = (value: string): string => {
  if (!value.startsWith('[novakai context] ')) return value;
  const newline = value.indexOf('\n');
  return newline < 0 ? value : value.slice(newline + 1);
};

export function contentText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.flatMap((part) => {
    if (typeof part === 'string') return [part];
    if (!isObject(part)) return [];
    return typeof part.text === 'string' ? [part.text] : [];
  });
  return parts.length > 0 ? parts.join('\n') : undefined;
}

export function numericUsage(value: unknown): Readonly<Record<string, number>> | undefined {
  if (!isObject(value)) return undefined;
  const entries = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      Number.isInteger(entry[1]) && Number(entry[1]) >= 0,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

export function parseExtent(extent: ProviderLineExtent): JsonObject | null {
  try {
    const parsed: unknown = JSON.parse(extent.raw);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** A line no host should render: unparsable rows and provider bookkeeping. */
export const noise = (resumeId?: string): NormalizedProviderLine => ({
  role: 'system',
  text: '',
  audience: 'internal',
  ...present('resumeId', resumeId),
});

export function declaredRole(value: unknown): TranscriptRole | undefined {
  return value === 'user'
    || value === 'assistant'
    || value === 'system'
    || value === 'tool'
    ? value
    : undefined;
}

/** Only user and assistant prose belongs in a rendered conversation. */
export const conversational = (role: TranscriptRole, text: string): boolean =>
  (role === 'user' || role === 'assistant') && text.trim() !== '';

/** A correlation hint exists only for rendered user prose. */
export const userCorrelation = (
  role: TranscriptRole,
  audience: NormalizedProviderLine['audience'],
  text: string,
): string | undefined =>
  role === 'user' && audience === 'conversation' ? messageCorrelationHint(text) : undefined;
