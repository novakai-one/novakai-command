// What a Notification delivery pass says about why it stopped.
//
// Every pre-reserve branch of the worker used to return `null`, and the pump
// published all of them as one reason: `not-deliverable-yet`. A live run held
// that reason for 90 seconds straight while every durable precondition anyone
// could name was true — the turn completion-committed, the lease free, the
// session durable-live, the Run ready/idle with its generation past the fence,
// the controller draft empty, no other reservation held, the notification
// unfenced. The block was real and, by construction, unnameable: the reason
// described the pump's decision instead of the predicate that failed, so
// diagnosing it cost a whole run and still ended in a suspect list.
//
// This module is the closed set of things a pass may say, and the two readings
// that turn a shared error code back into a cause.
import type {
  ActivityGeneration, AgentRunId, AuthenticatedPrincipal, B3ContractError,
} from '@novakai/foundation/contract';
import type { AgentRunsContract } from '../../../agent-runtime/contract/index.js';
import type { TerminalContract } from '../../../terminal/contract/index.js';

/** One Notification, resolved to the Run and fence this pass will hold it to. */
export interface DeliveryTarget {
  readonly agentRunId: AgentRunId;
  readonly effectKey: string;
  readonly claimGeneration: ActivityGeneration;
  readonly inputText: string;
}

/** Exactly what `getAgentRun` reports, without importing the Runs record shape. */
export type RunTruth = Awaited<ReturnType<AgentRunsContract['getAgentRun']>> extends infer Result
  ? Result extends { readonly ok: true; readonly value: infer Value }
    ? Value extends { readonly run: infer Run } ? Run : never
    : never
  : never;

/**
 * Why one pass did not move one Notification — a cause, never a bucket.
 *
 * The last two rows are the pump's own scheduling reasons rather than the
 * worker's; they live here so the closed set is readable in one place.
 */
export type NotificationDeliveryReason =
  | 'notification-is-queue-only'
  | 'run-lifecycle-not-ready'
  | 'run-activity-not-idle'
  | 'run-has-active-provider-turn'
  | 'run-has-no-terminal-session'
  | 'run-generation-not-past-delivery-fence'
  | 'terminal-session-not-live'
  | 'terminal-input-lease-held'
  | 'terminal-live-registry-missing-while-durable-session-live'
  | 'terminal-live-registry-holds-a-turn-the-durable-store-does-not'
  | 'run-already-delivered-this-pass'
  | 'awaiting-transcript-observation';

/** One typed sub-reason plus the in-memory facts that produced it. */
export interface NotificationDeliveryDiagnosis {
  readonly reason: NotificationDeliveryReason;
  /**
   * What this pass actually observed at the moment it stopped, as strings.
   *
   * Strings because this travels to a durable event whose consumers are
   * diagnostic readers, not typed clients: a branded id, a generation and a
   * lifecycle all read the same way once they are on the wire, and a snapshot
   * needing a schema per branch is one nobody would keep current.
   */
  readonly snapshot: Readonly<Record<string, string>>;
}

/** What one bounded delivery attempt did. */
export type NotificationDeliveryOutcome =
  | { readonly kind: 'delivered' }
  | {
      readonly kind: 'refused';
      readonly code: string;
      /** Present only where the code alone names a symptom and not its cause. */
      readonly diagnosis?: NotificationDeliveryDiagnosis;
    }
  | { readonly kind: 'skipped'; readonly diagnosis: NotificationDeliveryDiagnosis };

export const DELIVERED: NotificationDeliveryOutcome = { kind: 'delivered' };

export const NO_TERMINAL_SESSION: NotificationDeliveryDiagnosis = {
  reason: 'run-has-no-terminal-session', snapshot: { terminalSessionId: 'none' },
};

export function skip(
  reason: NotificationDeliveryReason, snapshot: Readonly<Record<string, string>>,
): NotificationDeliveryOutcome {
  return { kind: 'skipped', diagnosis: { reason, snapshot } };
}

export function refuse(
  code: string, diagnosis?: NotificationDeliveryDiagnosis,
): NotificationDeliveryOutcome {
  return { kind: 'refused', code, ...(diagnosis === undefined ? {} : { diagnosis }) };
}

/** `''` is this codebase's "committed"; anything else is the refusal's code. */
export function fromCode(code: string): NotificationDeliveryOutcome {
  return code === '' ? DELIVERED : { kind: 'refused', code };
}

/**
 * Which of the five "this Run can carry next-turn context" predicates failed,
 * or `null` when none did.
 *
 * The order is the order the conjunction it replaces evaluated in, so exactly
 * the same Runs are blocked as before — the only difference is that the one
 * that failed now says so, and says with which values.
 */
