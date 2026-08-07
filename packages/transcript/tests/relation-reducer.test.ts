import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTranscriptRelationDelta,
  emptyTranscriptRelationState,
} from '../core/relations.js';

const relationKey = (digit: string): `relation_${string}` =>
  `relation_${digit.repeat(64)}`;

test('relation reducer prunes a three-child parent only after its third child', () => {
  const parentKey = relationKey('a');
  let state = applyTranscriptRelationDelta(
    emptyTranscriptRelationState(),
    {
      type: 'parent',
      parentKey,
      parentTurnId: `turn_${'b'.repeat(64)}`,
      remainingChildren: 3,
    },
  );
  assert.equal(state.parents[parentKey]?.remainingChildren, 3);

  for (const [index, digit] of ['c', 'd', 'e'].entries()) {
    state = applyTranscriptRelationDelta(state, {
      type: 'child',
      childKey: relationKey(digit),
      parentKey,
    });
    assert.equal(
      state.parents[parentKey]?.remainingChildren,
      index < 2 ? 2 - index : undefined,
    );
    assert.equal(Object.keys(state.children).length, index + 1);
  }
});
