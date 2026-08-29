import type { ConversationSendInput, SendRejection } from '../../contract/commands.js';
import type { AgentDeliveryMarker } from '../../contract/agent-delivery-marker.js';
import { brandClock } from '../clock.js';
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
} from '../../contract/types.js';
import { MessagingError } from '../../contract/types.js';
import { listAgentCommunications, type CommunicationsReads } from '../communications/queries.js';
import {
  ensureConversationView,
  updateConversationView,
  type ConversationViewStore,
} from '../conversations/views.js';
import {
  listAgentConversationMessages,
  type ConversationMessageReads,
} from '../conversations/messages.js';
import { rebuildProjections } from '../projections/rebuild.js';
import { sendConversationMessage } from '../send/send.js';
import type { SendStore } from '../send/send-store.js';
import { agentDeliveryMarker } from '../delivery/delivery-marker-codec.js';
import { parseProviderName } from '../../contract/provider-name.js';
import { parseProviderSessionId } from '../../contract/provider-session-id.js';
import { parseTranscriptSourceId } from '../../contract/transcript-source-id.js';
import type { MessagingTraceSink } from '../../contract/trace.js';
import { present } from '../send/sparse.js';
import { thrownMessageOr } from '../thrown.js';

type RecordsApi = Pick<MessagingRuntimeApi,
  | 'ensureConversationView' | 'updateConversationView' | 'getConversationView'
  | 'listConversationViews' | 'rebuildProjections' | 'readProjections'
  | 'createAgentDeliveryInstruction'
  | 'sendConversationMessage' | 'listProviderSessions' | 'listTranscriptLines'
  | 'listAgentConversationMessages' | 'listSendJournals' | 'listAgentCommunications'>;

/**
 * The store this module needs, derived from the ports it feeds: each
 * collaborator's own narrow reads, plus the three direct calls no
 * collaborator owns. It can never drift — a collaborator's port growing
 * grows this type automatically. The full TranscriptStore satisfies it
 * structurally.
 */
type CommittedRecordsStore = ConversationViewStore
  & ConversationMessageReads
  & CommunicationsReads
  & SendStore
  & Pick<TranscriptStore,
    | 'listConversationViews' | 'replaceProjections' | 'readProjections'>;

/**
 * The committed-record half of the runtime API. Every operation here only
 * reads or writes durable records through the store — it never triggers
 * ingestion, watching, or delivery scheduling. Each call is wrapped so a
 * store failure reaches the host as a retryable `DependencyUnavailable`
 * outcome instead of leaking an implementation exception.
 */
export function createCommittedRecordsApi(options: {
  readonly store: CommittedRecordsStore;
  readonly now: () => string;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly agentDirectory?: AgentDirectory;
  readonly providerSend?: ProviderSend;
  readonly trace?: MessagingTraceSink;
}): RecordsApi {
  const safe = async <T>(operation: () => Promise<T>): Promise<Outcome<T>> => {
    try {
      return { kind: 'ok', value: await operation() };
    } catch (cause) {
      return failed(cause);
    }
  };
  return {
    ensureConversationView: (input: EnsureConversationViewInput) =>
      safe(() => ensureConversationView(options.store, input, brandClock(options.now))),
    updateConversationView: (input: UpdateConversationViewInput) =>
      safe(() => updateConversationView(options.store, input, brandClock(options.now))),
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
    listTranscriptLines: (input) => safe(() =>
      options.store.listTranscriptLines(parseTranscriptLineQuery(input))),
    listAgentConversationMessages: (input) => safe(() =>
      listAgentConversationMessages(options.store, options.normalizers, input)),
    listSendJournals: () => safe(() => options.store.listSendJournals()),
    listAgentCommunications: (input) => safe(() => listAgentCommunications(options.store, input)),
    sendConversationMessage: (input: ConversationSendInput) => safe(async () => {
      if (options.agentDirectory === undefined || options.providerSend === undefined) {
        throw new MessagingError('DependencyUnavailable', {
          message: 'Messaging send dependencies are not composed',
          fields: { dependency: 'messaging-send' },
        });
      }
      const result = await sendConversationMessage({
        store: options.store,
        agentDirectory: options.agentDirectory,
        providerSend: options.providerSend,
        now: brandClock(options.now),
        ...present('trace', options.trace),
      }, input);
      if (!result.ok) throw asMessagingError(result.rejection);
      return result.acceptance;
    }),
  };
}

/** Maps a typed send rejection onto the public error catalogue at the door. */
const asMessagingError = (rejection: SendRejection): MessagingError => {
  if (rejection.code === 'invalid-send-input') {
    return new MessagingError('InvalidSendInput', {
      message: rejection.message,
      fields: { field: rejection.field },
    });
  }
  return new MessagingError('UnknownTargetAgent', {
    message: rejection.message,
    fields: { targetAgentId: rejection.targetAgentId },
  });
};

/** Maps any store failure to the one outcome shape hosts handle; contract errors pass through unchanged. */
const failed = <T>(cause: unknown): Outcome<T> => {
  if (cause instanceof MessagingError) return { kind: 'error', error: cause };
  return {
    kind: 'error',
    error: new MessagingError('DependencyUnavailable', {
      message: thrownMessageOr(cause, 'Messaging records unavailable'),
      retryable: true,
      fields: { dependency: 'messaging-store' },
    }),
  };
};

/**
 * Parses the optional line-query filter from untrusted host input at the seam;
 * unknown shapes and malformed values are rejected as a typed `InvalidQuery`
 * instead of being silently ignored.
 */
function parseTranscriptLineQuery(input: unknown): TranscriptLineQuery {
  if (input === undefined) return {};
  if (!isRecord(input)) {
    throw new MessagingError('InvalidQuery', {
      message: 'Transcript line query must be an object',
      fields: { query: 'listTranscriptLines' },
    });
  }
  return {
    ...present('sessionId', requireValidFilter('sessionId', input.sessionId, parseProviderSessionId)),
    ...present('provider', requireValidFilter('provider', input.provider, parseProviderName)),
    ...present('sourceId', requireValidFilter('sourceId', input.sourceId, parseTranscriptSourceId)),
    ...present('resumeId', requireValidFilter('resumeId', input.resumeId, parseResumeId)),
  };
}

/** A supplied filter must parse against the contract; malformed means the query is impossible. */
function requireValidFilter<Brand>(
  field: string,
  value: unknown,
  parse: (value: unknown) => Brand | undefined,
): Brand | undefined {
  if (value === undefined) return undefined;
  const parsed = parse(value);
  if (parsed !== undefined) return parsed;
  throw invalidFilter(field);
}

/** Untrusted input is a plain string-keyed object, not an array or null. */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The rejection every malformed query filter shares. */
const invalidFilter = (field: string): MessagingError =>
  new MessagingError('InvalidQuery', {
    message: `Transcript line query ${field} is malformed`,
    fields: { query: 'listTranscriptLines' },
  });

/**
 * A resume id is provider-shaped, not contract-shaped — no pattern exists to
 * validate against, so a non-empty string is branded unchecked at this seam.
 */
const parseResumeId = (value: unknown): ProviderResumeId | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return value as ProviderResumeId;
};
