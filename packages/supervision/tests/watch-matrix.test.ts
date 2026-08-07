import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  b3ok, mintClientOpId, mintTraceCorrelationId,
} from '@novakai/foundation/contract';
import {
  watchOccurrenceFamily,
  type CreateWatchRuleInput, type WatchCondition, type WatchOccurrenceFamily,
  type WatchSubject,
} from '../contract/index.js';
import { composeSupervision } from '../core/index.js';

const AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000a1' as never;
const HUMAN = {
  id: 'person_chris' as never,
  kind: 'human' as const,
  verifiedScopes: ['supervision:watch:start-turn' as never],
};

const subjects: readonly WatchSubject[] = [
  { kind: 'agent', agentId: AGENT_ID },
  { kind: 'agent-run', agentRunId: RUN_ID },
  { kind: 'children-of', agentId: AGENT_ID },
];

const conditions: readonly WatchCondition[] = [
  { kind: 'turn-count-at-least', value: 1 },
  { kind: 'input-tokens-at-least', value: 1 },
  { kind: 'output-tokens-at-least', value: 1 },
  { kind: 'cost-micros-at-least', value: 1 },
  { kind: 'idle-for-ms', value: 1_000 },
  { kind: 'activity-drift', intervalMs: 300_000, staleAfterIntervals: 2,
    escalateAfterConsecutive: 3 },
  { kind: 'run-disconnected' },
  { kind: 'run-final' },
  { kind: 'child-needs-help' },
  { kind: 'operation-failed' },
];

const expected: Readonly<Record<WatchCondition['kind'], readonly WatchOccurrenceFamily[]>> = {
  'turn-count-at-least': ['AR', 'L', 'AR'],
  'input-tokens-at-least': ['AR', 'L', 'AR'],
  'output-tokens-at-least': ['AR', 'L', 'AR'],
  'cost-micros-at-least': ['AR', 'L', 'AR'],
  'idle-for-ms': ['R', 'L', 'R'],
  'activity-drift': ['R', 'A-03', 'R'],
  'run-disconnected': ['EV', 'L', 'EV'],
  'run-final': ['AR', 'L', 'AR'],
  'child-needs-help': ['EV', 'EV', 'EV'],
  'operation-failed': ['OP', 'OP', 'OP'],
};

function input(subject: WatchSubject, condition: WatchCondition): CreateWatchRuleInput {
  return {
    subject,
    condition,
    recipient: { kind: 'human', principalId: HUMAN.id },
    deliveryMode: 'queue-only',
    cooldownMs: 0,
    status: 'active',
    ...(condition.kind === 'activity-drift' ? {
      driftPolicy: {
        mode: 'cheap-first' as const,
        freeEvidence: [
          'terminal-liveness', 'transcript-advance', 'usage-delta',
        ] as const,
        statusTurn: 'queue-runtime-status-request-only-after-free-evidence-suspicious' as const,
        statusRecipient: 'subject-agent' as const,
        statusDeliveryMode: 'start-turn' as const,
        replyWindowMs: 300_000,
        statusPrompt: 'Status check: reply with one line — what are you working on right now?' as const,
      },
    } : {}),
  };
}

const humanContext = () => ({
  principal: HUMAN,
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1 as const,
});

test('all 30 matrix cells have exact contract, create, and update behavior', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-watch-matrix-'));
  try {
    const supervision = composeSupervision({
      root, dataRoot: path.join(root, 'stores'),
      installAuthority: { resolve: async () => { throw new Error('not used'); } },
      watchRuleAccess: { agentIdFor: async () => b3ok(null) },
      watchRuleGeneration: { generationFor: async () => b3ok(4 as never) },
    });
    let admittedCreates = 0;
    for (const condition of conditions) {
      for (const [subjectIndex, subject] of subjects.entries()) {
        const family = watchOccurrenceFamily(subject, condition);
        assert.equal(family, expected[condition.kind][subjectIndex],
          `${subject.kind}/${condition.kind}`);
        const created = await supervision.createWatchRule(
          humanContext(), input(subject, condition),
        );
        if (family === 'R') {
          assert.equal(created.ok, false, `${subject.kind}/${condition.kind} created`);
          if (!created.ok) {
            assert.equal(created.error.code, 'WatchRuleInvalid');
            assert.deepEqual(created.error.details['issues'], [{
              issue: condition.kind === 'activity-drift'
                ? 'activity-drift is admitted only for an exact agent-run subject'
                : 'the subject has no single authoritative Run-local clock for this condition',
              subjectKind: subject.kind,
              conditionKind: condition.kind,
            }]);
          }
        } else {
          assert.equal(created.ok, true, `${subject.kind}/${condition.kind} rejected`);
          if (created.ok) admittedCreates += 1;
        }
      }
    }
    const createdRules = await supervision.listWatchRules(HUMAN, { limit: 100 });
    assert.equal(createdRules.ok, true);
    if (!createdRules.ok) return;
    assert.equal(createdRules.value.items.length, admittedCreates);

    const seed = await supervision.createWatchRule(
      humanContext(), input(subjects[1]!, conditions[7]!),
    );
    assert.equal(seed.ok, true);
    if (!seed.ok) return;
    let current = seed.value;
    for (const condition of conditions) {
      for (const subject of subjects) {
        const family = watchOccurrenceFamily(subject, condition);
        const beforeVersion = current.recordVersion;
        const updated = await supervision.updateWatchRule(humanContext(), {
          watchRuleId: current.id,
          expectedRecordVersion: current.recordVersion,
          replacement: input(subject, condition),
        });
        if (family === 'R') {
          assert.equal(updated.ok, false, `${subject.kind}/${condition.kind} updated`);
          if (!updated.ok) assert.equal(updated.error.code, 'WatchRuleInvalid');
          const unchanged = await supervision.listWatchRules(HUMAN, { limit: 100 });
          assert.equal(unchanged.ok, true);
          if (unchanged.ok) {
            const same = unchanged.value.items.find((rule) => rule.id === current.id)!;
            assert.equal(same.recordVersion, beforeVersion);
            assert.deepEqual(same.subject, current.subject);
            assert.deepEqual(same.condition, current.condition);
          }
        } else {
          assert.equal(updated.ok, true, `${subject.kind}/${condition.kind} rejected`);
          if (updated.ok) current = updated.value;
        }
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
