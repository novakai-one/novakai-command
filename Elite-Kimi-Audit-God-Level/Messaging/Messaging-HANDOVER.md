# Messaging — Handover to the Next Agent

**Written:** 2026-07-24 by kimi-cli, at the end of Step 1 (decision ratification).
**Updated:** 2026-07-24 by kimi-cli — Step 3a (store seam contract) COMPLETE.
**Updated:** 2026-07-24 by kimi-cli — Step 2 (pass-2 schemas) COMPLETE.
**Updated:** 2026-07-24 by kimi-cli — Step 3b (remaining seam contracts) COMPLETE;
**all R-items (R1–R13) CLOSED**.
**Updated:** 2026-07-24 by kimi-cli — Step 4 (trace refresh + map) COMPLETE; next is
Step 5 (S1 build kickoff).
**Updated:** 2026-07-24 by kimi-cli — Step 5 (S1 build) COMPLETE and SEALED after
law-#6 audit + full remediation (`Messaging-S1-Review.md`). Next: slice S2 (Rooms)
per `Messaging-Plan.md` §18, or Chris's redirection.
**Updated:** 2026-07-24 by kimi-cli — slice S2 (Rooms) COMPLETE and SEALED after two
law-#6 audits + full remediation (`Messaging-S2-Review.md`). Exit condition P4 met.
Next: slice S3 (Attention — mostly built in S1; exit condition P1) per Plan §18.
**Updated:** 2026-07-24 by kimi-cli — slice S3 (Attention) COMPLETE and SEALED
(`Messaging-S3-Review.md`). Exit condition P1 met. Next: slice S4 (Templates +
failure truth; exit: full adapter suite + P5/P6 + scorecard re-run) — the LAST slice
in Plan §18.
**Updated:** 2026-07-24 by kimi-cli — slice S4 COMPLETE and SEALED
(`Messaging-S4-Review.md`). **The Plan §18 program is COMPLETE: S1–S4 all sealed,
all six proof scenarios (P1–P6) passing, 253/253 tests green, scorecard 97.0/100
ELITE (`Messaging-Scorecard.md`).** The capability awaits Chris's next direction
(integration into a host, or new requirements as numbered items per law #2).
**Amendment (2026-07-25, N1/D2):** the capability + contract moved to
`packages/messaging/` (contract source: `packages/messaging/contract/`). Where
this file map below says `messaging/` or `contract/`, read the new home. Run the
drift guard as `node packages/messaging/contract/check-map-drift.mjs`.
**You are:** the agent picking up post-program work. Read this first.

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
| `messaging/` | The S1 implementation: TS strict ESM package (`@novakai/messaging`). Public surface `public/index.ts` ONLY; codegen from `contract/messaging-contract.json` (law #3); store-memory + store-jsonl (mutation-queue atomic); embedded + standalone (WS, `ws` dep) composition roots; 158 tests | **Step 5 output — S1 sealed** |
| `Messaging-S1-Review.md` | Law-#6 audit of the S1 diff (verdict HIGH pre-fix: 3 severe, 9 moderate, 10 low) + full disposal record | Step 5 evidence |
| `Messaging-S2-Review.md` | Law-#6 audits of the S2-a/S2-b diffs (S2-a: HIGH pre-fix, R4 made literal via errata §11.7; S2-b: LOW-MODERATE) + disposal records | S2 evidence |
| `Messaging-S3-Review.md` | Law-#6 audit of the S3 diff (2 moderate, 3 low — all disposed) + MSG-009/010/015 coverage map + P1 proof record | S3 evidence |
| `Messaging-S4-Review.md` | Law-#6 audit of the S4 diff (2 moderate — prototype-chain defeats of DEC-15/R12, reproduced + fixed; 1 low-moderate; 7 low — all disposed) | S4 evidence |
| `Messaging-Scorecard.md` | Elite scorecard post-S4: 97.0/100, red gates evidence-checked, unmeasured dimensions marked; dated audit addendum | S4 output |
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
- ~~**Step 5 — S1 build.**~~ **DONE (2026-07-24)** — `messaging/` package: slice S1
  (direct lane: auth + 1-1 send/pull + durable acceptance + idempotent retry,
  embedded + standalone) built against the frozen contracts. Codegen from the
  contract JSON (law #3 holds mechanically, sha256-checked); store seam with
  memory + jsonl adapters (mutation-queue atomic, F1); single-decision-point send
  pipeline; R5 orchestrator; journal-sourced eventBus + subscriptions (R1/R2/R3);
  DEC-17 WS protocol; DEC-21 sweep (startup + periodic). Exit condition met:
  **P2 + P3 pass** (process-level, protocol-only external clients); W2 crash-retry
  proven with fault injection; P6 harness green. Law-#6 audit: verdict HIGH pre-fix
  (3 severely critical incl. store-jsonl concurrency atomicity, 9 moderate, 10 low)
  — **all disposed at the source**, record in `Messaging-S1-Review.md`; 158/158
  tests green post-remediation.
- ~~**Slice S2 — Rooms.**~~ **DONE (2026-07-24)** — membership seam +
  membership-config adapter (rosters in config never core, 3 s deadline wrapper),
  room sends (one resolveMembers per accept, R8 sender check from the same
  resolution, frozen recipient snapshots I5), room authorization R3 wired through
  queries + subscriptions (revocation stops facts, replay re-checks),
  ListThreadsForPerson end-to-end. Store-Seam errata §11.4–§11.7 (recorded
  amendments; contract JSON untouched): **§11.7 made R4 literal** — blocked room
  recipients commit TERMINAL `failed{blocked-by-contact-policy}` INSIDE
  commitAcceptance after the S2-a auditor reproduced two ordinary interleavings
  that delivered a blocked recipient. Exit condition met: **P4 passes**
  (Mission Rooms reference capability, both integration modes, integrity render
  from Messaging queries, ID-references-only persistence). Two law-#6 audits
  (S2-a: HIGH pre-fix, 10 findings; S2-b: LOW-MODERATE, 6 findings) — all disposed
  at source, record in `Messaging-S2-Review.md`; 194/194 tests green.
- ~~**Slice S3 — Attention.**~~ **DONE (2026-07-24)** — MSG-009/010/015 proofs
  closed (one genuine gap: MSG-009's held-but-pullable pull assertion; the rest was
  already covered and is cited in `Messaging-S3-Review.md`). Exit condition met:
  **P1 passes** — `messaging/examples/messenger-cli/`, a separate-package terminal
  messenger (ws only, zero messaging imports, child-process driven): token+URL
  provisioning, DEC-17 frames, own text UI rendered from published projections,
  inbox updating from push with ZERO queries issued (MSG-023), catch-up pull path.
  Law-#6 audit of the diff: 2 moderate + 3 low, all disposed at source. 198/198
  tests green; contract JSON untouched.
- ~~**Slice S4 — Templates + failure truth.**~~ **DONE (2026-07-24)** — templates
  live (R12 allowlist enforced at upsert AND render from codegen; SendFromTemplate
  crosses the SAME SendMessage door; revision CAS; retire one-way I10), failure
  truth proven (MSG-016/017: pushed journaled DeliveryUpdated failures + GetDelivery
  agree, replay re-delivers), PTY transport adapter (§4.3, injectable spawn, real
  `cat` smoke test), P5 (ONE shared transport suite × memory/PTY/WS + manifest +
  capability-level swap legs incl. the named PTY↔WS pair), P6 extended (template
  lifecycle in-memory). Scorecard: `Messaging-Scorecard.md` 97.0/100 ELITE, red
  gates evidence-checked. Law-#6 audit: 2 moderate (prototype-chain defeats of
  DEC-15/R12 — both reproduced by the auditor, both fixed with regression tests),
  1 low-moderate (ListTemplates page bound), 7 low — all disposed at source, record
  in `Messaging-S4-Review.md`; 253/253 tests green. **Plan §18 program COMPLETE:
  S1–S4 sealed, P1–P6 all passing, contract JSON never modified after Step 2.**

## Context you will not find in the files

- Chris's mental model is Slack/email: durable JSON Messages with IDs in Thread
  history; delivery = per-recipient notification state; relations between JSON
  objects. The design already matches this — keep it that way.
- The external Chief is the primary consumer to optimise for: pushed events in
  <1s, never polling. MSG-023 exists because the old app made chiefs run 20-minute
  mailbox-scan crons. Do not let pull-based thinking creep back in.
- "Team finished" aggregation is explicitly NOT Messaging's job (ratification §5
  boundary note). Messaging delivers events; the Chief's own tooling concludes.
