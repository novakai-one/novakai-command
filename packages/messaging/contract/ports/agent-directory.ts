/** Minimal Agent fact needed by Messaging. */
export interface AgentDirectoryEntry {
  readonly agentId: string;
  readonly provider: 'claude' | 'codex' | 'kimi';
  readonly currentProviderSessionId: string | null;
}

export type AgentSessionAttachment =
  | { readonly ok: true; readonly state: 'attached' | 'already-attached' }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Required operating assignment for an externally discovered Agent. */
export interface AdoptionAssignment {
  readonly teamId: string;
  readonly missionId: string;
}

/** Facts required to idempotently create or recover an externally discovered Agent. */
export interface EnsureAgentForSessionInput {
  readonly sessionId: string;
  readonly provider: AgentDirectoryEntry['provider'];
  readonly resumeId?: string;
  readonly assignment: AdoptionAssignment;
}

/** Result of resolving one provider session to its durable Agent identity. */
export type AgentEnsureOutcome =
  | { readonly ok: true; readonly agent: AgentDirectoryEntry }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Cross-capability port; it exposes no Agents store handle. */
export interface AgentDirectory {
  get(agentId: string): Promise<AgentDirectoryEntry | null>;
  ensureForSession(input: EnsureAgentForSessionInput): Promise<AgentEnsureOutcome>;
  attachProviderSession(
    agentId: string,
    providerSessionId: string,
    clientOpId: string,
  ): Promise<AgentSessionAttachment>;
}
