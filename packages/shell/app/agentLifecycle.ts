// shell/app/agentLifecycle.ts — the implementation behind FZ-VIEW-001's
// `lifecycle` and `runtime` slices.
//
// Every method here is a published one; nothing was added to the server for
// this door (`packages/server/core/runtime-host/agent-methods.ts:180–250`,
// `methods.ts:103`). The Shell was simply not calling them, which is finding
// L-20 — and the slice's absence, not any missing capability, is what made
// FZ-VIEW-033's "Stop and close" unreachable.
//
// The bodies are deliberately dull. A lifecycle command is the one place a
// consumer is most tempted to be helpful — to retry a version conflict, to look
// up the agentId itself, to treat "already stopping" as success — and every one
// of those is the consumer deciding something the owner owns. The interesting
// decision (which stop, aimed at what the caller actually READ) is pure and
// lives in `contract/agentLifecycle.ts`.
import type {
  ShellLifecycleServices, ShellRuntimeServices,
} from '../contract/agentLifecycle.js';
import type { ShellReadResult } from '../contract/agentRuns.js';
import { anyValue, guarded, readEnvelope } from './b3Envelope.js';
import type { B3ReadCall } from './agentRuns.js';

/** One command, one published method, one envelope back. */
function command(
  call: B3ReadCall, method: string, payload: unknown,
): Promise<ShellReadResult<unknown>> {
  return guarded(async () => readEnvelope<unknown>(
    await call(method, payload), anyValue, `the Runtime returned no answer to ${method}`,
  ));
}

/**
 * `undefined` is not a value on the wire. The published readers use
 * `field.optionalX`, which distinguishes "absent" from "present and wrong" — so
 * a key sent as `undefined` is a key the owner has to have an opinion about.
 * Absent means absent.
 */
function withOptional(
  base: Record<string, unknown>, optional: Record<string, unknown>,
): Record<string, unknown> {
  const built = { ...base };
  for (const [field, value] of Object.entries(optional)) {
    if (value !== undefined) built[field] = value;
  }
  return built;
}

export function createShellLifecycleServices(call: B3ReadCall): ShellLifecycleServices {
  return {
    spawnAgent: (request) => command(call, 'b3.agent.spawn', withOptional({
      roleProfileId: request.roleProfileId,
      displayName: request.displayName,
      workingDirectory: request.workingDirectory,
    }, {
      requestedProvider: request.requestedProvider,
      requestedModelId: request.requestedModelId,
      requestedEffort: request.requestedEffort,
      task: request.task,
      columns: request.columns,
      rows: request.rows,
    })),

    interruptAgentTurn: (request) => command(call, 'b3.agent.interrupt', {
      agentRunId: request.agentRunId,
      expectedRecordVersion: request.expectedRecordVersion,
    }),

    // Passed through as the caller built it. There is nothing to reshape: the
    // three fields ARE the frozen input, and `confirmation` is a literal the
    // caller had to type, which is the interlock working.
    stopAgent: (request) => command(call, 'b3.agent.stop', request),

    prepareStopAgentTree: (request) => command(call, 'b3.agent.prepareStopTree', request),

    // The token is the one the caller was ISSUED over the tree it was SHOWN.
    // Nothing here mints, caches or reuses one.
    stopAgentTree: (request) => command(call, 'b3.agent.stopTree', request),

    continueAgent: (request) => command(call, 'b3.agent.continue', withOptional({
      agentId: request.agentId,
      expectedOldRunId: request.expectedOldRunId,
      mode: request.mode,
      configurationMode: request.configurationMode,
    }, {
      replacementPlanId: request.replacementPlanId,
      handoverArtifactId: request.handoverArtifactId,
    })),

    adoptAgent: (request) => command(call, 'b3.agent.adopt', request),
  };
}

/**
 * The `runtime` slice. `getRuntimeStatus` takes no payload — `b3.runtime.getStatus`
 * is registered with `noPayload`, so `{}` is the whole request.
 */
export function createShellRuntimeServices(call: B3ReadCall): ShellRuntimeServices {
  return {
    getRuntimeStatus: () => command(call, 'b3.runtime.getStatus', {}),
  };
}
