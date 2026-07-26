/**
 * messagingV2 authority adapter (Messaging-Seams §2): ObjectModel-backed
 * Authority + ProvisioningDirectory for the sealed @novakai/messaging
 * capability (slice N1).
 *
 * Identity law: the durable agentId (agents.jsonl, written only through
 * ObjectModel) is the ONLY join key — identity NEVER comes from
 * caller-supplied names. D-N6-2: an agent's credential is an ISSUED token
 * (nvkt_<64 hex>) resolved through the token store (../tokens) by hash —
 * the raw durable agentId is REJECTED as a credential (D-N2-2 retired: an
 * agentId is an identifier, not a secret — observable in rosters, logs,
 * and the object model; the N1 posture was acceptable only with no exposed
 * endpoint, and N6 opens the door). Revocation is re-checked at revalidate:
 * a revoked token's session goes invalid (§2.1). The human principal keeps
 * its config credential (server-owned, never external).
 * personId derivation is one-directional (never reverse-mapped):
 *   agent_550e8400-…  →  person_agent-550e8400-…
 *
 * Roles (D4): roles are display-name CONVENTIONS, never a schema field and
 * never core. An agent whose name starts with "chief" (case-insensitive)
 * asserts the 'Chief' role; humans carry explicit roles from config. The
 * DEC-07 role→grant mapping is ADAPTER CONFIG (`roleGrants`, defaulting to
 * the package's DEFAULT_ROLE_GRANTS) — the core only ever sees boolean
 * grants (R10). Grants are snapshotted at authenticate and re-derived fresh
 * at revalidate (Seams §2.1).
 *
 * Lifecycle: agents in status 'retired' | 'failed' are NOT authenticatable
 * (treated as an unknown credential → rejected) and NOT provisioned; an
 * agent that retires/fails (or vanishes) mid-session fails revalidate →
 * invalid (session ends, §2.1).
 *
 * Failure discipline (G6 — never a silent allow/deny, never a leaked
 * exception across the seam):
 *  - ObjectModel read throwing inside authenticate/revalidate → typed
 *    `unavailable` (DependencyUnavailable{authority, retryable: true}).
 *  - ObjectModel read throwing inside isProvisioned: the ProvisioningDirectory
 *    contract has no `unavailable` outcome, and returning false would be a
 *    silent deny (G6-forbidden). Resolution (checked against the core): this
 *    adapter rethrows as an authUnavailable-style MessagingError. The core's
 *    send path (core/decideSend.ts) awaits isProvisioned without a catch, and
 *    the session door (core/session.ts `run`) converts a thrown MessagingError
 *    into the typed outcome DependencyUnavailable{authority, retryable: true}
 *    — an honest dependency failure, never a core bug (a non-MessagingError
 *    throw WOULD be rethrown as one). Documented per the N1 brief's flag.
 *
 * Session ids are adapter-minted (`session_<n>`), runtime-only, never
 * durable. Test controls (setUnavailable, invalidateSession) mirror the
 * package's authority-config adapter — adapter-private, not seam surface.
 */

import { grantValues, idPatterns } from '../../../../packages/messaging/public/contract/index.js';
import type { Grant, PersonId, Timestamp } from '../../../../packages/messaging/public/contract/index.js';
import type { ClockIds } from '../../../../packages/messaging/seams/clock.js';
import { authRejected, authUnavailable } from '../../../../packages/messaging/seams/authority.js';
import type {
  Authority,
  AuthOutcome,
  Principal,
  ProvisioningDirectory,
  RevalidateOutcome,
} from '../../../../packages/messaging/seams/authority.js';
import {
  DEFAULT_ROLE_GRANTS,
  DEFAULT_SESSION_TTL_MS,
} from '../../../../packages/messaging/adapters/authority-config.js';
import type { AgentBlock, ObjectModel } from '../../objectModel/index.js';
import type { TokenStore } from '../tokens/index.js';

// --- configuration (DEC-07 — roles exist HERE, as adapter config) -------------

export interface NovakaiHumanConfig {
  /** The credential secret (host-issued; embedded mode only until N6). */
  token: string;
  personId: PersonId;
  /** Explicit role assertions. Unknown roles map to no grants. */
  roles?: string[];
  /** Direct grant assignments, unioned with role-mapped grants. */
  grants?: Grant[];
}

