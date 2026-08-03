import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  b3err, b3fail, b3ok, deriveClientOpId, mintClientOpId, mintTraceCorrelationId,
  type B3Result,
} from '@novakai/foundation/contract';
import type {
  ProviderUsageEvidence, RunUsageFacts, WatchRule,
} from '../contract/index.js';
import {
  composeSupervision, createSupervisionStore, type SupervisionCore,
} from '../core/index.js';
import { usageEvidenceEvent } from './fixtures.js';

const AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174000' as never;
const OTHER_AGENT_ID = 'agent_123e4567-e89b-42d3-a456-426614174001' as never;
const RUN_IDS = [
  'agentRun_019fd000-0000-7000-8000-0000000000a1',
  'agentRun_019fd000-0000-7000-8000-0000000000a2',
  'agentRun_019fd000-0000-7000-8000-0000000000a3',
] as const;
const SESSION_IDS = [
  'sess_123e4567-e89b-42d3-a456-426614174000',
  'sess_123e4567-e89b-42d3-a456-426614174001',
  'sess_123e4567-e89b-42d3-a456-426614174002',
] as const;
const HUMAN = {
  id: 'person_chris' as never,
  kind: 'human' as const,
  verifiedScopes: ['supervision:watch:repair' as never],
};
const SYSTEM = { id: 'sys_agents' as const, kind: 'system' as const, verifiedScopes: [] };

interface MutableOwners {
  readonly runs: Map<string, RunUsageFacts>;
  readonly evidence: Map<string, ProviderUsageEvidence>;
  resolveCalls: number;
  resolve?: (providerSessionId: string, call: number) => B3Result<RunUsageFacts | null>;
  onEvidenceRead?: () => Promise<void>;
  related?: B3Result<boolean>;
}

function run(
  index: number,
  agentId = AGENT_ID,
  activityGeneration = 1,
): RunUsageFacts {
  return {
    agentRunId: RUN_IDS[index]! as never,
    agentId,
    providerSessionId: SESSION_IDS[index]! as never,
    lifecycle: index === 0 ? 'stopped' : 'ready',
    final: index === 0,
    activityGeneration: activityGeneration as never,
    recordVersion: 1 as never,
  };
}

function event(
  index: number,
  options: { readonly output?: number; readonly observedAt?: string } = {},
) {
  const character = ['a', 'b', 'c'][index]!;
  const observedAt = options.observedAt ?? `2026-08-04T00:00:0${String(index)}.000Z`;
  const base = usageEvidenceEvent({
    quality: 'measured', inputTokens: 1, outputTokens: options.output ?? 10,
    cachedInputTokens: 0, costMicros: 1, providerTurns: 1,
    limitations: [], evidenceDigest: `sha256:evaluation-${String(index)}`,
  }, index === 0 ? 1 : 2);
  return {
    ...base,
    eventId: `event_evaluation-${String(index)}`,
    occurredAt: observedAt,
    committedAt: observedAt,
    cursor: `cursor-evaluation-${String(index)}` as never,
    payload: {
      ...base.payload,
      id: `providerUsage_${character.repeat(52)}`,
      providerSessionId: SESSION_IDS[index]!,
      observedAt,
      measurement: {
        quality: 'measured',
        inputTokens: 1,
        outputTokens: options.output ?? 10,
        cachedInputTokens: 0,
        costMicros: 1,
        providerTurns: 1,
        limitations: [],
        evidenceDigest: `sha256:evaluation-${String(index)}`,
      },
    },
  } as unknown as ReturnType<typeof usageEvidenceEvent>;
}

function ownersFor(...events: ReturnType<typeof event>[]): MutableOwners {
  const owners: MutableOwners = {
    runs: new Map(), evidence: new Map(), resolveCalls: 0,
  };
  for (const candidate of events) {
    owners.evidence.set(
      String(candidate.payload.id),
      candidate.payload as unknown as ProviderUsageEvidence,
    );
  }
  return owners;
}

