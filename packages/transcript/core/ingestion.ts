import { createHash } from 'node:crypto';
import {
  createObject,
  err,
  getObjectWithReadFailure,
  isAbsent,
  listObjects,
  requestQuarantine,
  updateObject,
  type ClientOpId,
  type ObjectId,
  type Result,
  type StoredObject,
} from '@novakai/foundation/dist/contract/index.js';
import type { TranscriptError } from '../contract/errors.js';
import {
  ProviderName,
  SessionRef,
  TranscriptCheckpoint,
  TranscriptJournalEntry,
  TranscriptLine,
  TranscriptSource,
  TranscriptSourceItem,
  type IngestResult,
  type NormalizedTranscriptLine,
  type ProviderName as ProviderNameT,
  type SessionRef as SessionRefT,
  type TranscriptCheckpoint as TranscriptCheckpointT,
  type TranscriptDiagnostic,
  type TranscriptDiagnosticJournalEntry as TranscriptDiagnosticJournalEntryT,
  type TranscriptJournalEntry as TranscriptJournalEntryT,
  type TranscriptLine as TranscriptLineT,
  type TranscriptSkipJournalEntry as TranscriptSkipJournalEntryT,
  type TranscriptSource as TranscriptSourceT,
  type TranscriptSourceCandidate,
  type TranscriptSourceSkip,
} from '../contract/schemas.js';
import type { TranscriptContext } from './composition.js';
import { TranscriptFailpointCrash } from './failpoints.js';
import {
  persistTranscriptRelation,
  restoreTranscriptRelationState,
} from './relations.js';

const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

const operationId = (value: string): ClientOpId =>
  `op_${hash(value)}` as ClientOpId;

const scopedTurnId = (
  provider: ProviderNameT,
  turnId: string,
): string => `${provider}:${turnId}`;

function invalidInput(
  label: string,
  issues: Array<{ path: PropertyKey[]; message: string }>,
): TranscriptError {
  return err(
    'InvalidEnvelope',
    `${label} rejected`,
    {
      missingFields: [],
      invalidFields: issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        reason: issue.message,
      })),
    },
    false,
  );
}

function invalidRecord(
  kind: string,
  id: string,
  issues: Array<{ path: PropertyKey[]; message: string }>,
): TranscriptError {
  return err(
    'TranscriptRecordInvalid',
    `stored ${kind} "${id}" does not match the Transcript schema`,
    {
      kind,
      id,
      issues: issues.map((issue) => ({
        field: issue.path.join('.') || '(root)',
        reason: issue.message,
      })),
    },
    false,
  );
}

function sourceFailure(sourceId: string | undefined, cause: unknown): TranscriptError {
  return err(
    'TranscriptSourceFailed',
    `transcript source failed: ${String(cause)}`,
    { ...(sourceId ? { sourceId } : {}), cause: String(cause) },
    true,
  );
}

function dedupKey(
  source: TranscriptSourceT,
  item: TranscriptSourceCandidate,
): string {
  const nativeId = item.line.nativeId ?? item.line.turnId;
  if (nativeId) {
    return `${source.provider}:native:${nativeId}`;
  }
  const parentId =
    item.line.parentTurnId
    ?? item.line.parentAgentId
    ?? '';
  const fallback = hash(JSON.stringify([
    source.sourceId,
    item.content,
    item.offset,
    parentId,
  ]));
  return `${source.provider}:fallback:${fallback}`;
}

function parseLine(
  object: unknown,
): Result<TranscriptLineT, TranscriptError> {
  const parsed = TranscriptLine.safeParse(object);
  if (parsed.success) return { ok: true, value: parsed.data };
  const record = object as { id?: unknown };
  return {
    ok: false,
    error: invalidRecord(
      'transcriptLine',
      String(record?.id ?? '(unknown)'),
      parsed.error.issues,
    ),
  };
}

function parseCheckpoint(
  object: unknown,
): Result<TranscriptCheckpointT, TranscriptError> {
  const parsed = TranscriptCheckpoint.safeParse(object);
  if (parsed.success) return { ok: true, value: parsed.data };
  const record = object as { id?: unknown };
  return {
    ok: false,
    error: invalidRecord(
      'transcriptCheckpoint',
      String(record?.id ?? '(unknown)'),
      parsed.error.issues,
    ),
  };
}

