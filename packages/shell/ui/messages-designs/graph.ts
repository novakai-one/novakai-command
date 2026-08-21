/**
 * The deep module: records in, typed relationships out.
 *
 * Rooms ask `related(id)` and get meaning back. They never read a `refs` array, never
 * know that a stage stores its parent in `parentStageId` while a task stores its parent
 * in a ref, and never build a reverse lookup of their own. Deleting this module would
 * push all three of those into every Room, which is the test that it earns its place.
 */
import type {
  ObjectId,
  ObjectKind,
  ObjectRecord,
  Related,
  RelationType,
} from './contract';

/** Forward relation and its reverse, for one (from-kind, to-kind) pair. */
type Pair = readonly [RelationType, RelationType];

const CONTAINMENT: Pair = ['belongsTo', 'contains'];

/**
 * What a stored reference means, by the kind that holds it and the kind it points at.
 *
 * A missing entry falls through to `references` / `referencedBy`, which is the honest
 * default: we know the two objects are connected, and we do not claim to know how.
 */
const REF_MEANING: Record<string, Pair> = {
  'mission>project': CONTAINMENT,
  'mission>template': ['createdFrom', 'originOf'],
  'task>stage': CONTAINMENT,
  'task>mission': CONTAINMENT,
  'task>task': CONTAINMENT,
  'task>role': ['assignedTo', 'assigned'],
  'task>agent': ['assignedTo', 'assigned'],
  'team>mission': ['belongsTo', 'staffedBy'],
  'agent>mission': ['belongsTo', 'staffedBy'],
  'artifact>mission': ['producedBy', 'produces'],
  'artifact>task': ['producedBy', 'produces'],
  'artifact>step': ['producedBy', 'produces'],
  'artifact>agent': ['producedBy', 'produces'],
  'evidence>artifact': ['cites', 'citedBy'],
  'evidence>task': ['cites', 'citedBy'],
  'evidence>mission': ['cites', 'citedBy'],
  'thread>mission': ['discusses', 'discussedIn'],
  'thread>agent': ['discusses', 'discussedIn'],
  'request>task': ['blocks', 'blockedBy'],
  'request>mission': ['blocks', 'blockedBy'],
  'request>agent': ['blocks', 'blockedBy'],
  'decision>mission': ['resolves', 'resolvedBy'],
  'decision>request': ['resolves', 'resolvedBy'],
  'issue>mission': ['raisedAgainst', 'hasIssue'],
  'issue>task': ['raisedAgainst', 'hasIssue'],
  'notification>request': ['about', 'notified'],
  'notification>agent': ['about', 'notified'],
  'notification>mission': ['about', 'notified'],
  'notification>thread': ['about', 'notified'],
  'pin>mission': ['pins', 'pinnedBy'],
  'pin>agent': ['pins', 'pinnedBy'],
  'pin>project': ['pins', 'pinnedBy'],
  'pin>agentRoleProfile': ['pins', 'pinnedBy'],
};

/**
 * Relationships a store spells as a plain field rather than a ref.
 *
 * `[field, forward, reverse]` per kind. This is where the bespoke-identifier stores
 * rejoin the same typed vocabulary as everything else.
 */
const FIELD_EDGES: Partial<Record<ObjectKind, readonly (readonly [string, RelationType, RelationType])[]>> = {
  stage: [
    ['missionId', 'belongsTo', 'contains'],
    ['parentStageId', 'belongsTo', 'contains'],
  ],
  teamSeat: [
    ['teamId', 'belongsTo', 'contains'],
    ['roleProfileId', 'requests', 'requestedBy'],
    ['agentId', 'occupiedBy', 'occupies'],
  ],
  agentRun: [
    ['agentId', 'belongsTo', 'contains'],
    ['taskId', 'attempts', 'attemptedBy'],
  ],
  loop: [
    ['agentRunId', 'belongsTo', 'contains'],
    ['taskId', 'pursues', 'pursuedBy'],
  ],
  step: [['loopId', 'belongsTo', 'contains']],
  message: [
    ['threadId', 'belongsTo', 'contains'],
    ['senderId', 'producedBy', 'produces'],
  ],
  request: [['decision', 'resolvedBy', 'resolves']],
};

