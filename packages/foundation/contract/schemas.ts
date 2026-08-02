// §2 Envelope & Record Schemas (zod) — foundation-owned subset (§2 of S1 contracts).
import { z } from 'zod';
import { REFERENCE_KINDS } from './brands.js';

export const PermissionLevel = z.enum(['private', 'team', 'external']);
export type PermissionLevel = z.infer<typeof PermissionLevel>;

export const SourceAttribution = z.object({
  origin: z.string(),
  originalId: z.string().optional(),
  ingestedAt: z.string().datetime(),
});
export type SourceAttribution = z.infer<typeof SourceAttribution>;

// 6 required + 1 optional (DEC-F1, R3-9). createdBy is SYSTEM-DERIVED ONLY (red gate 4).
export const Envelope = z.object({
  kind: z.string().min(1),
  id: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  permissionLevel: PermissionLevel,
  createdBy: z.string().min(1),
  sourceAttribution: SourceAttribution.optional(),
});
export type Envelope = z.infer<typeof Envelope>;

export const Ref = z.object({ kind: z.string().min(1), id: z.string().min(1) });
export type Ref = z.infer<typeof Ref>;

export const RegisteredObjectKind = z.enum(REFERENCE_KINDS);
export type RegisteredObjectKind = z.infer<typeof RegisteredObjectKind>;

// §11 ruling 2 — record-line wrapper: { envelope, payload, meta: { opId, clientOpId } }.
// meta.version carries the per-object CAS counter on each appended line (A §10 — see NOTES.md).
export const RecordLine = z.object({
  envelope: Envelope,
  payload: z.record(z.unknown()),
  meta: z.object({
    opId: z.string().min(1),
    clientOpId: z.string().min(1),
    version: z.number().int().positive(),
  }),
});
export type RecordLine = z.infer<typeof RecordLine>;

// traces.jsonl line (FND-005, DEC-F6, R3-10/19/29)
export const TraceLine = z.object({
  kind: z.literal('trace'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('team'),
  createdBy: z.string().min(1),
  seq: z.number().int().nonnegative(),
  opId: z.string().min(1),
  clientOpId: z.string().min(1),
  action: z.enum(['create', 'update', 'quarantine', 'resolveQuarantine', 'truncate',
    // S2a (S2-pass1 §22 rulings 3/9): named system actions live in the same
    // journal — hook_log, context.inject, hook_error.
    'hook_log', 'context.inject', 'hook_error', 'session.terminate',
    'artifact.orphan.sweep']),
  // 'mutation' lines (absent opKind, pre-S2a) vs 'system.action' lines (S2a+).
  opKind: z.enum(['mutation', 'system.action']).optional(),
  target: Ref,
  meta: z.record(z.unknown()).optional(),
});
export type TraceLine = z.infer<typeof TraceLine>;

/**
 * Who ASKED Foundation to write a tombstone (spec ruling Q10).
 *
 * `createdBy` records the authoritative writer; this records who caused that
 * writer to act. Collapsing the two into one field falsely granted the
 * requester a write it does not hold (§8.2's grant boundary), and changing the
 * writer without keeping this would have lost the causal audit truth instead.
 */
export const QuarantineRequestProvenance = z.object({
  capability: z.string().min(1),
  principalId: z.string().min(1),
  clientOpId: z.string().min(1),
  traceId: z.string().min(1),
});
export type QuarantineRequestProvenance = z.infer<typeof QuarantineRequestProvenance>;

// quarantine.jsonl tombstone (R3-4: tombstone append; original lines NEVER move/rewrite)
export const QuarantineTombstone = z.object({
  kind: z.literal('quarantine'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('private'),
  createdBy: z.string().min(1),
  quarantinedRef: Ref,
  reason: z.enum(['orphan_object_no_trace', 'orphan_trace_no_object', 'corrupt_record']),
  status: z.enum(['open', 'resolved', 'dismissed']),
  resolution: z.enum(['reconcile', 'dismiss']).optional(),
  resolvedAt: z.string().datetime().optional(),
  resolvedBy: z.string().optional(),
  /**
   * Q10: optional at the PARSE boundary solely so tombstones written before the
   * ruling stay valid. Absence means `legacy-requester-unknown` and must not be
   * inferred from `createdBy`. New request-path writes may not omit it.
   */
  requestedBy: QuarantineRequestProvenance.optional(),
});
export type QuarantineTombstone = z.infer<typeof QuarantineTombstone>;

/** Q10's narrowed view: what every NEW `requestQuarantine` write must satisfy. */
export type RequestedQuarantineTombstone = QuarantineTombstone & {
  readonly createdBy: 'sys_foundation';
  readonly requestedBy: QuarantineRequestProvenance;
};

export const LayoutRecord = z.object({
  kind: z.literal('layout'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('private'),
  createdBy: z.string().min(1),
  rail: z.object({
    side: z.enum(['left', 'right']),
    width: z.number().positive(),
    collapsed: z.boolean(),
    order: z.array(z.string()),
  }),
  workspace: z.object({ minWidth: z.number().positive() }),
  inspector: z.object({ width: z.number().positive(), collapsed: z.boolean() }),
  composer: z.object({ height: z.number().positive() }),
  window: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
});
export type LayoutRecord = z.infer<typeof LayoutRecord>;

export const SettingsRecord = z.object({
  kind: z.literal('settings'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('private'),
  createdBy: z.string().min(1),
  key: z.string().min(1),
  value: z.unknown(),
  derivedFrom: z.string().optional(),
});
export type SettingsRecord = z.infer<typeof SettingsRecord>;

export const AgentDefinitionLite = z.object({
  kind: z.literal('agent'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: PermissionLevel,
  createdBy: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.enum(['kimi', 'claude', 'codex', 'mock']),
  model: z.string().min(1),
  hooks: z.array(Ref).default([]),
  status: z.enum(['defined', 'archived']).default('defined'),
});
export type AgentDefinitionLite = z.infer<typeof AgentDefinitionLite>;

export const TokenRecord = z.object({
  kind: z.literal('token'),
  id: z.string().min(1),
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime(),
  permissionLevel: z.literal('private'),
  createdBy: z.string().min(1),
  principal: z.string().min(1),
  // B1: an EMPTY grant set is legal and meaningful — a messaging-only principal
  // (an agent's person) writes no objects at all, and a token that grants
  // nothing composes a handle that refuses every write. Previously
  // unrepresentable, which forced callers to invent a grant.
  grants: z.array(z.string()),
  bearer: z.string().min(1),
});
export type TokenRecord = z.infer<typeof TokenRecord>;
