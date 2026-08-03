// Q7 — a watcher-originated turn is reserved before Supervision is claimed.
//
// The reservation is Terminal-owned because only Terminal can atomically say
// that no controller lease or draft can race the provider input. These tests
// exercise the public contract: no core/store shortcuts and no direct PTY use.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  deterministicId, mintProviderTurnId,
  type ActivityGeneration, type AgentRunId, type B3Brand, type B3Result,
  type IsoUtc, type ProviderTurnId, type RecordEnvelope, type TerminalInputAttemptId,
} from '@novakai/foundation/contract';
import type {
  ControllerAttachment, TerminalContract, TerminalInputAttempt,
} from '../../contract/index.js';
import {
  createRig, expectError, humanContext, openMockManagedSession,
  runtimeContext, unwrap,
} from '../harness.js';

const RUN_ID = 'agentRun_00000000-0000-7000-8000-000000000001' as AgentRunId;
const NOTIFICATION_ID = `notification_${'c'.repeat(52)}`;
const EFFECT_KEY = `b3v4:notification-delivery:${NOTIFICATION_ID}:condition`;
const SUMMARY = 'Output token threshold reached';

const reservationId = (): NotificationInputReservationId => deterministicId(
  'notificationInput', ['notification-input', EFFECT_KEY],
) as NotificationInputReservationId;

const digest = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

type NotificationInputReservationId = B3Brand<string, 'NotificationInputReservationId'>;
type NotificationInputReservation = RecordEnvelope<
  NotificationInputReservationId, 'notificationInputReservation'
> & {
  readonly terminalSessionId: string;
  readonly providerTurnId: ProviderTurnId;
  readonly state: 'reserved' | 'committed' | 'cancelled';
  readonly terminalInputAttemptId?: TerminalInputAttemptId;
};
interface NotificationInputCommitOutcome {
  readonly reservation: NotificationInputReservation & {
    readonly state: 'committed';
    readonly terminalInputAttemptId: TerminalInputAttemptId;
  };
  readonly attempt: TerminalInputAttempt & {
    readonly source: 'system-notification';
    readonly providerTurnId: ProviderTurnId;
    readonly submittedAt: IsoUtc;
  };
}

interface NotificationTerminal extends TerminalContract {
  reserveNotificationInput(
    context: ReturnType<typeof runtimeContext>,
    input: {
      readonly terminalSessionId: string;
      readonly agentRunId: AgentRunId;
      readonly notificationId: string;
      readonly effectKey: string;
      readonly expectedActivityGeneration: ActivityGeneration;
      readonly inputTextDigest: string;
      readonly providerTurnId: ReturnType<typeof mintProviderTurnId>;
    },
  ): Promise<B3Result<NotificationInputReservation>>;
  commitReservedNotificationInput(
    context: ReturnType<typeof runtimeContext>,
    input: {
      readonly notificationInputReservationId: NotificationInputReservationId;
      readonly effectKey: string;
      readonly utf8Text: string;
    },
  ): Promise<B3Result<NotificationInputCommitOutcome>>;
  getNotificationInputReservation(
    principal: ReturnType<typeof humanContext>['principal'],
    id: NotificationInputReservationId,
  ): Promise<B3Result<NotificationInputReservation>>;
  getTerminalInputAttempt(
    principal: ReturnType<typeof humanContext>['principal'],
    id: TerminalInputAttemptId,
  ): Promise<B3Result<TerminalInputAttempt>>;
  setControllerDraftState(
    context: ReturnType<typeof humanContext>,
    input: {
      readonly attachmentId: ControllerAttachment['id'];
      readonly expectedDraftGeneration: number;
      readonly state: 'empty' | 'present';
    },
  ): Promise<B3Result<ControllerAttachment>>;
}

