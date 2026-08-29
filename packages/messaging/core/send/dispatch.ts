import type { SendRejection } from '../../contract/commands.js';
import type { ProviderDispatchResult, ProviderSend } from '../../contract/ports/provider-send.js';
import type { IngestCheckpoint } from '../../contract/records/ingest-checkpoint.js';
import type { ProviderSession } from '../../contract/records/provider-session.js';
import type { SendAttempt, SendJournal } from '../../contract/records/send-journal.js';
import type { ProviderSessionId, Timestamp } from '../../contract/types.js';
import { messageCorrelationHint } from '../../contract/correlation.js';
import type { MessagingTraceSink } from '../../contract/trace.js';
import type { AgentLookup } from './agent-lookup.js';
import { mintSendAttemptId } from './mint.js';
import { present } from './sparse.js';
import type { SendStore } from './send-store.js';

interface DispatchDependencies {
  readonly store: SendStore;
  readonly providerSend: ProviderSend;
  readonly agentDirectory: AgentLookup;
  readonly now: () => Timestamp;
  readonly trace?: MessagingTraceSink;
}

/** Provider effect recorded on the journal, or the typed reason dispatch was refused. */
export type DispatchOutcome =
  | { readonly ok: true; readonly journal: SendJournal; readonly response?: string }
  | { readonly ok: false; readonly rejection: SendRejection };

/** Journal and attempt always land on the same post-dispatch state. */
type SettledDispatchState = 'awaiting-session-assignment' | 'awaiting-transcript' | 'failed' | 'indeterminate';

type SourceFence = NonNullable<SendAttempt['sourceFence']>;

async function sessionFor(
  store: SendStore,
  sessionId: ProviderSessionId | undefined,
): Promise<ProviderSession | undefined> {
  if (sessionId === undefined) return undefined;
  const sessions = await store.listProviderSessions();
  return sessions.find((candidate) => candidate.id === sessionId);
}

const newestCheckpointFirst = (left: IngestCheckpoint, right: IngestCheckpoint): number =>
  right.updatedAt.localeCompare(left.updatedAt)
  || right.sourceEpoch - left.sourceEpoch
  || right.offset - left.offset;

/**
 * The ingestion high-water mark for the target session, captured before the
 * provider effect so later confirmation only credits lines written after it.
 */
async function sourceFenceFor(
  store: SendStore,
  session: ProviderSession | undefined,
): Promise<SourceFence | undefined> {
  if (session === undefined) return undefined;
  const checkpoints = await Promise.all(
    session.sourceIds.map((sourceId) => store.getCheckpoint(sourceId)),
  );
  const latest = checkpoints
    .filter((checkpoint) => checkpoint !== null)
    .sort(newestCheckpointFirst)[0];
  if (latest === undefined) return undefined;
  return { sourceId: latest.sourceId, sourceEpoch: latest.sourceEpoch, offset: latest.offset };
}

/** Compare-and-set out of `dispatching`; the losing worker keeps the winner's journal. */
async function transitionFromDispatching(
  dependencies: DispatchDependencies,
  journal: SendJournal,
  state: SettledDispatchState,
  attempt: SendAttempt,
): Promise<SendJournal> {
  const result = await dependencies.store.transitionSend({
    sendId: journal.id,
    expectedState: 'dispatching',
    state,
    updatedAt: dependencies.now(),
    attempt,
  });
  return result.journal;
}

/** Provider accepted the turn; the send now waits for transcript proof (or a session to watch). */
async function recordSubmission(
  dependencies: DispatchDependencies,
  journal: SendJournal,
  attempt: SendAttempt,
  effect: Extract<ProviderDispatchResult, { ok: true }>,
  sessionId: ProviderSessionId | undefined,
): Promise<DispatchOutcome> {
  const state: SettledDispatchState = sessionId === undefined
    ? 'awaiting-session-assignment'
    : 'awaiting-transcript';
  const recorded = await transitionFromDispatching(dependencies, journal, state, {
    ...attempt,
    state,
    dispatchedAt: effect.dispatchedAt,
    submission: effect.certainty,
  });
  return { ok: true, journal: recorded, ...present('response', effect.response) };
}

