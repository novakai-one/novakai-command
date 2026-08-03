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
  CancelPreparedProviderTurnInput, CancelReservedNotificationInput,
  CloseTerminalProviderTurnUnprovenInput, CommitReservedNotificationInput,
  ExecuteProviderTurnInputInput,
  InterruptTerminalTurnInput, ListTerminalSessionsFilter, OpenManagedTerminalInput,
  NotificationInputCommitOutcome, ReserveNotificationInput,
  PrepareProviderTurnInputInput, PrepareProviderTurnInputOutcome,
  ReadTerminalStreamInput, ReleaseInputLeaseInput, ResizeTerminalInput,
  SettleTerminalProviderTurnCompletionInput, SettleTerminalProviderTurnCompletionOutcome,
  SetControllerDraftStateInput,
  TerminalContract, TerminateTerminalInput, WriteTerminalInput,
  InterruptTerminalTurnOutcome,
} from '../contract/api.js';
import type { Clock, PtyHost, RuntimeEpochFence } from '../contract/ports.js';
import { systemClock } from '../contract/ports.js';
import { requireSystemAuthority } from './authority.js';
import { LiveSessions } from './live.js';
import { SessionQueue } from './serialize.js';
import { DEFAULT_REPLAY_BYTES } from './replay.js';
import { createTerminalStore, type TerminalStoreOptions } from './store.js';
import { OPERATION, type TerminalCore } from './context.js';
import { DEFAULT_STALE_AFTER_MS } from '../contract/api.js';
import { observeControllers } from './presence.js';
import {
  getTerminalSession, listTerminalSessions, openManagedTerminal,
  reconcileAfterRestart, terminateTerminal,
} from './sessions.js';
import { attachController, detachController, resizeTerminal } from './controllers.js';
import { acquireInputLease, releaseInputLease, writeInput } from './input.js';
import { interruptTerminalTurn } from './interrupt.js';
import { readTerminalStream } from './stream.js';
import type {
  ControllerAttachment, NotificationInputReservation, ProviderTurnTerminalInputAttempt,
  TerminalInputAttempt, TerminalSession,
} from '../contract/records.js';
import {
  cancelReservedNotificationInput, commitReservedNotificationInput,
  getNotificationInputReservation, getTerminalInputAttempt,
  reserveNotificationInput, setControllerDraftState,
} from './notification-input.js';
import {
  cancelPreparedProviderTurnInput, closeProviderTurnBarrierUnproven,
  executeProviderTurnInput, getProviderTurnInputAttempt,
  listIncompleteProviderTurnInputAttempts, prepareProviderTurnInput,
  settleProviderTurnCompletion,
} from './provider-turn-input.js';

