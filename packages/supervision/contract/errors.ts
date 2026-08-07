import type {
  B3ContractError,
  B3ErrorCode,
} from '@novakai/foundation/contract';

/** The shared §11 error shape, reused rather than forked by Supervision. */
export type ContractError<
  Code extends B3ErrorCode = B3ErrorCode,
  Details extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> = B3ContractError<Code, Details>;

/** Every §11 code that a Supervision public boundary may emit directly. */
export const SUPERVISION_ERROR_CODES = [
  'ValidationFailed',
  'UnsupportedContractVersion',
  'PermissionDenied',
  'IdempotencyConflict',
  'StoreUnavailable',
  'VersionConflict',
  'RecoveryRequired',
  'ProviderSessionReservationConflict',
  'StaleRuntimeEpoch',
  'RuntimeUnavailable',
  'UnknownAgent',
  'UnknownAgentRun',
  'RunFinal',
  'NotWorking',
  'Backpressure',
  'CursorExpired',
  'UsageUnavailable',
  'WatchRuleInvalid',
  'WatcherConflict',
  'NotificationDeliveryUnsafe',
  'UnsupportedOperation',
] as const satisfies readonly B3ErrorCode[];

/** Supervision's relevant discriminant union; the wire shape remains §11's. */
export type SupervisionErrorCode = typeof SUPERVISION_ERROR_CODES[number];

/** A typed Supervision failure without leaking implementation exceptions. */
export type SupervisionContractError = ContractError<SupervisionErrorCode>;
