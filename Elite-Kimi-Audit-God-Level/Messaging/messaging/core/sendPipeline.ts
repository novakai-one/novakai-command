/**
 * sendPipeline — the door for SendMessage (MSG-021: parse from `unknown`;
 * DEC-13/A5 idempotency; DEC-09/20 commit-before-effect; DEC-21 settle marker).
 *
 * Choreography (W2):
 *   1. Parse the command input from `unknown` (core/validate.ts) — a caller-
 *      supplied `from`/`senderId` fails here (additionalProperties: false;
 *      MSG-020).
 *   2. Compute the A5 requestHash.
 *   3. Idempotency pre-check (read-only): an existing acceptance with the
 *      same hash short-circuits to the ORIGINAL acceptance (incl. persisted
 *      urgentDowngraded, §11.3) WITHOUT re-running policy — a retry must
 *      never be re-judged by policy that changed since acceptance (DEC-13).
 *      A different hash is IdempotencyConflict (A5). The store's atomic
 *      reservation inside commitAcceptance remains the race-safe authority;
 *      this pre-check is a read, never a write mechanism (DEC-18 intact).
 *   4. decideSend — THE single decision point.
 *   5. commitAcceptance — one atomic op (DEC-20). accepted | duplicate (race)
 *      | conflict (race) | failed (nothing committed → safe to retry).
 *   6. On acceptance: hand the deliveries to the orchestrator (R5 first
 *      attempt decision), then markEffectsSettled (DEC-21). Post-commit
 *      effect failures never fail the command — the acceptance is durable
 *      (DEC-09) and the recovery sweep (S1-c) re-drives anything left pending.
 *
 * Latency note (L5, documented decision): SendMessage's latency includes the
 * FULL effect leg (step 6) — the client awaits the first attempt decision
 * against the transport, so a hung transport blocks SendAccepted up to the
 * adapter's bounded effect deadline (v1 default 5 s, §4.3). This is
 * deliberate: commit-before-effect (DEC-09/20) makes the acceptance durable
 * FIRST, so the wait never risks the message; the alternative (respond before
 * effects) was not chosen in v1. The DEC-21 sweep bounds recovery.
 *
 * Fault injection (F4, TEST-ONLY): `effectLegDelayMs` inserts a deterministic
 * delay between the durable commit (step 5) and the effect leg (step 6),
 * holding the commit→settle window open so the W2 process-level proof can
 * land a SIGKILL inside it on EVERY run. Composition roots default it to
 * undefined (no delay); it exists for the crash-retry harness, never for
 * production configuration.
 */

import { MessagingError } from "../public/contract/index.js";
import type { MessageId, ThreadId } from "../public/contract/index.js";
import type { SendAccepted } from "../public/contract/index.js";
import type { Principal } from "../seams/authority.js";
import type { MessagingStore } from "../seams/store.js";
import type { ClockIds } from "../seams/clock.js";
import type { ProvisioningDirectory } from "../seams/authority.js";
import { decideSend } from "./decideSend.js";
import type { DeliveryOrchestrator } from "./deliveryOrchestrator.js";
import { hashSendRequest } from "./requestHash.js";
import { parseSendMessageInput } from "./validate.js";
import { storeDependencyError } from "./storeErrors.js";

export type SendOutcome =
  | { kind: "accepted"; result: SendAccepted }
  | { kind: "rejected"; error: MessagingError };

export interface SendPipelineDeps {
  store: MessagingStore;
  clock: ClockIds;
  provisioning: ProvisioningDirectory;
  orchestrator: DeliveryOrchestrator;
  /** TEST-ONLY fault injection (F4): delay the commit→settle window. See header. */
  effectLegDelayMs?: number;
}

function duplicateResult(
  messageId: MessageId,
  threadId: ThreadId,
  sequence: SendAccepted["sequence"],
  urgentDowngraded: boolean | undefined,
): SendAccepted {
  return {
    messageId,
    threadId,
    sequence,
    duplicate: true,
    ...(urgentDowngraded !== undefined ? { urgentDowngraded } : {}),
  };
}

