/**
 * Policy commands — SetDndPolicy / SetContactPolicy (DEC-14, O3).
 *
 * Authorization (contract): self, or policy.admin. Policy writes are
 * single-record optimistic-concurrency puts (Store-Seam §5); RevisionConflict
 * is a normal concurrency outcome — the core re-reads and re-decides (bounded),
 * never surfaces it (Schemas §8).
 *
 * R5 DND release: a successful SetDndPolicy(enabled=false) releases every held
 * Delivery for that Person back to pending via the orchestrator
 * (held → pending, dnd-released) — normal attempts resume. The release runs
 * AFTER the policy write is durable.
 */

import { schemaVersion } from "../contract/schemas.js";
import { MessagingError } from "../contract/schemas.js";
import type { ContactPolicy, DndPolicy, PersonId } from "../contract/schemas.js";
import type {
  PolicyUpdated,
  SetContactPolicyInput,
  SetDndPolicyInput,
} from "../contract/schemas.js";
import type { Principal } from "../contract/ports/authority.js";
import type { MessagingStore } from "../contract/ports/store.js";
import type { ClockIds } from "../contract/ports/clock.js";
import type { DeliveryOrchestrator } from "./deliveryOrchestrator.js";
import { storeDependencyError } from "./storeErrors.js";

export interface PolicyCommandsDeps {
  store: MessagingStore;
  clock: ClockIds;
  orchestrator: DeliveryOrchestrator;
}

/** Bounded re-decide loop for RevisionConflict (Store-Seam §6 core handling). */
const MAX_REVISION_RETRIES = 3;

function notAdmin(): MessagingError {
  return new MessagingError("NotAuthorized", {
    message: "setting another Person's policy requires policy.admin",
    retryable: false,
    fields: { requiredGrant: "policy.admin" },
  });
}

function targetPerson(principal: Principal, personId: PersonId | undefined): PersonId | MessagingError {
  const target = personId ?? principal.personId;
  if (target !== principal.personId && !principal.grants.includes("policy.admin")) {
    return notAdmin();
  }
  return target;
}

export function createPolicyCommands(deps: PolicyCommandsDeps) {
  const { store, clock, orchestrator } = deps;

  async function setDndPolicy(
    principal: Principal,
    input: SetDndPolicyInput,
  ): Promise<PolicyUpdated> {
    const target = targetPerson(principal, input.personId);
    if (target instanceof MessagingError) throw target;

    for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
      const existing = await store.getPolicy(target);
      if (existing.kind === "error" && existing.error.name !== "RecordNotFound") {
        throw storeDependencyError(existing.error);
      }
      const prior = existing.kind === "ok" ? existing.value.dnd : undefined;
      const policy: DndPolicy = {
        id: prior?.id ?? clock.newId("dndpolicy"),
        kind: "dnd-policy",
        schemaVersion,
        createdAt: prior?.createdAt ?? clock.now(),
        personId: target,
        enabled: input.enabled,
        revision: (prior?.revision ?? 0) + 1,
      };
      const written = await store.putPolicy(target, policy, prior?.revision);
      if (written.kind === "ok") {
        if (!input.enabled) {
          // R5 dnd-released: release every held Delivery for this Person.
          await orchestrator.onDndReleased(target);
        }
        return { revision: written.value.revision };
      }
      if (written.error.name === "RevisionConflict") continue; // re-read and re-decide
      throw storeDependencyError(written.error);
    }
    throw storeDependencyError({
      name: "StoreUnavailable",
      message: "policy write kept conflicting after bounded retries",
      retryable: true,
    });
  }

  async function setContactPolicy(
    principal: Principal,
    input: SetContactPolicyInput,
  ): Promise<PolicyUpdated> {
    const target = targetPerson(principal, input.personId);
    if (target instanceof MessagingError) throw target;

    for (let attempt = 0; attempt < MAX_REVISION_RETRIES; attempt += 1) {
      const existing = await store.getPolicy(target);
      if (existing.kind === "error" && existing.error.name !== "RecordNotFound") {
        throw storeDependencyError(existing.error);
      }
      const prior = existing.kind === "ok" ? existing.value.contact : undefined;
      const policy: ContactPolicy = {
        id: prior?.id ?? clock.newId("contactpolicy"),
        kind: "contact-policy",
        schemaVersion,
        createdAt: prior?.createdAt ?? clock.now(),
        personId: target,
        allowlist: input.allowlist,
        defaultRule: input.defaultRule,
        revision: (prior?.revision ?? 0) + 1,
      };
      const written = await store.putPolicy(target, policy, prior?.revision);
      if (written.kind === "ok") {
        return { revision: written.value.revision };
      }
      if (written.error.name === "RevisionConflict") continue;
      throw storeDependencyError(written.error);
    }
    throw storeDependencyError({
      name: "StoreUnavailable",
      message: "policy write kept conflicting after bounded retries",
      retryable: true,
    });
  }

  return { setDndPolicy, setContactPolicy };
}

export type PolicyCommands = ReturnType<typeof createPolicyCommands>;
