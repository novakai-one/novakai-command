/**
 * Shared harness for core tests. Core tests cross the SAME seam as consumers
 * (project law): they import only messaging/public and drive the embedded
 * composition root. Determinism comes from clock-seeded + store-memory +
 * presence-transport-memory + a manual retry scheduler.
 */

import {
  createEmbeddedMessaging,
  createMemoryPresenceTransport,
  createSeededClock,
  DEFAULT_ROLE_GRANTS,
} from "../../contract/index.js";
import type {
  ConfigAuthority,
  EmbeddedMessaging,
  EmbeddedMessagingOptions,
  MemoryPresenceTransport,
  MessagingError,
  MessagingSession,
  Outcome,
  PersonId,
  RetryPolicy,
  Scheduler,
  SeededClock,
} from "../../contract/index.js";

export const ALICE = "person_alice" as PersonId;
export const BOB = "person_bob" as PersonId;
export const CHIEF = "person_chief" as PersonId;
export const ADMIN = "person_admin" as PersonId;
/** Never provisioned in the harness config — the UnknownRecipient target. */
export const STRANGER = "person_stranger" as PersonId;

export const TEST_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
};

/** Deterministic scheduler: retries run only when the test says so. */
export class ManualScheduler implements Scheduler {
  private tasks: (() => void)[] = [];

  schedule(_delayMs: number, task: () => void): () => void {
    this.tasks.push(task);
    return () => {
      // L7: cancellation removes the parked task (end/settle cleanup).
      const index = this.tasks.indexOf(task);
      if (index >= 0) this.tasks.splice(index, 1);
    };
  }

  get pending(): number {
    return this.tasks.length;
  }

  /** Run queued retries, flushing microtasks so async attempt chains settle. */
  async runAll(): Promise<void> {
    while (this.tasks.length > 0) {
      const task = this.tasks.shift();
      task?.();
      await flushMicrotasks();
    }
  }
}

/** The in-memory seams resolve in microtasks; flush enough ticks for full chains. */
export async function flushMicrotasks(rounds = 200): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

export interface Harness {
  cap: EmbeddedMessaging;
  clock: SeededClock;
  transport: MemoryPresenceTransport;
  scheduler: ManualScheduler;
  authority: ConfigAuthority;
}

export function makeHarness(overrides?: Partial<EmbeddedMessagingOptions>): Harness {
  const clock = createSeededClock({ seed: "core" });
  const transport = createMemoryPresenceTransport({ kind: "ws" });
  const scheduler = new ManualScheduler();
  const cap = createEmbeddedMessaging({
    clock,
    transports: [transport],
    scheduler,
    retryPolicy: TEST_RETRY_POLICY,
    ...overrides,
    authority: {
      principals: [
        { token: "tok-alice", personId: ALICE, roles: ["Worker"] },
        { token: "tok-bob", personId: BOB, roles: ["Worker"] },
        { token: "tok-chief", personId: CHIEF, roles: ["Chief"] },
        { token: "tok-admin", personId: ADMIN, grants: ["policy.admin"] },
      ],
      roleGrants: DEFAULT_ROLE_GRANTS,
    },
  });
  return { cap, clock, transport, scheduler, authority: cap.authority as ConfigAuthority };
}

export async function sessionFor(cap: EmbeddedMessaging, token: string): Promise<MessagingSession> {
  const auth = await cap.authenticate({ token });
  if (auth.kind !== "authenticated") {
    throw new Error(`authenticate failed: ${auth.kind} ${auth.error.message}`);
  }
  return auth.session;
}

export function unwrap<T>(outcome: Outcome<T>): T {
  if (outcome.kind !== "ok") {
    throw new Error(`expected ok, got ${outcome.error.name}: ${outcome.error.message}`);
  }
  return outcome.value;
}

export function expectError<T>(outcome: Outcome<T>): MessagingError {
  if (outcome.kind !== "error") {
    throw new Error(`expected error, got ok: ${JSON.stringify(outcome.value)}`);
  }
  return outcome.error;
}

export function sendInput(
  address: string,
  text: string,
  clientMessageId: string,
  priority: "normal" | "urgent" = "normal",
): Record<string, unknown> {
  return { address, body: { text }, priority, clientMessageId };
}

/** Convenience: the recipient allowlists the sender (first contact is deliberate, DEC-14). */
export async function allowlist(recipientSession: MessagingSession, senderId: PersonId): Promise<void> {
  unwrap(
    await recipientSession.setContactPolicy({ allowlist: [senderId], defaultRule: "deny" }),
  );
}
