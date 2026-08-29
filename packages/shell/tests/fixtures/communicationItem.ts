// One communication row, shaped like the one Messaging actually returns.
//
// Shared by the deterministic suite and by tools/communications-preview.html,
// for the same reason usageRow.ts is: a preview page built on its own literals
// is a second story about what the projection looks like, and the screenshot
// would then prove that story rather than this one.
import type {
  AgentCommunicationItemView, AgentCommunicationsPageView, ScreenContextEcho,
} from '../../contract/communications.js';

export function communicationItem(
  over: Partial<AgentCommunicationItemView> = {},
): AgentCommunicationItemView {
  return {
    messageId: 'msg_01J8ZK4T0000000000000001',
    conversationGroupingKey: 'conv_01J8ZK4T0000000000000001',
    senderPrincipalId: 'person_chris',
    recipientAgentIds: ['agent_kimi'],
    relatedRunIds: ['agentRun_01J8ZK4T0000000000000009'],
    deliveryState: 'submitted-confirmed',
    occurredAt: '2026-08-06T09:12:00.000Z',
    // Implementation extras — carried by the owner, not named by FZ-VIEW-013.
    direction: 'to-agent',
    textPreview: 'Take the B3e lane B seat and read the freeze first.',
    inboxState: 'submitted-confirmed',
    ...over,
  };
}

/** An echo as Messaging would send one. Nothing in the Shell mints these. */
export function screenContextEcho(
  over: Partial<ScreenContextEcho> = {},
): ScreenContextEcho {
  return {
    captureId: 'capture_01J8ZK4T0000000000000002',
    capturedAt: '2026-08-06T09:11:58.000Z',
    source: 'novakai-window',
    support: 'snapshot',
    advisoryOnly: true,
    contentRef: 'artifact_01J8ZK4T0000000000000003',
    limitations: [],
    ...over,
  };
}

export function communicationsPage(
  items: readonly AgentCommunicationItemView[],
  over: Partial<AgentCommunicationsPageView> = {},
): AgentCommunicationsPageView {
  return { items, ...over };
}
