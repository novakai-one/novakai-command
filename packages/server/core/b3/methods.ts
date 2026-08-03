// b3.* methods on the EXISTING nvk-ws v1 frame (§16, AMD-001 A-02).
//
// No JSON-RPC dialect, no second framing, no field added to the socket frame:
// `contractVersion` and `clientOpId` ride inside `params`, and domain
// success/failure travels as a `Result` inside `result`.
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3ClientOpId, type B3Result, type CommandContext,
  type HumanPrincipalId,
} from '@novakai/foundation/contract';
import {
  readAcquireInputLeaseInput, readAttachControllerInput, readDetachControllerInput,
  readListTerminalSessionsFilter, readOpenManagedTerminalInput,
  readReadTerminalStreamInput, readReleaseInputLeaseInput, readResizeTerminalInput,
  readGetProviderTurnInputAttemptInput, readIncompleteProviderTurnInputAttemptFilter,
  readTerminalSessionIdInput, readWriteTerminalInput,
} from '../../../terminal/contract/index.js';
import { readRequestRuntimeStopInput } from '../../../agent-runtime/contract/index.js';
import type { MethodTable } from '../../contract/protocol.js';
import type { B3Runtime } from './composition.js';

/**
 * The one shape every b3 request carries. Authentication comes from the
 * token-authenticated transport session; the payload never names a principal
 * (red gate 5).
 */
export interface B3Params<Payload> {
  readonly contractVersion: 1;
  readonly clientOpId?: B3ClientOpId;
  readonly payload: Payload;
}

export interface B3MethodOptions {
  readonly runtime: B3Runtime;
  /** The authenticated local human. B3a has exactly one. */
  readonly principalId: HumanPrincipalId;
  /**
   * Fired once a stop request actually stopped the runtime, so a serving
   * process can release the port it no longer has any business holding.
   */
  readonly onRuntimeStopped?: () => void;
}

const unsupportedVersion = (received: unknown): B3Result<never> => b3fail(
  b3err('UnsupportedContractVersion',
    `contract version ${String(received)} is not supported`,
    { received, supported: [1] }, false),
);

const malformed = (): B3Result<never> => b3fail(
  b3err('ValidationFailed', 'params must be {contractVersion, payload}',
    { issues: [{ path: 'params', message: 'missing contractVersion or payload' }] }, false),
);

function readParams<Payload>(candidate: unknown): B3Result<B3Params<Payload>> {
  if (typeof candidate !== 'object' || candidate === null) return malformed();
  const params = candidate as Partial<B3Params<Payload>>;
  if (params.payload === undefined) return malformed();
  if (params.contractVersion !== 1) return unsupportedVersion(params.contractVersion);
  return b3ok(params as B3Params<Payload>);
}

export function buildB3Methods(options: B3MethodOptions): MethodTable {
  const { runtime, terminal } = options.runtime;

  const principal: AuthenticatedPrincipal = {
    id: options.principalId, kind: 'human', verifiedScopes: [],
  };

  const contextFrom = (clientOpId?: B3ClientOpId): CommandContext => ({
    principal,
    clientOpId: clientOpId ?? mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  });

  /**
   * Every method is the same four steps: read the envelope, VALIDATE the
   * payload at runtime, run, return a Result.
   *
   * The validator is not optional and not a type assertion (§4.2 MUST): a cast
   * is erased, and everything past this point treats the payload as true.
   */
  function method<Payload, Value>(
    validate: (payload: unknown) => B3Result<Payload>,
    perform: (payload: Payload, context: CommandContext) => Promise<B3Result<Value>>,
  ) {
    return async (params: never): Promise<B3Result<Value>> => {
      const parsed = readParams<unknown>(params);
      if (!parsed.ok) return parsed;
      const payload = validate(parsed.value.payload);
      if (!payload.ok) return payload;
      return perform(payload.value, contextFrom(parsed.value.clientOpId));
    };
  }

  /** A method whose payload carries nothing to validate. */
  const noPayload = (): B3Result<Record<string, never>> => b3ok({});

  return {
    'b3.runtime.ensure': method(noPayload,
      (_payload, context) => runtime.ensureLocalRuntime(context)),
    'b3.runtime.getStatus': method(noPayload, () => runtime.getRuntimeStatus(principal)),
    'b3.runtime.doctor': method(noPayload, () => runtime.runtimeDoctor(principal)),
    // A runtime that reports itself stopped and keeps its port is a zombie:
    // every later request 401s, `doctor` cannot reach it to say why, and
    // `ensure --start` spawns a child that dies on EADDRINUSE. The one thing
    // that ends it is the serving process letting go (probe S-6).
    'b3.runtime.stop': method(readRequestRuntimeStopInput, async (payload, context) => {
      const outcome = await runtime.requestRuntimeStop(context, payload);
      if (outcome.ok && outcome.value.stopped) options.onRuntimeStopped?.();
      return outcome;
    }),

    'b3.terminal.open': method(readOpenManagedTerminalInput,
      (payload, context) => terminal.openManagedTerminal(context, payload)),
    'b3.terminal.list': method(readListTerminalSessionsFilter,
      (payload) => terminal.listTerminalSessions(principal, payload)),
    'b3.terminal.inspect': method(readTerminalSessionIdInput,
      (payload) => terminal.getTerminalSession(principal, payload.terminalSessionId)),
    'b3.terminal.attach': method(readAttachControllerInput,
      (payload, context) => terminal.attachController(context, payload)),
    'b3.terminal.detach': method(readDetachControllerInput,
      (payload, context) => terminal.detachController(context, payload)),
    'b3.terminal.acquireLease': method(readAcquireInputLeaseInput,
      (payload, context) => terminal.acquireInputLease(context, payload)),
    'b3.terminal.releaseLease': method(readReleaseInputLeaseInput,
      (payload, context) => terminal.releaseInputLease(context, payload)),
    'b3.terminal.write': method(readWriteTerminalInput,
      (payload, context) => terminal.writeInput(context, payload)),
    'b3.terminal.getProviderTurnInputAttempt': method(
      readGetProviderTurnInputAttemptInput,
      (payload) => terminal.getProviderTurnInputAttempt(principal, payload),
    ),
    'b3.terminal.listIncompleteProviderTurnInputAttempts': method(
      readIncompleteProviderTurnInputAttemptFilter,
      (payload) => terminal.listIncompleteProviderTurnInputAttempts(principal, payload),
    ),
    'b3.terminal.resize': method(readResizeTerminalInput,
      (payload, context) => terminal.resizeTerminal(context, payload)),
    /** Bounded replay pull. Live following rides the event frame, not a method. */
    'b3.terminal.read': method(readReadTerminalStreamInput, async (payload) => {
      const frames = [];
      for await (const frame of terminal.readTerminalStream(principal, {
        ...payload, replayOnly: true,
      })) {
        if (!frame.ok) return frame;
        frames.push(frame.value);
      }
      return b3ok(frames);
    }),
  };
}
