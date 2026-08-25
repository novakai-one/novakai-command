import { createHash } from 'node:crypto';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { SendAttempt, SendJournal } from '../../contract/records/send-journal.js';
import type { SendAttemptId, Timestamp } from '../../contract/types.js';

interface DispatchDependencies {
  readonly store: TranscriptStore;
  readonly providerSend: ProviderSend;
  readonly agentDirectory: AgentDirectory;
  readonly now: () => string;
}

const attemptIdFor = (journal: SendJournal): SendAttemptId =>
  `sendAttempt_${createHash('sha256')
    .update(`${journal.id}:${journal.attempts.length}`)
    .digest('hex')}` as SendAttemptId;

/** Claims and dispatches one accepted send. A second claimant starts no effect. */
export async function dispatchAcceptedSend(
  dependencies: DispatchDependencies,
  journal: SendJournal,
): Promise<SendJournal> {
  if (journal.state !== 'accepted') return journal;
  const dispatchedAt = dependencies.now() as Timestamp;
  const attempt: SendAttempt = {
    attemptId: attemptIdFor(journal),
    state: 'claimed',
    dispatchedAt,
  };
  const claimed = await dependencies.store.transitionSend({
    sendId: journal.id,
    expectedState: 'accepted',
    state: 'dispatching',
    updatedAt: dispatchedAt,
    attempt,
  });
  if (!claimed.changed) return claimed.journal;
  try {
    const agent = await dependencies.agentDirectory.get(journal.targetAgentId);
    if (agent === null) throw new Error(`Unknown target Agent ${journal.targetAgentId}`);
    const targetSessionId = claimed.journal.targetSessionId
      ?? agent.currentProviderSessionId
      ?? undefined;
    const providerSession = targetSessionId === undefined
      ? undefined
      : (await dependencies.store.listProviderSessions()).find((session) =>
          session.id === targetSessionId);
    const effect = await dependencies.providerSend.dispatch({
      sendId: journal.id,
      targetAgentId: journal.targetAgentId,
      text: journal.request.text,
      ...(providerSession?.resumeId === undefined
        ? {} : { resumeId: providerSession.resumeId }),
      ...(journal.request.screenContext === undefined
        ? {} : { screenContext: journal.request.screenContext }),
    });
    if (!effect.ok) {
      return (await dependencies.store.transitionSend({
        sendId: journal.id,
        expectedState: 'dispatching',
        state: 'failed',
        updatedAt: dependencies.now() as Timestamp,
        attempt: { ...attempt, state: 'failed', failure: `${effect.code}: ${effect.message}` },
      })).journal;
    }
    const sessionKnown = claimed.journal.targetSessionId !== undefined
      || agent?.currentProviderSessionId !== null && agent?.currentProviderSessionId !== undefined;
    const state = sessionKnown ? 'awaiting-transcript' : 'awaiting-session-assignment';
    return (await dependencies.store.transitionSend({
      sendId: journal.id,
      expectedState: 'dispatching',
      state,
      updatedAt: dependencies.now() as Timestamp,
      attempt: { ...attempt, state, submission: effect.certainty },
    })).journal;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return (await dependencies.store.transitionSend({
      sendId: journal.id,
      expectedState: 'dispatching',
      state: 'indeterminate',
      updatedAt: dependencies.now() as Timestamp,
      attempt: { ...attempt, state: 'indeterminate', failure: message },
    })).journal;
  }
}
