// The Terminal composition root.
//
// Every public mutation goes through the same three guards, in the same order:
// serialize per session → durable command receipt → the operation itself. That
// is what makes "two controllers in the same millisecond" and "a retry after a
// crash" ordinary rather than exceptional.
import {
  b3fail, b3err, b3ok, composeReceiptStore,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type ReceiptStore, type RuntimeEpochId, type SystemCommandContext,
  type TerminalSessionId,
} from '@novakai/foundation/contract';
import type {
  AcquireInputLeaseInput, AttachControllerInput, DetachControllerInput,
  InterruptTerminalTurnInput, ListTerminalSessionsFilter, OpenManagedTerminalInput,
  ReadTerminalStreamInput, ReleaseInputLeaseInput, ResizeTerminalInput,
  TerminalContract, TerminateTerminalInput, WriteTerminalInput,
  InterruptTerminalTurnOutcome,
} from '../contract/api.js';
import type { Clock, PtyHost, RuntimeEpochFence } from '../contract/ports.js';
import { systemClock } from '../contract/ports.js';
import { LiveSessions } from './live.js';
import { SessionQueue } from './serialize.js';
import { DEFAULT_REPLAY_BYTES } from './replay.js';
import { createTerminalStore, type TerminalStoreOptions } from './store.js';
import { OPERATION, type TerminalCore } from './context.js';
import {
  getTerminalSession, listTerminalSessions, openManagedTerminal,
  reconcileAfterRestart, terminateTerminal,
} from './sessions.js';
import { attachController, detachController, resizeTerminal } from './controllers.js';
import { acquireInputLease, releaseInputLease, writeInput } from './input.js';
import { interruptTerminalTurn } from './interrupt.js';
import { readTerminalStream } from './stream.js';
import type { ControllerAttachment, TerminalSession } from '../contract/records.js';

export interface ComposeTerminalOptions extends TerminalStoreOptions {
  readonly ptyHost: PtyHost;
  readonly epochFence: RuntimeEpochFence;
  readonly clock?: Clock;
  readonly receipts?: ReceiptStore;
  /** Bytes of output kept for replay per session. */
  readonly replayBytes?: number;
}

