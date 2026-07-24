# Messaging — Handover to the Next Agent

**Written:** 2026-07-24 by kimi-cli, at the end of Step 1 (decision ratification).
**Updated:** 2026-07-24 by kimi-cli — Step 3a (store seam contract) COMPLETE.
**Updated:** 2026-07-24 by kimi-cli — Step 2 (pass-2 schemas) COMPLETE.
**Updated:** 2026-07-24 by kimi-cli — Step 3b (remaining seam contracts) COMPLETE;
**all R-items (R1–R13) CLOSED**.
**Updated:** 2026-07-24 by kimi-cli — Step 4 (trace refresh + map) COMPLETE; next is
Step 5 (S1 build kickoff).
**You are:** the agent executing Step 5 or later. Read this first.

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
| `Messaging-Store-Seam.md` | Store seam contract: atomic `commitAcceptance`, sequence ordering, failure vocabulary, recovery support. **§11 errata** (Step 2): committed-fact events journaled with sequence; inbox = non-terminal only; `urgentDowngraded` persisted | **Step 3a output — binding** |
| `contract/messaging-contract.json` | THE single machine-readable source: 10 records, 8 commands, 9 queries, 1 subscription, 4 events, 13 errors, constants, delivery state machine | **Step 2 output — binding** |
| `contract/check-map-drift.mjs` | Law-#3 guard: machine-verifies every enumeration the map copies from the contract source. Run after any contract or map edit | **Step 4 output — drift guard** |
| `Messaging-Schemas.md` | Step 2 rulings doc: R1–R5, R9–R13, R6 closed; review record (15 findings disposed) | **Step 2 output — binding** |
| `Messaging-Seams.md` | Step 3b seam contracts: authority (incl. DEC-07 role→grant config), membership (R8 linearization), presence-transport (R1 transport half), clock/ID; review record (8 findings disposed) | **Step 3b output — binding** |
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
5. **Skills are mandatory (Chris, 2026-07-24; mirrored in `~/.agents/AGENTS.md`):**
   every agent on this project invokes the appropriate skills at session start,
   BEFORE acting — `elite-codebase-engineering` + `codebase-design` for the design
   discipline; superpowers `verification-before-completion` (no completion claims
   without fresh evidence) and `requesting-code-review`; `handoff` when
   closing a step. Every handoff document states which skills the receiver must apply.
6. **0-context auditor after EVERY step (Chris, 2026-07-24):** before a step is
   sealed, spawn a fresh zero-context auditor to pressure-test **only the diff since
   the last auditor**. The auditor must: look for what is wrong and all problems;
   point out engineering flaws; name the reasons the plan will fail; rate every
   finding low / moderate / severely critical; include key assumptions and a
   confidence % per finding; hunt logical errors and coding-standards errors; use
   the elite engineering design skill. It is not there to make friends. Findings
   are disposed AT THE SOURCE before the commit; the audit + disposal is recorded
   in the step's review record.

## What happens next (in order — amended post-review)

- ~~**Step 3a — store seam contract FIRST.**~~ **DONE (2026-07-24)** —
  `Messaging-Store-Seam.md`. DEC-18/19/20/21 are now contractual: one atomic
  `commitAcceptance`, global sequence ordering with opaque cursors, typed failure
  vocabulary (§6 of that file — Step 2 freezes public error schemas against it),
  recovery-sweep support. R7 CLOSED, R6 store half CLOSED, R8 store side CLOSED.
- ~~**Step 2 — pass-2 schemas.**~~ **DONE (2026-07-24)** —
  `contract/messaging-contract.json` (single machine-readable source, law #3) +
  `Messaging-Schemas.md` (rulings). **R1–R5, R9–R13, R6 all CLOSED.** Error
  catalogue resolved at the source: 13 (11 + `IdempotencyConflict` (A5) +
  `DependencyUnavailable` (R6)); `RateLimited` forward-reserved; O6 = 32 KiB as
  `constants.messageMaxBytes`. Zero-context adversarial review run (1 SEVERE,
  7 MEDIUM, 7 LOW — all disposed at the source, incl. 3 store-seam errata now in
  Store-Seam §11). Notable rulings: R4 room-blocked = per-recipient terminal failed
  Delivery; R2 subscription push is NOT a Delivery and is not DND-gated; R1 adds
  the `Subscribe` stream operation with sequence-cursor replay and bounded-buffer
  backpressure.
- ~~**Step 3b — remaining seam contracts.**~~ **DONE (2026-07-24)** —
  `Messaging-Seams.md`. Authority (grants snapshotted at auth + revalidate with
  degraded-state ruling; DEC-07 role→grant mapping contractually in adapter config,
  never core), membership (R8 CLOSED: fresh resolution inside every accept call,
  revision evidence frozen with the snapshot, sender ∈ members from the SAME
  resolution), presence-transport (R1 transport half CLOSED: `deliver`/`push`
  two-lane split, effect-only-on-real-effect G10, liveness callbacks → single
  presence-close path, push-lane buffer/overflow accounting), clock/ID (halt-class
  `DependencyUnavailable{clock}`; `dependency` field is open-typed — tolerate-unknown
  is the compatibility rule). **All R-items (R1–R13) now CLOSED.**
- ~~**Step 4 — trace refresh.**~~ **DONE (2026-07-24)** — W4 (Chief subscribe push,
  MSG-023, slice **S3** per A2) added to Plan §16 with the disconnect/cursor-replay
  leg; MSG-023 added to Plan §6 + §19; W1/W2 refined against the frozen contracts
  (DEC-18/20 choreography); §7/§20 statuses reconciled to Accepted; §17 store-memory
  label corrected (A4). Map refreshed: 43 modules (added `subscriptions`,
  `subscriptionPusher`, `recoverySweep`), 4th trace (t4), seam signatures updated to
  the frozen contracts. **Law-#3 guard added:** `contract/check-map-drift.mjs`
  machine-verifies every enumeration the map copies (run: `node
  contract/check-map-drift.mjs`). 0-context auditor (law #6): overall MODERATE, 10
  findings (0 severely critical) — all disposed at the source.
- **Step 5 — S1 build kickoff. ← NEXT.** All R-items closed; all traces green.
  Build slice S1 (direct lane: auth + 1-1 send/pull + durable acceptance +
  idempotent retry, embedded + standalone) against the frozen contracts; exit
  condition P2 + P3.

## Context you will not find in the files

- Chris's mental model is Slack/email: durable JSON Messages with IDs in Thread
  history; delivery = per-recipient notification state; relations between JSON
  objects. The design already matches this — keep it that way.
- The external Chief is the primary consumer to optimise for: pushed events in
  <1s, never polling. MSG-023 exists because the old app made chiefs run 20-minute
  mailbox-scan crons. Do not let pull-based thinking creep back in.
- "Team finished" aggregation is explicitly NOT Messaging's job (ratification §5
  boundary note). Messaging delivers events; the Chief's own tooling concludes.
