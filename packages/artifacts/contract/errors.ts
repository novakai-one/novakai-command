import type {
  ContractError,
  StoreError,
} from '@novakai/foundation/dist/contract/errors.js';
import type {
  ArtifactId,
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

export type ArtifactsError =
  | StoreError
  | ArtifactByteEffectFailedError
  | ArtifactBytesReadFailedError
  | StoredArtifactInvalidError;
