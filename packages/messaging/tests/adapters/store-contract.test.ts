/**
 * Shared store adapter contract suite (P5): ONE suite, run against BOTH
 * adapters (store-memory and store-jsonl) with parameterised construction.
 * Both adapters must satisfy the seam with identical semantics (Store-Seam §8).
 *
 * Covers: acceptance happy path, duplicate retry (same hash → duplicate,
 * different hash → conflict), direct-thread canonicalisation, sequence
 * monotonicity (incl. jsonl restart), inbox non-terminal filtering (§11.2),
 * CAS transition failures, revision conflicts, journal contents after mixed
 * writes (§11.1), the recovery-sweep flow (DEC-21), room Thread creation
 * (§11.4: get-or-create by room key, unjournaled, durable), per-person
 * Thread listing (§11.5), the frozen snapshot read (§11.6), and blocked
 * recipients committing terminal failed inside the acceptance (§11.7).
 */

import { describe, it } from "node:test";
import * as assert from "node:assert/strict";

import { schemaVersion } from "../../public/contract/index.js";
import type {
  ClientMessageId,
  ContactPolicy,
  Cursor,
  Delivery,
  Message,
  MessageId,
  PersonId,
  RecipientSnapshot,
  RequestHash,
  Sequence,
  Template,
  ThreadId,
  Timestamp,
} from "../../public/contract/index.js";
import type { AcceptanceInput } from "../../seams/store.js";
import { createSeededClock } from "../../adapters/clock-seeded.js";
import type { SeededClock } from "../../adapters/clock-seeded.js";
import { storeAdapterFactories } from "./adapterFactories.js";

// --- fixtures -----------------------------------------------------------------

const ALICE = "person_alice" as PersonId;
const BOB = "person_bob" as PersonId;

const PLACEHOLDER_THREAD = "thread_placeholder" as ThreadId;

function requestHash(char: string): RequestHash {
  return char.repeat(64) as RequestHash;
}

interface Fixture {
  clock: SeededClock;
  sender: PersonId;
  recipient: PersonId;
  clientMessageId: ClientMessageId;
  hash?: RequestHash;
  urgentDowngraded?: boolean;
}

function makeAcceptanceInput(fixture: Fixture): AcceptanceInput {
  const { clock, sender, recipient, clientMessageId } = fixture;
  const now: Timestamp = clock.now();
  const messageId = clock.newId("message");
  const message: Message = {
    id: messageId,
    kind: "message",
    schemaVersion,
    createdAt: now,
    threadId: PLACEHOLDER_THREAD, // stamped by the store at commit
    senderId: sender,
    clientMessageId,
    sequence: 0 as Sequence, // assigned by the store inside the transaction
    priority: "normal",
    body: { text: `hello from ${sender}` },
  };
  const snapshot: RecipientSnapshot = {
    id: clock.newId("snapshot"),
    kind: "recipient-snapshot",
    schemaVersion,
    createdAt: now,
    messageId,
    recipients: [recipient],
  };
  const delivery: Delivery = {
    id: clock.newId("delivery"),
    kind: "delivery",
    schemaVersion,
    createdAt: now,
    updatedAt: now,
    messageId,
    threadId: PLACEHOLDER_THREAD,
    recipientId: recipient,
    state: "pending",
  };
  return {
    idempotency: {
      senderId: sender,
      clientMessageId,
      requestHash: fixture.hash ?? requestHash("a"),
    },
    thread: { kind: "direct", pair: [sender, recipient] },
    message,
    snapshot,
    deliveries: [delivery],
    ...(fixture.urgentDowngraded !== undefined
      ? { urgentDowngraded: fixture.urgentDowngraded }
      : {}),
  };
}

function makeContactPolicy(clock: SeededClock, personId: PersonId, revision: number): ContactPolicy {
  return {
    id: clock.newId("contactpolicy"),
    kind: "contact-policy",
    schemaVersion,
    createdAt: clock.now(),
    personId,
    allowlist: [ALICE],
    defaultRule: "deny",
    revision,
  };
}

function makeTemplate(clock: SeededClock, revision: number): Template {
  return {
    id: clock.newId("template"),
    kind: "template",
    schemaVersion,
    createdAt: clock.now(),
    name: "standup",
    bindings: [{ field: "summary", path: "body.text" }],
    retired: false,
    revision,
  };
}

// --- parameterised adapter construction -----------------------------------------
// The factories live in ./adapterFactories.ts (shared with the P5 manifest —
// one array, imported by the suite AND the proof, so they can never drift).

let counter = 0;
function cmid(label: string): ClientMessageId {
  counter += 1;
  return `cm-${label}-${counter}` as ClientMessageId;
}

// --- the shared suite -------------------------------------------------------------