export function createSendPipeline(deps: SendPipelineDeps) {
  const { store, clock, provisioning, orchestrator } = deps;

  return async function sendMessage(principal: Principal, input: unknown): Promise<SendOutcome> {
    // 1. The door: parse from unknown (MSG-021).
    const parsed = parseSendMessageInput(input);
    if (!parsed.ok) return { kind: "rejected", error: parsed.error };
    const command = parsed.value;
    const requestHash = hashSendRequest(command);

    // 3. Idempotency pre-check (read-only; the store's reservation stays authoritative).
    const prior = await store.findAcceptance(principal.personId, command.clientMessageId);
    if (prior.kind === "error" && prior.error.name !== "RecordNotFound") {
      return { kind: "rejected", error: storeDependencyError(prior.error) };
    }
    if (prior.kind === "ok") {
      if (prior.value.requestHash === requestHash) {
        return {
          kind: "accepted",
          result: duplicateResult(
            prior.value.messageId,
            prior.value.threadId,
            prior.value.sequence,
            prior.value.urgentDowngraded,
          ),
        };
      }
      return {
        kind: "rejected",
        error: new MessagingError("IdempotencyConflict", {
          message: `clientMessageId ${JSON.stringify(command.clientMessageId)} reused with different content (A5)`,
          retryable: false,
          fields: {
            clientMessageId: command.clientMessageId,
            originalMessageId: prior.value.messageId,
          },
        }),
      };
    }

    // 4. THE single decision point.
    const decision = await decideSend(
      { store, clock, provisioning },
      principal,
      command,
      requestHash,
      command.clientMessageId,
    );
    if (decision.kind === "reject") return { kind: "rejected", error: decision.error };

    // 5. The atomic acceptance transaction (DEC-20).
    const outcome = await store.commitAcceptance(decision.input);
    switch (outcome.kind) {
      case "duplicate":
        // Lost a same-key race between pre-check and commit — the original stands.
        return {
          kind: "accepted",
          result: duplicateResult(
            outcome.original.messageId,
            outcome.original.threadId,
            outcome.original.sequence,
            outcome.original.urgentDowngraded,
          ),
        };
      case "conflict":
        return {
          kind: "rejected",
          error: new MessagingError("IdempotencyConflict", {
            message: `clientMessageId ${JSON.stringify(command.clientMessageId)} reused with different content (A5)`,
            retryable: false,
            fields: {
              clientMessageId: outcome.error.clientMessageId,
              originalMessageId: outcome.error.originalMessageId,
            },
          }),
        };
      case "failed": {
        // F9: RecordNotFound is context-dependent (Store-Seam §6), NOT a
        // dependency failure — storeDependencyError throws on it by design.
        // On the send path a missing record is the room Thread the command
        // named (rooms land in S2; the store requires the thread to
        // pre-exist), so the honest typed outcome is SendMessage's own
        // UnknownThread — never a thrown core bug at the door.
        if (outcome.error.name === "RecordNotFound") {
          return {
            kind: "rejected",
            error: new MessagingError("UnknownThread", {
              message: `no such Thread: ${outcome.error.id}`,
              retryable: false,
              fields: { threadId: outcome.error.id },
            }),
          };
        }
        return { kind: "rejected", error: storeDependencyError(outcome.error) };
      }
      case "accepted":
        break;
    }

    // 6. Effects: the acceptance is durable from here (DEC-09) — failures in
    // this leg never fail the command; the DEC-21 sweep re-drives.
    const committedMessage = {
      ...decision.message,
      threadId: outcome.threadId,
      sequence: outcome.sequence,
    };
    if (deps.effectLegDelayMs !== undefined && deps.effectLegDelayMs > 0) {
      // TEST-ONLY fault injection (F4): hold the commit→settle window open so
      // the W2 SIGKILL proof lands inside it deterministically.
      await new Promise((resolve) => setTimeout(resolve, deps.effectLegDelayMs));
    }
    try {
      await orchestrator.onAcceptance(
        committedMessage,
        decision.deliveries,
        outcome.urgentDowngraded ?? false,
      );
      await store.markEffectsSettled(outcome.messageId);
    } catch {
      // Swallowed deliberately: effectsPending stays true → the recovery
      // sweep (S1-c) re-drives. SendAccepted is the honest outcome (MSG-019).
    }

    return {
      kind: "accepted",
      result: {
        messageId: outcome.messageId,
        threadId: outcome.threadId,
        sequence: outcome.sequence,
        ...(outcome.urgentDowngraded !== undefined
          ? { urgentDowngraded: outcome.urgentDowngraded }
          : {}),
      },
    };
  };
}

export type SendPipeline = ReturnType<typeof createSendPipeline>;