function compose(root: string, owners: MutableOwners): SupervisionCore {
  return composeSupervision({
    root,
    dataRoot: path.join(root, 'stores'),
    installAuthority: { resolve: async () => { throw new Error('not used'); } },
    watchRuleAccess: { agentIdFor: async () => b3ok(null) },
    watchRuleGeneration: { generationFor: async () => b3ok(1 as never) },
    occurrenceRelationships: {
      isDirectManagedChild: async () => owners.related ?? b3ok(true),
    },
    usage: {
      runs: {
        getUsageRun: async (_principal, agentRunId) => b3ok(
          [...owners.runs.values()].find((candidate) => candidate.agentRunId === agentRunId)!,
        ),
        listUsageRuns: async (_principal, agentId) => b3ok(
          [...owners.runs.values()].filter((candidate) => candidate.agentId === agentId),
        ),
        resolveUsageRunByProviderSession: async (_principal, providerSessionId) => {
          owners.resolveCalls += 1;
          return owners.resolve?.(String(providerSessionId), owners.resolveCalls)
            ?? b3ok(owners.runs.get(String(providerSessionId)) ?? null);
        },
        resolveCurrentRunByAgent: async (_principal, agentId) => b3ok(
          [...owners.runs.values()].find(
            (candidate) => candidate.agentId === agentId && !candidate.final,
          ) ?? null,
        ),
        getRunOccurrenceEvent: async () => b3ok(null),
      },
      evidence: {
        getProviderUsageEvidence: async (_principal, id) => {
          await owners.onEvidenceRead?.();
          return b3ok(owners.evidence.get(String(id)) ?? null);
        },
        listProviderUsageEvidence: async () => b3ok({ items: [], omissions: [] }),
      },
    },
  });
}

const humanContext = (clientOpId = mintClientOpId()) => ({
  principal: HUMAN,
  clientOpId,
  traceId: mintTraceCorrelationId(),
  contractVersion: 1 as const,
});

const systemContext = (clientOpId = mintClientOpId()) => ({
  principal: SYSTEM,
  clientOpId,
  traceId: mintTraceCorrelationId(),
  contractVersion: 1 as const,
});

async function createThresholdRule(
  supervision: SupervisionCore,
  options: {
    readonly value?: number;
    readonly cooldownMs?: number;
  } = {},
): Promise<WatchRule> {
  const created = await supervision.createWatchRule(humanContext(), {
    subject: { kind: 'agent', agentId: AGENT_ID },
    condition: { kind: 'output-tokens-at-least', value: options.value ?? 1 },
    recipient: { kind: 'human', principalId: HUMAN.id },
    deliveryMode: 'queue-only',
    cooldownMs: options.cooldownMs ?? 0,
    status: 'active',
  });
  if (!created.ok) assert.fail(created.error.message);
  return created.value;
}