function parseJournal(
  object: unknown,
): Result<TranscriptJournalEntryT, TranscriptError> {
  const parsed = TranscriptJournalEntry.safeParse(object);
  if (parsed.success) return { ok: true, value: parsed.data };
  const record = object as { id?: unknown };
  return {
    ok: false,
    error: invalidRecord(
      'transcriptJournal',
      String(record?.id ?? '(unknown)'),
      parsed.error.issues,
    ),
  };
}

const checkpointId = (source: TranscriptSourceT): string =>
  `transcriptCheckpoint_${hash(`${source.provider}:${source.sourceId}`)}`;

async function readCheckpoint(
  context: TranscriptContext,
  source: TranscriptSourceT,
): Promise<Result<StoredObject<TranscriptCheckpointT> | null, TranscriptError>> {
  const found = await getObjectWithReadFailure<TranscriptCheckpointT>(
    context.handle,
    'transcriptCheckpoint',
    checkpointId(source) as ObjectId,
  );
  if (!found.ok) return found;
  if (isAbsent(found.value)) return { ok: true, value: null };
  const parsed = parseCheckpoint(found.value.object);
  return parsed.ok
    ? {
        ok: true,
        value: { ...found.value, object: parsed.value },
      }
    : parsed;
}

async function advanceCheckpoint(
  context: TranscriptContext,
  source: TranscriptSourceT,
  nextOffset: number,
): Promise<Result<TranscriptCheckpointT, TranscriptError>> {
  for (;;) {
    const current = await readCheckpoint(context, source);
    if (!current.ok) return current;
    if (current.value && current.value.object.offset >= nextOffset) {
      return { ok: true, value: current.value.object };
    }
    const now = new Date().toISOString();
    if (!current.value) {
      const draft = TranscriptCheckpoint.parse({
        kind: 'transcriptCheckpoint',
        id: checkpointId(source),
        schemaVersion: 1,
        createdAt: now,
        permissionLevel: 'private',
        createdBy: 'overridden-by-foundation',
        provider: source.provider,
        sourceId: source.sourceId,
        offset: nextOffset,
        updatedAt: now,
      });
      const created = await createObject<TranscriptCheckpointT>(
        context.handle,
        draft,
        operationId(`checkpoint:create:${draft.id}:${nextOffset}`),
      );
      if (created.ok) return parseCheckpoint(created.value.object);
      if (created.error.code === 'CasConflict') continue;
      return created;
    }
    const patch: Partial<TranscriptCheckpointT> & {
      relationState?: undefined;
    } = {
      offset: nextOffset,
      relationState: undefined,
      updatedAt: now,
    };
    const updated = await updateObject<TranscriptCheckpointT>(
      context.handle,
      current.value.object.id as ObjectId,
      patch,
      current.value.version,
      operationId(
        `checkpoint:update:${current.value.object.id}:${nextOffset}`,
      ),
    );
    if (updated.ok) return parseCheckpoint(updated.value.object);
    if (updated.error.code === 'CasConflict') continue;
    return updated;
  }
}

async function persistSkip(
  context: TranscriptContext,
  source: TranscriptSourceT,
  item: TranscriptSourceSkip,
): Promise<Result<TranscriptSkipJournalEntryT, TranscriptError>> {
  const id = `transcriptJournal_${hash(
    `${source.provider}:${source.sourceId}:${item.offset}`,
  )}`;
  const now = new Date().toISOString();
  const draft = TranscriptJournalEntry.parse({
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
    outcome: 'skipped',
    skip: item.reason,
  });
  const created = await createObject<TranscriptJournalEntryT>(
    context.handle,
    draft,
    operationId(`journal:${id}`),
  );
  if (created.ok) {
    const parsed = parseJournal(created.value.object);
    if (parsed.ok && parsed.value.outcome === 'skipped') {
      return { ok: true, value: parsed.value };
    }
    return {
      ok: false,
      error: invalidRecord(
        'transcriptJournal',
        id,
        [{ path: ['outcome'], message: 'expected skipped entry' }],
      ),
    };
  }
  if (created.error.code !== 'CasConflict') return created;
  const found = await getObjectWithReadFailure<TranscriptJournalEntryT>(
    context.handle,
    'transcriptJournal',
    id as ObjectId,
  );
  if (!found.ok) return found;
  if (isAbsent(found.value)) return created;
  const parsed = parseJournal(found.value.object);
  if (parsed.ok && parsed.value.outcome === 'skipped') {
    return { ok: true, value: parsed.value };
  }
  return {
    ok: false,
    error: invalidRecord(
      'transcriptJournal',
      id,
      [{ path: ['outcome'], message: 'expected skipped entry' }],
    ),
  };
}

