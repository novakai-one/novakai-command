// §3 Supporting shapes + scoped handle.
import type { CapabilityId, ClientOpId, ObjectKind, ServerOpId } from './brands.js';
import type { Envelope, Ref, TraceLine, QuarantineTombstone } from './schemas.js';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

/**
 * B3a (B3V4-P2 §4.3, AMD-001 §4). What Foundation actually knows about the
 * mutation that produced this record. Three genuinely different facts:
 *
 *   trace-complete                 object + trace both landed
 *   object-appended-trace-missing  object landed, trace did not — and the
 *                                  operation IDs are still known, so they are
 *                                  reported rather than discarded
 *   legacy-no-trace                a pre-wrapper flat record: no operation
 *                                  ever existed to have IDs
 *
 * `traceId` is the trace LINE's own id. A consumer must never cast a
 * ServerOpId into it, nor invent `committedAt` when it is absent.
 */
export type FoundationMutationProvenance =
  | {
      readonly state: 'trace-complete';
      readonly serverOpId: ServerOpId;
      readonly clientOpId: ClientOpId;
      readonly traceId: string;
      readonly committedAt: string;
    }
  | {
      readonly state: 'object-appended-trace-missing';
      readonly serverOpId: ServerOpId;
      readonly clientOpId: ClientOpId;
      readonly traceId?: never;
      readonly committedAt?: never;
    }
  | {
      readonly state: 'legacy-no-trace';
      readonly serverOpId?: never;
      readonly clientOpId?: never;
      readonly traceId?: never;
      readonly committedAt?: never;
    };

export interface StoredObject<T> {
  object: T & Envelope;
  version: number;
  /**
   * true ⇔ object appended, trace append failed (R3-10). Retains its narrow
   * meaning: it is true exactly when `lastMutation.state` is
   * `object-appended-trace-missing`, and false for a legacy flat record.
   */
  incomplete: boolean;
  // §8 rule 3: reads of records newer than this code surface the record with
  // this flag instead of crashing (absence/unknown is data — see NOTES.md).
  unsupportedVersion?: boolean;
  lastMutation: FoundationMutationProvenance;
}
export interface Absent { readonly absent: true; readonly ref: Ref }
export const ABSENT = (ref: Ref): Absent => ({ absent: true, ref });
export const isAbsent = (v: unknown): v is Absent =>
  typeof v === 'object' && v !== null && (v as Absent).absent === true;

export interface ListFilter { [field: string]: unknown }
export interface TraceFilter { opId?: ServerOpId; clientOpId?: ClientOpId; target?: Ref; since?: string }
export interface Page<T> { items: T[]; nextCursor?: string }

export interface QuarantineRequestOutcome {
  outcome: 'created' | 'already_requested';
  tombstone: QuarantineTombstone;
}

// Scoped store handle (R3-6). Engine binding is internal — consumers see only
// capability + allowedKinds. Construct via composeHandle() in contract/compose.
export interface ScopedStoreHandle {
  readonly capability: CapabilityId;
  readonly allowedKinds: ReadonlySet<ObjectKind>;
  /** @internal engine binding — never touched by consumers. */
  readonly __engine?: unknown;
  /** @internal authenticated principal, token-derived (red gate 4). */
  readonly __principal?: string;
}

export interface PageOptions { cursor?: string; limit?: number }

export type { TraceLine, QuarantineTombstone, Ref, Envelope };