export type ObjectGraph = {
  readonly all: readonly ObjectRecord[];
  get(id: ObjectId): ObjectRecord | undefined;
  byKind(kind: ObjectKind): readonly ObjectRecord[];
  related(id: ObjectId): readonly Related[];
  relatedBy(id: ObjectId, relation: RelationType): readonly ObjectRecord[];
  /** Related records of one relation, narrowed to one kind. The Rooms' workhorse. */
  relatedOfKind(id: ObjectId, relation: RelationType, kind: ObjectKind): readonly ObjectRecord[];
};

/** Reads a field the graph knows is an identifier, ignoring nulls and non-strings. */
function idField(record: ObjectRecord, field: string): string | null {
  const value = record.fields[field];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function buildGraph(records: readonly ObjectRecord[]): ObjectGraph {
  const byId = new Map<ObjectId, ObjectRecord>();
  const byKind = new Map<ObjectKind, ObjectRecord[]>();
  const edges = new Map<ObjectId, Related[]>();

  for (const record of records) {
    byId.set(record.id, record);
    const bucket = byKind.get(record.kind);
    if (bucket) bucket.push(record);
    else byKind.set(record.kind, [record]);
  }

  /** Records both directions at once, so no consumer has to store a duplicate list. */
  const link = (from: ObjectId, to: ObjectId, pair: Pair): void => {
    const source = byId.get(from);
    const target = byId.get(to);
    if (!source || !target || source === target) return;
    const forward = edges.get(from) ?? [];
    forward.push({ relation: pair[0], record: target });
    edges.set(from, forward);
    const back = edges.get(to) ?? [];
    back.push({ relation: pair[1], record: source });
    edges.set(to, back);
  };

  for (const record of records) {
    for (const [field, forward, reverse] of FIELD_EDGES[record.kind] ?? []) {
      const target = idField(record, field);
      if (target) link(record.id, target, [forward, reverse]);
    }
    for (const ref of record.refs) {
      const target = byId.get(ref.value);
      if (!target) continue;
      const meaning =
        REF_MEANING[`${record.kind}>${ref.kind}`] ??
        REF_MEANING[`${record.kind}>${target.kind}`] ??
        (['references', 'referencedBy'] as Pair);
      link(record.id, ref.value, meaning);
    }
  }

  const relatedOf = (id: ObjectId): readonly Related[] => edges.get(id) ?? [];

  return {
    all: records,
    get: (id) => byId.get(id),
    byKind: (kind) => byKind.get(kind) ?? [],
    related: relatedOf,
    relatedBy: (id, relation) =>
      relatedOf(id)
        .filter((entry) => entry.relation === relation)
        .map((entry) => entry.record),
    relatedOfKind: (id, relation, kind) =>
      relatedOf(id)
        .filter((entry) => entry.relation === relation && entry.record.kind === kind)
        .map((entry) => entry.record),
  };
}

/** Stages that hang directly off the Mission — the plumb line's sequence. */
export function rootStages(graph: ObjectGraph, missionId: ObjectId): ObjectRecord[] {
  return graph
    .relatedOfKind(missionId, 'contains', 'stage')
    .filter((stage) => !stage.fields.parentStageId)
    .slice()
    .sort((a, b) => Number(a.fields.order ?? 0) - Number(b.fields.order ?? 0));
}

/** A Stage's immediate internal structure — what `Show on canvas` reveals. */
export function childStages(graph: ObjectGraph, stageId: ObjectId): ObjectRecord[] {
  return graph
    .relatedOfKind(stageId, 'contains', 'stage')
    .filter((stage) => stage.fields.parentStageId === stageId)
    .slice()
    .sort((a, b) => Number(a.fields.order ?? 0) - Number(b.fields.order ?? 0));
}

/** Reads a string field for display. Presentation only; never a join. */
export function field(record: ObjectRecord | undefined, name: string): string {
  const value = record?.fields[name];
  return typeof value === 'string' ? value : '';
}
