import {
  b3fail,
  b3err,
  b3ok,
  composeHandle,
  composeReceiptStore,
  createObject,
  deterministicId,
  getObject,
  isAbsent,
  listObjects,
  storeFailure,
  type B3PrincipalId,
  type EventCursor,
  type ObjectId,
  type PublicOperationName,
  type RecordVersion,
  type ReceiptStore,
  type ScopedStoreHandle,
  type StoredObject,
} from '@novakai/foundation/contract';
import type {
  ProviderUsageEvidence,
  ProviderUsageEvidenceContract,
  ProviderUsageEvidenceId,
  ProviderUsageEvidencePublisher,
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
}

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
  const clock = options.clock ?? (() => new Date().toISOString());
  const receipts = options.receipts ?? composeReceiptStore(options);

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
          const id = providerUsageEvidenceId(parsed.value);
          const handle = handleFor(context.principal.id);
          const existing = await getObject<ProviderUsageEvidence>(
            handle, 'providerUsageEvidence', id as unknown as ObjectId,
          );
          if (!existing.ok) return b3fail(storeFailure('agents', existing.error));
          if (!isAbsent(existing.value)) {
            const evidence = publicView(existing.value);
            return sameEvidence(evidence, parsed.value)
              ? b3ok(evidence)
              : b3fail(b3err(
                  'IdempotencyConflict',
                  `provider usage evidence "${String(id)}" already names different facts`,
                  { providerUsageEvidenceId: id },
                  false,
                ));
          }
          const written = await createObject(handle, {
            id,
            kind: 'providerUsageEvidence',
            schemaVersion: 1,
            createdAt: clock(),
            permissionLevel: 'private',
            createdBy: 'sys_agents',
            ...parsed.value,
          }, context.clientOpId);
          if (!written.ok) return b3fail(storeFailure('agents', written.error));
          const evidence = publicView(written.value);
          options.publish?.(
            PROVIDER_USAGE_EVIDENCE_COMMITTED_EVENT,
            evidence,
            context.traceId,
          );
          return b3ok(evidence);
        },
      );
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

    async getProviderUsageEvidence(_principal, providerUsageEvidenceId) {
      const found = await getObject<ProviderUsageEvidence>(
        reader,
        'providerUsageEvidence',
        providerUsageEvidenceId as unknown as ObjectId,
      );
      if (!found.ok) return b3fail(storeFailure('agents', found.error));
      return b3ok(isAbsent(found.value) ? null : publicView(found.value));
    },
  };
}

function sameEvidence(
  existing: ProviderUsageEvidence,
  input: RecordProviderUsageEvidenceInput,
): boolean {
  const content = (value: ProviderUsageEvidence | RecordProviderUsageEvidenceInput) => ({
    providerSessionId: value.providerSessionId,
    providerConversationId: value.providerConversationId,
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

function publicView(stored: StoredObject<unknown>): ProviderUsageEvidence {
  return {
    ...(stored.object as Omit<ProviderUsageEvidence, 'recordVersion' | 'lastMutation'>),
    recordVersion: stored.version as RecordVersion,
    lastMutation: stored.lastMutation,
  };
}
