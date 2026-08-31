import type { AgentDirectoryEntry } from '../../contract/ports/agent-directory.js';

/**
 * The slice of the Agent directory the send path needs: resolve one Agent.
 * The full cross-capability AgentDirectory satisfies this structurally;
 * tests fake one method instead of four.
 */
export interface AgentLookup {
  get(agentId: string): Promise<AgentDirectoryEntry | null>;
}
