import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3ok,
  type AgentRunId,
  type IsoUtc,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  composeSupervision,
  createSupervisionStore,
  type SupervisionCore,
  type SupervisionCoreOptions,
} from '../core/index.js';
import {
  deriveDriftEpisodeId,
  type CheckRunDriftInput,
  type DriftCheckOutcome,
  type SupervisionContract,
  type WatchDeadline,
} from '../contract/index.js';

const RUN_ID = 'agentRun_019fd000-0000-7000-8000-0000000000b1' as AgentRunId;
const PLAN_ID = 'launchPlan_019fd000-0000-7000-8000-0000000000b2' as never;

const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174100' as never,
  traceId: 'trace_123e4567-e89b-42d3-a456-426614174100' as never,
  contractVersion: 1,
});

const supervisionContext = (): SystemCommandContext<'sys_supervision'> => ({
  principal: { id: 'sys_supervision', kind: 'system', verifiedScopes: [] },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174101' as never,
  traceId: 'trace_123e4567-e89b-42d3-a456-426614174101' as never,
  contractVersion: 1,
});

function unwrap<Value>(result: { readonly ok: true; readonly value: Value } | {
  readonly ok: false; readonly error: { readonly message: string };
}): Value {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

test('identical free evidence establishes a baseline then opens one quiet episode without a turn', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-drift-'));
  let now = new Date('2026-08-03T00:00:00.000Z');
  let sample = 0;
  const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
  const options = {
    root,
    dataRoot: path.join(root, 'stores'),
    store,
    clock: () => now,
    installAuthority: {
      resolve: async () => b3ok({
        agentRunId: RUN_ID,
        launchPlanId: PLAN_ID,
        activityDrift: 'required' as const,
        requiredTemplateRefs: [],
        parentNotificationMode: 'queue-only' as const,
        recipient: { kind: 'human' as const, principalId: 'person_chris' as never },
        activityGeneration: 4 as never,
        watchStartTurnAuthorized: true,
        requestProvenance: {
          requestedBy: 'person_chris' as never,
          traceId: 'trace_123e4567-e89b-42d3-a456-426614174100' as never,
        },
      }),
    },
    watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    driftEvidence: {
      observe: async () => b3ok({
        terminalLiveness: 'live' as const,
        terminalActivityGeneration: 4 as never,
        transcriptWatermark: 'transcript.42',
        usageActivityDigest: 'usage:in=10;out=20;turns=2',
        usageSourceCursor: 'usage.7',
        evidenceRefs: [`sample-${String(++sample)}`],
      }),
    },
  } as SupervisionCoreOptions & {
    readonly driftEvidence: {
      observe(agentRunId: AgentRunId): Promise<ReturnType<typeof b3ok<{
        readonly terminalLiveness: 'live';
        readonly terminalActivityGeneration: never;
        readonly transcriptWatermark: string;
        readonly usageActivityDigest: string;
        readonly usageSourceCursor: string;
        readonly evidenceRefs: readonly string[];
      }>>>;
    };
  };
  const supervision = composeSupervision(options) as SupervisionCore & SupervisionContract;

  try {
    const rules = unwrap(await supervision.installRunWatchers(runtimeContext(), {
      agentRunId: RUN_ID,
      launchPlanId: PLAN_ID,
      requiredTemplateRefs: [],
      recipient: { kind: 'human', principalId: 'person_chris' as never },
      activityGeneration: 4 as never,
      requestProvenance: {
        requestedBy: 'person_chris' as never,
        traceId: 'trace_123e4567-e89b-42d3-a456-426614174100' as never,
        clientOpId: runtimeContext().clientOpId,
      },
    }));
    const rule = rules[0]!;
    let deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    const input = (): CheckRunDriftInput => ({
      watchRuleId: rule.id,
      agentRunId: RUN_ID,
      expectedActivityGeneration: 4 as never,
      dueDeadlineId: deadline.id,
      expectedDeadlineRecordVersion: deadline.recordVersion,
    });

    now = new Date('2026-08-03T00:05:00.000Z');
    const baseline: DriftCheckOutcome = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.deepEqual(baseline, {
      kind: 'healthy-free-evidence',
      providerTurnsStartedThisEvaluation: 0,
      evidenceRefs: ['sample-1'],
    });
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T00:10:00.000Z');
    assert.equal(deadline.driftState?.quietIntervals, 0);
    const fingerprint = deadline.driftState?.lastEvidence?.fingerprint;
    assert.equal(typeof fingerprint, 'string');

    now = new Date('2026-08-03T00:10:00.000Z');
    const quiet: DriftCheckOutcome = unwrap(
      await supervision.checkRunDrift(supervisionContext(), input()),
    );
    assert.deepEqual(quiet, {
      kind: 'first-quiet-interval',
      providerTurnsStartedThisEvaluation: 0,
      staleIntervals: 1,
    });
    deadline = unwrap(await store.list<WatchDeadline>('watchDeadline'))[0]!;
    assert.equal(deadline.dueAt, '2026-08-03T00:15:00.000Z');
    assert.equal(deadline.driftState?.lastEvidence?.fingerprint, fingerprint,
      'audit refs and checkedAt changed the activity-bearing fingerprint');
    assert.equal(deadline.driftState?.episodeOrdinal, 1);
    assert.equal(deadline.driftState?.quietIntervals, 1);
    assert.equal(deadline.driftState?.episodeId, deriveDriftEpisodeId({
      watchRuleId: rule.id,
      subjectKey: deadline.subjectKey,
      activityGeneration: deadline.activityGeneration,
      fingerprint: fingerprint!,
      episodeOrdinal: 1,
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
