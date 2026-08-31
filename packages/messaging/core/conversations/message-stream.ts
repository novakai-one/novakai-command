import type { AgentConversationMessageSink } from '../../contract/conversations.js';
import type { ProviderNormalizer } from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptLine } from '../../contract/records/transcript-line.js';
import type { MessagingTraceSink } from '../../contract/trace.js';
import type {
  ProviderName,
  ProviderSessionId,
  TranscriptLineId,
} from '../../contract/types.js';
import type { DurableTranscriptEventBus } from '../event-bus.js';
import { emitTrace } from '../trace.js';
import {
  projectAgentConversationMessages,
  type ConversationMessageReads,
} from './messages.js';

interface AgentConversationMessageStreamDependencies {
  readonly eventBus: Pick<DurableTranscriptEventBus, 'subscribe'>;
  readonly store: ConversationMessageReads;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
  readonly trace?: MessagingTraceSink;
}

/**
 * Pushes the same messages `listAgentConversationMessages` returns, as they
 * land: each committed transcript line is re-read in its session's order,
 * projected through the shared projection in messages.ts, and delivered to
 * the sink only if it is human-visible. Hosts never see sessions, providers,
 * or raw lines — the subscription speaks the canonical message vocabulary
 * only.
 *
 * Failure semantics: a store or sink throw rejects the event-bus pump, so the
 * remaining committed events in that batch are skipped until the next pump;
 * a crash between sink delivery and cursor advance can replay an event, and
 * hosts must treat messages as at-least-once.
 */
export function subscribeAgentConversationMessageStream(
  dependencies: AgentConversationMessageStreamDependencies,
  sink: AgentConversationMessageSink,
): { close(): void } {
  return dependencies.eventBus.subscribe(async (event) => {
    if (event.kind !== 'transcript-line.appended' || event.transcriptLineId === undefined) return;
    await publishAppendedLine(dependencies, event.sessionId, event.transcriptLineId, sink);
  });
}

/** Projects the session's lines and publishes the appended one when it is human-visible. */
async function publishAppendedLine(
  dependencies: AgentConversationMessageStreamDependencies,
  sessionId: ProviderSessionId,
  transcriptLineId: TranscriptLineId,
  sink: AgentConversationMessageSink,
): Promise<void> {
  const [lines, sessions, journals] = await Promise.all([
    dependencies.store.listTranscriptLines({ sessionId }),
    dependencies.store.listProviderSessions(),
    dependencies.store.listSendJournals(),
  ]);
  const line = lines.find((candidate) => candidate.id === transcriptLineId);
  const agentId = sessions.find((candidate) => candidate.id === sessionId)?.agentId;
  if (line === undefined || agentId === undefined) return;
  const message = projectAgentConversationMessages(
    orderedBySourcePosition(lines), dependencies.normalizers, journals,
  ).find((candidate) => candidate.id === line.id);
  if (message === undefined) return;
  await sink({ agentId, message });
  emitTrace(dependencies.trace, {
    stage: 'message.published',
    sessionId,
    detail: `${agentId} ← ${message.role} message ${message.id}`,
  });
}

/** Source order within one session, so the projection sees the lines the provider wrote. */
const orderedBySourcePosition = (lines: readonly TranscriptLine[]): TranscriptLine[] =>
  [...lines].sort((left, right) =>
    left.sourcePosition.sourceEpoch - right.sourcePosition.sourceEpoch
    || left.sourcePosition.offset - right.sourcePosition.offset);
