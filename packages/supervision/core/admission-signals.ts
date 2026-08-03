import {
  b3err, b3fail, b3ok,
  type AuthenticatedPrincipal, type B3Result, type EventCursor,
} from '@novakai/foundation/contract';
import type {
  WatchEvaluationProgress, WatchRuleAdmissionEvent,
} from '../contract/index.js';
import type { SupervisionStore } from './store.js';
import { authorizeWatchRepair } from './watch-evaluation-progress.js';

interface AdmissionCandidate {
  readonly cursorKey: string;
  readonly event: WatchRuleAdmissionEvent;
}

function admissionCursor(occurredAt: string, eventId: string): EventCursor {
  return `watchAdmission:${occurredAt}:${eventId}` as EventCursor;
}

function admissionCursorKey(cursor: EventCursor | undefined): string | null {
  if (cursor === undefined) return '';
  const encodedCursor = String(cursor);
  if (!encodedCursor.startsWith('watchAdmission:')) return null;
  const marker = encodedCursor.lastIndexOf(':event_');
  return marker < 0
    ? null
    : `${encodedCursor.slice('watchAdmission:'.length, marker)}`
      + `\u0000${encodedCursor.slice(marker + 1)}`;
}

function admissionCandidates(
  progressRows: readonly WatchEvaluationProgress[],
): readonly AdmissionCandidate[] {
  return progressRows.flatMap((progress) => progress.completed.flatMap((entry) => {
    if (entry.outcome.kind !== 'pair-not-admitted') return [];
    const outcome = entry.outcome;
    return [{
      cursorKey: `${String(outcome.signalOccurredAt)}\u0000${outcome.signalEventId}`,
      event: {
        eventId: outcome.signalEventId,
        kind: 'supervision.watch-rule-admission.changed' as const,
        schemaVersion: 1 as const,
        occurredAt: outcome.signalOccurredAt,
        committedAt: outcome.signalOccurredAt,
        sourceOwner: 'supervision' as const,
        traceId: outcome.signalTraceId,
        cursor: admissionCursor(outcome.signalOccurredAt, outcome.signalEventId),
        payload: {
          watchEvaluationId: progress.id,
          watchRuleId: entry.watchRuleId,
          evaluatedRecordVersion: entry.evaluatedRecordVersion,
          subject: outcome.subject,
          condition: outcome.condition,
          reason: outcome.reason,
        },
      },
    }];
  })).sort((left, right) => left.cursorKey.localeCompare(right.cursorKey));
}

function prepareSubscription(
  principal: AuthenticatedPrincipal,
  after: EventCursor | undefined,
): B3Result<string> {
  const access = authorizeWatchRepair(principal);
  if (!access.ok) return access;
  const cursorKey = admissionCursorKey(after);
  return cursorKey === null
    ? b3fail(b3err(
        'CursorExpired', 'the watch-admission cursor is not recognized',
        { newestCursor: null, reason: 'cursor was not minted by this signal stream' }, false,
      ))
    : b3ok(cursorKey);
}

function isUndelivered(
  candidate: AdmissionCandidate,
  deliveredCursorKey: string,
  emitted: ReadonlySet<string>,
): boolean {
  return candidate.cursorKey > deliveredCursorKey
    && !emitted.has(candidate.event.eventId);
}

/** Durable replay plus live tail for persisted R-pair operator signals. */
export async function* subscribeWatchRuleAdmissionSignals(
  store: SupervisionStore,
  principal: AuthenticatedPrincipal,
  after?: EventCursor,
): AsyncIterable<B3Result<WatchRuleAdmissionEvent>> {
  const prepared = prepareSubscription(principal, after);
  if (!prepared.ok) {
    yield prepared;
    return;
  }
  let deliveredCursorKey = prepared.value;
  const emitted = new Set<string>();
  for (;;) {
    const listed = await store.list<WatchEvaluationProgress>('watchEvaluation');
    if (!listed.ok) {
      yield listed;
      return;
    }
    let delivered = false;
    for (const candidate of admissionCandidates(listed.value)) {
      if (!isUndelivered(candidate, deliveredCursorKey, emitted)) continue;
      emitted.add(candidate.event.eventId);
      deliveredCursorKey = candidate.cursorKey;
      delivered = true;
      yield b3ok(candidate.event);
    }
    if (delivered) continue;
    await new Promise<void>((resolve) => { setTimeout(resolve, 25); });
  }
}
