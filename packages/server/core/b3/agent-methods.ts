// `b3.agent.*` on the EXISTING nvk-ws v1 frame (§16.2, AMD-001 A-02).
//
// Same rules as the B3a methods: no second dialect, no field added to the socket
// frame, and every payload VALIDATED at runtime rather than cast. The one thing
// these add is a principal that is not always Chris — a spawned Agent calling
// `nvk agent spawn` from inside its own PTY authenticates as ITSELF, and its
// identity comes from the connection rather than from anything in `params`
// (red gate 5).
import {
  b3err, b3fail, b3ok, mintClientOpId,
  type AuthenticatedPrincipal, type B3Result, type ClientOpId, type CommandContext,
  type PublicOperationName, type RunOperationId,
} from '@novakai/foundation/contract';
import {
  readAdoptAgentInput, readAgentRunIdInput, readApplyRunControlInput,
  readContinueAgentInput, readDiscoverRunControlsInput, readGetAgentRunTreeInput,
  readInterruptAgentTurnInput, readListAgentRunsFilter, readPrepareStopAgentTreeInput,
  readRunOperationIdInput, readSpawnAgentInput, readStopAgentInput, readStopAgentTreeInput,
} from '../../../agent-runtime/contract/index.js';
import {
  readCreateRoleProfileInput, readIssueDelegationGrantInput, readUpdateRoleProfileInput,
} from '../../../agents/b3/contract/index.js';
import { readAgentIdInput, readListGrantsFilter } from './agent-reads.js';
import type { CallerSession, MethodTable } from '../../contract/protocol.js';
import type { B3Runtime } from './composition.js';

export interface B3AgentMethodOptions {
  readonly runtime: B3Runtime;
  /** Resolve the caller from the connection. Never from `params`. */
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

/**
 * §4.1: `op_<uuidv4>`, and "validators MUST reject the wrong prefix even if the
 * remaining string is otherwise valid".
 *
 * A caller that sends a malformed key is making an idempotency claim the server
 * cannot honour. Minting a replacement — which is what used to happen — throws
 * that claim away silently and turns the caller's next retry into a second
 * command. So it is refused, by name.
 */
const CLIENT_OP_ID = /^op_[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readClientOpId(given: string | undefined): B3Result<ClientOpId> {
  // Absent is legal: §17.2 makes the key mandatory on the CLI, and a caller
  // that never claims idempotency gets a fresh operation, which is honest.
  if (given === undefined) return b3ok(mintClientOpId());
  if (!CLIENT_OP_ID.test(given)) {
    return b3fail(b3err('ValidationFailed', 'clientOpId must be op_<uuid>',
      { issues: [{ path: 'clientOpId', message: `not a ClientOpId: ${given}` }] }, false));
  }
  return b3ok(given as ClientOpId);
}

/**
 * An Agent may only hand its authority to a Run it can already reach.
 *
 * `issuerAgentRunId` names the Run a grant is FOR — the Run it dies with — and
 * it arrives in the payload, because a human legitimately names somebody else's
 * Run. For an Agent caller that is authority-widening by target: "hand my own
 * bounded authority to a stranger's Run" (the residue P0-4 reported and could
 * not close inside Agents, which cannot map a Run to its Agent without crossing
 * the one-writer boundary). The composition root CAN: it holds both contracts,
 * so it asks each owner its own question and joins the answers here.
 */
async function issuerWithinReach(
  runtime: B3Runtime,
  principal: AuthenticatedPrincipal,
  issuerAgentRunId: string,
): Promise<B3Result<null>> {
  if (principal.kind !== 'agent-run' || principal.agentRunId === undefined) return b3ok(null);
  if (issuerAgentRunId === principal.agentRunId) return b3ok(null);

  const denied = b3fail(b3err('PermissionDenied',
    'a grant may only name a Run inside the issuing Agent\'s own reach',
    { operation: 'agent.issueGrant', requiredScope: 'agent.delegate' }, false));

  const holder = await runtime.runs.getAgentRun(principal, issuerAgentRunId as never);
  const caller = await runtime.runs.getAgentRun(principal, principal.agentRunId);
  if (!holder.ok || !caller.ok) return denied;
  const family = await runtime.agents.getAgentTree(principal, {
    rootAgentId: caller.value.agent.agentId, direction: 'descendants', maxDepth: 64,
  });
  if (!family.ok) return denied;
  const inside = family.value.items.some(
    (node) => node.agent.id === holder.value.agent.agentId,
  );
  return inside ? b3ok(null) : denied;
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
      // The caller's key, not one minted here: the receipt id is derived from
      // {principal, operation, clientOpId}, so a fresh key per call made every
      // retry a brand-new command (NVK-KIMI-028 finding 2).
      const clientOpId = readClientOpId(parsed.value.clientOpId);
      if (!clientOpId.ok) return clientOpId;
      const principal = options.principalFor(session);
      const context = options.contextFor(principal, session, clientOpId.value);
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

    // §16.2 names these `getControls` and `applyControl`. The short names came
    // first and are kept, because scripts and the CLI already speak them — but
    // a second host written from the spec calls a method by the name the SPEC
    // gives it, and until now that name was `unknown method` (hold-out H3).
    'b3.agent.controls': method(readDiscoverRunControlsInput,
      (payload, _context, principal) => runs.discoverRunControls(principal, payload)),
    'b3.agent.getControls': method(readDiscoverRunControlsInput,
      (payload, _context, principal) => runs.discoverRunControls(principal, payload)),

    'b3.agent.control': method(readApplyRunControlInput,
      (payload, context) => runs.applyRunControl(context, payload)),
    'b3.agent.applyControl': method(readApplyRunControlInput,
      (payload, context) => runs.applyRunControl(context, payload)),

    // §12.1 publishes `issueDelegationGrant`; §16.2 lists no wire name for it,
    // so it takes the name every §16.2 method has — the capability method,
    // minus the noise (`getAgentRun` → `getRun`). Without it, `DelegationGrant`
    // was written on every spawn and readable by nobody, and the four §22 rows
    // that turn on a grant could not be tested from outside at all (D10).
    'b3.agent.issueGrant': method(readIssueDelegationGrantInput,
      async (payload, context, principal) => {
        const reachable = await issuerWithinReach(
          options.runtime, principal, payload.issuerAgentRunId,
        );
        if (!reachable.ok) return reachable;
        return agents.issueDelegationGrant(context, payload);
      }),

    'b3.agent.listGrants': method(readListGrantsFilter,
      (payload, _context, principal) => agents.listDelegationGrants(principal, payload)),

    // §12.2's recovery action, and until now `unknown method`: a stranded
    // operation had no public cleanup at all (G6).
    'b3.agent.repairOperation': method(readRunOperationIdInput,
      (payload, context) => runs.repairRunOperation(context, payload.operationId)),

    // "fence" is named in B3b's exit line and was provable only from inside the
    // code (E9). A partial stop leaves it closed, which is exactly when someone
    // needs to see it.
    'b3.agent.getTreeFence': method(readAgentIdInput,
      (payload, _context, principal) => runs.getTreeFence(principal, payload)),

    'b3.agent.getRoles': method(noPayload, async (_payload, _context, principal) => {
      // A list of every role, so `nvk agent spawn --role builder` can resolve a
      // NAME. Chris types names; ids are for machines.
      const listed = await agents.listRoleProfiles(principal);
      return listed;
    }),
  };
}

export type { CallerSession, PublicOperationName };
