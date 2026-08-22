import type { ObjectRecord } from '../../contract';
import type { BenchConversation, BenchNodeActions } from '../model/bench-model';
import { ConversationThread } from '../nodes/ConversationThread';
import { BlockedAgentBanner } from './BlockedAgentBanner';
import './ZenLayer.css';

/** Focused presentation of the existing conversation implementation. */
export function ZenLayer({
  conversation,
  savedScrollTop,
  missions,
  actions,
  onExit,
}: {
  conversation: BenchConversation;
  savedScrollTop: number;
  missions: readonly ObjectRecord[];
  actions: BenchNodeActions;
  onExit(): void;
}) {
  const pendingRequest = conversation.pendingDecisionRequests[0];
  const focusedActions: BenchNodeActions = {
    ...actions,
    inspectMessage: (threadId, messageId) => {
      actions.inspectMessage(threadId, messageId);
      onExit();
    },
  };

  return (
    <section className="bench-zen" aria-label={`Focused conversation with ${conversation.primaryParticipant?.record.title ?? 'agent'}`}>
      <button type="button" className="bench-zen__exit" onClick={onExit} autoFocus>Exit focus <kbd>Esc</kbd></button>
      {pendingRequest && (
        <BlockedAgentBanner
          request={pendingRequest}
          requestCount={conversation.pendingDecisionRequests.length}
          actions={actions}
          onInspect={() => {
            actions.expandMessageRelation(
              pendingRequest.context.threadId,
              pendingRequest.context.rootMessageId,
              pendingRequest.context.requestRelation,
              pendingRequest.context.requestId,
            );
            onExit();
          }}
        />
      )}
      <div className="bench-zen__thread">
        <ConversationThread
          conversation={conversation}
          missions={missions}
          savedScrollTop={savedScrollTop}
          actions={focusedActions}
          showCollapse={false}
        />
      </div>
    </section>
  );
}
