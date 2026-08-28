import { createHash, randomUUID } from 'node:crypto';
import {
  b3err, b3fail, b3ok,
  type AuthenticatedPrincipal, type B3Result,
} from '@novakai/foundation/contract';
import {
  type MessagingRuntimeApi,
  type Outcome,
} from '../../../messaging/contract/index.js';
import type { CallerSession, MethodTable } from '../../contract/protocol.js';

type WireMessaging = Pick<
  MessagingRuntimeApi,
  | 'ensureConversationView' | 'updateConversationView' | 'getConversationView'
  | 'listConversationViews' | 'listAgentCommunications'
  | 'createAgentDeliveryInstruction' | 'sendConversationMessage'
>;

interface MessagingMethodOptions {
  readonly messaging: WireMessaging;
  readonly agentOfRun: (agentRunId: string) => Promise<string | null>;
  readonly principalFor: (session: CallerSession | undefined) => AuthenticatedPrincipal;
}

interface Params {
  readonly contractVersion: 1;
  readonly clientOpId?: string;
  readonly payload: unknown;
}

type Handler = (payload: Record<string, unknown>, context: {
  readonly principal: AuthenticatedPrincipal;
  readonly clientOpId: string;
}) => Promise<B3Result<unknown>>;

const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;

const failure = (message: string): B3Result<never> => b3fail(b3err(
  'ValidationFailed', message, { issues: [{ path: 'payload', message }] }, false,
));

function fromOutcome<Value>(outcome: Outcome<Value>): B3Result<Value> {
  return outcome.kind === 'ok'
    ? b3ok(outcome.value)
    : b3fail(b3err('RuntimeUnavailable', outcome.error.message, {
        owner: 'messaging', cause: outcome.error.name, ...outcome.error.fields,
      }, outcome.error.retryable));
}

function threadIdFor(participants: readonly string[]): string {
  const digest = createHash('sha256').update([...participants].sort().join(':')).digest('hex');
  return `thread_${digest.slice(0, 32)}`;
}

function conversationIdFor(threadId: string): string {
  const digest = createHash('sha256').update(threadId).digest('hex');
  return `conv_wire_${digest.slice(0, 32)}`;
}

function readParticipants(value: unknown): readonly string[] | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const participants = value.flatMap((entry) => {
    const item = object(entry);
    if (item?.['kind'] === 'agent' && typeof item['agentId'] === 'string') {
      return [item['agentId']];
    }
    if (item?.['kind'] === 'human' && typeof item['personId'] === 'string') {
      return [item['personId']];
    }
    return [];
  });
  return participants.length === value.length ? participants : null;
}

function method(options: MessagingMethodOptions, handler: Handler): MethodTable[string] {
  return async (candidate: never, session?: CallerSession) => {
    const params = object(candidate) as Partial<Params> | null;
    if (params?.contractVersion !== 1 || params.payload === undefined) {
      return failure('params must be {contractVersion:1,payload}');
    }
    const payload = object(params.payload);
    if (payload === null) return failure('payload must be an object');
    return handler(payload, {
      principal: options.principalFor(session),
      clientOpId: params.clientOpId ?? `op_wire_${randomUUID()}`,
    });
  };
}

async function send(
  options: MessagingMethodOptions,
  payload: Record<string, unknown>,
  context: { readonly principal: AuthenticatedPrincipal; readonly clientOpId: string },
): Promise<B3Result<unknown>> {
  const target = object(payload['target']);
  if (target?.['kind'] !== 'agent' || typeof target['agentId'] !== 'string') {
    return failure('target must identify one Agent; exact-run delivery was retired with B3 endpoints');
  }
  if (typeof payload['text'] !== 'string' || payload['text'].trim() === '') {
    return failure('text must be non-empty');
  }
  const targetAgentId = target['agentId'];
  const threadId = typeof payload['threadId'] === 'string'
    ? payload['threadId'] : threadIdFor([context.principal.id, targetAgentId]);
  if (!/^thread_[A-Za-z0-9-]+$/u.test(threadId)) return failure('threadId must be a thread_ id');
  if (context.principal.kind === 'agent-run') {
    if (await options.agentOfRun(context.principal.agentRunId ?? '') === null) {
      return b3fail(b3err('PermissionDenied', 'Agent Run has no governed Agent', {}, false));
    }
    return fromOutcome(await options.messaging.createAgentDeliveryInstruction({
      version: 1, recipientAgentId: targetAgentId, text: payload['text'],
      clientOpId: context.clientOpId, threadId,
      ...(object(payload['screenContext']) === null
        ? {} : { screenContext: object(payload['screenContext'])! }),
    }));
  }
  const conversationId = conversationIdFor(threadId);
  const present = await options.messaging.getConversationView(conversationId);
  if (present.kind === 'error') return fromOutcome(present);
  if (present.value === null) {
    const view = await options.messaging.ensureConversationView({
      conversationId,
      participantIds: [context.principal.id, targetAgentId],
      clientOpId: `${context.clientOpId}:view`,
      address: threadId,
      agentId: targetAgentId,
    });
    if (view.kind === 'error') return fromOutcome(view);
  }
  const accepted = await options.messaging.sendConversationMessage({
    conversationId,
    issuedBy: context.principal.id,
    targetAgentId,
    text: payload['text'],
    clientOpId: context.clientOpId,
    ...(object(payload['screenContext']) === null
      ? {} : { screenContext: object(payload['screenContext'])! }),
  });
  if (accepted.kind === 'error') return fromOutcome(accepted);
  return b3ok({
    messageId: accepted.value.sendId,
    threadId,
    state: accepted.value.state,
    duplicate: accepted.value.duplicate,
  });
}

