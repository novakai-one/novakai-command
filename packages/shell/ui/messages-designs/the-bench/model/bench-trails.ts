import type {
  BenchAction,
  BenchInspectionTrail,
  BenchSessionSnapshot,
  BenchTrailStep,
  BenchTrailStepId,
} from './bench-model';

type TrailAction = Extract<BenchAction, {
  type:
    | 'inspect-message'
    | 'expand-message-relation'
    | 'expand-relation'
    | 'close-trail-step'
    | 'append-decision';
}>;

function trailIdentity(threadId: string, messageId: string): string {
  return `trail:${threadId}:${messageId}`;
}

function relationStepIdentity(trailId: string): string {
  return `${trailId}:relations`;
}

function objectStepIdentity(
  parentStepId: BenchTrailStepId,
  relation: string,
  recordId: string,
): string {
  return `${parentStepId}:${relation}:${recordId}`;
}

function nextSiblingOrder(
  steps: readonly BenchTrailStep[],
  parentStepId: BenchTrailStepId,
): number {
  return steps.reduce((next, step) => (
    step.parentStepId === parentStepId ? Math.max(next, step.siblingOrder + 1) : next
  ), 0);
}

function createRelationsStep(trailId: string, messageId: string): BenchTrailStep {
  return {
    id: relationStepIdentity(trailId),
    kind: 'relations',
    parentStepId: null,
    recordId: messageId,
    relation: null,
    siblingOrder: 0,
  };
}

function inspectMessage(
  session: BenchSessionSnapshot,
  threadId: string,
  messageId: string,
): BenchSessionSnapshot {
  const id = trailIdentity(threadId, messageId);
  if (session.trails.some((trail) => trail.id === id)) return session;

  const relationStep = createRelationsStep(id, messageId);
  const trail: BenchInspectionTrail = {
    id,
    threadId,
    rootMessageId: messageId,
    steps: [relationStep],
  };
  return { ...session, trails: [...session.trails, trail] };
}

function expandRelation(
  session: BenchSessionSnapshot,
  action: Extract<BenchAction, { type: 'expand-relation' }>,
): BenchSessionSnapshot {
  const stepId = objectStepIdentity(action.parentStepId, action.relation, action.recordId);
  const trails = session.trails.map((trail) => {
    if (trail.id !== action.trailId
      || !trail.steps.some((step) => step.id === action.parentStepId)
      || trail.steps.some((step) => step.id === stepId)) return trail;
    return {
      ...trail,
      steps: [...trail.steps, {
        id: stepId,
        kind: 'object' as const,
        parentStepId: action.parentStepId,
        recordId: action.recordId,
        relation: action.relation,
        siblingOrder: nextSiblingOrder(trail.steps, action.parentStepId),
      }],
    };
  });
  return { ...session, trails };
}

type MessageRelationInput = {
  readonly threadId: string;
  readonly messageId: string;
  readonly relation: Extract<BenchAction, { type: 'expand-relation' }>['relation'];
  readonly recordId: string;
};

function expandMessageRelation(
  session: BenchSessionSnapshot,
  input: MessageRelationInput,
): BenchSessionSnapshot {
  const trailId = trailIdentity(input.threadId, input.messageId);
  const existing = session.trails.find((trail) => trail.id === trailId);
  const existingRoot = existing?.steps.find((step) => (
    step.kind === 'relations' && step.parentStepId === null
  ));
  const root = existingRoot ?? createRelationsStep(trailId, input.messageId);
  const steps = existing && existingRoot ? existing.steps : [root];
  const stepId = objectStepIdentity(root.id, input.relation, input.recordId);
  if (steps.some((step) => step.id === stepId)) return session;
  const nextTrail: BenchInspectionTrail = {
    id: trailId,
    threadId: input.threadId,
    rootMessageId: input.messageId,
    steps: [...steps, {
      id: stepId,
      kind: 'object',
      parentStepId: root.id,
      recordId: input.recordId,
      relation: input.relation,
      siblingOrder: nextSiblingOrder(steps, root.id),
    }],
  };
  return {
    ...session,
    trails: existing
      ? session.trails.map((trail) => (trail.id === trailId ? nextTrail : trail))
      : [...session.trails, nextTrail],
  };
}

