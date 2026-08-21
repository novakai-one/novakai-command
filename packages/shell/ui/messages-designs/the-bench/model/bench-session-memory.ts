import { z } from 'zod';
import type {
  BenchConversationFrame,
  BenchInspectionTrail,
  BenchSessionSnapshot,
  BenchTrailStep,
} from './bench-model';

const BENCH_SESSION_STORAGE_KEY = 'novakai:messages:the-bench:session:v1';

const relationSchema = z.enum([
  'belongsTo', 'contains', 'assignedTo', 'assigned', 'requests', 'requestedBy',
  'occupiedBy', 'occupies', 'attempts', 'attemptedBy', 'pursues', 'pursuedBy',
  'produces', 'producedBy', 'cites', 'citedBy', 'discusses', 'discussedIn',
  'references', 'referencedBy', 'blocks', 'blockedBy', 'resolves', 'resolvedBy',
  'raisedAgainst', 'hasIssue', 'about', 'notified', 'createdFrom', 'originOf',
  'staffedBy', 'pins', 'pinnedBy',
]);

const trailStepSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['relations', 'object']),
  parentStepId: z.string().min(1).nullable(),
  recordId: z.string().min(1).nullable(),
  relation: relationSchema.nullable(),
  siblingOrder: z.number().int().nonnegative().optional(),
}).strict();

const trailSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  rootMessageId: z.string().min(1),
  steps: z.array(trailStepSchema),
}).strict();

const frameSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  conversationIds: z.array(z.string().min(1)),
}).strict();

const storedBenchSessionSchema = z.object({
  schemaVersion: z.literal(1),
  session: z.object({
    openThreadIds: z.array(z.string().min(1)),
    trails: z.array(trailSchema),
    frames: z.array(frameSchema),
    scrollTopByThreadId: z.record(z.string(), z.number().finite().nonnegative()),
    focusedThreadId: z.string().min(1).nullable(),
    pendingDraft: z.object({ id: z.string().min(1) }).strict().nullable().optional(),
  }).strict(),
}).strict();

type StoredBenchSessionV1 = z.infer<typeof storedBenchSessionSchema>;
type PersistenceBackend = 'browser' | 'volatile';

let backend: PersistenceBackend = 'browser';
let volatileSession: BenchSessionSnapshot | null = null;

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function copyTrail(trail: BenchInspectionTrail): BenchInspectionTrail {
  return {
    ...trail,
    steps: trail.steps.map((step) => ({ ...step })),
  };
}

function copyFrame(frame: BenchConversationFrame): BenchConversationFrame {
  return {
    ...frame,
    conversationIds: [...frame.conversationIds],
  };
}

function copySnapshot(snapshot: BenchSessionSnapshot): BenchSessionSnapshot {
  return {
    openThreadIds: [...snapshot.openThreadIds],
    trails: snapshot.trails.map(copyTrail),
    frames: snapshot.frames.map(copyFrame),
    scrollTopByThreadId: { ...snapshot.scrollTopByThreadId },
    focusedThreadId: snapshot.focusedThreadId,
    pendingDraft: snapshot.pendingDraft ? { ...snapshot.pendingDraft } : null,
  };
}

function normalizedTrailSteps(
  trail: StoredBenchSessionV1['session']['trails'][number],
): BenchTrailStep[] {
  const seenIds = new Set<string>();
  const retainedIds = new Set<string>();
  const usedOrdersByParent = new Map<string, Set<number>>();
  const siblingCountByParent = new Map<string, number>();
  const steps: BenchTrailStep[] = [];
  let hasRoot = false;

  for (const step of trail.steps) {
    if (seenIds.has(step.id)) continue;
    seenIds.add(step.id);
    if (!step.recordId) continue;

    const isRoot = step.kind === 'relations'
      && step.parentStepId === null
      && step.recordId === trail.rootMessageId
      && !hasRoot;
    const isChild = step.kind === 'object'
      && step.parentStepId !== null
      && retainedIds.has(step.parentStepId);
    if (!isRoot && !isChild) continue;

    const parentKey = step.parentStepId ?? '__root__';
    const siblingCount = siblingCountByParent.get(parentKey) ?? 0;
    siblingCountByParent.set(parentKey, siblingCount + 1);
    const usedOrders = usedOrdersByParent.get(parentKey) ?? new Set<number>();
    let siblingOrder = isRoot ? 0 : (step.siblingOrder ?? siblingCount);
    while (usedOrders.has(siblingOrder)) siblingOrder += 1;
    usedOrders.add(siblingOrder);
    usedOrdersByParent.set(parentKey, usedOrders);

    steps.push({
      id: step.id,
      kind: step.kind,
      parentStepId: step.parentStepId,
      recordId: step.recordId,
      relation: step.relation,
      siblingOrder,
    });
    retainedIds.add(step.id);
    if (isRoot) hasRoot = true;
  }
  return steps;
}

