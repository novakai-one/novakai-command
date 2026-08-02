// Boundary validators for the `b3.messaging.*` / `b3.transcript.*` wire
// methods (§4.2 MUST: every payload is READ from `unknown`, never cast).
//
// They live in the server rather than in the capability packages because the
// shape they validate is the WIRE's — §12.5 spells several of these operations
// out as separate arguments, and a request body has to name them.
import {
  b3err, b3fail, b3ok, isValidId, readBoundary,
  type AgentRunId as FoundationAgentRunId, type B3Result, type EventCursor,
} from '@novakai/foundation/contract';
// The MESSAGING vocabulary, deliberately. A validator's job is to turn
// `unknown` into the type the capability it feeds actually speaks; producing
// Foundation's AgentId here would just move the cast one call deeper.
import type {
  AgentEndpointClaimId, AgentId, AgentInboxItem, AgentRunId,
  ConversationParticipant, EnsureDirectThreadInput, EnsureGroupThreadInput,
  ListAgentCommunicationsInput, ListAgentInboxInput, OpenConversationViewInput,
  SendAgentMessageInput,
} from '../../../messaging/b3/contract/index.js';
import type { ThreadId } from '../../../messaging/public/contract/index.js';
import type {
  IngestTranscriptSourceInput, ListObservedSubagentsInput, ObservedSubagentId,
  PromoteObservedSubagentInput,
} from '../../../transcript/b3/contract/index.js';

const invalid = (path: string, message: string): B3Result<never> =>
  b3fail(b3err('ValidationFailed', `invalid input: ${path} ${message}`,
    { issues: [{ path, message }] }, false));

const asArray = (value: unknown): readonly unknown[] | null =>
  Array.isArray(value) ? value : null;

/**
 * A Messaging ThreadId is `thread_<opaque>` — NOT one of §4.1's B3 identity
 * formats. Messaging mints its ids through its own clock seam and has done
 * since before Build 3; validating them as UUIDv4 would reject every real
 * Thread the store has ever created.
 */
const THREAD_ID = /^thread_[A-Za-z0-9-]+$/;

function readThreadId(value: unknown): ThreadId | null {
  return typeof value === 'string' && THREAD_ID.test(value) ? value as ThreadId : null;
}

/**
 * §4.1's wrong-kind rule, at the boundaries B3c added.
 *
 * `b3.agent.*` has enforced this since B3a (the exam proves an
 * AgentRoleProfileId is refused where an AgentRunId belongs). Every
 * `b3.messaging.*` validator below tested `typeof x === 'string'` and cast, so
 * an `agentRole_…` reached the capability, resolved against nothing, and came
 * back `UnknownAgent`: a plausible answer to a question that was never legal,
 * and one that blames the store instead of the caller.
 */
const readAgentId = (value: unknown): AgentId | null =>
  isValidId(value, 'agent', 'uuidv4') ? value as AgentId : null;

const readAgentRunId = (value: unknown): AgentRunId | null =>
  isValidId(value, 'agentRun', 'uuidv7') ? value as AgentRunId : null;

/** A participant is a tagged union, which `readBoundary` cannot express alone. */
function readParticipant(candidate: unknown, path: string): ConversationParticipant | null {
  if (typeof candidate !== 'object' || candidate === null) return null;
  const body = candidate as Record<string, unknown>;
  if (body['kind'] === 'agent') {
    const agentId = readAgentId(body['agentId']);
    return agentId === null ? null : { kind: 'agent', agentId };
  }
  if (body['kind'] === 'human' && typeof body['personId'] === 'string') {
    return { kind: 'human', personId: body['personId'] };
  }
  void path;
  return null;
}

