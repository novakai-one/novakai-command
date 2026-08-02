import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDriftEpisodeId,
  isNotificationId,
  isWatchDeadlineId,
  isWatchRuleId,
  deriveDriftEpisodeId,
  mintWatchRuleId,
} from '../contract/index.js';

const UUID7 = '018f0f8a-4f7b-7abc-8def-0123456789ab';
const HASH = 'a'.repeat(52);

test('Supervision identities accept only their own §4.1 prefix and format', () => {
  assert.equal(isWatchRuleId(`watchRule_${UUID7}`), true);
  assert.equal(isWatchDeadlineId(`watchDeadline_${HASH}`), true);
  assert.equal(isNotificationId(`notification_${HASH}`), true);
  assert.equal(isDriftEpisodeId(`driftEpisode_${HASH}`), true);
  assert.equal(isWatchRuleId(`notification_${HASH}`), false);
  assert.equal(isNotificationId(`watchDeadline_${HASH}`), false);
});

test('drift episode identity is deterministic over the exact §9.2 tuple', () => {
  const input = {
    watchRuleId: `watchRule_${UUID7}` as never,
    subjectKey: 'agentRun:one',
    activityGeneration: 4 as never,
    fingerprint: 'sha256:fingerprint',
    episodeOrdinal: 2,
  };
  const first = deriveDriftEpisodeId(input);
  assert.equal(isDriftEpisodeId(first), true);
  assert.equal(deriveDriftEpisodeId(input), first);
  assert.notEqual(deriveDriftEpisodeId({ ...input, episodeOrdinal: 3 }), first);
});

test('Supervision mints lowercase UUIDv7 WatchRule identities', () => {
  assert.equal(isWatchRuleId(mintWatchRuleId()), true);
});
