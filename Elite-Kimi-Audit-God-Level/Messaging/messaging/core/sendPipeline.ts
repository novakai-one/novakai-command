/**
 * sendPipeline — the door for SendMessage AND SendFromTemplate (MSG-021:
 * parse from `unknown`; DEC-13/A5 idempotency; DEC-09/20 commit-before-effect;
 * DEC-21 settle marker). Both send commands share ONE executor — the
 * choreography exists exactly once; the doors differ only in how they parse,
 * hash (A5 request content), and PREPARE the decided send.
 *
 * Choreography (W2):
 *   1. Parse the command input from `unknown` (core/validate.ts) — a caller-
 *      supplied `from`/`senderId` fails here (additionalProperties: false;
 *      MSG-020).
 *   2. Compute the A5 requestHash (address/body/priority for SendMessage;
 *      address/templateId/fields/priority for SendFromTemplate).
 *   3. Idempotency pre-check (read-only): an existing acceptance with the
 *      same hash short-circuits to the ORIGINAL acceptance (incl. persisted
 *      urgentDowngraded, §11.3) WITHOUT re-running policy — a retry must
 *      never be re-judged by policy that changed since acceptance (DEC-13).
 *      For template sends this also means the retry never re-loads the
 *      template: a revised or retired template cannot turn a same-content
 *      retry into TemplateNotFound. A different hash is IdempotencyConflict
 *      (A5). The store's atomic reservation inside commitAcceptance remains
 *      the race-safe authority; this pre-check is a read, never a write
 *      mechanism (DEC-18 intact).
 *   4. PREPARE — SendMessage: the parsed command itself. SendFromTemplate:
 *      load the template (unknown/retired → TemplateNotFound, I10), match the
 *      supplied fields to the declared bindings (DEC-15 →
 *      TemplateFieldMismatch), render into the R12-allowlisted Message paths,
 *      and re-validate the rendered message through the SAME door parser as
 *      SendMessage (core/templates.ts).
 *   5. decideSend — THE single decision point (the TemplateRef is stamped
 *      onto the Message verbatim; there is no template-specific policy).
 *   6. commitAcceptance — one atomic op (DEC-20). accepted | duplicate (race)
 *      | conflict (race) | failed (nothing committed → safe to retry).
 *   7. On acceptance: hand the deliveries to the orchestrator (R5 first
 *      attempt decision), then markEffectsSettled (DEC-21). Post-commit
 *      effect failures never fail the command — the acceptance is durable
 *      (DEC-09) and the recovery sweep (S1-c) re-drives anything left pending.
 *
 * Latency note (L5, documented decision): both sends' latency includes the
 * FULL effect leg (step 7) — the client awaits the first attempt decision
 * against the transport, so a hung transport blocks SendAccepted up to the
 * adapter's bounded effect deadline (v1 default 5 s, §4.3). This is
 * deliberate: commit-before-effect (DEC-09/20) makes the acceptance durable
 * FIRST, so the wait never risks the message; the alternative (respond before
 * effects) was not chosen in v1. The DEC-21 sweep bounds recovery.
 *
 * Fault injection (F4, TEST-ONLY): `effectLegDelayMs` inserts a deterministic
 * delay between the durable commit (step 6) and the effect leg (step 7),
 * holding the commit→settle window open so the W2 process-level proof can
 * land a SIGKILL inside it on EVERY run. Composition roots default it to
 * undefined (no delay); it exists for the crash-retry harness, never for
 * production configuration.
 */

import { MessagingError } from "../public/contract/index.js";
import type { MessageId, ThreadId } from "../public/contract/index.js";
import type {
  ClientMessageId,
  RequestHash,
  SendAccepted,
  SendMessageInput,
  TemplateRef,
} from "../public/contract/index.js";
import type { Principal } from "../seams/authority.js";
import type { MembershipSource } from "../seams/membership.js";
import type { MessagingStore } from "../seams/store.js";
import type { ClockIds } from "../seams/clock.js";
import type { ProvisioningDirectory } from "../seams/authority.js";
import { decideSend } from "./decideSend.js";
import type { DeliveryOrchestrator } from "./deliveryOrchestrator.js";
import { hashSendFromTemplateRequest, hashSendRequest } from "./requestHash.js";
import { parseSendFromTemplateInput, parseSendMessageInput } from "./validate.js";
import { renderTemplateSend } from "./templates.js";
import { storeDependencyError } from "./storeErrors.js";

