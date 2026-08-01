// b3.* methods on the EXISTING nvk-ws v1 frame (§16, AMD-001 A-02).
//
// No JSON-RPC dialect, no second framing, no field added to the socket frame:
// `contractVersion` and `clientOpId` ride inside `params`, and domain
// success/failure travels as a `Result` inside `result`.
import {
  b3err, b3fail, b3ok, mintClientOpId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3ClientOpId, type B3Result, type CommandContext,
  type HumanPrincipalId, type TerminalSessionId,
} from '@novakai/foundation/contract';
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

  /** Every method is the same three steps: parse params, run, return a Result. */
  function method<Payload, Value>(
    perform: (payload: Payload, context: CommandContext) => Promise<B3Result<Value>>,
  ) {
    return async (params: never): Promise<B3Result<Value>> => {
      const parsed = readParams<Payload>(params);
      if (!parsed.ok) return parsed;
      return perform(parsed.value.payload, contextFrom(parsed.value.clientOpId));
    };
  }

  return {
    'b3.runtime.ensure': method<Record<string, never>, unknown>(
      (_payload, context) => runtime.ensureLocalRuntime(context),
    ),
    'b3.runtime.getStatus': method<Record<string, never>, unknown>(
      () => runtime.getRuntimeStatus(principal),
    ),
    'b3.runtime.doctor': method<Record<string, never>, unknown>(
      () => runtime.runtimeDoctor(principal),
    ),
    'b3.runtime.stop': method<Parameters<typeof runtime.requestRuntimeStop>[1], unknown>(
      (payload, context) => runtime.requestRuntimeStop(context, payload),
    ),

    'b3.terminal.open': method<Parameters<typeof terminal.openManagedTerminal>[1], unknown>(
      (payload, context) => terminal.openManagedTerminal(context, payload),
    ),
    'b3.terminal.list': method<{ state?: 'live' | 'final' | 'all' }, unknown>(
      (payload) => terminal.listTerminalSessions(principal, payload),
    ),
    'b3.terminal.inspect': method<{ terminalSessionId: TerminalSessionId }, unknown>(
      (payload) => terminal.getTerminalSession(principal, payload.terminalSessionId),
    ),
    'b3.terminal.attach': method<Parameters<typeof terminal.attachController>[1], unknown>(
      (payload, context) => terminal.attachController(context, payload),
    ),
    'b3.terminal.detach': method<Parameters<typeof terminal.detachController>[1], unknown>(
      (payload, context) => terminal.detachController(context, payload),
    ),
    'b3.terminal.acquireLease': method<Parameters<typeof terminal.acquireInputLease>[1], unknown>(
      (payload, context) => terminal.acquireInputLease(context, payload),
    ),
    'b3.terminal.releaseLease': method<Parameters<typeof terminal.releaseInputLease>[1], unknown>(
      (payload, context) => terminal.releaseInputLease(context, payload),
    ),
    'b3.terminal.write': method<Parameters<typeof terminal.writeInput>[1], unknown>(
      (payload, context) => terminal.writeInput(context, payload),
    ),
    'b3.terminal.resize': method<Parameters<typeof terminal.resizeTerminal>[1], unknown>(
      (payload, context) => terminal.resizeTerminal(context, payload),
    ),
    /** Bounded replay pull. Live following rides the event frame, not a method. */
    'b3.terminal.read': method<
      { terminalSessionId: TerminalSessionId; afterOutputSequence?: number }, unknown
    >(async (payload) => {
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