async function quarantineRejectedItem(
  context: TranscriptContext,
  source: TranscriptSourceT,
  item: TranscriptSourceSkip,
): Promise<Result<null, TranscriptError>> {
  const identity = `${source.provider}:${source.sourceId}:${item.offset}`;
  const requested = await requestQuarantine(context.handle, {
    target: {
      kind: 'transcriptLine',
      id: `transcriptLine_${hash(`quarantine-target:${identity}`)}`,
    },
    clientOpId: operationId(`quarantine:${identity}`),
  });
  return requested.ok
    ? { ok: true, value: null }
    : requested;
}

async function persistDiagnostic(
  context: TranscriptContext,
  source: TranscriptSourceT,
  item: TranscriptSourceCandidate,
  diagnostic: TranscriptDiagnostic,
): Promise<Result<TranscriptDiagnosticJournalEntryT, TranscriptError>> {
  const id = `transcriptJournal_${hash(
    `${source.provider}:${source.sourceId}:${item.offset}:diagnostic:${diagnostic.code}`,
  )}`;
  const now = new Date().toISOString();
  const draft = TranscriptJournalEntry.parse({
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
    outcome: 'diagnostic',
    diagnostic,
  });
  const created = await createObject<TranscriptJournalEntryT>(
    context.handle,
    draft,
    operationId(`journal:${id}`),
  );
  if (created.ok) {
    const parsed = parseJournal(created.value.object);
    if (parsed.ok && parsed.value.outcome === 'diagnostic') {
      return { ok: true, value: parsed.value };
    }
    return {
      ok: false,
      error: invalidRecord(
        'transcriptJournal',
        id,
        [{ path: ['outcome'], message: 'expected diagnostic entry' }],
      ),
    };
  }
  if (created.error.code !== 'CasConflict') return created;
  const found = await getObjectWithReadFailure<TranscriptJournalEntryT>(
    context.handle,
    'transcriptJournal',
    id as ObjectId,
  );
  if (!found.ok) return found;
  if (isAbsent(found.value)) return created;
  const parsed = parseJournal(found.value.object);
  if (parsed.ok && parsed.value.outcome === 'diagnostic') {
    return { ok: true, value: parsed.value };
  }
  return {
    ok: false,
    error: invalidRecord(
      'transcriptJournal',
      id,
      [{ path: ['outcome'], message: 'expected diagnostic entry' }],
    ),
  };
}

