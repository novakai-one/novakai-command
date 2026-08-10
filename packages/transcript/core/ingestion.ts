import { createHash } from 'node:crypto';
import {
  commitMutationBatch,
  err,
  getObjectWithReadFailure,
  isAbsent,
  listObjects,
  requestQuarantine,
  visitObjects,
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
  type TranscriptRelationJournalEntry as TranscriptRelationJournalEntryT,
  type TranscriptSkipJournalEntry as TranscriptSkipJournalEntryT,
  type TranscriptSource as TranscriptSourceT,
  type TranscriptSourceCandidate,
  type TranscriptSourceSkip,
} from '../contract/schemas.js';
import type { TranscriptContext } from './composition.js';
import { TranscriptFailpointCrash } from './failpoints.js';
import {
  stageTranscriptRelation,
  restoreTranscriptRelationState,
} from './relations.js';

/** One buffered store mutation awaiting the next group commit (2026-08-09). */
export interface StagedMutation {
  kind: string;
  flat: Record<string, unknown>;
  action: 'create' | 'update';
  clientOpId: ClientOpId;
  mustBeAbsent?: boolean;
}

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

function sourceFailure(
  sourceId: string | undefined,
  _cause: unknown,
): TranscriptError {
  return err(
    'TranscriptSourceFailed',
    sourceId
      ? `transcript source "${sourceId}" failed`
      : 'transcript source discovery failed',
    {
      ...(sourceId ? { sourceId } : {}),
      cause: 'provider source unavailable',
    },
    true,
  );
}