export function runContextBlock(
  runTruth: RunTruth, target: DeliveryTarget,
): NotificationDeliveryDiagnosis | null {
  if (runTruth.lifecycle !== 'ready') {
    return { reason: 'run-lifecycle-not-ready', snapshot: { lifecycle: String(runTruth.lifecycle) } };
  }
  if (runTruth.activity !== 'idle') {
    return { reason: 'run-activity-not-idle', snapshot: { activity: String(runTruth.activity) } };
  }
  if (runTruth.activeProviderTurn !== undefined) {
    return {
      reason: 'run-has-active-provider-turn',
      snapshot: {
        activeProviderTurnId: String(runTruth.activeProviderTurn.providerTurnId),
        activeTurnActivityGeneration: String(runTruth.activeProviderTurn.activityGeneration),
      },
    };
  }
  if (runTruth.terminalSessionId === undefined) return NO_TERMINAL_SESSION;
  if (!(Number(runTruth.activityGeneration) > Number(target.claimGeneration))) {
    return {
      reason: 'run-generation-not-past-delivery-fence',
      snapshot: {
        runActivityGeneration: String(runTruth.activityGeneration),
        deliveryFenceGeneration: String(target.claimGeneration),
        comparison: 'run generation must be strictly greater than the delivery fence',
      },
    };
  }
  return null;
}

/**
 * What the Terminal input boundary says about this session, or `null` when it
 * says nothing — the two conditions a reservation may not be attempted under.
 */
export async function inputBoundaryBlock(
  terminal: TerminalContract,
  reader: AuthenticatedPrincipal,
  terminalSessionId: NonNullable<RunTruth['terminalSessionId']>,
): Promise<NotificationDeliveryOutcome | null> {
  const view = await terminal.getTerminalSession(reader, terminalSessionId);
  if (!view.ok) return refuse(view.error.code);
  if (view.value.session.status !== 'live') {
    return skip('terminal-session-not-live', {
      terminalSessionId: String(terminalSessionId),
      terminalSessionStatus: String(view.value.session.status),
    });
  }
  const lease = view.value.activeInputLease;
  return lease === undefined ? null : skip('terminal-input-lease-held', {
    terminalSessionId: String(terminalSessionId),
    leaseId: String(lease.id),
    leaseGeneration: String(lease.generation),
    leaseState: String(lease.state),
    holderAttachmentId: String(lease.attachmentId),
  });
}

/**
 * The two reserve refusals that mean Terminal's in-memory registry and its own
 * durable records disagree about the same session.
 *
 * Both are decided INSIDE `reserveNotificationInput`, after checks the worker
 * cannot see, so their codes alone name a symptom that several innocent causes
 * share. What makes the split nameable from out here is the order those checks
 * run in (`packages/terminal/core/notification-input.ts`):
 *
 *   - `TerminalNotLive` is reached only after `requireLiveSession` passed, so
 *     the durable session said `live` and the live-process registry had no
 *     entry for it. The worker independently read the same durable `live` a
 *     moment earlier, so the split is observed twice, not inferred once.
 *   - `provider-turn-active` is reached only after the DURABLE active-attempt
 *     lookup returned nothing, so the durable store holds no non-terminal
 *     provider-turn attempt for this session while the live process believes
 *     one is running. A durable attempt for that same turn carrying a
 *     completion-committed barrier is exactly that shape — a completed attempt
 *     is terminal, so the durable side stops counting it while the registry
 *     has not let go. The Run agrees with the durable side: `runContextBlock`
 *     already required `activeProviderTurn === undefined` to get this far.
 *
 * The id the registry believes is active is not among the facts: no published
 * Terminal query exposes the live process's `activeTurn`, so the snapshot says
 * that rather than leaving a reader to wonder why it is missing.
 */
export function reserveSplit(
  error: B3ContractError, terminalSessionId: string,
): NotificationDeliveryDiagnosis | undefined {
  if (error.code === 'TerminalNotLive') {
    return {
      reason: 'terminal-live-registry-missing-while-durable-session-live',
      snapshot: { terminalSessionId, durableSessionStatus: 'live', inMemoryLiveEntry: 'absent' },
    };
  }
  const details = error.details as { readonly reason?: unknown } | undefined;
  if (error.code === 'InputLeaseBusy' && details?.reason === 'provider-turn-active') {
    return {
      reason: 'terminal-live-registry-holds-a-turn-the-durable-store-does-not',
      snapshot: {
        terminalSessionId,
        inMemoryActiveProviderTurn: 'present',
        durableActiveProviderTurnAttempt: 'none',
        runActiveProviderTurn: 'none',
        inMemoryProviderTurnId: 'not-exposed-by-any-published-terminal-query',
      },
    };
  }
  return undefined;
}
