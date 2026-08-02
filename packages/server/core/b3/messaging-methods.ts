// `b3.messaging.*` and `b3.transcript.*` on the EXISTING nvk-ws v1 frame
// (§16.2, AMD-001 A-02).
//
// §16.2 names six methods for these two families and B3b learned the hard way
// that a drifted name is an unreachable method: a second host written from the
// spec calls `b3.messaging.sendAgent`, and anything else is `unknown method`.
// So the six §16.2 names are here verbatim.
//
// The other seven exist because the pre-build hold-out exam proved the six are
// not usable alone: nothing minted a Thread, so nothing could call send or
// open at all; and nothing could read an inbox or an endpoint, so nothing could
// tell what happened to a Message it sent.
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type ClientOpId, type CommandContext,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import type { AgentMessagingContract } from '../../../messaging/b3/contract/index.js';
import type { B3TranscriptContract } from '../../../transcript/b3/contract/index.js';
import type { CallerSession, MethodTable } from '../../contract/protocol.js';
import {
  readEnsureDirectThreadInput, readEnsureGroupThreadInput, readGetAgentEndpointInput,
  readIngestTranscriptSourceInput, readListAgentCommunicationsInput,
  readListAgentInboxInput, readListObservedSubagentsInput, readOpenConversationInput,
  readPromoteObservedSubagentInput, readSendAgentMessageInput, readThreadIdInput,
  readTranscriptBindingLookup,
} from './messaging-validate.js';

export interface B3MessagingMethodOptions {
  readonly messaging: AgentMessagingContract;
  readonly transcript: B3TranscriptContract;
  /**
   * Which Agent a Run belongs to, answered from durable state rather than from
   * anything the caller sent (red gate 5). This is the join that turns "an
   * Agent Run is connected" into "this Run may read THIS Agent".
   */
  readonly agentOfRun: (agentRunId: string) => Promise<string | null>;
  readonly principalFor: (session: CallerSession | undefined) => AuthenticatedPrincipal;
  readonly contextFor: (
    principal: AuthenticatedPrincipal,
    session: CallerSession | undefined,
    clientOpId: ClientOpId,
  ) => CommandContext;
}

const malformed = (): B3Result<never> => b3fail(
  b3err('ValidationFailed', 'params must be {contractVersion, payload}',
    { issues: [{ path: 'params', message: 'missing contractVersion or payload' }] }, false),
);

interface B3Params<Payload> {
  readonly contractVersion: 1;
  readonly clientOpId?: string;
  readonly payload: Payload;
}

function readParams<Payload>(candidate: unknown): B3Result<B3Params<Payload>> {
  if (typeof candidate !== 'object' || candidate === null) return malformed();
  const params = candidate as Partial<B3Params<Payload>>;
  if (params.payload === undefined) return malformed();
  if (params.contractVersion !== 1) {
    return b3fail(b3err('UnsupportedContractVersion',
      `contract version ${String(params.contractVersion)} is not supported`,
      { received: params.contractVersion, supported: [1] }, false));
  }
  return b3ok(params as B3Params<Payload>);
}

const CLIENT_OP_ID = /^op_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readClientOpId(given: string | undefined): B3Result<ClientOpId> {
  if (given === undefined) return b3ok(mintClientOpId());
  if (!CLIENT_OP_ID.test(given)) {
    return b3fail(b3err('ValidationFailed', 'clientOpId must be op_<uuid>',
      { issues: [{ path: 'clientOpId', message: `not a ClientOpId: ${given}` }] }, false));
  }
  return b3ok(given as ClientOpId);
}

