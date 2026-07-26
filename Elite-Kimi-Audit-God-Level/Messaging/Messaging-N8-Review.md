# N8 Review — the PartnerChris moment (external principals)

**Sealed:** 2026-07-26 · branch `kimi/n8-external-principals` · commits
`d19056f9` (WIP, interrupted mid-build) + `63a05720`/`3b51ca6f`
(completion) · the frozen core is untouched (zero files under
`packages/messaging`).

## What shipped

PartnerChris's team are real principals. A Novakai agent posts in the
shared room → visible in `#novakai-fleet` → their Slack reply lands in the
app AS THEM, with delivery truth.

- **D-N8-1 — externals are a real principal kind.**
  `src/backend/messagingV2/externals/` + `externals.jsonl` (append-only,
  600, gitignored): `{ personId: person_ext_<slug>, slackUserId,
  displayName, revoked? }`. Token store resolves external tokens to
  personIds; the authority authenticates them with NO grants (revoked →
  NotAuthenticated; revalidate re-checks, §2.1); `isProvisioned` includes
  them (MSG-014). Provision is idempotent per slackUserId. CLI:
  `nvk-agent external add/list/revoke`.
- **D-N8-2 — fleet roster only.** Externals ride the fleet roster (room
  sends reach them as recipients; they may send into #team; the D-N2-5
  policy sync covers them — deny-by-default stays the gate). Team/mission
  rosters unchanged.
- **D-N8-3 — the bridge is a DEC-17 client per external.** A mapped Slack
  user's channel message → frames `SendMessage thread:<fleet room>` through
  the door as THAT principal (their own nvkt_ credential — identity from
  the authenticated Slack user id, never text, never as chris). chris
  inbound stays on `/user/send`; unmapped users drop loudly; externals
  absent = dormant.
- **D-N8-4 — real delivery truth.** One held ws presence per external
  through the door; delivery effects close the loop (delivered = handed to
  the Slack lane); delivery frames are confirmation-ONLY — content posts
  stay on the N7 room path (no double-post, test-pinned). Presence down =
  pending (honest).
- **D-N8-5 — the live-fire is the moment** (see below).

## Audit

**The law-#6 fresh 0-context adversarial auditor was SKIPPED at Chris's
explicit instruction (2026-07-26, usage ceiling: "finish without the
auditor and have that as a marked follow up").** This is the first slice
sealed without it. It is recorded as follow-up debt: a fresh auditor must
pressure-test `269254a3..<N8 merge>` and its findings dispose at source or
ride the register. In mitigation, the orchestrator personally reviewed the
full diff and caught three defects the gates alone surfaced or hid:

- The bridge suite's seq-31/32 fixtures sat below the external section's
  seq-34 cursor — dropped as at-least-once dupes (renumbered; the
  interrupted build's own insertion invalidated pre-existing fixtures).
- +10 lint violations from the WIP (decomposed/compressed at source; 192
  PASS, no ratchet).
- `provision()` was not idempotent — two ACTIVE records could share one
  slug-derived personId (guarded; test extended).

## Verification evidence (personally re-run by the orchestrator)

- Full src tsx sweep **94/94**; scripts sweep **7/7**; bridge suite
  **47/47** (incl. the D-N8-3/4 check: external rides the door with his OWN
  token, room address, confirmation-only deliveries); package **263/263 +
  NO DRIFT** (untouched); `npx tsc --noEmit` clean; `npm run lint` **192 at
  baseline**; stores:test + stores:gate PASS; build green.
- Door e2e (app harness, from the WIP): an external authenticates through
  the door, opens ws presence, sends `thread:<fleet room>` — commits with
  senderId = the external; an agent recipient is pushed.
- **LIVE-FIRED 2026-07-26 (deployed `c26f06d5`):** PartnerChris provisioned
  (`person_ext-partnerchris`, token issued + placed in the bridge config,
  600) and invited to `#novakai-fleet`; the bridge's external door client
  authenticated (`external door ready: U0BKR7HTK53`) holding his ws
  presence. An agent posted to #team → bridged top-level to the channel
  (seen in Slack) → the journal shows **`person_ext-partnerchris →
  delivered adapter-effect`** — the delivery loop closed through his held
  presence. His first REPLY exercises the external inbound path in
  production (harness-proven: own token, room address, never as chris) —
  the one step that needs his fingers, not ours.

## Follow-up debt

- **THE SKIPPED AUDITOR (Chris's marked follow-up):** fresh 0-context
  adversarial audit of the N8 diff; dispose at source or register.
- External inbound when the door is down drops loudly with a Slack note
  (never bridged as anyone else) — a queued-redelivery option is parked.
- The `<#C…>` channel-mention decode + N6/N7 parked polish (bridge-health
  UI, DM thread-reply visibility, boot-time saveState, nvk-connect
  queue-until-ready, door bind log line).
- The standing register (F4/F7 package items, journal fold growth, N1
  revalidate disk scan, mirror raw-threadId/FRAGILE-inverse).
