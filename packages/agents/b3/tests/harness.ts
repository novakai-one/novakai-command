// Shared rig for the governed-Agents suites.
//
// Every test gets a real Foundation store in a temp directory. Nothing here
// fakes persistence: the whole point of these suites is that the durable
// behaviour is the behaviour.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  agentRunPrincipalId, mintClientOpId, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type AuthorityScope,
  type CommandContext, type HumanPrincipalId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import type {
  CreateRoleProfileInput, GovernedAgentsContract,
} from '../contract/api.js';
import type { WatcherTemplateRefCatalogue } from '../contract/records.js';
import { composeGovernedAgents } from '../core/compose.js';
import { createFakeProviderAdapters } from '../adapters/providers/fake.js';

export const CHRIS = 'person_chris' as HumanPrincipalId;

export interface Rig {
  readonly agents: GovernedAgentsContract;
  readonly root: string;
  human(scopes?: readonly string[]): CommandContext;
  agentRun(agentRunId: AgentRunId, scopes?: readonly string[]): CommandContext;
  system(): SystemCommandContext<'sys_agent_runtime'>;
  principal(): AuthenticatedPrincipal;
  close(): void;
}

export function createRig(
  watcherTemplates: WatcherTemplateRefCatalogue = { inspect: () => null },
): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3b-agents-'));
  const agents = composeGovernedAgents({
    root,
    dataRoot: path.join(root, 'stores'),
    providers: createFakeProviderAdapters(),
    watcherTemplates,
  });

  const envelope = (principal: AuthenticatedPrincipal): CommandContext => ({
    principal,
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  });

  return {
    agents,
    root,
    human: (scopes = []) => envelope({
      id: CHRIS, kind: 'human', verifiedScopes: scopes as readonly AuthorityScope[],
    }),
    agentRun: (agentRunId, scopes = []) => envelope({
      // Derived exactly as the server derives it, so a harness never proves
      // something about a principal shape production does not use.
      id: agentRunPrincipalId(agentRunId), kind: 'agent-run', agentRunId,
      verifiedScopes: scopes as readonly AuthorityScope[],
    }),
    system: () => ({
      principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
      clientOpId: mintClientOpId(),
      traceId: mintTraceCorrelationId(),
      contractVersion: 1,
    }),
    principal: () => ({ id: CHRIS, kind: 'human', verifiedScopes: [] }),
    close: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A skill reference shaped the way a pinned launch plan carries one. */
export const skillRef = (id: string, version = 1): { id: string; version: number; digest: string } =>
  ({ id, version, digest: `digest-${id}-v${version}` });

/**
 * A complete, realistic role. Tests override the one field they are about, so
 * a test that fails names a policy rather than a missing property.
 */
export function roleInput(
  overrides: Partial<CreateRoleProfileInput> = {},
): CreateRoleProfileInput {
  return {
    name: 'builder',
    description: 'writes the code',
    status: 'active',
    providerPolicy: { allowed: ['claude', 'codex'], defaultProvider: 'claude' },
    modelPolicy: {
      allowedModelIds: ['opus', 'sonnet'],
      defaultModelId: 'opus',
      allowNativeChange: true,
      allowReplacementChange: true,
    },
    effortPolicy: { allowed: ['high', 'medium'], defaultEffort: 'high' },
    skillRefs: [skillRef('tdd'), skillRef('verification-before-completion')],
    hookRefs: [],
    instructionRefs: [skillRef('builder-instructions')],
    skillsConfirmationGate: {
      mode: 'required-two-turn',
      confirmationMarker: 'SKILLS-CONFIRMED:',
      confirmationTokenFormat: 'skill-id@v<version>#<digest>',
      comparison: 'exact-set-canonical-order',
      subagentEvidenceMarker: 'SUBAGENT-SKILLS:',
      providerNativeSubagentPolicy: 'managed-only-for-supervised-work',
      onFailure: 'terminate-run-and-record-drift',
    },
    executionPolicyRef: skillRef('execution-default'),
    spawnPolicy: { allowedChildRoleIds: [], requireManagedSpawn: true },
    lifecyclePolicy: {
      onTaskComplete: 'keep-running',
      onSupervisorFinal: 'assign-nearest-live-ancestor',
      allowedContinuationModes: ['resume', 'fresh', 'compact', 'handover'],
    },
    supervisionPolicy: {
      activityDrift: 'disabled-explicitly',
      requiredWatcherTemplates: [],
      parentNotificationMode: 'queue-only',
    },
    budgetPolicy: { hardStopEnabled: false },
    ...overrides,
  };
}

/** A chat role: gate disabled, which is legal for exactly one kind of launch. */
export function chatRoleInput(): CreateRoleProfileInput {
  return roleInput({
    name: 'chat',
    skillRefs: [],
    skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
  });
}
