// §3 Supporting shapes + scoped handle.
import type { CapabilityId, ClientOpId, ObjectKind, ServerOpId } from './brands.js';
import type { Envelope, Ref, TraceLine, QuarantineTombstone } from './schemas.js';

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const fail = <E>(error: E): Result<never, E> => ({ ok: false, error });

export interface StoredObject<T> {
  object: T & Envelope;
  version: number;
  incomplete: boolean; // true ⇔ object appended, trace append failed (R3-10)
  // §8 rule 3: reads of records newer than this code surface the record with
  // this flag instead of crashing (absence/unknown is data — see NOTES.md).
  unsupportedVersion?: boolean;
}
export interface Absent { readonly absent: true; readonly ref: Ref }
export const ABSENT = (ref: Ref): Absent => ({ absent: true, ref });
export const isAbsent = (v: unknown): v is Absent =>
  typeof v === 'object' && v !== null && (v as Absent).absent === true;

export interface ListFilter { [field: string]: unknown }
export interface TraceFilter { opId?: ServerOpId; clientOpId?: ClientOpId; target?: Ref; since?: string }
export interface Page<T> { items: T[]; nextCursor?: string }

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
