// Reconcile a repeated Q7 command against Terminal and Supervision owner truth.
import {
  b3err, b3fail, b3ok, notificationInputReservationId,
  type AuthenticatedPrincipal, type B3Result, type TerminalInputAttemptId,
} from '@novakai/foundation/contract';
import type {
  NotificationDeliveryAuthorityFacts, NotificationDeliveryPort,
  NotificationTurnSubmission, StartNotificationTurnInput,
} from '../contract/notification-delivery.js';
import type { ProviderTurnSubmission } from '../contract/provider-turns.js';
import type { RunOperation } from '../contract/runs.js';
import type { RunsCore } from './runs-context.js';
import {
  getNotificationTurnSubmission, notificationOperationFor, semanticNotificationSubmission,
} from './notification-delivery-state.js';

type Submitted = Extract<
  NotificationTurnSubmission,
  { readonly state: 'submitted-confirmed' | 'submitted-unconfirmed' }
>;

export type DeliveryReplay =
  | { readonly kind: 'completed'; readonly outcome: Submitted }
  | {
      readonly kind: 'continue';
      readonly priorOperation: RunOperation | null;
      readonly ownerClaimed: boolean;
    };

const reader: AuthenticatedPrincipal = {
  id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [],
};

const isSubmitted = (value: NotificationTurnSubmission): value is Submitted =>
  value.state === 'submitted-confirmed' || value.state === 'submitted-unconfirmed';

function semanticOutcome(
  submission: ProviderTurnSubmission,
): { readonly outcome: Submitted; readonly terminalInputAttemptId: TerminalInputAttemptId } | null {
  const state = submission.state;
  if (state.kind === 'submitted-confirmed') {
    return {
      outcome: {
        state: 'submitted-confirmed', submittedAt: state.submittedAt,
        providerTurnId: submission.providerTurnId,
      },
      terminalInputAttemptId: state.terminalInputAttemptId,
    };
  }
  if (state.kind === 'submitted-unconfirmed') {
    return {
      outcome: {
        state: 'submitted-unconfirmed', submittedAt: state.submittedAt,
        providerTurnId: submission.providerTurnId,
      },
      terminalInputAttemptId: state.terminalInputAttemptId,
    };
  }
  if (state.kind !== 'completed') return null;
  return {
    outcome: {
      state: state.submissionDisposition,
      submittedAt: state.completedAt,
      providerTurnId: submission.providerTurnId,
    },
    terminalInputAttemptId: state.terminalInputAttemptId,
  };
}

/** Finish Supervision bookkeeping for an already-submitted AMD-002 turn. */
export async function recoverSemanticNotificationDelivery(
  core: RunsCore,
  notifications: NotificationDeliveryPort,
  authority: NotificationDeliveryAuthorityFacts,
  input: StartNotificationTurnInput,
): Promise<B3Result<Submitted | null>> {
  const found = await semanticNotificationSubmission(core, input.effectKey);
  if (!found.ok) return b3fail(found.error);
  if (found.value === null) return b3ok(null);
  const submission = found.value;
  if (submission.origin.kind !== 'runtime-effect'
    || submission.origin.sourceObjectRef !== input.notificationId) {
    return b3fail(b3err(
      'IdempotencyConflict', 'semantic delivery effect is bound to another Notification',
      {
        effectKey: input.effectKey,
        heldNotificationId: submission.origin.kind === 'runtime-effect'
          ? submission.origin.sourceObjectRef : null,
        requestedNotificationId: input.notificationId,
      },
      false,
    ));
  }
  const submitted = semanticOutcome(submission);
  if (submitted === null) return b3ok(null);
  const reservation = notificationInputReservationId(input.effectKey);
  const ownerState = await notifications.getDeliveryState(reader, {
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    notificationInputReservationId: reservation,
  });
  if (!ownerState.ok) return ownerState;
  if (ownerState.value.state === 'submitted-confirmed'
    || ownerState.value.state === 'submitted-unconfirmed') return b3ok(submitted.outcome);
  const claim = await notifications.claim({
    notificationId: input.notificationId,
    expectedNotificationRecordVersion: authority.notificationRecordVersion,
    expectedEffectKey: input.effectKey,
    notificationInputReservationId: reservation,
    expectedActivityGeneration: input.expectedActivityGeneration,
  });
  if (!claim.ok) return claim;
  const recorded = await notifications.recordSubmission({
    claim: claim.value,
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    notificationInputReservationId: reservation,
    terminalInputAttemptId: submitted.terminalInputAttemptId,
    outcome: submitted.outcome,
  });
  return recorded.ok ? b3ok(submitted.outcome) : recorded;
}

function validateBinding(
  operation: RunOperation, input: StartNotificationTurnInput,
): B3Result<null> {
  if (operation.notificationId === input.notificationId) return b3ok(null);
  return b3fail(b3err(
    'IdempotencyConflict', 'delivery effect is bound to another Notification',
    {
      effectKey: input.effectKey,
      heldNotificationId: operation.notificationId,
      requestedNotificationId: input.notificationId,
    }, false,
  ));
}

function isFullyRecorded(operation: RunOperation): boolean {
  return operation.state === 'completed'
    && operation.completedStages.some((stage) => stage.stage === 'supervision-delivery-recorded');
}

async function ownerHasClaim(
  notifications: NotificationDeliveryPort,
  operation: RunOperation,
  input: StartNotificationTurnInput,
): Promise<B3Result<boolean>> {
  const reservationId = operation.notificationInputReservationId;
  if (reservationId === undefined) return b3ok(false);
  const ownerState = await notifications.getDeliveryState(reader, {
    notificationId: input.notificationId,
    effectKey: input.effectKey,
    notificationInputReservationId: reservationId,
  });
  return ownerState.ok
    ? b3ok(ownerState.value.state !== 'queued')
    : ownerState;
}

export async function resolveDeliveryReplay(
  core: RunsCore,
  notifications: NotificationDeliveryPort,
  input: StartNotificationTurnInput,
): Promise<B3Result<DeliveryReplay>> {
  const found = await notificationOperationFor(core, input.effectKey);
  if (!found.ok) return found;
  const operation = found.value;
  if (operation === null) {
    return b3ok({ kind: 'continue', priorOperation: null, ownerClaimed: false });
  }
  const binding = validateBinding(operation, input);
  if (!binding.ok) return binding;
  const prior = await getNotificationTurnSubmission(core, input.effectKey);
  if (!prior.ok) return prior;
  if (isSubmitted(prior.value) && isFullyRecorded(operation)) {
    return b3ok({ kind: 'completed', outcome: prior.value });
  }
  if (prior.value.state === 'cancelled-not-submitted') {
    return b3fail(b3err(
      'IdempotencyConflict', 'the deterministic delivery reservation was cancelled',
      { effectKey: input.effectKey }, false,
    ));
  }
  const claimed = await ownerHasClaim(notifications, operation, input);
  if (!claimed.ok) return claimed;
  if (isSubmitted(prior.value) && !claimed.value) {
    return b3fail(b3err(
      'RecoveryRequired', 'Terminal submitted before Supervision recorded a claim',
      { notificationId: input.notificationId, effectKey: input.effectKey }, true,
    ));
  }
  return b3ok({ kind: 'continue', priorOperation: operation, ownerClaimed: claimed.value });
}
