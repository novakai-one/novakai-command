# Messaging — Handover to the Next Agent

**Written:** 2026-07-24 by kimi-cli, at the end of Step 1 (decision ratification).
**Updated:** 2026-07-24 by kimi-cli — Step 3a (store seam contract) COMPLETE; next is Step 2.
**You are:** the agent executing Step 2 (pass-2 schemas) or later. Read this first.

---

## Where things stand

Step 1 of the pass-2 sequence is COMPLETE:

- `Messaging-Ratification.md` — all 17 original DECs ruled (12 accepted as-is, 5 with
  recorded amendments/clarifications from Chris), 2 new engineering DECs proposed
  (DEC-18 store put-if-absent, DEC-19 store sequence ordering), MSG-023 added
  (pushed delivery to connected principals — the anti-polling law), O1–O6 v1 defaults
  confirmed.
- `Messaging-Ratification-Review.md` — the zero-context adversarial review of the
  ratification (Codex, codebase-design lens): 15 SEVERE, 7 MEDIUM, 1 LOW, verdict
  "not safe to build against yet." Disposed in the ratification: 7 binding
  amendments (§9, A1–A7 — incl. new DEC-20 atomic acceptance transaction and
  DEC-21 recovery sweep) and 13 registered work items (§10, R1–R13) owned by
  named steps. **Amended sequence: Step 1 → Step 3a (store seam) → Step 2 (schemas)
  → Step 3b (remaining seams) → Step 4 (traces) → Step 5 (S1 build).** Steps do not
  close while their R-items are open.

## The file map (all in this directory)

| File | What it is | Status |
|---|---|---|
| `Messaging-Plan.md` | The pass-1 blueprint, §1–§21 (promise, requirements MSG-001..022, DECs, invariants, seams, walkthroughs, slices, traceability, open decisions) | Reference — do not edit without cause |
| `Messaging-Ratification.md` | The decision gate. Binding. | Step 1 output |
| `Messaging-Ratification-Review.md` | Adversarial review of the gate | Evidence |
| `Messaging-Store-Seam.md` | Store seam contract: atomic `commitAcceptance`, sequence ordering, failure vocabulary, recovery support | **Step 3a output — binding** |
| `Messaging-Map.html` | Visual module map (open in a browser; 40 modules, animated traces) | Update in Step 4 |
| `Messaging-Report copy.html` | Second visual variant of the map | Working copy |
| `Messaging-Report.html` | Older mermaid-based report | Superseded, kept for history |

## The laws (do not violate)

1. **Anti-inheritance:** NOTHING is carried over from the current Novakai-Command
   messaging implementation. It informed requirements only, never mechanisms.
   (Chris, 2026-07-24, absolute.)
2. **Schemas wait for acceptance** — ratification is the gate; pass-2 work derives
   from `Messaging-Ratification.md`, not from ad-hoc readings of the Plan.
3. **Single source of truth** — in Step 2, every contract shape is defined ONCE,
   machine-readably; docs/validators/map generate from it. Never hand-copy numbers
   into prose (the "12 vs 11 errors" drift is the cautionary tale — resolve it at
   the source in Step 2).
4. **Chris is a visual/spatial thinker** — do not hand him long prose to review.
   Decisions get batched with recommendations; silence = accepted. Keep the visual
   map current; it is how he understands the system.

## What happens next (in order — amended post-review)

- ~~**Step 3a — store seam contract FIRST.**~~ **DONE (2026-07-24)** —
  `Messaging-Store-Seam.md`. DEC-18/19/20/21 are now contractual: one atomic
  `commitAcceptance`, global sequence ordering with opaque cursors, typed failure
  vocabulary (§6 of that file — Step 2 freezes public error schemas against it),
  recovery-sweep support. R7 CLOSED, R6 store half CLOSED, R8 store side CLOSED.
- **Step 2 — pass-2 schemas. ← NEXT.** Property-level schemas for every shape: records
  (Message, Thread, Delivery, Presence, policies, templates), 8 commands, 9 queries,
  4 events, errors (resolve the 11-vs-12 count at the source), results — from one
  machine-readable source. Open R-items to close here: R1–R5, R9–R13. Honour A5
  (`IdempotencyConflict`), A6, R12's template allowlist. O6 settled: 32 KiB
  serialized Message JSON bytes (R13).
- **Step 3b — remaining seam contracts** (authority incl. role→grant config per
  DEC-07 amendment, membership incl. R8 linearization, presence-transport, clock).
- **Step 4 — trace refresh.** Add W4 (Chief subscribe push, MSG-023 — slice **S3**
  per A2) to Plan §16 and a fourth trace to the map; re-run §19 traceability.
- **Step 5 — S1 build kickoff.** Only after all R-items above are closed.

## Context you will not find in the files

- Chris's mental model is Slack/email: durable JSON Messages with IDs in Thread
  history; delivery = per-recipient notification state; relations between JSON
  objects. The design already matches this — keep it that way.
- The external Chief is the primary consumer to optimise for: pushed events in
  <1s, never polling. MSG-023 exists because the old app made chiefs run 20-minute
  mailbox-scan crons. Do not let pull-based thinking creep back in.
- "Team finished" aggregation is explicitly NOT Messaging's job (ratification §5
  boundary note). Messaging delivers events; the Chief's own tooling concludes.
