import type { ObjectRecord } from '../../contract';
import type { BenchConversation, BenchNodeActions } from '../model/bench-model';
import { ConversationMenu } from './ConversationMenu';
import { MessageComposer } from './MessageComposer';
import { MessageTranscript } from './MessageTranscript';
import './ConversationThread.css';

/** Full thread that expands in the stable conversation node without moving it. */
export function ConversationThread({
  conversation,
  missions,
  savedScrollTop,
  actions,
  showCollapse = true,
}: {
  conversation: BenchConversation;
  missions: readonly ObjectRecord[];
  savedScrollTop: number;
  actions: BenchNodeActions;
  showCollapse?: boolean;
}) {
  const participant = conversation.primaryParticipant;
  const agentName = participant?.record.title ?? 'Unassigned agent';

  return (
    <section className="bench-thread">
      <header className="bench-thread__header">
        <span className="bench-avatar bench-thread__avatar" data-status={participant?.status ?? 'unknown'}>
          {participant?.initials ?? '—'}
        </span>
        <span className="bench-thread__identity">
          {conversation.mission && (
            <span className="bench-thread__eyebrow">{conversation.mission.record.title}</span>
          )}
          <strong>{agentName}</strong>
        </span>
        <ConversationMenu conversation={conversation} missions={missions} actions={actions} />
        {showCollapse && (
          <button
            type="button"
            className="bench-icon-control bench-thread__collapse nodrag"
            onClick={() => actions.collapseConversation(conversation.thread.id)}
            aria-label={`Collapse conversation with ${agentName}`}
            title="Collapse conversation"
          >
            ‹
          </button>
        )}
      </header>

      <MessageTranscript
        threadId={conversation.thread.id}
        messages={conversation.messages}
        composingAgentName={conversation.composingAgentName}
        savedScrollTop={savedScrollTop}
        actions={actions}
      />
      <MessageComposer threadId={conversation.thread.id} actions={actions} />
    </section>
  );
}
