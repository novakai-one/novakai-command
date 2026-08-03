import type {
  AuthenticatedPrincipal,
  AgentRunId,
  B3Page,
  B3Result,
  EventCursor,
  IsoUtc,
  ProviderSessionId,
  ProviderTurnId,
  ProviderUsageEvidenceId,
  RecordEnvelope,
  SystemCommandContext,
  TraceCorrelationId,
  TranscriptTurnCompletionId,
} from '@novakai/foundation/contract';
import {
  b3fail,
  b3ok,
  isValidId,
  readBoundary,
  validationFailed,
} from '@novakai/foundation/contract';

export type { ProviderUsageEvidenceId } from '@novakai/foundation/contract';

/** Agents-owned committed fact consumed by Supervision and external hosts. */
export const PROVIDER_USAGE_EVIDENCE_COMMITTED_EVENT =
  'agent.provider-usage-evidence.committed' as const;

/** Provider-native totals with explicit measurement uncertainty. */
export interface ProviderUsageMeasurement {
  readonly quality: 'measured' | 'estimated' | 'partial' | 'unavailable';
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly costMicros?: number;
  readonly providerTurns?: number;
  readonly limitations: readonly string[];
  readonly evidenceDigest: string;
}

export type ProviderUsageEvidenceScope =
  | { readonly kind: 'provider-session-cumulative' }
  | {
      readonly kind: 'runtime-turn-completion';
      readonly agentRunId: import('@novakai/foundation/contract').AgentRunId;
      readonly providerTurnId: ProviderTurnId;
      readonly transcriptTurnCompletionId: TranscriptTurnCompletionId;
    };

/** Append-only evidence retained by Agents; Supervision only projects it. */
export interface ProviderUsageEvidence extends RecordEnvelope<
  ProviderUsageEvidenceId,
  'providerUsageEvidence'
> {
  readonly providerSessionId: ProviderSessionId;
  readonly providerConversationId: string | null;
  readonly scope: ProviderUsageEvidenceScope;
  readonly observedAt: IsoUtc;
  readonly source: string;
  readonly sourceCursor?: string;
  readonly measurement: ProviderUsageMeasurement;
}

/** Public command input; identity and record provenance are owner-derived. */
export interface RecordProviderUsageEvidenceInput {
  readonly providerSessionId: ProviderSessionId;
  readonly providerConversationId: string | null;
  /** Omitted is the contract-v1 cumulative scope. */
  readonly scope?: Extract<ProviderUsageEvidenceScope, { readonly kind: 'provider-session-cumulative' }>;
  readonly observedAt: IsoUtc;
  readonly source: string;
  readonly sourceCursor?: string;
  readonly measurement: ProviderUsageMeasurement;
}

export interface ProviderTurnCompletionEvidenceFilter {
  readonly agentRunId?: AgentRunId;
  readonly providerSessionId?: ProviderSessionId;
  readonly providerTurnId?: ProviderTurnId;
  readonly transcriptTurnCompletionId?: TranscriptTurnCompletionId;
  readonly cursor?: EventCursor;
  readonly limit: number;
}

export function parseEnsureProviderTurnCompletionEvidenceInput(
  value: unknown,
): B3Result<{ readonly transcriptTurnCompletionId: TranscriptTurnCompletionId }> {
  return readBoundary(value, (field) => ({
    transcriptTurnCompletionId: field.id<TranscriptTurnCompletionId>(
      'transcriptTurnCompletionId', 'transcriptTurnCompletion', 'base32sha256',
    ),
  }));
}

export function parseProviderTurnCompletionEvidenceFilter(
  value: unknown,
): B3Result<ProviderTurnCompletionEvidenceFilter> {
  return readBoundary(value, (field) => {
    const agentRunId = field.optionalId<AgentRunId>('agentRunId', 'agentRun');
    const providerSessionId = field.optionalId<ProviderSessionId>(
      'providerSessionId', 'sess', 'uuidv4',
    );
    const providerTurnId = field.optionalId<ProviderTurnId>('providerTurnId', 'providerTurn');
    const transcriptTurnCompletionId = field.optionalId<TranscriptTurnCompletionId>(
      'transcriptTurnCompletionId', 'transcriptTurnCompletion', 'base32sha256',
    );
    const cursor = field.optionalText('cursor');
    return {
      ...(agentRunId === undefined ? {} : { agentRunId }),
      ...(providerSessionId === undefined ? {} : { providerSessionId }),
      ...(providerTurnId === undefined ? {} : { providerTurnId }),
      ...(transcriptTurnCompletionId === undefined ? {} : { transcriptTurnCompletionId }),
      ...(cursor === undefined ? {} : { cursor: cursor as EventCursor }),
      limit: field.count('limit', 1, 200),
    };
  });
}