test('AMD-003 #3/#4/#16: visibility lag resumes one receipt and redelivery adopts', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-evaluation-visibility-'));
  try {
    const usage = event(0);
    const owners = ownersFor(usage);
    const source = run(0);
    let visible = false;
    owners.resolve = () => b3ok(visible ? source : null);
    owners.runs.set(String(source.providerSessionId), source);
    const firstHost = compose(root, owners);
    await createThresholdRule(firstHost);
    const clientOpId = mintClientOpId();
    const context = systemContext(clientOpId);
    const first = await firstHost.evaluateEvent(context, { event: usage });
    assert.equal(first.ok, false);
    if (!first.ok) {
      assert.equal(first.error.code, 'RuntimeUnavailable');
      assert.equal(first.error.details['reason'], 'usage-run-not-yet-visible');
    }
    const recovery = await firstHost.listWatchEvaluationProgress(HUMAN, {
      limit: 10, state: 'recovery-required',
    });
    assert.equal(recovery.ok, true);
    if (recovery.ok) assert.equal(recovery.value.items.length, 1);

    visible = true;
    const resumedHost = compose(root, owners);
    const resumed = await resumedHost.evaluateEvent(context, { event: usage });
    assert.equal(resumed.ok, true, resumed.ok ? '' : resumed.error.message);
    if (!resumed.ok) return;
    assert.equal(resumed.value.length, 1);
    const receiptReplay = await resumedHost.evaluateEvent(context, { event: usage });
    assert.deepEqual(receiptReplay, resumed);
    const eventRedelivery = await resumedHost.evaluateEvent(
      systemContext(), { event: usage },
    );
    assert.deepEqual(eventRedelivery, b3ok([]));
    const stored = await resumedHost.listNotifications(HUMAN, { limit: 10 });
    assert.equal(stored.ok, true);
    if (stored.ok) assert.equal(stored.value.items.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #5: non-retryable correlation failure is isolated and observable', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-evaluation-isolation-'));
  try {
    const usage = event(0);
    const owners = ownersFor(usage);
    const source = run(0);
    owners.runs.set(String(source.providerSessionId), source);
    owners.resolve = (_session, call) => call === 1
      ? b3fail(b3err(
          'ProviderSessionReservationConflict', 'duplicate Runtime bindings',
          { conflictingAgentRunIds: [RUN_IDS[0], RUN_IDS[1]] }, false,
        ))
      : b3ok(source);
    const supervision = compose(root, owners);
    const failingRule = await createThresholdRule(supervision);
    const healthyRule = await createThresholdRule(supervision, { value: 2 });
    const evaluated = await supervision.evaluateEvent(systemContext(), { event: usage });
    assert.equal(evaluated.ok, true, evaluated.ok ? '' : evaluated.error.message);
    if (!evaluated.ok) return;
    assert.equal(evaluated.value.length, 1);
    assert.equal(evaluated.value[0]!.watchRuleId, healthyRule.id);
    const progress = await supervision.listWatchEvaluationProgress(HUMAN, { limit: 10 });
    assert.equal(progress.ok, true);
    if (!progress.ok) return;
    const failed = progress.value.items[0]!.completed.find(
      (entry) => entry.watchRuleId === failingRule.id,
    );
    assert.equal(failed?.outcome.kind, 'failed-non-retryable');
    if (failed?.outcome.kind === 'failed-non-retryable') {
      assert.equal(failed.outcome.code, 'ProviderSessionReservationConflict');
    }
    assert.equal(progress.value.items[0]!.state, 'completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #6/#19: mutation fences non-match and retries newest matching policy', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-evaluation-policy-'));
  try {
    const usage = event(0, { output: 10 });
    const owners = ownersFor(usage);
    const source = run(0);
    owners.runs.set(String(source.providerSessionId), source);
    const supervision = compose(root, owners);
    const rule = await createThresholdRule(supervision, { value: 100 });
    const store = createSupervisionStore({ root, dataRoot: path.join(root, 'stores') });
    let mutated = false;
    owners.onEvidenceRead = async () => {
      if (mutated) return;
      mutated = true;
      const current = await store.read<WatchRule>('watchRule', rule.id);
      assert.equal(current.ok, true);
      if (!current.ok || current.value === null) return;
      const changed = await store.update<WatchRule>(
        'sys_supervision', current.value.id,
        { condition: { kind: 'output-tokens-at-least', value: 1 } },
        current.value.recordVersion,
        deriveClientOpId(`test:mutate-rule:${String(rule.id)}`),
      );
      assert.equal(changed.ok, true, changed.ok ? '' : changed.error.message);
    };
    const context = systemContext();
    const fenced = await supervision.evaluateEvent(context, { event: usage });
    assert.equal(fenced.ok, false);
    if (!fenced.ok) assert.equal(fenced.error.code, 'VersionConflict');
    const resumed = await supervision.evaluateEvent(context, { event: usage });
    assert.equal(resumed.ok, true, resumed.ok ? '' : resumed.error.message);
    if (resumed.ok) assert.equal(resumed.value.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #7/#17: two hosts linearize replay and distinct cooldown decisions', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-evaluation-concurrency-'));
  try {
    const firstEvent = event(0, { observedAt: '2026-08-04T00:00:10.000Z' });
    const secondEvent = event(1, { observedAt: '2026-08-04T00:00:11.000Z' });
    const owners = ownersFor(firstEvent, secondEvent);
    const firstRun = run(0);
    const secondRun = run(1);
    owners.runs.set(String(firstRun.providerSessionId), firstRun);
    owners.runs.set(String(secondRun.providerSessionId), secondRun);
    const hostA = compose(root, owners);
    const hostB = compose(root, owners);
    await createThresholdRule(hostA, { cooldownMs: 60_000 });
    const same = await Promise.all([
      hostA.evaluateEvent(systemContext(), { event: firstEvent }),
      hostB.evaluateEvent(systemContext(), { event: firstEvent }),
    ]);
    assert.equal(same.every((result) => result.ok), true);
    assert.equal(same.flatMap((result) => result.ok ? result.value : []).length, 1);
    const distinct = await Promise.all([
      hostA.evaluateEvent(systemContext(), { event: secondEvent }),
      hostB.evaluateEvent(systemContext(), { event: secondEvent }),
    ]);
    assert.equal(distinct.every((result) => result.ok), true);
    assert.equal(distinct.flatMap((result) => result.ok ? result.value : []).length, 0);
    const stored = await hostB.listNotifications(HUMAN, { limit: 10 });
    assert.equal(stored.ok, true);
    if (stored.ok) assert.equal(stored.value.items.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #10/#18/#35: evidence time anchors cooldown across threshold mutation', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-evaluation-cooldown-'));
  try {
    const newest = event(0, { output: 10, observedAt: '2026-08-04T00:00:20.000Z' });
    const older = event(1, { output: 10, observedAt: '2026-08-04T00:00:10.000Z' });
    const after = event(2, { output: 10, observedAt: '2026-08-04T00:00:30.000Z' });
    const owners = ownersFor(newest, older, after);
    for (let index = 0; index < 3; index += 1) {
      const source = run(index);
      owners.runs.set(String(source.providerSessionId), source);
    }
    const supervision = compose(root, owners);
    const rule = await createThresholdRule(supervision, { value: 1, cooldownMs: 60_000 });
    const committed = await supervision.evaluateEvent(systemContext(), { event: newest });
    assert.equal(committed.ok, true);
    if (committed.ok) assert.equal(committed.value.length, 1);
    const outOfOrder = await supervision.evaluateEvent(systemContext(), { event: older });
    assert.deepEqual(outOfOrder, b3ok([]));
    const updated = await supervision.updateWatchRule(humanContext(), {
      watchRuleId: rule.id,
      expectedRecordVersion: rule.recordVersion,
      replacement: {
        subject: rule.subject,
        condition: { kind: 'output-tokens-at-least', value: 5 },
        recipient: rule.recipient,
        deliveryMode: rule.deliveryMode,
        cooldownMs: rule.cooldownMs,
        status: rule.status,
      },
    });
    assert.equal(updated.ok, true, updated.ok ? '' : updated.error.message);
    const changedCondition = await supervision.evaluateEvent(systemContext(), { event: after });
    assert.deepEqual(changedCondition, b3ok([]));

    const zeroCooldown = await createThresholdRule(supervision, { cooldownMs: 0 });
    const late = await supervision.evaluateEvent(systemContext(), { event: newest });
    const early = await supervision.evaluateEvent(systemContext(), { event: older });
    assert.equal(late.ok, true);
    assert.equal(early.ok, true);
    const zeroRows = await supervision.listNotifications(HUMAN, { limit: 20 });
    assert.equal(zeroRows.ok, true);
    if (zeroRows.ok) {
      assert.equal(zeroRows.value.items.filter(
        (notification) => notification.watchRuleId === zeroCooldown.id,
      ).length, 2);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #20/#28: session mismatch fails closed and child usage uses owner authority', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-evaluation-child-'));
  try {
    const usage = event(0);
    const owners = ownersFor(usage);
    const childRun = run(0, OTHER_AGENT_ID);
    owners.runs.set(String(childRun.providerSessionId), childRun);
    const supervision = compose(root, owners);
    const childRule = await supervision.createWatchRule(humanContext(), {
      subject: { kind: 'children-of', agentId: AGENT_ID },
      condition: { kind: 'output-tokens-at-least', value: 1 },
      recipient: { kind: 'human', principalId: HUMAN.id },
      deliveryMode: 'queue-only', cooldownMs: 0, status: 'active',
    });
    assert.equal(childRule.ok, true, childRule.ok ? '' : childRule.error.message);
    const child = await supervision.evaluateEvent(systemContext(), { event: usage });
    assert.equal(child.ok, true, child.ok ? '' : child.error.message);
    if (child.ok) {
      assert.equal(child.value.length, 1);
      assert.equal(child.value[0]!.subject.kind, 'children-of');
      assert.equal(
        'conditionOccurrence' in child.value[0]!
          ? child.value[0]!.conditionOccurrence?.agentRunId
          : undefined,
        childRun.agentRunId,
      );
    }

    const mismatchRoot = mkdtempSync(path.join(tmpdir(), 'nvk-evaluation-mismatch-'));
    try {
      const mismatchedOwners = ownersFor(usage);
      mismatchedOwners.resolve = () => b3ok({
        ...childRun,
        providerSessionId: SESSION_IDS[1] as never,
      });
      const mismatched = compose(mismatchRoot, mismatchedOwners);
      await createThresholdRule(mismatched);
      const rejected = await mismatched.evaluateEvent(systemContext(), { event: usage });
      assert.equal(rejected.ok, false);
      if (!rejected.ok) {
        assert.equal(rejected.error.code, 'RecoveryRequired');
        assert.equal(rejected.error.details['stage'], 'occurrence-derivation');
      }
      const rows = await mismatched.listNotifications(HUMAN, { limit: 10 });
      assert.equal(rows.ok, true);
      if (rows.ok) assert.equal(rows.value.items.length, 0);
    } finally {
      rmSync(mismatchRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('AMD-003 #19/#39: retry appends a new ordinal and re-evaluates noncommitting history', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-evaluation-history-'));
  try {
    const usage = event(0, { output: 10 });
    const owners = ownersFor(usage);
    const source = run(0);
    owners.runs.set(String(source.providerSessionId), source);
    let visible = false;
    owners.resolve = () => b3ok(visible ? source : null);
    const supervision = compose(root, owners);
    const created = [
      await createThresholdRule(supervision, { value: 1 }),
      await createThresholdRule(supervision, { value: 1 }),
    ].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const firstRule = created[0]!;
    const laterRule = created[1]!;
    const madeNonmatching = await supervision.updateWatchRule(humanContext(), {
      watchRuleId: firstRule.id,
      expectedRecordVersion: firstRule.recordVersion,
      replacement: {
        subject: firstRule.subject,
        condition: { kind: 'output-tokens-at-least', value: 100 },
        recipient: firstRule.recipient,
        deliveryMode: firstRule.deliveryMode,
        cooldownMs: firstRule.cooldownMs,
        status: firstRule.status,
      },
    });
    assert.equal(madeNonmatching.ok, true, madeNonmatching.ok ? '' : madeNonmatching.error.message);
    if (!madeNonmatching.ok) return;
    const context = systemContext();
    const stopped = await supervision.evaluateEvent(context, { event: usage });
    assert.equal(stopped.ok, false);
    if (!stopped.ok) assert.equal(stopped.error.code, 'RuntimeUnavailable');

    visible = true;
    const madeMatching = await supervision.updateWatchRule(humanContext(), {
      watchRuleId: madeNonmatching.value.id,
      expectedRecordVersion: madeNonmatching.value.recordVersion,
      replacement: {
        subject: madeNonmatching.value.subject,
        condition: { kind: 'output-tokens-at-least', value: 1 },
        recipient: madeNonmatching.value.recipient,
        deliveryMode: madeNonmatching.value.deliveryMode,
        cooldownMs: madeNonmatching.value.cooldownMs,
        status: madeNonmatching.value.status,
      },
    });
    assert.equal(madeMatching.ok, true, madeMatching.ok ? '' : madeMatching.error.message);
    const resumed = await supervision.evaluateEvent(context, { event: usage });
    assert.equal(resumed.ok, true, resumed.ok ? '' : resumed.error.message);
    if (resumed.ok) assert.equal(resumed.value.length, 2);
    const listed = await supervision.listWatchEvaluationProgress(HUMAN, { limit: 10 });
    assert.equal(listed.ok, true);
    if (!listed.ok) return;
    const progress = listed.value.items[0]!;
    assert.equal(progress.attemptOrdinal, 1);
    const history = progress.completed.filter((entry) => entry.watchRuleId === firstRule.id);
    assert.deepEqual(history.map((entry) => [entry.attemptOrdinal, entry.outcome.kind]), [
      [0, 'not-matching'],
      [1, 'committed'],
    ]);
    assert.equal(progress.completed.some(
      (entry) => entry.watchRuleId === laterRule.id
        && entry.attemptOrdinal === 1
        && entry.outcome.kind === 'committed',
    ), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
