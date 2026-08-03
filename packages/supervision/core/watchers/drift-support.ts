import { createHash } from 'node:crypto';
import {
  b3err,
  b3fail,
  b3ok,
  deriveClientOpId,
  type ActivityGeneration,
  type AgentId,
  type AgentRunId,
  type B3Result,
  type IsoUtc,
} from '@novakai/foundation/contract';
import {
  SUPERVISION_RECORD_WRITER,
  type CheckRunDriftInput,
  type DriftEvidenceCheckpoint,
  type DurableDriftState,
  type WatchDeadline,
  type WatchRule,
} from '../../contract/index.js';
import type { SupervisionStore } from '../store.js';

/** Activity-bearing facts read from their owning capabilities at check time. */
export interface DriftEvidenceObservation {
  readonly agentId: AgentId;
  readonly terminalLiveness: 'live' | 'exited' | 'unknown';
  readonly terminalActivityGeneration: ActivityGeneration;
  readonly transcriptWatermark?: string;
  readonly usageActivityDigest?: string;
  readonly usageSourceCursor?: string;
  readonly evidenceRefs: readonly string[];
  readonly replyEvidenceRef?: string;
}

/** Host seam joining Terminal, Transcript, and usage truth without private imports. */
export interface DriftEvidencePort {
  observe(agentRunId: AgentRunId): Promise<B3Result<DriftEvidenceObservation>>;
}

export interface DriftDependencies {
  readonly store: SupervisionStore;
  readonly evidence: DriftEvidencePort;
  readonly clock: () => Date;
}

export interface CurrentDrift {
  readonly rule: WatchRule;
  readonly deadline: WatchDeadline;
}

export const watcherConflict = (
  message: string,
  details: Readonly<Record<string, unknown>>,
) => b3err('WatcherConflict', message, details, true);

/** Stable scalar over only the activity-bearing fields named by §9.2 step 1. */
export function driftEvidenceFingerprint(
  evidence: Omit<DriftEvidenceObservation, 'agentId' | 'evidenceRefs' | 'replyEvidenceRef'>,
): string {
  const scalar = [
    'b3v4',
    'activity-drift-evidence',
    evidence.terminalLiveness,
    String(evidence.terminalActivityGeneration),
    evidence.transcriptWatermark ?? '-',
    evidence.usageActivityDigest ?? '-',
    evidence.usageSourceCursor ?? '-',
  ].join('\u001f');
  return createHash('sha256').update(scalar, 'utf8').digest('hex');
}

export function evidenceCheckpoint(
  observation: DriftEvidenceObservation,
  checkedAt: IsoUtc,
): DriftEvidenceCheckpoint {
  return {
    fingerprint: driftEvidenceFingerprint(observation),
    terminalLiveness: observation.terminalLiveness,
    terminalActivityGeneration: observation.terminalActivityGeneration,
    ...(observation.transcriptWatermark === undefined
      ? {}
      : { transcriptWatermark: observation.transcriptWatermark }),
    ...(observation.usageActivityDigest === undefined
      ? {}
      : { usageActivityDigest: observation.usageActivityDigest }),
    ...(observation.usageSourceCursor === undefined
      ? {}
      : { usageSourceCursor: observation.usageSourceCursor }),
    evidenceRefs: observation.evidenceRefs,
    checkedAt,
  };
}

export function movementEvidenceRef(
  observed: DriftEvidenceObservation,
  nextEvidence: DriftEvidenceCheckpoint,
): string {
  return observed.replyEvidenceRef
    ?? observed.evidenceRefs[0]
    ?? 'drift-fingerprint:' + nextEvidence.fingerprint;
}

export async function loadCurrentDrift(
  deps: DriftDependencies,
  input: CheckRunDriftInput,
): Promise<B3Result<CurrentDrift>> {
  const [rule, deadline] = await Promise.all([
    deps.store.read<WatchRule>('watchRule', input.watchRuleId),
    deps.store.read<WatchDeadline>('watchDeadline', input.dueDeadlineId),
  ]);
  if (!rule.ok) return b3fail(rule.error);
  if (!deadline.ok) return b3fail(deadline.error);
  if (rule.value === null || deadline.value === null) {
    return b3fail(watcherConflict('the drift rule or deadline no longer exists', {
      watchRuleId: input.watchRuleId,
      watchDeadlineId: input.dueDeadlineId,
    }));
  }
  const current = deadline.value;
  const subjectMatches = rule.value.subject.kind === 'agent-run'
    && rule.value.subject.agentRunId === input.agentRunId;
  const matches = current.watchRuleId === input.watchRuleId
    && subjectMatches
    && current.activityGeneration === input.expectedActivityGeneration
    && Number(current.recordVersion) === Number(input.expectedDeadlineRecordVersion)
    && rule.value.condition.kind === 'activity-drift'
    && current.driftState !== undefined
    && current.state !== 'fired'
    && current.state !== 'superseded';
  if (!matches) {
    return b3fail(watcherConflict('the drift check fence does not match current durable truth', {
      watchRuleId: input.watchRuleId,
      watchDeadlineId: input.dueDeadlineId,
      expectedActivityGeneration: input.expectedActivityGeneration,
      actualActivityGeneration: current.activityGeneration,
      expectedRecordVersion: input.expectedDeadlineRecordVersion,
      actualRecordVersion: current.recordVersion,
    }));
  }
  return b3ok({ rule: rule.value, deadline: current });
}

function rearmedDueAt(now: Date, rule: WatchRule): IsoUtc {
  if (rule.condition.kind !== 'activity-drift') {
    throw new TypeError('activity-drift reducer received a non-drift rule');
  }
  return new Date(now.getTime() + rule.condition.intervalMs).toISOString() as IsoUtc;
}

export async function persistDrift(
  deps: DriftDependencies,
  current: CurrentDrift,
  state: DurableDriftState,
  now: Date,
  dueAt: IsoUtc = rearmedDueAt(now, current.rule),
): Promise<B3Result<WatchDeadline>> {
  return deps.store.update<WatchDeadline>(
    SUPERVISION_RECORD_WRITER,
    current.deadline.id,
    { state: 'armed', dueAt, driftState: state },
    current.deadline.recordVersion,
    deriveClientOpId(
      'b3v4:check-run-drift:' + current.deadline.id + ':' + current.deadline.recordVersion,
    ),
  );
}
