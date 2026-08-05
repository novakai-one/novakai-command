// shell/contract/listAnswer.ts — one authority for what an empty list MEANS.
//
// Four of this Shell's screens told Chris there was nothing there while nothing
// had answered yet. Every one of them was written the same way:
//
//   const [data, setData] = useState<Page | null>(null);
//   const rows = data?.rows ?? [];
//   {rows.length === 0 && <EmptyState>No …</EmptyState>}
//
// which reads "no answer" and prints "the answer is none". B0 found it on Runs;
// the B2 audit found it on usage, notifications, watchers and agents. It is
// FZ-VIEW-010's law one level up — "Unavailable is not zero" applied to the
// answer rather than to a measurement — and FZ-VIEW-034's first tempting lie.
//
// So it is refused the way the false zero was refused in B1.2: by shape, not by
// discipline. A row list is reachable ONLY through a source that answered, so
// there is no path from "nothing answered" to "none". `rowsOf` is never called
// without a source, and `rows` is typed non-empty, so neither end of the lie
// has anywhere to live.
//
// Pure: no React, no fetch, no clock. Every list screen switches on the result.

export interface AnswerFailure {
  readonly code: string;
  readonly message: string;
}

/**
 * The four states a list can actually be in. `waiting` and `none` are different
 * facts and are drawn differently; conflating them is the defect this file
 * exists to remove.
 */
export type ListAnswer<TRow> =
  | { readonly kind: 'waiting' }
  | { readonly kind: 'failed'; readonly failure: AnswerFailure }
  | { readonly kind: 'none' }
  | { readonly kind: 'rows'; readonly rows: readonly [TRow, ...TRow[]] };

export interface ListAnswerInput<TSource, TRow> {
  /** The projection an authority returned. `null`/`undefined` = nobody answered. */
  readonly source: TSource | null | undefined;
  /** Set when the ask itself failed. Outranks everything below. */
  readonly failure: AnswerFailure | null;
  /** The only way to a row list — and it cannot run without a source. */
  readonly rowsOf: (source: TSource) => readonly TRow[];
}

/**
 * Precedence, and the reason for it:
 *
 *   failure first — a list beside a failure must not read as a complete list.
 *                   A screen that wants to keep showing the last good page
 *                   while stating the failure draws both deliberately; it does
 *                   not get that by accident.
 *   waiting next  — no source is no answer.
 *   then the source speaks for itself.
 */
export function answerFrom<TSource, TRow>(
  input: ListAnswerInput<TSource, TRow>,
): ListAnswer<TRow> {
  if (input.failure !== null) return { kind: 'failed', failure: input.failure };
  if (input.source === null || input.source === undefined) return { kind: 'waiting' };
  const rows = input.rowsOf(input.source);
  if (rows.length === 0) return { kind: 'none' };
  return { kind: 'rows', rows: rows as readonly [TRow, ...TRow[]] };
}
