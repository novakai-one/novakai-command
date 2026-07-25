# Messaging — Slice S2 (Rooms) Review Record

**Written:** 2026-07-24 by kimi-cli, sealing S2.
**Scope audited (law #6):** two diffs — S2-a (base `581a72c9`, the rooms implementation)
and S2-b (base `377eea59`, the P4 proof). Two separate 0-context adversarial audits ran;
all findings disposed at source before each commit.

## S2-a audit (rooms implementation) — verdict HIGH pre-fix; 1 severe, 4 moderate, 5 low

- **F1 SEVERE — R4 defeated in the commit→settle window.** Blocked room deliveries
  committed as ordinary `pending`; presence-open and DND-release interleavings delivered
  a ContactPolicy-blocked recipient (reproduced two ways by the auditor, no crash
  needed). FIXED by making R4 literal — **errata §11.7**: blocked Deliveries commit
  TERMINAL `failed{blocked-by-contact-policy}` INSIDE `commitAcceptance`, journaled as
  `DeliveryUpdated` in the same commit; effect-leg blocked CAS and its StateConflict
  swallow removed. Regression tests failed pre-fix (red evidence captured), pass
  post-fix, on both store adapters.
- **F2** sweep laundered missing snapshot into "nobody blocked" — disposed by
  construction (the sweep's snapshot read removed; §11.7 makes it obsolete).
- **F3** sweep-blocked path never exercised — real torn-acceptance sweep test added.
- **F4** acceptance-time contact-eval smear — per-recipient reads parallelized;
  "acceptance time = decideSend evaluation, frozen at commit" documented.
- **F5** recipients deduped in core (contract `uniqueItems` enforced).
- **F6** report test-count corrected for the record (17 new, not 21).
- **F7** untracked-files hazard — committed with full-tree `git add`.
- **F8** membership deadline (3 s wrapper, one place in coreStack wiring), §3.4 adapter
  rename recorded in Seams §7, room-key control-char guard.
- **F9** membership revocation mid-subscription test (live push AND replay re-check).
- **F10** embedded root sweeps at startup.

Frozen-doc amendments this slice (all recorded, contract JSON untouched):
Store-Seam **§11.4** createRoomThread (get-or-create by room key), **§11.5**
listThreadsForPerson, **§11.6** getSnapshot (I5 evidence read), **§11.7** R4 terminal
at commit; Seams §7 amendment record (adapter rename, deadline, room-key hygiene).

## S2-b audit (P4 proof) — verdict LOW-to-MODERATE; 0 severe, 2 moderate, 4 low

- **F1** "structural anti-copy" overclaim — comments corrected to the real mechanism
  (view rebuilt from GetMessages every render); value-level assertion added
  (payloadSummary ≠ any posted Message body).
- **F2** DEC-13 idempotency untested + restart-unsafe counter — explicit durable
  eventId path + honest doc; retry leg (duplicate → same messageId, one message) and
  conflict leg (IdempotencyConflict) added.
- **F3** renderRoomView truncation — port adapters follow nextCursor to exhaustion.
- **F4** scanner limitations documented (tripwire, not proof; compiled-artifact scan is
  the backstop).
- **F5** wirePort typed errors preserved (TestWireError: name + fields + retryable).
- **F6** stale test name fixed.

Auditor's non-findings (hunted, cleared): the integrity render is NOT vacuous
(expected reconstructed from capability metadata, actual from Messaging's GetMessages
through the door); threadId learning honest per §11.4; no harness backdoors (the
stand-in sees only its narrow port); the import-boundaries edit weakened nothing.

## Exit condition (Plan §18, S2 row): **P4 passes**

`tests/capability/p4-mission-rooms.test.ts` — a real second capability (Mission Rooms)
with its own truth, crossing only the public surface in BOTH integration modes
(embedded + standalone WS), posting mission events to room Threads by ID, persisting
only ID references, rendering its room view from Messaging queries. MSG-002/003 shapes,
I5 immutability, R3/R4 authorization all proven. **194/194 tests green; drift guard
NO DRIFT; contract JSON untouched. S2 SEALED.**
