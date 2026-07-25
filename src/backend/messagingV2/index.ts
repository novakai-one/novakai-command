/**
 * messagingV2 composition glue (slice N1 — Foundation): boots the sealed
 * @novakai/messaging capability embedded in the app backend, wired to the
 * app's identity/membership authority (ObjectModel) through the Novakai
 * adapters in ./authority and ./membership.
 *
 * N1 scope: ADDITIVE. No consumers yet — nothing calls the returned handle;
 * the old messaging surface (src/backend/messaging/) is untouched and keeps
 * serving. A boot failure must never take the app down (the server catches
 * and logs it LOUD, then continues without the capability).
 *
 * Room Thread provisioning note (composition/coreStack.ts): passing a READY
 * MembershipSource means the coreStack provisions NOTHING — the HOST owns
 * room Thread creation. That is slice N3's job; N1 boots with zero room
 * Threads (the direct person: lane works today).
 *
 * ONE clock (createSystemClock) is shared by the store, both adapters, and
 * the embedded stack so session expiry, evidence timestamps, and journal
 * records never disagree.
 */

import path from 'node:path';
import { createEmbeddedMessaging } from '../../../packages/messaging/composition/embedded.js';
import type { EmbeddedMessaging } from '../../../packages/messaging/composition/embedded.js';
import { createSystemClock } from '../../../packages/messaging/adapters/clock-system.js';
import { openJsonlStore } from '../../../packages/messaging/adapters/store-jsonl.js';
import type { PersonId } from '../../../packages/messaging/public/contract/index.js';
import type { ObjectModel } from '../objectModel/index.js';
import { createNovakaiAuthority } from './authority/index.js';
import type { NovakaiAuthorityConfig } from './authority/index.js';
import { createNovakaiMembership } from './membership/index.js';

export interface MessagingV2Handle {
  /** The full embedded capability handle, held for N2+ consumers. */
  readonly embedded: EmbeddedMessaging;
  close(): Promise<void>;
}

/** The optional human principal (person_user-chris, role Human) from config. */
function humanConfig(humanToken: string | undefined): NovakaiAuthorityConfig {
  if (humanToken === undefined) return {};
  return { humans: [{ token: humanToken, personId: 'person_user-chris' as PersonId, roles: ['Human'] }] };
}

/** Boot-log principal count: live/spawning durable agents + configured humans. */
function countPrincipals(objectModel: ObjectModel, config: NovakaiAuthorityConfig): number {
  const agents = objectModel
    .listAgents()
    .filter((block) => block.status === 'live' || block.status === 'spawning').length;
  return agents + (config.humans?.length ?? 0);
}

export interface StartMessagingV2Deps {
  objectModel: ObjectModel;
  /** Journal path; defaults to .novakai-command/messaging-v2/journal.jsonl. */
  storePath?: string;
  /** When set, provisions the human principal (person_user-chris, role Human). */
  humanToken?: string;
  log?: (message: string) => void;
}

export async function startMessagingV2(deps: StartMessagingV2Deps): Promise<MessagingV2Handle> {
  const clock = createSystemClock();
  const storePath = deps.storePath ?? path.resolve('.novakai-command/messaging-v2/journal.jsonl');
  const store = await openJsonlStore(clock, { path: storePath });
  const config = humanConfig(deps.humanToken);
  // No `transports`: the default in-memory 'ws' transport is correct for N1
  // (the PTY/app-ws presence transports are slices N2/N4).
  const embedded = createEmbeddedMessaging({
    clock, store,
    authority: createNovakaiAuthority(deps.objectModel, clock, config),
    membership: createNovakaiMembership(deps.objectModel, clock),
    busPollIntervalMs: 500, sweepIntervalMs: 60_000,
  });
  // DEC-21/F10: the recovery sweep runs BEFORE serving (inside start()).
  await embedded.start();
  const announce = deps.log ?? console.log;
  announce(`[messaging-v2] capability booted (store=${storePath}, principals=${countPrincipals(deps.objectModel, config)})`);
  return { embedded, close: () => embedded.close() };
}