for (const factory of storeAdapterFactories) {
  describe(`store seam contract suite — ${factory.name}`, () => {
    it("acceptance happy path: message + snapshot + deliveries + marker committed atomically", async () => {
      const handle = await factory.make();
      try {
        const input = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("happy"),
        });
        const outcome = await handle.store.commitAcceptance(input);
        assert.equal(outcome.kind, "accepted");
        if (outcome.kind !== "accepted") return;
        assert.equal(outcome.sequence, 1);

        const message = await handle.store.getMessage(outcome.messageId);
        assert.equal(message.kind, "ok");
        if (message.kind === "ok") {
          assert.equal(message.value.sequence, 1);
          assert.equal(message.value.threadId, outcome.threadId);
          assert.equal(message.value.senderId, ALICE);
        }

        const thread = await handle.store.getThread(outcome.threadId);
        assert.equal(thread.kind, "ok");
        if (thread.kind === "ok") {
          assert.equal(thread.value.threadKind, "direct");
          assert.deepEqual(thread.value.direct?.pair, [ALICE, BOB]);
        }

        const deliveries = await handle.store.getDeliveries(outcome.messageId);
        assert.equal(deliveries.kind, "ok");
        if (deliveries.kind === "ok") {
          assert.equal(deliveries.value.length, 1);
          assert.equal(deliveries.value[0]?.recipientId, BOB);
          assert.equal(deliveries.value[0]?.state, "pending");
          assert.equal(deliveries.value[0]?.threadId, outcome.threadId);
        }

        const acceptance = await handle.store.findAcceptance(ALICE, input.idempotency.clientMessageId);
        assert.equal(acceptance.kind, "ok");
        if (acceptance.kind === "ok") {
          assert.equal(acceptance.value.effectsPending, true);
          assert.equal(acceptance.value.sequence, 1);
        }

        const page = await handle.store.getMessages(outcome.threadId);
        assert.equal(page.kind, "ok");
        if (page.kind === "ok") assert.equal(page.value.messages.length, 1);
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("duplicate retry: same hash → duplicate (with persisted urgentDowngraded), different hash → conflict", async () => {
      const handle = await factory.make();
      try {
        const clientMessageId = cmid("retry");
        const input = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId,
          urgentDowngraded: true,
        });
        const first = await handle.store.commitAcceptance(input);
        assert.equal(first.kind, "accepted");
        if (first.kind !== "accepted") return;
        assert.equal(first.urgentDowngraded, true);

        // Same key + same requestHash → duplicate, nothing new committed (§2.2, §11.3).
        const retry = await handle.store.commitAcceptance(input);
        assert.equal(retry.kind, "duplicate");
        if (retry.kind === "duplicate") {
          assert.equal(retry.original.messageId, first.messageId);
          assert.equal(retry.original.sequence, first.sequence);
          assert.equal(retry.original.urgentDowngraded, true);
        }

        // Same key + different requestHash → IdempotencyConflict (A5), nothing committed.
        const conflicting = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId,
          hash: requestHash("b"),
        });
        const conflict = await handle.store.commitAcceptance(conflicting);
        assert.equal(conflict.kind, "conflict");
        if (conflict.kind === "conflict") {
          assert.equal(conflict.error.name, "IdempotencyConflict");
          assert.equal(conflict.error.originalMessageId, first.messageId);
        }

        const page = await handle.store.getMessages(first.threadId);
        assert.equal(page.kind, "ok");
        if (page.kind === "ok") assert.equal(page.value.messages.length, 1);
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("direct-thread canonicalisation: A→B and B→A land in one thread (DEC-03)", async () => {
      const handle = await factory.make();
      try {
        const ab = await handle.store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: cmid("ab") }),
        );
        const ba = await handle.store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: BOB, recipient: ALICE, clientMessageId: cmid("ba") }),
        );
        assert.equal(ab.kind, "accepted");
        assert.equal(ba.kind, "accepted");
        if (ab.kind !== "accepted" || ba.kind !== "accepted") return;
        assert.equal(ab.threadId, ba.threadId);

        const reversed = await handle.store.getDirectThread(BOB, ALICE);
        assert.equal(reversed.kind, "ok");
        if (reversed.kind === "ok") {
          assert.equal(reversed.value.id, ab.threadId);
          // Canonical sorted pair regardless of send direction.
          assert.deepEqual(reversed.value.direct?.pair, [ALICE, BOB].sort());
        }
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("sequence monotonicity, incl. across restart where the adapter is durable", async () => {
      const handle = await factory.make();
      let store = handle.store;
      try {
        const seq1Id = cmid("seq1");
        const seq2Id = cmid("seq2");
        const one = await store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: seq1Id }),
        );
        const two = await store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: seq2Id }),
        );
        assert.equal(one.kind, "accepted");
        assert.equal(two.kind, "accepted");
        if (one.kind !== "accepted" || two.kind !== "accepted") return;
        assert.ok(two.sequence > one.sequence);

        // Restart leg: only adapters with durability (A4 excludes store-memory).
        if (handle.reopen) {
          store = await handle.reopen();
          const three = await store.commitAcceptance(
            makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: cmid("seq3") }),
          );
          assert.equal(three.kind, "accepted");
          if (three.kind === "accepted") {
            assert.ok(three.sequence > two.sequence, "no sequence number is ever reissued across restart");
          }
          const survived = await store.findAcceptance(ALICE, seq1Id);
          assert.equal(survived.kind, "ok", "pre-restart acceptance is still reserved");
          const journal = await store.scanJournal();
          assert.equal(journal.kind, "ok");
          if (journal.kind === "ok") assert.ok(journal.value.length >= 2);
        }
      } finally {
        await store.close();
        handle.cleanup();
      }
    });

    it("getInbox returns non-terminal deliveries only (§11.2)", async () => {
      const handle = await factory.make();
      try {
        const input = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("inbox"),
        });
        const outcome = await handle.store.commitAcceptance(input);
        assert.equal(outcome.kind, "accepted");
        if (outcome.kind !== "accepted") return;
        const deliveryId = input.deliveries[0]?.id;
        assert.ok(deliveryId);

        const before = await handle.store.getInbox(BOB);
        assert.equal(before.kind, "ok");
        if (before.kind === "ok") assert.equal(before.value.messages.length, 1);

        // pending → held keeps it in the inbox.
        const hold = await handle.store.transitionDelivery(deliveryId, "pending", "held", "dnd-hold");
        assert.equal(hold.kind, "ok");
        const held = await handle.store.getInbox(BOB);
        assert.equal(held.kind, "ok");
        if (held.kind === "ok") assert.equal(held.value.messages.length, 1);

        // held → delivered removes it: terminal states never appear.
        const deliver = await handle.store.transitionDelivery(deliveryId, "held", "delivered", "adapter-effect");
        assert.equal(deliver.kind, "ok");
        const after = await handle.store.getInbox(BOB);
        assert.equal(after.kind, "ok");
        if (after.kind === "ok") assert.equal(after.value.messages.length, 0);

        // failed is terminal too: a fresh send, transitioned to failed, is not served.
        const second = await handle.store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: cmid("inbox2") }),
        );
        assert.equal(second.kind, "accepted");
        if (second.kind !== "accepted") return;
        const secondInputDelivery = await handle.store.getDeliveries(second.messageId);
        assert.equal(secondInputDelivery.kind, "ok");
        const failedId = secondInputDelivery.kind === "ok" ? secondInputDelivery.value[0]?.id : undefined;
        assert.ok(failedId);
        const fail = await handle.store.transitionDelivery(failedId, "pending", "failed", "blocked-by-contact-policy");
        assert.equal(fail.kind, "ok");
        const terminal = await handle.store.getInbox(BOB);
        assert.equal(terminal.kind, "ok");
        if (terminal.kind === "ok") assert.equal(terminal.value.messages.length, 0);
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("transitionDelivery CAS: expected mismatch → StateConflict; unknown → RecordNotFound; attempts append-only", async () => {
      const handle = await factory.make();
      try {
        const input = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("cas"),
        });
        const outcome = await handle.store.commitAcceptance(input);
        assert.equal(outcome.kind, "accepted");
        const deliveryId = input.deliveries[0]?.id;
        assert.ok(deliveryId);

        const wrongExpected = await handle.store.transitionDelivery(deliveryId, "delivered", "failed", "transport-failure");
        assert.equal(wrongExpected.kind, "error");
        if (wrongExpected.kind === "error") {
          assert.equal(wrongExpected.error.name, "StateConflict");
          if (wrongExpected.error.name === "StateConflict") {
            assert.equal(wrongExpected.error.expected, "delivered");
            assert.equal(wrongExpected.error.actual, "pending");
          }
        }

        const missing = await handle.store.transitionDelivery(
          handle.clock.newId("delivery"),
          "pending",
          "delivered",
          "adapter-effect",
        );
        assert.equal(missing.kind, "error");
        if (missing.kind === "error") assert.equal(missing.error.name, "RecordNotFound");

        // First effect wins (DEC-16 fan-out race resolves at the CAS); the loser gets StateConflict.
        const win = await handle.store.transitionDelivery(deliveryId, "pending", "delivered", "adapter-effect");
        assert.equal(win.kind, "ok");
        const lose = await handle.store.transitionDelivery(deliveryId, "pending", "delivered", "adapter-effect");
        assert.equal(lose.kind, "error");
        if (lose.kind === "error") assert.equal(lose.error.name, "StateConflict");

        const attempt = await handle.store.appendDeliveryAttempt(deliveryId, {
          id: handle.clock.newId("attempt"),
          kind: "delivery-attempt",
          schemaVersion,
          createdAt: handle.clock.now(),
          deliveryId,
          transport: "ws",
          outcome: "superseded",
        });
        assert.equal(attempt.kind, "ok");

        const orphan = await handle.store.appendDeliveryAttempt(handle.clock.newId("delivery"), {
          id: handle.clock.newId("attempt"),
          kind: "delivery-attempt",
          schemaVersion,
          createdAt: handle.clock.now(),
          deliveryId: "delivery_orphan" as typeof deliveryId,
          transport: "ws",
          outcome: "failure",
        });
        assert.equal(orphan.kind, "error");
        if (orphan.kind === "error") assert.equal(orphan.error.name, "RecordNotFound");
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("revision CAS: stale expectedRevision → RevisionConflict; retire unknown → RecordNotFound", async () => {
      const handle = await factory.make();
      try {
        // First creation is an unconditional put (§5).
        const created = await handle.store.putPolicy(BOB, makeContactPolicy(handle.clock, BOB, 1));
        assert.equal(created.kind, "ok");

        const revised = await handle.store.putPolicy(BOB, makeContactPolicy(handle.clock, BOB, 2), 1);
        assert.equal(revised.kind, "ok");

        const stale = await handle.store.putPolicy(BOB, makeContactPolicy(handle.clock, BOB, 3), 1);
        assert.equal(stale.kind, "error");
        if (stale.kind === "error") {
          assert.equal(stale.error.name, "RevisionConflict");
          if (stale.error.name === "RevisionConflict") {
            assert.equal(stale.error.expected, 1);
            assert.equal(stale.error.actual, 2);
          }
        }

        const policy = await handle.store.getPolicy(BOB);
        assert.equal(policy.kind, "ok");
        if (policy.kind === "ok") assert.equal(policy.value.contact?.revision, 2);

        const template = makeTemplate(handle.clock, 1);
        const templated = await handle.store.putTemplate(template);
        assert.equal(templated.kind, "ok");

        const staleTemplate = await handle.store.putTemplate({ ...template, revision: 2 }, 7);
        assert.equal(staleTemplate.kind, "error");
        if (staleTemplate.kind === "error") assert.equal(staleTemplate.error.name, "RevisionConflict");

        const retireMissing = await handle.store.retireTemplate(handle.clock.newId("template"));
        assert.equal(retireMissing.kind, "error");
        if (retireMissing.kind === "error") assert.equal(retireMissing.error.name, "RecordNotFound");

        const retired = await handle.store.retireTemplate(template.id, 1);
        assert.equal(retired.kind, "ok");
        if (retired.kind === "ok") assert.equal(retired.value.revision, 2);
        const reloaded = await handle.store.getTemplate(template.id);
        assert.equal(reloaded.kind, "ok");
        if (reloaded.kind === "ok") {
          assert.equal(reloaded.value.retired, true);
          assert.equal(reloaded.value.revision, 2);
        }
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("journal contents after mixed writes (§11.1): acceptance + transition + policy + template, all sequenced", async () => {
      const handle = await factory.make();
      try {
        const input = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("journal"),
        });
        const accepted = await handle.store.commitAcceptance(input);
        assert.equal(accepted.kind, "accepted");
        const deliveryId = input.deliveries[0]?.id;
        assert.ok(deliveryId);
        await handle.store.transitionDelivery(deliveryId, "pending", "delivered", "adapter-effect");
        await handle.store.putPolicy(BOB, makeContactPolicy(handle.clock, BOB, 1));
        await handle.store.putTemplate(makeTemplate(handle.clock, 1));

        const journal = await handle.store.scanJournal();
        assert.equal(journal.kind, "ok");
        if (journal.kind !== "ok") return;
        assert.equal(journal.value.length, 4);
        assert.deepEqual(
          journal.value.map((entry) => entry.kind),
          ["MessageCommitted", "DeliveryUpdated", "PolicyChanged", "TemplateWritten"],
        );
        const sequences = journal.value.map((entry) => entry.sequence);
        assert.deepEqual(
          [...sequences].sort((a, b) => a - b),
          sequences,
          "journal is ordered by sequence ascending",
        );
        assert.ok(new Set(sequences).size === sequences.length, "sequences are strictly unique");
        const policyEntry = journal.value[2];
        assert.equal(policyEntry?.kind, "PolicyChanged");
        if (policyEntry?.kind === "PolicyChanged") {
          assert.equal(policyEntry.personId, BOB);
          assert.equal(policyEntry.policy, "contact");
          assert.equal(policyEntry.revision, 1);
        }

        const tail = await handle.store.scanJournal(sequences[1] as Sequence);
        assert.equal(tail.kind, "ok");
        if (tail.kind === "ok") assert.equal(tail.value.length, 2);
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("recovery sweep: listPendingAcceptances → markEffectsSettled (idempotent), unknown → RecordNotFound", async () => {
      const handle = await factory.make();
      try {
        const outcome = await handle.store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: cmid("sweep") }),
        );
        assert.equal(outcome.kind, "accepted");
        if (outcome.kind !== "accepted") return;

        const pending = await handle.store.listPendingAcceptances();
        assert.equal(pending.kind, "ok");
        if (pending.kind === "ok") {
          assert.equal(pending.value.acceptances.length, 1);
          assert.equal(pending.value.acceptances[0]?.messageId, outcome.messageId);
        }

        const settled = await handle.store.markEffectsSettled(outcome.messageId);
        assert.equal(settled.kind, "ok");
        const after = await handle.store.listPendingAcceptances();
        assert.equal(after.kind, "ok");
        if (after.kind === "ok") assert.equal(after.value.acceptances.length, 0);

        // Idempotent: settling twice is fine.
        const again = await handle.store.markEffectsSettled(outcome.messageId);
        assert.equal(again.kind, "ok");

        const unknown = await handle.store.markEffectsSettled("message_unknown" as MessageId);
        assert.equal(unknown.kind, "error");
        if (unknown.kind === "error") assert.equal(unknown.error.name, "RecordNotFound");
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("cursors: malformed → CursorInvalid; pagination follows s_<n> without loss or duplication", async () => {
      const handle = await factory.make();
      try {
        for (const label of ["p1", "p2", "p3"]) {
          const outcome = await handle.store.commitAcceptance(
            makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: cmid(label) }),
          );
          assert.equal(outcome.kind, "accepted");
        }
        const thread = await handle.store.getDirectThread(ALICE, BOB);
        assert.equal(thread.kind, "ok");
        if (thread.kind !== "ok") return;

        const badCursor = await handle.store.getMessages(thread.value.id, {
          cursor: "not-a-cursor" as Cursor,
        });
        assert.equal(badCursor.kind, "error");
        if (badCursor.kind === "error") assert.equal(badCursor.error.name, "CursorInvalid");

        const firstPage = await handle.store.getMessages(thread.value.id, { limit: 2 });
        assert.equal(firstPage.kind, "ok");
        if (firstPage.kind !== "ok") return;
        assert.equal(firstPage.value.messages.length, 2);
        assert.ok(firstPage.value.nextCursor);

        const secondPage = await handle.store.getMessages(thread.value.id, {
          cursor: firstPage.value.nextCursor,
          limit: 2,
        });
        assert.equal(secondPage.kind, "ok");
        if (secondPage.kind !== "ok") return;
        assert.equal(secondPage.value.messages.length, 1);
        assert.equal(secondPage.value.nextCursor, undefined);

        const all = [...firstPage.value.messages, ...secondPage.value.messages].map((m) => m.id);
        assert.equal(new Set(all).size, 3, "no message repeated or skipped across pages");

        // Limit is clamped to constants.pageLimitMax, never rejected (§4).
        const clamped = await handle.store.getMessages(thread.value.id, { limit: 100000 });
        assert.equal(clamped.kind, "ok");
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    // F1/F5: concurrent-mutation atomicity (Store-Seam §1 rule 3: "adapters
    // serialise writes internally"). These FAIL against a store whose
    // check-then-act is separated from apply by an await (the persist hook
    // yields), and PASS once the store core serialises mutations.
    it("F5: concurrent same-key commitAcceptance → exactly one accepted + one duplicate, same messageId", async () => {
      const handle = await factory.make();
      try {
        const clientMessageId = cmid("race-same-key");
        const first = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId,
        });
        const second = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId,
        });
        // Both start before either can apply: the loser's idempotency check
        // MUST observe the winner's reservation (DEC-20/A5).
        const [outcomeA, outcomeB] = await Promise.all([
          handle.store.commitAcceptance(first),
          handle.store.commitAcceptance(second),
        ]);
        const kinds = [outcomeA.kind, outcomeB.kind].sort();
        assert.deepEqual(kinds, ["accepted", "duplicate"], "exactly one commit wins the race");
        const accepted = outcomeA.kind === "accepted" ? outcomeA : outcomeB;
        const duplicate = outcomeA.kind === "duplicate" ? outcomeA : outcomeB;
        assert.ok(accepted.kind === "accepted" && duplicate.kind === "duplicate");
        assert.equal(duplicate.original.messageId, accepted.messageId, "the duplicate returns the ORIGINAL");

        const page = await handle.store.getMessages(accepted.threadId);
        assert.equal(page.kind, "ok");
        if (page.kind === "ok") {
          assert.equal(page.value.messages.length, 1, "no double commit (I1)");
        }
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("F5: concurrent first-send on the same principal pair → exactly one Thread (DEC-03)", async () => {
      const handle = await factory.make();
      try {
        const [outcomeA, outcomeB] = await Promise.all([
          handle.store.commitAcceptance(
            makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: cmid("race-pair-a") }),
          ),
          handle.store.commitAcceptance(
            makeAcceptanceInput({ clock: handle.clock, sender: BOB, recipient: ALICE, clientMessageId: cmid("race-pair-b") }),
          ),
        ]);
        assert.equal(outcomeA.kind, "accepted");
        assert.equal(outcomeB.kind, "accepted");
        if (outcomeA.kind !== "accepted" || outcomeB.kind !== "accepted") return;
        assert.equal(
          outcomeA.threadId,
          outcomeB.threadId,
          "the canonical pair resolves to ONE Thread even under a get-or-create race",
        );
        const thread = await handle.store.getDirectThread(ALICE, BOB);
        assert.equal(thread.kind, "ok");
        if (thread.kind === "ok") assert.equal(thread.value.id, outcomeA.threadId);
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("F5: concurrent CAS on the same delivery → exactly one ok; the journal shows no illegal transition (R5 terminality)", async () => {
      const handle = await factory.make();
      try {
        const input = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("race-cas"),
        });
        const accepted = await handle.store.commitAcceptance(input);
        assert.equal(accepted.kind, "accepted");
        const deliveryId = input.deliveries[0]?.id;
        assert.ok(deliveryId);

        // pending → delivered races pending → failed: exactly one may win;
        // delivered → failed is an illegal transition and must never be journaled.
        const [resultA, resultB] = await Promise.all([
          handle.store.transitionDelivery(deliveryId, "pending", "delivered", "adapter-effect"),
          handle.store.transitionDelivery(deliveryId, "pending", "failed", "retry-exhausted"),
        ]);
        const oks = [resultA, resultB].filter((result) => result.kind === "ok");
        const conflicts = [resultA, resultB].filter(
          (result) => result.kind === "error" && result.error.name === "StateConflict",
        );
        assert.equal(oks.length, 1, "exactly one CAS wins");
        assert.equal(conflicts.length, 1, "the loser gets StateConflict");

        const journal = await handle.store.scanJournal();
        assert.equal(journal.kind, "ok");
        if (journal.kind === "ok") {
          const transitions = journal.value.filter((entry) => entry.kind === "DeliveryUpdated");
          assert.equal(transitions.length, 1, "exactly one delivery transition is journaled");
        }

        const deliveries = await handle.store.getDeliveries(input.message.id);
        assert.equal(deliveries.kind, "ok");
        if (deliveries.kind === "ok") {
          const states = deliveries.value.map((delivery) => delivery.state);
          assert.equal(states.length, 1);
          assert.ok(states[0] === "delivered" || states[0] === "failed");
        }
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("jsonl durability: committed state and journal survive close + reopen", async () => {
      const handle = await factory.make();
      let store = handle.store;
      try {
        if (!handle.reopen) return; // A4: store-memory makes no durability claims.
        const durableId = cmid("durable");
        const outcome = await store.commitAcceptance(
          makeAcceptanceInput({
            clock: handle.clock,
            sender: ALICE,
            recipient: BOB,
            clientMessageId: durableId,
            urgentDowngraded: false,
          }),
        );
        assert.equal(outcome.kind, "accepted");
        if (outcome.kind !== "accepted") return;

        store = await handle.reopen();

        const message = await store.getMessage(outcome.messageId);
        assert.equal(message.kind, "ok");
        const acceptance = await store.findAcceptance(ALICE, durableId);
        assert.equal(acceptance.kind, "ok");
        if (acceptance.kind === "ok") {
          assert.equal(acceptance.value.effectsPending, true);
          assert.equal(acceptance.value.urgentDowngraded, false);
        }
        const journal = await store.scanJournal();
        assert.equal(journal.kind, "ok");
        if (journal.kind === "ok") {
          assert.equal(journal.value.length, 1);
          assert.equal(journal.value[0]?.kind, "MessageCommitted");
        }
      } finally {
        await store.close();
        handle.cleanup();
      }
    });

    it("createRoomThread (§11.4): get-or-create by room key; minted threadId; NOT journaled; unknown room commit fails", async () => {
      const handle = await factory.make();
      try {
        const spec = { threadKind: "team" as const, authority: "team-capability", externalId: "team-1" };
        const created = await handle.store.createRoomThread(spec);
        assert.equal(created.kind, "ok");
        if (created.kind !== "ok") return;
        assert.ok(created.value.id.startsWith("thread_"), "the adapter mints the threadId");
        assert.equal(created.value.threadKind, "team");
        assert.deepEqual(created.value.room, { authority: "team-capability", externalId: "team-1" });

        // Idempotent by room key: a repeated create proceeds against the
        // EXISTING Thread (not an error) and never mints a second one.
        const again = await handle.store.createRoomThread(spec);
        assert.equal(again.kind, "ok");
        if (again.kind === "ok") assert.equal(again.value.id, created.value.id);

        // A different room key mints a different Thread.
        const other = await handle.store.createRoomThread({
          threadKind: "mission",
          authority: "team-capability",
          externalId: "mission-1",
        });
        assert.equal(other.kind, "ok");
        if (other.kind === "ok") assert.notEqual(other.value.id, created.value.id);

        // Concurrent creates race inside the mutation queue → exactly one Thread.
        const [raceA, raceB] = await Promise.all([
          handle.store.createRoomThread({ threadKind: "team", authority: "team-capability", externalId: "race" }),
          handle.store.createRoomThread({ threadKind: "team", authority: "team-capability", externalId: "race" }),
        ]);
        assert.equal(raceA.kind, "ok");
        assert.equal(raceB.kind, "ok");
        if (raceA.kind === "ok" && raceB.kind === "ok") {
          assert.equal(raceA.value.id, raceB.value.id, "one Thread per room, forever");
        }

        // §11.4: Thread creation is NOT journaled (no committed-fact event).
        const journal = await handle.store.scanJournal();
        assert.equal(journal.kind, "ok");
        if (journal.kind === "ok") assert.equal(journal.value.length, 0);

        // §2.1: a room commit against an unknown room Thread fails RecordNotFound.
        const unknown = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("room-unknown"),
        });
        unknown.thread = { kind: "room", threadId: handle.clock.newId("thread") };
        const failed = await handle.store.commitAcceptance(unknown);
        assert.equal(failed.kind, "failed");
        if (failed.kind === "failed") assert.equal(failed.error.name, "RecordNotFound");

        // A room commit against the created Thread succeeds and lands history there.
        const roomSend = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("room-ok"),
        });
        roomSend.thread = { kind: "room", threadId: created.value.id };
        const accepted = await handle.store.commitAcceptance(roomSend);
        assert.equal(accepted.kind, "accepted");
        if (accepted.kind === "accepted") assert.equal(accepted.threadId, created.value.id);
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("createRoomThread durability: the Thread and its room-key index survive close + reopen", async () => {
      const handle = await factory.make();
      let store = handle.store;
      try {
        if (!handle.reopen) return; // A4: store-memory makes no durability claims.
        const spec = { threadKind: "team" as const, authority: "team-capability", externalId: "team-durable" };
        const created = await store.createRoomThread(spec);
        assert.equal(created.kind, "ok");
        if (created.kind !== "ok") return;

        store = await handle.reopen();

        const thread = await store.getThread(created.value.id);
        assert.equal(thread.kind, "ok");
        if (thread.kind === "ok") assert.equal(thread.value.threadKind, "team");
        // The room-key index survived: re-creating proceeds against the same Thread.
        const again = await store.createRoomThread(spec);
        assert.equal(again.kind, "ok");
        if (again.kind === "ok") assert.equal(again.value.id, created.value.id);
        const listed = await store.listThreadsForPerson(ALICE);
        assert.equal(listed.kind, "ok");
        if (listed.kind === "ok") {
          assert.ok(listed.value.some((candidate) => candidate.id === created.value.id));
        }
      } finally {
        await store.close();
        handle.cleanup();
      }
    });

    it("listThreadsForPerson (§11.5): direct-for-person + ALL room Threads; committed state only", async () => {
      const handle = await factory.make();
      try {
        const nobody = "person_nobody" as PersonId;
        const before = await handle.store.listThreadsForPerson(ALICE);
        assert.equal(before.kind, "ok");
        if (before.kind === "ok") assert.equal(before.value.length, 0);

        // A direct Thread for alice↔bob and an unrelated one for bob↔nobody.
        await handle.store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: cmid("lt-1") }),
        );
        await handle.store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: BOB, recipient: nobody, clientMessageId: cmid("lt-2") }),
        );
        const room = await handle.store.createRoomThread({
          threadKind: "team",
          authority: "team-capability",
          externalId: "team-lt",
        });
        assert.equal(room.kind, "ok");

        const aliceThreads = await handle.store.listThreadsForPerson(ALICE);
        assert.equal(aliceThreads.kind, "ok");
        if (aliceThreads.kind === "ok") {
          assert.equal(aliceThreads.value.filter((t) => t.threadKind === "direct").length, 1, "own direct only");
          assert.equal(aliceThreads.value.filter((t) => t.threadKind === "team").length, 1, "ALL rooms — membership filtering lives above the store");
        }
        const nobodyThreads = await handle.store.listThreadsForPerson(nobody);
        assert.equal(nobodyThreads.kind, "ok");
        if (nobodyThreads.kind === "ok") {
          assert.equal(nobodyThreads.value.filter((t) => t.threadKind === "direct").length, 1);
          assert.equal(nobodyThreads.value.filter((t) => t.threadKind === "team").length, 1);
        }
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("listDirectThreads (A-R-N4-1): EVERY direct lane in creation order, no rooms, regardless of pair", async () => {
      const handle = await factory.make();
      try {
        const nobody = "person_nobody" as PersonId;
        const before = await handle.store.listDirectThreads();
        assert.equal(before.kind, "ok");
        if (before.kind === "ok") assert.equal(before.value.length, 0);

        // Two unrelated direct lanes + a room — the amendment read is the
        // UNSCOPED lane enumeration (oversight), never pair-matched.
        await handle.store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: ALICE, recipient: BOB, clientMessageId: cmid("ld-1") }),
        );
        await handle.store.commitAcceptance(
          makeAcceptanceInput({ clock: handle.clock, sender: BOB, recipient: nobody, clientMessageId: cmid("ld-2") }),
        );
        const room = await handle.store.createRoomThread({
          threadKind: "team",
          authority: "team-capability",
          externalId: "team-ld",
        });
        assert.equal(room.kind, "ok");

        const lanes = await handle.store.listDirectThreads();
        assert.equal(lanes.kind, "ok");
        if (lanes.kind === "ok") {
          assert.equal(lanes.value.length, 2, "every direct lane, no rooms");
          assert.ok(lanes.value.every((thread) => thread.threadKind === "direct"));
          const pairs = lanes.value.map((thread) => [...(thread.direct?.pair ?? [])].sort().join("+"));
          assert.deepEqual(pairs, [[ALICE, BOB].sort().join("+"), [BOB, nobody].sort().join("+")], "creation order");
        }
      } finally {
        await handle.store.close();
        handle.cleanup();
      }
    });

    it("getSnapshot (§11.6): the frozen snapshot by messageId — membership evidence + blocked; unknown → RecordNotFound", async () => {
      const handle = await factory.make();
      let store = handle.store;
      try {
        const room = await store.createRoomThread({
          threadKind: "team",
          authority: "team-capability",
          externalId: "team-snap",
        });
        assert.equal(room.kind, "ok");
        if (room.kind !== "ok") return;

        const input = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("snap"),
        });
        input.thread = { kind: "room", threadId: room.value.id };
        input.snapshot.membership = {
          authority: "team-capability",
          revision: "rev-42",
          resolvedAt: handle.clock.now(),
        };
        input.snapshot.blocked = [{ personId: BOB, reason: "blocked-by-contact-policy" }];
        const accepted = await store.commitAcceptance(input);
        assert.equal(accepted.kind, "accepted");
        if (accepted.kind !== "accepted") return;

        const snapshot = await store.getSnapshot(accepted.messageId);
        assert.equal(snapshot.kind, "ok");
        if (snapshot.kind === "ok") {
          assert.equal(snapshot.value.messageId, accepted.messageId);
          assert.equal(snapshot.value.membership?.revision, "rev-42", "evidence frozen verbatim (Store-Seam §9)");
          assert.deepEqual(snapshot.value.blocked, [{ personId: BOB, reason: "blocked-by-contact-policy" }]);
        }

        const missing = await store.getSnapshot("message_unknown" as MessageId);
        assert.equal(missing.kind, "error");
        if (missing.kind === "error") assert.equal(missing.error.name, "RecordNotFound");

        if (handle.reopen) {
          store = await handle.reopen();
          const durable = await store.getSnapshot(accepted.messageId);
          assert.equal(durable.kind, "ok");
          if (durable.kind === "ok") {
            assert.equal(durable.value.membership?.revision, "rev-42");
          }
        }
      } finally {
        await store.close();
        handle.cleanup();
      }
    });

    it("§11.7: snapshot-blocked recipients commit TERMINAL failed{blocked-by-contact-policy} INSIDE commitAcceptance", async () => {
      const handle = await factory.make();
      let store = handle.store;
      try {
        const room = await store.createRoomThread({
          threadKind: "team",
          authority: "team-capability",
          externalId: "team-blocked",
        });
        assert.equal(room.kind, "ok");
        if (room.kind !== "ok") return;

        const input = makeAcceptanceInput({
          clock: handle.clock,
          sender: ALICE,
          recipient: BOB,
          clientMessageId: cmid("blocked-commit"),
        });
        input.thread = { kind: "room", threadId: room.value.id };
        input.snapshot.blocked = [{ personId: BOB, reason: "blocked-by-contact-policy" }];
        const accepted = await store.commitAcceptance(input);
        assert.equal(accepted.kind, "accepted");
        if (accepted.kind !== "accepted") return;

        // Terminal FROM THE COMMIT — no pending instant is ever observable.
        const deliveries = await store.getDeliveries(accepted.messageId);
        assert.equal(deliveries.kind, "ok");
        if (deliveries.kind === "ok") {
          assert.equal(deliveries.value.length, 1);
          assert.equal(deliveries.value[0]?.state, "failed");
          assert.equal(deliveries.value[0]?.stateReason, "blocked-by-contact-policy");
        }

        // §11.2: the blocked Message never enters the recipient's inbox.
        const inbox = await store.getInbox(BOB);
        assert.equal(inbox.kind, "ok");
        if (inbox.kind === "ok") assert.equal(inbox.value.messages.length, 0);

        // MSG-016 observability preserved: MessageCommitted AND a
        // DeliveryUpdated for the terminal failure, journaled in the same
        // commit (§11.1).
        const journal = await store.scanJournal();
        assert.equal(journal.kind, "ok");
        if (journal.kind === "ok") {
          const kinds = journal.value.map((entry) => entry.kind);
          assert.deepEqual(kinds, ["MessageCommitted", "DeliveryUpdated"]);
          const update = journal.value[1];
          if (update?.kind === "DeliveryUpdated") {
            assert.equal(update.delivery.state, "failed");
            assert.equal(update.delivery.stateReason, "blocked-by-contact-policy");
          }
        }

        // The terminal truth is durable across restart (jsonl; memory skips).
        if (handle.reopen) {
          store = await handle.reopen();
          const durable = await store.getDeliveries(accepted.messageId);
          assert.equal(durable.kind, "ok");
          if (durable.kind === "ok") {
            assert.equal(durable.value[0]?.state, "failed");
            assert.equal(durable.value[0]?.stateReason, "blocked-by-contact-policy");
          }
          const durableJournal = await store.scanJournal();
          assert.equal(durableJournal.kind, "ok");
          if (durableJournal.kind === "ok") {
            assert.deepEqual(
              durableJournal.value.map((entry) => entry.kind),
              ["MessageCommitted", "DeliveryUpdated"],
              "both journaled entries survive replay",
            );
          }
        }
      } finally {
        await store.close();
        handle.cleanup();
      }
    });
  });
}