/** Provider refused the turn outright, so nothing may have been delivered. */
async function recordRefusal(
  dependencies: DispatchDependencies,
  journal: SendJournal,
  attempt: SendAttempt,
  effect: Extract<ProviderDispatchResult, { ok: false }>,
): Promise<DispatchOutcome> {
  const recorded = await transitionFromDispatching(dependencies, journal, 'failed', {
    ...attempt,
    state: 'failed',
    failure: `${effect.code}: ${effect.message}`,
  });
  return { ok: true, journal: recorded };
}

/** The effect threw, so delivery is unknowable from here — only the transcript can settle it. */
async function recordUncertainty(
  dependencies: DispatchDependencies,
  journal: SendJournal,
  attempt: SendAttempt,
  cause: unknown,
): Promise<DispatchOutcome> {
  const recorded = await transitionFromDispatching(dependencies, journal, 'indeterminate', {
    ...attempt,
    state: 'indeterminate',
    failure: cause instanceof Error ? cause.message : String(cause),
  });
  return { ok: true, journal: recorded };
}

/** Runs the one provider effect for a claimed send and records how it ended. */
async function runProviderEffect(
  dependencies: DispatchDependencies,
  journal: SendJournal,
  attempt: SendAttempt,
  sessionId: ProviderSessionId | undefined,
  session: ProviderSession | undefined,
): Promise<DispatchOutcome> {
  dependencies.trace?.({
    stage: 'send.dispatch-started',
    sendId: journal.id,
    ...present('sessionId', sessionId),
  });
  try {
    const effect = await dependencies.providerSend.dispatch({
      sendId: journal.id,
      targetAgentId: journal.targetAgentId,
      text: journal.request.text,
      ...present('resumeId', session?.resumeId),
      ...present('screenContext', journal.request.screenContext),
    });
    const settled = effect.ok
      ? await recordSubmission(dependencies, journal, attempt, effect, sessionId)
      : await recordRefusal(dependencies, journal, attempt, effect);
    dependencies.trace?.({
      stage: 'send.dispatch-settled',
      sendId: journal.id,
      detail: settled.ok ? settled.journal.state : 'refused',
    });
    return settled;
  } catch (cause) {
    const uncertain = await recordUncertainty(dependencies, journal, attempt, cause);
    dependencies.trace?.({
      stage: 'send.dispatch-settled',
      sendId: journal.id,
      detail: 'indeterminate',
    });
    return uncertain;
  }
}

/**
 * Hands one accepted send to the provider and records the outcome on the
 * journal. The claim transition runs before the provider call, so if two
 * workers race the same send only one effect ever leaves the process; the
 * loser gets the journal back unchanged. A refused effect is recorded as
 * failed, while a thrown error is recorded as indeterminate because the
 * provider may or may not have received the message.
 */
export async function dispatchAcceptedSend(
  dependencies: DispatchDependencies,
  journal: SendJournal,
): Promise<DispatchOutcome> {
  if (journal.state !== 'accepted') return { ok: true, journal };
  const agent = await dependencies.agentDirectory.get(journal.targetAgentId);
  if (agent === null) {
    return {
      ok: false,
      rejection: {
        code: 'unknown-target-agent',
        targetAgentId: journal.targetAgentId,
        message: `Unknown target Agent ${journal.targetAgentId}`,
      },
    };
  }
  const sessionId = journal.targetSessionId ?? agent.currentProviderSessionId ?? undefined;
  const session = await sessionFor(dependencies.store, sessionId);
  const attempt: SendAttempt = {
    attemptId: mintSendAttemptId(journal.id, journal.attempts.length),
    state: 'claimed',
    dispatchedAt: dependencies.now(),
    correlationHint: messageCorrelationHint(journal.request.text),
    ...present('sourceFence', await sourceFenceFor(dependencies.store, session)),
  };
  const claimed = await dependencies.store.transitionSend({
    sendId: journal.id,
    expectedState: 'accepted',
    state: 'dispatching',
    updatedAt: attempt.dispatchedAt,
    attempt,
  });
  if (!claimed.changed) return { ok: true, journal: claimed.journal };
  return runProviderEffect(dependencies, journal, attempt, sessionId, session);
}
