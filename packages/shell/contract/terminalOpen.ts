// Which open is "the same open".
//
// The terminal client mints one open-operation id per question and reuses it, so
// that a tab which remounts gets the shell it already opened rather than leaving
// a second one running behind it. The id therefore has to name the QUESTION —
// and the question includes the size, because the size is what the pty is opened
// at (§3.2: the caller mints the operation id; §4.1: it identifies one request).
//
// Reusing an id for a request that differs is not "the same operation asked
// again", and Foundation says so: `IdempotencyConflict`. B1.5 watched that
// refusal turn `New tab` into a button that did nothing.

/** The unit separator: no directory can contain it, so no directory can spell another's key. */
const JOIN = '';

export function openOperationKey(
  workingDirectory: string, columns: number, rows: number,
): string {
  return [workingDirectory, columns, rows].join(JOIN);
}
