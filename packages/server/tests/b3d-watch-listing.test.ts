import assert from 'node:assert/strict';
import test from 'node:test';
import { currentDeadlines } from '../core/b3/supervision-methods.js';

test('combined watcher listing exposes only the latest generation deadline', () => {
  const ruleId = 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab' as never;
  const deadlines = [
    { watchRuleId: ruleId, activityGeneration: 1, state: 'superseded' },
    { watchRuleId: ruleId, activityGeneration: 2, state: 'armed' },
  ] as never;
  const current = currentDeadlines(deadlines, new Set([ruleId]));
  assert.equal(current.length, 1);
  assert.equal(current[0]!.activityGeneration, 2);
  assert.equal(current[0]!.state, 'armed');
});