export function readSendAgentMessageInput(
  candidate: unknown,
): B3Result<SendAgentMessageInput> {
  if (typeof candidate !== 'object' || candidate === null) {
    return invalid('payload', 'must be an object');
  }
  const body = candidate as Record<string, unknown>;
  const target = body['target'];
  if (typeof target !== 'object' || target === null) {
    return invalid('target', 'must be {kind:"agent"|"exact-run", ...}');
  }
  const targetBody = target as Record<string, unknown>;
  let resolved: SendAgentMessageInput['target'];
  const targetAgent = readAgentId(targetBody['agentId']);
  const targetRun = readAgentRunId(targetBody['agentRunId']);
  if (targetBody['kind'] === 'agent' && targetAgent !== null) {
    resolved = { kind: 'agent', agentId: targetAgent };
  } else if (targetBody['kind'] === 'exact-run' && targetRun !== null) {
    resolved = { kind: 'exact-run', agentRunId: targetRun };
  } else {
    return invalid('target.kind', 'must be "agent" with agentId or "exact-run" with agentRunId');
  }
  // Absent means "the direct Thread with this Agent" — the capability resolves
  // it. A present-but-malformed one is still a refusal: a caller that named a
  // Thread meant a specific conversation, and quietly sending somewhere else
  // would be worse than saying no.
  const threadId = body['threadId'] === undefined ? undefined : readThreadId(body['threadId']);
  if (threadId === null) return invalid('threadId', 'must be a thread_ id');
  const scalars = readBoundary(body, (field) => ({
    text: field.text('text'),
    clientMessageId: field.optionalText('clientMessageId'),
  }));
  if (!scalars.ok) return scalars;
  return b3ok({
    target: resolved,
    ...(threadId === undefined ? {} : { threadId }),
    text: scalars.value.text,
    ...(scalars.value.clientMessageId === undefined
      ? {} : { clientMessageId: scalars.value.clientMessageId }),
  });
}

export function readEnsureDirectThreadInput(
  candidate: unknown,
): B3Result<EnsureDirectThreadInput> {
  const body = candidate as Record<string, unknown> | null;
  const between = asArray(body?.['between']);
  if (between === null || between.length !== 2) {
    return invalid('between', 'must be exactly two participants');
  }
  const first = readParticipant(between[0], 'between.0');
  const second = readParticipant(between[1], 'between.1');
  if (first === null || second === null) {
    return invalid('between', 'each participant is {kind:"agent",agentId} or {kind:"human",personId}');
  }
  return b3ok({ between: [first, second] });
}

export function readEnsureGroupThreadInput(
  candidate: unknown,
): B3Result<EnsureGroupThreadInput> {
  const body = candidate as Record<string, unknown> | null;
  const listed = asArray(body?.['participants']);
  if (listed === null || listed.length < 2) {
    return invalid('participants', 'must be at least two participants');
  }
  const participants: ConversationParticipant[] = [];
  for (const [index, entry] of listed.entries()) {
    const participant = readParticipant(entry, `participants.${String(index)}`);
    if (participant === null) {
      return invalid(`participants.${String(index)}`, 'is not a participant');
    }
    participants.push(participant);
  }
  return b3ok({ participants });
}

export function readOpenConversationInput(
  candidate: unknown,
): B3Result<OpenConversationViewInput> {
  const body = candidate as Record<string, unknown> | null;
  const threadId = body?.['threadId'];
  if (typeof threadId !== 'string' || !threadId.startsWith('thread_')) {
    return invalid('threadId', 'must be a thread_ id');
  }
  const membership = body?.['membership'];
  if (typeof membership !== 'object' || membership === null) {
    return invalid('membership', 'must be {kind:"direct"|"group", ...}');
  }
  const membershipBody = membership as Record<string, unknown>;
  const directAgent = readAgentId(membershipBody['agentId']);
  if (membershipBody['kind'] === 'direct' && directAgent !== null) {
    return b3ok({
      threadId: threadId as ThreadId,
      membership: { kind: 'direct', agentId: directAgent },
    });
  }
  const agentIds = asArray(membershipBody['agentIds']);
  if (membershipBody['kind'] === 'group' && agentIds !== null) {
    if (!agentIds.every((entry) => readAgentId(entry) !== null)) {
      return invalid('membership.agentIds', 'must be a list of agent identifiers');
    }
    return b3ok({
      threadId: threadId as ThreadId,
      membership: { kind: 'group', agentIds: agentIds as AgentId[] },
    });
  }
  return invalid('membership.kind', 'must be "direct" with agentId or "group" with agentIds');
}

export function readThreadIdInput(
  candidate: unknown,
): B3Result<{ readonly threadId: ThreadId }> {
  const threadId = readThreadId((candidate as Record<string, unknown> | null)?.['threadId']);
  if (threadId === null) return invalid('threadId', 'must be a thread_ id');
  return b3ok({ threadId });
}

