import type { AgentId } from '@novakai/foundation/dist/contract/brands.js';

/** One provider turn requested by another capability through the Agents door. */
export interface ProviderTurnDispatchInput {
  readonly agentId: AgentId;
  readonly text: string;
  /** Provider-native handle; absent for the first turn. */
  readonly resumeId?: string;
}

/** Runtime mechanics stay private; callers only learn whether work was queued. */
export interface ProviderTurnDispatch {
  readonly state: 'queued';
  readonly resumed: boolean;
}
