/* eslint-disable max-lines -- Canonical usage custody and normalization remain one owner module. */

import {
  b3fail,
  b3err,
  b3ok,
  composeHandle,
  composeReceiptStore,
  createObject,
  deriveClientOpId,
  deterministicId,
  getObject,
  isAbsent,
  keysetPage,
  listObjects,
  mintClientOpId,
  requestQuarantine,
  storeFailure,
  type B3PrincipalId,
  type B3Result,
  type EventCursor,
  type ObjectId,
  type PublicOperationName,
  type RecordVersion,
  type ReceiptStore,
  type ScopedStoreHandle,
  type StoredObject,
  type TranscriptTurnCompletionId,
} from '@novakai/foundation/contract';
import type {
  ProviderUsageEvidence,
  ProviderUsageEvidenceContract,
  ProviderUsageEvidenceId,
  ProviderUsageEvidencePublisher,
  ProviderUsageEvidenceScope,
  RecordProviderUsageEvidenceInput,
} from '../contract/provider-usage-evidence.js';
import {
  parseRecordProviderUsageEvidenceInput,
  PROVIDER_USAGE_EVIDENCE_COMMITTED_EVENT,
} from '../contract/provider-usage-evidence.js';

export interface ComposeProviderUsageEvidenceOptions {
  readonly root: string;
  readonly dataRoot?: string;
  readonly legacyRoot?: string;
  readonly lockTimeoutMs?: number;
  readonly clock?: () => string;
  readonly publish?: ProviderUsageEvidencePublisher;
  readonly receipts?: ReceiptStore;
  /** Late-bound exact owner reads; required only by the reconciler ensure path. */
  readonly turnCompletion?: {
    get(transcriptTurnCompletionId: TranscriptTurnCompletionId): Promise<B3Result<{
      readonly id: TranscriptTurnCompletionId;
      readonly providerTurnId: import('@novakai/foundation/contract').ProviderTurnId;
      readonly agentRunId: import('@novakai/foundation/contract').AgentRunId;
      readonly providerSessionId: import('@novakai/foundation/contract').ProviderSessionId;
      readonly providerConversationId: string | null;
      readonly completionTranscriptWatermark: string;
      readonly completionEvidenceDigest: string;
      readonly observedAt: import('@novakai/foundation/contract').IsoUtc;
    }>>;
    getProviderSession(providerSessionId: import('@novakai/foundation/contract').ProviderSessionId): Promise<B3Result<{
      readonly id: import('@novakai/foundation/contract').ProviderSessionId;
      readonly providerConversationId: string | null;
    }>>;
  };
}

type CanonicalEvidenceInput = Omit<RecordProviderUsageEvidenceInput, 'scope'> & {
  readonly scope: ProviderUsageEvidenceScope;
};

