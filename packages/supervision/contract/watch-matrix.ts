import type { VersionedRef } from './policy.js';
import type { WatchCondition, WatchSubject } from './records.js';

export type WatchOccurrenceFamily = 'L' | 'AR' | 'EV' | 'OP' | 'A-03' | 'R';

export interface WatchPairIssue {
  readonly issue: string;
  readonly subjectKind: WatchSubject['kind'];
  readonly conditionKind: WatchCondition['kind'];
  readonly templateRef?: VersionedRef;
}

const USAGE = new Set<WatchCondition['kind']>([
  'turn-count-at-least',
  'input-tokens-at-least',
  'output-tokens-at-least',
  'cost-micros-at-least',
]);

/** The exhaustive B3V4-AMD-003 WatchSubject × WatchCondition matrix. */
export function watchOccurrenceFamily(
  subject: WatchSubject,
  condition: WatchCondition,
): WatchOccurrenceFamily {
  if (USAGE.has(condition.kind)) return subject.kind === 'agent-run' ? 'L' : 'AR';
  if (condition.kind === 'idle-for-ms') return subject.kind === 'agent-run' ? 'L' : 'R';
  if (condition.kind === 'activity-drift') return subject.kind === 'agent-run' ? 'A-03' : 'R';
  if (condition.kind === 'run-disconnected') return subject.kind === 'agent-run' ? 'L' : 'EV';
  if (condition.kind === 'run-final') return subject.kind === 'agent-run' ? 'L' : 'AR';
  if (condition.kind === 'child-needs-help') return 'EV';
  if (condition.kind === 'operation-failed') return 'OP';
  return 'R';
}

/** Machine-readable rejection shared by install, create, and update. */
export function watchPairIssue(
  subject: WatchSubject,
  condition: WatchCondition,
  templateRef?: VersionedRef,
): WatchPairIssue | null {
  if (watchOccurrenceFamily(subject, condition) !== 'R') return null;
  return {
    issue: condition.kind === 'activity-drift'
      ? 'activity-drift is admitted only for an exact agent-run subject'
      : 'the subject has no single authoritative Run-local clock for this condition',
    subjectKind: subject.kind,
    conditionKind: condition.kind,
    ...(templateRef === undefined ? {} : { templateRef }),
  };
}
