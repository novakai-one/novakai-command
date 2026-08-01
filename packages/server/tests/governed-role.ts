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
    supervisionPolicy: { requiredWatcherTemplates: [], parentNotificationMode: 'queue-only' },
    budgetPolicy: { hardStopEnabled: false },
  };
}
