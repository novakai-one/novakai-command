import assert from 'node:assert/strict';
import type {
  B3Result,
  SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  InstallRunWatchersInput,
  WatchRule,
  WatchRuleId,
} from '../index.js';

/** Supervision provider half of Runtime spawn → installRunWatchers. */
export interface RunWatcherInstallerProviderHarness {
  installRunWatchers(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: InstallRunWatchersInput,
  ): Promise<B3Result<readonly WatchRule[]>>;
}

/** Observable state of spawn's mandatory watchers-installed rung. */
export interface SpawnWatcherInstallObservation {
  readonly ready: boolean;
  readonly installedRuleIds: readonly WatchRuleId[];
}

/** Runtime consumer half of spawn → installRunWatchers. */
export interface SpawnWatcherConsumerHarness {
  completeWatcherStage(
    context: SystemCommandContext<'sys_agent_runtime'>,
    input: InstallRunWatchersInput,
    provider: RunWatcherInstallerProviderHarness,
  ): Promise<SpawnWatcherInstallObservation>;
}

const CONTEXT: SystemCommandContext<'sys_agent_runtime'> = {
  principal: {
    id: 'sys_agent_runtime',
    kind: 'system',
    verifiedScopes: [],
  },
  clientOpId: 'op_123e4567-e89b-42d3-a456-426614174000' as never,
  traceId: 'trace_123e4567-e89b-42d3-a456-426614174000' as never,
  contractVersion: 1,
};

const INSTALL_INPUT: InstallRunWatchersInput = {
  agentRunId: 'agentRun_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
  launchPlanId: 'launchPlan_018f0f8a-4f7b-7abc-8def-0123456789ab' as never,
  requiredTemplateRefs: [
    { id: 'template.turn-100', version: 1, digest: 'sha256:turn-100-v1' },
    { id: 'template.output-100k', version: 1, digest: 'sha256:output-100k-v1' },
  ],
};

/** Verify the provider returns one unique, correctly targeted rule per required template. */
export async function assertInstallRunWatchersProviderContract(
  provider: RunWatcherInstallerProviderHarness,
): Promise<void> {
  const installed = await provider.installRunWatchers(CONTEXT, INSTALL_INPUT);
  assert.equal(installed.ok, true, installed.ok ? '' : installed.error.message);
  if (!installed.ok) return;
  assert.equal(installed.value.length, INSTALL_INPUT.requiredTemplateRefs.length);
  assert.equal(new Set(installed.value.map((rule) => rule.id)).size, installed.value.length);
  for (const rule of installed.value) {
    assert.deepEqual(rule.subject, {
      kind: 'agent-run',
      agentRunId: INSTALL_INPUT.agentRunId,
    });
  }
}

/** Verify Runtime blocks `ready` when the provider omits any required rule. */
export async function assertSpawnWatcherConsumerContract(
  provider: RunWatcherInstallerProviderHarness,
  consumer: SpawnWatcherConsumerHarness,
): Promise<void> {
  const complete = await consumer.completeWatcherStage(CONTEXT, INSTALL_INPUT, provider);
  assert.equal(complete.ready, true);
  assert.equal(complete.installedRuleIds.length, INSTALL_INPUT.requiredTemplateRefs.length);
  const partial: RunWatcherInstallerProviderHarness = {
    installRunWatchers: async (context, input) => {
      const installed = await provider.installRunWatchers(context, input);
      return installed.ok
        ? { ok: true, value: installed.value.slice(0, -1) }
        : installed;
    },
  };
  const blocked = await consumer.completeWatcherStage(CONTEXT, INSTALL_INPUT, partial);
  assert.equal(blocked.ready, false);
  assert.equal(blocked.installedRuleIds.length, 1);
}