/** Compose the Agents-owned evidence store behind its public contract. */
export function composeProviderUsageEvidence(
  options: ComposeProviderUsageEvidenceOptions,
): ProviderUsageEvidenceContract {
  const handleFor = (principal: B3PrincipalId): ScopedStoreHandle => composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    ...(options.legacyRoot === undefined ? {} : { legacyRoot: options.legacyRoot }),
    ...(options.lockTimeoutMs === undefined ? {} : { lockTimeoutMs: options.lockTimeoutMs }),
    capability: 'agents',
    allowedKinds: ['providerUsageEvidence'],
    principal,
  });
  const reader = handleFor('sys_agents');
  const receipts = options.receipts ?? composeReceiptStore(options);
  const clock = options.clock ?? (() => new Date().toISOString());

  const commit = async (
    context: { readonly principal: { readonly id: B3PrincipalId }; readonly clientOpId: import('@novakai/foundation/contract').ClientOpId; readonly traceId: import('@novakai/foundation/contract').TraceCorrelationId },
    input: CanonicalEvidenceInput,
    id: ProviderUsageEvidenceId,
    createdAt: string,
  ): Promise<B3Result<ProviderUsageEvidence>> => {
    const handle = handleFor('sys_agents');
    const existing = await getObject<ProviderUsageEvidence>(
      handle, 'providerUsageEvidence', id as unknown as ObjectId,
    );
    if (!existing.ok) return b3fail(storeFailure('agents', existing.error));
    if (!isAbsent(existing.value)) {
      const evidence = publicView(existing.value);
      if (sameEvidence(evidence, input)) return b3ok(evidence);
      const quarantined = await requestQuarantine(handle, {
        target: { kind: 'providerUsageEvidence', id: id as unknown as ObjectId },
        clientOpId: mintClientOpId(),
        traceId: context.traceId,
      });
      if (!quarantined.ok) return b3fail(storeFailure('agents', quarantined.error));
      return b3fail(b3err('IdempotencyConflict',
        `provider usage evidence "${String(id)}" already names different facts`,
        { providerUsageEvidenceId: id }, false));
    }
    const written = await createObject(handle, {
      id,
      kind: 'providerUsageEvidence',
      schemaVersion: 1,
      createdAt,
      permissionLevel: 'private',
      createdBy: 'sys_agents',
      ...input,
    }, context.clientOpId);
    if (!written.ok) return b3fail(storeFailure('agents', written.error));
    const evidence = publicView(written.value);
    options.publish?.(PROVIDER_USAGE_EVIDENCE_COMMITTED_EVENT, evidence, context.traceId);
    return b3ok(evidence);
  };

  return {
    async recordProviderUsageEvidence(context, input) {
      if (context.contractVersion !== 1) {
        return b3fail(b3err(
          'UnsupportedContractVersion',
          `contract version ${String(context.contractVersion)} is not supported`,
          { received: context.contractVersion, supported: [1] },
          false,
        ));
      }
      if (context.principal.id !== 'sys_agents') {
        return b3fail(b3err(
          'PermissionDenied',
          'only sys_agents may record provider usage evidence',
          { principalId: context.principal.id },
          false,
        ));
      }
      const parsed = parseRecordProviderUsageEvidenceInput(input);
      if (!parsed.ok) return parsed;
      return receipts.runCommand(
        context,
        {
          operation: 'agent.recordProviderUsageEvidence' as PublicOperationName,
          request: parsed.value,
          replaySafe: true,
        },
        async () => {
          const normalised = {
            ...parsed.value,
            scope: { kind: 'provider-session-cumulative' as const },
          };
          return commit(context, normalised, providerUsageEvidenceId(normalised), clock());
        },
      );
    },

    async ensureProviderTurnCompletionEvidence(context, input) {
      if (context.principal.id !== 'sys_reconciler' || options.turnCompletion === undefined) {
        return b3fail(b3err('PermissionDenied',
          'turn-completion evidence requires sys_reconciler and exact owner reads', {
            principalId: context.principal.id,
          }, false));
      }
      const completion = await options.turnCompletion.get(input.transcriptTurnCompletionId);
      if (!completion.ok) return completion;
      const session = await options.turnCompletion.getProviderSession(
        completion.value.providerSessionId,
      );
      if (!session.ok) return session;
      if (session.value.id !== completion.value.providerSessionId
        || session.value.providerConversationId !== completion.value.providerConversationId) {
        return b3fail(b3err('UsageUnavailable', 'provider-session lineage differs from Transcript', {
          providerSessionId: completion.value.providerSessionId,
          reason: 'provider-conversation-lineage-mismatch',
        }, false));
      }
      const scope = {
        kind: 'runtime-turn-completion' as const,
        agentRunId: completion.value.agentRunId,
        providerTurnId: completion.value.providerTurnId,
        transcriptTurnCompletionId: completion.value.id,
      };
      const canonical = {
        providerSessionId: completion.value.providerSessionId,
        providerConversationId: completion.value.providerConversationId,
        scope,
        observedAt: completion.value.observedAt,
        source: 'transcript-turn-completion',
        sourceCursor: completion.value.completionTranscriptWatermark,
        measurement: {
          quality: 'partial' as const,
          providerTurns: 1,
          limitations: [
            'provider turn completion is measured; per-turn token and cost attribution is unavailable',
          ],
          evidenceDigest: completion.value.completionEvidenceDigest,
        },
      };
      const ownerContext = {
        principal: { id: 'sys_agents' as const, kind: 'system' as const, verifiedScopes: [] },
        clientOpId: deriveClientOpId(
          `agents.ensureProviderTurnCompletionEvidence:${completion.value.id}`,
        ),
        traceId: context.traceId,
        contractVersion: 1 as const,
      };
      return receipts.runCommand(ownerContext, {
        operation: 'agent.ensureProviderTurnCompletionEvidence' as PublicOperationName,
        request: { transcriptTurnCompletionId: completion.value.id },
        replaySafe: true,
      }, () => commit(
        ownerContext,
        canonical,
        providerTurnCompletionEvidenceId(canonical),
        completion.value.observedAt,
      ));
    },

    async getProviderUsageEvidence(_principal, id) {
      const found = await getObject<ProviderUsageEvidence>(
        reader, 'providerUsageEvidence', id as unknown as ObjectId,
      );
      if (!found.ok) return b3fail(storeFailure('agents', found.error));
      return isAbsent(found.value)
        ? b3fail(b3err('UsageUnavailable', 'provider usage evidence is not available', {
            providerUsageEvidenceId: id,
          }, true))
        : b3ok(publicView(found.value));
    },

    async listProviderUsageEvidence(_principal, providerSessionId) {
      const listed = await listObjects(
        reader,
        'providerUsageEvidence',
        { providerSessionId },
        { limit: 100_000 },
      );
      if (!listed.ok) return b3fail(storeFailure('agents', listed.error));
      return b3ok({
        items: listed.value.items.map((item) => publicView(item)),
        ...(listed.value.nextCursor === undefined
          ? {}
          : { nextCursor: listed.value.nextCursor as EventCursor }),
        omissions: [],
      });
    },

    async listProviderTurnCompletionEvidence(_principal, filter) {
      const listed = await listObjects(
        reader, 'providerUsageEvidence', {}, { limit: 100_000 },
      );
      if (!listed.ok) return b3fail(storeFailure('agents', listed.error));
      const items = listed.value.items.map((item) => publicView(item))
        .filter((item) => item.scope.kind === 'runtime-turn-completion')
        .filter((item) => filter.providerSessionId === undefined
          || item.providerSessionId === filter.providerSessionId)
        .filter((item) => item.scope.kind === 'runtime-turn-completion'
          && (filter.agentRunId === undefined || item.scope.agentRunId === filter.agentRunId)
          && (filter.providerTurnId === undefined || item.scope.providerTurnId === filter.providerTurnId)
          && (filter.transcriptTurnCompletionId === undefined
            || item.scope.transcriptTurnCompletionId === filter.transcriptTurnCompletionId));
      return keysetPage(items, filter);
    },
  };
}

