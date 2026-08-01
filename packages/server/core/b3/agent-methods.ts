// `b3.agent.*` on the EXISTING nvk-ws v1 frame (§16.2, AMD-001 A-02).
//
// Same rules as the B3a methods: no second dialect, no field added to the socket
// frame, and every payload VALIDATED at runtime rather than cast. The one thing
// these add is a principal that is not always Chris — a spawned Agent calling
// `nvk agent spawn` from inside its own PTY authenticates as ITSELF, and its
// identity comes from the connection rather than from anything in `params`
// (red gate 5).
import {
  b3err, b3fail, b3ok,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type PublicOperationName, type RunOperationId,
} from '@novakai/foundation/contract';
import {
  readAdoptAgentInput, readAgentRunIdInput, readContinueAgentInput,
  readGetAgentRunTreeInput, readInterruptAgentTurnInput, readListAgentRunsFilter,
  readPrepareStopAgentTreeInput, readRunOperationIdInput, readSpawnAgentInput,
  readStopAgentInput, readStopAgentTreeInput,
} from '../../../agent-runtime/contract/index.js';
import {
  readCreateRoleProfileInput, readUpdateRoleProfileInput,
} from '../../../agents/b3/contract/index.js';
import type { CallerSession, MethodTable } from '../../contract/protocol.js';
import type { B3Runtime } from './composition.js';

export interface B3AgentMethodOptions {
  readonly runtime: B3Runtime;
  /** Resolve the caller from the connection. Never from `params`. */
  readonly principalFor: (session: CallerSession | undefined) => AuthenticatedPrincipal;
  readonly contextFor: (
    principal: AuthenticatedPrincipal, session: CallerSession | undefined,
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

export function buildB3AgentMethods(options: B3AgentMethodOptions): MethodTable {
  const { runs, agents } = options.runtime;

  /**
   * Read the envelope, VALIDATE the payload, resolve the caller from the
   * CONNECTION, run, return a Result. The validator is not optional: a cast is
   * erased and everything past this point treats the payload as true.
   */
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
      const principal = options.principalFor(session);
      const context = options.contextFor(principal, session);
      return perform(payload.value, context, principal);
    };
  }

  const noPayload = (): B3Result<Record<string, never>> => b3ok({});

  return {
    'b3.agent.spawn': method(readSpawnAgentInput,
      (payload, context) => runs.spawnAgent(context, payload)),

    'b3.agent.interrupt': method(readInterruptAgentTurnInput,
      (payload, context) => runs.interruptAgentTurn(context, payload)),

    'b3.agent.beginTurn': method(readInterruptAgentTurnInput,
      (payload, context) => runs.beginProviderTurn(context, payload)),

    'b3.agent.stop': method(readStopAgentInput,
      (payload, context) => runs.stopAgent(context, payload)),

    'b3.agent.prepareStopTree': method(readPrepareStopAgentTreeInput,
      (payload, context) => runs.prepareStopAgentTree(context, payload)),

    'b3.agent.stopTree': method(readStopAgentTreeInput,
      (payload, context) => runs.stopAgentTree(context, payload)),

    'b3.agent.continue': method(readContinueAgentInput,
      (payload, context) => runs.continueAgent(context, payload)),

    'b3.agent.adopt': method(readAdoptAgentInput,
      (payload, context) => runs.adoptAgent(context, payload)),

    'b3.agent.getRun': method(readAgentRunIdInput,
      (payload, _context, principal) => runs.getAgentRun(principal, payload.agentRunId)),

    'b3.agent.listRuns': method(readListAgentRunsFilter,
      (payload, _context, principal) => runs.listAgentRuns(principal, payload)),

    'b3.agent.getTree': method(readGetAgentRunTreeInput,
      (payload, _context, principal) => runs.getAgentRunTree(principal, payload)),

    'b3.agent.getOperation': method(readRunOperationIdInput,
      (payload, _context, principal) =>
        runs.getRunOperation(principal, payload.operationId as RunOperationId)),

    'b3.agent.listOperations': method(noPayload,
      (_payload, _context, principal) =>
        runs.listRunOperations(principal, { includeCompleted: true })),

    'b3.agent.createRole': method(readCreateRoleProfileInput,
      (payload, context) => agents.createRoleProfile(context, payload)),

    'b3.agent.updateRole': method(readUpdateRoleProfileInput,
      (payload, context) => agents.updateRoleProfile(context, payload)),

    'b3.agent.getRoles': method(noPayload, async (_payload, _context, principal) => {
      // A list of every role, so `nvk agent spawn --role builder` can resolve a
      // NAME. Chris types names; ids are for machines.
      const listed = await agents.listRoleProfiles(principal);
      return listed;
    }),
  };
}

export type { CallerSession, PublicOperationName };
