# Messaging — Slice S4 (Templates + failure truth) Review Record

**Written:** 2026-07-24 by kimi-cli, sealing S4 — the LAST slice in Plan §18.
**Scope audited (law #6):** the S4 diff (base `2e16709f`): templates (DEC-15/R12/I10),
failure-truth proofs (MSG-016/017), PTY transport adapter + shared transport suite +
P5, the scorecard (`Messaging-Scorecard.md`), map refresh.

## What S4 delivered

- **Templates:** R12 allowlist enforced at upsert AND render, sourced from codegen
  (law #3); SendFromTemplate renders then crosses the SAME SendMessage door (single
  decision point preserved); shared send executor with template load AFTER the
  idempotency pre-check (retry-after-retire → duplicate, never TemplateNotFound);
  revision CAS; retire is one-way (I10).
- **Failure truth:** pushed journaled `DeliveryUpdated` failure events + GetDelivery
  asserted to agree; replay re-delivers failures; §11.7 blocked failures observed
  from the commit.
- **P5:** ONE shared transport contract suite run unchanged against memory/PTY/WS
  (WS over real localhost sockets); manifest leg asserts every v1 adapter is covered;
  capability-level swap legs incl. the named PTY↔WS pair (added in remediation).
- **PTY adapter:** §4.3 obligations, injectable spawn, real `cat` smoke test.
- **Scorecard:** `Messaging-Scorecard.md` — 97.0/100 ELITE at scoring, all red gates
  evidence-checked, unmeasured dimensions marked honestly.

## Law-#6 audit of the S4 diff — verdict: do-not-seal pre-fix; 2 moderate, 1 low-moderate, 7 low

All disposed at source:

- **F1 (moderate)** DEC-15 exact field match defeated by the prototype chain
  (`in` operator; field `constructor` omitted → no TemplateFieldMismatch, reproduced
  against dist). FIXED: `Object.hasOwn` + regression test.
- **F2 (moderate)** R12 admitted `body.fields.__proto__`; render silently destroyed
  the value (reproduced). FIXED: forbidden-segment rejection (`__proto__`/
  `constructor`/`prototype` + the pattern literal) at both enforcement points;
  null-prototype render semantics; regression tests.
- **F3 (low-moderate)** ListTemplates over-returned (limit:2 → 3) and no-limit
  drained the store. FIXED: hard page bound + the standard pageLimitMax clamp;
  cursor walk lossless; regression tests (205-template proof).
- **F4** PTY open() swallowed bind failure → onDisconnect into the single close
  path. **F5** closeAll() SIGTERM→bounded grace→SIGKILL escalation. **F6** scorecard
  "none observed" claims corrected via dated addendum (history not rewritten).
  **F7** named PTY↔WS capability-level leg added. **F8** Plan MSG-016 stale
  `DeliveryFailed` event name — dated errata note at the source. **F9** package.json
  description current. **F10** node:child_process in the public barrel —
  accept-and-documented (v1 hosts are Node; alternative composition path verified).

Auditor-cleared (hunted, no finding): R12 core-owned fields unreachable; non-door
template planting blocked; I10 retirement one-way; DEC-13/A5 idempotency incl.
cross-door conflict and retry-after-revise; prior dispositions (R4 §11.7, F1 queue,
F9 error mapping) intact after the shared-executor refactor; shared transport suite
genuinely branch-free; red gates genuinely enforced.

## Exit condition (Plan §18, S4 row): full adapter suite + P5/P6 + scorecard re-run

All met: shared store suite ×2 adapters, shared transport suite ×3 adapters, P5
manifest + capability legs, P6 harness incl. template lifecycle, scorecard written
and audit-corrected. **253/253 tests green; drift guard NO DRIFT; contract JSON
untouched through the entire program. S4 SEALED — Plan §18 program COMPLETE
(S1–S4 all sealed).**
