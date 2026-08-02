import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isDriftEpisodeId,
  isNotificationId,
  isWatchDeadlineId,
  isWatchRuleId,
  deriveDriftEpisodeId,
  deriveNotificationId,
  deriveWatchDeadlineId,
  mintWatchRuleId,
  subjectKey,
  notificationDeliveryEffectKey,
  deriveNotificationInputReservationId,
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
  const runId = `agentRun_${UUID7}` as never;
  const input = {
    watchRuleId: `watchRule_${UUID7}` as never,
    subjectKey: subjectKey({ kind: 'agent-run', agentRunId: runId }),
    activityGeneration: 4 as never,
    fingerprint: 'sha256:fingerprint',
    episodeOrdinal: 2,
  };
  const first = deriveDriftEpisodeId(input);
  assert.equal(isDriftEpisodeId(first), true);
  assert.equal(
    first,
    'driftEpisode_nvd7d5xac34xfw5pobxkv7ii6ekunznl7sqtumwtokyz2jlgveoq',
  );
  assert.equal(deriveDriftEpisodeId(input), first);
  assert.notEqual(deriveDriftEpisodeId({ ...input, episodeOrdinal: 3 }), first);
});

test('deadline and notification identities use the ruled domain tuples', () => {
  const runId = `agentRun_${UUID7}` as never;
  const ruleId = `watchRule_${UUID7}` as never;
  const key = subjectKey({ kind: 'agent-run', agentRunId: runId });
  assert.equal(key, `agent-run:${String(runId)}`);
  assert.equal(
    deriveWatchDeadlineId({
      watchRuleId: ruleId,
      subjectKey: key,
      activityGeneration: 4 as never,
    }),
    'watchDeadline_hzvya2ucdznmmm6p7d6qpzyhyvdr25g6dj3dayhazi4yjhxq4zoq',
  );
  assert.equal(
    deriveNotificationId({
      watchRuleId: ruleId,
      subjectKey: key,
      condition: { kind: 'output-tokens-at-least', value: 100_000 },
      activityGeneration: 4 as never,
      phase: 'condition',
    }),
    'notification_ia2eu5zx733bmoafubjjtlxrqxiji5lvma3pshhsfyzh3oh7swiq',
  );
  assert.equal(
    notificationDeliveryEffectKey(
      'notification_ia2eu5zx733bmoafubjjtlxrqxiji5lvma3pshhsfyzh3oh7swiq' as never,
    ),
    'b3v4:notification-delivery:notification_ia2eu5zx733bmoafubjjtlxrqxiji5lvma3pshhsfyzh3oh7swiq:condition',
  );
  assert.match(
    deriveNotificationInputReservationId('b3v4:notification-delivery:test:condition'),
    /^notificationInput_[a-z2-7]{52}$/,
  );
});

test('Supervision mints lowercase UUIDv7 WatchRule identities', () => {
  assert.equal(isWatchRuleId(mintWatchRuleId()), true);
});
