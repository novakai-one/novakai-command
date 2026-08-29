import { deriveClientOpId } from '@novakai/foundation/contract';
import type { AgentIdentityMarker } from '../../contract/records/agent-identity.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { Timestamp } from '../../contract/types.js';
import type { AssignmentStore } from './ingest-store.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';

/** Assignment evidence extracted from one uncommitted provider-source batch. */
export interface SessionAssignmentInput {
  readonly session: ProviderSession;
  readonly markers: readonly AgentIdentityMarker[];
  readonly externalAgentId?: string;
  readonly directory?: AgentDirectory;
  readonly store: AssignmentStore;
  readonly now: () => Timestamp;
}

const attachmentOpId = (sessionId: string, agentId: string): string =>
  deriveClientOpId(`messaging:attach:${sessionId}:${agentId}`);

/** Sole ProviderSession.agentId transition; Agent attachment precedes line visibility. */
export async function assignProviderSession(
  input: SessionAssignmentInput,
): Promise<ProviderSession> {
  const agentIds = [...new Set([
    ...input.markers.map((marker) => marker.agentId),
    ...(input.externalAgentId === undefined ? [] : [input.externalAgentId]),
  ])];
  if (agentIds.length === 0) return input.store.upsertProviderSession(input.session);
  if (agentIds.length !== 1) {
    throw new Error(`ProviderSession ${input.session.id} has conflicting Agent identity markers`);
  }
  const agentId = agentIds[0]!;
  if (input.session.agentId !== undefined && input.session.agentId !== agentId) {
    throw new Error(`ProviderSession ${input.session.id} is already assigned to ${input.session.agentId}`);
  }
  if (input.directory === undefined) {
    throw new Error(`ProviderSession ${input.session.id} carries Agent identity but no AgentDirectory is composed`);
  }
  const agent = await input.directory.get(agentId);
  if (agent === null) throw new Error(`Agent identity marker names missing Agent ${agentId}`);
  if (agent.provider !== input.session.provider) {
    throw new Error(`Agent ${agentId} provider does not match ProviderSession ${input.session.id}`);
  }
  const pending = await input.store.upsertProviderSession({
    ...input.session,
    agentId,
    status: 'assignment-pending',
  });
  const attached = await input.directory.attachProviderSession(
    agentId,
    input.session.id,
    attachmentOpId(input.session.id, agentId),
  );
  if (!attached.ok) {
    throw new Error(`Agent session attachment failed: ${attached.code} ${attached.message}`);
  }
  await input.store.bindAgentSession(agentId, pending.id, input.now());
  return input.store.upsertProviderSession({ ...pending, status: 'idle' });
}