function appendDecision(
  session: BenchSessionSnapshot,
  action: Extract<BenchAction, { type: 'append-decision' }>,
): BenchSessionSnapshot {
  const preferredTrail = action.context.trailId
    ? session.trails.find((candidate) => candidate.id === action.context.trailId)
    : undefined;
  const preferredRequestStep = action.context.requestStepId
    ? preferredTrail?.steps.find((step) => (
        step.id === action.context.requestStepId && step.recordId === action.context.requestId
      ))
    : undefined;
  const withRequest = preferredRequestStep ? session : expandMessageRelation(session, {
    threadId: action.context.threadId,
    messageId: action.context.rootMessageId,
    relation: action.context.requestRelation,
    recordId: action.context.requestId,
  });
  const trailId = preferredRequestStep
    ? preferredTrail?.id
    : trailIdentity(action.context.threadId, action.context.rootMessageId);
  const trail = withRequest.trails.find((candidate) => candidate.id === trailId);
  const requestStep = preferredRequestStep ?? trail?.steps.find((step) => (
    step.parentStepId === relationStepIdentity(trail?.id ?? '')
    && step.recordId === action.context.requestId
  ));
  if (!trail || !requestStep) return withRequest;
  const decisionStepId = objectStepIdentity(requestStep.id, 'resolvedBy', action.decisionId);
  if (trail.steps.some((step) => step.id === decisionStepId)) return withRequest;
  const nextTrail = {
    ...trail,
    steps: [...trail.steps, {
      id: decisionStepId,
      kind: 'object' as const,
      parentStepId: requestStep.id,
      recordId: action.decisionId,
      relation: 'resolvedBy' as const,
      siblingOrder: nextSiblingOrder(trail.steps, requestStep.id),
    }],
  };
  return {
    ...withRequest,
    trails: withRequest.trails.map((candidate) => (
      candidate.id === trailId ? nextTrail : candidate
    )),
  };
}

function descendantStepIds(steps: readonly BenchTrailStep[], rootId: BenchTrailStepId): Set<string> {
  const removed = new Set<string>([rootId]);
  let foundAnother = true;
  while (foundAnother) {
    foundAnother = false;
    for (const step of steps) {
      if (step.parentStepId && removed.has(step.parentStepId) && !removed.has(step.id)) {
        removed.add(step.id);
        foundAnother = true;
      }
    }
  }
  return removed;
}

function closeTrailStep(
  session: BenchSessionSnapshot,
  trailId: string,
  stepId: string,
): BenchSessionSnapshot {
  const trail = session.trails.find((candidate) => candidate.id === trailId);
  if (!trail) return session;
  const removed = descendantStepIds(trail.steps, stepId);
  const remainingSteps = trail.steps.filter((step) => !removed.has(step.id));
  const trails = remainingSteps.length === 0
    ? session.trails.filter((candidate) => candidate.id !== trailId)
    : session.trails.map((candidate) => (
        candidate.id === trailId ? { ...candidate, steps: remainingSteps } : candidate
      ));
  return { ...session, trails };
}

/** Reconciles semantic trail ancestry against the host graph without touching canvas placement. */
export function reconcileInspectionTrails(
  trails: readonly BenchInspectionTrail[],
  action: Extract<BenchAction, { type: 'reconcile-session' }>,
): BenchInspectionTrail[] {
  const messageIds = new Set(action.messageIds);
  const recordIds = new Set(action.recordIds);
  return trails
    .filter((trail) => messageIds.has(trail.rootMessageId))
    .map((trail) => {
      const retainedIds = new Set<string>();
      let hasRoot = false;
      const steps = trail.steps.filter((step) => {
        if (step.kind === 'relations') {
          const validRoot = !hasRoot
            && step.parentStepId === null
            && step.recordId === trail.rootMessageId
            && messageIds.has(step.recordId);
          if (!validRoot) return false;
          hasRoot = true;
          retainedIds.add(step.id);
          return true;
        }
        if (!step.parentStepId || !retainedIds.has(step.parentStepId) || !recordIds.has(step.recordId)) {
          return false;
        }
        retainedIds.add(step.id);
        return true;
      });
      return { ...trail, steps };
    })
    .filter((trail) => trail.steps.length > 0);
}

/** Applies one inspection-trail action as a pure semantic state transition. */
export function reduceInspectionTrails(
  session: BenchSessionSnapshot,
  action: TrailAction,
): BenchSessionSnapshot {
  switch (action.type) {
    case 'inspect-message':
      return inspectMessage(session, action.threadId, action.messageId);
    case 'expand-message-relation':
      return expandMessageRelation(session, action);
    case 'expand-relation':
      return expandRelation(session, action);
    case 'close-trail-step':
      return closeTrailStep(session, action.trailId, action.stepId);
    case 'append-decision':
      return appendDecision(session, action);
  }
}
