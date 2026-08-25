import type {
  AdoptionAssignment,
  AgentDirectory,
} from '../../contract/ports/agent-directory.js';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { NormalizedProviderLine } from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import { adoptProviderSession } from './adopt-session.js';
import { assignProviderSession } from './assign-session.js';

/** Runtime policy required before Messaging may make an external session visible. */
export interface ExternalAdoptionRuntimePolicy {
  readonly assignment: AdoptionAssignment;
  readonly conversations: ConversationDirectory;
  readonly limitPerTick: number;
}

type SessionClassification =
  | { readonly kind: 'commit'; readonly session: ProviderSession; readonly adopted: boolean }
  | { readonly kind: 'defer'; readonly status: 'adoption-pending' | 'discovered-only' };

interface ClassificationInput {
  readonly session: ProviderSession;
  readonly lines: readonly NormalizedProviderLine[];
  readonly complete: boolean;
  readonly adoptionEligible: boolean;
  readonly adoptionRemaining: number;
  readonly store: TranscriptStore;
  readonly directory?: AgentDirectory;
  readonly adoption?: ExternalAdoptionRuntimePolicy;
}

/** Chooses hook assignment, external adoption or metadata-only discovery. */
export async function classifyProviderSession(
  input: ClassificationInput,
): Promise<SessionClassification> {
  const markers = input.lines.flatMap((line) =>
    line.agentIdentity === undefined ? [] : [line.agentIdentity]);
  if (input.session.agentId !== undefined || markers.length > 0) {
    return {
      kind: 'commit',
      adopted: false,
      session: await assignProviderSession({
        session: input.session,
        store: input.store,
        markers,
        ...(input.session.agentId === undefined
          ? {} : { externalAgentId: input.session.agentId }),
        ...(input.directory === undefined ? {} : { directory: input.directory }),
      }),
    };
  }

  const canAdopt = input.adoptionEligible
    && input.adoption !== undefined
    && input.directory !== undefined;
  const protectedFreshSend = canAdopt && await matchesPendingFreshSend(input);
  if (!canAdopt || protectedFreshSend || !input.complete || input.adoptionRemaining === 0) {
    return { kind: 'defer', status: canAdopt ? 'adoption-pending' : 'discovered-only' };
  }
  return {
    kind: 'commit',
    adopted: true,
    session: await adoptProviderSession({
      session: input.session,
      store: input.store,
      directory: input.directory!,
      conversations: input.adoption!.conversations,
      assignment: input.adoption!.assignment,
    }),
  };
}

async function matchesPendingFreshSend(input: ClassificationInput): Promise<boolean> {
  if (input.directory === undefined) return false;
  const userText = new Set(input.lines
    .filter((line) => line.role === 'user')
    .map((line) => line.text));
  if (userText.size === 0) return false;
  const journals = await input.store.listSendJournals();
  for (const journal of journals) {
    if (journal.state !== 'awaiting-session-assignment'
      || !userText.has(journal.request.text)) continue;
    const agent = await input.directory.get(journal.targetAgentId);
    if (agent?.provider === input.session.provider) return true;
  }
  return false;
}
