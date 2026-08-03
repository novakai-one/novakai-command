import assert from 'node:assert/strict';
import test from 'node:test';
import { b3ok } from '@novakai/foundation/contract';
import {
  parseNotificationEvent,
  parseNotificationPage,
  parseCliOutput,
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

  const mismatchedAttempt = parseNotificationEvent({
    ...event,
    payload: {
      ...event.payload,
      deliveryAttempt: { state: 'queued', effectKey: 'different-effect' },
    },
  });
  assert.equal(mismatchedAttempt.ok, false);

  const wrongDeliveryKey = parseNotificationEvent({
    ...event,
    payload: {
      ...event.payload,
      deliveryEffectKey: 'b3v4:notification-delivery:wrong:condition',
      deliveryAttempt: {
        state: 'queued',
        effectKey: 'b3v4:notification-delivery:wrong:condition',
      },
    },
  });
  assert.equal(wrongDeliveryKey.ok, false);
});

test('notification Page output validates every item and omission', () => {
  const event = queuedNotificationEvent('queue-only');
  const parsed = parseNotificationPage({
    items: [event.payload],
    nextCursor: 'cursor_page-2',
    omissions: [{ reason: 'permission', count: 1 }],
  });
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);

  const cli = parseCliOutput({
    schemaVersion: 1,
    ok: true,
    command: 'nvk watch notifications',
    value: {
      items: [event.payload],
      nextCursor: 'cursor_page-2',
      omissions: [],
    },
  }, parseNotificationPage);
  assert.equal(cli.ok, true, cli.ok ? '' : cli.error.message);

  assert.equal(parseNotificationPage({
    items: [event.payload],
    omissions: [{ reason: 'hidden', count: 1 }],
  }).ok, false);

  assert.equal(parseCliOutput({
    schemaVersion: 1,
    ok: false,
    command: 'nvk watch notifications',
    error: {
      code: 'WatchRuleInvalid',
      message: 'bad rule',
      details: { issues: [] },
      retryable: 'no',
    },
  }, parseNotificationPage).ok, false);
});

test('AMD-003 #42: RecoveryRequired validates the owning Supervision operation identity', () => {
  const parser = () => b3ok(null);
  const operationIds = [
    `watchEvaluation_${'a'.repeat(52)}`,
    `notificationDeliveryFenceOperation_${'b'.repeat(52)}`,
    `receipt_${'c'.repeat(52)}`,
  ];
  for (const operationId of operationIds) {
    const parsed = parseCliOutput({
      schemaVersion: 1,
      ok: false,
      command: 'nvk watch repair',
      error: {
        code: 'RecoveryRequired',
        message: 'owner evidence is not yet complete',
        details: { operationId, reason: 'owner evidence is not yet complete' },
        retryable: true,
      },
    }, parser);
    assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.error.message);
  }
  for (const operationId of [
    `runOperation_${'d'.repeat(52)}`,
    `watchDeadline_${'e'.repeat(52)}`,
    'watchEvaluation_not-a-hash',
  ]) {
    assert.equal(parseCliOutput({
      schemaVersion: 1,
      ok: false,
      command: 'nvk watch repair',
      error: {
        code: 'RecoveryRequired',
        message: 'bad operation owner',
        details: { operationId },
        retryable: true,
      },
    }, parser).ok, false);
  }
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
