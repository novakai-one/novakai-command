import type { SpineFailpointError } from '../contract/errors.js';

export type SpineJournalPhase = 'before' | 'after';

export function journalFailpointName(
  state: 'accepted' | 'running' | 'done' | 'failed' | 'abandoned',
  step: 0 | 1 | 2,
  phase: SpineJournalPhase,
): string {
  if (state === 'accepted' || state === 'abandoned') {
    return `spine.journal.${state}.${phase}`;
  }
  return `spine.journal.step${step}.${state}.${phase}`;
}

export function effectFailpointName(
  step: 1 | 2,
  phase: 'before' | 'after',
): string {
  return `spine.effect.step${step}.${phase}`;
}

export function hitFailpoint(
  configured: string | undefined,
  point: string,
  workflowId: string,
): SpineFailpointError | null {
  if (configured !== point) return null;
  return {
    code: 'SpineFailpoint',
    message: `injected Spine failure at ${point}`,
    details: { point, workflowId },
    retryable: true,
  };
}
