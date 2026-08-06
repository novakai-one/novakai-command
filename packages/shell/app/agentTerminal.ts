// shell/app/agentTerminal.ts — the implementation behind FZ-VIEW-001's
// `terminal` slice.
//
// Seven published methods, one call site each. The B1a facade
// (`app/terminalClient.ts`) now goes through here rather than sending its own
// frames, so "attach" means one thing in this browser and there is one place a
// payload name can be wrong.
//
// This slice does no decoding. `b3.terminal.read` answers with base64 frames and
// `b3.terminal.output` pushes them, and turning those into text is presentation
// that belongs beside the xterm — not in the door, which would then owe the
// contract a decoded shape the capability never published.
import type {
  ShellTerminalServices,
} from '../contract/agentTerminal.js';
import type { ShellReadResult } from '../contract/agentRuns.js';
import { anyValue, guarded, readEnvelope } from './b3Envelope.js';
import type { B3ReadCall } from './agentRuns.js';

function terminalCall(
  call: B3ReadCall, method: string, payload: unknown,
): Promise<ShellReadResult<unknown>> {
  return guarded(async () => readEnvelope<unknown>(
    await call(method, payload), anyValue, `the Runtime returned no answer to ${method}`,
  ));
}

/**
 * `afterOutputSequence` is optional and MEANS something when absent: replay from
 * the earliest frame the Runtime still holds. Sending `undefined` would make the
 * owner reject a request the caller was entitled to make, so an absent optional
 * stays absent — the same rule as the lifecycle slice's.
 */
function withSequence(
  base: Record<string, unknown>, afterOutputSequence: number | undefined,
): Record<string, unknown> {
  return afterOutputSequence === undefined ? base : { ...base, afterOutputSequence };
}

export function createShellTerminalServices(call: B3ReadCall): ShellTerminalServices {
  return {
    attachController: (request) => terminalCall(call, 'b3.terminal.attach', withSequence({
      terminalSessionId: request.terminalSessionId,
      controllerKind: request.controllerKind,
      columns: request.columns,
      rows: request.rows,
    }, request.afterOutputSequence)),

    detachController: (request) => terminalCall(call, 'b3.terminal.detach', request),

    acquireInputLease: (request) => terminalCall(call, 'b3.terminal.acquireLease', {
      terminalSessionId: request.terminalSessionId,
      attachmentId: request.attachmentId,
      mode: request.mode,
      ttlMs: request.ttlMs,
      ...(request.expectedLeaseGeneration === undefined
        ? {}
        : { expectedLeaseGeneration: request.expectedLeaseGeneration }),
    }),

    releaseInputLease: (request) => terminalCall(call, 'b3.terminal.releaseLease', request),

    writeInput: (request) => terminalCall(call, 'b3.terminal.write', {
      terminalSessionId: request.terminalSessionId,
      attachmentId: request.attachmentId,
      inputLeaseId: request.inputLeaseId,
      leaseGeneration: request.leaseGeneration,
      expectedNextInputSequence: request.expectedNextInputSequence,
      kindOfInput: request.kindOfInput,
      ...(request.utf8Text === undefined ? {} : { utf8Text: request.utf8Text }),
    }),

    resizeTerminal: (request) => terminalCall(call, 'b3.terminal.resize', request),

    readTerminalStream: (request) => terminalCall(call, 'b3.terminal.read', withSequence({
      terminalSessionId: request.terminalSessionId,
    }, request.afterOutputSequence)),
  };
}
