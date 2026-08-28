import type { AgentConversationMessageSink } from '../../contract/conversations.js';
import type { ProviderNormalizer } from '../../contract/ports/provider-transcript-source.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { ProviderName } from '../../contract/types.js';
import type { DurableTranscriptEventBus } from '../event-bus.js';
import { projectAgentConversationMessages } from './messages.js';

interface AgentConversationMessageStreamDependencies {
  readonly eventBus: DurableTranscriptEventBus;
  readonly store: TranscriptStore;
  readonly normalizers: Readonly<Record<ProviderName, ProviderNormalizer>>;
}

/**
 * Pushes the same messages `listAgentConversationMessages` returns, as they
 * land: each committed transcript line is re-read in its session's order,
 * projected through the shared projection in messages.ts, and delivered to
 * the sink only if it is human-visible. Hosts never see sessions, providers,
 * or raw lines — the subscription speaks the canonical message vocabulary
 * only.
 */
export function subscribeAgentConversationMessageStream(
  dependencies: AgentConversationMessageStreamDependencies,
  sink: AgentConversationMessageSink,
): { close(): void } {
  return dependencies.eventBus.subscribe(async (event) => {
    if (event.kind !== 'transcript-line.appended'
      || event.transcriptLineId === undefined) return;

    const [lines, sessions, journals] = await Promise.all([
      dependencies.store.listTranscriptLines({ sessionId: event.sessionId }),
      dependencies.store.listProviderSessions(),
      dependencies.store.listSendJournals(),
    ]);
    const line = lines.find((candidate) => candidate.id === event.transcriptLineId);
    const session = sessions.find((candidate) => candidate.id === event.sessionId);
    if (line === undefined || session?.agentId === undefined) return;

    const orderedLines = [...lines].sort((left, right) =>
      left.sourcePosition.sourceEpoch - right.sourcePosition.sourceEpoch
      || left.sourcePosition.offset - right.sourcePosition.offset);
    const message = projectAgentConversationMessages(
      orderedLines,
      dependencies.normalizers,
      journals,
    ).find((candidate) => candidate.id === line.id);
    if (message === undefined) return;
    await sink({ agentId: session.agentId, message });
  });
}
