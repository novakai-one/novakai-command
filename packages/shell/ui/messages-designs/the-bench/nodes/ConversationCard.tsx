import type { BenchConversation, BenchNodeActions, BenchZoomTier } from '../model/bench-model';
import './ConversationCard.css';

/** Resting conversation card, including the complete far-zoom spine. */
export function ConversationCard({
  conversation,
  tier,
  actions,
}: {
  conversation: BenchConversation;
  tier: BenchZoomTier;
  actions: BenchNodeActions;
}) {
  const participant = conversation.primaryParticipant;
  const agentName = participant?.record.title ?? 'Unassigned agent';

  return (
    <button
      type="button"
      className="bench-card"
      onClick={() => actions.openConversation(conversation.thread.id)}
      aria-label={`Open conversation with ${agentName}`}
    >
      <span className="bench-card__spine">
        <span className="bench-avatar bench-card__avatar" data-status={participant?.status ?? 'unknown'}>
          {participant?.initials ?? '—'}
        </span>
        <span className="bench-card__identity">
          <strong>{agentName}</strong>
          {conversation.unreadCount > 0 && (
            <i className="bench-card__unread-dot" aria-label={`${conversation.unreadCount} unread`} />
          )}
        </span>
      </span>

      {tier !== 'far' && (
        <span className="bench-card__detail">
          <strong className="bench-card__agent">{agentName}</strong>
          {conversation.mission && (
            <span className="bench-card__context">{conversation.mission.record.title}</span>
          )}
          <span className="bench-card__preview">
            {conversation.previewLines.length > 0
              ? conversation.previewLines.map((line, index) => <span key={`${index}:${line}`}>{line}</span>)
              : <span>No messages yet. Open the card to begin.</span>}
          </span>
        </span>
      )}

      <span className="bench-card__index" aria-hidden="true">
        {conversation.thread.id.slice(-6).toUpperCase()}
      </span>
    </button>
  );
}
