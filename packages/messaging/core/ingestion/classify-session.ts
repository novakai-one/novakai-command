import type {
  AdoptionAssignment,
  AgentDirectory,
} from '../../contract/ports/agent-directory.js';
import type { ConversationDirectory } from '../../contract/ports/conversation-directory.js';
import type { NormalizedProviderLine } from '../../contract/ports/provider-transcript-source.js';
import type { AgentIdentityMarker } from '../../contract/records/agent-identity.js';
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
  | {
      readonly kind: 'defer';
      readonly status: 'adoption-pending' | 'discovered-only';
      readonly foreign?: boolean;
    };

interface ClassificationInput {
  readonly session: ProviderSession;
  readonly lines: readonly NormalizedProviderLine[];
  readonly complete: boolean;
  readonly adoptionEligible: boolean;
  readonly adoptionRemaining: number;
  readonly store: TranscriptStore;
  readonly directory?: AgentDirectory;
  readonly adoption?: ExternalAdoptionRuntimePolicy;
  readonly storeId?: string;
  readonly now: () => string;
}

async function ownedMarkers(
  input: ClassificationInput,
  markers: readonly AgentIdentityMarker[],
): Promise<readonly AgentIdentityMarker[] | 'foreign'> {
  const current = markers.filter((marker) => marker.schemaVersion === 2
    && marker.storeId === input.storeId);
  const foreignV2 = markers.filter((marker) => marker.schemaVersion === 2
    && marker.storeId !== input.storeId);
  if (current.length > 0 && foreignV2.length > 0) {
    throw new Error(`ProviderSession ${input.session.id} mixes store ownership markers`);
  }
  if (current.length > 0) {
    if (input.directory === undefined) {
      throw new Error(`ProviderSession ${input.session.id} carries owned identity without AgentDirectory`);
    }
    for (const marker of current) {
      if (await input.directory.get(marker.agentId) === null) {
        throw new Error(`Owned identity marker names missing Agent ${marker.agentId}`);
      }
    }
    return current;
  }
  if (foreignV2.length > 0) return 'foreign';

  const legacy = markers.filter((marker) => marker.schemaVersion === 1);
  if (legacy.length === 0 || input.directory === undefined) return 'foreign';
  const known = [];
  for (const marker of legacy) {
    if (await input.directory.get(marker.agentId) !== null) known.push(marker);
  }
  return known.length === 0 ? 'foreign' : known;
}

/** Chooses hook assignment, external adoption or metadata-only discovery. */
export async function classifyProviderSession(
  input: ClassificationInput,
): Promise<SessionClassification> {
  const markers = input.lines.flatMap((line) =>
    line.agentIdentity === undefined ? [] : [line.agentIdentity]);
  const owned = markers.length === 0 ? [] : await ownedMarkers(input, markers);
  if (owned === 'foreign') {
    return { kind: 'defer', status: 'discovered-only', foreign: true };
  }
  if (input.session.agentId !== undefined || owned.length > 0) {
    return {
      kind: 'commit',
      adopted: false,
      session: await assignProviderSession({
        session: input.session,
        store: input.store,
        markers: owned,
        ...(input.session.agentId === undefined
          ? {} : { externalAgentId: input.session.agentId }),
        ...(input.directory === undefined ? {} : { directory: input.directory }),
        now: input.now,
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
      now: input.now,
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
