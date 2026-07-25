# Messaging — Elite Engineering Scorecard (post-S4 re-run)

**Scored:** 2026-07-25, working tree after slice S4 (Templates + failure
truth) — S1–S3 were sealed at `2e16709f`; S4 is complete but uncommitted at
scoring time. **Method:** `elite-scorecard.md` from the
`elite-codebase-engineering` skill — `dimension points = weight × rating ÷ 5`,
observed score only (no target points), unavailable measurements marked
**unmeasured**, never awarded.

**Verification baseline at scoring time:**

```
npm run build                       → tsc exit 0 (strict, no any/@ts-ignore)
npm test                            → 246 tests · 60 suites · 246 pass · 0 fail
node contract/check-map-drift.mjs   → NO DRIFT (43 modules, 4 traces)
```

**Post-scoring addendum (2026-07-25, S4 zero-context audit):** an independent
audit found ten defects (F1–F10) against this tree AFTER the scoring above —
falsifying three "none observed" claims below. All were disposed as
code/test/doc honesty (contracts frozen, contract JSON untouched). The
affected dimensions now record the found-and-fixed defects in their
failed-conditions notes, with the regression test names as evidence, per the
scorecard's own rules. Re-verified after the disposals:

```
npm run build                       → tsc exit 0
npm test                            → 253 tests · 60 suites · 253 pass · 0 fail (246 + 7 audit regression tests)
node contract/check-map-drift.mjs   → NO DRIFT
git diff --quiet on the contract    → clean (contract JSON untouched)
```

---

## 1. Weighted dimensions

### Capability ownership and domain authority — weight 15

- **rating: 5** · **weighted points: 15.0**
- **evidence:** one authority per durable fact — Messages/Threads/Deliveries/
  Attempts/Policies/Templates/Snapshots/Acceptances are authored only by the
  core through the store seam (`messaging/seams/store.ts`); membership truth
  stays with its external owner and is only *referenced* via the membership
  seam (DEC-04; `seams/membership.ts`, frozen `MembershipEvidence` on the
  snapshot). Branded, non-interchangeable IDs (`public/contract/generated.ts:28-44`).
  Projections never compete with authority: the subscription stream replays
  the journaled committed facts (`core/eventBus.ts`, `core/subscriptions.ts`).
  Group sends produce ONE Message in ONE Thread (DEC-05 —
  `tests/core/rooms.test.ts` "one Message to a team destination…").
- **failed conditions:** none observed.
- **required action:** none.

### Module depth and information hiding — weight 15

