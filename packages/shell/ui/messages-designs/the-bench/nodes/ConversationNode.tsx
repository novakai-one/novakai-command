import type { NodeProps } from '@xyflow/react';
import type { BenchConversationCanvasNode } from '../model/bench-projection';
import { ConversationCard } from './ConversationCard';
import { DecisionRequestCallout } from './DecisionRequestCallout';
import { ConversationThread } from './ConversationThread';
import './ConversationNode.css';

/** Keeps one canvas node identity while switching between card and open-thread views. */
export function ConversationNode({ data }: NodeProps<BenchConversationCanvasNode>) {
  const pendingRequest = data.conversation.pendingDecisionRequests[0];
  return (
    <article
      className="bench-conversation"
      data-tier={data.tier}
      data-mission-tone={data.conversation.mission?.tone ?? 'none'}
    >
      {data.conversation.mission && (
        <div className="bench-conversation__mission-pool" aria-hidden="true" />
      )}
      {data.isOpen ? (
        <ConversationThread
          conversation={data.conversation}
          missions={data.missions}
          savedScrollTop={data.savedScrollTop}
          actions={data.actions}
        />
      ) : (
        <ConversationCard conversation={data.conversation} tier={data.tier} actions={data.actions} />
      )}
      {pendingRequest && (
        <DecisionRequestCallout
          request={pendingRequest}
          requestCount={data.conversation.pendingDecisionRequests.length}
          actions={data.actions}
        />
      )}
    </article>
  );
}
