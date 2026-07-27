// §3 Foundation contract functions. Free functions; the engine rides on the
// scoped handle (composed by composeHandle). Absence is typed data, never a throw.
import { z } from 'zod';
import type { ClientOpId, ObjectId, ObjectKind, ServerOpId } from './brands.js';
import { Envelope, QuarantineTombstone, Ref } from './schemas.js';
import type { Envelope as EnvelopeT, QuarantineTombstone as TombstoneT, TraceLine as TraceLineT } from './schemas.js';
import { err, type StoreError } from './errors.js';
import {
  ABSENT, fail, ok, type Absent, type ListFilter, type Page, type PageOptions,
  type Result, type ScopedStoreHandle, type StoredObject, type TraceFilter,
} from './types.js';
import { CURRENT_SCHEMA_VERSION, KIND_FILES, StoreEngine } from '../core/store-engine/engine.js';

const ENVELOPE_FIELDS = ['kind', 'id', 'schemaVersion', 'createdAt', 'permissionLevel', 'createdBy'] as const;

function engineOf(handle: ScopedStoreHandle): StoreEngine {
  const engine = handle.__engine as StoreEngine | undefined;
  if (!engine) throw new Error('handle is not composed — use composeHandle()');
  engine.boot();
  return engine;
}

function principalOf(handle: ScopedStoreHandle): string {
  return handle.__principal ?? 'sys_ingester';
}

function scopeCheck(handle: ScopedStoreHandle, kind: string): StoreError | null {
  if (!(kind in KIND_FILES)) {
    return err('KindUnknown', `kind "${kind}" is not registered`, { kind, registered: Object.keys(KIND_FILES) }, false);
  }
  if (!handle.allowedKinds.has(kind as ObjectKind)) {
    return err('ScopeViolation',
      `capability "${handle.capability}" may not write kind "${kind}"`,
      { capability: handle.capability, kind, allowedKinds: [...handle.allowedKinds] }, false);
  }
  return null;
}

function validateEnvelope(payload: unknown): { flat?: EnvelopeT & Record<string, unknown>; error?: StoreError } {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      error: err('InvalidEnvelope', 'payload must be a single JSON object',
        { missingFields: [...ENVELOPE_FIELDS], invalidFields: [] }, false),
    };
  }
  const obj = payload as Record<string, unknown>;
  const missingFields = ENVELOPE_FIELDS.filter((f) => !(f in obj) || obj[f] === undefined || obj[f] === null || obj[f] === '');
  const parsed = Envelope.safeParse(obj);
  const invalidFields = parsed.success
    ? []
    : parsed.error.issues
      .filter((i) => !missingFields.includes(i.path[0] as typeof ENVELOPE_FIELDS[number]))
      .map((i) => ({ field: i.path.join('.') || '(root)', reason: i.message }));
  if (missingFields.length > 0 || invalidFields.length > 0) {
    return {
      error: err('InvalidEnvelope',
        `envelope rejected: missing [${missingFields.join(', ')}]${invalidFields.length ? `; invalid [${invalidFields.map((i) => i.field).join(', ')}]` : ''}`,
        { missingFields, invalidFields }, false),
    };
  }
  return { flat: obj as EnvelopeT & Record<string, unknown> };
}

interface PriorOp {
  opId: ServerOpId;
  clientOpId: ClientOpId;
  action: 'create' | 'update';
  kind: string;
  id: string;
  traceComplete: boolean;
}

/** Dedup lookup (R3-10): clientOpId honored for the object's lifetime. */
function findPriorOp(engine: StoreEngine, kind: string, clientOpId: ClientOpId): PriorOp | null {
  const trace = engine.readTraces().find((t) => t.clientOpId === clientOpId);
  if (trace && (trace.action === 'create' || trace.action === 'update')) {
    return {
      opId: trace.opId as ServerOpId, clientOpId, action: trace.action,
      kind: trace.target.kind, id: trace.target.id, traceComplete: true,
    };
  }
  // object line exists but trace missing (incomplete) — retry reconciles
  for (const line of readAllRecords(engine, kind)) {
    if (line.clientOpId === clientOpId) {
      return { opId: line.opId as ServerOpId, clientOpId, action: 'create', kind, id: line.envelope.id, traceComplete: false };
    }
  }
  return null;
}

