# Messaging — Store Seam Contract (Step 3a)

**Date:** 2026-07-24 · **Author:** kimi-cli (Step 3a of the amended pass-2 sequence)
**Authority:** derives from `Messaging-Ratification.md` only — DEC-18/19/20/21 (A1, A5, A6, A7),
work items R6 (Step-3 half), R7 (closed here), R8 (store-side hook; membership side lands in Step 3b).
**Status:** binding seam contract. Step 2's error schemas freeze against §6 of this document (R6 sequencing note).
**Scope:** the Store seam only. Authority, membership, presence-transport, clock/ID seams are Step 3b.

---

## 1. Why this seam exists and why it is deep

The store is independently replaceable infrastructure (Plan §14) and the single-writer
point that makes atomicity and ordering *possible*. Per DEC-20 (A6), the seam is **deep**:
the core calls one operation per acceptance; it never orchestrates append/find choreography
across the seam. If the core can observe or assemble intermediate persistence states, this
contract is violated.

**Rules:**

1. All writes to authoritative Messaging records go through this seam. Nothing else persists.
2. Every persisted record carries the I3 envelope: `id`, `kind`, `schemaVersion`, `createdAt`.
   Records arrive at the seam already validated by the contract layer; the store treats
   payloads as opaque except the envelope and the indexed fields named in §5.
3. The store is a single logical writer. Adapters serialise writes internally; the core
   never coordinates concurrent writers — that is what the seam is for.
4. `append / read / find`-style primitives survive **only** as the read operations in §4
   and the journal scan in §7 — for reads, projections, and recovery. They are not an
   acceptance path.

---

## 2. The acceptance transaction (DEC-20, DEC-18, A5)

One atomic operation. All effects below commit, or none do.

```
commitAcceptance(input: AcceptanceInput) → AcceptanceOutcome

AcceptanceInput = {
  idempotency: { senderId: PersonId, clientMessageId: string, requestHash: Hash },
  thread:      DirectThreadRef | RoomThreadRef,          // see get-or-create below
  message:     Message,                                  // fully formed except `sequence`
  snapshot:    RecipientSnapshot,                        // frozen recipient set (I5)
  deliveries:  Delivery[],                               // one initial record per recipient
}

AcceptanceOutcome =
  | { kind: "accepted",  messageId, threadId, sequence }
  | { kind: "duplicate", original: AcceptedOutcome }      // same key + same requestHash
  | { kind: "conflict",  error: IdempotencyConflict }     // same key + different requestHash (A5)
  | { kind: "failed",    error: StoreError }              // §6 — NOTHING committed
```

**The transaction performs, atomically:**

1. **Thread get-or-create.** Direct: resolve the canonical sorted Person pair (DEC-03);
   create the Thread if absent. Two concurrent first-sends between the same pair produce
   exactly one Thread — the loser's commit proceeds against the existing Thread (this is
   *not* an error; review #5). Room: the Thread must already exist; unknown room Thread →
   `failed { RecordNotFound }`.
2. **Idempotency reservation.** Put-if-absent on `(senderId, clientMessageId)` storing
   `requestHash` (A5). Absent → reserved, continue. Present + same hash → return
   `duplicate` with the original acceptance, commit nothing new. Present + different hash →
   return `conflict`, commit nothing.
3. **Sequence assignment.** Assign the next global sequence number (§3) to the Message
   inside the transaction.
4. **Commit.** Message + recipient snapshot + initial Delivery records, together (DEC-09).
5. **Recovery marker.** Write the acceptance's `effectsPending` marker in the same
   transaction (§7, DEC-21). An acceptance without its marker does not exist.

`requestHash` covers the full request content: address, body, priority, template ID +
fields. The core computes it; the store stores and compares it opaquely.

**Invalid if changed:** idempotency mechanism, commit path, W2/W3 proofs, MSG-018/019.

---

## 3. Sequence ordering (DEC-19, R7 — CLOSED here)

R7 asked: scope, uniqueness, gaps, restart recovery, cursor encoding, and the DEC-10
reconciliation. Rulings:

