/** Minimal Agent fact needed by Messaging. */
export interface AgentDirectoryEntry {
  readonly agentId: string;
  readonly provider: 'claude' | 'codex' | 'kimi';
  readonly currentProviderSessionId: string | null;
}

export type AgentSessionAttachment =
  | { readonly ok: true; readonly state: 'attached' | 'already-attached' }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Cross-capability port; it exposes no Agents store handle. */
export interface AgentDirectory {
  get(agentId: string): Promise<AgentDirectoryEntry | null>;
  attachProviderSession(
    agentId: string,
    providerSessionId: string,
    clientOpId: string,
  ): Promise<AgentSessionAttachment>;
}
