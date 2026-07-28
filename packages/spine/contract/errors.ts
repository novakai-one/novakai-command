import type {
  ContractError,
  StoreError,
} from '@novakai/foundation/dist/contract/errors.js';
import type { Ref } from '@novakai/foundation/dist/contract/schemas.js';

export type StoredSpineStepInvalidError = ContractError<
  'StoredSpineStepInvalid',
  {
    ref: Ref;
    issues: Array<{ field: string; reason: string }>;
  }
>;

export type SpineDependencyFailedError = ContractError<
  'SpineDependencyFailed',
  {
    dependency: 'messaging' | 'projects' | 'artifacts';
    operation: string;
    cause: string;
  }
>;

export type SpineSourceMissingError = ContractError<
  'SpineSourceMissing',
  {
    sourceRef: Ref;
  }
>;

export type SpineError =
  | StoreError
  | StoredSpineStepInvalidError
  | SpineDependencyFailedError
  | SpineSourceMissingError;
