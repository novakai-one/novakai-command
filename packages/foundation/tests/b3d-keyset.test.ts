import assert from 'node:assert/strict';
import test from 'node:test';
import { keysetPage } from '../contract/index.js';

const items = [
  { id: 'row_b', createdAt: '2026-08-03T01:00:00.000Z' },
  { id: 'row_a', createdAt: '2026-08-03T01:00:00.000Z' },
  { id: 'row_c', createdAt: '2026-08-03T01:00:01.000Z' },
];

test('B3 keyset pages are stable across equal timestamps', () => {
  const first = keysetPage(items, { limit: 1 });
  assert.equal(first.ok, true, first.ok ? '' : first.error.message);
  if (!first.ok || first.value.nextCursor === undefined) return;
  assert.deepEqual(first.value.items.map((item) => item.id), ['row_a']);

  const second = keysetPage(items, { limit: 1, cursor: first.value.nextCursor });
  assert.equal(second.ok, true, second.ok ? '' : second.error.message);
  if (!second.ok || second.value.nextCursor === undefined) return;
  assert.deepEqual(second.value.items.map((item) => item.id), ['row_b']);

  const third = keysetPage(items, { limit: 1, cursor: second.value.nextCursor });
  assert.equal(third.ok, true, third.ok ? '' : third.error.message);
  if (third.ok) {
    assert.deepEqual(third.value.items.map((item) => item.id), ['row_c']);
    assert.equal(third.value.nextCursor, undefined);
  }
});

test('B3 keyset pages reject malformed cursors and invalid limits', () => {
  const malformed = keysetPage(items, { limit: 1, cursor: 'not-a-keyset' as never });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, 'ValidationFailed');

  const invalidLimit = keysetPage(items, { limit: 0 });
  assert.equal(invalidLimit.ok, false);
  if (!invalidLimit.ok) assert.equal(invalidLimit.error.code, 'ValidationFailed');
});