async function persistCandidate(
  context: TranscriptContext,
  source: TranscriptSourceT,
  item: TranscriptSourceCandidate,
): Promise<Result<'added' | 'duplicate', TranscriptError>> {
  const key = dedupKey(source, item);
  const id = `transcriptLine_${hash(key)}`;
  const existing = await getObjectWithReadFailure<TranscriptLineT>(
    context.handle,
    'transcriptLine',
    id as ObjectId,
  );
  if (!existing.ok) return existing;
  if (!isAbsent(existing.value)) {
    const parsed = parseLine(existing.value.object);
    if (!parsed.ok) return parsed;
    return parsed.value.dedupKey === key
      ? { ok: true, value: 'duplicate' }
      : {
          ok: false,
          error: err(
            'CasConflict',
            `dedup id collision for "${id}"`,
            {
              id: id as ObjectId,
              expectedVersion: 0,
              actualVersion: existing.value.version,
            },
            false,
          ),
        };
  }
  const now = new Date().toISOString();
  const line: NormalizedTranscriptLine = item.line;
  const nativeId = line.nativeId ?? line.turnId;
  const draft = TranscriptLine.parse({
    kind: 'transcriptLine',
    id,
    schemaVersion: 1,
    createdAt: now,
    permissionLevel: 'private',
    createdBy: 'overridden-by-foundation',
    sourceAttribution: {
      origin: `${source.provider}:${source.sourceId}`,
      ...(nativeId ? { originalId: nativeId } : {}),
      ingestedAt: now,
    },
    provider: source.provider,
    sourceId: source.sourceId,
    sourceOffset: item.offset,
    dedupKey: key,
    turnId: scopedTurnId(
      source.provider,
      line.turnId ?? line.nativeId ?? id,
    ),
    turnIndex: line.turnIndex,
    role: line.role,
    text: line.text,
    ...(line.tokenUsage ? { tokenUsage: line.tokenUsage } : {}),
    ...(line.agentId ? { agentId: line.agentId } : {}),
    ...(line.parentAgentId ? { parentAgentId: line.parentAgentId } : {}),
    ...(line.parentTurnId
      ? { parentTurnId: scopedTurnId(source.provider, line.parentTurnId) }
      : {}),
    ...(line.sessionRef ? { sessionRef: line.sessionRef } : {}),
  });
  const created = await createObject<TranscriptLineT>(
    context.handle,
    draft,
    operationId(
      `line:${source.provider}:${source.sourceId}:${item.offset}`,
    ),
  );
  if (created.ok) {
    const parsed = parseLine(created.value.object);
    return parsed.ok ? { ok: true, value: 'added' } : parsed;
  }
  if (created.error.code !== 'CasConflict') return created;
  const winner = await getObjectWithReadFailure<TranscriptLineT>(
    context.handle,
    'transcriptLine',
    id as ObjectId,
  );
  if (!winner.ok) return winner;
  if (isAbsent(winner.value)) return created;
  const parsed = parseLine(winner.value.object);
  if (!parsed.ok) return parsed;
  return parsed.value.dedupKey === key
    ? { ok: true, value: 'duplicate' }
    : created;
}

export async function ingest(
  context: TranscriptContext,
): Promise<Result<IngestResult, TranscriptError>> {
  const result: IngestResult = {
    added: 0,
    duplicates: 0,
    skipped: [],
    diagnostics: [],
  };
  let rawSources: AsyncIterable<TranscriptSourceT>;
  let itemsSinceYield = 0;
  try {
    rawSources = context.source.sources();
  } catch (cause) {
    return { ok: false, error: sourceFailure(undefined, cause) };
  }
  try {
    for await (const rawSource of rawSources) {
      const parsedSource = TranscriptSource.safeParse(rawSource);
      if (!parsedSource.success) {
        return {
          ok: false,
          error: invalidInput('transcript source', parsedSource.error.issues),
        };
      }
      const source = parsedSource.data;
      const checkpoint = await readCheckpoint(context, source);
      if (!checkpoint.ok) return checkpoint;
      const fromOffset = checkpoint.value?.object.offset ?? 0;
      const restoredRelations = await restoreTranscriptRelationState(
        context,
        source,
      );
      if (!restoredRelations.ok) return restoredRelations;
      const relationState = restoredRelations.value;
      try {
        for await (
          const rawItem of context.source.read(
            source,
            fromOffset,
            relationState,
          )
        ) {
          const parsedItem = TranscriptSourceItem.safeParse(rawItem);
          if (!parsedItem.success) {
            return {
              ok: false,
              error: invalidInput(
                `transcript source item from ${source.sourceId}`,
                parsedItem.error.issues,
              ),
            };
          }
          const item = parsedItem.data;
          if (item.kind === 'context') {
            if (item.relation) {
              const persisted = await persistTranscriptRelation(
                context,
                source,
                item,
                item.relation,
              );
              if (!persisted.ok) return persisted;
              context.failpoint.hit(
                'transcript.afterRelationBeforeCheckpoint',
              );
            }
          } else if (item.kind === 'skip') {
            const quarantined = await quarantineRejectedItem(
              context,
              source,
              item,
            );
            if (!quarantined.ok) return quarantined;
            context.failpoint.hit(
              'transcript.afterQuarantineBeforeSkip',
            );
            const skipped = await persistSkip(context, source, item);
            if (!skipped.ok) return skipped;
            result.skipped.push(skipped.value);
          } else {
            context.failpoint.hit('transcript.beforeLineAppend');
            const persisted = await persistCandidate(context, source, item);
            if (!persisted.ok) return persisted;
            result[persisted.value === 'added' ? 'added' : 'duplicates'] += 1;
            context.failpoint.hit(
              'transcript.afterLineAppendBeforeCheckpoint',
            );
            for (const diagnostic of item.diagnostics ?? []) {
              const journaled = await persistDiagnostic(
                context,
                source,
                item,
                diagnostic,
              );
              if (!journaled.ok) return journaled;
              result.diagnostics.push(journaled.value);
            }
          }
          const advanced = await advanceCheckpoint(
            context,
            source,
            item.nextOffset,
          );
          if (!advanced.ok) return advanced;
          itemsSinceYield += 1;
          if (itemsSinceYield >= context.yieldAfterItems) {
            itemsSinceYield = 0;
            await context.yieldToHost();
          }
        }
      } catch (cause) {
        if (cause instanceof TranscriptFailpointCrash) throw cause;
        return { ok: false, error: sourceFailure(source.sourceId, cause) };
      }
    }
  } catch (cause) {
    if (cause instanceof TranscriptFailpointCrash) throw cause;
    return { ok: false, error: sourceFailure(undefined, cause) };
  }
  return { ok: true, value: result };
}