export function composeTerminal(options: ComposeTerminalOptions): TerminalContract {
  const core: TerminalCore = {
    store: createTerminalStore(options),
    live: new LiveSessions(),
    queue: new SessionQueue(),
    ptyHost: options.ptyHost,
    epochFence: options.epochFence,
    clock: options.clock ?? systemClock,
    receipts: options.receipts ?? composeReceiptStore(options),
    replayBytes: options.replayBytes ?? DEFAULT_REPLAY_BYTES,
  };

  /**
   * `replaySafe` says whether re-entering the operation after an interrupted
   * attempt is harmless. Only `writeInput` can already have moved bytes into a
   * real process with no way to tell, so only it refuses at this layer.
   *
   * `open` is replay-safe because re-entering it is not a second launch: it
   * finds its own earlier reservation by operation id and adopts, resumes, or
   * reports recovery (§13.5). Refusing here instead would make adoption
   * unreachable — the receipt would answer before Terminal ever looked.
   */
  function guarded<Input, Value>(
    operation: typeof OPERATION[keyof typeof OPERATION],
    lane: (input: Input) => string,
    replaySafe: boolean,
    perform: (context: CommandContext, input: Input) => Promise<B3Result<Value>>,
  ) {
    return async (context: CommandContext, input: Input): Promise<B3Result<Value>> => {
      const version = versionGuard<Value>(context);
      if (version) return version;
      return core.queue.enqueue(lane(input), () => core.receipts.runCommand(
        context, { operation, request: input, replaySafe }, () => perform(context, input),
      ));
    };
  }

  const contract: TerminalContract = {
    openManagedTerminal: guarded(
      OPERATION.open, (input) => `open:${input.launchFingerprint}:${input.workingDirectory}`, true,
      (context, input: OpenManagedTerminalInput) => openManagedTerminal(core, context, input),
    ),
    attachController: guarded(
      OPERATION.attach, (input) => input.terminalSessionId, true,
      (context, input: AttachControllerInput) => attachController(core, context, input),
    ),
    detachController: guarded(
      OPERATION.detach, (input) => input.terminalSessionId, true,
      (context, input: DetachControllerInput) => detachController(core, context, input),
    ),
    acquireInputLease: guarded(
      OPERATION.acquire, (input) => input.terminalSessionId, true,
      (context, input: AcquireInputLeaseInput) => acquireInputLease(core, context, input),
    ),
    releaseInputLease: guarded(
      OPERATION.release, (input) => input.terminalSessionId, true,
      (context, input: ReleaseInputLeaseInput) => releaseInputLease(core, context, input),
    ),
    writeInput: guarded(
      OPERATION.write, (input) => input.terminalSessionId, false,
      (context, input: WriteTerminalInput) => writeInput(core, context, input),
    ),
    resizeTerminal: guarded(
      OPERATION.resize, (input) => input.terminalSessionId, true,
      (context, input: ResizeTerminalInput) => resizeTerminal(core, context, input),
    ),

    async interruptTerminalTurn(
      context: SystemCommandContext<'sys_agent_runtime'>, input: InterruptTerminalTurnInput,
    ) {
      const version = versionGuard<InterruptTerminalTurnOutcome>(context);
      if (version) return version;
      return core.queue.enqueue(input.terminalSessionId, () => core.receipts.runCommand(
        context, { operation: OPERATION.interrupt, request: input, replaySafe: false },
        () => interruptTerminalTurn(core, context, input),
      ));
    },

    async terminateTerminal(
      context: SystemCommandContext<'sys_agent_runtime'>, input: TerminateTerminalInput,
    ) {
      const version = versionGuard<TerminalSession>(context);
      if (version) return version;
      return core.queue.enqueue(input.terminalSessionId, () => core.receipts.runCommand(
        context, { operation: OPERATION.terminate, request: input, replaySafe: true },
        () => terminateTerminal(core, context, input),
      ));
    },

    getTerminalSession: (principal, terminalSessionId) =>
      getTerminalSession(core, principal, terminalSessionId),

    listTerminalSessions: (principal: AuthenticatedPrincipal, filter?: ListTerminalSessionsFilter) =>
      listTerminalSessions(core, principal, filter),

    async listControllerAttachments(_principal, terminalSessionId: TerminalSessionId) {
      return core.store.list<ControllerAttachment>(
        'controllerAttachment', { terminalSessionId },
      );
    },

    readTerminalStream: (principal, input: ReadTerminalStreamInput) =>
      readTerminalStream(core, principal, input),

    system: {
      async beginProviderTurn(context, input) {
        void context;
        const live = core.live.lookup(input.terminalSessionId);
        if (!live) {
          return b3fail(b3err('TerminalNotLive',
            'no live process for this session', { terminalSessionId: input.terminalSessionId, status: 'unknown' }, false));
        }
        live.activeTurn = {
          providerTurnId: input.providerTurnId,
          activityGeneration: input.activityGeneration,
          agentRunId: input.agentRunId,
        };
        return b3ok(null);
      },
      async endProviderTurn(context, input) {
        void context;
        const live = core.live.lookup(input.terminalSessionId);
        if (live?.activeTurn?.providerTurnId === input.providerTurnId) live.activeTurn = null;
        return b3ok(null);
      },
      async reconcileAfterRestart(
        context, input: { readonly activeRuntimeEpochId: RuntimeEpochId },
      ) {
        void context;
        return reconcileAfterRestart(core, input.activeRuntimeEpochId);
      },
    },

    async dispose() {
      // Runtime-private teardown only. Deliberately does NOT stop any PTY:
      // disposing a composition is not an authorised stop (red gate 1).
      for (const session of core.live.list()) core.live.forget(session.sessionId);
    },
  };
  return contract;
}

/** §3.5: an unknown newer contract version is refused, never guessed at. */
function versionGuard<T>(context: CommandContext): B3Result<T> | null {
  if (context.contractVersion === 1) return null;
  return b3fail(b3err('UnsupportedContractVersion',
    `contract version ${String(context.contractVersion)} is not supported`,
    { received: context.contractVersion, supported: [1] }, false));
}
