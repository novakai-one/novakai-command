// bench-node-actions.ts — the one factory for the stable action surface canvas
// nodes and the Library receive. Every mutation either dispatches a semantic
// Bench action or crosses the host command seam; nothing here touches stores.
import type { Dispatch, MutableRefObject } from 'react';
import type { MessagesDesignCommands } from '../../contract';
import type { BenchAction, BenchModel, BenchNodeActions } from './bench-model';

type BenchNodeActionDeps = {
  readonly dispatch: Dispatch<BenchAction>;
  readonly commandsRef: MutableRefObject<MessagesDesignCommands>;
  readonly modelRef: MutableRefObject<BenchModel>;
  readonly zenThreadId: string | null;
  readonly exitZen: () => void;
  readonly removeFrame: (frameId: string) => void;
  readonly rememberSize: (nodeId: string, size: { width: number; height: number }) => void;
};

/** The inspection-trail and travel slice of the action surface (moved verbatim). */
function inspectionActions(deps: BenchNodeActionDeps): Pick<BenchNodeActions,
  'inspectMessage' | 'expandMessageRelation' | 'expandRelation' | 'closeTrailStep'
  | 'answerDecisionRequest' | 'selectRecord' | 'canTravel' | 'travel'> {
  const { dispatch, commandsRef, modelRef } = deps;
  return {
    inspectMessage: (threadId, messageId) => {
      dispatch({ type: 'inspect-message', threadId, messageId });
      commandsRef.current.select(modelRef.current.recordsById.get(messageId) ?? null);
    },
    expandMessageRelation: (threadId, messageId, relation, recordId) => {
      dispatch({ type: 'expand-message-relation', threadId, messageId, relation, recordId });
      commandsRef.current.select(modelRef.current.recordsById.get(recordId) ?? null);
    },
    expandRelation: (trailId, parentStepId, relation, recordId) => {
      dispatch({ type: 'expand-relation', trailId, parentStepId, relation, recordId });
      commandsRef.current.select(modelRef.current.recordsById.get(recordId) ?? null);
    },
    closeTrailStep: (trailId, stepId) => dispatch({ type: 'close-trail-step', trailId, stepId }),
    answerDecisionRequest: (context, ruling) => {
      const trimmedRuling = ruling.trim();
      if (!trimmedRuling) return;
      const decisionId = commandsRef.current.answerDecisionRequest({
        requestId: context.requestId,
        ruling: trimmedRuling,
      });
      dispatch({ type: 'append-decision', context, decisionId });
      commandsRef.current.select(modelRef.current.recordsById.get(context.requestId) ?? null);
    },
    selectRecord: (recordId) => commandsRef.current.select(
      recordId ? modelRef.current.recordsById.get(recordId) ?? null : null,
    ),
    canTravel: (recordId) => {
      const record = modelRef.current.recordsById.get(recordId);
      return record ? commandsRef.current.canOpen(record) : false;
    },
    travel: (recordId) => {
      const record = modelRef.current.recordsById.get(recordId);
      if (record && commandsRef.current.canOpen(record)) commandsRef.current.open(record);
    },
  };
}

/** Builds the node action surface (moved verbatim; new Library verbs at the end). */
export function createBenchNodeActions(deps: BenchNodeActionDeps): BenchNodeActions {
  const { dispatch, commandsRef, modelRef, zenThreadId, exitZen, removeFrame, rememberSize } = deps;
  const leaveZenIfShowing = (threadId: string): void => {
    if (zenThreadId === threadId) {
      exitZen();
      commandsRef.current.select(null);
    }
  };

  return {
    ...inspectionActions(deps),
    openConversation: (threadId) => {
      dispatch({ type: 'open-conversation', threadId });
      commandsRef.current.select(modelRef.current.recordsById.get(threadId) ?? null);
    },
    collapseConversation: (threadId) => dispatch({ type: 'collapse-conversation', threadId }),
    sendMessage: (threadId, body) => {
      const trimmedBody = body.trim();
      if (trimmedBody) commandsRef.current.send(threadId, trimmedBody);
    },
    rememberTranscriptScroll: (threadId, scrollTop) => {
      dispatch({ type: 'remember-scroll', threadId, scrollTop });
    },
    markThreadRead: (threadId) => commandsRef.current.markThreadRead(threadId),
    // D34: hosts without a resend route simply render no affordance.
    resendMessage: (threadId, messageId) => commandsRef.current.resendMessage?.(threadId, messageId),
    attachThreadToMission: (threadId, missionId) => (
      commandsRef.current.attachThreadToMission(threadId, missionId)
    ),
    archiveConversation: (threadId) => {
      leaveZenIfShowing(threadId);
      // No optimistic prune: the card leaves when the refreshed model drops
      // the thread and reconcile-session sweeps its state. A failed archive
      // therefore changes nothing (and says so on the card).
      commandsRef.current.archiveThread(threadId);
    },
    shelveConversation: (threadId) => {
      leaveZenIfShowing(threadId);
      dispatch({ type: 'shelve-conversation', threadId });
    },
    unarchiveConversation: (threadId) => commandsRef.current.unarchiveThread?.(threadId),
    pinConversation: (threadId, pinned) => commandsRef.current.pinThread?.(threadId, pinned),
    killAgent: (threadId) => commandsRef.current.killAgent?.(threadId),
    rememberNodeSize: (nodeId, size) => rememberSize(nodeId, size),
    renameFrame: (frameId, name) => dispatch({ type: 'rename-frame', frameId, name }),
    removeFrame,
  };
}