async function allLines(
  context: TranscriptContext,
  filter?: Record<string, unknown>,
): Promise<Result<TranscriptLineT[], TranscriptError>> {
  const lines: TranscriptLineT[] = [];
  let cursor: string | undefined;
  do {
    const listed = await listObjects<TranscriptLineT>(
      context.handle,
      'transcriptLine',
      filter,
      { ...(cursor ? { cursor } : {}), limit: 1_000 },
    );
    if (!listed.ok) return listed;
    for (const stored of listed.value.items) {
      const parsed = parseLine(stored.object);
      if (!parsed.ok) return parsed;
      lines.push(parsed.value);
    }
    cursor = listed.value.nextCursor;
  } while (cursor);
  return { ok: true, value: lines };
}

export async function linesBySession(
  context: TranscriptContext,
  sessionRef: SessionRefT,
): Promise<Result<TranscriptLineT[], TranscriptError>> {
  const parsed = SessionRef.safeParse(sessionRef);
  if (!parsed.success) {
    return {
      ok: false,
      error: invalidInput('sessionRef', parsed.error.issues),
    };
  }
  return allLines(context, { sessionRef: parsed.data });
}

export async function linesByProvider(
  context: TranscriptContext,
  provider: ProviderNameT,
  since?: string,
): Promise<Result<TranscriptLineT[], TranscriptError>> {
  const parsedProvider = ProviderName.safeParse(provider);
  if (!parsedProvider.success) {
    return {
      ok: false,
      error: invalidInput('provider', parsedProvider.error.issues),
    };
  }
  const sinceMs = since === undefined ? undefined : Date.parse(since);
  if (sinceMs !== undefined && Number.isNaN(sinceMs)) {
    return {
      ok: false,
      error: invalidInput('since', [{
        path: ['since'],
        message: 'must be an ISO-8601 timestamp',
      }]),
    };
  }
  const listed = await allLines(context, { provider: parsedProvider.data });
  if (!listed.ok || sinceMs === undefined) return listed;
  return {
    ok: true,
    value: listed.value.filter(
      (line) => Date.parse(line.createdAt) >= sinceMs,
    ),
  };
}

export async function subagentTree(
  context: TranscriptContext,
  turnId: string,
): Promise<Result<TranscriptLineT[], TranscriptError>> {
  if (typeof turnId !== 'string' || turnId.length === 0) {
    return {
      ok: false,
      error: invalidInput('turnId', [{
        path: ['turnId'],
        message: 'required non-empty string',
      }]),
    };
  }
  const listed = await allLines(context);
  if (!listed.ok) return listed;
  const descendants: TranscriptLineT[] = [];
  const queued = [turnId];
  const seenLines = new Set<string>();
  while (queued.length > 0) {
    const parentTurnId = queued.shift()!;
    for (const line of listed.value) {
      if (
        line.parentTurnId !== parentTurnId
        || seenLines.has(line.id)
      ) {
        continue;
      }
      seenLines.add(line.id);
      descendants.push(line);
      queued.push(line.turnId);
    }
  }
  return { ok: true, value: descendants };
}
