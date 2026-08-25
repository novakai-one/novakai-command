/**
 * authority-config adapter (Messaging-Seams.md §2.4): config-driven local
 * authority for embedded mode and tests — the v1 "local token authority".
 *
 * The DEC-07 role→grant mapping is CONFIGURATION HERE, never core (§2.3): the
 * adapter resolves a principal's role assertions + explicit grant assignments
 * into the boolean grants the core checks (R10). Changing the rule = editing
 * one config. DEFAULT_ROLE_GRANTS encodes the §2.3 v1 organisational mapping
 * (Human > Chief > Manager > Executive Assistant hold priority.override;
 * Auditor, Worker, Aide never do) as a convenience constant a host may use,
 * extend, or replace — it is adapter config, not core logic.
 *
 * The adapter also answers the provisioning-directory adjunct (seams/authority.ts
 * header): its configured principal list IS the v1 provisioning truth for
 * embedded mode (MSG-014 UnknownRecipient).
 *
 * Credential shape is adapter-owned: `{ token: string }`. A malformed
 * credential is `rejected`, never a throw (typed outcomes at the seam).
 *
 * Test/host controls (setUnavailable, invalidateSession) model the external
 * authority's failure states so the §2.1 degraded-state ruling is exercisable;
 * they are adapter-private extras, not seam surface.
 */

import { grantValues, idPatterns } from "../contract/schemas.js";
import type { Grant, PersonId, Timestamp } from "../contract/schemas.js";
import type { ClockIds } from "../contract/ports/clock.js";
import { authRejected, authUnavailable } from "../contract/ports/authority.js";
import type {
  Authority,
  AuthOutcome,
  Principal,
  ProvisioningDirectory,
  RevalidateOutcome,
} from "../contract/ports/authority.js";

// --- configuration (DEC-07 amendment — this is where roles exist) --------------

export interface PrincipalConfig {
  /** The credential secret. */
  token: string;
  personId: PersonId;
  /** Role assertions made by the Identity authority. Unknown roles map to no grants. */
  roles?: string[];
  /** Direct grant assignments (policy.admin / template.write are per-deployment, §2.3). */
  grants?: Grant[];
  /** Session TTL in ms. Overrides the adapter default. */
  sessionTtlMs?: number;
}

export interface AuthorityConfig {
  principals: PrincipalConfig[];
  /** Role → grants. Keys are role names (config data — the core never sees them). */
  roleGrants: Record<string, Grant[]>;
  /** Default session TTL in ms (v1 default 1 h). */
  sessionTtlMs?: number;
}

/** The §2.3 v1 mapping, as adapter config a host may reuse. NOT core logic. */
export const DEFAULT_ROLE_GRANTS: Record<string, Grant[]> = {
  Human: ["priority.override"],
  Chief: ["priority.override"],
  Manager: ["priority.override"],
  "Executive Assistant": ["priority.override"],
  Auditor: [],
  Worker: [],
  Aide: [],
};

export const DEFAULT_SESSION_TTL_MS = 3_600_000;

// --- adapter --------------------------------------------------------------------

export interface ConfigAuthority extends Authority, ProvisioningDirectory {
  /** Test/host control: simulate the authority being unreachable (§2.2 unavailable). */
  setUnavailable(unavailable: boolean): void;
  /** Test/host control: simulate session invalidation (§2.1 invalid). */
  invalidateSession(sessionId: string): void;
}

interface LiveSession {
  principalConfig: PrincipalConfig;
  expiresAtMs: number;
  invalidated: boolean;
}

const PERSON_PATTERN = new RegExp(idPatterns.PersonId);
const KNOWN_GRANTS: ReadonlySet<string> = new Set(grantValues);

function millis(iso: string): number {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) {
    // A config-clock mismatch is a composition error; fail fast at the seam.
    throw authUnavailable(`unparseable timestamp ${JSON.stringify(iso)}`);
  }
  return parsed;
}

