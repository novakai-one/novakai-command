/** The message of a thrown value, coerced for anything that is not an Error. */
export const thrownMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** The message of a thrown Error, or the fallback when the value carries none. */
export const thrownMessageOr = (cause: unknown, fallback: string): string =>
  cause instanceof Error ? cause.message : fallback;
