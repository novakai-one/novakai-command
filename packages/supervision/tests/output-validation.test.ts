import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseNotificationEvent,
  parseProviderUsageEvidenceCommittedEvent,
} from '../contract/index.js';
import {
  queuedNotificationEvent,
  usageEvidenceEvent,
} from './fixtures.js';

test('notification event parser enforces the concrete §12.7 payload', () => {
  const valid = parseNotificationEvent(queuedNotificationEvent('queue-only'));
  assert.equal(valid.ok, true, valid.ok ? '' : valid.error.message);

  const event = queuedNotificationEvent('queue-only');
  const invalid = parseNotificationEvent({
    ...event,
    payload: { ...event.payload, phase: 'drift-status-request' },
  });
  assert.equal(invalid.ok, false);
});

test('usage-evidence event parser rejects a non-numeric provider total', () => {
  const measurement = {
    quality: 'measured',
    outputTokens: 100_000,
    limitations: [],
    evidenceDigest: 'sha256:usage',
  } as const;
  const event = usageEvidenceEvent(measurement);
  assert.equal(parseProviderUsageEvidenceCommittedEvent(event).ok, true);
  const invalid = {
    ...event,
    payload: {
      ...event.payload,
      measurement: { ...measurement, outputTokens: '100000' },
    },
  };
  assert.equal(parseProviderUsageEvidenceCommittedEvent(invalid).ok, false);
});
