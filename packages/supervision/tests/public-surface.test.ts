import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SUPERVISION_CLI_COMMANDS,
  SUPERVISION_EVENT_KINDS,
} from '../contract/index.js';

test('the frozen public event surface contains exactly the §15 supervision rows', () => {
  assert.deepEqual(SUPERVISION_EVENT_KINDS, [
    'supervision.deadline.changed',
    'supervision.notification.changed',
    'supervision.drift.ping',
    'supervision.drift.cleared',
    'supervision.drift.detected',
    'supervision.drift.escalated',
  ]);
});

test('the frozen CLI surface contains exactly the §17 supervision verbs', () => {
  assert.deepEqual(SUPERVISION_CLI_COMMANDS, [
    'nvk watch add',
    'nvk watch list',
    'nvk watch update',
    'nvk watch remove',
    'nvk watch notifications',
    'nvk watch acknowledge',
    'nvk watch reset-drift',
  ]);
});
