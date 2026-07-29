import { z } from 'zod';
import {
  ProviderName,
  SessionRef,
  type TranscriptContract,
} from '../../../transcript/contract/index.js';
import type { MethodTable } from '../../contract/protocol.js';

const LinesBySessionInput = z.object({
  sessionRef: SessionRef,
}).strict();
const LinesByProviderInput = z.object({
  provider: ProviderName,
  since: z.string().datetime({ offset: true }).optional(),
}).strict();
const SubagentTreeInput = z.object({
  turnId: z.string().min(1),
}).strict();

function parseInput<T>(
  method: string,
  schema: z.ZodType<T>,
  params: unknown,
): { ok: true; value: T } | {
  ok: false;
  error: {
    code: 'InvalidEnvelope';
    message: string;
    details: {
      missingFields: string[];
      invalidFields: Array<{ field: string; reason: string }>;
    };
    retryable: false;
  };
} {
  const parsed = schema.safeParse(params ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    error: {
      code: 'InvalidEnvelope',
      message: `${method} input is invalid`,
      details: {
        missingFields: parsed.error.issues
          .filter((issue) =>
            issue.code === 'invalid_type'
            && issue.received === 'undefined')
          .map((issue) => issue.path.join('.') || '(root)'),
        invalidFields: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.') || '(root)',
          reason: issue.message,
        })),
      },
      retryable: false,
    },
  };
}

/** Read-only WS translation over Transcript's public query interface. */
export function buildTranscriptMethods(
  transcript: TranscriptContract,
): MethodTable {
  return {
    async linesBySession(params: never) {
      const parsed = parseInput(
        'linesBySession',
        LinesBySessionInput,
        params,
      );
      if (!parsed.ok) return parsed;
      return transcript.linesBySession(parsed.value.sessionRef);
    },
    async linesByProvider(params: never) {
      const parsed = parseInput(
        'linesByProvider',
        LinesByProviderInput,
        params,
      );
      if (!parsed.ok) return parsed;
      return transcript.linesByProvider(
        parsed.value.provider,
        parsed.value.since,
      );
    },
    async subagentTree(params: never) {
      const parsed = parseInput(
        'subagentTree',
        SubagentTreeInput,
        params,
      );
      if (!parsed.ok) return parsed;
      return transcript.subagentTree(parsed.value.turnId);
    },
  };
}
