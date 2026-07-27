// shell/contract/errors.ts — typed errors (Pass 2 §6). Values, never throws.
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
export const ok = <T>(v: T): Result<T, never> => ({ ok: true, value: v });
export const fail = <E>(e: E): Result<never, E> => ({ ok: false, error: e });

export interface ContractError<C extends string, P = Record<string, unknown>> {
  readonly code: C;
  readonly message: string;
  readonly details: P;
  readonly retryable: boolean;
}

export type UnknownCommandError = ContractError<'UnknownCommand', { input: string; suggestions: string[] }>;
export type ActionNotFoundError = ContractError<'ActionNotFound', { ref: { kind: string; id: string }; actionId: string }>;
export type ContrastBlockedError = ContractError<'ContrastBlocked', { accent: string; ratio: number; floor: number }>;
export type UnknownSettingKeyError = ContractError<'UnknownSettingKey', { key: string; registered: string[] }>;
export type InvalidSettingValueError = ContractError<'InvalidSettingValue', { key: string; reason: string }>;
/** M4: a store-layer write failure crossing the shell seam — typed, never thrown. */
export type PersistFailedError = ContractError<'PersistFailed', { store: string; storeCode: string; cause: string }>;

export type ShellOwnError =
  | UnknownCommandError
  | ActionNotFoundError
  | ContrastBlockedError
  | UnknownSettingKeyError
  | InvalidSettingValueError;

export const unknownCommand = (input: string, suggestions: string[]): UnknownCommandError => ({
  code: 'UnknownCommand',
  message: `unknown command "${input}"`,
  details: { input, suggestions },
  retryable: false,
});

export const contrastBlocked = (accent: string, ratio: number, floor: number): ContrastBlockedError => ({
  code: 'ContrastBlocked',
  message: `accent ${accent} fails contrast floor (${ratio.toFixed(2)}:1 < ${floor}:1)`,
  details: { accent, ratio, floor },
  retryable: false,
});

export const unknownSettingKey = (key: string, registered: string[]): UnknownSettingKeyError => ({
  code: 'UnknownSettingKey',
  message: `unknown setting key "${key}"`,
  details: { key, registered },
  retryable: false,
});

export const invalidSettingValue = (key: string, reason: string): InvalidSettingValueError => ({
  code: 'InvalidSettingValue',
  message: `invalid value for "${key}": ${reason}`,
  details: { key, reason },
  retryable: false,
});

export const persistFailed = (store: string, storeCode: string, cause: string): PersistFailedError => ({
  code: 'PersistFailed',
  message: `${store} write failed (${storeCode}): ${cause}`,
  details: { store, storeCode, cause },
  retryable: true, // store errors carry their own retryable flag; writes are safe to retry with the same clientOpId
});