export function createConfigAuthority(config: AuthorityConfig, clock: ClockIds): ConfigAuthority {
  // Fail-fast config validation at construction (Seams §1: an adapter that
  // cannot meet its seam's obligations must not be registered).
  for (const [role, grants] of Object.entries(config.roleGrants)) {
    for (const grant of grants) {
      if (!KNOWN_GRANTS.has(grant)) {
        throw authUnavailable(`role ${JSON.stringify(role)} maps unknown grant ${JSON.stringify(grant)}`);
      }
    }
  }
  const byToken = new Map<string, PrincipalConfig>();
  for (const principal of config.principals) {
    if (!PERSON_PATTERN.test(principal.personId)) {
      throw authUnavailable(`personId ${JSON.stringify(principal.personId)} fails the PersonId pattern`);
    }
    if (principal.token.length === 0) {
      throw authUnavailable(`empty token for ${principal.personId}`);
    }
    for (const grant of principal.grants ?? []) {
      if (!KNOWN_GRANTS.has(grant)) {
        throw authUnavailable(`principal ${principal.personId} assigned unknown grant ${JSON.stringify(grant)}`);
      }
    }
    byToken.set(principal.token, principal);
  }

  const defaultTtl = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const sessions = new Map<string, LiveSession>();
  let sessionCounter = 0;
  let unavailable = false;

  function grantsFor(principalConfig: PrincipalConfig): Grant[] {
    const effective = new Set<Grant>(principalConfig.grants ?? []);
    for (const role of principalConfig.roles ?? []) {
      for (const grant of config.roleGrants[role] ?? []) {
        effective.add(grant);
      }
    }
    return [...effective];
  }

  function toPrincipal(sessionId: string, session: LiveSession): Principal {
    return {
      personId: session.principalConfig.personId,
      grants: grantsFor(session.principalConfig),
      sessionId,
      expiresAt: new Date(session.expiresAtMs).toISOString() as Timestamp,
    };
  }

  return {
    setUnavailable(flag: boolean): void {
      unavailable = flag;
    },
    invalidateSession(sessionId: string): void {
      const session = sessions.get(sessionId);
      if (session) session.invalidated = true;
    },

    async isProvisioned(personId: PersonId): Promise<boolean> {
      for (const principal of config.principals) {
        if (principal.personId === personId) return true;
      }
      return false;
    },

    async authenticate(credential: unknown): Promise<AuthOutcome> {
      if (unavailable) {
        return { kind: "unavailable", error: authUnavailable("authority is unavailable") };
      }
      const record =
        typeof credential === "object" && credential !== null
          ? (credential as Record<string, unknown>)
          : undefined;
      const token = typeof record?.["token"] === "string" ? record["token"] : undefined;
      if (token === undefined) {
        return { kind: "rejected", error: authRejected("credential must be { token: string }") };
      }
      const principalConfig = byToken.get(token);
      if (!principalConfig) {
        return { kind: "rejected", error: authRejected("unknown credential") };
      }
      sessionCounter += 1;
      const sessionId = `session_${sessionCounter}`;
      const session: LiveSession = {
        principalConfig,
        expiresAtMs: millis(clock.now()) + (principalConfig.sessionTtlMs ?? defaultTtl),
        invalidated: false,
      };
      sessions.set(sessionId, session);
      return { kind: "authenticated", principal: toPrincipal(sessionId, session) };
    },

    async revalidate(sessionId: string): Promise<RevalidateOutcome> {
      if (unavailable) return { kind: "unavailable" };
      const session = sessions.get(sessionId);
      if (!session || session.invalidated) return { kind: "invalid" };
      if (millis(clock.now()) >= session.expiresAtMs) return { kind: "invalid" };
      // Fresh grants: a mid-session grant change takes effect HERE (§2.1).
      return { kind: "valid", principal: toPrincipal(sessionId, session) };
    },
  };
}
