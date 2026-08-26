import type { ConversationSendInput } from '../../contract/commands.js';
import type { AgentDeliveryMarker } from '../../contract/agent-delivery-marker.js';
import type {
  EnsureConversationViewInput,
  UpdateConversationViewInput,
} from '../../contract/conversations.js';
import type { Outcome } from '../../contract/outcome.js';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ProviderNormalizer } from '../../contract/ports/provider-transcript-source.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { TranscriptLineQuery, TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { MessagingRuntimeApi } from '../../contract/runtime.js';
import type {
  ProviderResumeId,
  ProviderName,
  ProviderSessionId,
  TranscriptSourceId,
} from '../../contract/types.js';
import { MessagingError } from '../../contract/types.js';
import { listAgentCommunications } from '../communications/queries.js';
import { ensureConversationView, updateConversationView } from '../conversations/views.js';
import { listAgentConversationMessages } from '../conversations/messages.js';
import { rebuildProjections } from '../projections/rebuild.js';
import { sendConversationMessage } from '../send/send.js';
import { agentDeliveryMarker } from '../delivery/agent-delivery-marker.js';
import { parseProviderName } from '../../contract/provider-name.js';

type RecordsApi = Pick<MessagingRuntimeApi,
  | 'ensureConversationView' | 'updateConversationView' | 'getConversationView'
  | 'listConversationViews' | 'rebuildProjections' | 'readProjections'
  | 'createAgentDeliveryInstruction'
  | 'sendConversationMessage' | 'listProviderSessions' | 'listTranscriptLines'
  | 'listAgentConversationMessages' | 'listSendJournals' | 'listAgentCommunications'>;

const failed = <T>(cause: unknown): Outcome<T> => ({
  kind: 'error',
  error: new MessagingError('DependencyUnavailable', {
    message: cause instanceof Error ? cause.message : 'Messaging records unavailable',
    retryable: true,
    fields: { dependency: 'messaging-store' },
  }),
});

function lineQuery(input: unknown): TranscriptLineQuery {
  if (input === undefined) return {};
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Transcript line query must be an object');
  }
  const value = input as Record<string, unknown>;
  const provider = parseProviderName(value.provider);
  return {
    ...(typeof value.sessionId === 'string'
      ? { sessionId: value.sessionId as ProviderSessionId } : {}),
    ...(provider === undefined ? {} : { provider }),
    ...(typeof value.sourceId === 'string'
      ? { sourceId: value.sourceId as TranscriptSourceId } : {}),
    ...(typeof value.resumeId === 'string'
      ? { resumeId: value.resumeId as ProviderResumeId } : {}),
  };
}

/** Committed record operations kept separate from watcher lifecycle policy. */
export function createCommittedRecordsApi(options: {
  readonly store: TranscriptStore;
  readonly now: () => string;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly agentDirectory?: AgentDirectory;
  readonly providerSend?: ProviderSend;
}): RecordsApi {
  const safe = async <T>(operation: () => Promise<T>): Promise<Outcome<T>> => {
    try { return { kind: 'ok', value: await operation() }; } catch (cause) { return failed(cause); }
  };
  return {
    ensureConversationView: (input: EnsureConversationViewInput) =>
      safe(() => ensureConversationView(options.store, input, options.now)),
    updateConversationView: (input: UpdateConversationViewInput) =>
      safe(() => updateConversationView(options.store, input, options.now)),
    getConversationView: (id) => safe(() => options.store.getConversationView(id)),
    listConversationViews: () => safe(() => options.store.listConversationViews()),
    rebuildProjections: () => safe(async () => options.store.replaceProjections(
      rebuildProjections(await options.store.listTranscriptLines()),
    )),
    readProjections: () => safe(() => options.store.readProjections()),
    createAgentDeliveryInstruction: (input: AgentDeliveryMarker) => safe(async () => ({
      kind: 'transcript-addressed-delivery',
      recipientAgentId: input.recipientAgentId,
      clientOpId: input.clientOpId,
      transcriptMarker: agentDeliveryMarker(input),
    })),
    listProviderSessions: () => safe(() => options.store.listProviderSessions()),
    listTranscriptLines: (input) => safe(() => options.store.listTranscriptLines(lineQuery(input))),
    listAgentConversationMessages: (input) => safe(() =>
      listAgentConversationMessages(options.store, options.normalizers, input)),
    listSendJournals: () => safe(() => options.store.listSendJournals()),
    listAgentCommunications: (input) => safe(() => listAgentCommunications(options.store, input)),
    sendConversationMessage: (input: ConversationSendInput) => safe(() => {
      if (options.agentDirectory === undefined || options.providerSend === undefined) {
        throw new Error('Messaging send dependencies are not composed');
      }
      return sendConversationMessage({
        store: options.store,
        agentDirectory: options.agentDirectory,
        providerSend: options.providerSend,
        now: options.now,
      }, input);
    }),
  };
}