function readAllRecords(engine: StoreEngine, kind: string) {
  // all parsed lines, latest per id, via the dual-read shim
  return [...engine.readLatestEffective(kind).values()];
}

function toStoredObject<T>(engine: StoreEngine, rec: ReturnType<StoreEngine['readLatestEffective']> extends Map<string, infer R> ? R : never): StoredObject<T> {
  const traced = new Set(engine.readTraces().map((t) => t.opId));
  const flat = { ...rec.payload, ...rec.envelope } as T & EnvelopeT;
  const stored: StoredObject<T> = {
    object: flat,
    version: rec.version,
    incomplete: rec.opId !== '' && !traced.has(rec.opId),
  };
  if (rec.unsupportedVersion) stored.unsupportedVersion = true;
  return stored;
}

const DEFAULT_PAGE_LIMIT = 100;

function paginate<T>(items: T[], options?: PageOptions): Page<T> {
  const offset = options?.cursor ? Number.parseInt(options.cursor, 10) : 0;
  const limit = options?.limit ?? DEFAULT_PAGE_LIMIT;
  const slice = items.slice(offset, offset + limit);
  const next = offset + limit < items.length ? String(offset + limit) : undefined;
  return next === undefined ? { items: slice } : { items: slice, nextCursor: next };
}

// ── Mutating ops ────────────────────────────────────────────────────────────

export async function createObject<T>(
  handle: ScopedStoreHandle,
  payload: T,
  clientOpId: ClientOpId,
): Promise<Result<StoredObject<T>, StoreError>> {
  const engine = engineOf(handle);
  const { flat, error } = validateEnvelope(payload);
  if (error) return fail(error);
  const kind = flat!.kind;
  const scoped = scopeCheck(handle, kind);
  if (scoped) return fail(scoped);
  if (flat!.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return fail(err('KindUnknown',
      `schemaVersion ${flat!.schemaVersion} is newer than this code supports (${CURRENT_SCHEMA_VERSION})`,
      { kind, registered: Object.keys(KIND_FILES) }, false));
  }
  if (engine.quarantinedIds().has(flat!.id)) {
    const tombstone = engine.readTombstones().find((t) => t.quarantinedRef.id === flat!.id && t.status === 'open');
    return fail(err('Quarantined', `object "${flat!.id}" is quarantined until resolveQuarantine`,
      { ref: { kind, id: flat!.id }, tombstoneId: tombstone?.id ?? '' }, false));
  }
  // dedup: retry with same clientOpId returns prior outcome, no double-apply
  const prior = findPriorOp(engine, kind, clientOpId);
  if (prior) {
    if (!prior.traceComplete) {
      const rec = readAllRecords(engine, kind).find((r) => r.envelope.id === prior.id);
      if (rec) engine.completeTrace(kind, { ...rec.payload, ...rec.envelope } as EnvelopeT & Record<string, unknown>, prior.action, prior.opId, clientOpId);
    }
    const rec = readAllRecords(engine, kind).find((r) => r.envelope.id === prior.id);
    if (rec) return ok(toStoredObject<T>(engine, rec));
  }
  const existing = readAllRecords(engine, kind).find((r) => r.envelope.id === flat!.id);
  if (existing) {
    return fail(err('CasConflict',
      `object "${flat!.id}" already exists (version ${existing.version}) — use updateObject`,
      { id: flat!.id as ObjectId, expectedVersion: 0, actualVersion: existing.version }, true));
  }
  // red gate 4: createdBy is system-derived from the token principal — always overridden
  const stamped = { ...flat!, createdBy: principalOf(handle) };
  const res = engine.appendMutation(kind, stamped, 'create', clientOpId, 1);
  if (!res.ok) return fail(res.error);
  return ok({ object: res.value.object as T & EnvelopeT, version: res.value.version, incomplete: res.value.incomplete });
}

