# Messaging — Step 5 (S1 build) Review Record

**Written:** 2026-07-24 by kimi-cli, sealing Step 5.
**Scope audited (law #6):** the full S1 diff since the last pressure tester (Step 4,
`092d7616`) — the entire new `messaging/` package: codegen + contract types, clock/store
seams + memory/jsonl adapters, authority-config adapter, presence registry + transports,
decideSend/sendPipeline/deliveryOrchestrator, eventBus/subscriptions/recoverySweep,
DEC-17 WS protocol, embedded + standalone composition roots, and the proof layer
(contract surface, W2, P2, P3, P6, architecture tests).

## Auditor verdict (pre-remediation)

Overall risk: **HIGH — do not seal.** 3 severely critical, 9 moderate, 10 low findings.
The suite was 135/135 green at audit time; the three worst defects were invisible to it
by construction (synchronous memory adapter + no concurrency tests).

## Disposal summary — every finding disposed at source before sealing

### Severely critical

- **F1 — store-jsonl not atomic under concurrency** (check-then-act split by `await
  persist`): reproduced by the auditor (double-accept, split-brain direct threads,
  illegal delivered→failed journaled). FIXED: per-store mutation queue in
  `adapters/store-shared.ts` (`runMutation`) serializes every mutation on both adapters.
  Regression tests (F5) **failed pre-fix, pass post-fix** (empirical fail-before proof).
- **F2 — graceful shutdown deadlocked with any live client** (`server.close` awaited
  before `closeAll`). FIXED: close order inverted; SIGTERM guard added. Test races a
  3 s deadlock detector.
- **F3 — session `ended` not terminal; grace not clock-driven** (auth-lost sessions
  could resurrect via the revalidation timer; idle sessions never grace-expired).
  FIXED: `ended` terminal; grace enforced on the revalidation path.

### Moderate

- **F4 — W2 mid-flight crash window only optionally exercised.** FIXED: test-only
  fault-injection hook (`effectLegDelayMs`) lands SIGKILL inside the commit→settle
  window every run; torn-sweep assertion now unconditional.
- **F5 — zero concurrent-atomicity coverage.** FIXED: 3 tests in the shared adapter
  suite, run against BOTH adapters (the fail-before/pass-after evidence for F1).
- **F6 — subscribe replay→live merge race** (watermark regression, reordered frames).
  FIXED: per-subscription serialized offer chain.
- **F7 — replay overflow delivered `ended` before `started`.** FIXED: `started` always
  first, per R1 lifecycle.
- **F8 — per-connection pipelining race** (pipelined OpenPresence→Subscribe spuriously
  rejected). FIXED: per-connection serialized frame handling.
- **F9 — error laundering at the protocol edge + RecordNotFound S2 trap.** FIXED:
  internal errors map to `DependencyUnavailable{dependency:"internal", retryable:false}`
  (open-typed field, tolerate-unknown rule); commitAcceptance `failed{RecordNotFound}`
  maps to typed `UnknownThread`, never a throw.
- **F10 — ghost Presence in the accept→bind window** (leaked presences; deliveries
  burned retry budget to `failed` instead of staying `pending`). FIXED: bind to a dead
  socket fails honestly and closes the presence via the single close path;
  `handleClose` closes the connection's presence.
- **F11 — no periodic DEC-21 sweep.** FIXED: shared periodic sweep in `coreStack`
  (standalone default 60 s; embedded manual-by-default for determinism).
- **F12 — retry-budget accounting drift; exhaustion attempt lost; unbounded map.**
  FIXED: budget charges only real retry attempts; exhaustion attempt appended even on
  StateConflict; counter cleaned on terminal settle.

### Low

L1–L4, L6–L9 disposed (swallowed settleDelivered errors, eventBus pump guard +
listener-throw surfacing, contractVersion single-sourced, held presence observations,
cancellable unref'd scheduler, import-boundary scan tightened, cosmetic rot).
L5 (SendMessage latency includes the effect leg) and L10 (room-thread subscriptions
silently starve until S2) **accepted-documented** in the relevant file headers.

## Post-remediation evidence (fresh runs by the sealing agent)

- `npm run build` → exit 0 (tsc strict, zero type errors).
- `npm test` → **158/158 pass** (135 baseline + 23 regression tests), 40 suites.
- `node contract/check-map-drift.mjs` → NO DRIFT (law #3 guard).
- F1 mutation queue and F2 close order spot-checked at source by the sealer.

## Slice exit condition (Plan §18, S1 row)

**P2 + P3 pass** — process-level proofs: `tests/standalone/p2-external-chief.test.ts`
(MSG-004, MSG-023: external Chief, protocol-only client, pushed delivery without
polling) and `tests/standalone/p3-two-chiefs.test.ts` (MSG-005, MSG-019: two external
Chiefs converse; history survives both disconnecting). W2 crash-retry proven with
fault injection. P6 in-memory harness green. S1 SEALED.