export type SendOutcome =
  | { kind: "accepted"; result: SendAccepted }
  | { kind: "rejected"; error: MessagingError };

export interface SendPipelineDeps {
  store: MessagingStore;
  clock: ClockIds;
  provisioning: ProvisioningDirectory;
  membership: MembershipSource;
  orchestrator: DeliveryOrchestrator;
  /** TEST-ONLY fault injection (F4): delay the commit→settle window. See header. */
  effectLegDelayMs?: number;
}

/**
 * What a door hands the shared executor: the SendMessageInput decideSend
 * consumes, plus the TemplateRef to stamp (SendFromTemplate only, DEC-15).
 */
interface PreparedSend {
  command: SendMessageInput;
  templateRef?: TemplateRef;
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

/** Steps 3–7 of the header choreography — the ONE send executor. */
async function executeSend(
  deps: SendPipelineDeps,
  principal: Principal,
  requestHash: RequestHash,
  clientMessageId: ClientMessageId,
  prepare: () => Promise<PreparedSend | MessagingError>,
): Promise<SendOutcome> {
  const { store, clock, provisioning, membership, orchestrator } = deps;

  // 3. Idempotency pre-check (read-only; the store's reservation stays authoritative).
  const prior = await store.findAcceptance(principal.personId, clientMessageId);
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
        message: `clientMessageId ${JSON.stringify(clientMessageId)} reused with different content (A5)`,
        retryable: false,
        fields: {
          clientMessageId,
          originalMessageId: prior.value.messageId,
        },
      }),
    };
  }

  // 4. Prepare — runs ONLY after the pre-check misses (DEC-13: a retry never
  // re-loads a template, never re-runs policy).
  const prepared = await prepare();
  if (prepared instanceof MessagingError) return { kind: "rejected", error: prepared };

  // 5. THE single decision point.
  const decision = await decideSend(
    { store, clock, provisioning, membership },
    principal,
    prepared.command,
    requestHash,
    clientMessageId,
    prepared.templateRef,
  );
  if (decision.kind === "reject") return { kind: "rejected", error: decision.error };

  // 6. The atomic acceptance transaction (DEC-20).
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
          message: `clientMessageId ${JSON.stringify(clientMessageId)} reused with different content (A5)`,
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
      // named (the store requires room Threads to pre-exist, §2.1/§11.4),
      // so the honest typed outcome is SendMessage's own UnknownThread —
      // never a thrown core bug at the door.
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

  // 7. Effects: the acceptance is durable from here (DEC-09) — failures in
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
    // R4 needs nothing here: room-send blocked recipients committed
    // terminal failed{blocked-by-contact-policy} INSIDE commitAcceptance
    // (Store-Seam §11.7) — the orchestrator's current-state re-read skips
    // them, and no commit→settle window can ever expose them as pending.
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
}

export function createSendPipeline(deps: SendPipelineDeps) {
  return async function sendMessage(principal: Principal, input: unknown): Promise<SendOutcome> {
    // 1. The door: parse from unknown (MSG-021).
    const parsed = parseSendMessageInput(input);
    if (!parsed.ok) return { kind: "rejected", error: parsed.error };
    const command = parsed.value;
    // 2. The A5 requestHash.
    return executeSend(
      deps,
      principal,
      hashSendRequest(command),
      command.clientMessageId,
      () => Promise.resolve({ command }),
    );
  };
}

export type SendPipeline = ReturnType<typeof createSendPipeline>;

/**
 * The SendFromTemplate door (S4, DEC-15, R12, I10). Same executor, same
 * idempotency, same decision point — the door-specific work is the template
 * load + render in prepare (core/templates.ts), which runs only after the
 * idempotency pre-check misses.
 */
export function createSendFromTemplatePipeline(deps: SendPipelineDeps) {
  return async function sendFromTemplate(principal: Principal, input: unknown): Promise<SendOutcome> {
    const parsed = parseSendFromTemplateInput(input);
    if (!parsed.ok) return { kind: "rejected", error: parsed.error };
    const command = parsed.value;
    return executeSend(
      deps,
      principal,
      hashSendFromTemplateRequest(command),
      command.clientMessageId,
      async () => {
        const rendered = await renderTemplateSend(deps.store, command);
        if (rendered instanceof MessagingError) return rendered;
        return rendered;
      },
    );
  };
}

export type SendFromTemplatePipeline = ReturnType<typeof createSendFromTemplatePipeline>;
