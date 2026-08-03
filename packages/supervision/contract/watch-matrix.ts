import type { VersionedRef } from './policy.js';
import type { WatchCondition, WatchSubject } from './records.js';

export type WatchOccurrenceFamily = 'L' | 'AR' | 'EV' | 'OP' | 'A-03' | 'R';

export interface WatchPairIssue {
  readonly issue: string;
  readonly subjectKind: WatchSubject['kind'];
  readonly conditionKind: WatchCondition['kind'];
  readonly templateRef?: VersionedRef;
}

type SubjectKind = WatchSubject['kind'];
type ConditionKind = WatchCondition['kind'];

const FAMILY_BY_CONDITION: Readonly<Record<
ConditionKind, Readonly<Record<SubjectKind, WatchOccurrenceFamily>>
>> = {
  'turn-count-at-least': { 'agent-run': 'L', agent: 'AR', 'children-of': 'AR' },
  'input-tokens-at-least': { 'agent-run': 'L', agent: 'AR', 'children-of': 'AR' },
  'output-tokens-at-least': { 'agent-run': 'L', agent: 'AR', 'children-of': 'AR' },
  'cost-micros-at-least': { 'agent-run': 'L', agent: 'AR', 'children-of': 'AR' },
  'idle-for-ms': { 'agent-run': 'L', agent: 'R', 'children-of': 'R' },
  'activity-drift': { 'agent-run': 'A-03', agent: 'R', 'children-of': 'R' },
  'run-disconnected': { 'agent-run': 'L', agent: 'EV', 'children-of': 'EV' },
  'run-final': { 'agent-run': 'L', agent: 'AR', 'children-of': 'AR' },
  'child-needs-help': { 'agent-run': 'EV', agent: 'EV', 'children-of': 'EV' },
  'operation-failed': { 'agent-run': 'OP', agent: 'OP', 'children-of': 'OP' },
};

/** The exhaustive B3V4-AMD-003 WatchSubject × WatchCondition matrix. */
export function watchOccurrenceFamily(
  subject: WatchSubject,
  condition: WatchCondition,
): WatchOccurrenceFamily {
  return FAMILY_BY_CONDITION[condition.kind][subject.kind];
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