function sameEvidence(
  existing: ProviderUsageEvidence,
  input: CanonicalEvidenceInput,
): boolean {
  const content = (value: ProviderUsageEvidence | CanonicalEvidenceInput) => ({
    providerSessionId: value.providerSessionId,
    providerConversationId: value.providerConversationId,
    scope: value.scope,
    observedAt: value.observedAt,
    source: value.source,
    sourceCursor: value.sourceCursor ?? null,
    measurement: value.measurement,
  });
  return JSON.stringify(content(existing)) === JSON.stringify(content(input));
}

/** §5.5's deterministic identity tuple. */
export function providerUsageEvidenceId(
  input: RecordProviderUsageEvidenceInput,
): ProviderUsageEvidenceId {
  return deterministicId('providerUsage', [
    'provider-usage-evidence',
    String(input.providerSessionId),
    input.source,
    input.sourceCursor ?? String(input.observedAt),
    input.measurement.evidenceDigest,
  ]) as ProviderUsageEvidenceId;
}

export function providerTurnCompletionEvidenceId(
  input: { readonly providerSessionId: ProviderUsageEvidence['providerSessionId']; readonly scope: Extract<ProviderUsageEvidenceScope, { readonly kind: 'runtime-turn-completion' }> },
): ProviderUsageEvidenceId {
  return deterministicId('providerUsage', [
    String(input.providerSessionId),
    'runtime-turn-completion',
    String(input.scope.agentRunId),
    String(input.scope.providerTurnId),
    String(input.scope.transcriptTurnCompletionId),
  ]) as ProviderUsageEvidenceId;
}

function publicView(stored: StoredObject<unknown>): ProviderUsageEvidence {
  const object = stored.object as Omit<ProviderUsageEvidence, 'recordVersion' | 'lastMutation'>;
  return {
    ...object,
    scope: object.scope ?? { kind: 'provider-session-cumulative' },
    recordVersion: stored.version as RecordVersion,
    lastMutation: stored.lastMutation,
  };
}
