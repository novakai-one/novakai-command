// The provider port: where a resolved launch becomes an opaque ref.
//
// §14 keeps executable paths, argv and environment private to adapters. Terminal
// takes only a `launchAuthorityRef`. So the bridge is: ask the adapter what to
// run, register it with the PTY host under a ref derived from the Run, and hand
// Terminal the ref. argv never touches a contract in either direction.
import { b3fail, b3ok, type B3Result } from '@novakai/foundation/contract';
import type { ProviderPort } from '../../../agent-runtime/contract/index.js';
import type {
  InteractiveProviderAdapter, ProviderAdapterRegistry, ResolvedLaunchPlan,
} from '../../../agents/b3/contract/index.js';
import type { LaunchAuthorityRegistrar } from '../../../terminal/adapters/pty-host/node-pty.js';

/**
 * The launch plan an adapter needs, rebuilt from the facts the port carries.
 *
 * The Runtime's `LaunchPlanFacts` is deliberately narrower than the Agents
 * record — it holds what a RUN needs, not what a ROLE is. An adapter asks for
 * the record, so this fills the difference with values that cannot mislead:
 * anything an adapter reads is present, and anything it does not read is empty
 * rather than invented.
 */
function planFor(
  facts: Parameters<ProviderPort['prepareLaunch']>[0]['launchPlan'],
): ResolvedLaunchPlan {
  return {
    kind: 'resolvedLaunchPlan',
    id: facts.id,
    schemaVersion: 1,
    recordVersion: 1 as never,
    createdAt: '' as never,
    permissionLevel: 'private',
    createdBy: 'sys_agent_runtime',
    lastMutation: { state: 'legacy-no-trace' },
    agentId: facts.agentId,
    roleProfile: { id: '', version: 0, digest: '' },
    provider: facts.provider,
    modelId: facts.modelId,
    effort: facts.effort,
    workingDirectory: facts.workingDirectory,
    skills: facts.skills,
    hooks: [],
    instructions: [],
    skillsConfirmationGate: facts.skillsConfirmationGate.mode === 'disabled'
      ? { mode: 'disabled', allowedFor: 'interactive-chat-only' }
      : {
        mode: 'required-two-turn',
        confirmationMarker: 'SKILLS-CONFIRMED:',
        confirmationTokenFormat: 'skill-id@v<version>#<digest>',
        comparison: 'exact-set-canonical-order',
        subagentEvidenceMarker: 'SUBAGENT-SKILLS:',
        providerNativeSubagentPolicy: 'managed-only-for-supervised-work',
        onFailure: 'terminate-run-and-record-drift',
      },
    executionPolicy: {
      policyRef: { id: '', version: 0, digest: '' },
      commandScopes: [], filesystemScopes: [], networkScopes: [],
      enforcement: 'advisory', limitations: [],
    },
    spawnPolicy: { allowedChildRoleIds: [], requireManagedSpawn: true },
    lifecyclePolicy: {
      onTaskComplete: 'keep-running',
      onSupervisorFinal: facts.lifecyclePolicy.onSupervisorFinal,
      allowedContinuationModes: facts.lifecyclePolicy.allowedContinuationModes,
    },
    supervisionPolicy: { requiredWatcherTemplates: [], parentNotificationMode: 'queue-only' },
    budgetPolicy: { hardStopEnabled: false },
    resolutionFingerprint: '',
  };
}

export function createProviderPort(
  adapters: ProviderAdapterRegistry, authorities: LaunchAuthorityRegistrar,
): ProviderPort {
  const adapterFor = (
    provider: 'claude' | 'codex' | 'kimi',
  ): InteractiveProviderAdapter => adapters[provider];

  return {
    async prepareLaunch(input) {
      const adapter = adapterFor(input.launchPlan.provider);
      const built = await adapter.buildLaunch(planFor(input.launchPlan), {
        workingDirectory: input.launchPlan.workingDirectory,
        columns: input.columns,
        rows: input.rows,
        reservedProviderSessionId: input.reservedProviderSessionId,
        runtimeEnvironment: input.runtimeEnvironment,
      });
      if (!built.ok) return built;
      // The ref is derived from the RUN, so a retry registers the same one and
      // Terminal's adopt-by-operation path sees the same fingerprint.
      const authorityRef = `agent-run:${input.agentRunId}`;
      authorities.register(authorityRef, {
        file: built.value.executable,
        args: built.value.argv,
        environment: built.value.environment,
      });
      return b3ok({
        launchAuthorityRef: authorityRef,
        launchFingerprint: built.value.launchFingerprint,
      });
    },

    async prepareContinuation(input) {
      const adapter = adapterFor(input.launchPlan.provider);
      const built = await adapter.buildContinuation({
        mode: input.mode,
        oldSession: {
          providerSessionId: input.reservedProviderSessionId,
          providerNativeSessionId: input.oldNativeSessionId,
          live: input.oldNativeSessionId === '' ? 'unknown' : 'final',
          evidence: [],
        },
        launchPlan: planFor(input.launchPlan),
        ...(input.handoverArtifactId === undefined
          ? {} : { handoverArtifactId: input.handoverArtifactId }),
        workingDirectory: input.launchPlan.workingDirectory,
        columns: input.columns,
        rows: input.rows,
        runtimeEnvironment: input.runtimeEnvironment,
      });
      if (!built.ok) return built;
      const authorityRef = `agent-run:${input.mode}:${input.agentRunId}`;
      authorities.register(authorityRef, {
        file: built.value.executable,
        args: built.value.argv,
        environment: built.value.environment,
      });
      return b3ok({
        launchAuthorityRef: authorityRef,
        launchFingerprint: built.value.launchFingerprint,
        providerNativeSessionId: built.value.privateResumeHandle ?? '',
        resumeHandleUsed: built.value.privateResumeHandle !== undefined,
      });
    },

    async discoverSession(input) {
      const found = await adapterFor(input.provider).discoverSession({
        agentRunId: input.agentRunId,
        expectedProviderSessionId: input.expectedProviderSessionId,
        terminalSessionId: input.terminalSessionId,
        launchFingerprint: input.launchFingerprint,
      });
      if (!found.ok) return found;
      return b3ok({
        providerSessionId: found.value.providerSessionId,
        providerNativeSessionId: found.value.providerNativeSessionId,
        live: found.value.live,
      });
    },

    async requestInterrupt(input) {
      const outcome = await adapterFor(input.provider).requestInterrupt({
        providerSessionId: input.providerSessionId,
        providerTurnId: input.providerTurnId,
        activityGeneration: input.activityGeneration,
      });
      if (!outcome.ok) return outcome;
      return b3ok({ kind: outcome.value.kind });
    },

    deliverTurn: (provider, text) => adapterFor(provider).deliverTurn(text),
    findConfirmationLine: (provider, text, marker) =>
      adapterFor(provider).findConfirmationLine({ text }, marker),
  };
}

export const providerPortUnavailable = (): B3Result<never> => b3fail({
  code: 'RuntimeUnavailable',
  message: 'no provider adapters are composed',
  details: { reason: 'no-providers' },
  retryable: false,
});