- **rating: 5** · **weighted points: 15.0**
- **evidence:** consumers learn only the door (`public/index.ts` — the ONLY
  importable surface; `tests/architecture/import-boundaries.test.ts` "no
  consumer test … imports capability-private modules"). Deep modules behind
  small interfaces: `core/decideSend.ts` is the single send-policy decision
  point (S4's template send enters through the SAME point —
  `core/sendPipeline.ts` shared executor); the store seam hides the entire
  atomic acceptance transaction behind one `commitAcceptance` (DEC-20).
  The door surface is exactly the frozen catalogue — no more, no less
  (`tests/contract/surface-manifest.test.ts` — updated honestly at S4: the
  full 8-command/9-query surface is now live).
- **failed conditions:** none observed.
- **required action:** none.

### Coupling and dependency direction — weight 15

- **rating: 5** · **weighted points: 15.0**
- **evidence:** machine-enforced direction — `import-boundaries.test.ts`
  "no capability module is reachable from consumers except through public/",
  "no import cycles anywhere in the capability graph", "adapters never
  import each other" (all green in the 246). The core imports only the
  contract and its seams (`core:` allowed edges = public/seams/core).
  Role→grant mapping lives in authority-adapter config, never core (DEC-07
  amendment; `adapters/authority-config.ts` DEFAULT_ROLE_GRANTS). Cross-
  capability access by contract only (P4 Mission Rooms references
  Threads/Messages by ID — `tests/capability/p4-mission-rooms.test.ts`).
  Zero new runtime deps in S4 (PTY adapter = `node:child_process` only).
- **failed conditions:** none observed.
- **required action:** none.

### Composability and second-host proof — weight 15

- **rating: 5** · **weighted points: 15.0**
- **evidence:** both integration modes serve the same core with no per-mode
  business logic (`composition/coreStack.ts` — one wiring; S4's template
  doors landed in both modes through it). Second host: P1 standalone
  messenger app, a separate package with zero messaging imports
  (`examples/messenger-cli/`, proven by `import-boundaries.test.ts` "the P1
  messenger app … has NO import path into messaging internals" and
  `tests/standalone/p1-messenger-app.test.ts`). External principals: P2/P3
  (`tests/standalone/p2-external-chief.test.ts`, `p3-two-chiefs.test.ts`).
  Capability-to-capability: P4. Independent harness: P6
  (`tests/harness/p6-in-memory.test.ts` — extended at S4 with the full
  template lifecycle on in-memory everything). Adapter swap: P5 (below).
- **failed conditions:** none observed.
- **required action:** none.

### Contract correctness and compatibility — weight 10

- **rating: 5** · **weighted points: 10.0**
- **evidence:** single machine-readable source (`contract/messaging-contract.json`)
  with codegen sha-checked fresh (`tests/contract/codegen-freshness.test.ts`);
  the 13-error catalogue, constants, enumerations, and the R12
  `templateBindablePaths` all cross from the source mechanically
  (`surface-manifest.test.ts` "the generated public types mirror the contract
  source"; S4 sources the R12 allowlist from `generated.ts`, never hand-copied —
  `core/templates.ts:isBindablePath`). Every external input is parsed from
  `unknown` at a door with typed `ValidationFailed` (`core/validate.ts`,
  `protocol/frames.ts`; MSG-021 tests). Idempotency: DEC-13/A5 proven incl.
  crash-retry (`tests/core/w2-idempotency.test.ts`,
  `tests/standalone/w2-crash-retry.test.ts` — SIGKILL in the commit→settle
  window); S4 template retries return the original acceptance even after
  retirement (`tests/core/templates.test.ts` "DEC-13: a same-key retry after
  RETIREMENT…"). Versioning: contractVersion/protocolVersion advertised by
  pre-auth GetCapabilities; `VersionUnsupported` negotiation tested.
  Compatibility rule (tolerate-unknown `dependency` values) documented in the
  contract source and exercised by the F9 `internal` mapping.
- **failed conditions:** none observed AT SCORING TIME — then falsified by the
  post-scoring audit (see the header addendum). Found-and-fixed: **F1** — the
  DEC-15 exact field match used `in`, walking the prototype chain, so a
  template declaring field `constructor`, sent without it, produced NO
  TemplateFieldMismatch (fixed: `Object.hasOwn`; regression:
  `templates.test.ts` "F1: the DEC-15 field match is own-key…"). **F2** — R12
  admitted `body.fields.__proto__`/`constructor`/`prototype` and the pattern
  literal `body.fields.<name>`; a `__proto__` render mutated the prototype
  and the value vanished silently (fixed: segment rejection in
  `isBindablePath` + Map-accumulated render map; regression: `templates.test.ts`
  "F2: R12 rejects prototype-pollution segments…"). The contract JSON was NOT
  touched — in S4 or in the audit disposals.
- **required action:** none remaining.

### Verification and failure resilience — weight 15

- **rating: 5** · **weighted points: 15.0**
- **evidence:** 253 tests / 60 suites green (246 at scoring + 7 audit
  regression tests). Contract tests (surface-manifest,
  s1-operations, codegen-freshness). Adapter contract suites: ONE store suite
  × {memory, jsonl} (`tests/adapters/store-contract.test.ts`), ONE transport
  suite × {memory, pty, ws-real-localhost} (new
  `tests/adapters/transport-contract.test.ts`). Architecture tests
  (import-boundaries). Failure injection: process-level SIGKILL crash-retry
  (W2), `effectLegDelayMs` window control, membership deadline breach (F8a),
  store-failure propagation (L1 paths in deliveryOrchestrator/orchestrator-
  internals tests). Recovery: DEC-21 sweep tests incl. crash-before-settle
  with blocked recipients (`rooms.test.ts` "crash before settle…"). State
  machine: retry/exhaustion, presence-gone budget accounting (F12), DND
  hold/release, in-flight effects (`delivery-retry.test.ts`, `w1-dnd-urgent`).
  Subscriptions: replay, overflow, backpressure, R3 filtering, auth-lost
  (`subscriptions.test.ts`). Failure truth: MSG-016 legs (new
  `tests/core/failure-truth.test.ts`). Integration proofs P1–P6 all green;
  P5 gained the NAMED PTY↔WS capability-level swap leg (audit F7 —
  `p5-adapter-swap.test.ts` "transport swap (the NAMED P5 pair, audit F7)").
- **failed conditions:** none observed AT SCORING TIME — then falsified by the
  post-scoring audit. Found-and-fixed: **F4** — PTY `open()` discarded
  attach()'s false, leaking a ghost Presence in the spawn→bind window (fixed:
  open raises onDisconnect into the single close path; regression:
  `presence-transport-pty.test.ts` "F4: open() surfaces the spawn→bind
  window…"). **F5** — PTY `closeAll()` did not await child death and had no
  SIGKILL escalation (fixed: SIGTERM → bounded unref'd grace → SIGKILL;
  regression: "F5: closeAll escalates…"). **Unmeasured:** branch/line coverage
  percentage (no coverage tooling in the package); the WS adapter's
  ping/pong liveness-timeout leg has no deterministic test (the PTY probe
  leg does — `presence-transport-pty.test.ts` "the signal-0 probe catches an
  out-of-band death").
- **required action:** optional — add a coverage gate; add a deterministic
  WS liveness-timeout test if the ws adapter grows probe config.

### Changeability and code health — weight 10

- **rating: 4** · **weighted points: 8.0**
- **evidence:** four vertical slices (S1→S4) landed additively through the
  same door with zero breaking changes to previously shipped surface — the
  observable change-amplification record. S4 itself: template support
  required changes in exactly the predicted places (one new core module, one
  shared-executor refactor, door parsers, dispatch) — no consumer-visible
  churn. No dead public surface (the manifest asserts exact equality of the
  door with the SESSION_MAP). Duplication controlled: the two send doors
  share ONE executor (`core/sendPipeline.ts`); the shared adapter suites
  share ONE factory module (`tests/adapters/adapterFactories.ts`).
- **failed conditions:** the 5/5 condition "adversarial verification … and
  no superseded path" holds, but **unmeasured**: cognitive complexity, churn
  concentration, and dead-export analysis have no tooling in this package —
  per the scorecard rules these are unknown, not clean zeros.
- **required action:** none blocking; if the package grows, add a
  dead-export/complexity check to `npm test`.

### Operability and security — weight 5

- **rating: 4** · **weighted points: 4.0**
- **evidence:** authenticated identity at a trust boundary (authority seam;
  grants snapshotted + revalidated, `core/session.ts` active/degraded/ended);
  authorization matrix enforced per operation (R3 tests; `template.write`
  enforced for template management — `templates.test.ts` "authorization:
  UpsertTemplate/RetireTemplate require the template.write grant"); bounded
  resources everywhere — page limit clamp, subscription buffer bound +
  overflow end, retry budget, bounded effect deadlines (both real
  transports), membership call deadline (F8), session grace; actionable
  failure truth (MSG-016 — typed `DeliveryUpdated` failure events with
  machine-readable reasons + `GetDelivery` per-recipient state);
  correlation via global sequence + opaque cursors and WS requestIds;
  graceful shutdown (`tests/standalone/f2-graceful-shutdown.test.ts`).
- **failed conditions:** the 5/5 condition includes metrics — **unmeasured:**
  no metrics emission exists in v1 (no declared target; not hidden).
  Post-scoring audit: **F3** — the "bounded resources everywhere" claim did
  not hold for ListTemplates: `limit` was overshot across filtered pages
  (limit:2 returned 3) and an omitted limit drained the store stream (fixed:
  hard page bound clamped to `constants.pageLimitMax` like GetMessages +
  remaining-capacity store reads; regressions: `templates.test.ts` "F3:
  ListTemplates honors limit as a HARD bound…" and "F3: an omitted limit
  returns ONE bounded page…").
- **required action:** none for v1; metrics are an additive operability
  decision (O-register) if an operator asks.

## 2. Total

| Dimension | Weight | Rating | Points |
|---|---:|---:|---:|
| Capability ownership & domain authority | 15 | 5 | 15.0 |
| Module depth & information hiding | 15 | 5 | 15.0 |
| Coupling & dependency direction | 15 | 5 | 15.0 |
| Composability & second-host proof | 15 | 5 | 15.0 |
| Contract correctness & compatibility | 10 | 5 | 10.0 |
| Verification & failure resilience | 15 | 5 | 15.0 |
| Changeability & code health | 10 | 4 | 8.0 |
| Operability & security | 5 | 4 | 4.0 |
| **Total** | **100** | | **97.0** |

**Elite threshold: total ≥ 90 AND every red gate passes → 97.0 with all red
gates green = ELITE (observed, post-S4).**

## 3. Red gates (scorecard §5 — every one checked, none hidden)

| Gate | Required | Observed | Evidence |
|---|---:|---:|---|
| Authorities for each durable fact | 1 | 1 | core-through-store-seam only (`seams/store.ts`); P4 proves a second capability references by ID without owning |
| Dependency cycles across capabilities | 0 | 0 | `import-boundaries.test.ts` "no import cycles anywhere" |
| Host-framework imports in capability core | 0 | 0 | core's only dep is `node:crypto`/builtins; `ws` appears in adapters/protocol only (ALLOWED_EDGES) |
| Cross-capability private imports | 0 | 0 | P4 stand-in capability imports the public door only (`tests/capability/`, architecture suite leg (a)) |
| Direct writes to another capability's store | 0 | 0 | membership seam is read-only resolution (DEC-04) |
| Durable relationships using display names | 0 | 0 | branded IDs everywhere; room join is the (authority, externalId) key (§11.4) |
| Caller-controlled trusted identity | 0 | 0 | no sender field exists anywhere; payload `from` fails the door (`templates.test.ts` "…same policy door" + send-rejections MSG-020) |
| External payloads without runtime validation | 0 | 0 | every door parses from `unknown` (`core/validate.ts`, `protocol/frames.ts`; MSG-021 tests) |
| Public imports from private implementation paths | 0 | 0 | architecture suite leg (a) + exact door manifest |
| Declared integration modes without contract tests | 0 | 0 | embedded (P6/harness/core suites) AND standalone (P1/P2/P3/ws-roundtrip) tested through the same contract |
| Critical failure paths with silent or untyped outcomes | 0 | 0 | 13-error typed catalogue; transport failures surface as typed Delivery state (MSG-016 suite); F9 internal mapping typed |
| Superseded production paths after migration | 0 | 0 | slices extended one path each; nothing superseded left behind |
| Required type-check or architecture gates omitted from CI | 0 | 0 | `npm test` = build (tsc strict) THEN tests incl. architecture suite — one command, no opt-out |
| Mandatory current-host scenarios passing | 100% | 100% | 246/246 at scoring; 253/253 after the audit disposals (F1–F5, F7 regression legs) |
| Mandatory second-host scenarios passing | 100% | 100% | P1 messenger-cli green (architecture suite + p1 test) |

**Domain-specific gates (delivery, per Plan §5):**

| Gate | Required | Observed | Evidence |
|---|---:|---:|---|
| G10/I11: `delivered` settled without a real adapter effect | 0 | 0 | effect-only settles (`deliveryOrchestrator.settleDelivered` on `effect` reports); transport suite asserts dead lanes never report effect |
| G7: accepted Messages that can disappear | 0 | 0 | DEC-09 commit-before-effect + DEC-21 sweep; W2 SIGKILL test; jsonl restart suite legs |
| R4: a blocked room recipient ever delivered | 0 | 0 | §11.7 terminal-at-commit + rooms.test.ts path A/B + crash legs; MSG-016 suite |
| G9: competing conversation-history copies | 0 | 0 | DEC-05 one Message/one Thread per send (rooms suite) |
| G3: sender identity from caller payload | 0 | 0 | door parsers reject unknown keys (MSG-020 tests) |

**Honest notes (not gate failures — documented v1 scope):**

- store-memory makes NO durability claims (A4); capability durability
  guarantees are scoped to durable adapters (Store-Seam §8 table).
- Delivery retry counters are runtime state; a restart forgets counts and the
  DEC-21 sweep re-drives (`deliveryOrchestrator.ts` header — documented
  limitation, consistent with A4).
- The `<1s push` intent (MSG-023) has no benchmark harness — **unmeasured**;
  the push path is proven functionally (W4, MSG-023 tests), not timed.
- WS ping/pong liveness-timeout leg is untested deterministically (see
  Verification dimension).

## 4. Design-principle cross-check (scorecard §4)

Coupling (additive slices, machine-checked direction), cohesion (one owned
outcome; template support concentrated in `core/templates.ts` + the shared
executor), separation of concerns (host/core policy/persistence/effects all
distinct), information hiding (door-only imports, machine-checked), single
responsibility (one decision point; one commit boundary), dependency
direction (adapters → core), DRY (contract JSON is the only source;
`adapterFactories.ts` is the only factory list), YAGNI (every seam has ≥2
adapters; `RateLimited` stays reserved, not built), least surprise (retired
templates read as TemplateNotFound exactly as the contract names it;
re-retire idempotent like ClosePresence), composability (P1/P4/P6 all green
through the same contract). No principle challenges the ratings above; no
hidden red gate found.

---

*Scoring rule reminder for the next re-run: observed evidence only, cite
test names / file:line / command output, mark unavailable measurements
unmeasured. Re-score after any contract or seam amendment.*
