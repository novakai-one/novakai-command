/** The message of a thrown value, coerced for anything that is not an Error. */
export const thrownMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The message of a thrown Error, or the fallback when the value carries none. */
export const thrownMessageOr = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;

/** The errno code a thrown value carries, when it carries one. */
export const errnoCode = (cause: unknown): string | undefined =>
  typeof cause === 'object' && cause !== null && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;

/** True when the thrown value is a Node errno exception with the given code. */
export const isErrno = (cause: unknown, code: string): boolean => errnoCode(cause) === code;
