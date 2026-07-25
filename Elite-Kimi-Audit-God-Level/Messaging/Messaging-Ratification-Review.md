# Messaging — Ratification Pressure Test (Zero-Context Review)

**Date:** 2026-07-24 · **Reviewer:** Codex CLI 0.144.5, zero-context, read-only sandbox
**Lens:** codebase-design skill (deep modules, seams, information hiding)
**Inputs:** `Messaging-Plan.md` + `Messaging-Ratification.md` (pre-amendment)
**Instruction:** adversarial — hunt for what is wrong, classify SEVERE / MEDIUM / LOW.

---

## Verdict (verbatim)

> No — the gate is not safe to build against. The acceptance transaction, durable
> recovery handoff, subscription interface, authorization model, delivery state
> machine, and slice ownership are unresolved or contradictory; pass-2 schemas
> written now would encode arbitrary choices and force material redesign during S1.

## Disposition

All 15 SEVERE findings are addressed in `Messaging-Ratification.md`:
6 resolved immediately by amendments A1–A7 (§9), the remainder converted to
registered pass-2 work items R1–R9 (§10) with owning steps — nothing is left
"disguised as settled" (the Plan's own rule). MEDIUM/LOW findings are likewise
registered in §10.

---

## Findings (verbatim, deduplicated)

1. **SEVERE — Ratification state contradicts itself:** the file calls itself the completed acceptance gate and strikes Step 1 complete, yet DEC-18/19 remain `PROPOSED` while downstream work treats them as binding; schemas therefore still lack an accepted basis (Ratification §§0, 3–4, 7–8; Plan §7/G14).
2. **SEVERE — DEC-18 does not define an atomic acceptance transaction:** `put-if-absent` on the idempotency key is ambiguous about whether the key, original result, Message, Thread, recipient snapshot, and Deliveries commit together, leaving crash windows with a reserved key but no recoverable acceptance—or a Message without a key (DEC-18; DEC-09/13; W2).
3. **SEVERE — The Store seam remains shallow:** adding `put-if-absent` to `append/read/find` makes the core orchestrate persistence choreography instead of hiding atomic acceptance behind a deep module, so correctness leaks across the seam as pass-through logic (DEC-18; Plan §§13–14).
4. **SEVERE — Commit-before-effect has no durable recovery handoff:** a crash after Message/snapshot commit but before Delivery creation, event publication, or transport scheduling can permanently suppress delivery and MSG-023 push; "emit only after durable" prevents premature emission but does not guarantee eventual emission (DEC-09; MSG-019/023; G7; Plan §9/W2).
5. **SEVERE — Deterministic direct IDs do not eliminate the creation race:** two Persons sending concurrently can both attempt to create the same canonical Thread, but no atomic get-or-create or uniqueness-failure semantics exist outside DEC-18's unrelated message key (DEC-03; Plan §8).
6. **SEVERE — Public dependency failures have no contract:** Store commit failure, membership timeout/unavailability, authority failure, and ID exhaustion have no typed public outcomes, making G6 impossible; worse, pass-2 error schemas are scheduled before step-3 seam failure vocabulary (Plan §§5, 9, 14; Ratification §7).
7. **SEVERE — MSG-023 depends on a nonexistent interface:** `messaging.subscribe` appears only in prose; there is no subscribe operation, scope, cursor, acknowledgement, replay contract, duplicate policy, backpressure rule, or endpoint capable of catching up all missed event kinds after disconnect (MSG-007/023; Plan §9; Ratification §5).
8. **SEVERE — Event publication and addressed delivery are conflated:** the Plan's transport seam sends `Message + Presence`, while MSG-023 pushes `MessageCommitted`; it is undefined whether subscription push constitutes Delivery, whether DND suppresses that event, and whether generic subscribers receive recipient-addressed content (DEC-08/16; Plan §§9, 14; MSG-023).
9. **SEVERE — Read and subscription authorization is missing:** authentication is stated only for commands, several sensitive queries omit `NotAuthorized`, and `MessageCommitted` carries the full Message without recipient/thread filtering—an implementation could legally expose messages, delivery state, or Presence data globally (Plan §9: queries/events).
10. **SEVERE — MSG-023's slice assignment directly contradicts the Plan:** Ratification mandates subscription and WS push in S1, while Plan §18 places push subscriptions in S3; the trace map simultaneously assigns MSG-007 to S1 (Ratification §5; Plan §§18–19).
11. **SEVERE — DEC-14's clarification destroys its own deny-default:** nearly every valid external Person is necessarily provisioned, so "provisioned means implied-allowed" reduces deny-by-default to blocking identities that already fail as `UnknownRecipient`; credential issuance is also not recipient consent or a shared relationship (DEC-14; MSG-014/015).
12. **SEVERE — Room-send authorization and contact-policy composition are undefined:** the contract does not say whether the sender must be a room member, or whether one blocked recipient rejects the whole Message, produces a partial snapshot, or receives a failed Delivery—each choice contradicts some combination of MSG-002/003/015 (DEC-04/05/14; Plan §§6, 8–9).
13. **SEVERE — The in-memory adapter violates capability-wide durability:** it is described as a standalone default and interchangeable with JSONL while guarantees are claimed across every adapter, yet it cannot satisfy process-crash survival or durable acceptance (DEC-09/10; Plan §§11, 14, 17; P5/W2).
14. **SEVERE — Delivery semantics are insufficient to generate pass-2 schemas:** no authoritative state set or transitions define pending, held, retrying, failed, or delivered; no-presence handling, DND release, retry exhaustion, terminal failure, and first-success fan-out races are all unresolved (DEC-08/16; Plan §§9, 11–12, W3).
15. **SEVERE — Idempotency does not bind the key to request content:** reusing `(senderId, clientMessageId)` with a different address, content, priority, or template could silently return an unrelated original acceptance; no `IdempotencyConflict` outcome exists (DEC-13/18; MSG-018; Plan §9).
16. **MEDIUM — DEC-19 does not define a portable total order:** "monotonic" leaves global-versus-stream scope, strict uniqueness, gaps, restart recovery, transactional batches, and cursor encoding undefined; assigning authoritative order inside the adapter also conflicts with DEC-10's statement that ordering belongs to the capability (DEC-10/19; GetMessages/GetInbox).
17. **MEDIUM — "Membership at acceptance time" has no linearization point:** membership can change between external resolution and local commit, and no membership revision or snapshot timestamp is recorded to establish which set was authoritative (DEC-04/09; I5; MSG-002/003).
18. **MEDIUM — Presence lifecycle has two competing mechanisms:** Plan §8 says authentication automatically registers a Presence, while `OpenPresence` explicitly registers it; disconnect cleanup, stale-presence detection, duplicate opens, and ownership failures for `ClosePresence` are undefined (DEC-02/17; Plan §§8–9).
19. **MEDIUM — DEC-07's role amendment is semantically misleading:** the `Human > Chief > Manager > Executive Assistant` ordering has no meaning when the core checks only a Boolean grant, and no rule says whether a grant overrides every recipient—including higher-trust roles—or only a scoped set (DEC-07; Ratification §2).
20. **MEDIUM — The event durability rule contradicts Presence ownership:** all events are called committed facts emitted only after durable facts, but `Presence` is explicitly ephemeral, so `PresenceChanged` cannot satisfy the declared event invariant without persistence or an exception (Plan §§9–10).
21. **MEDIUM — DEC-15 allows templates to target protected Message fields:** "paths in the Message schema" does not exclude sender, IDs, thread, timestamps, schema version, or delivery metadata, potentially conflicting with DEC-11 and core-owned fields (DEC-11/15; SendFromTemplate).
22. **MEDIUM — O6 is neither settled nor implementable as written:** it is called a confirmed default, a recommended default, and adjustable during pass 2, while "32 KiB" does not specify UTF-8 content bytes, rendered template bytes, or serialized Message bytes (Ratification §§6, 8).
23. **LOW — `RateLimited` is contradictory dead surface:** v1 has no rate limiting, the global error catalogue retains it, and individual command failure lists omit it, leaving schema generation without one authoritative answer (Plan §§9, 21; Ratification §§6–7).
