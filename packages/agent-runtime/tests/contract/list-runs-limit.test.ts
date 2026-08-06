// B3e lane A — A7-03 items 1–3 (NVK-KIMI-094 Q3): `ListAgentRunsFilter.limit`
// is REQUIRED and bounded 1–200, and this owner has no page size of its own.
//
// pass2 §12.7:2650 declares `readonly limit: number`, and every one of the six
// list filters in that section declares the same. A5-05 states the law in
// words: "authenticated, `limit` 1–200, opaque keyset cursor over stable
// `(createdAt,id)`, conjunctive filters, omissions via `Page<T>`". This filter
// was the only outlier in its own section, and it drifted in two directions at
// once:
//
//   - `runs-validate.ts` read `optionalCount('limit', 1, 10_000)` — the
//     boundary accepted FIFTY TIMES the ratified cap, and accepted omission;
//   - `queries.ts` then cut the page at `filter.limit ?? 500` — so when the
//     limit was omitted the OWNER silently chose 500.
//
// The concrete failure, which is the reason this is a defect and not a
// tidy-up: a second host calls `b3.agent.listRuns {includeFinal:false}` over
// nvk-ws — entirely lawful under X-2, which is the whole point of the wire
// being published — and is handed up to 500 items in one page by a contract
// that caps a page at 200, with no `nextCursor` discipline it can reason
// about. Two authorities now answer "how big is a page" (the CLI's 200, the
// Runtime's 500), which is the B3d SEVERE-2 shape one field over.
//
// A5-01 does not license the optionality; it DEPENDS on it not existing. "When
// `--limit` is omitted the CLI supplies 200" is an adapter default over a
// required contract field. The default belongs to the adapter and nowhere
// else.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readListAgentRunsFilter } from '../../contract/runs-validate.js';
import type { B3Result } from '@novakai/foundation/contract';
import type { ListAgentRunsFilter } from '../../contract/runs-api.js';

const issuePaths = (result: B3Result<ListAgentRunsFilter>): readonly string[] => {
  if (result.ok) return [];
  const details = result.error.details as
    { readonly issues?: readonly { readonly path?: string }[] } | undefined;
  return (details?.issues ?? []).map((issue) => issue.path ?? '');
};

test('the ruling\'s exact second-host payload is refused: `limit` is not optional', () => {
  // `{includeFinal:false}` is verbatim the call NVK-KIMI-094 Q3 traces to a
  // 500-item page. It must never reach the owner at all.
  const read = readListAgentRunsFilter({ includeFinal: false });
  assert.equal(read.ok, false, 'a filter with no `limit` was accepted');
  if (read.ok) return;
  assert.equal(read.error.code, 'ValidationFailed');
  assert.ok(issuePaths(read).includes('limit'), `no issue names limit: ${JSON.stringify(read.error.details)}`);
});

test('the boundary caps a page at 200, not 10,000', () => {
  for (const limit of [201, 500, 10_000]) {
    const read = readListAgentRunsFilter({ includeFinal: false, limit });
    assert.equal(read.ok, false, `limit ${limit} was accepted`);
    if (!read.ok) assert.ok(issuePaths(read).includes('limit'));
  }
});

test('1 and 200 are both inside the ratified range', () => {
  for (const limit of [1, 200]) {
    const read = readListAgentRunsFilter({ includeFinal: false, limit });
    assert.equal(read.ok, true, `limit ${limit} was refused`);
    if (read.ok) assert.equal(read.value.limit, limit);
  }
});

test('a page size below 1 is refused — an empty page is not a filter', () => {
  for (const limit of [0, -1]) {
    const read = readListAgentRunsFilter({ includeFinal: false, limit });
    assert.equal(read.ok, false, `limit ${limit} was accepted`);
  }
});

test('the caller\'s limit travels unchanged — the owner never substitutes its own', () => {
  const read = readListAgentRunsFilter({ includeFinal: true, limit: 7 });
  assert.equal(read.ok, true);
  if (read.ok) assert.equal(read.value.limit, 7);
});
