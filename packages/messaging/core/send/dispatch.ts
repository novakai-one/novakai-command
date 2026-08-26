import { createHash } from 'node:crypto';
import type { AgentDirectory } from '../../contract/ports/agent-directory.js';
import type { ProviderSend } from '../../contract/ports/provider-send.js';
import type { TranscriptStore } from '../../contract/ports/transcript-store.js';
import type { SendAttempt, SendJournal } from '../../contract/records/send-journal.js';
import type { SendAttemptId, Timestamp } from '../../contract/types.js';
import { messageCorrelationHint } from '../../contract/correlation.js';

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

async function sourceFenceFor(
  store: TranscriptStore,
  sessionId: string | undefined,
): Promise<SendAttempt['sourceFence']> {
  if (sessionId === undefined) return undefined;
  const session = (await store.listProviderSessions()).find((candidate) => candidate.id === sessionId);
  if (session === undefined) return undefined;
  const checkpoints = (await Promise.all(session.sourceIds.map((sourceId) =>
    store.getCheckpoint(sourceId)))).filter((checkpoint) => checkpoint !== null);
  const latest = checkpoints.sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || right.sourceEpoch - left.sourceEpoch
    || right.offset - left.offset)[0];
  return latest === undefined ? undefined : {
    sourceId: latest.sourceId,
    sourceEpoch: latest.sourceEpoch,
    offset: latest.offset,
  };
}

/** Claims and dispatches one accepted send. A second claimant starts no effect. */
export async function dispatchAcceptedSend(
  dependencies: DispatchDependencies,
  journal: SendJournal,
): Promise<SendJournal> {
  if (journal.state !== 'accepted') return journal;
  const agent = await dependencies.agentDirectory.get(journal.targetAgentId);
  if (agent === null) throw new Error(`Unknown target Agent ${journal.targetAgentId}`);
  const targetSessionId = journal.targetSessionId
    ?? agent.currentProviderSessionId
    ?? undefined;
  const dispatchedAt = dependencies.now() as Timestamp;
  const sourceFence = await sourceFenceFor(dependencies.store, targetSessionId);
  const attempt: SendAttempt = {
    attemptId: attemptIdFor(journal),
    state: 'claimed',
    dispatchedAt,
    correlationHint: messageCorrelationHint(journal.request.text),
    ...(sourceFence === undefined ? {} : { sourceFence }),
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
    const sessionKnown = targetSessionId !== undefined;
    const state = sessionKnown ? 'awaiting-transcript' : 'awaiting-session-assignment';
    return (await dependencies.store.transitionSend({
      sendId: journal.id,
      expectedState: 'dispatching',
      state,
      updatedAt: dependencies.now() as Timestamp,
      attempt: {
        ...attempt,
        state,
        dispatchedAt: effect.dispatchedAt as Timestamp,
        submission: effect.certainty,
      },
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