function normalizedSession(stored: StoredBenchSessionV1['session']): BenchSessionSnapshot {
  const trailIds = new Set<string>();
  const frameIds = new Set<string>();
  const framedConversationIds = new Set<string>();
  return {
    openThreadIds: unique(stored.openThreadIds),
    trails: stored.trails
      .filter((trail) => {
        if (trailIds.has(trail.id)) return false;
        trailIds.add(trail.id);
        return true;
      })
      .map((trail) => ({ ...trail, steps: normalizedTrailSteps(trail) }))
      .filter((trail) => trail.steps.length > 0),
    frames: stored.frames
      .filter((frame) => {
        if (frameIds.has(frame.id)) return false;
        frameIds.add(frame.id);
        return true;
      })
      .map((frame) => ({
        ...frame,
        conversationIds: unique(frame.conversationIds).filter((conversationId) => {
          if (framedConversationIds.has(conversationId)) return false;
          framedConversationIds.add(conversationId);
          return true;
        }),
      })),
    scrollTopByThreadId: { ...stored.scrollTopByThreadId },
    focusedThreadId: stored.focusedThreadId,
    pendingDraft: stored.pendingDraft ? { ...stored.pendingDraft } : null,
  };
}

function removeInvalidBrowserSnapshot(): void {
  try {
    window.localStorage.removeItem(BENCH_SESSION_STORAGE_KEY);
  } catch {
    backend = 'volatile';
  }
}

/** Reads and validates the cumulative semantic Bench session through one owned seam. */
export function readBenchSession(): BenchSessionSnapshot | null {
  if (backend === 'volatile' || typeof window === 'undefined') {
    return volatileSession ? copySnapshot(volatileSession) : null;
  }

  try {
    const raw = window.localStorage.getItem(BENCH_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = storedBenchSessionSchema.safeParse(JSON.parse(raw) as unknown);
    if (!parsed.success) {
      removeInvalidBrowserSnapshot();
      return null;
    }
    return normalizedSession(parsed.data.session);
  } catch (error) {
    if (error instanceof SyntaxError) {
      removeInvalidBrowserSnapshot();
      return null;
    }
    backend = 'volatile';
    return volatileSession ? copySnapshot(volatileSession) : null;
  }
}

/** Remembers semantic Bench state without coordinates, viewport, search, markers or Zen. */
export function rememberBenchSession(snapshot: BenchSessionSnapshot): void {
  const copy = copySnapshot(snapshot);
  if (backend === 'volatile' || typeof window === 'undefined') {
    volatileSession = copy;
    return;
  }

  try {
    const stored: StoredBenchSessionV1 = {
      schemaVersion: 1,
      session: {
        openThreadIds: [...copy.openThreadIds],
        trails: copy.trails.map((trail) => ({
          ...trail,
          steps: trail.steps.map((step) => ({ ...step })),
        })),
        frames: copy.frames.map((frame) => ({
          ...frame,
          conversationIds: [...frame.conversationIds],
        })),
        scrollTopByThreadId: { ...copy.scrollTopByThreadId },
        focusedThreadId: copy.focusedThreadId,
        pendingDraft: copy.pendingDraft ? { ...copy.pendingDraft } : null,
      },
    };
    window.localStorage.setItem(BENCH_SESSION_STORAGE_KEY, JSON.stringify(stored));
  } catch {
    backend = 'volatile';
    volatileSession = copy;
  }
}
