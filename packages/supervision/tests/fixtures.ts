import type {
  ProviderUsageEvidenceCommittedEvent,
  ProviderUsageMeasurement,
} from '../contract/index.js';

/** Frozen usage event fixture shared by the usage seam pair. */
export function usageEvidenceEvent(
  measurement: ProviderUsageMeasurement,
): ProviderUsageEvidenceCommittedEvent {
  return {
    eventId: 'event_usage-100k',
    kind: 'agent.provider-usage-evidence.committed',
    schemaVersion: 1,
    occurredAt: '2026-08-02T00:00:00.000Z' as never,
    committedAt: '2026-08-02T00:00:00.100Z' as never,
    sourceOwner: 'agents',
    traceId: 'trace_123e4567-e89b-42d3-a456-426614174000' as never,
    cursor: 'cursor-usage-1' as never,
    payload: {
      id: `providerUsage_${'a'.repeat(52)}`,
      kind: 'providerUsageEvidence',
      schemaVersion: 1,
      recordVersion: 1,
      createdAt: '2026-08-02T00:00:00.000Z',
      permissionLevel: 'team',
      createdBy: 'sys_agents',
      lastMutation: { state: 'legacy-no-trace' },
      providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174000',
      providerConversationId: 'conversation-1',
      observedAt: '2026-08-02T00:00:00.000Z',
      source: 'provider-meter',
      sourceCursor: 'usage-cursor-1',
      measurement,
    },
  };
}