export interface ComposeTerminalOptions extends TerminalStoreOptions {
  readonly ptyHost: PtyHost;
  readonly epochFence: RuntimeEpochFence;
  readonly clock?: Clock;
  readonly receipts?: ReceiptStore;
  /** Bytes of output kept for replay per session. */
  readonly replayBytes?: number;
  /** Host observation of an uncommanded managed-process exit. */
  readonly onUnexpectedExit?: (terminalSessionId: TerminalSessionId) => void;
  /** How long a controller may go unseen before it is `stale` (§13.4). */
  readonly staleAfterMs?: number;
  readonly providerTurnDelivery?: TerminalCore['providerTurnDelivery'];
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
    ...(options.onUnexpectedExit === undefined
      ? {}
      : { onUnexpectedExit: options.onUnexpectedExit }),
    staleAfterMs: options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    providerTurnDelivery: options.providerTurnDelivery
      ?? (async (_providerSessionId, utf8Text) => [
        { utf8Text, pauseMsAfter: 0 },
        { utf8Text: '\r', pauseMsAfter: 0 },
      ]),
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
    async reserveNotificationInput(context, input: ReserveNotificationInput) {
      const version = versionGuard<NotificationInputReservation>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(
        context, 'sys_agent_runtime', OPERATION.reserveNotification,
      );
      if (!authorised.ok) return authorised;
      return core.queue.enqueue(input.terminalSessionId, () => core.receipts.runCommand(
        context,
        { operation: OPERATION.reserveNotification, request: input, replaySafe: true },
        () => reserveNotificationInput(core, context, input),
      ));
    },
    async commitReservedNotificationInput(context, input: CommitReservedNotificationInput) {
      const version = versionGuard<NotificationInputCommitOutcome>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(
        context, 'sys_agent_runtime', OPERATION.commitNotification,
      );
      if (!authorised.ok) return authorised;
      const reservation = await core.store.read<NotificationInputReservation>(
        'notificationInputReservation', input.notificationInputReservationId,
      );
      if (!reservation.ok) return reservation;
      const lane = reservation.value?.terminalSessionId ?? input.notificationInputReservationId;
      return core.queue.enqueue(lane, () => core.receipts.runCommand(
        context,
        { operation: OPERATION.commitNotification, request: input, replaySafe: true },
        () => commitReservedNotificationInput(core, context, input),
      ));
    },
    async cancelReservedNotificationInput(context, input: CancelReservedNotificationInput) {
      const version = versionGuard<NotificationInputReservation>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(
        context, 'sys_agent_runtime', OPERATION.cancelNotification,
      );
      if (!authorised.ok) return authorised;
      const reservation = await core.store.read<NotificationInputReservation>(
        'notificationInputReservation', input.notificationInputReservationId,
      );
      if (!reservation.ok) return reservation;
      const lane = reservation.value?.terminalSessionId ?? input.notificationInputReservationId;
      return core.queue.enqueue(lane, () => core.receipts.runCommand(
        context,
        { operation: OPERATION.cancelNotification, request: input, replaySafe: true },
        () => cancelReservedNotificationInput(core, context, input),
      ));
    },
    async setControllerDraftState(context, input: SetControllerDraftStateInput) {
      const version = versionGuard<ControllerAttachment>(context);
      if (version) return version;
      const attachment = await core.store.read<ControllerAttachment>(
        'controllerAttachment', input.attachmentId,
      );
      if (!attachment.ok) return attachment;
      const lane = attachment.value?.terminalSessionId ?? input.attachmentId;
      return core.queue.enqueue(lane, () => core.receipts.runCommand(
        context, { operation: OPERATION.draft, request: input, replaySafe: true },
        () => setControllerDraftState(core, context, input),
      ));
    },
    writeInput: guarded(
      OPERATION.write, (input) => input.terminalSessionId, false,
      (context, input: WriteTerminalInput) => writeInput(core, context, input),
    ),
    async prepareProviderTurnInput(context, input: PrepareProviderTurnInputInput) {
      const version = versionGuard<PrepareProviderTurnInputOutcome>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(
        context, 'sys_agent_runtime', OPERATION.prepareProviderTurn,
      );
      if (!authorised.ok) return authorised;
      return core.queue.enqueue(input.terminalSessionId, () => core.receipts.runCommand(
        context,
        { operation: OPERATION.prepareProviderTurn, request: input, replaySafe: true },
        () => prepareProviderTurnInput(core, context, input),
      ));
    },
    async executeProviderTurnInput(context, input: ExecuteProviderTurnInputInput) {
      const version = versionGuard<ProviderTurnTerminalInputAttempt>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(
        context, 'sys_agent_runtime', OPERATION.executeProviderTurn,
      );
      if (!authorised.ok) return authorised;
      const attempt = await core.store.read<ProviderTurnTerminalInputAttempt>(
        'terminalInputAttempt', input.terminalInputAttemptId,
      );
      if (!attempt.ok) return attempt;
      const lane = attempt.value?.terminalSessionId ?? input.terminalInputAttemptId;
      return core.queue.enqueue(lane, () => core.receipts.runCommand(
        context,
        { operation: OPERATION.executeProviderTurn, request: input, replaySafe: true },
        () => executeProviderTurnInput(core, input),
      ));
    },
    async cancelPreparedProviderTurnInput(context, input: CancelPreparedProviderTurnInput) {
      const version = versionGuard<ProviderTurnTerminalInputAttempt>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(
        context, 'sys_agent_runtime', OPERATION.cancelProviderTurn,
      );
      if (!authorised.ok) return authorised;
      const attempt = await core.store.read<ProviderTurnTerminalInputAttempt>(
        'terminalInputAttempt', input.terminalInputAttemptId,
      );
      if (!attempt.ok) return attempt;
      const lane = attempt.value?.terminalSessionId ?? input.terminalInputAttemptId;
      return core.queue.enqueue(lane, () => core.receipts.runCommand(
        context,
        { operation: OPERATION.cancelProviderTurn, request: input, replaySafe: true },
        () => cancelPreparedProviderTurnInput(core, input),
      ));
    },
    async settleProviderTurnCompletion(context, input: SettleTerminalProviderTurnCompletionInput) {
      const version = versionGuard<SettleTerminalProviderTurnCompletionOutcome>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(
        context, 'sys_agent_runtime', OPERATION.settleProviderTurn,
      );
      if (!authorised.ok) return authorised;
      const attempt = await core.store.read<ProviderTurnTerminalInputAttempt>(
        'terminalInputAttempt', input.terminalInputAttemptId,
      );
      if (!attempt.ok) return attempt;
      const lane = attempt.value?.terminalSessionId ?? input.terminalInputAttemptId;
      return core.queue.enqueue(lane, () => core.receipts.runCommand(
        context,
        { operation: OPERATION.settleProviderTurn, request: input, replaySafe: true },
        () => settleProviderTurnCompletion(core, input),
      ));
    },
    async closeProviderTurnBarrierUnproven(
      context, input: CloseTerminalProviderTurnUnprovenInput,
    ) {
      const version = versionGuard<ProviderTurnTerminalInputAttempt>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(
        context, 'sys_agent_runtime', OPERATION.closeProviderTurn,
      );
      if (!authorised.ok) return authorised;
      const attempt = await core.store.read<ProviderTurnTerminalInputAttempt>(
        'terminalInputAttempt', input.terminalInputAttemptId,
      );
      if (!attempt.ok) return attempt;
      const lane = attempt.value?.terminalSessionId ?? input.terminalInputAttemptId;
      return core.queue.enqueue(lane, () => core.receipts.runCommand(
        context,
        { operation: OPERATION.closeProviderTurn, request: input, replaySafe: true },
        () => closeProviderTurnBarrierUnproven(core, input),
      ));
    },
    resizeTerminal: guarded(
      OPERATION.resize, (input) => input.terminalSessionId, true,
      (context, input: ResizeTerminalInput) => resizeTerminal(core, context, input),
    ),

