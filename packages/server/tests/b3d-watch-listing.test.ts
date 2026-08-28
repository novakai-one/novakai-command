import assert from 'node:assert/strict';
import test from 'node:test';
import { currentDeadlines } from '../core/runtime-host/supervision-methods.js';

test('combined watcher listing exposes only the latest generation deadline', () => {
  const ruleId = 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab' as never;
  const deadlines = [
    { watchRuleId: ruleId, activityGeneration: 1, state: 'superseded' },
    { watchRuleId: ruleId, activityGeneration: 2, state: 'armed' },
  ] as never;
  const current = currentDeadlines(deadlines, new Map([[ruleId, 2 as never]]));
  assert.equal(current.length, 1);
  assert.equal(current[0]!.activityGeneration, 2);
  assert.equal(current[0]!.state, 'armed');
});

test('combined watcher listing omits a stale-only superseded deadline', () => {
  const ruleId = 'watchRule_018f0f8a-4f7b-7abc-8def-0123456789ab' as never;
  const deadlines = [
    { watchRuleId: ruleId, activityGeneration: 1, state: 'superseded' },
  ] as never;
  const current = currentDeadlines(deadlines, new Map([[ruleId, 2 as never]]));
  assert.deepEqual(current, [], 'a stale row was rendered as the current deadline');
});
