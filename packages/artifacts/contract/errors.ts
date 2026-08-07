import type {
  ContractError,
  StoreError,
} from '@novakai/foundation/dist/contract/errors.js';
import type {
  ArtifactId,
  ClientOpId,
} from '@novakai/foundation/dist/contract/brands.js';
import type { Ref } from '@novakai/foundation/dist/contract/schemas.js';

export type ArtifactByteEffect =
  | 'temp-write'
  | 'temp-fsync'
  | 'rename';

export type ArtifactByteEffectFailedError = ContractError<
  'ArtifactByteEffectFailed',
  {
    artifactId: ArtifactId;
    effect: ArtifactByteEffect;
    cause: string;
  }
>;

export type StoredArtifactInvalidError = ContractError<
  'StoredArtifactInvalid',
  {
    ref: Ref;
    issues: Array<{ field: string; reason: string }>;
  }
>;

export type ArtifactBytesReadFailedError = ContractError<
  'ArtifactBytesReadFailed',
  {
    artifactId: ArtifactId;
    cause: string;
  }
>;

export type ArtifactBytesMissingError = ContractError<
  'ArtifactBytesMissing',
  {
    ref: Ref;
  }
>;

export type ArtifactStoreReadFailedError = ContractError<
  'ArtifactStoreReadFailed',
  {
    operation: 'get' | 'list';
    cause: string;
  }
>;

export type ArtifactStoreWriteFailedError = ContractError<
  'ArtifactStoreWriteFailed',
  {
    operation: 'put';
    cause: string;
  }
>;

export type ArtifactIdempotencyConflictError = ContractError<
  'ArtifactIdempotencyConflict',
  {
    artifactId: ArtifactId;
    clientOpId: ClientOpId;
    differingFields: string[];
  }
>;

export type ArtifactPublicationBusyError = ContractError<
  'ArtifactPublicationBusy',
  {
    artifactId: ArtifactId;
    waitedMs: number;
    timeoutMs: number;
  }
>;

export type ArtifactPublicationLockFailedError = ContractError<
  'ArtifactPublicationLockFailed',
  {
    artifactId: ArtifactId;
    phase: 'acquire' | 'release';
    cause: string;
  }
>;

export type ArtifactFailpointError = ContractError<
  'ArtifactFailpoint',
  {
    artifactId: ArtifactId;
    point: string;
  }
>;

export type ArtifactOrphanScanFailedError = ContractError<
  'ArtifactOrphanScanFailed',
  {
    cause: string;
  }
>;

export type ArtifactOrphanDeleteFailedError = ContractError<
  'ArtifactOrphanDeleteFailed',
  {
    artifactId: ArtifactId;
    entryType: 'final' | 'temp';
    cause: string;
  }
>;

export type ArtifactOrphanTraceFailedError = ContractError<
  'ArtifactOrphanTraceFailed',
  {
    artifactId: ArtifactId;
    entryType: 'final' | 'temp';
    cause: string;
  }
>;

export type ArtifactsError =
  | StoreError
  | ArtifactByteEffectFailedError
  | ArtifactBytesMissingError
  | ArtifactBytesReadFailedError
  | ArtifactStoreReadFailedError
  | ArtifactStoreWriteFailedError
  | ArtifactIdempotencyConflictError
  | ArtifactPublicationBusyError
  | ArtifactPublicationLockFailedError
  | ArtifactFailpointError
  | ArtifactOrphanScanFailedError
  | ArtifactOrphanDeleteFailedError
  | ArtifactOrphanTraceFailedError
  | StoredArtifactInvalidError;