test('a reserved notification input commits once and replays the same Terminal attempt', async () => {
  const rig = createRig();
  try {
    const terminal = rig.terminal as NotificationTerminal;
    const session = unwrap(await openMockManagedSession(rig, RUN_ID), 'open managed session');
    const providerTurnId = mintProviderTurnId();
    const input = {
      terminalSessionId: session.id,
      agentRunId: RUN_ID,
      notificationId: NOTIFICATION_ID,
      effectKey: EFFECT_KEY,
      expectedActivityGeneration: 7 as ActivityGeneration,
      inputTextDigest: digest(SUMMARY),
      providerTurnId,
    };

    const reserved = unwrap(
      await terminal.reserveNotificationInput(runtimeContext(), input), 'reserve notification input',
    );
    assert.equal(reserved.id, reservationId());
    assert.equal(reserved.state, 'reserved');

    const committed = unwrap(await terminal.commitReservedNotificationInput(runtimeContext(), {
      notificationInputReservationId: reserved.id,
      effectKey: EFFECT_KEY,
      utf8Text: `${SUMMARY}\r`,
    }), 'commit notification input');
    const replay = unwrap(await terminal.commitReservedNotificationInput(runtimeContext(), {
      notificationInputReservationId: reserved.id,
      effectKey: EFFECT_KEY,
      utf8Text: `${SUMMARY}\r`,
    }), 'replay notification input');

    assert.equal(committed.reservation.state, 'committed');
    assert.equal(committed.attempt.source, 'system-notification');
    assert.equal(committed.attempt.providerTurnId, providerTurnId);
    assert.equal(replay.attempt.id, committed.attempt.id);
    assert.deepEqual(rig.ptyHost.latest().written, [SUMMARY, '\r'],
      'replay typed the reserved provider turn twice');
    assert.equal(
      unwrap(await terminal.getNotificationInputReservation(
        humanContext().principal, reserved.id,
      ), 'read reservation').state,
      'committed',
    );
    assert.equal(
      unwrap(await terminal.getTerminalInputAttempt(
        humanContext().principal, committed.attempt.id,
      ), 'read attempt').id,
      committed.attempt.id,
    );
  } finally {
    await rig.dispose();
  }
});

test('controller drafts and notification reservations fence each other', async () => {
  const rig = createRig();
  try {
    const terminal = rig.terminal as NotificationTerminal;
    const session = unwrap(await openMockManagedSession(rig, RUN_ID), 'open managed session');
    const controller = unwrap(await terminal.attachController(humanContext(), {
      terminalSessionId: session.id,
      controllerKind: 'novakai-shell',
      columns: 100,
      rows: 30,
    }), 'attach controller');
    assert.equal(controller.draftState, 'empty');
    assert.equal(controller.draftGeneration, 0);

    const drafting = unwrap(await terminal.setControllerDraftState(humanContext(), {
      attachmentId: controller.id,
      expectedDraftGeneration: 0,
      state: 'present',
    }), 'mark draft present');
    const reserve = () => terminal.reserveNotificationInput(runtimeContext(), {
      terminalSessionId: session.id,
      agentRunId: RUN_ID,
      notificationId: NOTIFICATION_ID,
      effectKey: EFFECT_KEY,
      expectedActivityGeneration: 7 as ActivityGeneration,
      inputTextDigest: digest(SUMMARY),
      providerTurnId: mintProviderTurnId(),
    });
    assert.equal(expectError(await reserve(), 'reserve through draft').code, 'InputLeaseBusy');

    const cleared = unwrap(await terminal.setControllerDraftState(humanContext(), {
      attachmentId: controller.id,
      expectedDraftGeneration: drafting.draftGeneration,
      state: 'empty',
    }), 'clear draft');
    const reserved = unwrap(await reserve(), 'reserve after draft clears');

    const fencedDraft = await terminal.setControllerDraftState(humanContext(), {
      attachmentId: controller.id,
      expectedDraftGeneration: cleared.draftGeneration,
      state: 'present',
    });
    assert.equal(expectError(fencedDraft, 'draft through reservation').code, 'InputLeaseBusy');

    const lease = await terminal.acquireInputLease(humanContext(), {
      terminalSessionId: session.id,
      attachmentId: controller.id,
      mode: 'acquire-if-free',
      ttlMs: 30_000,
    });
    assert.equal(expectError(lease, 'lease through reservation').code, 'InputLeaseBusy');
    assert.equal(reserved.id, reservationId());
  } finally {
    await rig.dispose();
  }
});
