# Messaging — Slice S3 (Attention) Review Record

**Written:** 2026-07-24 by kimi-cli, sealing S3.
**Scope audited (law #6):** the S3 diff (base `d7b159b8`): MSG-009/010/015 proof
closure + the P1 second-host proof (`examples/messenger-cli/` + driver + architecture
scan). The S3 builder dispatched a fresh 0-context adversarial auditor on the diff;
findings disposed at source before this seal; disposals spot-verified by the sealer.

## MSG proof coverage (Plan §6 criteria)

- **MSG-009** (DND → non-urgent held but pullable): one genuine gap found and closed —
  new test asserting `held{dnd-hold}` from acceptance AND the explicit GetInbox pull
  (§11.2). Other aspects already covered (cited, not duplicated).
- **MSG-010** (override grant both paths, typed): already covered — W1 tests 1–2
  (urgentDowngraded typed both ways), W2 persistence across retry (§11.3), rooms +
  harness suites.
- **MSG-015** (typed BlockedByContactPolicy): already covered — direct lane
  (send-rejections + P2 wire-level), room lane R4 (rooms tests incl. §11.7
  interleaving regressions).

## Law-#6 audit of the S3 diff — verdict: honestly proven, 2 moderate + 3 low

All disposed at source:

- **F1 (moderate)** app subscribe swallowed typed errors behind a 10 s generic
  timeout → error frames now correlated by requestId (auditor repro: ValidationFailed
  surfaces in 51 ms).
- **F2 (moderate)** test driver calls unbounded → per-call timeouts,
  reject-pending-on-child-exit, kill fallback.
- **F3 (low)** presence counter drift under at-least-once observations → projection
  keyed by Presence ID (duplicates idempotent).
- **F4 (low)** architecture scan top-level only → recursive, .mjs/.js/.cjs,
  node_modules skipped.
- **F5 (low)** example-scope limitations (backlog growth, disconnect handling, ended
  frames) documented in app header + README.

Auditor-cleared non-vacuous: the no-poll assertions (inbox fed only by pushed frames;
query-count stats catch any poll), [pushed] provenance first-source-wins,
PresenceChanged-on-quit race-freedom, room visibility via membership config.

## Exit condition (Plan §18, S3 row): **P1 passes**

`examples/messenger-cli/` — a SEPARATE package (own package.json, `ws` only, plain
.mjs, outside the messaging tsconfig graph), driven as a child process: provisions
identity via token + URL only, speaks DEC-17 frames with zero messaging imports
(architecture scan enforces), renders its own text UI from published projections,
inbox updates from push with ZERO queries issued (MSG-023), catch-up pull renders
[pulled]. Second-host composability (G13, MSG-022) proven; zero production-code
changes in the slice. **198/198 tests green; drift guard NO DRIFT; contract JSON
untouched. S3 SEALED.**
