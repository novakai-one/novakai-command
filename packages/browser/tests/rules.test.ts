// Pure session-rules tests (lease math + allocation). Run with
// `npx tsx packages/browser/tests/rules.test.ts`.
import assert from 'node:assert/strict';
import { decideAllocation, isLeaseExpired, leaseExpiresAt } from '../domain/rules.js';
import type { Session } from '../domain/types.js';

const FIXED_NOW = new Date('2026-07-17T00:00:10.000Z');

function makeSession(over: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    agentId: 'a1',
    instance: { processId: 111, port: 9300, userDataDir: '/tmp/x', cdpEndpoint: 'http://127.0.0.1:9300' },
    status: 'active',
    leaseExpiresAt: '2026-07-17T00:00:20.000Z',
    ...over,
  };
}

function testExpiresAtIsNowPlusTtl(): void {
  const clock = new Date('2026-07-17T00:00:00.000Z');
  assert.equal(leaseExpiresAt(clock, 1000), '2026-07-17T00:00:01.000Z');
}

function testExpiredWhenDeadlinePassed(): void {
  assert.equal(isLeaseExpired({ leaseExpiresAt: '2026-07-17T00:00:10.000Z' }, FIXED_NOW), true, 'equal instant expired');
  assert.equal(isLeaseExpired({ leaseExpiresAt: '2026-07-17T00:00:05.000Z' }, FIXED_NOW), true, 'past deadline expired');
  assert.equal(isLeaseExpired({ leaseExpiresAt: '2026-07-17T00:00:20.000Z' }, FIXED_NOW), false, 'ahead not expired');
}

function testNoSessionLaunches(): void {
  assert.equal(decideAllocation(undefined, false, FIXED_NOW).kind, 'launch');
}

function testHealthySessionReuses(): void {
  const decision = decideAllocation(makeSession(), true, FIXED_NOW);
  assert.equal(decision.kind, 'reuse');
  assert.equal(decision.session?.sessionId, 's1');
}

function testStaleSessionsLaunch(): void {
  assert.equal(decideAllocation(makeSession({ leaseExpiresAt: '2026-07-17T00:00:05.000Z' }), true, FIXED_NOW).kind, 'launch', 'expired');
  assert.equal(decideAllocation(makeSession(), false, FIXED_NOW).kind, 'launch', 'dead instance');
  assert.equal(decideAllocation(makeSession({ status: 'released' }), true, FIXED_NOW).kind, 'launch', 'released');
}

testExpiresAtIsNowPlusTtl();
testExpiredWhenDeadlinePassed();
testNoSessionLaunches();
testHealthySessionReuses();
testStaleSessionsLaunch();
console.log('PASS');
