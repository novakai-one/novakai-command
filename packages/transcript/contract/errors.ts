import type {
  ContractError,
  StoreError,
} from '@novakai/foundation/dist/contract/errors.js';

export type TranscriptSourceError = ContractError<
  'TranscriptSourceFailed',
  { sourceId?: string; cause: string }
>;

export type TranscriptRecordError = ContractError<
  'TranscriptRecordInvalid',
  { kind: string; id: string; issues: Array<{ field: string; reason: string }> }
>;

export type TranscriptError =
  | StoreError
  | TranscriptSourceError
  | TranscriptRecordError;
