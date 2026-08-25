/** Frozen Communications-screen query, independent of legacy B3 records. */
export interface AgentCommunicationsQuery {
  readonly agentIds: readonly string[];
  readonly runIds?: readonly string[];
  readonly threadId?: string;
  readonly cursor?: string;
  readonly limit: number;
}

/** Existing screen/CLI fields projected from transcript-first authority. */
export interface AgentCommunicationView {
  readonly messageId: string;
  readonly threadId: string;
  readonly conversationId?: string;
  readonly senderPrincipalId: string;
  readonly recipientAgentIds: readonly string[];
  readonly relatedRunIds: readonly string[];
  readonly deliveryState: string;
  readonly occurredAt: string;
  readonly direction: 'to-agent' | 'from-agent' | 'between-agents';
  readonly inboxState?: string;
  readonly senderAgentId?: string;
  readonly textPreview: string;
  readonly originBindingId?: string;
  readonly screenContext?: Readonly<Record<string, unknown>>;
}

export interface AgentCommunicationPage {
  readonly items: readonly AgentCommunicationView[];
  readonly nextCursor?: string;
}
