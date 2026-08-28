// The role shape every governed test needs, in one place.
//
// It exists because the shipped suites and the bundled three-generation proof
// all used `skillsConfirmationGate: 'disabled'` roles — so nothing in the repo
// ever launched the shape the slice is named for. Anything that wants to prove
// governance starts here.
export const GOVERNED_SKILLS = [
  { id: 'elite-codebase-engineering', version: 3, digest: 'a1b2c3d4' },
  { id: 'test-driven-development', version: 2, digest: 'e5f6a7b8' },
] as const;

/** The tokens a correct provider reply carries: `id@v<version>#<digest>`, sorted. */
export function governedTokens(
  skills: readonly { id: string; version: number; digest: string }[] = GOVERNED_SKILLS,
): readonly string[] {
  return skills
    .map((skill) => `${skill.id}@v${String(skill.version)}#${skill.digest}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

/**
 * Synthetic providers whose first observed boundary completes and whose later
 * turns stay pending. Governed launch tests use it when the skills answer is
 * complete but the released work turn is intentionally silent.
 */
export function fakeProvidersWithCompletionLimit(limit: number): ProviderAdapterRegistry {
  const base = createFakeProviderAdapters();
  const built = {} as Record<ProviderKind, InteractiveProviderAdapter>;
  for (const [provider, adapter] of Object.entries(base) as [
    ProviderKind, InteractiveProviderAdapter,
  ][]) {
    let observed = 0;
    built[provider] = {
      ...adapter,
      async observeProviderTurnBoundary(input) {
        observed += 1;
        if (observed <= limit) return adapter.observeProviderTurnBoundary(input);
        return b3ok({
          kind: 'unavailable',
          reason: 'source-unavailable',
          evidenceRefs: ['the synthetic provider has not completed this turn'],
        });
      },
    };
  }
  return built;
}

/** A role that is actually governed: a real two-turn gate over real pinned skills. */
export function governedRole(
  name: string,
  allowedChildRoleIds: readonly string[] = [],
  provider = 'claude',
  skills: readonly { id: string; version: number; digest: string }[] = GOVERNED_SKILLS,
): Record<string, unknown> {
  return {
    name,
    description: `${name}, governed`,
    status: 'active',
    providerPolicy: { allowed: [provider], defaultProvider: provider },
    modelPolicy: {
      allowedModelIds: ['cli-default'], defaultModelId: 'cli-default',
      allowNativeChange: false, allowReplacementChange: true,
    },
    effortPolicy: { allowed: ['default'], defaultEffort: 'default' },
    skillRefs: skills.map((skill) => ({ ...skill })),
    hookRefs: [], instructionRefs: [],
    skillsConfirmationGate: {
      mode: 'required-two-turn',
      confirmationMarker: 'SKILLS-CONFIRMED:',
      confirmationTokenFormat: 'skill-id@v<version>#<digest>',
      comparison: 'exact-set-canonical-order',
      subagentEvidenceMarker: 'SUBAGENT-SKILLS:',
      providerNativeSubagentPolicy: 'managed-only-for-supervised-work',
      onFailure: 'terminate-run-and-record-drift',
    },
    executionPolicyRef: { id: 'execution-default', version: 1, digest: 'digest' },
    spawnPolicy: { allowedChildRoleIds, requireManagedSpawn: true },
    lifecyclePolicy: {
      onTaskComplete: 'keep-running',
      onSupervisorFinal: 'assign-nearest-live-ancestor',
      allowedContinuationModes: ['fresh', 'resume'],
    },
    supervisionPolicy: {
      activityDrift: 'disabled-explicitly',
      requiredWatcherTemplates: [],
      parentNotificationMode: 'queue-only',
    },
    budgetPolicy: { hardStopEnabled: false },
  };
}

/** The ungoverned counterpart: no gate, for tests about anything but the gate. */
export function chatRole(
  name: string, allowedChildRoleIds: readonly string[] = [], provider = 'claude',
): Record<string, unknown> {
  return {
    ...governedRole(name, allowedChildRoleIds, provider),
    skillRefs: [],
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  };
}
import { b3ok } from '@novakai/foundation/contract';
import {
  createFakeProviderAdapters,
  type InteractiveProviderAdapter, type ProviderAdapterRegistry, type ProviderKind,
} from '../../agents/governed/contract/index.js';
