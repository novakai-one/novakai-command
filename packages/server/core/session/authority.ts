// packages/server/core/session/authority.ts — the messaging authority, built
// from CONFIG and kept live (DEC-B1-3 + DEC-B1-8).
//
// messaging's config authority resolves its token→principal table once, at
// construction. That is correct for a fixed deployment and wrong for a server
// that provisions a person the moment Chris creates a new agent conversation.
//
// So the server passes a READY seam pair (coreStack accepts either) that owns a
// config authority and rebuilds it only when the principal set actually
// changes. Sessions issued by a superseded authority stop revalidating, which
// surfaces as the ordinary typed auth failure the holder factory already
// renews — the mechanism that exists is the mechanism that handles it.
//
// packages/messaging is used entirely through its public surface here.
import { createConfigAuthority, DEFAULT_ROLE_GRANTS } from '../../../messaging/public/index.js';
import type { PersonId } from '../../../messaging/public/index.js';
import type { ServerConfig } from '../../contract/config.js';

type ConfigAuthority = ReturnType<typeof createConfigAuthority>;
type Clock = Parameters<typeof createConfigAuthority>[1];

export interface LiveAuthority {
  authenticate(credential: unknown): Promise<unknown>;
  revalidate(sessionId: string): Promise<unknown>;
  isProvisioned(personId: PersonId): Promise<boolean>;
  /** How many times the principal set changed — boot tracing / tests. */
  generation(): number;
}

const keyOf = (config: ServerConfig): string =>
  config.principals.map((p) => `${p.personId}:${p.tokenId}`).sort().join('|');

export function createLiveAuthority(deps: { snapshot(): ServerConfig; clock: Clock }): LiveAuthority {
  let key: string | null = null;
  let inner: ConfigAuthority | null = null;
  let generation = 0;

  const current = (): ConfigAuthority => {
    const config = deps.snapshot();
    const next = keyOf(config);
    if (inner === null || next !== key) {
      key = next;
      generation += 1;
      inner = createConfigAuthority({
        principals: config.principals.map((p) => ({
          token: p.token, personId: p.personId as PersonId, roles: p.roles,
        })),
        roleGrants: DEFAULT_ROLE_GRANTS,
      }, deps.clock);
    }
    return inner;
  };

  return {
    authenticate: (credential) => current().authenticate(credential) as Promise<unknown>,
    revalidate: (sessionId) => current().revalidate(sessionId) as Promise<unknown>,
    isProvisioned: (personId) => current().isProvisioned(personId),
    generation: () => generation,
  };
}