export function buildB3MessagingMethods(options: B3MessagingMethodOptions): MethodTable {
  const { messaging, transcript } = options;

  function method<Payload, Value>(
    validate: (payload: unknown) => B3Result<Payload>,
    perform: (
      payload: Payload, context: CommandContext, principal: AuthenticatedPrincipal,
    ) => Promise<B3Result<Value>>,
  ) {
    return async (params: never, session?: CallerSession): Promise<B3Result<Value>> => {
      const parsed = readParams<unknown>(params);
      if (!parsed.ok) return parsed;
      const payload = validate(parsed.value.payload);
      if (!payload.ok) return payload;
      const clientOpId = readClientOpId(parsed.value.clientOpId);
      if (!clientOpId.ok) return clientOpId;
      const principal = options.principalFor(session);
      return perform(payload.value, options.contextFor(principal, session, clientOpId.value), principal);
    };
  }

  /**
   * The two Transcript system contexts. §12.5 types these operations to
   * `sys_transcript`, and the wire is not a way around that: the caller is
   * authenticated as themselves, and the server — which IS the composition
   * root — is what holds the system authority to ask Transcript to ingest.
   */
  const transcriptSystem = (context: CommandContext): SystemCommandContext<'sys_transcript'> => ({
    ...context,
    principal: { id: 'sys_transcript', kind: 'system', verifiedScopes: [] },
  });

  const denied = (what: string): B3Result<never> => b3fail(b3err('PermissionDenied',
    `an Agent Run may not ${what}`,
    { required: 'human', held: 'agent-run' }, false));

  /**
   * The elevation above is FOR THE HUMAN, and only the human.
   *
   * The server being the composition root is what makes it legitimate for Chris
   * to ask Transcript to ingest — he is asking the root, and the root holds the
   * authority. An Agent Run connected to the same socket inherited that
   * sentence and therefore the authority, which is not the same thing at all:
   * `sys_transcript` writes the mirror, and a Run that can drive it can mirror
   * its own terminal into anyone's conversation.
   */
  function humanOnly<Payload, Value>(
    validate: (payload: unknown) => B3Result<Payload>,
    what: string,
    perform: (
      payload: Payload, context: CommandContext, principal: AuthenticatedPrincipal,
    ) => Promise<B3Result<Value>>,
  ) {
    const inner = method<Payload, Value>(validate, perform);
    // BEFORE the validator, deliberately. Authority does not depend on the
    // shape of the payload, and checking it second means a caller who may not
    // perform the operation at all is told their id is malformed — a refusal
    // they can fix, which is the wrong answer to a question they may not ask.
    return async (params: never, session?: CallerSession): Promise<B3Result<Value>> =>
      options.principalFor(session).kind === 'agent-run'
        ? denied(what)
        : inner(params, session);
  }

  /**
   * A read scoped to the caller's OWN Agent.
   *
   * `verifiedScopes: []` is set on every agent-run principal on purpose — "an
   * Agent's authority comes from its GRANTS, never from the socket" — and then
   * nothing read it, so a Run could enumerate any Agent's inbox, endpoint and
   * communications by naming them. The Run→Agent join is the endpoint claim,
   * which is Messaging's own durable record rather than anything the caller
   * sends (red gate 5).
   */
  function ownAgentOnly<Payload, Value>(
    validate: (payload: unknown) => B3Result<Payload>,
    subjectsOf: (payload: Payload) => readonly string[],
    perform: (
      payload: Payload, context: CommandContext, principal: AuthenticatedPrincipal,
    ) => Promise<B3Result<Value>>,
  ) {
    return method<Payload, Value>(validate, async (payload, context, principal) => {
      if (principal.kind !== 'agent-run') return perform(payload, context, principal);
      const mine = await options.agentOfRun(principal.agentRunId ?? '');
      const subjects = subjectsOf(payload);
      if (mine === null || !subjects.every((subject) => subject === mine)) {
        return denied('read another Agent');
      }
      return perform(payload, context, principal);
    });
  }

  return {
    // --- §16.2, exactly these names -----------------------------------------
    'b3.messaging.sendAgent': method(readSendAgentMessageInput,
      (payload, context) => messaging.sendAgentMessage(context, payload)),

    'b3.messaging.listAgentCommunications': ownAgentOnly(
      readListAgentCommunicationsInput,
      (payload) => payload.agentIds,
      (payload, _context, principal) => messaging.listAgentCommunications(principal, payload)),

    'b3.messaging.openConversation': method(readOpenConversationInput,
      (payload, context) => messaging.openConversationView(context, payload)),

    'b3.transcript.getBinding': method(readTranscriptBindingLookup,
      (payload, _context, principal) =>
        transcript.getTranscriptBinding(principal, payload.agentRunId)),

    'b3.transcript.listObservedSubagents': method(readListObservedSubagentsInput,
      (payload, _context, principal) => transcript.listObservedSubagents(principal, payload)),

    'b3.transcript.promoteObservedSubagent': humanOnly(readPromoteObservedSubagentInput,
      'promote an observed subagent',
      (payload, context) =>
        transcript.promoteObservedSubagent(transcriptSystem(context), payload)),

    // --- the surfaces that make the six usable -------------------------------
    //
    // Without a Thread nothing above can be called at all: `threadId` is
    // required by send and open, and §12.5 publishes nothing that produces one.
    'b3.messaging.ensureDirectThread': method(readEnsureDirectThreadInput,
      (payload, context) => messaging.ensureDirectThread(context, payload)),

    'b3.messaging.ensureGroupThread': method(readEnsureGroupThreadInput,
      (payload, context) => messaging.ensureGroupThread(context, payload)),

    'b3.messaging.listAgentInbox': ownAgentOnly(
      readListAgentInboxInput,
      (payload) => [payload.agentId],
      (payload, _context, principal) => messaging.listAgentInbox(principal, payload)),

    'b3.messaging.getAgentEndpoint': ownAgentOnly(
      readGetAgentEndpointInput,
      (payload) => [payload.agentId],
      (payload, _context, principal) => messaging.getAgentEndpoint(principal, payload.agentId)),

    // Chris's sidebar, not an Agent's. §19.2 keeps conversation views as a
    // HUMAN's arrangement of what to look at; an Agent enumerating them learns
    // which conversations Chris has open, which is neither its business nor
    // anything it could act on.
    'b3.messaging.listConversationViews': humanOnly(
      () => b3ok({}),
      'read the conversation-view sidebar',
      (_payload, _context, principal) => messaging.listConversationViews(principal)),

    'b3.messaging.closeConversation': method(readThreadIdInput,
      (payload, context) => messaging.closeConversationView(context, payload.threadId)),

    // Makes the quarantine and mirror suites drivable from outside without
    // touching a provider file (§27, surface #5).
    'b3.transcript.ingest': humanOnly(readIngestTranscriptSourceInput,
      'drive the transcript mirror',
      (payload, context) =>
        transcript.ingestTranscriptSource(transcriptSystem(context), payload)),
  };
}

export { mintTraceCorrelationId };
