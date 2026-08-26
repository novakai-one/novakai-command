/** Legacy marker written before durable store ownership was available. */
export interface LegacyAgentIdentityMarker {
  readonly kind: 'novakai-agent-identity';
  readonly schemaVersion: 1;
  readonly hookEvent: 'UserPromptSubmit';
  readonly agentId: string;
}

/** Store-owned marker written by a Novakai-managed provider turn. */
export interface OwnedAgentIdentityMarker {
  readonly kind: 'novakai-agent-identity';
  readonly schemaVersion: 2;
  readonly hookEvent: 'UserPromptSubmit';
  readonly storeId: string;
  readonly agentId: string;
}

/** Versioned hook evidence persisted inside a provider-owned transcript. */
export type AgentIdentityMarker = LegacyAgentIdentityMarker | OwnedAgentIdentityMarker;