export async function updateObject<T>(
  handle: ScopedStoreHandle,
  id: ObjectId,
  patch: Partial<T>,
  expectedVersion: number,
  clientOpId: ClientOpId,
): Promise<Result<StoredObject<T>, StoreError>> {
  const engine = engineOf(handle);
  const ref = Ref.safeParse(id && typeof id === 'string' ? { kind: (patch as Record<string, unknown>)?.kind, id } : {});
  void ref;
  // locate the object across the handle's allowed kinds (id carries its kind prefix)
  const all = [...handle.allowedKinds];
  let rec: ReturnType<typeof readAllRecords>[number] | undefined;
  let kind = '';
  for (const k of all) {
    const found = readAllRecords(engine, k).find((r) => r.envelope.id === id);
    if (found) { rec = found; kind = k; break; }
  }
  if (!rec) {
    return fail(err('NotFound', `no object with id "${id}"`, { ref: { kind: kind || 'unknown', id } }, false));
  }
  const scoped = scopeCheck(handle, kind);
  if (scoped) return fail(scoped);
  if (engine.quarantinedIds().has(id)) {
    const tombstone = engine.readTombstones().find((t) => t.quarantinedRef.id === id && t.status === 'open');
    return fail(err('Quarantined', `object "${id}" is quarantined until resolveQuarantine`,
      { ref: { kind, id }, tombstoneId: tombstone?.id ?? '' }, false));
  }
  if (rec.version !== expectedVersion) {
    return fail(err('CasConflict', `CAS conflict on "${id}": expected v${expectedVersion}, actual v${rec.version}`,
      { id, expectedVersion, actualVersion: rec.version }, true));
  }
  const prior = findPriorOp(engine, kind, clientOpId);
  if (prior) {
    if (!prior.traceComplete) {
      engine.completeTrace(kind, { ...rec.payload, ...rec.envelope } as EnvelopeT & Record<string, unknown>, prior.action, prior.opId, clientOpId);
    }
    const current = readAllRecords(engine, kind).find((r) => r.envelope.id === id);
    if (current) return ok(toStoredObject<T>(engine, current));
  }
  // merge: envelope identity fields are immutable; createdBy/createdAt preserved from creation
  const currentFlat = { ...rec.payload, ...rec.envelope } as Record<string, unknown>;
  const patchObj = { ...(patch as Record<string, unknown>) };
  for (const f of ENVELOPE_FIELDS) delete patchObj[f]; // envelope identity never patched
  const merged = { ...currentFlat, ...patchObj, schemaVersion: CURRENT_SCHEMA_VERSION };
  const res = engine.appendMutation(kind, merged as EnvelopeT & Record<string, unknown>, 'update', clientOpId, rec.version + 1);
  if (!res.ok) return fail(res.error);
  return ok({ object: res.value.object as T & EnvelopeT, version: res.value.version, incomplete: res.value.incomplete });
}

// ── Queries ─────────────────────────────────────────────────────────────────

export async function getObject<T>(
  handle: ScopedStoreHandle, kind: ObjectKind, id: ObjectId,
): Promise<Result<StoredObject<T> | Absent, never>> {
  const engine = engineOf(handle);
  if (!(kind in KIND_FILES)) return ok(ABSENT({ kind, id }));
  if (engine.quarantinedIds().has(id)) return ok(ABSENT({ kind, id }));
  const rec = readAllRecords(engine, kind).find((r) => r.envelope.id === id);
  if (!rec) return ok(ABSENT({ kind, id }));
  return ok(toStoredObject<T>(engine, rec));
}

export async function listObjects<T>(
  handle: ScopedStoreHandle, kind: ObjectKind, filter?: ListFilter, page?: PageOptions,
): Promise<Result<Page<StoredObject<T>>, StoreError>> {
  const engine = engineOf(handle);
  if (!(kind in KIND_FILES)) {
    return fail(err('KindUnknown', `kind "${kind}" is not registered`, { kind, registered: Object.keys(KIND_FILES) }, false));
  }
  if (filter !== undefined && (filter === null || typeof filter !== 'object' || Array.isArray(filter))) {
    return fail(err('FilterInvalid', 'filter must be a plain object of field equality checks', { filter, reason: 'not an object' }, false));
  }
  const skipped = engine.quarantinedIds();
  let items = readAllRecords(engine, kind)
    .filter((r) => !skipped.has(r.envelope.id))
    .map((r) => toStoredObject<T>(engine, r));
  if (filter) {
    for (const [field, value] of Object.entries(filter)) {
      items = items.filter((s) => (s.object as Record<string, unknown>)[field] === value);
    }
  }
  items.sort((a, b) => a.object.createdAt.localeCompare(b.object.createdAt)); // R3-3: ordered by createdAt
  return ok(paginate(items, page));
}

export async function resolveRef<T>(
  handle: ScopedStoreHandle, ref: z.infer<typeof Ref>,
): Promise<Result<StoredObject<T> | Absent, never>> {
  return getObject<T>(handle, ref.kind as ObjectKind, ref.id as ObjectId);
}

