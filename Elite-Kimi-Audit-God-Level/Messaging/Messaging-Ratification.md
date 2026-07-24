# Messaging — Decision Ratification (Pass 1 → Pass 2 Gate)

**Date:** 2026-07-24 · **Author:** kimi-cli (Step 1 of the pass-2 sequence)
**Companion docs:** `Messaging-Plan.md` (the blueprint, §1–§21) · `Messaging-Map.html` (visual module map)
**Status of this document:** binding once reviewed by Chris under the silence-accept protocol (amendments only; silence = accepted).

---

## 0. Purpose and protocol

`Messaging-Plan.md` holds 17 load-bearing decisions (§7), all status **Proposed**.
The Plan's own rule: *"Schemas wait for acceptance."* This document is the acceptance.

Pass 2 (property-level schemas) MUST NOT start against unratified decisions, and S1
build MUST NOT start against unratified seams. This file is the single gate.

Protocol used: Chris gave verbal rulings on the judgment calls in conversation
(2026-07-24); the technical decisions were batched with recommendations.
Any line Chris amends wins over this document's recommendation.

**Anti-inheritance law (Chris, 2026-07-24):** nothing is carried over from the current
Novakai-Command messaging implementation. The current app informed *requirements only*
(via its ops record: chief mail latency, `learning_candidate-ready-needs-mail`), never
mechanisms. This capability is a clean-sheet build.

---

## 1. Batch A — technical decisions, ACCEPTED as-is

No taste involved; reversing any of these is objectively worse. One-line justification each.

| DEC | Decision | Why accept |
|---|---|---|
| DEC-01 | Addressable identity = durable **Person** (`person_<id>`); Presence is never an address | Runtime connections die; identity must not |
| DEC-02 | Person (durable) separate from Presence (ephemeral, 0..n) | A Person on two machines is still one Person |
| DEC-03 | Direct thread = canonical sorted Person pair, one per pair forever | Stable across restarts; no lookup race |
| DEC-05 | Group send = ONE Message in one Thread + one Delivery per recipient | No competing history copies (red gate G9) |
| DEC-06 | Messaging owns Thread/Message history | One authority per fact |
| DEC-08 | "delivered" = a real adapter effect occurred, never "written to journal" | The old app's central lie; forbidden (G10) |
| DEC-09 | Durable acceptance = Message + recipient snapshot committed BEFORE any adapter effect | Accept-then-crash loses nothing (MSG-019) |
| DEC-10 | Capability owns acceptance/ordering/idempotency/policy/outcomes; adapters own transport effect only | Behaviour must not diverge by host |
| DEC-11 | Sender identity = authenticated principal only; payload sender fields rejected | Trust never crosses from caller data (G3) |
| DEC-12 | Urgency = `priority: normal \| urgent` field on SendMessage, not separate commands | One path, one policy decision point |
| DEC-13 | Idempotency = client-supplied `clientMessageId` (unique per sender); retry returns original acceptance | Lost responses are normal; duplicates are not (requires DEC-18, §4) |
| DEC-16 | Multi-Presence fan-out: push to all live Presences; delivered settles on first real effect | A Person on two machines misses nothing |

**Batch A result: ACCEPTED (12 decisions).**

---

## 2. Batch B — judgment calls, RULED by Chris (2026-07-24)

### DEC-04 — Team/Mission threads → **ACCEPTED as-is**
Room Thread (`thread_<id>`, kind `team`|`mission`) referencing exactly one external
membership authority. Membership truth stays with its owner; recipient set resolved at
acceptance and frozen (I5). No amendment.

### DEC-07 — DND override → **ACCEPTED (grant model), with the roles amendment**
Messaging core checks ONLY the `priority.override` grant, verified via the Authority
seam. Urgent without the grant downgrades with a typed outcome — never silent.

**Amendment — roles (Chris):** override authority derives from organisational role.
Roles: `Human, Chief, Manager, Auditor, Worker, Executive Assistant, Aide`.

The role→grant mapping lives in the **authority adapter configuration, never in
Messaging core**. Rationale: the roles do not form a clean total order (Auditor is
orthogonal — watches, never overrides; EA is sideways-high-trust), so a baked-in
hierarchy would force wrong answers. v1 mapping (adapter config, one ordered list):

- **Hold `priority.override`:** Human > Chief > Manager > Executive Assistant
- **Never hold it:** Auditor, Worker, Aide

