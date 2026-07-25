# Messaging Integration — N-Program Plan

**Status:** ratified by Chris 2026-07-25 ("Yes go"). Decisions D1–D8 below are binding
(silence = accepted, per law #4).
**Predecessor:** the Messaging pass-2 program — COMPLETE. S1–S4 sealed, P1–P6 passing,
253/253 tests, scorecard 97.0/100. Read `Messaging-HANDOVER.md` first.
**Visual roadmap:** `Messaging-Integration-Roadmap.html` (open in a browser).

---

## 1. The promise

Novakai-Command's messaging becomes the sealed `@novakai/messaging` capability —
pushed, durable, policy-true — inside the app, with the old surface deleted. Then the
door opens: external terminals integrate as first-class principals, a Slack bridge
connects the app's rooms to Slack channels, and finally a Novakai agent and Luke's
team share one cross-company channel with real delivery truth.

The capability core does not change. Everything in this program attaches through the
seams that already exist, or is a client of the published DEC-17 protocol. That is
the load-bearing fact of this plan: **N1–N8 add adapters and consumers, never core
code.** If a slice needs a core change, that is a new R-item and a contract amendment
— law #2 — not a quiet edit.

## 2. Current state (evidence)

- The capability: `Elite-Kimi-Audit-God-Level/Messaging/messaging/` — embedded +
  standalone composition roots; seams for store/authority/membership/presence-
  transport/clock; `ws` the only runtime dep; proof layer P1–P6.
- The surface being replaced: `src/backend/messaging/**` (28
  files), Messages tab + tunnel UI (~6,300 LOC), messaging REST routes +
  `message-envelope` broadcasts, PTY-typing delivery, transcript confirmer,
  `nvk-watchdog` / `nvk-slack-mirror` / `nvk-msg` conventions. **Full map with
  file:line anchors: `Messaging-Integration-CurrentState.md`** (the deletion +
  integration-point evidence base for N1–N5).
- App integration points: ObjectModel (`agents/teams/missions/threads.jsonl` — the
  single membership authority), PeopleHub directory, TerminalHost `submit` lane,
  `broadcastEvent` ws boundary, Express `registerRoutes` pattern.
- Known debt the new contract eliminates by construction: `POST /api/messages`
  trusts a client-supplied `from` string; agent reads are CLI polls; `#team` is
  pull-only; delivery confirmation is a 500 ms transcript scan.

## 3. Binding decisions

| # | Decision | Ruling |
|---|---|---|
| D1 | Old message history | **Archive read-only, start fresh.** Old envelopes lack policy/snapshot truth; importing would fake authority the records never had. |
| D2 | Package home | **Move to `packages/messaging/`** in N1 (one mechanical commit; the audit path was a workspace, not a home). |
| D3 | Agent-facing contract | **Keep `[nvk-msg …]` markers + the `nvk-msg` CLI working** as thin adapters over the capability. Re-briefing the fleet is expensive and buys nothing. |
| D4 | Roles | **Role→grant mapping lives in authority-adapter config** (DEC-07 pattern), keyed off existing data. No stores-schema change in v1. |
| D5 | Slack mirror + watchdog | **Repoint the mirror to a capability subscription; delete the watchdog's delivery checks** — the capability's own failure truth replaces them. |
| D6 | External chiefs | **Expose the DEC-17 endpoint from the app itself** — one less process, and external principals are the primary consumer. |
| D7 | Slack bridge shape | **A bridge daemon that is a CLIENT of Messaging over DEC-17** — same pattern as messenger-cli, but a service. Not an adapter inside the capability. Core untouched by construction. |
| D8 | Luke cross-company | **Start the Slack Connect conversation during Phase 1.** It is the only long-lead dependency code cannot control. |

## 4. Architecture

```
┌─────────────────────────────── Novakai-Command app ───────────────────────────────┐
│                                                                                   │
│  Frontend (Messages tab, Mission Control)                                         │
│      │  capability events/queries over the app ws (push — no polling)             │
│      ▼                                                                            │
│  Backend composition root (embedded mode)                                         │
│   ┌────────────────────────────────────────────────────────────────┐              │
│   │                 @novakai/messaging (SEALED CORE)               │              │
│   └────────────────────────────────────────────────────────────────┘              │
│      │              │                 │                     │                     │
│  authority-    membership-       presence-transport      store-jsonl              │
│  novakai       novakai           -terminal-host (PTY     (.novakai-command/       │
│  (ObjectModel  (ObjectModel       submit lane) +         messaging-v2/)           │
│   agents +     team/mission       -app-ws (browser push)                          │
│   PeopleHub)   refs)                                                            │
└───────────────────────────────────────────────────────────────────────────────────┘
            ▲ DEC-17 WS (external terminals, token + TLS)          ▲ DEC-17 WS
            │                                                       │
   External agents (any machine)                        Slack bridge daemon (D7)
                                                         ├─ lane 1: Slack → room Thread
                                                         └─ lane 2: subscribe → Slack
                                                                    │
                                                          Slack Connect channel
                                                          (Luke's workspace — N8)
```

Adapter contracts already proven: store (memory↔jsonl, P5), transport
(memory↔PTY↔WS, P5), external client over DEC-17 (P1/P2/P3), second capability as
consumer (P4). N-program adapters follow the same discipline: one shared contract
suite per seam, run against every adapter.

## 5. Slices

Each slice: build → repo gates green + package suite green → 0-context adversarial
audit of the diff (law #6) → findings disposed at source → review record → commit.
No slice seals with a finding undisposed.

| Slice | Capability after slice | Deletes | Exit condition |
|---|---|---|---|
| **N1 — Foundation** | Package at `packages/messaging/`; embedded in the backend composition root; authority/membership/store adapters wired to ObjectModel + PeopleHub; app gates + package suite in CI | nothing (additive) | Capability boots in-app; contract suite runs in app CI; `tsc`/lint/stores gates green |
| **N2 — Agent direct lane** | Agents send/receive 1-1 through the capability; PTY delivery via terminal-host transport adapter (submit lane); `nvk-msg` CLI re-pointed as thin adapter (D3) | Router direct path, `PtyDelivery`, `POST /api/messages` trust-the-`from` debt | Two live agents converse via capability in the running app; old path gone |
| **N3 — Rooms** | #team + rooms are room Threads; membership from ObjectModel refs | `RoomStore`, channel fan-out | Room send reaches exactly the snapshot members; blocked recipient terminally failed (R4/§11.7) |
| **N4 — Frontend** | Messages tab + Mission Control on pushed capability events + queries | `tunnelModel` messaging half, `message-envelope` dialect, tunnel UI | Inbox updates with zero REST polls; reconnect replays from cursor |
| **N5 — Kill the pollers** | Failure truth + push replace every scanner | watchdog delivery checks, transcript confirmer, mailbox-scan briefing | No interval touches the journal; failed deliveries surface as pushed `DeliveryUpdated` |
| **N6 — Open the door** | Token issuance/revocation; TLS/reachability; connect-your-agent flow | — | An agent spawned on a foreign machine connects, authenticates, messages — no manual step |
| **N7 — Slack bridge (own workspace)** | Bridge daemon (D7): one Slack channel ↔ one room Thread, echo-safe, identity stamped from Slack user IDs | slack-mirror script | Message Slack→app and app→Slack, both durable, no loops |
| **N8 — The Luke moment** | Slack Connect channel; cross-company room; Luke's team as external principals behind deny-by-default contact policy | — | A Novakai agent posts in the shared room → visible in Luke's Slack → reply lands in the app with delivery truth |

Phase gates: **Phase 1 = N1–N5** (rock solid in-app) → **Phase 2 = N6** (open door)
→ **Phase 3 = N7** (Slack) → **Phase 4 = N8** (Luke). Do not start a phase with the
previous one's slices unsealed.

## 6. Risks (named now, watched per slice)

- **N4 is the beast** — ~6,300 LOC of old frontend retires. Slice it internally
  (per-panel cutovers) if the diff gets un-auditable.
- **Echo loops** (N7/N8) — the bridge must drop its own posts; tested with a loop
  hunt before sealing.
- **Identity spoofing** (N7/N8) — identity stamped from authenticated Slack user
  IDs, never message text. Same law as the core contract.
- **Slack edit/delete vs immutable history** — renders as a follow-up note, never a
  mutation. Documented behaviour, tested.
- **Rate limits / size** — Slack throttling + 32 KiB cap; chunk or reply-too-big,
  decided at N7 contract time.
- **Cross-boundary ordering** — cosmetic interleaving differences; accepted,
  documented.
- **Governance** — bridged content leaves our infrastructure; deny-by-default
  contact policy is the gate and stays the gate.

## 7. Verification (standing, every slice)

- App gates: `npx tsc --noEmit`, every `src/**/*.test.ts` via tsx, `npm run
  stores:test`, `npm run lint`, `npm run stores:gate`, `npm run build`.
- Package suite: `npm run build && npm test` in `packages/messaging/` (253+ tests),
  `node contract/check-map-drift.mjs` while the map covers the contract.
- New behaviour: tests cross the public contract only; shared adapter suites run
  against every adapter; process-level proofs for anything external.
- Law #6: fresh 0-context adversarial auditor per slice, diff since last auditor,
  findings disposed at source, review record committed.

## 8. The laws (carried from the Messaging program — unchanged)

1. Anti-inheritance: the old implementation informs requirements only, never
   mechanisms. Replacement, not reuse.
2. Ratification is the gate; frozen artifacts change only via recorded amendments.
3. Single source of truth: the contract JSON; codegen; drift guard.
4. Chris is visual: batch decisions with recommendations; silence = accepted; never
   grill him; keep the visual map/roadmap current.
5. Skills are mandatory: `elite-codebase-engineering` + `codebase-design`;
   superpowers `verification-before-completion` + `requesting-code-review`;
   `handoff` when closing a slice.
6. 0-context adversarial auditor before any slice seals; findings disposed at
   source; recorded.
