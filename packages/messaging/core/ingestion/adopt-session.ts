import { deriveClientOpId } from '@novakai/foundation/contract';
import type {
  AdoptionAssignment,
  AgentDirectory,
} from '../../contract/ports/agent-directory.js';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { Timestamp } from '../../contract/types.js';
import type { AssignmentStore } from './ingest-store.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import { assignProviderSession } from './assign-session.js';

interface AdoptProviderSessionInput {
  readonly session: ProviderSession;
  readonly directory: AgentDirectory;
  readonly conversations: ConversationDirectory;
  readonly assignment: AdoptionAssignment;
  readonly store: AssignmentStore;
  readonly now: () => Timestamp;
}

/** Creates one external Agent/View, then reuses the sole assignment writer. */
export async function adoptProviderSession(
  input: AdoptProviderSessionInput,
): Promise<ProviderSession> {
  const ensured = await input.directory.ensureForSession({
    sessionId: input.session.id,
    provider: input.session.provider,
    ...(input.session.resumeId === undefined ? {} : { resumeId: input.session.resumeId }),
    assignment: input.assignment,
  });
  if (!ensured.ok) {
    throw new Error(`External Agent ensure failed: ${ensured.code} ${ensured.message}`);
  }
  const assigned = await assignProviderSession({
    session: input.session,
    markers: [],
    externalAgentId: ensured.agent.agentId,
    directory: input.directory,
    store: input.store,
    now: input.now,
  });
  await input.conversations.ensureForAdoptedAgent({
    agent: ensured.agent,
    sessionId: assigned.id,
    ...(assigned.resumeId === undefined ? {} : { resumeId: assigned.resumeId }),
    clientOpId: deriveClientOpId(`messaging:adopted-view:${assigned.id}`),
  });
  return assigned;
}
