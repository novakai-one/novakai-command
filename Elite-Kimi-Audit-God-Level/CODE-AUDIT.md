# Novakai-Command — Elite Code Audit

**Target:** `/Users/christopherdasca/Programming/Novakai-Command`
**Size:** ~41,800 LOC · 299 code files · 90 test files (src test:source ratio 1:2)
**Method:** Read-only. Six parallel deep passes (server/terminal, stores/scripts/gates, messaging/transcript/missionView, frontend components, frontend lib/shared/desktop, cross-cutting metrics), plus the repo's own gates run fresh (`tsc --noEmit` clean; lint ratchet 200 warnings vs baseline 201), plus independent spot-checks of the four most damning claims. Every claim below has a file:line you can open.
**Date:** 2026-07-23

---

## 1. Scorecard (before a single excuse)

| Axis | Score /10 | One-line verdict |
|---|---|---|
| Coupling & module depth | **5.3** | Real seams exist, but two god-objects sit at the roots |
| Duplication | **3.3** | The dominant disease — measured, admitted, and drifting |
| State discipline | **6.2** | Good instincts (derived-not-stored), leaks at the edges |
| Failure handling | **4.2** | "Best-effort by default" — failures vanish silently |
| Testability | **6.5** | A genuine strength, unevenly distributed |
| Naming & honesty | **7.3** | The comments tell the truth — rare and valuable |
| **Composite** | **5.5 / 10** | **Strong journeyman. Not amateur. Not elite.** |

Plain version: this is not amateur code. Amateur code doesn't have a 1:2 test ratio, a CAS-guarded store engine, or comments that confess their own debts. But it has one deep cultural habit that keeps generating the same bugs in new costumes, and until that's fixed, every new feature re-forks the fork.

---

## 2. What's genuinely good (so you know the scale is calibrated)

- **`src/backend/stores/` is elite.** A 975-LOC pure validation engine behind a 61-line typed facade, sha256-bracketed audits, a pid-liveness lock, crash-safe CAS replace with byte-verify and read-back-verify, three typed error classes, ~201 test asserts, zero module-level mutable state. This is what the rest of the repo should look like.
- **Test coverage is real.** 1:2 test-to-source ratio; view-models (`messages/model.ts`, `timelineModel.ts`) are pure with twin test files; the store engine has crash-injection seams.
- **The comments are honest.** Debts are labeled ("recorded DRY debt", "ponytail:", "SECURITY DEBT (M2)"), rulings are cited, dead code carries the decision that killed it. Zero TODO/FIXME litter. Most codebases lie to you; this one doesn't.
- **`tsc --noEmit` passes clean** with `strict: true`. One `any` in the entire server core.
- **The `TerminalRuntime` interface + host protocol is a clean seam**, and the Electron shell (`desktop/main.cjs`, 168 LOC) is a model of restraint.

The problem is not talent. The problem is a pattern.

---

## 3. The root problem, in plain language

**When this codebase needs something it already has, it copies it instead of sharing it — and the copies are already drifting into bugs.**

The repo's "fence" culture (keep each mission's diff inside its own territory) made copy-paste the *approved* move. The result, counted across every subsystem:

- **8 separate hand-rolled JSONL readers** — same "split, trim, try-parse, skip torn line" loop, written 8 times, with divergent failure semantics (`messaging/store/index.ts:115`, `rooms/index.ts:65`, `mailbox/index.ts:46`, `confirm/index.ts:38`, `transcript/parser.ts:142`, `transcript/repoIndex.ts:99`, `missionView/sources/index.ts:138` and `:179`)
- **3 parallel messenger implementations** in the frontend (studio tunnel, workspace/messages, missionControl) with proven drift: 3 lane-restore copies (only one correct), 4 send paths over 2 different endpoints, 3 unsynchronized dismissal sets
- **2 full implementations of the 14-method `TerminalRuntime`** (`terminal/manager.ts` vs `terminal/host/client/index.ts`), copy-pasted defensive copies included
- **5 hand-rolled "resilient fetch" loops** in `frontend/lib`, each with different failure behavior — one of them can wipe your saved canvas (see below)
- **4 reimplementations of `pidAlive`** — and they disagree: the engine treats `EPERM` as *alive* (correct); the watchdog returns *dead*, so it files false "seat looks dead" alerts for exactly the case the engine engineered against
- **6 reimplemented CLI arg-parsers**, 3 copies of `requireText`, 4 ref-predicate helpers, 2 `stringOrNull` copies that disagree about whitespace, duplicated env defaults, duplicated timing constants "by design"

**The smoking gun** — the one example that proves the whole thesis: `missionView/index.ts:30-33` carries a correction comment, written after a real bug, saying *"compare PARSED instants, never the raw strings — mixed offsets sort wrong lexically."* And in the sibling module, `missionView/snapshot/index.ts:145`, the timeline sorts with `left.timestamp.localeCompare(right.timestamp)` on raw strings. **The team found this bug, fixed it, wrote the lesson down — and the identical bug lives one directory over, because the fix was a local patch to a local copy instead of a shared primitive.** That is the entire audit in one sentence.

