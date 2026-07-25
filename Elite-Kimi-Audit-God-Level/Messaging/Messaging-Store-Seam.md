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

---

## 11. Errata (added by Step 2, 2026-07-24 — same authority as §1–§10)

Three gaps surfaced when Step 2 froze the public contract against this seam. Resolved
here at the source (law #3):

1. **Committed-fact events are journaled with sequence.** `transitionDelivery`,
   `appendDeliveryAttempt`-settling transitions, and `putPolicy`/`putTemplate` writes
   each append a sequenced journal entry (same global sequence, §3) describing the
   state change — not only `commitAcceptance`. Without this, R1's replay-after-disconnect
   ("committed-fact events with sequence > cursor") could not deliver `DeliveryUpdated`
   or `PolicyChanged`, both classified committed-fact in the public contract.
2. **`getInbox` returns non-terminal Deliveries only.** §4's "held or undelivered only"
   reads precisely: Deliveries in `pending` or `held`. Terminal states (`delivered`,
   `failed`) never appear — so a room-send recipient blocked by contact policy (R4,
   terminal `failed` Delivery) is not served the blocked Message via the inbox.
3. **`AcceptanceRecord` persists `urgentDowngraded`.** The `duplicate` outcome of
   `commitAcceptance` (§2) returns the original acceptance *including* this flag, so an
   idempotent retry of a downgraded urgent send still carries the typed outcome
   (MSG-010 survives DEC-13 retries). The field is optional in the record schema —
   absent means no downgrade occurred.

---

**Errata 4–6 (added by Step 6 / slice S2-a, 2026-07-25 — same authority as §1–§10).**
Three further gaps surfaced when slice S2 (Rooms) implemented against this seam.
Resolved here at the source (law #3); the frozen contract catalogue (8 commands,
9 queries) is unchanged — all three are seam-level.

4. **Room Thread creation exists as a store op (`createRoomThread`).** §2.1 requires
   a room Thread to pre-exist, but §1–§10 defined no operation that creates one.
   Ruling:
   `createRoomThread(room: { threadKind: "team" | "mission", authority: string, externalId: string }) → StoreResult<Thread>`
   is a **get-or-create keyed by the room key `(authority, externalId)`** — one Thread
   per room, forever (the room analogue of DEC-03's canonical pair). Two concurrent
   creates produce exactly one Thread; the loser proceeds against the existing one
   (not an error — the same ruling as §2.1's direct get-or-create). The `threadId`
   is minted by the adapter via the clock/ID seam inside the mutation; the caller
   never supplies it — the durable join to the owning capability is the room key
   (G2), and the owner learns the minted threadId through reads (e.g. the S2
   `ListThreadsForPerson` query). **Failure vocabulary:** §6 unchanged — the only
   new reachable outcome is `StoreUnavailable` (persist failure); there is no
   `RecordNotFound` and no idempotency interaction. **Journaling:** the write is
   **not** journaled — §11.1 journals writes that feed committed-fact events, and no
   public event exists for Thread creation (subscription replay therefore neither
   needs nor gets one). Durable adapters persist the write in the op log like every
   other mutation: the op log is durability, the §11.1 journal is the
   event-projection feed — the two are distinct. **Who calls it:** no public command
   exists (the frozen 8-command catalogue stands) — creation is capability-internal,
   driven by the host capability that owns the room (Plan §15 P4's
   capability-to-capability shape). In v1 the membership adapter's room config
   declares the rooms at composition and the composition root provisions their
   Threads at startup through this op; §2.1's room pre-existence requirement is
   thereby satisfiable and `SendMessage` to a `thread:` address works unchanged.
5. **Per-person Thread listing exists as a store read (`listThreadsForPerson`).**
   The frozen `ListThreadsForPerson` query had no faithful seam read in §4 (the S1-b
   flag). Ruling: `listThreadsForPerson(personId) → StoreResult<Thread[]>` returns
   every DIRECT Thread whose canonical pair contains `personId`, plus EVERY room
   Thread (`threadKind` team|mission). Room membership filtering is **not** the
   store's truth (DEC-04: membership truth stays with its owner) — the core filters
   room Threads through the membership seam (`isMember`, Messaging-Seams §3.1) at
   request time, per R3. Committed state only. Ordering is creation order in the v1
   adapters and is **not contractual** (Thread carries no sequence field; §3 stays
   message-scoped).
6. **The frozen RecipientSnapshot is readable (`getSnapshot`).** Ruling:
   `getSnapshot(messageId) → StoreResult<RecipientSnapshot>` (`RecordNotFound` when
   absent). Motivation: the DEC-21 recovery sweep (§7) re-drives R4 room-send
   blocked settles, and the blocked set is durable ONLY on the committed snapshot —
   re-deriving it from CURRENT contact policy at sweep time would violate R4's
   "terminal AT ACCEPTANCE" and I5. The sweep reads the snapshot and settles each
   blocked Delivery `pending → failed` (`blocked-by-contact-policy`) through the §5
   CAS — CAS-idempotent under re-drive, and journaled per §11.1 so the failure stays
   observable (`DeliveryUpdated`, MSG-016).

---

**Erratum 7 (added by the S2-a audit remediation, 2026-07-25 — same authority as
§1–§10).** The zero-context adversarial audit of slice S2-a found R4 defeated in the
commit→settle window: blocked room Deliveries committed as ordinary `pending` and
settled `failed` only in the post-commit effect leg, so TWO ordinary interleavings
(no crash needed) delivered a blocked recipient — a presence-open re-drive inside
the window, and a DND-hold inside the window whose later release delivered after the
effect leg's blocked CAS lost with a swallowed `StateConflict`. The blocked
recipient's inbox also served the Message during the window. Ruling — R4's
"terminal AT ACCEPTANCE" is made LITERAL:

7. **Blocked Deliveries commit TERMINAL `failed{blocked-by-contact-policy}` INSIDE
   `commitAcceptance`.** The store reads the blocked set off the
   `AcceptanceInput.snapshot` it is already committing and stamps those Deliveries
   terminal in the same transaction that stamps thread/sequence — the
   zero-transition shape of the R5 machine's `pending → failed{policy-blocked}`
   ("Terminal AT ACCEPTANCE … no attempts are ever made"; the frozen contract
   already names the `blocked-by-contact-policy` reason, and the S2-a effect-leg
   CAS matched these same semantics — this erratum moves the identical outcome
   into the commit; the contract JSON and its state machine are unchanged).
   Consequences: no `pending` instant is ever observable for a blocked Delivery,
   so pending-state re-drives (presence-open, DND release, the DEC-21 sweep) can
   never see, hold, or deliver it; §11.2's inbox (non-terminal only) never serves
   the blocked Message at any instant; the effect leg needs no blocked CAS and the
   `StateConflict` swallow is gone. **Observability is preserved:** each blocked
   Delivery's terminal failure is journaled as a `DeliveryUpdated` entry in the
   same commit (§11.1, MSG-016) — the same committed-fact event the effect-leg
   CAS produced. **§11.6's motivation is superseded:** the sweep no longer reads
   the snapshot to re-drive blocked settles (there is nothing to settle — the
   commit already holds the terminal truth), and with it goes the sweep's
   `RecordNotFound → blocked=[]` laundering hazard; `getSnapshot` remains in the
   seam as the I5 evidence read (frozen recipient set + membership revision).