    async interruptTerminalTurn(
      context: SystemCommandContext<'sys_agent_runtime'>, input: InterruptTerminalTurnInput,
    ) {
      const version = versionGuard<InterruptTerminalTurnOutcome>(context);
      if (version) return version;
      const authorised = requireSystemAuthority(context, 'sys_agent_runtime', OPERATION.interrupt);
      if (!authorised.ok) return authorised;
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
      // Red gate 1: the type says system-only and the type is erased at runtime.
      const authorised = requireSystemAuthority(context, 'sys_agent_runtime', OPERATION.terminate);
      if (!authorised.ok) return authorised;
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

    getTerminalInputAttempt: (_principal, terminalInputAttemptId) =>
      getTerminalInputAttempt(core, terminalInputAttemptId),

    getProviderTurnInputAttempt: (_principal, input) =>
      getProviderTurnInputAttempt(core, input),

    listIncompleteProviderTurnInputAttempts: (_principal, filter) =>
      listIncompleteProviderTurnInputAttempts(core, filter),

    getNotificationInputReservation: (_principal, notificationInputReservationId) =>
      getNotificationInputReservation(core, notificationInputReservationId),

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
      async observeControllers(context, input) {
        const authorised = requireSystemAuthority(
          context, 'sys_agent_runtime', OPERATION.observe,
        );
        if (!authorised.ok) return authorised;
        return observeControllers(core, input.attachmentIds);
      },

      async reconcileAfterRestart(
        context, input: { readonly activeRuntimeEpochId: RuntimeEpochId },
      ) {
        const authorised = requireSystemAuthority(
          context, 'sys_agent_runtime', OPERATION.reconcile,
        );
        if (!authorised.ok) return authorised;
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