async function ensureView(
  options: MessagingMethodOptions,
  participants: readonly string[],
  clientOpId: string,
  suppliedThreadId?: string,
): Promise<B3Result<unknown>> {
  const threadId = suppliedThreadId ?? threadIdFor(participants);
  const created = await options.messaging.ensureConversationView({
    conversationId: conversationIdFor(threadId),
    participantIds: participants,
    clientOpId,
    address: threadId,
  });
  return created.kind === 'error'
    ? fromOutcome(created)
    : b3ok({ id: threadId, threadId, conversationId: created.value.id });
}

/** Legacy wire names backed only by the transcript-first Messaging contract. */
export function buildMessagingRuntimeMethods(options: MessagingMethodOptions): MethodTable {
  return {
    'b3.messaging.sendAgent': method(options, (payload, context) => send(options, payload, context)),
    'b3.messaging.listAgentCommunications': method(options, async (payload, context) => {
      const agentIds = Array.isArray(payload['agentIds'])
        ? payload['agentIds'].filter((item): item is string => typeof item === 'string') : [];
      if (context.principal.kind === 'agent-run') {
        const own = await options.agentOfRun(context.principal.agentRunId ?? '');
        if (own === null || agentIds.some((id) => id !== own)) {
          return b3fail(b3err('PermissionDenied', 'Agent Run may only read its Agent', {}, false));
        }
      }
      return fromOutcome(await options.messaging.listAgentCommunications({
        agentIds,
        limit: typeof payload['limit'] === 'number' ? payload['limit'] : 200,
        ...(Array.isArray(payload['runIds']) ? { runIds: payload['runIds'] as string[] } : {}),
        ...(typeof payload['threadId'] === 'string' ? { threadId: payload['threadId'] } : {}),
        ...(typeof payload['cursor'] === 'string' ? { cursor: payload['cursor'] } : {}),
      }));
    }),
    'b3.messaging.ensureDirectThread': method(options, (payload, context) => {
      const participants = readParticipants(payload['between']);
      return participants === null
        ? Promise.resolve(failure('between must contain two participants'))
        : ensureView(options, participants, context.clientOpId);
    }),
    'b3.messaging.ensureGroupThread': method(options, (payload, context) => {
      const participants = readParticipants(payload['participants']);
      return participants === null
        ? Promise.resolve(failure('participants must contain at least two identities'))
        : ensureView(options, participants, context.clientOpId);
    }),
    'b3.messaging.openConversation': method(options, (payload, context) => {
      const membership = object(payload['membership']);
      const participants = membership?.['kind'] === 'direct'
        && typeof membership['agentId'] === 'string'
        ? [context.principal.id, membership['agentId']]
        : membership?.['kind'] === 'group' && Array.isArray(membership['agentIds'])
          ? [context.principal.id, ...membership['agentIds'].filter(
              (item): item is string => typeof item === 'string',
            )] : null;
      return participants === null || typeof payload['threadId'] !== 'string'
        ? Promise.resolve(failure('threadId and valid membership are required'))
        : ensureView(options, participants, context.clientOpId, payload['threadId']);
    }),
    'b3.messaging.listConversationViews': method(options, async (_payload, context) =>
      context.principal.kind === 'agent-run'
        ? b3fail(b3err('PermissionDenied', 'Agent Run may not read the sidebar', {}, false))
        : fromOutcome(await options.messaging.listConversationViews())),
    'b3.messaging.closeConversation': method(options, async (payload, context) => {
      if (typeof payload['threadId'] !== 'string') return failure('threadId is required');
      return fromOutcome(await options.messaging.updateConversationView({
        conversationId: conversationIdFor(payload['threadId']),
        clientOpId: context.clientOpId,
        archived: true,
      }));
    }),
  };
}