Changing the rule = editing one adapter config. Core untouched. Complexity stays
outside the capability (the adapter is replaceable by construction, §14).

### DEC-14 — Contact policy default → **ACCEPTED, with the provisioning clarification**
Per-Person ContactPolicy: allowlist + default rule (`deny` for unconnected external
Persons; members of shared Threads implied-allowed).

**Clarification (Chris's requirement — external terminals must be able to connect):**
**provisioning a Person credential with the Identity authority IS the deliberate
connection.** A provisioned external agent is implied-allowed; deny-by-default blocks
only *unprovisioned* strangers. This is how MSG-004 (externally spawned agent connects
and authenticates) and DEC-14 compose: the front door is deliberate but not bureaucratic.

### DEC-15 — Templates → **ACCEPTED as-is**
Templates declare fields bound to paths in the Message schema; sending validates
against that schema. Templates can't drift from the contract.

### DEC-17 — Standalone protocol → **ACCEPTED, with the direction-of-travel clarification**
Versioned JSON-over-WebSocket protocol + CLI adapter, both translating into the same core.

**Clarification (recorded because it confused the reviewer):** DEC-17 is **inbound** —
how an external process talks TO Messaging. The PTY transport is **outbound** — how a
message is delivered into an agent's terminal. They are unrelated layers. Concretely:
an external Chief connects over this WebSocket, authenticates (§8), receives a
Presence, and from then on is *pushed to* (see MSG-023, §5) — no PTY, no polling.

**Batch B result: ACCEPTED (5 decisions, 3 with recorded amendments/clarifications).**

---

## 3. DEC-18 (NEW) — Store seam atomicity → **PROPOSED, recommend ACCEPT**

**Question:** how is the idempotency check race-free?
**Decision:** the store seam gains an atomic **put-if-absent** primitive on the
`(senderId, clientMessageId)` key. The acceptance path uses it; a lost race returns
the original acceptance (DEC-13).

**Rationale:** the pass-1 seam exposed `append / read / find` — find-then-append is a
race. Two concurrent retries (or a retry racing the original) can both pass
`checkDuplicate` and both commit, violating I1. Without this, walkthrough W2 fails
under concurrency from day one, and S1 builds idempotency on sand.

**Invalid if changed:** idempotency mechanism, commit path, W2 proof.

## 4. DEC-19 (NEW) — Store ordering → **PROPOSED, recommend ACCEPT**

**Question:** "ordered reads" — ordered by what, under concurrent writers?
**Decision:** every committed record is assigned a **monotonic store sequence number
at append time** by the store adapter. All ordered reads (thread history, inbox,
journal scans) order by sequence. Wall-clock timestamps are display-only, never
ordering keys.

**Rationale:** "ordered" was undefined at pass 1. Two sends in the same millisecond,
or clock skew across adapters, make timestamp ordering a lie. Sequence-at-append is
the only ordering the single-writer store can actually guarantee.

**Invalid if changed:** query semantics (GetMessages, GetInbox), projections, W2/W3.

---

## 5. MSG-023 (NEW requirement) — pushed delivery to connected principals; polling never required

| ID | Behaviour | Proof obligation |
|---|---|---|
| MSG-023 | A connected principal (e.g. the Chief in an external terminal) receives committed-fact events **pushed** over its live Presence (DEC-16 fan-out) in near-real-time. Polling is a fallback for catch-up after disconnect, never the liveness mechanism. | W4 walkthrough passes: worker commits → `MessageCommitted` pushed to the Chief's Presence without any poll. |

**Why this exists:** the old app's ops record is the evidence. External identities were
mailbox-pull; chiefs ran 20-minute backstop mailbox-scan crons; a Manager held a
verified merge candidate silently and the mission stalled until the Chief found it by
reading transcripts (`learning_candidate-ready-needs-mail`, captains-log 2026-07-24).
That class of failure is designed out here: `messaging.subscribe` + Presence +
transport-ws push are the mechanism; events emit only after the fact is durable
(eventBus rule, §13).

**Boundary note:** "team finished" aggregation (noticing all workers done and telling
the Chief) is NOT Messaging's job. Messaging guarantees the events arrive; concluding
"the team is finished" is orchestration logic belonging to the Chief's own tooling.
Recorded so no agent gold-plates it into the capability.

**Slice:** S1 (subscribe + transport-ws + presence already in S1's surface).

---

## 6. Open-Decision Register — v1 defaults CONFIRMED

| # | Question | v1 ruling | Consequence |
|---|---|---|---|
| O1 | Retention/archival | **Unbounded (v1)** | Revisit at pass-3 persistence design |
| O2 | Rate limits on send | **None (v1)** | `RateLimited` error shape exists in the contract regardless |
| O3 | DND schedules | **On/off only (v1)** | Policy schema: `{ enabled: boolean }`; schedules are a later additive field |
| O4 | Webhook presence transport | **Deferred** | Not in the S1 adapter suite |
| O5 | Cross-machine federation | **Out of scope v1** | Single-authority deployment assumption stands |
| O6 | Message content size limit | **32 KiB (recommended default)** | Enforced as a schema constant at validation; `ValidationFailed` over the limit. Chief may adjust at pass 2 — it is one constant |

---

## 7. What this ratification unlocks (the remaining sequence)

1. ~~Step 1 — ratify decisions~~ ← **this document**
2. **Step 2 — pass 2 schemas:** property-level schemas for every contract shape
   (records, commands, queries, events, errors, results), written ONCE in one
   machine-readable source. Docs, runtime validators (`schemas/`), and the visual map
   all generate from it. This kills the doc-drift class (e.g. the map's "12 errors"
   vs the Plan's 11) permanently. **Note for step 2: resolve the error-count drift
   at the source — the catalogue lists 11 named errors.**
3. **Step 3 — seam contracts:** each of the 5 seams gets exact interface + error
   vocabulary + timeout/failure behaviour (incl. DEC-18/19 semantics on store).
4. **Step 4 — trace refresh:** add W4 (Chief subscribe push) to the Plan §16 and a
   matching trace to the map; re-run §19 traceability.
5. **Step 5 — S1 build kickoff.** Not before 2–4 land.

---

## 8. Sign-off record

- 2026-07-24 — Batch A accepted (recommended, silence-accept). Batch B ruled verbally
  by Chris: DEC-07 roles amendment, DEC-14 provisioning clarification, DEC-17
  direction clarification. DEC-18/19 proposed by kimi-cli (engineering additions,
  silence-accept). O1–O6 defaults confirmed. MSG-023 added from ops evidence.
- 2026-07-24 — Pressure-tested by a zero-context Codex reviewer
  (`Messaging-Ratification-Review.md`: 15 SEVERE, 7 MEDIUM, 1 LOW). Verdict: not yet
  safe to build against. Findings disposed via §9 amendments (A1–A7, binding) and
  §10 registered work items (R1–R13, owned by named steps). **The gate is safe to
  proceed against ONLY with §9 and §10 applied.**

---

## 9. Post-review amendments (binding, same authority as §1–§6)

**A1 — DEC-18 and DEC-19 are ACCEPTED.** Their PROPOSED status while Step 1 was
struck complete was a contradiction (review #1). Per the §0 silence-accept protocol
they are accepted with the refinements in A6/A7 and §10.

**A2 — MSG-023 slice corrected: S3, not S1** (review #10). Plan §18 owns this:
push subscriptions live in S3 (Attention). S1 remains the direct lane
(auth + 1-1 send/pull + durable acceptance + idempotent retry). W4 is written in
Step 4 against S3. Chris's priority is noted; the dependency order is real —
subscription push needs the presence/event machinery honestly, not bolted on.

**A3 — DEC-14 clarification corrected** (review #11). Provisioning grants
**addressability and connection right**, NOT send-right. A provisioned external
Person can authenticate and hold a Presence (Chris's terminal requirement — satisfied);
whether it may *send to a given recipient* is still decided per-recipient by that
recipient's ContactPolicy (allowlist + default rule). Deny-by-default is preserved;
"provisioned = implied-allowed" is withdrawn.

**A4 — store-memory reclassified** (review #13). `store-memory` is **test/harness
only**, never a standalone production default. The standalone production default is
`store-jsonl`. Capability-wide guarantees (§11) are scoped to durable adapters;
the harness makes no durability claims.

**A5 — Idempotency keys bind to request content** (review #15). The
`(senderId, clientMessageId)` record stores a hash of the full request content.
Same key + same content → original acceptance. Same key + different content → typed
failure **`IdempotencyConflict`** (added to the error catalogue; Step 2 resolves the
final count at the source — see R9).

**A6 — New DEC-20: acceptance is ONE store transaction** (reviews #2, #3, #5).
The store seam is deepened: `commitAcceptance(key, message, thread, snapshot,
deliveries) → SendAccepted | TypedError` — a single atomic operation that
get-or-creates the canonical direct Thread (fixing the DEC-03 creation race),
reserves the idempotency key (A5), and commits Message + recipient snapshot +
initial Delivery records together. The core calls one deep operation; it does NOT
orchestrate append/find choreography across the seam. `append/read/find` remain for
reads and projections.

**A7 — New DEC-21: recovery guarantees eventual effect** (review #4).
"Emit only after durable" prevents premature emission but not permanent suppression.
Therefore: any acceptance committed without its downstream effects (Delivery
creation, event emission, transport scheduling) is picked up by a **recovery sweep**
(on startup and periodically) that drives every committed acceptance to completion.
DEC-09 now reads: commit-before-effect AND eventual-effect.

---

## 10. Registered work items (nothing disguised as settled)

Each item names its owning step. Steps do not close while their items are open.

| ID | Sev | Item (from review #) | Owner |
|---|---|---|---|
| R1 | SEVERE | Define the `messaging.subscribe` contract: operation, scope/filter, cursor, replay-after-disconnect, duplicate policy, backpressure (#7) | Step 2 (contract) + Step 3 (transport) |
| R2 | SEVERE | Separate event publication from addressed Delivery: whether subscription push is a Delivery (no — define), DND interaction, and per-subscriber content filtering (#8) | Step 2 |
| R3 | SEVERE | Read/subscription authorization model: which queries require `NotAuthorized`; `MessageCommitted` payload filtered to threads the subscriber may see (#9) | Step 2 |
| R4 | SEVERE | Room-send rules: sender membership requirement; blocked-recipient composition — reject whole, partial snapshot, or per-recipient failed Delivery — one choice, written down (#12) | Step 2 |
| R5 | SEVERE | Authoritative Delivery state machine: states, transitions, triggers, no-presence handling, DND hold/release, retry exhaustion, terminal failure, fan-out first-success race (#14) | Step 2 |
| R6 | SEVERE | Typed public outcomes for dependency failures: store commit failure, membership timeout, authority failure — G6 demands they exist (#6). Note: Step 3 seam vocabulary must land BEFORE these error schemas freeze | Step 3 → Step 2 |
| R7 | MEDIUM | DEC-19 order scope: global vs per-stream, uniqueness, gaps, restart recovery, cursor encoding; reconcile "adapter assigns" with DEC-10 "capability owns ordering" (#16) | Step 3 |
| R8 | MEDIUM | Membership linearization: resolve membership INSIDE the acceptance transaction (A6); record membership revision/timestamp in the snapshot (#17) | Step 3 |
| R9 | MEDIUM | Presence lifecycle: ONE registration mechanism (recommend explicit `OpenPresence`; authentication alone does not register), disconnect cleanup, stale detection, duplicate opens, `ClosePresence` ownership (#18) | Step 2 |
| R10 | MEDIUM | DEC-07 grant semantics: grant is boolean per principal; the role order is adapter-config documentation, not core logic; state whether override is global or recipient-scoped (recommend: global v1) (#19) | Step 2 |
| R11 | MEDIUM | `PresenceChanged` reclassified: Presence is ephemeral, so this event is an **observation**, not a committed fact — the durability rule applies to committed-fact events only (#20) | Step 2 |
| R12 | MEDIUM | Template path allowlist: exclude core-owned fields (sender, IDs, thread, timestamps, schemaVersion, delivery metadata) from bindable paths (#21) | Step 2 |
| R13 | LOW | O6 settled as written: **32 KiB serialized Message JSON bytes**, enforced at validation; `RateLimited` stays in the catalogue as forward-reserved surface, absent from per-command failure lists until O2 activates (#22, #23) | Step 2 |

**Sequencing note (from review #6):** Step 3's store/seam failure vocabulary is a
prerequisite for Step 2's error schemas. Run Step 3's store-seam contract FIRST,
then Step 2 schemas, then the rest of Step 3. The §7 order is amended accordingly:
**Step 1 → Step 3a (store seam) → Step 2 (schemas) → Step 3b (remaining seams) →
Step 4 (traces) → Step 5 (S1 build).**