/** Parse unknown command JSON before identity derivation or persistence. */
export function parseRecordProviderUsageEvidenceInput(
  candidate: unknown,
): B3Result<RecordProviderUsageEvidenceInput> {
  const issues: Array<{ path: string; message: string }> = [];
  if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
    return b3fail(validationFailed([{ path: 'payload', message: 'must be an object' }]));
  }
  const input = candidate as Readonly<Record<string, unknown>>;
  if (!isValidId(input.providerSessionId, 'sess', 'uuidv4')) {
    issues.push({ path: 'providerSessionId', message: 'must be a ProviderSessionId' });
  }
  if (input.providerConversationId !== null
    && typeof input.providerConversationId !== 'string') {
    issues.push({ path: 'providerConversationId', message: 'must be string or null' });
  }
  isoUtc(input.observedAt, 'observedAt', issues);
  tupleText(input.source, 'source', issues);
  if (input.sourceCursor !== undefined) tupleText(input.sourceCursor, 'sourceCursor', issues);

  const measurement = objectValue(input.measurement, 'measurement', issues);
  const qualities = ['measured', 'estimated', 'partial', 'unavailable'] as const;
  if (!qualities.includes(measurement.quality as never)) {
    issues.push({ path: 'measurement.quality', message: 'must be a measurement quality' });
  }
  const metricNames = [
    'inputTokens', 'outputTokens', 'cachedInputTokens', 'costMicros', 'providerTurns',
  ] as const;
  for (const metric of metricNames) {
    const value = measurement[metric];
    if (value !== undefined && (!Number.isInteger(value) || (value as number) < 0)) {
      issues.push({ path: `measurement.${metric}`, message: 'must be a non-negative whole number' });
    }
    if (measurement.quality === 'unavailable' && value !== undefined) {
      issues.push({ path: `measurement.${metric}`, message: 'must be absent when unavailable' });
    }
  }
  if (!Array.isArray(measurement.limitations)
    || measurement.limitations.some((item) => typeof item !== 'string')) {
    issues.push({ path: 'measurement.limitations', message: 'must be an array of strings' });
  } else if (measurement.quality === 'unavailable' && measurement.limitations.length === 0) {
    issues.push({ path: 'measurement.limitations', message: 'must explain unavailable usage' });
  }
  tupleText(measurement.evidenceDigest, 'measurement.evidenceDigest', issues);

  if (input.scope !== undefined) {
    const scope = objectValue(input.scope, 'scope', issues);
    if (scope.kind !== 'provider-session-cumulative') {
      issues.push({ path: 'scope.kind', message: 'generic evidence accepts cumulative scope only' });
    }
  }

  return issues.length === 0
    ? b3ok({
        ...(candidate as RecordProviderUsageEvidenceInput),
        scope: { kind: 'provider-session-cumulative' },
      })
    : b3fail(validationFailed(issues));
}

function objectValue(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    issues.push({ path, message: 'must be an object' });
    return {};
  }
  return value as Readonly<Record<string, unknown>>;
}

function isoUtc(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (typeof value !== 'string' || !value.endsWith('Z') || Number.isNaN(Date.parse(value))) {
    issues.push({ path, message: 'must be an ISO-8601 UTC timestamp' });
  }
}

function tupleText(
  value: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
): void {
  if (typeof value !== 'string' || value.trim() === '') {
    issues.push({ path, message: 'must be a non-empty string' });
  } else if (value.includes('\u001f')) {
    issues.push({ path, message: 'must not contain the identity tuple separator' });
  }
}

/** Agents' narrow write/query surface for authoritative provider usage evidence. */
export interface ProviderUsageEvidenceContract {
  recordProviderUsageEvidence(
    context: SystemCommandContext<'sys_agents'>,
    input: RecordProviderUsageEvidenceInput,
  ): Promise<B3Result<ProviderUsageEvidence>>;
  ensureProviderTurnCompletionEvidence(
    context: SystemCommandContext<'sys_reconciler'>,
    input: { readonly transcriptTurnCompletionId: TranscriptTurnCompletionId },
  ): Promise<B3Result<ProviderUsageEvidence>>;
  getProviderUsageEvidence(
    principal: AuthenticatedPrincipal,
    providerUsageEvidenceId: ProviderUsageEvidenceId,
  ): Promise<B3Result<ProviderUsageEvidence>>;
  listProviderUsageEvidence(
    principal: AuthenticatedPrincipal,
    providerSessionId: ProviderSessionId,
  ): Promise<B3Result<B3Page<ProviderUsageEvidence>>>;
  getProviderUsageEvidence(
    principal: AuthenticatedPrincipal,
    providerUsageEvidenceId: ProviderUsageEvidenceId,
  ): Promise<B3Result<ProviderUsageEvidence | null>>;
  listProviderTurnCompletionEvidence(
    principal: AuthenticatedPrincipal,
    filter: ProviderTurnCompletionEvidenceFilter,
  ): Promise<B3Result<B3Page<ProviderUsageEvidence>>>;
}

/** Host transport seam; the host adds its one event cursor/envelope. */
export type ProviderUsageEvidencePublisher = (
  kind: typeof PROVIDER_USAGE_EVIDENCE_COMMITTED_EVENT,
  payload: ProviderUsageEvidence,
  traceId: TraceCorrelationId,
) => void;