The duplication isn't cosmetic. It's a bug generator with a production schedule.

---

## 4. The five violated principles

### Principle 1 — DRY / Single Source of Truth — Score 3.3/10

Covered above. The counts: 8 JSONL readers, 3 messengers, 2 runtimes, 5 fetch loops, 4 pid checks, 6 arg parsers, 4 upsert-by-key helpers, 3 rail-width persistence schemes, 27 direct localStorage sites across 8 component files. At least 14 distinct duplication clusters in `scripts/` alone, with the debt *admitted in the source* (`nvk-mission.mjs:121-124`: "the shared scripts/ lib is recorded DRY debt"). Several copies have already drifted into behavioral differences: the pid-liveness fork, the `stringOrNull` whitespace fork, the three lane-restore semantics fork.

### Principle 2 — Failure handling is designed, not defaulted — Score 4.2/10

The codebase's immune system is built to *tolerate* failure silently. **~45 swallowed-error sites** in non-test code. The worst, verified by hand:

- `canvasEngine/index.ts:85-94` — any load error (even a transient network blip) returns `emptyArchitecture`, and since `save()` PUTs the in-memory doc, **a failed load followed by a save overwrites the persisted canvas with an empty document.** That's data loss by default.
- `agent/index.ts:71` — `runAgentLoop(...).catch(() => {})`: agent execution failures vanish entirely.
- `components/index.tsx:200-277` — six `.catch(() => {})` in the app shell's fetch effects; a dead backend is indistinguishable from empty data.
- Three Express async handlers with no try/catch (`server/index.ts:332,338`, `agents.ts:339`) — a rejection hangs the client and raises an unhandled rejection.
- `nvk-agent.mjs:169` — a dead `.catch(() => null)`: `findAgent` exits the process rather than rejecting, so the documented "mailbox an offline agent" fallback can never run. The code lies about its own behavior.

The standard already exists in-repo: `missionView/sources` converts every read failure into a visible, provenance-carrying `ReadIssue`. One subsystem knows how. The habit never spread.

### Principle 3 — Deep modules, shallow roots — Score 5.3/10

The composition roots are gravity wells:

- `components/index.tsx` (`DashboardShell`, 558 LOC) — 25 imports, owns the websocket, 6 fetch effects, routing for 9 views, 3 resize columns, and exports types the whole tree imports *from the app shell*.
- `server/index.ts` (`ServerController`, 568 LOC) — composition root + owner of two HTTP/WS server pairs + 5 route families implemented inline + 11 inline env-var reads. It also hands its private socket Set **by reference** to another class (`index.ts:140`) — shared mutable state neither side owns.
- `tunnelModel/index.ts` (395 LOC) — 7 responsibilities: lane algebra, mention detection, HTTP transport, ws lifecycle, React hooks, room rostering, reconnect policy.
- `transcript/parser.ts` (465 LOC) — parser + token accounting + fs discovery + a 100ms file-watcher in one file.

Meanwhile `stores/` proves the team can build a deep module: tiny interface, hard semantics underneath. The roots never got the same treatment.

### Principle 4 — One contract, one direction — Score (folded into axes) 

- Wire types are **mirrored by hand** instead of shared: `tunnelModel/index.ts:17` keeps a "Frontend mirror of src/backend/messaging/types.ts" — while `src/shared/` exists *for exactly this* and was bypassed. Drift between the copies compiles cleanly.
- The "frozen" wire protocol in `agentSocket/index.ts:38-44` is enforced by a comment, with a `[prop: string]: unknown` catch-all and nine `as` casts at the busiest boundary.
- Features import sideways: `workspace/missionControl` imports components from `studio/chat`; `workspace/messages/thread` imports from `studio/chat/mention`. The "rebuild that replaces studio chat" depends on studio chat.
- The terminal layer imports upward: a PTY manager depends on transcript encoding (`terminal/manager.ts:5`).
- A `// KEEP IN SYNC` comment spans three theme files — drift maintained by convention where a single source would compile-enforce it.

### Principle 5 — The gates must see the code that matters — Score: the meta-failure

The quality machinery is theater where it counts most:

- **The most correctness-critical code in the repo is invisible to the gates.** `tsconfig.json` includes only `src/`; eslint covers only `src/**/*.{ts,tsx}`. So `scripts/` (10 operator CLIs), `tools/`, and the entire store engine (`src/backend/stores/*.mjs`, 2,111 LOC — the system of record) have **zero typecheck and zero lint coverage**.
- The lint gate is a **count-only ratchet**: 200 warnings vs a baseline of 201, and its own header admits violations can migrate between files under a fixed count. `stores-baseline.json` grandfathers 57 violation fingerprints.
- Test seams pollute the production API: `setBackoffForTest` lets any caller mutate global reconnect policy (`agentSocket/index.ts:317`); `mountFeed`/`watchRooms` are exported "for the reconnect-wiring test".
- Zero `fs.watch` anywhere in the backend — every module named `watch/` polls on timers (100ms, 500ms), and the frontend polls REST every 1s **while a live WebSocket sits right there**.

