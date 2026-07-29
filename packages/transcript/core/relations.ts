import { createHash } from 'node:crypto';
import {
  createObject,
  err,
  getObjectWithReadFailure,
  isAbsent,
  listObjects,
  type ClientOpId,
  type ObjectId,
  type Result,
} from '@novakai/foundation/dist/contract/index.js';
import type { TranscriptError } from '../contract/errors.js';
import {
  TranscriptRelationJournalEntry,
  type TranscriptRelationDelta,
  type TranscriptRelationJournalEntry as TranscriptRelationJournalEntryT,
  type TranscriptRelationState,
  type TranscriptSource as TranscriptSourceT,
  type TranscriptSourceCandidate,
  type TranscriptSourceContext,
} from '../contract/schemas.js';
import type { TranscriptContext } from './composition.js';

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const operationId = (value: string): ClientOpId =>
  `op_${hash(value)}` as ClientOpId;

function invalidRelationRecord(
  id: string,
  issues: Array<{ path: PropertyKey[]; message: string }>,
): TranscriptError {
  return err(
    'TranscriptRecordInvalid',
    `stored transcriptJournal "${id}" does not match the Transcript schema`,
    {
      kind: 'transcriptJournal',
      id,
      issues: issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        reason: issue.message,
      })),
    },
    false,
  );
}

function parseRelationJournal(
  object: unknown,
): Result<TranscriptRelationJournalEntryT, TranscriptError> {
  const parsed = TranscriptRelationJournalEntry.safeParse(object);
  if (parsed.success) return { ok: true, value: parsed.data };
  const record = object as { id?: unknown };
  return {
    ok: false,
    error: invalidRelationRecord(
      String(record?.id ?? '(unknown)'),
      parsed.error.issues,
    ),
  };
}

export function emptyTranscriptRelationState(): TranscriptRelationState {
  return { parents: {}, children: {} };
}

export function applyTranscriptRelationDelta(
  state: TranscriptRelationState,
  delta: TranscriptRelationDelta,
): TranscriptRelationState {
  if (delta.type === 'parent') {
    if (state.parents[delta.parentKey]) return state;
    return {
      parents: {
        ...state.parents,
        [delta.parentKey]: {
          parentTurnId: delta.parentTurnId,
          remainingChildren: delta.remainingChildren,
          ...(delta.parentAgentId
            ? { parentAgentId: delta.parentAgentId }
            : {}),
        },
      },
      children: state.children,
    };
  }

  if (state.children[delta.childKey]) return state;
  const parent = state.parents[delta.parentKey];
  if (!parent) return state;
  const parents = { ...state.parents };
  if (parent.remainingChildren === 1) {
    delete parents[delta.parentKey];
  } else {
    parents[delta.parentKey] = {
      ...parent,
      remainingChildren: parent.remainingChildren - 1,
    };
  }
  return {
    parents,
    children: {
      ...state.children,
      [delta.childKey]: {
        parentTurnId: parent.parentTurnId,
        ...(delta.agentId ? { agentId: delta.agentId } : {}),
        ...(parent.parentAgentId
          ? { parentAgentId: parent.parentAgentId }
          : {}),
      },
    },
  };
}

export async function persistTranscriptRelation(
  context: TranscriptContext,
  source: TranscriptSourceT,
  item: TranscriptSourceContext | TranscriptSourceCandidate,
  relation: TranscriptRelationDelta,
): Promise<Result<TranscriptRelationJournalEntryT, TranscriptError>> {
  const id = `transcriptJournal_${hash(
    `${source.provider}:${source.sourceId}:${item.offset}:relation`,
  )}`;
  const now = new Date().toISOString();
  const draft = TranscriptRelationJournalEntry.parse({
    kind: 'transcriptJournal',
    id,
    schemaVersion: 1,
    createdAt: now,
    permissionLevel: 'private',
    createdBy: 'overridden-by-foundation',
    provider: source.provider,
    sourceId: source.sourceId,
    offset: item.offset,
    nextOffset: item.nextOffset,
    outcome: 'relation',
    relation,
  });
  const created = await createObject<TranscriptRelationJournalEntryT>(
    context.handle,
    draft,
    operationId(`journal:${id}`),
  );
  if (created.ok) return parseRelationJournal(created.value.object);
  if (created.error.code !== 'CasConflict') return created;

  const found = await getObjectWithReadFailure<
    TranscriptRelationJournalEntryT
  >(
    context.handle,
    'transcriptJournal',
    id as ObjectId,
  );
  if (!found.ok) return found;
  if (isAbsent(found.value)) return created;
  return parseRelationJournal(found.value.object);
}

export async function restoreTranscriptRelationState(
  context: TranscriptContext,
  source: TranscriptSourceT,
): Promise<Result<TranscriptRelationState, TranscriptError>> {
  const relations: TranscriptRelationJournalEntryT[] = [];
  let cursor: string | undefined;
  do {
    const listed = await listObjects<TranscriptRelationJournalEntryT>(
      context.handle,
      'transcriptJournal',
      {
        provider: source.provider,
        sourceId: source.sourceId,
        outcome: 'relation',
      },
      { ...(cursor ? { cursor } : {}), limit: 1_000 },
    );
    if (!listed.ok) return listed;
    for (const stored of listed.value.items) {
      const parsed = parseRelationJournal(stored.object);
      if (!parsed.ok) return parsed;
      relations.push(parsed.value);
    }
    cursor = listed.value.nextCursor;
  } while (cursor);

  relations.sort((left, right) => left.offset - right.offset);
  return {
    ok: true,
    value: relations.reduce(
      (state, entry) =>
        applyTranscriptRelationDelta(state, entry.relation),
      emptyTranscriptRelationState(),
    ),
  };
}
