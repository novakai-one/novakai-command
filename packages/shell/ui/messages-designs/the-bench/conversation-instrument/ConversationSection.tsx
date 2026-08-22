import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import type { ConversationSectionView } from './sections';

type ConversationSectionProps = {
  readonly section: ConversationSectionView;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly children: ReactNode;
};

/** Renders reusable section anatomy; taxonomy formulas remain outside React. */
export function ConversationSection({
  section,
  collapsed,
  onToggle,
  children,
}: ConversationSectionProps) {
  const headingId = `conversation-section-${section.id}`;
  const contentId = `${headingId}-content`;
  return (
    <section
      className="conversation-instrument__section"
      data-section-id={section.id}
      data-collapsed={collapsed}
      aria-labelledby={section.label ? headingId : undefined}
      aria-label={section.label ? undefined : 'Conversations'}
    >
      {section.label && (
        <button
          id={headingId}
          type="button"
          className="conversation-instrument__section-heading"
          onClick={onToggle}
          aria-expanded={!collapsed}
          aria-controls={contentId}
        >
          <ChevronDown size={14} aria-hidden="true" />
          <strong>{section.label}</strong>
          <span>{section.items.length}</span>
        </button>
      )}
      <div id={contentId} className="conversation-instrument__list" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