---

## 5. The plan — amateur-to-elite, with numbers

Ordered by leverage. Each step is a redesign, not a patch, and each carries a measurable finish line. Before → after.

**Step 1 — Build the JSONL kernel (kills the bug factory).** ~1 week.
One shared module: tolerant reader, last-wins fold, mtime/size fingerprint cache, `ReadIssue` corruption channel, parsed-instant timestamp compare, typed-ref predicates. Make all 8 readers, the message/room stores, and missionView's sources thin specializations.
*Measures: JSONL readers 8 → 1 · ref predicates 4 → 1 · the snapshot:145 lexical-sort bug deleted by construction · Duplication 3.3 → 5+*

**Step 2 — Adopt a failure policy (stop the silent bleeding).** ~1 week, parallel with Step 1.
Rule: errors are values, surfaced or typed — never `.catch(() => {})`. Fix the three live hazards first: canvasEngine must *never* save after a failed load (load-failure ≠ empty doc); guard the 3 unguarded Express handlers; make the agent loop's failure land in the build record.
*Measures: swallowed catches ~45 → <10, every remaining one carrying a justification comment · unguarded async handlers 3 → 0 · data-loss paths 1 → 0 · Failure handling 4.2 → 7*

**Step 3 — One messenger, three skins (the frontend fork).** ~2 weeks.
A single `useMessenger()` hook owns selection, restore, unread, send, dismissals, scroll-seat; one transcript/composer pair parameterized by density. Messages, Mission Control, and the studio Tunnel become skins.
*Measures: messenger stacks 3 → 1 · lane-restore impls 3 → 1 · send paths 4 → 1 · dismissal sets 3 → 1 · deletes ~1,500 duplicated LOC*

**Step 4 — One resource factory + shared wire types.** ~1 week.
`createResource({ load, validate, liveFrames })` owns fetch-guard, staleness flag, refetch-on-reconnect — replacing the 5 hand-rolled loops. Move mirrored wire types into `src/shared/` with runtime validation at the socket boundary.
*Measures: resilient-read copies 5 → 1 · silent lib swallows 12 → 0 · wire-type mirrors 2 → 0 · `as` casts at the socket 9 → 0*

**Step 5 — Fix the gates (make the immune system real).** Days, not weeks.
Extend tsconfig + eslint to `scripts/`, `tools/`, and `*.mjs`. Replace the count-only lint ratchet with a fingerprint ratchet like the stores gate. Remove test-only exports from production modules (inject the seams instead).
*Measures: gate coverage 68% → 100% of production files · test-only production exports 6 → 0 · ratchet: count → fingerprint*

**Step 6 — Slim the roots.** ~2 weeks, after Steps 1–4 land.
Extract `DashboardShell`'s fetch effects and ws dispatch into hooks/modules; split `ServerController`'s 5 inline route families into hub modules like the well-behaved `projects/`/`canvas/` adapters; split `tunnelModel` along its 7 responsibilities; take `SessionWatcher` out of the parser.
*Measures: files >300 LOC violating the repo's own rule ~15 → <5 · DashboardShell imports 25 → <10 · env reads: one `BackendConfig` module, 18 sites → 1*

**Step 7 — Events over polling.** Opportunistic, with the above.
`fs.watch` for transcript/store changes; push over the existing WebSocket instead of 1s REST polling.
*Measures: `setInterval` watchers 13 → ~3 · fs.watch users 0 → the watch modules*

### Projected scorecard after Steps 1–5

| Axis | Now | After |
|---|---|---|
| Coupling & module depth | 5.3 | 7.5 |
| Duplication | 3.3 | 7.0 |
| State discipline | 6.2 | 7.5 |
| Failure handling | 4.2 | 7.5 |
| Testability | 6.5 | 8.0 |
| Naming & honesty | 7.3 | 8.0 (keep the culture, delete the lies) |
| **Composite** | **5.5** | **~7.6 — elite territory** |

---

## 6. Bottom line

The diagnosis is one sentence: **a team that clearly knows how to build elite modules — the store engine proves it — built a culture where copying was safer than sharing, and the copies are now generating bugs faster than the gates can see them.**

The fix is not a rewrite and not a hundred patches. It's five shared kernels (JSONL, failure policy, messenger engine, resource factory, gate coverage) that make the copied code *converge* — after which the drift class of bugs can't exist, because there's nothing left to drift from.

The honest comments, the test ratio, and the store engine say the craft is already in the building. The codebase just needs its own standards applied to itself.

---

*Audit produced read-only. Method: 6 parallel subsystem passes + repo's own gates + independent spot-verification of the four headline claims (all four confirmed: snapshot/index.ts:145, canvasEngine/index.ts:85-94, agent/index.ts:71, missionView/index.ts:30-37).*
