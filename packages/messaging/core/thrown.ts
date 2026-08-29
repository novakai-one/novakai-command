/** The message of a thrown value, coerced for anything that is not an Error. */
export const thrownMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
