/** The errno of a thrown filesystem failure, when the cause is one. */
export const errnoCode = (cause: unknown): string | undefined =>
  cause instanceof Error && 'code' in cause && typeof cause.code === 'string'
    ? cause.code
    : undefined;

/** True when the thrown failure is the named errno — the only honest way to branch on fs errors. */
export const isErrno = (cause: unknown, code: string): boolean => errnoCode(cause) === code;
