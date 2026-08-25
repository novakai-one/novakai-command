/**
 * Dormant record shapes retained only so the sealed v1 store can replay old
 * endpoint/inbox operations. Transcript-first Messaging never creates them.
 */
import type { MessageId } from '../schemas.js';

/** Legacy Agent identity required by the sealed v1 replay port. */
export type AgentId = string & { readonly __brand: 'AgentId' };
type AgentRunId = string & { readonly __brand: 'AgentRunId' };
type TerminalSessionId = string & { readonly __brand: 'TerminalSessionId' };
type TerminalInputAttemptId = string & { readonly __brand: 'TerminalInputAttemptId' };
/** Identity of one historic endpoint-claim record. */
export type AgentEndpointClaimId = string & { readonly __brand: 'AgentEndpointClaimId' };
/** Identity of one historic inbox record. */
export type AgentInboxItemId = string & { readonly __brand: 'AgentInboxItemId' };
/** Identity of one Foundation-wrapped v1 Messaging operation. */
export type MessagingStoreOpId = string & { readonly __brand: 'MessagingStoreOpId' };

interface LegacyEntity<Id extends string, Kind extends string> {
  readonly id: Id;
  readonly kind: Kind;
  readonly schemaVersion: 1;
  readonly entityRevision: number;
  readonly createdAt: string;
  readonly permissionLevel: 'private' | 'shared' | 'public';
  readonly createdBy: string;
  readonly lastStoreOpId: MessagingStoreOpId;
}

type AgentEndpointState = 'reserved' | 'active' | 'draining' | 'closed';

/** Historic endpoint state retained solely for deterministic v1 replay. */
export interface AgentEndpointClaim
  extends LegacyEntity<AgentEndpointClaimId, 'agentEndpointClaim'> {
  readonly agentId: AgentId;
  readonly agentRunId: AgentRunId;
  readonly terminalSessionId: TerminalSessionId;
  readonly endpointGeneration: number;
  readonly state: AgentEndpointState;
  readonly cutoffMessageSequence?: number;
  readonly finalTranscriptWatermark?: string;
}

type AgentInboxItemState =
  | 'queued'
  | 'claimed'
  | 'submitted-confirmed'
  | 'submitted-unconfirmed'
  | 'transcript-observed'
  | 'failed';

/** Historic inbox state retained solely for deterministic v1 replay. */
export interface AgentInboxItem
  extends LegacyEntity<AgentInboxItemId, 'agentInboxItem'> {
  readonly agentId: AgentId;
  readonly messageId: MessageId;
  readonly requestedRunId?: AgentRunId;
  readonly acceptedSequence: number;
  readonly state: AgentInboxItemState;
  readonly endpointClaimId?: AgentEndpointClaimId;
  readonly terminalInputAttemptId?: TerminalInputAttemptId;
  readonly failureReason?: string;
}
