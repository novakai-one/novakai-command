// What every governed-Agents operation shares, and the vocabulary of authority.
import {
  b3err, b3fail, b3ok, canonicalJson,
  type AuthorityScope, type B3Result, type CommandContext, type HumanPrincipalId,
} from '@novakai/foundation/contract';
import { createHash } from 'node:crypto';
import type { ProviderAdapterRegistry } from '../contract/providers.js';
import type { GovernedAgentsStore } from './store.js';

/**
 * The operations one Agent can ask Novakai to perform on another. Named
 * constants because a scope is a compatibility contract: a grant issued today
 * is still read tomorrow.
 */
export const SCOPE = {
  spawn: 'agent.spawn' as AuthorityScope,
  interrupt: 'agent.interrupt' as AuthorityScope,
  stopOne: 'agent.stop-one' as AuthorityScope,
  /** §22: a SEPARATE scope. Holding stop-one never implies holding this. */
  stopTree: 'agent.stop-tree' as AuthorityScope,
  adopt: 'agent.adopt' as AuthorityScope,
  continueRun: 'agent.continue' as AuthorityScope,
  control: 'agent.control' as AuthorityScope,
  /** Q5: durable authority for watcher-originated provider turns. */
  watchStartTurn: 'supervision:watch:start-turn' as AuthorityScope,
} as const;

export const RUN_OPERATION_SCOPE: Readonly<Record<string, AuthorityScope>> = {
  interrupt: SCOPE.interrupt,
  'stop-one': SCOPE.stopOne,
  'stop-tree': SCOPE.stopTree,
  adopt: SCOPE.adopt,
  continue: SCOPE.continueRun,
  control: SCOPE.control,
};

/** Every scope a local human holds. B3b has exactly one human (DEC-C04). */
export const HUMAN_SCOPES: readonly AuthorityScope[] = Object.values(SCOPE);

export interface GovernedAgentsCore {
  readonly store: GovernedAgentsStore;
  readonly providers: ProviderAdapterRegistry;
  /** Whose tree a human/script/operations spawn lands in. */
  readonly rootHumanPrincipalId: HumanPrincipalId;
  readonly clock: () => string;
}

export const OPERATION = {
  createRole: 'agents.createRoleProfile',
  updateRole: 'agents.updateRoleProfile',
  createAgent: 'agents.createAgentFromRole',
  resolvePlan: 'agents.resolveLaunchPlan',
  recordRelationship: 'agents.recordRelationship',
  issueGrant: 'agents.issueDelegationGrant',
  applyControl: 'agents.applyAgentControl',
  registerSession: 'agents.registerProviderSession',
} as const;

/** §3.5: an unknown newer contract version is refused, never guessed at. */
export function versionGuard<T>(context: CommandContext): B3Result<T> | null {
  if (context.contractVersion === 1) return null;
  return b3fail(b3err('UnsupportedContractVersion',
    `contract version ${String(context.contractVersion)} is not supported`,
    { received: context.contractVersion, supported: [1] }, false));
}

export const permissionDenied = (
  operation: string, requiredScope?: AuthorityScope,
): ReturnType<typeof b3err> => b3err('PermissionDenied',
  `${operation} is not permitted for this caller`,
  { operation, ...(requiredScope === undefined ? {} : { requiredScope }) }, false);

export const authorityEscalation = (
  requestedScopes: readonly AuthorityScope[],
  allowedScopes: readonly AuthorityScope[],
  /** Targets outside the issuer's reach: widening by pointing, not by naming. */
  unreachableTargetAgentIds: readonly string[] = [],
): ReturnType<typeof b3err> => b3err('AuthorityEscalation',
  unreachableTargetAgentIds.length > 0
    ? 'a grant may not name an Agent its issuer cannot already reach'
    : 'a grant may not carry authority its issuer does not hold',
  {
    requestedScopes, allowedScopes,
    ...(unreachableTargetAgentIds.length > 0 ? { unreachableTargetAgentIds } : {}),
  }, false);

/**
 * Content identity for a resolved plan: the same role version, the same
 * request, the same answer (B3R-005). Excludes the record's own identity and
 * timestamps, which differ per resolution by design.
 */
export function fingerprint(content: unknown): string {
  return createHash('sha256')
    .update(`b3v4.launch-plan${String.fromCharCode(0x1f)}${canonicalJson(content)}`, 'utf8')
    .digest('hex');
}

export const okNull = (): B3Result<null> => b3ok(null);