export interface NovakaiAuthorityConfig {
  humans?: NovakaiHumanConfig[];
  /** Role → grants. Defaults to the package's DEFAULT_ROLE_GRANTS. */
  roleGrants?: Record<string, Grant[]>;
  /** Default session TTL in ms (v1 default 1 h). */
  sessionTtlMs?: number;
  /** D-N6-2: agent credential resolution (hash lookup + revocation truth).
   * REQUIRED — without it no agent credential can exist (fail fast, §1). */
  tokenStore: TokenStore;
  /** D-N8-1: external-principal truth (active check for auth/revalidate/
   * provisioning). Absent = external tokens are rejected (nothing to check). */
  externalsStore?: { isActive(personId: string): boolean };
}

export interface NovakaiAuthority extends Authority, ProvisioningDirectory {
  /** Test/host control: simulate the authority being unreachable (§2.2). */
  setUnavailable(unavailable: boolean): void;
  /** Test/host control: simulate session invalidation (§2.1 invalid). */
  invalidateSession(sessionId: string): void;
  /** Test control: live session count — proves pruning (N1 audit finding 5). */
  sessionCount(): number;
}

/**
 * The ONE personId derivation (one-directional — never reverse-mapped).
 * Shared with the messagingV2 membership adapter so both sides of the seam
 * derive the same Person from the same durable agentId.
 */
export function personIdForAgentId(agentId: string): PersonId {
  return `person_${agentId.replaceAll('_', '-')}` as PersonId;
}

/** Authenticatable + provisionable lifecycle states (Seams §2 truth source).
 * THE ONE lifecycle predicate — shared by the membership adapter and the
 * composition glue's principal count (N1 audit finding 7: triplicated
 * predicates drift). */
export function isActiveAgent(block: AgentBlock): boolean {
  return block.status === 'live' || block.status === 'spawning';
}

/** D4: the 'Chief' role is a display-name convention, asserted here only.
 * Word-bounded (N1 audit finding 4): "chieftain" must not assert Chief. */
function rolesForAgent(block: AgentBlock): string[] {
  return /^chief\b/i.test(block.name) ? ['Chief'] : [];
}

type LiveSession =
  | { kind: 'agent'; agentId: string; recordId: string; expiresAtMs: number; invalidated: boolean }
  | { kind: 'external'; personId: string; recordId: string; expiresAtMs: number; invalidated: boolean }
  | { kind: 'human'; human: NovakaiHumanConfig; expiresAtMs: number; invalidated: boolean };

interface AuthorityState {
  sessions: Map<string, LiveSession>;
  sessionCounter: number;
  unavailable: boolean;
}

const PERSON_PATTERN = new RegExp(idPatterns.PersonId);
const KNOWN_GRANTS: ReadonlySet<string> = new Set(grantValues);

function millis(isoText: string): number {
  const parsed = Date.parse(isoText);
  if (Number.isNaN(parsed)) {
    // A clock the adapter cannot read is a composition error; fail fast.
    throw authUnavailable(`unparseable timestamp ${JSON.stringify(isoText)}`);
  }
  return parsed;
}

// --- construction-time validation (fail fast, Seams §1 — same discipline as --
// --- the package's authority-config adapter) -----------------------------------

function validateRoleGrants(roleGrants: Record<string, Grant[]>): void {
  for (const [role, grants] of Object.entries(roleGrants)) {
    for (const grant of grants) {
      if (!KNOWN_GRANTS.has(grant)) {
        throw authUnavailable(`role ${JSON.stringify(role)} maps unknown grant ${JSON.stringify(grant)}`);
      }
    }
  }
}

function indexHumans(humans: NovakaiHumanConfig[]): Map<string, NovakaiHumanConfig> {
  const byToken = new Map<string, NovakaiHumanConfig>();
  for (const human of humans) {
    if (!PERSON_PATTERN.test(human.personId)) {
      throw authUnavailable(`personId ${JSON.stringify(human.personId)} fails the PersonId pattern`);
    }
    if (human.token.length === 0) throw authUnavailable(`empty token for ${human.personId}`);
    for (const grant of human.grants ?? []) {
      if (!KNOWN_GRANTS.has(grant)) {
        throw authUnavailable(`principal ${human.personId} assigned unknown grant ${JSON.stringify(grant)}`);
      }
    }
    byToken.set(human.token, human);
  }
  return byToken;
}

