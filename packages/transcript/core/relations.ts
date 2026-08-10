import { createHash } from 'node:crypto';
import {
  err,
  type ClientOpId,
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

/** Staged (2026-08-09): builds the relation journal draft and buffers it for
 * the scan's group commit; a re-scan duplicate resolves as a 'duplicate'
 * outcome at flush (content-addressed id + mustBeAbsent). */
export function stageTranscriptRelation(
  source: TranscriptSourceT,
  item: TranscriptSourceContext | TranscriptSourceCandidate,
  relation: TranscriptRelationDelta,
  ops: Array<{
    kind: string;
    flat: Record<string, unknown>;
    action: 'create' | 'update';
    clientOpId: ClientOpId;
    mustBeAbsent?: boolean;
  }>,
): Result<TranscriptRelationJournalEntryT, TranscriptError> {
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
  ops.push({
    kind: 'transcriptJournal',
    flat: draft as unknown as Record<string, unknown>,
    action: 'create',
    clientOpId: operationId(`journal:${id}`),
    mustBeAbsent: true,
  });
  return parseRelationJournal(draft);
}

export function restoreTranscriptRelationState(
  relations: readonly TranscriptRelationJournalEntryT[],
): TranscriptRelationState {
  return [...relations]
    .sort((left, right) => left.offset - right.offset)
    .reduce(
      (state, entry) =>
        applyTranscriptRelationDelta(state, entry.relation),
      emptyTranscriptRelationState(),
    );
}
