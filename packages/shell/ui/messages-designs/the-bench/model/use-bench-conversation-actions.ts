import { useCallback, type MutableRefObject } from 'react';
import type { MessagesDesignProps, ObjectId } from '../../contract';
import type { ConversationInstrumentAction } from '../conversation-instrument/contract';
import type { BenchModel, BenchState } from './bench-model';

type ConversationActionOptions = {
  readonly stateRef: MutableRefObject<BenchState>;
  readonly modelRef: MutableRefObject<BenchModel>;
  readonly commandsRef: MutableRefObject<MessagesDesignProps['commands']>;
  readonly locateConversation: (threadId: ObjectId) => void;
  readonly beginPlacement: (threadId: ObjectId) => void;
  readonly removeConversation: (threadId: ObjectId) => void;
};

/** Adapts navigator intents to the existing placement/removal capabilities. */
export function useBenchConversationActions(options: ConversationActionOptions) {
  const actOnConversation = useCallback((action: ConversationInstrumentAction) => {
    const session = options.stateRef.current.session;
    const isPlaced = session.placedThreadIds.includes(action.threadId);
    if (action.kind === 'select') {
      options.commandsRef.current.select(
        options.modelRef.current.recordsById.get(action.threadId) ?? null,
      );
    } else if (action.kind === 'locate' && isPlaced) {
      options.locateConversation(action.threadId);
    } else if (action.kind === 'begin-placement' && !isPlaced) {
      options.beginPlacement(action.threadId);
    } else if (action.kind === 'remove' && isPlaced) {
      options.removeConversation(action.threadId);
    }
  }, [options]);

  return { actOnConversation };
}
