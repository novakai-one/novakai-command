/** Frozen Communications-screen query, independent of legacy B3 records. */
export interface AgentCommunicationsQuery {
  readonly agentIds: readonly string[];
  readonly runIds?: readonly string[];
  /** Narrows the page to one conversation grouping key (see AgentCommunicationView.threadId). */
  readonly threadId?: string;
  readonly cursor?: string;
  readonly limit: number;
}

/** Existing screen/CLI fields projected from transcript-first authority. */
export interface AgentCommunicationView {
  readonly messageId: string;
  /**
   * Old-screen field name kept for host compatibility. In the
   * transcript-first system this is the conversation grouping key: the real
   * conversation id when the row belongs to a conversation, otherwise a
   * deterministic stand-in derived from the row's participants.
   */
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
