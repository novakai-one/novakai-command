// §6 Typed Error Shapes. Every contract failure is a typed value, never a
// thrown exception a consumer must catch (A §11).
import type { CapabilityId, ClientOpId, ObjectId, ServerOpId } from './brands.js';
import type { Ref } from './schemas.js';

export interface ContractError<C extends string, P = Record<string, unknown>> {
  readonly code: C;
  readonly message: string;
  readonly details: P;
  readonly retryable: boolean;
}

export type InvalidEnvelopeError = ContractError<'InvalidEnvelope',
  { missingFields: string[]; invalidFields: { field: string; reason: string }[] }>;
export type KindUnknownError = ContractError<'KindUnknown', { kind: string; registered: string[] }>;
export type ScopeViolationError = ContractError<'ScopeViolation',
  { capability: CapabilityId; kind: string; allowedKinds: string[] }>;
export type CasConflictError = ContractError<'CasConflict',
  { id: ObjectId; expectedVersion: number; actualVersion: number }>;
export type LockBusyError = ContractError<'LockBusy', { waitedMs: number; timeoutMs: number }>;
export type TraceIncompleteError = ContractError<'TraceIncomplete',
  { opId: ServerOpId; clientOpId: ClientOpId; objectId: ObjectId }>;
export type TraceWriteFailedError = ContractError<'TraceWriteFailed', { opId: ServerOpId; cause: string }>;
export type ObjectWriteFailedError = ContractError<'ObjectWriteFailed', { opId: ServerOpId; cause: string }>;
export type FilterInvalidError = ContractError<'FilterInvalid', { filter: unknown; reason: string }>;
export type NotFoundError = ContractError<'NotFound', { ref: Ref }>;
// §11 ruling 5: writes to a quarantined id are rejected `Quarantined` until resolveQuarantine.
// (Named by the ruling; additive to the §6 union — see NOTES.md.)
export type QuarantinedError = ContractError<'Quarantined', { ref: Ref; tombstoneId: string }>;
export type AuthError = ContractError<'AuthFailed', { cause: string }>;
/**
 * §18.1's store-route outcome, and therefore Foundation's to name.
 *
 * "If both canonical and legacy files already exist without a successful
 * cutover receipt, boot returns typed `StoreRouteConflict`" — boot is
 * Foundation's bootstrap, so the code belongs in Foundation's union rather than
 * being re-invented by whichever capability happened to notice first. The same
 * code covers a copy that did not verify against its source: in both cases the
 * canonical route is not proven current and must not open.
 */
export type StoreRouteConflictError = ContractError<'StoreRouteConflict',
  { kind: string; canonicalPath: string; legacyPath: string }>;

export type StoreError =
  | InvalidEnvelopeError | KindUnknownError | ScopeViolationError | CasConflictError
  | LockBusyError | TraceIncompleteError | TraceWriteFailedError | ObjectWriteFailedError | FilterInvalidError
  | NotFoundError | QuarantinedError | AuthError | StoreRouteConflictError;

export function err<C extends string, P>(code: C, message: string, details: P, retryable: boolean): ContractError<C, P> {
  return { code, message, details, retryable };
}
