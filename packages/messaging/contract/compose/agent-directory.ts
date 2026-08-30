import { deriveClientOpId } from '@novakai/foundation/contract';
import type { Result } from '@novakai/foundation/contract';
import type {
  AgentDirectory,
  AgentDirectoryEntry,
  AgentEnsureOutcome,
  AgentSessionAttachment,
  EnsureAgentForSessionInput,
} from '../ports/agent-directory.js';
import { parseProviderName } from '../provider-name.js';
import { parseProviderSessionId } from '../provider-session-id.js';
import type {
  AgentsDoor,
  AgentsDoorAbsent,
  AgentsDoorAgent,
  AgentsDoorError,
} from './agents-door.js';

/** The directory binds five of the six door ops; the turn op belongs to provider-send. */
type DirectoryDoor = Pick<
  AgentsDoor,
  'getAgent' | 'listAgents' | 'defineAgent' | 'attachProviderSession' | 'providerTurnReadiness'
>;

type AgentResult = Result<AgentsDoorAgent | AgentsDoorAbsent, AgentsDoorError>;
type AttachmentState = Extract<AgentSessionAttachment, { readonly ok: true }>['state'];

/**
 * Re-validates one Agent fact crossing the seam. Anything beyond this
 * anti-corruption layer treats the provider name and session pointer as
 * contract-checked; an Agent record that fails validation — including a
 * session pointer present in a form Messaging cannot trust — becomes
 * `null`, never a partially trusted entry.
 */
function toEntry(found: AgentsDoorAgent): AgentDirectoryEntry | null {
  const provider = parseProviderName(found.provider);
  if (provider === undefined) return null;
  const sessionId = parseProviderSessionId(found.sessionId);
  if (found.sessionId !== undefined && sessionId === undefined) return null;
  return { agentId: found.id, provider, currentProviderSessionId: sessionId ?? null };
}

/** Agents failures keep their typed code and message. */
function failure(error: AgentsDoorError): { readonly ok: false; readonly code: string; readonly message: string } {
  return { ok: false, code: error.code, message: error.message };
}

function ownsSession(found: AgentsDoorAgent, sessionId: string): boolean {
  return found.sessionId === sessionId
    || found.sessions?.includes(sessionId) === true;
}

/** Narrows a lookup to a present Agent, so callers branch once and read typed facts after. */
function found(result: AgentResult): result is { readonly ok: true; readonly value: AgentsDoorAgent } {
  return result.ok && !('absent' in result.value);
}

function parseAttachmentState(state: string): AttachmentState | undefined {
  if (state === 'attached') return state;
  if (state === 'already-attached') return state;
  return undefined;
}

const externalName = (provider: string, resumeId: string | undefined): string => {
  const suffix = resumeId === undefined ? 'session' : resumeId.slice(-8);
  return `External ${provider[0]?.toUpperCase() ?? ''}${provider.slice(1)} ${suffix}`;
};

async function adoptExternalAgent(
  agents: DirectoryDoor,
  input: EnsureAgentForSessionInput,
): Promise<AgentEnsureOutcome> {
  const created = await agents.defineAgent({
    displayName: externalName(input.provider, input.resumeId),
    provider: input.provider,
    model: 'cli-default',
    origin: 'provider-spawned',
    teamId: input.assignment.teamId,
    missionId: input.assignment.missionId,
  }, deriveClientOpId(`messaging:adopt:${input.sessionId}`));
  if (!created.ok) return failure(created.error);
  const agent = toEntry(created.value);
  if (agent === null) {
    return {
      ok: false,
      code: 'AgentCreationFailed',
      message: 'created Agent failed Messaging validation',
    };
  }
  return { ok: true, agent };
}

/** Resolves an Agent that already owns the session: validate, then check the provider matches. */
function adoptExistingAgent(
  existing: AgentsDoorAgent,
  input: EnsureAgentForSessionInput,
): AgentEnsureOutcome {
  const entry = toEntry(existing);
  if (entry === null) {
    return {
      ok: false,
      code: 'AgentRecordInvalid',
      message: `Agent owning ProviderSession ${input.sessionId} failed Messaging validation`,
    };
  }
  if (entry.provider !== input.provider) {
    return {
      ok: false,
      code: 'AgentProviderConflict',
      message: `ProviderSession ${input.sessionId} belongs to another provider`,
    };
  }
  return { ok: true, agent: entry };
}

async function ensureForSession(
  agents: DirectoryDoor,
  input: EnsureAgentForSessionInput,
): Promise<AgentEnsureOutcome> {
  const listed = await agents.listAgents();
  // A list failure fails the adoption: treating it as "no existing Agent"
  // would mint a duplicate identity for the same provider session.
  if (!listed.ok) return failure(listed.error);
  // The door returns one page at most (see AgentsDoor). Concluding "no
  // existing Agent" from a partial page would mint that same duplicate.
  if (listed.value.nextCursor !== undefined) {
    return {
      ok: false,
      code: 'AgentDirectoryPageOverflow',
      message: 'Agent directory exceeds one page; adoption cannot prove the session is unowned',
    };
  }
  const existing = listed.value.items.find((candidate) => ownsSession(candidate, input.sessionId));
  if (existing === undefined) return adoptExternalAgent(agents, input);
  return adoptExistingAgent(existing, input);
}

async function attachSession(
  agents: DirectoryDoor,
  agentId: string,
  providerSessionId: string,
  clientOpId: string,
): Promise<AgentSessionAttachment> {
  const current = await agents.getAgent(agentId);
  if (!found(current)) {
    return { ok: false, code: 'AgentNotFound', message: `no agent with id "${agentId}"` };
  }
  const attached = await agents.attachProviderSession({
    agentId,
    providerSessionId,
    expectedSessionId: current.value.sessionId ?? null,
    clientOpId,
  });
  if (!attached.ok) return failure(attached.error);
  const state = parseAttachmentState(attached.value.state);
  if (state === undefined) {
    return {
      ok: false,
      code: 'AgentAttachmentFailed',
      message: `unexpected attachment state "${attached.value.state}"`,
    };
  }
  return { ok: true, state };
}

/**
 * Binds Messaging to the Agents capability through the structural door.
 * Every Agent fact is re-validated in `toEntry` before Messaging code sees
 * it; Agents failures keep their typed code and message.
 *
 * Crash recovery: no state lives here, so a retry re-derives identity from
 * the provider session — adoption replays safely (derived clientOpId) and
 * attachment reports `already-attached`. An Agents op that throws rather
 * than returning a typed failure propagates uncaught to the host caller.
 */
export function createAgentDirectory(agents: DirectoryDoor): AgentDirectory {
  return {
    async get(agentId) {
      const result = await agents.getAgent(agentId);
      if (!found(result)) return null;
      return toEntry(result.value);
    },
    async deliveryReadiness(agentId) {
      return agents.providerTurnReadiness(agentId);
    },
    ensureForSession: (input) => ensureForSession(agents, input),
    attachProviderSession: (agentId, providerSessionId, clientOpId) =>
      attachSession(agents, agentId, providerSessionId, clientOpId),
  };
}