| Question | Ruling |
|---|---|
| Scope | **One global sequence per store**, across all record kinds. No per-stream sequences in v1 — thread history is "global sequence, filtered by thread", which is correct by construction and keeps one ordering truth. |
| Uniqueness | Strict. A sequence number identifies exactly one committed record. |
| Monotonicity | Increasing by assignment order. **Gaps are permitted** (a failed transaction may consume nothing, but consumers MUST NOT assume contiguity — queries compare, they never count). |
| Assignment | By the store adapter, inside the commit transaction (DEC-19). The last-issued number is persisted **as part of the same transaction** (a counter record), so restart recovery is "read the counter". An adapter may instead max-scan at open, but reissuing a number is a contract violation. |
| Cursor encoding | Opaque string wrapping the last-seen sequence (`"s_<n>"`). Cursors survive restarts. A malformed or foreign cursor → `CursorInvalid` (§6), never a silent wrong page. |
| Wall-clock | `createdAt` is display-only. Nothing in the capability orders by timestamps. |

**DEC-10 reconciliation (R7's second half):** the capability owns the ordering
**guarantee** — the contract every consumer sees (sequence-ordered reads, cursor rules,
no timestamp ordering). The adapter owns the assignment **mechanism**, because the
single-writer store is the only point that can assign race-free. Ownership of the
semantics did not move; only the mechanism sits where it must.

---

## 4. Reads

All reads are of committed state only. Ordered results are by sequence ascending.

```
getThread(threadId)                              → Thread | RecordNotFound
getDirectThread(personA, personB)                → Thread | RecordNotFound
getMessage(messageId)                            → Message | RecordNotFound
getMessages(threadId, cursor?, limit)            → MessagePage     // ordered by sequence
getInbox(personId, cursor?, limit)               → MessagePage     // held or undelivered only
getDeliveries(messageId)                         → Delivery[]      // per-recipient state
findAcceptance(senderId, clientMessageId)        → AcceptanceRecord | RecordNotFound
getPolicy(personId)                              → PolicyRecord | RecordNotFound
getTemplate(templateId)                          → TemplateRecord | RecordNotFound
listTemplates(cursor?, limit)                    → TemplatePage
```

`limit` is bounded by an adapter constant (v1 default: 200) — an over-limit request is
clamped, not rejected. Every paged read returns `nextCursor?`.

## 5. Non-acceptance writes

Policies, templates, and delivery state change after acceptance. These are single-record
writes with optimistic concurrency — never multi-record transactions (only acceptance is):

```
putPolicy(personId, policy, expectedRevision?)   → ok | RevisionConflict
putTemplate(template, expectedRevision?)         → ok | RevisionConflict
retireTemplate(templateId, expectedRevision?)    → ok | RevisionConflict | RecordNotFound

transitionDelivery(deliveryId, expectedState, nextState, attempt?)
                                                 → ok | StateConflict | RecordNotFound
appendDeliveryAttempt(deliveryId, attempt)       → AttemptId | RecordNotFound
```

- `transitionDelivery` is compare-and-swap on the Delivery's state. The DEC-16 fan-out
  race resolves here: the first adapter effect to transition a Delivery to `delivered`
  wins; late transitions get `StateConflict` and the core records them as attempts only
  (I11 intact, no double-settle). State names and legal transitions are owned by the
  Delivery state machine (R5, Step 2) — the store enforces only "expected matches current".
- `appendDeliveryAttempt` enforces I6: the parent Delivery must exist
  (`RecordNotFound` otherwise). Attempts are append-only.
- `expectedRevision` omitted means unconditional put (used only for first creation).

**Indexed fields** (the only payload fields the store may look inside): envelope fields,
`threadId`, `senderId`, `clientMessageId`, `recipientId`, delivery `state`, `sequence`.

---

## 6. Failure vocabulary (R6 — Step-3 half, CLOSED; feeds Step 2)

Every store operation returns a typed outcome. No thrown strings, no silent failure (G6).
The seam-level vocabulary:

| Error | Meaning | Retryable? | Core handling |
|---|---|---|---|
| `StoreUnavailable` | IO failure, lock timeout, operation exceeded its deadline | Yes (bounded backoff) | Surface as public dependency-failure outcome (Step 2 names it) |
| `StoreCorrupt` | Durable state unparseable or internally inconsistent | **No** | Halt the affected operation; surface; operator intervention |
| `StorageExhausted` | Disk full / quota | No (until freed) | Surface |
| `IdempotencyConflict` | Same key, different `requestHash` (A5) | No | Pass through to caller — **public** error |
| `StateConflict` | CAS `expectedState` mismatch | Core re-reads and re-decides | Normal concurrency outcome — **not** public |
| `RevisionConflict` | `expectedRevision` mismatch on policy/template put | Core re-reads and re-decides | Normal concurrency outcome — **not** public |
| `RecordNotFound` | Read/append target absent | No | Maps to `UnknownThread` / `UnknownMessage` etc. at the contract layer |
| `CursorInvalid` | Malformed or foreign cursor | No | Maps to public `ValidationFailed` |
| `SequenceExhausted` | Counter overflow | No | Forward-reserved; unreachable with unsigned 64-bit |

**Timeout behaviour:** store operations are local. Every adapter must complete or fail
any operation within a bounded deadline (adapter configuration, v1 default 5 s). A
deadline breach is `StoreUnavailable` — never a hung caller, never a partial commit.
`commitAcceptance` returning `failed` guarantees *nothing* was committed (atomicity §2);
the core may safely surface failure and let the client retry the same `clientMessageId`.

**Step 2 consumes this section as-is** to freeze the public dependency-failure outcomes
(store commit failure, plus membership-timeout and authority-failure shapes from Step 3b).
The seam names above are stable; only their public mappings are Step 2's to write.

---

## 7. Recovery support (DEC-21, A7)

DEC-09 reads: commit-before-effect **and** eventual-effect. The store makes the sweep
possible; the core's effect shell runs it (on startup and periodically).

```
listPendingAcceptances(cursor?, limit)  → PendingAcceptance[]   // effectsPending = true
markEffectsSettled(messageId)           → ok                    // idempotent
scanJournal(sinceSequence?, limit)      → JournalEntry[]        // ordered by sequence
```

- The `effectsPending` marker is written inside the acceptance transaction (§2.5).
- `markEffectsSettled` clears it **after** Delivery records exist, events are emitted,
  and transport is scheduled. Idempotent: settling twice is fine, settling an unknown
  `messageId` is `RecordNotFound`.
- The sweep drives every pending acceptance to completion; `scanJournal` is the
  catch-up mechanism for projections and for subscription replay-after-disconnect
  (input to R1 in Step 2 — the replay cursor is a sequence cursor, §3).
- Crash window honesty: a crash between commit and settle leaves a pending marker →
  the sweep re-drives. Effects must therefore be idempotent at the consumer side
  (delivery transitions are CAS, §5; event replay dedupes by sequence).

---

## 8. Adapter obligations

| Obligation | `store-jsonl` (production default) | `store-memory` (A4: test/harness only) |
|---|---|---|
| Full §2–§7 contract | Required | Required |
| Atomicity of `commitAcceptance` | Required (single-writer file discipline; write-then-fsync) | Required (trivial in-process) |
| Sequence counter survives restart | Required | Not applicable — no restart survival |
| Durability claims | Process-crash survival (DEC-09) | **None** (A4). Harness makes no durability claims; capability-wide guarantees (Plan §11) are scoped to durable adapters. |
| Shared adapter contract suite (P5) | Must pass | Must pass |

An adapter that cannot meet a row must not be registered — there is no degraded mode.

---

## 9. R8 hook (membership linearization — store side)

`RecipientSnapshot` carries, for room sends, an opaque
`membership: { authority: string, revision: string, resolvedAt: Timestamp }` supplied by
the membership seam at resolution time. The store stores it verbatim inside the
acceptance transaction — the snapshot and its membership revision are frozen together
(I5). What the revision *means*, and how the membership authority linearizes it, is the
membership seam's contract — **R8 stays open until Step 3b**; this section guarantees the
store side cannot lose or mutate it.

---

## 10. Work-item disposition

| Item | Status |
|---|---|
| R7 (DEC-19 order scope, cursor, DEC-10 reconciliation) | **CLOSED** — §3 |
| R6, Step-3 half (store failure vocabulary exists and is typed) | **CLOSED** — §6. Step-2 half (public outcome schemas) open, now unblocked |
| R8, store side (snapshot carries membership revision atomically) | **CLOSED** — §9. Membership-seam side open, owned by Step 3b |
| DEC-18/19/20/21 semantics made contractual | **CLOSED** — §2, §3, §7 |

**Step 3a closes here.** Next: Step 2 (pass-2 schemas) — R1–R5, R9–R13, freezing error
schemas against §6.
