# Messaging — Remaining Seam Contracts (Step 3b)

**Date:** 2026-07-24 · **Author:** kimi-cli (Step 3b of the amended pass-2 sequence)
**Authority:** derives from `Messaging-Ratification.md` §9/§10 only — work items R8
(membership side) and R1 (transport half), plus the DEC-07 roles amendment.
**Status:** binding seam contracts. Freezes against
[`contract/messaging-contract.json`](contract/messaging-contract.json) (Step 2 — THE
single source for shapes) and `Messaging-Store-Seam.md` (Step 3a, incl. §11 errata).
**Scope:** the four remaining seams — **Authority, Membership, Presence-transport,
Clock/ID**. The store seam is Step 3a (done). After this: Step 4 (traces + map),
Step 5 (S1 build).

Shape references (`PersonId`, `Grant`, `TransportKind`, `MembershipEvidence`,
`SubscriptionMessage`, …) name definitions in the contract source — they are never
re-defined here (law #3).

---

## 1. Seam summary

| Seam | Why the boundary is real | Core ← adapter crossing | v1 adapters |
|---|---|---|---|
| **Authority** | Trust boundary — identity and grants must come from outside caller data (G3, I4) | credential → Principal + grants | `authority-local` (token file); future SSO |
| **Membership** | External ownership — Team/Mission capabilities own that truth (DEC-04) | thread ref → recipient PersonIds + revision | `membership-novakai`; `membership-static` (test) |
| **Presence-transport** | Environmental effect (DEC-08) + independently replaceable infrastructure | presence → effect report; connection events → core | `transport-pty`, `transport-ws` (webhook deferred, O4) |
| **Clock / ID factory** | Required test substitution (deterministic state machines, Plan §14) | timestamps, branded IDs | `clock-system` + `id-random`; `clock-seeded` (test) |

An adapter that cannot meet its seam's obligations table must not be registered —
there is no degraded mode (same rule as Store-Seam §8).

---

## 2. Authority seam

Authenticates principals and vends verified grants. The core NEVER takes identity or
grants from caller data (DEC-11, G3) and NEVER knows what a "role" is (DEC-07
amendment — roles are adapter configuration, §2.3).

### 2.1 Operations

```
authenticate(credential: Credential) → AuthOutcome

AuthOutcome =
  | { kind: "authenticated", principal: Principal }
  | { kind: "rejected",  error: NotAuthenticated }        // bad/expired/unknown credential — public
  | { kind: "unavailable", error: DependencyUnavailable } // authority down — public, retryable

Principal = {
  personId:  PersonId,        // the ONLY sender identity source
  grants:    Grant[],         // verified at authentication, session-scoped
  sessionId: string,          // runtime handle for invalidation (never a durable ref, G2)
  expiresAt: Timestamp,
}

revalidate(sessionId) → { kind: "valid", principal } | { kind: "invalid" } | { kind: "unavailable" }
```

- Grants are snapshotted at authentication and held for the session. A grant change
  mid-session takes effect at the next `revalidate`.
- **Revalidation owner:** the composition root owns the revalidation timer in every
  integration mode — the standalone protocol adapters run it per connection, the
  embedded composition root runs it in-process (there is no protocol adapter to
  lean on). Triggers: on connect/session start and at `expiresAt`.
- `revalidate` returning `invalid` terminates any live subscriptions with
  `ended{reason: auth-lost}` (contract source, R1) and forbids further operations.
- `revalidate` returning `unavailable` puts the session in a **degraded** state —
  invalidity cannot be proven, so the session is NOT ended (cutting MSG-023 push
  during a transient authority outage would recreate the polling failure): existing
  subscriptions keep flowing (their authorization was decided at subscribe time) and
  the Presence stays open, but every new operation fails with
  `DependencyUnavailable{dependency: "authority", retryable: true}` until a
  revalidate succeeds. If `unavailable` persists past a grace period (adapter
  configuration, v1 default **5 min**), the session is treated as `invalid`.
- The core checks ONLY boolean grants (`priority.override`, `policy.admin`,
  `template.write`) from the Principal it was handed (R10). It never calls the
  authority per-operation with "does X outrank Y" — there is no order in core.

### 2.2 Failure vocabulary and deadline

| Condition | Outcome | Public mapping |
|---|---|---|
| Credential invalid/expired/unknown | `rejected` | `NotAuthenticated` (retryable: false) |
| Authority unreachable / timeout / garbage response | `unavailable` | `DependencyUnavailable{dependency: "authority", retryable: true}` |

Every call completes or fails within a bounded deadline (adapter configuration, v1
default **3 s**). A deadline breach is `unavailable` — never a hung caller.

### 2.3 Role→grant configuration (DEC-07 amendment — contractually placed HERE)

The seven organisational roles (Chris, verbatim):
`Human, Chief, Manager, Auditor, Worker, Executive Assistant, Aide`.

- The mapping from role assertions (made by the Identity authority) to Messaging
  grants lives in **authority-adapter configuration — never in Messaging core**.
- v1 mapping, one ordered list in adapter config: **hold `priority.override`:**
  Human > Chief > Manager > Executive Assistant. **Never hold it:** Auditor, Worker,
  Aide. The order is documentation of the org's intent; the core consumes only the
  resulting boolean (R10 — grant is global, not recipient-scoped).
- Changing the rule = editing one adapter config. Core untouched.
- `policy.admin` and `template.write` mappings follow the same mechanism; v1 config
  assigns them per deployment, not per role dogma.

### 2.4 Adapter obligations

| Obligation | `authority-local` (v1) | future SSO |
|---|---|---|
| Full §2.1 contract with typed outcomes — incl. degraded-state semantics for `revalidate → unavailable` | Required | Required |
| Role→grant mapping externalised in config | Required | Required |
| Bounded deadline (§2.2) | Required | Required |
| Session invalidation surfaced via `revalidate` | Required | Required |

---

## 3. Membership seam

Resolves team/mission membership for Room Threads. Membership truth stays with its
owning capability (DEC-04); Messaging resolves it at this seam and freezes what it
used (I5).

### 3.1 Operations

```
resolveMembers(room: { authority: string, externalId: string })
  → { kind: "resolved", members: PersonId[], evidence: MembershipEvidence }
  | { kind: "unknown",  error: UnknownRoom }           // → public UnknownThread
  | { kind: "unavailable", error: DependencyUnavailable } // → public, retryable

isMember(room, personId)
  → { kind: "known", member: boolean }
  | { kind: "unknown",  error: UnknownRoom }
  | { kind: "unavailable", error: DependencyUnavailable }
```

`MembershipEvidence = { authority, revision, resolvedAt }` — shape frozen in the
contract source; stored verbatim inside the acceptance transaction (Store-Seam §9).
`UnknownRoom` is this seam's own vocabulary — distinct from the store seam's
`RecordNotFound` (Store-Seam §6); the public mapping (`UnknownThread`) is shared.

### 3.2 Linearization (R8 — membership side, CLOSED here)

R8 asks that membership be resolved INSIDE the acceptance decision and its revision
frozen with the snapshot. Rulings:

1. **No cached rosters in v1.** Every room send resolves membership fresh inside the
   accept call, immediately before `commitAcceptance`. The resolution-to-commit
   window is small but non-zero (the commit may queue behind the single-writer
   store) — honesty comes from RECORDING the revision that was used (point 2), not
   from pretending the window is zero.
2. **The evidence travels with the snapshot.** `resolveMembers` returns the
   authority's `revision`; it enters `AcceptanceInput.snapshot.membership` and is
   committed atomically with the recipient set (Store-Seam §9). After acceptance,
   membership changes affect only future sends — the snapshot never rewrites (I5).
3. **An authority that cannot produce a revision token** is adapted by
   `revision = <hash of the sorted member list>` computed by the adapter (algorithm
   and encoding are adapter-private). Revisions are **authority-scoped and never
   compared across adapters or authorities** — they are evidence, not a protocol.
4. **Two consumers, two entry points.** R3 read-time authorization
   (GetThread/GetMessages/GetDelivery on rooms) uses `isMember` at request time.
   R4 SENDER membership is decided differently: from the SAME `resolveMembers`
   result that freezes the snapshot — `sender ∈ members` inside the acceptance step
   (Step 2 §6 ruling). A separate `isMember` call at send time would be a second
   resolution against a potentially different revision — exactly what R8 forbids.
   `unavailable` in either path → `DependencyUnavailable{dependency: "membership",
   retryable: true}` — never a silent allow or deny (G6).

### 3.3 Failure vocabulary and deadline

| Condition | Outcome | Public mapping |
|---|---|---|
| Room unknown to the authority | `unknown` | `UnknownThread` (send and read) |
| Authority unreachable / timeout / unparseable | `unavailable` | `DependencyUnavailable{dependency: "membership", retryable: true}` |

Bounded deadline per call (adapter configuration, v1 default **3 s**). A room send
whose membership cannot be resolved FAILS the send with `DependencyUnavailable` —
it never falls back to a stale or partial roster (I5's snapshot must be true).

### 3.4 Adapter obligations

| Obligation | `membership-novakai` (v1) | `membership-static` (test) |
|---|---|---|
| Full §3.1 contract with typed outcomes | Required | Required |
| Revision evidence per resolution (§3.2.3 fallback allowed) | Required | Required (constant roster → constant hash) |
| Bounded deadline (§3.3) | Required | Trivial (in-process) |

---

## 4. Presence-transport seam

Produces the actual delivery effect to a live runtime (DEC-08) — the ONLY place
"delivered" can honestly come from (G10, I11) — carries subscription frames to
connected principals (R1's transport half), and reports connection liveness into the
core (R9). `TransportKind` (`ws`, `pty`) is frozen in the contract source; the CLI is
an INBOUND protocol adapter (DEC-17), not a presence transport.

**Composition rule:** a composition root offers a `TransportKind` only when that
transport's adapter is registered. `OpenPresence` naming an unregistered transport
fails with `ValidationFailed` (issue path `transport`) — it can never hang, silently
no-op, or reach an absent adapter.

### 4.1 Operations

```
deliver(presenceId, payload: { message: Message, priority: Priority })
  → EffectReport

push(presenceId, frame: SubscriptionMessage)
  → EffectReport

EffectReport =
  | { kind: "effect" }                                   // bytes into the PTY / frame onto the socket — REAL
  | { kind: "failure", retryable: boolean, detail: string, permanent?: "presence-gone" }

// inbound callbacks the adapter MUST raise into the core:
onDisconnect(presenceId)          // connection lost
onLivenessTimeout(presenceId)     // transport-level liveness probe failed
```

- **Two lanes, two operations.** `deliver` serves the ADDRESSED lane (R2): one call
  per attempted Delivery; its `effect` report is the only legal input to
  `pending → delivered` (R5). `push` serves the OBSERVATION lane: subscription frames
  to connected presences; a `push` outcome NEVER touches Delivery state — it feeds
  the subscription's buffer/ended logic (§4.2).
- **Urgent steer is not a separate operation.** MSG-008's steer is the `pty`
  adapter's implementation of `deliver` with `priority: urgent` — mechanics are
  adapter-private; the core sees one contract.
- **Liveness is reported, not inferred.** The core runs no liveness heuristics
  (Plan §3 non-goal). Each transport defines its own probe (WS: ping/timeout; PTY:
  process liveness) and MUST raise `onDisconnect` / `onLivenessTimeout`; both funnel
  into the single presence-close path (R9), emitting `PresenceChanged`.
- **Presence close ends its subscriptions.** When a Presence closes (any cause),
  every subscription bound to it ends. `ended{reason: closed}` is sent
  **best-effort** — on a dead connection it is undeliverable, and that is fine: the
  durable recovery path is the client re-subscribing with its last cursor (R1
  replay), not the goodbye frame.
- **`permanent: "presence-gone"`** means the connection died mid-effect: the attempt
  records `failure`, the presence closes, and the Delivery stays `pending` (R5
  no-presence rule) rather than burning retries against a corpse.

### 4.2 Failure vocabulary — and why this seam does NOT extend `DependencyUnavailable`

Transport failures surface through the DELIVERY lane as typed state
(`DeliveryAttempt` outcome + `DeliveryUpdated` with reason) — that is their honest
public outcome (MSG-016), not a command error. No command or query fails because a
presence transport is down. The `DependencyUnavailable.dependency` known-values set
therefore gains only `"clock"` at Step 3b (§5.2); `"presence-transport"` is
deliberately absent — its failures already have a richer typed surface.

**`deliver` outcomes (addressed lane):**

| Condition | Outcome |
|---|---|
| Effect confirmed by the transport | `effect` → may settle `delivered` (first across fan-out wins, Store-Seam §5 CAS) |
| Transient failure (socket backpressure, PTY busy) | `failure{retryable: true}` → R5 retry budget |
| Permanent failure (PTY dead, protocol error) | `failure{retryable: false}` → `failed{reason: transport-failure}` |
| Connection gone mid-effect | `failure{permanent: "presence-gone"}` → presence closes, Delivery stays `pending` |

**`push` outcomes (observation lane — no Delivery, no R5 budget; R2):**

| Condition | Outcome |
|---|---|
| Frame confirmed sent | `effect` → frame leaves the per-subscription buffer |
| Transient failure | Frame stays in the per-subscription buffer and is retried; the buffer bound is `constants.subscriptionBufferMax` (R1) — a buffer that fills ENDS the subscription with `ended{reason: overflow}` |
| Permanent failure | The frame is dropped and the subscription ENDS: a dead pusher must not pretend liveness. Committed-fact events are recovered by re-subscribing with the last cursor (R1 replay) — at-least-once holds across the subscription's LIFE, not across one dead connection |
| Connection gone | As `onDisconnect`: presence closes → subscription ends (§4.1 teardown); the client re-subscribes with its last cursor |

### 4.3 Adapter obligations

| Obligation | `transport-pty` | `transport-ws` |
|---|---|---|
| Full §4.1 contract (`deliver`, `push`, both callbacks) | Required | Required |
| `effect` returned ONLY on a real transport effect (G10) | Required — bytes written | Required — frame sent |
| Liveness probe + `onLivenessTimeout` | Process liveness | Ping/timeout |
| Bounded effect deadline (adapter config, v1 default **5 s**) | Required | Required |
| Shared adapter contract suite (P5) | Must pass | Must pass |

---

## 5. Clock / ID factory seam

Time and unique IDs — a seam because deterministic tests require substitution
(Plan §14), not because production varies.

### 5.1 Operations

```
now() → Timestamp                       // display-only; NEVER an ordering key (DEC-19)
newId(kind: IdKind) → branded ID        // mints IDs matching the contract-source patterns
```

- `IdKind` ∈ the prefixed kinds of the contract source (`person_` is minted by the
  Identity authority, not here; this seam mints `presence_`, `thread_`, `message_`,
  `delivery_`, `attempt_`, `template_`, `snapshot_`, `acceptance_`,
  `contactpolicy_`, `dndpolicy_`, `subscription_`).
- Uniqueness requirement: within the lifetime of one store, `newId` never reissues.
  The production adapter uses 128-bit randomness; the test adapter is a seeded
  counter (`id_test_000001…`) for deterministic state machines.
- `now()` feeds `createdAt`/`resolvedAt`/deadlines only. Ordering is the store
  sequence, always (DEC-19, Store-Seam §3).

### 5.2 Failure vocabulary

A clock/ID failure means the core cannot honestly proceed (no timestamp, no ID) —
halt-class, like `StoreCorrupt`:

| Condition | Outcome |
|---|---|
| Cannot mint / cannot read time | Operation halts → `DependencyUnavailable{dependency: "clock", retryable: false}` |

The contract source's `DependencyUnavailable.dependency` known-values set extends at
this step: `store | membership | authority | clock`. The field is typed `string`
with these values documented — additive extension is the compatibility rule, and
consumers MUST tolerate unknown values (Step 2 ruling), so this is
backwards-compatible.

### 5.3 Adapter obligations

| Obligation | `clock-system` + `id-random` (v1) | `clock-seeded` (test) |
|---|---|---|
| Contract-source ID patterns, never reissued | Required | Required (deterministic sequence) |
| Monotonic-enough `now()` for deadlines | Required | Fixed/stepped clock |

---

## 6. What Step 3b closes

| Item | Status | Where |
|---|---|---|
| R8 — membership linearization (membership side) | **CLOSED** | §3.2 (store side was Store-Seam §9) |
| R1 — subscribe contract (transport half) | **CLOSED** | §4.1 `push` + teardown, §4.2 push outcomes (contract half was Step 2 §3) |
| DEC-07 roles amendment placed contractually | **CLOSED** | §2.3 |
| All five seams now have binding contracts | store (3a) + authority, membership, presence-transport, clock/ID (3b) | — |

**All R-items (R1–R13) are now CLOSED.** Next: **Step 4** — trace refresh (W4 Chief
subscribe push against S3 per A2; map regenerates from `contract/messaging-contract.json`;
re-run Plan §19 traceability), then **Step 5** — S1 build kickoff.

---

## 7. Review record

2026-07-24 — zero-context adversarial review of this document + the enum amendment
(same protocol as Steps 1 and 2): 0 SEVERE, 5 MEDIUM, 3 LOW. All disposed at the
source:

- **MEDIUM** — R4 sender-membership moved out of read-time `isMember` into the same
  acceptance-time resolution that freezes the snapshot (§3.2.4); push-lane failure
  accounting written (§4.2 observation-lane table) + subscription teardown at
  presence close (§4.1); `revalidate → unavailable` degraded-state ruling +
  revalidation owner named per composition mode (§2.1, §2.4); closed `dependency`
  enum replaced with `string` + documented known values so the tolerate-unknown
  compatibility rule is implementable (§5.2, contract source); unregistered-transport
  `OpenPresence` fails `ValidationFailed` under the composition rule (§4 intro).
- **LOW** — `IdKind` names the real policy prefixes (`contactpolicy_`, `dndpolicy_`);
  §3.2.1 window honesty (small non-zero window; the recorded revision is the
  honesty mechanism) + §3.2.3 revisions never compared across adapters; membership
  seam vocabulary renamed `UnknownRoom` to avoid collision with the store seam's
  `RecordNotFound`.

---

**Amendment record — 2026-07-25 (S2-a audit remediation; §3 text frozen, amended here).**

1. **§3.4 adapter naming:** the v1 static/test membership adapter is
   **`membership-config`** (config-driven room/roster source, the membership analogue
   of `authority-config`). §1's table and §3.4's `membership-static` column named a
   working title; the shipped adapter is `membership-config`. `membership-novakai`
   still lands with the Team/Mission capabilities.
2. **§3.3 deadline enforcement:** the bounded 3 s per-call deadline §3.3 promises is
   enforced in ONE place — a `withMembershipDeadline` wrapper around the seam applied
   in the composition root (`coreStack`, option `membershipDeadlineMs`, default 3 s),
   covering both composition roots and every caller. A breach resolves `unavailable`
   → `DependencyUnavailable{dependency: "membership", retryable: true}`; adapter
   throws are likewise typed at the seam. Adapters themselves need no timer.
3. **Room-key hygiene:** room `authority`/`externalId` join into the durable room key
   (`authority\nexternalId`, here and Store-Seam §11.4). Control characters in either
   half would collide distinct rooms onto one key; `membership-config` now rejects
   them fail-fast at construction.
4. **Tested, not just claimed:** membership revocation mid-subscription (a revoked
   member stops receiving room facts — live push AND cursor replay re-check,
   §3.2.4's read-time `isMember`) and the DEC-21 startup sweep in the embedded root
   (`start()` runs it — accept-after-sweep parity with standalone) are now covered
   by regression tests.
