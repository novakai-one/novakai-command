import { LocateFixed, Minus, MoveUpRight } from 'lucide-react';
import type { ConversationInstrumentAction } from './contract';
import type { ConversationInstrumentItem } from './model';

type ConversationItemProps = {
  readonly item: ConversationInstrumentItem;
  readonly expanded: boolean;
  readonly onSelect: () => void;
  readonly onToggle: () => void;
  readonly onAction: (action: ConversationInstrumentAction) => void;
};

/** One inspect-first row; canvas verbs remain explicit and independent. */
export function ConversationItem({
  item,
  expanded,
  onSelect,
  onToggle,
  onAction,
}: ConversationItemProps) {
  const placed = item.canvasState === 'placed';
  const action = (kind: ConversationInstrumentAction['kind']) => () => {
    onAction({ kind, threadId: item.threadId });
    if (kind === 'remove') {
      requestAnimationFrame(() => {
        const row = [...document.querySelectorAll<HTMLElement>('.conversation-instrument__item')]
          .find((candidate) => candidate.dataset.threadId === item.threadId);
        row?.querySelector<HTMLButtonElement>('.conversation-instrument__summary')?.focus();
      });
    }
  };

  return (
    <article
      className="conversation-instrument__item"
      data-thread-id={item.threadId}
      data-selected={item.selected}
      data-placed={placed}
      data-expanded={expanded}
    >
      <button
        type="button"
        className="conversation-instrument__summary"
        onClick={() => {
          onSelect();
          onToggle();
        }}
        aria-expanded={expanded}
        aria-label={`Inspect ${item.title}`}
      >
        <span className="conversation-instrument__membership" aria-hidden="true">
          {placed && <span />}
        </span>
        <span
          className="conversation-instrument__avatar"
          data-status={item.personStatus ?? 'unknown'}
          aria-hidden="true"
        >
          {item.initials}
        </span>
        <span className="conversation-instrument__copy">
          <span className="conversation-instrument__identity">
            <strong>{item.title}</strong>
            {item.personLabel && <small>{item.personLabel}</small>}
          </span>
          <span className="conversation-instrument__excerpt">{item.excerpt}</span>
          <span className="conversation-instrument__metadata">
            {item.blocked && <b>Needs input</b>}
            {item.unreadCount > 0 && <i>{item.unreadCount} unread</i>}
            {item.activityLabel && <time>{item.activityLabel}</time>}
          </span>
        </span>
        <MoveUpRight className="conversation-instrument__expand-mark" size={14} aria-hidden="true" />
      </button>

      {expanded && (
        <div className="conversation-instrument__details">
          {item.relations.length > 0 && (
            <div className="conversation-instrument__contexts" aria-label="Related work">
              {item.relations.slice(0, 3).map((relation) => (
                <span key={relation.relationId}>{relation.kind} · {relation.label}</span>
              ))}
            </div>
          )}
          <div className="conversation-instrument__actions">
            {placed ? (
              <>
                <button type="button" onClick={action('locate')}>
                  <LocateFixed size={13} aria-hidden="true" /> Locate
                </button>
                {item.canRemove ? (
                  <button type="button" data-danger="true" onClick={action('remove')}>
                    <Minus size={13} aria-hidden="true" /> Remove
                  </button>
                ) : <span>Restoring position…</span>}
              </>
            ) : (
              <button type="button" onClick={action('begin-placement')}>
                <MoveUpRight size={13} aria-hidden="true" /> Place on canvas
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
