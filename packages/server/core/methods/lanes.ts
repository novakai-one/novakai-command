/** Provider-session lane attachment across session rotation. */

import type { Conversation, ServerRuntime } from './runtime.js';

/** Attach only activity/advisory semantics; never message content. */
export function attachLane(
  runtime: ServerRuntime,
  conversation: Conversation,
  sessionId: string,
  personId: string,
): void {
  void conversation;
  void personId;
  runtime.agents.attachLiveLane({
    sessionId,
    address: `person:${runtime.human.personId}`,
  });
}

/** Relink one conversation after its runtime session rotates. */
export function relinkConversation(
  runtime: ServerRuntime,
  oldSessionId: string,
  newSessionId: string,
): void {
  for (const conversation of runtime.conversations.values()) {
    if (conversation.sessionId !== oldSessionId) continue;
    conversation.sessionId = newSessionId;
    if (conversation.personId) {
      attachLane(runtime, conversation, newSessionId, conversation.personId);
    }
  }
}
