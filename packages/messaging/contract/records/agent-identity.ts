/** Versioned hook evidence persisted inside a provider-owned transcript. */
export interface AgentIdentityMarker {
  readonly kind: 'novakai-agent-identity';
  readonly schemaVersion: 1;
  readonly hookEvent: 'UserPromptSubmit';
  readonly agentId: string;
}