// --- shared derivation helpers ---------------------------------------------------

function grantsFor(roleGrants: Record<string, Grant[]>, roles: string[] | undefined, explicit: Grant[] | undefined): Grant[] {
  const effective = new Set<Grant>(explicit ?? []);
  for (const role of roles ?? []) {
    for (const grant of roleGrants[role] ?? []) {
      effective.add(grant);
    }
  }
  return [...effective];
}

function toPrincipal(sessionId: string, personId: PersonId, grants: Grant[], expiresAtMs: number): Principal {
  return {
    personId,
    grants,
    sessionId,
    expiresAt: new Date(expiresAtMs).toISOString() as Timestamp,
  };
}

function mintSession(state: AuthorityState, session: LiveSession): string {
  state.sessionCounter += 1;
  const sessionId = `session_${state.sessionCounter}`;
  state.sessions.set(sessionId, session);
  return sessionId;
}

function readAgents(objectModel: ObjectModel): AgentBlock[] | Error {
  try {
    return objectModel.listAgents();
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

function parseToken(credential: unknown): string | undefined {
  const record =
    typeof credential === 'object' && credential !== null
      ? (credential as Record<string, unknown>)
      : undefined;
  return typeof record?.['token'] === 'string' ? record['token'] : undefined;
}

/** N1 audit finding 5: the session Map must not grow for the process
 * lifetime — drop expired/invalidated entries (called on authenticate, the
 * only growth point; revalidate deletes on invalid). */
function pruneSessions(state: AuthorityState, nowMs: number): void {
  for (const [sessionId, session] of state.sessions) {
    if (session.invalidated || nowMs >= session.expiresAtMs) state.sessions.delete(sessionId);
  }
}

// --- authenticate -----------------------------------------------------------------

interface AuthenticateDeps {
  objectModel: ObjectModel;
  clock: ClockIds;
  ttlMs: number;
  roleGrants: Record<string, Grant[]>;
  humansByToken: Map<string, NovakaiHumanConfig>;
  tokenStore: TokenStore;
  externalsStore?: { isActive(personId: string): boolean };
  state: AuthorityState;
}

function authenticateAgent(deps: AuthenticateDeps, agent: AgentBlock, recordId: string): AuthOutcome {
  if (!isActiveAgent(agent)) {
    // Retired/failed agents are NOT authenticatable — an unknown credential,
    // never a distinguished failure mode (§2.2).
    return { kind: 'rejected', error: authRejected('unknown credential') };
  }
  const expiresAtMs = millis(deps.clock.now()) + deps.ttlMs;
  const sessionId = mintSession(deps.state, { kind: 'agent', agentId: agent.id, recordId, expiresAtMs, invalidated: false });
  const grants = grantsFor(deps.roleGrants, rolesForAgent(agent), undefined);
  return { kind: 'authenticated', principal: toPrincipal(sessionId, personIdForAgentId(agent.id), grants, expiresAtMs) };
}

function authenticateHuman(deps: AuthenticateDeps, human: NovakaiHumanConfig): AuthOutcome {
  const expiresAtMs = millis(deps.clock.now()) + deps.ttlMs;
  const sessionId = mintSession(deps.state, { kind: 'human', human, expiresAtMs, invalidated: false });
  const grants = grantsFor(deps.roleGrants, human.roles, human.grants);
  return { kind: 'authenticated', principal: toPrincipal(sessionId, human.personId, grants, expiresAtMs) };
}

/** D-N8-1: an external token authenticates as ITS personId, NO grants —
 * the active check is the externals store's (revoked → unknown credential). */
function authenticateExternal(deps: AuthenticateDeps, personId: string, recordId: string): AuthOutcome {
  if (deps.externalsStore?.isActive(personId) !== true) {
    return { kind: 'rejected', error: authRejected('unknown credential') };
  }
  const expiresAtMs = millis(deps.clock.now()) + deps.ttlMs;
  const sessionId = mintSession(deps.state, { kind: 'external', personId, recordId, expiresAtMs, invalidated: false });
  return { kind: 'authenticated', principal: toPrincipal(sessionId, personId as PersonId, [], expiresAtMs) };
}

/** Token → principal resolution once the agent list is in hand. D-N6-2: an
 * agent credential is an issued nvkt_ token (hash lookup in the token
 * store); the raw durable agentId is REJECTED (D-N2-2 retired). D-N8-1:
 * external tokens resolve to their personId directly. */
function resolveByToken(deps: AuthenticateDeps, token: string, agents: AgentBlock[]): AuthOutcome {
  const resolved = deps.tokenStore.resolve(token);
  if (resolved !== null) {
    if (resolved.externalPersonId !== undefined) {
      return authenticateExternal(deps, resolved.externalPersonId, resolved.recordId);
    }
    const agent = agents.find((block) => block.id === resolved.agentId);
    if (agent !== undefined) return authenticateAgent(deps, agent, resolved.recordId as string);
    return { kind: 'rejected', error: authRejected('unknown credential') };
  }
  const human = deps.humansByToken.get(token);
  if (human === undefined) return { kind: 'rejected', error: authRejected('unknown credential') };
  return authenticateHuman(deps, human);
}

function makeAuthenticate(deps: AuthenticateDeps): Authority['authenticate'] {
  return async (credential) => {
    if (deps.state.unavailable) {
      return { kind: 'unavailable', error: authUnavailable('authority is unavailable') };
    }
    const token = parseToken(credential);
    if (token === undefined) {
      return { kind: 'rejected', error: authRejected('credential must be { token: string }') };
    }
    pruneSessions(deps.state, millis(deps.clock.now()));
    const agents = readAgents(deps.objectModel);
    if (agents instanceof Error) {
      return { kind: 'unavailable', error: authUnavailable(`principal read failed: ${agents.message}`) };
    }
    return resolveByToken(deps, token, agents);
  };
}

// --- revalidate (§2.1) --------------------------------------------------------------

function revalidateAgent(
  objectModel: ObjectModel,
  roleGrants: Record<string, Grant[]>,
  tokenStore: TokenStore,
  sessionId: string,
  session: Extract<LiveSession, { kind: 'agent' }>,
): RevalidateOutcome {
  // D-N6-2: revocation is re-checked at the point of truth — a revoked
  // token's session goes invalid (§2.1).
  if (tokenStore.isRevoked(session.recordId)) return { kind: 'invalid' };
  let agent: AgentBlock | null;
  try {
    agent = objectModel.agentRecord(session.agentId);
  } catch {
    return { kind: 'unavailable' };
  }
  // The durable identity GONE or retired/failed mid-session → invalid (§2.1).
  if (agent === null || !isActiveAgent(agent)) return { kind: 'invalid' };
  const grants = grantsFor(roleGrants, rolesForAgent(agent), undefined);
  return { kind: 'valid', principal: toPrincipal(sessionId, personIdForAgentId(agent.id), grants, session.expiresAtMs) };
}

/** Agent-session revalidation + the finding-5 prune at the point of truth. */
function revalidateAgentSession(
  objectModel: ObjectModel,
  roleGrants: Record<string, Grant[]>,
  tokenStore: TokenStore,
  state: AuthorityState,
  sessionId: string,
  session: Extract<LiveSession, { kind: 'agent' }>,
): RevalidateOutcome {
  const outcome = revalidateAgent(objectModel, roleGrants, tokenStore, sessionId, session);
  if (outcome.kind === 'invalid') state.sessions.delete(sessionId); // gone/retired/revoked mid-session
  return outcome;
}

/** Expired at the point of truth: prune (finding 5), then invalid. */
function expireSession(state: AuthorityState, sessionId: string): RevalidateOutcome {
  state.sessions.delete(sessionId);
  return { kind: 'invalid' };
}

/** External-session revalidation (D-N8-1): revocation AND the externals
 * store's active check are re-read at the point of truth (§2.1). */
function revalidateExternalSession(
  tokenStore: TokenStore,
  externalsStore: { isActive(personId: string): boolean } | undefined,
  state: AuthorityState,
  sessionId: string,
  session: Extract<LiveSession, { kind: 'external' }>,
): RevalidateOutcome {
  if (tokenStore.isRevoked(session.recordId) || externalsStore?.isActive(session.personId) !== true) {
    state.sessions.delete(sessionId);
    return { kind: 'invalid' };
  }
  return { kind: 'valid', principal: toPrincipal(sessionId, session.personId as PersonId, [], session.expiresAtMs) };
}

function makeRevalidate(
  objectModel: ObjectModel,
  clock: ClockIds,
  roleGrants: Record<string, Grant[]>,
  tokenStore: TokenStore,
  externalsStore: { isActive(personId: string): boolean } | undefined,
  state: AuthorityState,
): Authority['revalidate'] {
  return async (sessionId) => {
    if (state.unavailable) return { kind: 'unavailable' };
    const session = state.sessions.get(sessionId);
    if (!session || session.invalidated) return { kind: 'invalid' };
    if (millis(clock.now()) >= session.expiresAtMs) return expireSession(state, sessionId);
    if (session.kind === 'agent') {
      return revalidateAgentSession(objectModel, roleGrants, tokenStore, state, sessionId, session);
    }
    if (session.kind === 'external') {
      return revalidateExternalSession(tokenStore, externalsStore, state, sessionId, session);
    }
    // Fresh grants: a mid-session grant change takes effect HERE (§2.1).
    const grants = grantsFor(roleGrants, session.human.roles, session.human.grants);
    return { kind: 'valid', principal: toPrincipal(sessionId, session.human.personId, grants, session.expiresAtMs) };
  };
}

// --- provisioning directory (MSG-014 UnknownRecipient) --------------------------------

function agentProvisioned(objectModel: ObjectModel, personId: PersonId): boolean {
  let agents: AgentBlock[];
  try {
    agents = objectModel.listAgents();
  } catch (error) {
    // G6: a silent `false` is a deny we cannot prove — forbidden. The honest
    // failure is DependencyUnavailable; see the header note for how the core
    // maps this MessagingError throw to a typed outcome.
    throw authUnavailable(
      `provisioning read failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return agents.some((block) => isActiveAgent(block) && personIdForAgentId(block.id) === personId);
}

function makeIsProvisioned(
  objectModel: ObjectModel,
  humansByToken: Map<string, NovakaiHumanConfig>,
  externalsStore: { isActive(personId: string): boolean } | undefined,
): ProvisioningDirectory['isProvisioned'] {
  return async (personId) => {
    for (const human of humansByToken.values()) {
      if (human.personId === personId) return true;
    }
    // D-N8-1: active externals are provisioned recipients too (MSG-014).
    if (externalsStore?.isActive(personId) === true) return true;
    return agentProvisioned(objectModel, personId);
  };
}

// --- factory ----------------------------------------------------------------------------

/** The factory's test/host controls (adapter-private, not seam surface). */
function makeTestControls(state: AuthorityState) {
  return {
    setUnavailable: (flag: boolean): void => { state.unavailable = flag; },
    invalidateSession: (sessionId: string): void => {
      const session = state.sessions.get(sessionId);
      if (session) session.invalidated = true;
    },
    sessionCount: (): number => state.sessions.size,
  };
}

export function createNovakaiAuthority(
  objectModel: ObjectModel, clock: ClockIds, config: NovakaiAuthorityConfig,
): NovakaiAuthority {
  if (config.tokenStore === undefined || config.tokenStore === null) {
    // D-N6-2: without the token store no agent credential can resolve —
    // fail construction, never silently reject every agent (Seams §1).
    throw authUnavailable('tokenStore is required (D-N6-2: agent credentials are issued tokens)');
  }
  const roleGrants = config.roleGrants ?? DEFAULT_ROLE_GRANTS;
  validateRoleGrants(roleGrants);
  const humansByToken = indexHumans(config.humans ?? []);
  const ttlMs = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const state: AuthorityState = { sessions: new Map(), sessionCounter: 0, unavailable: false };
  return {
    ...makeTestControls(state),
    isProvisioned: makeIsProvisioned(objectModel, humansByToken, config.externalsStore),
    authenticate: makeAuthenticate({
      objectModel, clock, ttlMs, roleGrants, humansByToken, tokenStore: config.tokenStore,
      ...(config.externalsStore !== undefined ? { externalsStore: config.externalsStore } : {}),
      state,
    }),
    revalidate: makeRevalidate(objectModel, clock, roleGrants, config.tokenStore, config.externalsStore, state),
  };
}
