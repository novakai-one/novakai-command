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

- The capability: `packages/messaging/` (moved from the audit workspace in N1
  per D2; contract source at `packages/messaging/contract/`) — embedded +
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

### Recorded amendments (law #2)

- **A-N2-1 (N2):** the N2 row's "deletes PtyDelivery + router direct path" is
  scoped to AGENT-originated traffic. The server-owned human route
  (`/api/user/messages` → SendApi → routeDirect → PtyDelivery → confirmer)
  survives until N3/N4 so Chris's UI never regresses; it dies there. Agent lanes
  never dual-run.
- **D-N2-1/2 (N2):** agent credential = durable agentId, env-injected at spawn
  (`NVK_AGENT_ID`); token=agentId is an accepted localhost-threat decision until
  N6's real issuance (N1 finding 3, ruled in `Messaging-N2-Review.md`).
- **D-N2-5 (N2):** team contact bootstrap is composition policy — the glue unions
  contact allowlists for team/mission co-members + the human principal with
  `defaultRule:'deny'` always re-asserted. DEC-14 stays the gate.
- **D-N3-1/2 (N3):** `#team` = room Thread `{team, authority:'fleet', externalId:'team'}`
  (fleet = active durable agents + human); the human principal is in EVERY roster
  the membership adapter serves (owner host policy).
- **D-N3-3/4 (N3):** room Thread provisioning is host-owned (boot before lanes +
  on launch); the browser #team shim needed ONE frontend line (`historyPath` →
  `?withAgent=%23team`) — the "zero frontend changes" claim is amended.
- **D-N3-5/6 (N3):** urgent-to-room stays route-rejected (old parity, core would
  allow); sender-receives-own-room-post is accepted core truth.
- **A-N3 (N3):** old free-floating rooms are browser-only archive (fold shim over
  `rooms.jsonl`); agent room routes deleted; the whole shim + surviving human-route
  stack dies in N4. Fleet push reaches co-members + chris by design (DEC-14).
- **D-N4-1..5 (N4):** browser = forwarded-frame subscriber over the existing app ws
  (per-connection sink/cursor/teardown; browser presence transport + DEC-17 are
  N5/N6 options); data plane moves, view layer survives under a strict honesty
  table; sends/reads are server-owned human sessions; UI rooms are capability
  rooms; presence UI = PeopleHub tiers (capability presence surface built, found
  unused, deleted).
- **R-N4-1 (RULED by Chris 2026-07-26: YES):** agent↔agent direct threads are
  party-only by the ratified contract; the human no longer sees agent↔agent DM
  lanes (rooms/#team fully visible — he is in every roster). Chris ruled the
  owner MUST see agent↔agent DM lanes. This is a CONTRACT amendment
  (assertThreadMember + subscription filtering) — scheduled as its own slice
  after N5 seals; not to be snuck into an unrelated branch.
- **D-N5-1..5 (N5):** watchdog process deleted whole (delivery checks zombie on
  the frozen journal; launchd job removed, plist archived); slack-mirror
  repointed to a capability client per D5 (user routes + browser ws dialect,
  cursor resume — the N7 bridge seed); sender failure-truth types ONE
  `[nvk-msg failed …]` line into the sender's PTY per terminal DeliveryUpdated,
  live-only subscriptions (cursor seeded at journal tip — no restart replays);
  frozen-archive readers (people liveness, missionView, nvk-status) fold the
  capability journal via `messagingV2/journal/`; nvk-oversee left (no journal
  contact).
- **D-N5-6 (N5 — Chris's ruling, overrides D-N5-1's accepted loss):** the
  watchdog's seat-watch is revived IN-APP (`terminal/seatWatch/`): quiet
  detection (watchdog.json boundaries honored), pendingPrompt sniff, dead-seat
  + Codex pid fallback, alert-once + silent first-tick baseline; alerts post to
  the fleet room through the capability as the durable `nvk-watchdog` ops
  identity — co-member of EVERY team/mission (audit finding 3: deny-by-default
  policy would otherwise terminally-fail most alert fan-out); state annotated
  on `/api/agents/:id/health`. Every tick guarded (a throwing tick logs and
  loses one pass, never kills the backend).
- **A-N5-1 (N5):** app-side stores schema allows an agent multiple team/mission
  refs (min 1, no max) — co-membership was always union semantics in
  `messagingV2/policy/`; the validator's REF-CARDINALITY contradicted it.
  App-side change; the frozen core is untouched.
- **D-BRIDGE-1 (2026-07-26):** D7 descoped. A v0 Slack bridge
  (`scripts/nvk-slack-bridge.mjs`, branch `kimi/slack-bridge-v0`) precedes N7:
  own workspace, human principal ONLY (agent→chris DMs appear in Slack;
  chris's Slack replies land in the capability). Owner: Chris's kimi
  orchestrator lane. **No N-slice builds Slack bridging** — N7 generalizes the
  v0 bridge (rooms, fleet identity, rate limits); it does not start from
  scratch, and no other Slack work begins before then. The one-way
  `nvk-slack-mirror.mjs` stays N5's concern (D5) and is unaffected.

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
| **N1 — Foundation** | Package at `packages/messaging/`; embedded in the backend composition root; authority/membership/store adapters wired to ObjectModel (amendment, N1 audit finding 13: the authority adapter reads ObjectModel directly — PeopleHub is itself a read hub over the same model, so an in-process HTTP hop would be ceremony; PeopleHub's join/liveness rules remain the N4 read-side reference); app gates + package suite in CI | nothing (additive) | Capability boots in-app; contract suite runs in app CI; `tsc`/lint/stores gates green |
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
  `node packages/messaging/contract/check-map-drift.mjs` while the map covers the contract.
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