// ── Trace (FND-005; read-only — NO update/delete API exists) ────────────────

/** Bound variant — the CLI and in-process consumers pass their composed engine. */
export async function queryTraceBound(engine: StoreEngine, filter: TraceFilter, page?: PageOptions): Promise<Page<TraceLineT>> {
  engine.boot();
  let items = engine.readTraces();
  if (filter.opId) items = items.filter((t) => t.opId === filter.opId);
  if (filter.clientOpId) items = items.filter((t) => t.clientOpId === filter.clientOpId);
  if (filter.target) items = items.filter((t) => t.target.kind === filter.target!.kind && t.target.id === filter.target!.id);
  if (filter.since) items = items.filter((t) => t.createdAt >= filter.since!);
  items.sort((a, b) => a.seq - b.seq);
  return paginate(items, page);
}

export async function queryTrace(filter: TraceFilter, page?: PageOptions): Promise<Page<TraceLineT>> {
  // §3 signature is handle-free; defaults to the ambient root (NOVAKAI_ROOT or ./.novakai).
  return queryTraceBound(defaultEngine(), filter, page);
}

// ── Quarantine (R3-4/R3-11) ─────────────────────────────────────────────────

/** Bound variant. */
export async function listQuarantineBound(engine: StoreEngine, page?: PageOptions): Promise<Page<TombstoneT>> {
  engine.boot();
  const items = engine.readTombstones();
  return paginate(items, page);
}

export async function listQuarantine(page?: PageOptions): Promise<Page<TombstoneT>> {
  return listQuarantineBound(defaultEngine(), page);
}

export async function resolveQuarantine(
  handle: ScopedStoreHandle,
  id: ObjectId,
  resolution: 'reconcile' | 'dismiss',
  clientOpId: ClientOpId,
): Promise<Result<TombstoneT, StoreError>> {
  const engine = engineOf(handle);
  const scoped = scopeCheck(handle, 'quarantine');
  if (scoped) return fail(scoped);
  const tombstone = engine.readTombstones().find((t) => t.id === id);
  if (!tombstone) {
    return fail(err('NotFound', `no tombstone with id "${id}"`, { ref: { kind: 'quarantine', id } }, false));
  }
  const actor = principalOf(handle);
  if (resolution === 'reconcile') {
    // re-stamp the trace for the orphaned object if it still exists
    const ref = tombstone.quarantinedRef;
    if (ref.kind in KIND_FILES) {
      const rec = readAllRecords(engine, ref.kind).find((r) => r.envelope.id === ref.id);
      if (rec && rec.opId) {
        engine.completeTrace(ref.kind, { ...rec.payload, ...rec.envelope } as EnvelopeT & Record<string, unknown>,
          'create', rec.opId as ServerOpId, (rec.clientOpId || `op_${crypto.randomUUID()}`) as ClientOpId);
      }
    }
  }
  const version = countTombstoneLines(engine, id) + 1;
  const next: TombstoneT = QuarantineTombstone.parse({
    ...tombstone,
    status: resolution === 'reconcile' ? 'resolved' : 'dismissed',
    resolution,
    resolvedAt: new Date().toISOString(),
    resolvedBy: actor,
  });
  engine.appendRecordLine('quarantine', next as EnvelopeT & Record<string, unknown>, {
    opId: `srv_${crypto.randomUUID()}`, clientOpId, version,
  });
  engine.appendLifecycleTrace('resolveQuarantine', { kind: 'quarantine', id }, actor, clientOpId, { resolution });
  return ok(next);
}

function countTombstoneLines(engine: StoreEngine, id: string): number {
  // version = number of appended lines for this tombstone id so far
  const rec = [...engine.readLatestEffective('quarantine').values()].find((r) => r.envelope.id === id);
  return rec?.version ?? 0;
}

// ── default engine for handle-free reads (CLI composes explicitly) ─────────
let sharedDefault: StoreEngine | null = null;
export function defaultEngine(): StoreEngine {
  if (!sharedDefault) {
    sharedDefault = new StoreEngine({ root: process.env.NOVAKAI_ROOT ?? '.novakai' });
  }
  return sharedDefault;
}
/** @internal tests: reset the shared default engine. */
export function __resetDefaultEngine(): void { sharedDefault = null; }