export function readListAgentCommunicationsInput(
  candidate: unknown,
): B3Result<ListAgentCommunicationsInput> {
  const body = candidate as Record<string, unknown> | null;
  const agentIds = asArray(body?.['agentIds']);
  if (agentIds === null || agentIds.length === 0) {
    return invalid('agentIds', 'must name at least one Agent');
  }
  if (!agentIds.every((entry) => readAgentId(entry) !== null)) {
    return invalid('agentIds', 'must be a list of agent identifiers');
  }
  const runIds = asArray(body?.['runIds']);
  if (body?.['runIds'] !== undefined
    && (runIds === null || !runIds.every((entry) => readAgentRunId(entry) !== null))) {
    return invalid('runIds', 'must be a list of agentRun identifiers');
  }
  const threadId = body?.['threadId'] === undefined ? null : readThreadId(body['threadId']);
  if (body?.['threadId'] !== undefined && threadId === null) {
    return invalid('threadId', 'must be a thread_ id');
  }
  const scalars = readBoundary(body, (field) => ({
    limit: field.optionalCount('limit', 1, 1_000),
    cursor: field.optionalText('cursor'),
  }));
  if (!scalars.ok) return scalars;
  return b3ok({
    agentIds: agentIds as AgentId[],
    limit: scalars.value.limit ?? 100,
    ...(runIds === null ? {} : { runIds: runIds as AgentRunId[] }),
    ...(threadId === null ? {} : { threadId }),
    ...(scalars.value.cursor === undefined
      ? {} : { cursor: scalars.value.cursor as EventCursor }),
  });
}

const INBOX_STATES = [
  'queued', 'claimed', 'submitted-confirmed', 'submitted-unconfirmed',
  'transcript-observed', 'failed',
] as const;

export function readListAgentInboxInput(candidate: unknown): B3Result<ListAgentInboxInput> {
  const body = candidate as Record<string, unknown> | null;
  const states = asArray(body?.['states']);
  if (states !== null
    && !states.every((entry): entry is AgentInboxItem['state'] =>
      typeof entry === 'string' && (INBOX_STATES as readonly string[]).includes(entry))) {
    return invalid('states', `each state must be one of ${INBOX_STATES.join(', ')}`);
  }
  const scalars = readBoundary(body, (field) => ({
    agentId: field.id<AgentId>('agentId', 'agent', 'uuidv4'),
    limit: field.optionalCount('limit', 1, 1_000),
  }));
  if (!scalars.ok) return scalars;
  return b3ok({
    agentId: scalars.value.agentId,
    ...(states === null ? {} : { states: states as AgentInboxItem['state'][] }),
    ...(scalars.value.limit === undefined ? {} : { limit: scalars.value.limit }),
  });
}

export function readGetAgentEndpointInput(
  candidate: unknown,
): B3Result<{ readonly agentId: AgentId }> {
  return readBoundary(candidate, (field) => ({
    agentId: field.id<AgentId>('agentId', 'agent', 'uuidv4'),
  }));
}

export function readTranscriptBindingLookup(
  candidate: unknown,
): B3Result<{ readonly agentRunId: FoundationAgentRunId }> {
  return readBoundary(candidate, (field) => ({
    agentRunId: field.id<FoundationAgentRunId>('agentRunId', 'agentRun'),
  }));
}

export function readIngestTranscriptSourceInput(
  candidate: unknown,
): B3Result<IngestTranscriptSourceInput> {
  return readBoundary(candidate, (field) => {
    const expectedWatermark = field.optionalText('expectedWatermark');
    return {
      bindingId: field.id<IngestTranscriptSourceInput['bindingId']>(
        'bindingId', 'transcriptBinding', 'base32sha256',
      ),
      maxLines: field.count('maxLines', 1, 10_000),
      ...(expectedWatermark === undefined ? {} : { expectedWatermark }),
    };
  });
}

export function readListObservedSubagentsInput(
  candidate: unknown,
): B3Result<ListObservedSubagentsInput> {
  return readBoundary(candidate, (field) => {
    const bindingId = field.optionalId<ListObservedSubagentsInput['bindingId'] & string>(
      'bindingId', 'transcriptBinding', 'base32sha256',
    );
    const agentRunId = field.optionalId<FoundationAgentRunId>('agentRunId', 'agentRun');
    return {
      limit: field.optionalCount('limit', 1, 1_000) ?? 100,
      ...(bindingId === undefined ? {} : { bindingId }),
      ...(agentRunId === undefined ? {} : { agentRunId }),
    };
  });
}

export function readPromoteObservedSubagentInput(
  candidate: unknown,
): B3Result<PromoteObservedSubagentInput> {
  return readBoundary(candidate, (field) => ({
    observedSubagentId: field.id<ObservedSubagentId>(
      'observedSubagentId', 'observedSubagent', 'base32sha256',
    ),
    roleProfileId: field.text('roleProfileId'),
    displayName: field.text('displayName'),
  }));
}

export type { AgentEndpointClaimId };