function dedupKey(
  source: TranscriptSourceT,
  item: TranscriptSourceCandidate,
): string {
  if (item.line.nativeId) {
    return `${source.provider}:native:${item.line.nativeId}`;
  }
  if (source.provider === 'codex' && item.line.turnId) {
    return [
      source.provider,
      'native',
      item.line.turnId,
      source.sourceId,
      item.offset,
    ].join(':');
  }
  if (item.line.turnId && source.provider !== 'kimi') {
    return `${source.provider}:native:${item.line.turnId}`;
  }
  const parentId =
    item.line.parentTurnId
    ?? item.line.parentAgentId
    ?? '';
  const fallback = hash(JSON.stringify([
    item.content,
    item.offset,
    parentId,
    source.sourceId,
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

/**
 * Group commit (2026-08-09 churn fix): everything a scan staged — lines,
 * journal entries, relations — plus ONE checkpoint advance and ONE durable
 * batch receipt, committed under ONE lock hold with one fsync per file.
 * The checkpoint rides in the same commit as the members it covers, so a
 * crash never leaves the cursor ahead of durable truth; an un-flushed batch
 * simply re-scans from the previous checkpoint and dedups to 'duplicate'.
 */
async function flushIngestBatch(
  context: TranscriptContext,
  source: TranscriptSourceT,
  ops: StagedMutation[],
  lineIds: Set<string>,
  cursor: { fromOffset: number; nextOffset: number; nextTurnIndex: number; lastTurnId: string | undefined },
  result: IngestResult,
): Promise<Result<null, TranscriptError>> {
  if (ops.length === 0 && cursor.nextOffset <= cursor.fromOffset) {
    return { ok: true, value: null };
  }
  const now = new Date().toISOString();
  const current = await readCheckpoint(context, source);
  if (!current.ok) return current;
  if (!current.value || current.value.object.offset < cursor.nextOffset) {
    const base = current.value?.object;
    ops.push({
      kind: 'transcriptCheckpoint',
      flat: TranscriptCheckpoint.parse({
        kind: 'transcriptCheckpoint',
        id: checkpointId(source),
        schemaVersion: 1,
        createdAt: base?.createdAt ?? now,
        permissionLevel: 'private',
        createdBy: 'overridden-by-foundation',
        provider: source.provider,
        sourceId: source.sourceId,
        offset: cursor.nextOffset,
        nextTurnIndex: cursor.nextTurnIndex,
        ...(cursor.lastTurnId ? { lastTurnId: cursor.lastTurnId } : {}),
        updatedAt: now,
      }) as unknown as Record<string, unknown>,
      action: base ? 'update' : 'create',
      clientOpId: operationId(
        `checkpoint:${checkpointId(source)}:${cursor.nextOffset}:${cursor.nextTurnIndex}`,
      ),
    });
  }
  const memberIds = ops.map((op) => String(op.flat.id));
  const receiptId = `transcriptIngestBatch_${hash(
    `${source.provider}:${source.sourceId}:${cursor.fromOffset}:${cursor.nextOffset}:${memberIds.length}`,
  )}`;
  const committed = await commitMutationBatch(context.handle, ops, {
    flat: {
      kind: 'transcriptIngestBatch',
      id: receiptId,
      schemaVersion: 1,
      createdAt: now,
      permissionLevel: 'private',
      createdBy: 'overridden-by-foundation',
      provider: source.provider,
      sourceId: source.sourceId,
      fromOffset: cursor.fromOffset,
      toOffset: cursor.nextOffset,
      members: memberIds.length,
      memberDigest: hash(memberIds.join('\n')),
    },
    clientOpId: operationId(`ingestBatch:${receiptId}`),
  });
  if (!committed.ok) return committed; // StoreError is a TranscriptError member
  for (const outcome of committed.value.outcomes) {
    if (!lineIds.has(outcome.id)) continue;
    result[outcome.outcome === 'applied' ? 'added' : 'duplicates'] += 1;
  }
  ops.length = 0;
  lineIds.clear();
  cursor.fromOffset = cursor.nextOffset;
  return { ok: true, value: null };
}

function stageSkip(
  source: TranscriptSourceT,
  item: TranscriptSourceSkip,
  ops: StagedMutation[],
): Result<TranscriptSkipJournalEntryT, TranscriptError> {
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
  // Staged (2026-08-09): content-addressed id + mustBeAbsent makes a re-scan's
  // duplicate a 'duplicate' outcome at flush, same net state as the old
  // write-then-CasConflict dance, without a store write per skipped line.
  ops.push({
    kind: 'transcriptJournal',
    flat: draft as unknown as Record<string, unknown>,
    action: 'create',
    clientOpId: operationId(`journal:${id}`),
    mustBeAbsent: true,
  });
  const parsed = parseJournal(draft);
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

function stageDiagnostic(
  source: TranscriptSourceT,
  item: TranscriptSourceCandidate,
  diagnostic: TranscriptDiagnostic,
  ops: StagedMutation[],
): Result<TranscriptDiagnosticJournalEntryT, TranscriptError> {
  const id = `transcriptJournal_${hash(
    `${source.provider}:${source.sourceId}:diagnostic:${diagnostic.code}`,
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
  ops.push({
    kind: 'transcriptJournal',
    flat: draft as unknown as Record<string, unknown>,
    action: 'create',
    clientOpId: operationId(`journal:${id}`),
    mustBeAbsent: true,
  });
  const parsed = parseJournal(draft);
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

interface TranscriptJournalIndex {
  readonly diagnosticCodes: Map<
    string,
    Set<TranscriptDiagnostic['code']>
  >;
  readonly relations: Map<
    string,
    TranscriptRelationJournalEntryT[]
  >;
}

const sourceJournalKey = (source: TranscriptSourceT): string =>
  JSON.stringify([source.provider, source.sourceId]);

async function loadTranscriptJournalIndex(
  context: TranscriptContext,
): Promise<Result<TranscriptJournalIndex, TranscriptError>> {
  const index: TranscriptJournalIndex = {
    diagnosticCodes: new Map(),
    relations: new Map(),
  };
  let parseFailure: TranscriptError | undefined;
  const visited = await visitObjects<TranscriptJournalEntryT>(
    context.handle,
    'transcriptJournal',
    (object) => {
      if (parseFailure) return;
      const parsed = parseJournal(object);
      if (!parsed.ok) {
        parseFailure = parsed.error;
        return;
      }
      const key = sourceJournalKey(parsed.value);
      if (parsed.value.outcome === 'diagnostic') {
        const emitted = index.diagnosticCodes.get(key) ?? new Set();
        emitted.add(parsed.value.diagnostic.code);
        index.diagnosticCodes.set(key, emitted);
      } else if (parsed.value.outcome === 'relation') {
        const relations = index.relations.get(key) ?? [];
        relations.push(parsed.value);
        index.relations.set(key, relations);
      }
    },
  );
  if (!visited.ok) return visited;
  if (parseFailure) return { ok: false, error: parseFailure };
  return { ok: true, value: index };
}

async function stageCandidate(
  context: TranscriptContext,
  source: TranscriptSourceT,
  item: TranscriptSourceCandidate,
  ops: StagedMutation[],
  lineIds: Set<string>,
): Promise<Result<'staged', TranscriptError>> {
  const key = dedupKey(source, item);
  const id = `transcriptLine_${hash(key)}`;
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
  // Staged (2026-08-09): the in-lock mustBeAbsent check at flush is the same
  // create-CAS the old per-line createObject ran; a same-batch or concurrent
  // duplicate comes back as a 'duplicate' outcome and is tallied there.
  const parsed = parseLine(draft);
  if (!parsed.ok) return parsed;
  ops.push({
    kind: 'transcriptLine',
    flat: draft as unknown as Record<string, unknown>,
    action: 'create',
    clientOpId: operationId(
      `line:${source.provider}:${source.sourceId}:${item.offset}`,
    ),
    mustBeAbsent: true,
  });
  lineIds.add(id);
  return { ok: true, value: 'staged' };
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
  // 2026-08-09: cached across ingest() calls — this process is the sole
  // journal writer, so its own staged entries keep the cache coherent.
  let journalIndex = context.ingestCache.journalIndex as
    | TranscriptJournalIndex
    | undefined;
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
      let nextTurnIndex =
        checkpoint.value?.object.nextTurnIndex ?? 0;
      let lastTurnId = checkpoint.value?.object.lastTurnId;
      // Group-commit buffer (2026-08-09): staged mutations flush as ONE locked
      // commit per BATCH_MAX items and once more at end of source.
      const BATCH_MAX = 200;
      const ops: StagedMutation[] = [];
      const lineIds = new Set<string>();
      const cursor = {
        fromOffset,
        nextOffset: fromOffset,
        nextTurnIndex,
        lastTurnId,
      };
      if (!journalIndex) {
        const loaded = await loadTranscriptJournalIndex(context);
        if (!loaded.ok) return loaded;
        journalIndex = loaded.value;
        context.ingestCache.journalIndex = journalIndex;
      }
      const journalKey = sourceJournalKey(source);
      const diagnosticCodes =
        journalIndex.diagnosticCodes.get(journalKey) ?? new Set();
      journalIndex.diagnosticCodes.set(journalKey, diagnosticCodes);
      const relationEntries =
        journalIndex.relations.get(journalKey) ?? [];
      journalIndex.relations.set(journalKey, relationEntries);
      const relationState =
        restoreTranscriptRelationState(relationEntries);
      try {
        for await (
          const rawItem of context.source.read(
            source,
            fromOffset,
            relationState,
            {
              nextTurnIndex,
              ...(lastTurnId ? { lastTurnId } : {}),
            },
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
          if ('relation' in item && item.relation) {
            const staged = stageTranscriptRelation(
              source,
              item,
              item.relation,
              ops,
            );
            if (!staged.ok) return staged;
            relationEntries.push(staged.value);
            context.failpoint.hit(
              'transcript.afterRelationBeforeCheckpoint',
            );
          }
          if (item.kind === 'context') {
          } else if (item.kind === 'skip') {
            if (item.reason.code !== 'non_message') {
              const quarantined = await quarantineRejectedItem(
                context,
                source,
                item,
              );
              if (!quarantined.ok) return quarantined;
              context.failpoint.hit(
                'transcript.afterQuarantineBeforeSkip',
              );
            }
            const skipped = stageSkip(source, item, ops);
            if (!skipped.ok) return skipped;
            context.failpoint.hit(
              'transcript.afterSkipJournalBeforeCheckpoint',
            );
            result.skipped.push(skipped.value);
          } else {
            context.failpoint.hit('transcript.beforeLineAppend');
            const staged = await stageCandidate(context, source, item, ops, lineIds);
            if (!staged.ok) return staged;
            context.failpoint.hit(
              'transcript.afterLineAppendBeforeCheckpoint',
            );
            for (const diagnostic of item.diagnostics ?? []) {
              if (diagnosticCodes.has(diagnostic.code)) continue;
              const journaled = stageDiagnostic(
                source,
                item,
                diagnostic,
                ops,
              );
              if (!journaled.ok) return journaled;
              context.failpoint.hit(
                'transcript.afterDiagnosticJournalBeforeCheckpoint',
              );
              diagnosticCodes.add(diagnostic.code);
              result.diagnostics.push(journaled.value);
            }
          }
          if (item.kind === 'candidate' && source.provider !== 'kimi') {
            nextTurnIndex = Math.max(
              nextTurnIndex,
              item.line.turnIndex + 1,
            );
            lastTurnId = item.line.turnId;
          } else if (item.kind === 'candidate') {
            nextTurnIndex += 1;
          }
          cursor.nextOffset = item.nextOffset;
          cursor.nextTurnIndex = nextTurnIndex;
          cursor.lastTurnId = lastTurnId;
          if (ops.length >= BATCH_MAX) {
            context.failpoint.hit('transcript.beforeCheckpointAppend');
            const flushed = await flushIngestBatch(
              context, source, ops, lineIds, cursor, result,
            );
            if (!flushed.ok) return flushed;
          }
          itemsSinceYield += 1;
          if (itemsSinceYield >= context.yieldAfterItems) {
            itemsSinceYield = 0;
            await context.yieldToHost();
          }
        }
        context.failpoint.hit('transcript.beforeCheckpointAppend');
        const flushed = await flushIngestBatch(
          context, source, ops, lineIds, cursor, result,
        );
        if (!flushed.ok) return flushed;
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
      { ...(cursor ? { cursor } : {}), limit: 1_000_000 },
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
  if (turnId.startsWith('codex:')) {
    return {
      ok: false,
      error: err(
        'TranscriptTreeUnsupported',
        'Codex transcript rows expose no verified spawn relation',
        {
          provider: 'codex' as const,
          reason: 'no verified spawn table is available in the provider format',
        },
        false,
      ),
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
