import type {
  NotificationEvent,
  Notification,
  InstallRunWatchersInput,
  ProviderUsageEvidenceCommittedEvent,
  ProviderUsageMeasurement,
  WatchRule,
} from '../contract/index.js';
import type { SafeBoundaryStatusTurnRequest } from '../contract/testkit/index.js';

/** Frozen usage event fixture shared by the usage seam pair. */
export function usageEvidenceEvent(
  measurement: ProviderUsageMeasurement,
  revision = 1,
): ProviderUsageEvidenceCommittedEvent {
  const identityBody = revision === 1 ? 'a'.repeat(52) : 'c'.repeat(52);
  const second = String(revision - 1).padStart(2, '0');
  return {
    eventId: `event_usage-100k-${revision}`,
    kind: 'agent.provider-usage-evidence.committed',
    schemaVersion: 1,
    occurredAt: `2026-08-02T00:00:${second}.000Z` as never,
    committedAt: `2026-08-02T00:00:${second}.100Z` as never,
    sourceOwner: 'agents',
    traceId: 'trace_123e4567-e89b-42d3-a456-426614174000' as never,
    cursor: `cursor-usage-${revision}` as never,
    payload: {
      id: `providerUsage_${identityBody}`,
      kind: 'providerUsageEvidence',
      schemaVersion: 1,
      recordVersion: 1,
      createdAt: '2026-08-02T00:00:00.000Z',
      permissionLevel: 'team',
      createdBy: 'sys_agents',
      lastMutation: { state: 'legacy-no-trace' },
      providerSessionId: 'sess_123e4567-e89b-42d3-a456-426614174000',
      providerConversationId: 'conversation-1',
      observedAt: `2026-08-02T00:00:${second}.000Z`,
      source: 'provider-meter',
      sourceCursor: 'usage-cursor-1',
      measurement,
    },
  };
}

/** Two installed rules for the two required spawn templates. */
export function installedWatchRules(
  input: InstallRunWatchersInput,
): readonly WatchRule[] {
  const identifiers = [
    'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab',
    'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ac',
  ] as const;
  return identifiers.map((id, index) => ({
    id: id as never,
    kind: 'watchRule',
    schemaVersion: 1,
    recordVersion: 1 as never,
    createdAt: '2026-08-02T00:04:00.000Z' as never,
    permissionLevel: 'team' as const,
    createdBy: 'sys_supervision' as const,
    lastMutation: { state: 'legacy-no-trace' as const },
    subject: { kind: 'agent-run' as const, agentRunId: input.agentRunId },
    condition: index === 0
      ? { kind: 'turn-count-at-least' as const, value: 100 }
      : { kind: 'output-tokens-at-least' as const, value: 100_000 },
    recipient: input.recipient,
    deliveryMode: 'queue-only' as const,
    cooldownMs: 0,
    status: 'active' as const,
  }));
}

/** Queued drift request: no submitted/reply timestamps exist before Runtime acts. */
export function queuedDriftStatusTurn(): SafeBoundaryStatusTurnRequest {
  return {
    agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
    watchDeadlineId: `watchDeadline_${'c'.repeat(52)}` as never,
    expectedDeadlineRecordVersion: 4 as never,
    prompt: 'Status check: reply with one line — what are you working on right now?',
    status: {
      episodeId: `driftEpisode_${'d'.repeat(52)}` as never,
      effectKey: 'drift-status:episode-1',
      notificationId: `notification_${'e'.repeat(52)}` as never,
      state: 'queued',
      requestedAt: '2026-08-02T00:02:00.000Z' as never,
    },
  };
}

/** Frozen queued notification fixture shared by the emit/deliver seam pair. */
export function queuedNotificationEvent(
  deliveryMode: Notification['deliveryMode'],
): NotificationEvent {
  const notification: Notification = {
    id: `notification_${'b'.repeat(52)}` as never,
    kind: 'notification',
    schemaVersion: 1,
    recordVersion: 1 as never,
    createdAt: '2026-08-02T00:01:00.000Z' as never,
    permissionLevel: 'team',
    createdBy: 'sys_supervision',
    lastMutation: { state: 'legacy-no-trace' },
    deliveryEffectKey: `b3v4:notification-delivery:notification_${'b'.repeat(52)}:condition`,
    deliveryAttempt: {
      state: 'queued',
      effectKey: `b3v4:notification-delivery:notification_${'b'.repeat(52)}:condition`,
    },
    watchRuleId: `watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab` as never,
    subject: {
      kind: 'agent',
      agentId: 'agent_123e4567-e89b-42d3-a456-426614174000' as never,
    },
    recipient: { kind: 'human', principalId: 'person_chris' as never },
    conditionGeneration: 1,
    summary: 'Output token threshold reached',
    evidenceRefs: [`providerUsage_${'a'.repeat(52)}`],
    state: 'queued',
    deliveryMode,
    phase: 'condition',
  };
  return {
    eventId: `event_notification-${deliveryMode}`,
    kind: 'supervision.notification.changed',
    schemaVersion: 1,
    occurredAt: '2026-08-02T00:01:00.000Z' as never,
    committedAt: '2026-08-02T00:01:00.100Z' as never,
    sourceOwner: 'supervision',
    traceId: 'trace_123e4567-e89b-42d3-a456-426614174000' as never,
    cursor: `cursor-notification-${deliveryMode}` as never,
    payload: notification,
  };
}
