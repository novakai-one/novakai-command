import type {
  ContractError,
  StoreError,
} from '@novakai/foundation/dist/contract/errors.js';
import type { Ref } from '@novakai/foundation/dist/contract/schemas.js';

export type StoredRecordInvalidError = ContractError<
  'StoredRecordInvalid',
  {
    ref: Ref;
    issues: Array<{ field: string; reason: string }>;
  }
>;

export type ProjectsError = StoreError | StoredRecordInvalidError;
