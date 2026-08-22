// ProviderSession, as B3 writes it (§5.4, AMD-001 A-04).
//
// The Runtime mints this id ONCE, before any Run record exists, and stores it
// in its operation journal. By the time registration happens the id is history:
// an adapter that comes back with a different one is refused rather than
// rebound, because a substituted session id is how one Run quietly becomes two.
import {
  b3fail, b3ok, nowIsoUtc,
  type AuthenticatedPrincipal, type B3Result, type ProviderSessionId,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { RegisterProviderSessionInput } from '../contract/api.js';
import { readRegisterProviderSessionInput } from '../contract/validate.js';
import type { ProviderSessionView } from '../contract/records.js';
import type { GovernedAgentsCore } from './context.js';
import type { Persisted } from './store.js';

export async function registerProviderSession(
  core: GovernedAgentsCore,
  context: SystemCommandContext<'sys_agent_runtime'>,
  input: RegisterProviderSessionInput,
): Promise<B3Result<ProviderSessionView>> {
  const read = readRegisterProviderSessionInput(input);
  if (!read.ok) return read;
  const request = read.value;

  const existing = await readEitherKind(core, request.expectedProviderSessionId);
  if (!existing.ok) return existing;
  if (existing.value !== null) {
    // Registering the same reservation twice is the retry path, not a conflict
    // — but only if it is the SAME Agent behind it.
    if (existing.value.agentId !== request.agentId) {
      return b3fail(reservationConflict(request.expectedProviderSessionId,
        `is already bound to agent ${existing.value.agentId}`));
    }
    return b3ok(existing.value);
  }

  const record: Persisted<ProviderSessionView> = {
    kind: 'providerSessionHandle',
    id: request.expectedProviderSessionId,
    schemaVersion: 1,
    createdAt: nowIsoUtc(),
    permissionLevel: 'private',
    createdBy: context.principal.id,
    agentId: request.agentId,
    provider: request.provider,
    providerConversationId: request.providerConversationId,
    providerResumeHandle: request.providerResumeHandle,
    ...(request.providerVersion === undefined ? {} : { providerVersion: request.providerVersion }),
    discovery: request.discovery,
  };
  return core.store.create<ProviderSessionView>(
    context.principal.id, record as never, context.clientOpId,
  );
}

export async function getProviderSession(
  core: GovernedAgentsCore,
  _principal: AuthenticatedPrincipal,
  providerSessionId: ProviderSessionId,
): Promise<B3Result<ProviderSessionView>> {
  const found = await readEitherKind(core, providerSessionId);
  if (!found.ok) return found;
  if (found.value === null) {
    return b3fail(reservationConflict(providerSessionId, 'names no provider session'));
  }
  // A pre-B3 record carries lifecycle, usage and cwd fields this view does not
  // promise. They are read past, never rewritten (§3.5, AMD-001 A-04): the
  // stored line stays exactly as the earlier build left it.
  return b3ok(normaliseToB3View(found.value));
}

/**
 * SUPFIX-04: B3 handles live under `providerSessionHandle`; pre-split B3
 * records and pre-B3 v1 records are read from the legacy `providerSession`
 * kind. Reads only — B3 never writes the legacy kind again.
 */
async function readEitherKind(
  core: GovernedAgentsCore, providerSessionId: ProviderSessionId,
): Promise<B3Result<ProviderSessionView | null>> {
  const handle = await core.store.read<ProviderSessionView>(
    'providerSessionHandle', providerSessionId,
  );
  if (!handle.ok || handle.value !== null) return handle;
  return core.store.read<ProviderSessionView>('providerSession', providerSessionId);
}

/** The in-memory v1 → B3 mapping. Reading never appends (AMD-001 A-04). */
function normaliseToB3View(stored: ProviderSessionView): ProviderSessionView {
  const legacy = stored as unknown as Record<string, unknown>;
  return {
    ...stored,
    providerResumeHandle: stored.providerResumeHandle
      ?? (typeof legacy['providerConversationId'] === 'string'
        ? legacy['providerConversationId'] : null),
    discovery: stored.discovery ?? { state: 'discovered' },
  };
}

export const reservationConflict = (
  reservedProviderSessionId: string, problem: string,
): { code: 'ProviderSessionReservationConflict'; message: string; details: Record<string, unknown>; retryable: false } => ({
  code: 'ProviderSessionReservationConflict',
  message: `provider session ${reservedProviderSessionId} ${problem}`,
  details: { reservedProviderSessionId },
  retryable: false,
});
