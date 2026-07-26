# R-N4-1 Review — oversight.read: the owner sees agent↔agent DM lanes

**Sealed:** 2026-07-26 · branch `kimi/r-n4-1-oversight-read` · commits
`2592f032` (amendment) + `a966805e` (audit disposals) · contract **1.0.0 →
1.1.0** (additive amendment **A-R-N4-1**).

## What shipped

Chris ruled R-N4-1 YES (PR #72): the owner MUST see agent↔agent DM lanes,
which the ratified contract made party-only. The amendment adds one grant,
`oversight.read`, to the contract Grant enum:

- **Reads:** the holder passes `assertThreadMember`'s direct branch —
  GetThread / GetMessages / GetDelivery on any direct lane (queries.ts).
- **Lists:** a holder listing SELF gets the interleaved §11.5 list PLUS the
  foreign lanes appended (deduped by id); `policy.admin` acting for another
  keeps the pair-scoped read — oversight is a self-list privilege, never a
  leak of unrelated lanes.
- **Push:** `mayReadThread` / `assertReadable` direct branches pass for
  holders — unscoped subscriptions receive foreign-lane MessageCommitted /
  DeliveryUpdated (live AND since-cursor replay — one `factPasses` funnel),
  and explicit `threads[]` scope may name foreign direct lanes.
- **Store seam:** new `listDirectThreads()` — every direct Thread, unscoped
  (the §11.5 read is pair-scoped by design). One shared `StoreCore`
  implementation serves both adapters (memory + jsonl).
- **Host policy stays in the host:** the app's boot-minted human principal
  carries the grant explicitly (`humanConfig`); the package's
  DEFAULT_ROLE_GRANTS is deliberately unchanged, so no second host silently
  gains oversight (DEC-07).
- **READ-ONLY:** R4 party-only send rules untouched — the owner watches,
  he does not speak into lanes he isn't a party to.
- **Unchanged by design:** rooms (the owner is already in every roster,
  D-N3-1/2), PolicyChanged filtering (owner + policy.admin), presence,
  protocolVersion, schemaVersion.

## Decisions (D-R-N4-1)

- **D-R-N4-1-1:** the amendment is one additive Grant enum value
  (`oversight.read`) + authorization-string amendments on GetThread,
  GetMessages, GetDelivery, ListThreadsForPerson, Subscribe. Contract
  1.0.0 → 1.1.0; generated.ts regenerated via `npm run generate`, never
  hand-edited; the drift guard (43 modules, 4 traces) stays NO DRIFT.
- **D-R-N4-1-2:** the store seam gains `listDirectThreads()` — required
  because §11.5 is pair-scoped; without it the owner's thread LIST cannot
  see foreign lanes. Recorded here because the ruled scope named
  "assertThreadMember + subscription filtering" and lane visibility in the
  list is what the ruling actually means in the UI.
- **D-R-N4-1-3:** host policy in the host — the grant rides the app's human
  principal entry, not the package default role map (second-host test).
- **D-R-N4-1-4:** PolicyChanged / presence / rooms / sends unchanged.

## Audit (law #6 — fresh 0-context auditor, elite-engineering lens)

**Verdict: LOW.** The auditor machine-verified contract↔generated.ts
freshness, replay-vs-live filter funnel unity, room/send/PolicyChanged
branches untouched, and second-host containment. Five findings, all LOW:

- **F1 (disposed at source, RED-first):** the first implementation rebuilt
  the thread list directs-then-rooms for ALL callers. Restored the
  pre-amendment interleaved loop byte-identically; holder foreign lanes
  append after. Ordering pinned by a new interleaving test.
- **F2 (disposed at source):** the new read's error path could label a
  RecordNotFound with a personId in a threadId field — the pattern getInbox's
  L9 note repudiates. Now maps L9-style (CursorInvalid → ValidationFailed;
  everything else storeDependencyError).
- **F3 (disposed at source):** the grant's "direct lanes only" boundary was
  comment-asserted, not test-asserted. New tests: holder getThread on a
  foreign ROOM → NotAuthorized; explicit Subscribe scope naming a foreign
  room → the whole Subscribe fails.
- **F4 (partially disposed; debt recorded):** added the since-cursor REPLAY
  test (foreign-lane MessageCommitted replays to a holder). The jsonl
  close/reopen fold case for listDirectThreads is follow-up debt (below).
- **F5 (disposed at source):** corrupt-payload guard parity in
  listDirectThreads (`thread.direct` truthy, matching §11.5); duplicate
  import merged.

## Verification evidence (all personally re-run by the orchestrator)

- Package: `npm run messaging:test` → **263/263 + NO DRIFT** (253 at N5 →
  260 amendment → 263 disposals). New tests: `tests/core/oversight.test.ts`
  (8), `tests/adapters/store-contract.test.ts` (+1, runs on BOTH adapters).
  RED-first evidence captured for the amendment (4 of 5 failing pre-fix)
  and F1 (interleaved-order pin failing pre-fix).
- App: `npx tsx src/backend/messagingV2/userRoutes/index.test.ts` — the
  human principal authenticates WITH oversight.read; the user-threads route
  serves an agent↔agent direct lane; the human DM still sends 201.
- Root: `npx tsc --noEmit` clean; full src tsx sweep **90/90**; scripts
  sweep **7/7**; `npm run lint` 192 at baseline; `npm run stores:test` +
  `stores:gate` PASS; `npm run build` green.
- Live-fire (post-deploy): the human thread list + a live agent↔agent lane,
  verified against the deployed app (recorded in the PR body).

## Follow-up debt for N6+

- jsonl close/reopen fold test for `listDirectThreads` (audit F4 remainder —
  sound by construction: the same op-application path rebuilds the threads
  index the §11.5 read already survives restart on).
- Existing register (unchanged): journal fold growth (R-item if it bites);
  ExternalSessions allowlist timing; browser presence transport option; N1
  authority revalidate disk scan; bridge polish parked for N7.
