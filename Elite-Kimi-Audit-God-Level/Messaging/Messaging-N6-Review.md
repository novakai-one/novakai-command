# N6 Review — Open the door (external terminals)

**Sealed:** 2026-07-26 · branch `kimi/n6-open-the-door` · commits `99c6b5ed`
(slice) + `e7c1e50d` (audit disposals) · app-side only — the frozen core is
untouched (zero files under `packages/messaging`).

## What shipped

The DEC-17 door, in the app, with real credentials — the done-definition:
an agent on a FOREIGN machine connects, authenticates, messages, no manual
step (two commands, one per side).

- **D-N6-1 — the door.** `messagingV2/door/`: a third listener (default
  3032, bind 127.0.0.1 — localhost default unchanged) serves the package's
  frames protocol via `createProtocolConnection` against the app's existing
  embedded stack (the standalone.ts:184-211 reference wiring, F2 close
  order). The package's ws presence transport registers ALONGSIDE the pty
  transport: local lanes stay `pty`, external connections OpenPresence `ws`
  and get real push (MSG-023 — no polling). Door bind failure is loud, not
  fatal (`handle.door === null` + console.error).
- **D-N6-2 — real tokens; D-N2-2 retired.** `messagingV2/tokens/`:
  append-only jsonl (`tokens.jsonl`, chmod 600 every append, gitignored) —
  `nvkt_<64hex>` mints, SHA-256-only at rest, printed once at issuance,
  revocable (folded marker, re-checked at revalidate per §2.1). **Raw
  agentId is rejected as a credential.** Boot mints for active durable
  agents (zero-touch); spawn injects `NVK_AGENT_TOKEN`; lane glue,
  seatWatch, externalSessions read tokens in-process; `nvk-msg` takes
  `NVK_AGENT_TOKEN`, no agentId fallback. Owner CLI: `nvk-agent token
  issue/revoke/list` (+ REST issue/revoke routes, localhost). Fixed at
  source en route: the v2 routes passed the bearer token as senderAgentId
  for #mission resolution (D-N2-2's conflation) — the sender now derives
  from the authenticated principal.
- **D-N6-3 — connect-your-agent.** `scripts/nvk-connect.mjs`: a
  protocol-only frames client (ws sole dep, imports nothing from the
  package): handshake → OpenPresence{ws} → Subscribe → JSON-lines
  stdin/stdout, resume-from-sequence reconnect + transparent re-auth (the
  1h-TTL lesson). `docs/operations/CONNECT-EXTERNAL.md`: the two-command
  flow; remote reachability is the owner's opt-in (bind/tunnel); NO TLS in
  N6 — stated plainly.
- **D-N6-5 — the allowlist-timing debt dies.** Issuance triggers the D-N2-5
  policy sync (`syncPoliciesNow`): a fresh external's first message never
  403s on the human's deny-by-default contact policy (N4 ExternalSessions
  debt disposed).

## Audit (law #6 — fresh 0-context auditor, elite-engineering lens)

**Verdict: MODERATE** — nothing SEVERE; the wire protocol, door composition,
hash-only storage, and the D-N2-2 retirement were found real and honestly
tested (the auditor re-ran the door/connect-smoke/authority/tokens suites on
a throwaway worktree). Seven findings:

- **F1 (MODERATE — disposed at source, RED-first):** cross-process
  revocation stranded the running server: `ensure()` keyed only off the
  process-local raw cache, so a CLI-side `revokeAll` left the backend
  injecting dead `NVK_AGENT_TOKEN`s until restart. Fixed: a held raw whose
  records are all revoked (fresh fold) is treated as absent — `ensure()`
  re-mints, `tokenForAgent()` never serves a dead raw. Two-instance
  server+CLI test: dead raw resolves null, fresh mint authenticates.
- **F2 (MODERATE — disposed at source):** the agent briefing still
  instructed `NVK_AGENT_ID` as the credential. Now: identity =
  `NVK_AGENT_ID`, credential = `NVK_AGENT_TOKEN` (nvk-msg reads it
  automatically).
- **F3 (disposed at source, RED-first):** chmod 600 was create-path-only;
  now applied on every append (loose pre-existing file tightened).
- **F4 (debt):** `doorStack`'s structural CoreStack cast is honest today
  (auditor-verified against connection.ts) but has no compile-time link — a
  `Pick<CoreStack,…>`-shaped param is a package-side hardening, recorded.
- **F5 (disposed at source):** stale lane-lifecycle comment in the presence
  header corrected to the minted-credential truth.
- **F6 (disposed at source):** spliced nvk-agent comment restored;
  redundant .gitignore line dropped.
- **F7 (debt):** door close race (a socket accepted between
  `transport.closeAll()` and `server.close()` keeps close pending) —
  inherited from the standalone reference, shutdown-only; recorded.

## Verification evidence (personally re-run by the orchestrator)

- Full src tsx sweep **93/93**; scripts sweep **7/7**; `npx tsc --noEmit`
  clean; `npm run lint` **192 at baseline**; `stores:test` + `stores:gate`
  PASS; `npm run build` green; package **263/263 + NO DRIFT** (untouched).
- RED-first: raw agentId authenticating pre-fix → rejected post-fix; F1
  cross-process revocation; F3 loose-file perms; nvk-connect smoke showed a
  real intermediate RED (bad person: derivation → ValidationFailed, fixed).
- e2e honesty: `connectSmoke` drives the real client as a child process
  against the real composition on a scratch journal — pre-auth
  get-capabilities, issued-token authenticate, ws presence, PUSHED
  MessageCommitted + DeliveryUpdated, GetDelivery truth, typed negatives
  (bad/revoked token, VersionUnsupported, unauthenticated).
- Live (post-deploy): recorded in the PR body + handover — door bound on
  3032/127.0.0.1, deploy health checks, first live external round-trip.

## Follow-up debt for N7+

- F4: doorStack Pick-shaped param (package-side hardening, next package slice).
- F7: door close race (package-side, inherited from standalone reference).
- Boot-mint growth: one token record per active agent per boot (append-only;
  trivial growth, noted in the module header) — fold-rotation question rides
  with the journal-fold debt.
- nvk-connect resolves only `person:`/`thread:`/`agent_<id>` — display names
  stay with nvk-msg's REST address-book (documented).
- The R-N4-1 carryover: jsonl close/reopen fold test for `listDirectThreads`.
- Carried register (unchanged): journal fold growth (R-item if it bites);
  watchdog union refresh on restart; mirror raw-threadId/FRAGILE-inverse;
  N1 revalidate disk scan; bridge polish (N7).
