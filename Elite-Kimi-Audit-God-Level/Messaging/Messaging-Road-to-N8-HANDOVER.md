# Road to N8 — Master Handover (read this first, every session)

**Written:** 2026-07-26 by kimi-cli (main lane), at Chris's instruction, so the
session can compact and the next agent can run the remaining program
**autonomously to N8 without stopping to ask questions.**
**You are:** the main-lane orchestrator. You are in charge. Chris's words:
"you know more than the auditor"; "if I am in bed, test things yourself";
"keep committing and merging."

---

## 1. The mission and the moment

The app's messaging is rebuilt as a sealed capability
(`packages/messaging/`, FROZEN). The N-program wires it everywhere. **N8 is the
moment the program exists for: a Novakai agent posts in a shared cross-company
Slack channel → PartnerChris's team sees it in Slack → their reply lands in the
app with real delivery truth.** Do not let phase perfectionism delay the
phase gates. Sequence: **R-N4-1 → N6 → N7 → N8.** Phase gates are hard: a
slice seals before the next starts.

## 2. Where things stand (2026-07-26, all live-verified)

- **N1–N5 sealed, merged, deployed** (PRs #63–#71, #75). Records:
  `Messaging-N1..N5-Review.md`; plan + amendments:
  `Messaging-Integration-Plan.md`; roadmap visual:
  `Messaging-Integration-Roadmap.html` (N1–N5 struck). N-program handover
  (N6 inheritance): `Messaging-Integration-HANDOVER.md`.
- **PR #76 (hotfix, deployed `00fa8961ff0d`):** the human session renewal.
  The N3.1 boot-minted human session carried a 1h TTL and died; the lane glue
  now re-mints at ~50% TTL + reactive belt; user routes map NotAuthenticated→503.
  LESSON: long-lived consumers (daemons) surface what browser tabs never do.
- **Slack-for-Chris is LIVE** (arrived early — was N7's scope):
  - The v0 bridge `scripts/nvk-slack-bridge.mjs` (PR #74) runs as launchd
    `com.novakai.slackbridge` (PR #78; plist `scripts/com.novakai.slackbridge.plist`,
    KeepAlive, APP_BASE=http://localhost:3030, log `/tmp/nvk-slack-bridge.log`).
  - Config: `.novakai-command/slack-bridge.json` (chmod 600, gitignored —
    xoxb bot token + xapp Socket-Mode token + chrisUserId; Slack app "Novakai
    Mirror" provisioned by Chris). Cursor state:
    `.novakai-command/slack-bridge-state.json` (gitignored). Both live in the
    MAIN repo; the daemon survives reboots and terminal deaths.
  - Multi-word @mentions work (PR #77: longest roster-title match).
  - Both directions live-verified. Ops runbook: `docs/operations/SLACK-BRIDGE.md`.
- **The other Kimi lane is RETIRED.** Its PRs (#72 docs/D-BRIDGE-1, #73
  agent→human DM by name, #74 bridge v0) are merged; its 3 worktrees +
  branches deleted; `stores-baseline.json` ratchet committed.
- **R-N4-1 SEALED, merged (PR #80), deployed `b8ef813b`** (2026-07-26):
  contract **1.0.0 → 1.1.0** (A-R-N4-1) — the `oversight.read` grant lets the
  owner READ every agent↔agent DM lane (reads, self-list, push live+replay,
  explicit scope). READ-ONLY; sends stay party-only. The grant rides the
  app's human principal as HOST policy (package DEFAULT_ROLE_GRANTS
  unchanged). Store seam gained `listDirectThreads()`. Audit LOW (5 findings
  disposed at source); package 263/263 + NO DRIFT. Record:
  `Messaging-R-N4-1-Review.md`. Live note: production has zero agent↔agent
  lanes so far (agent traffic is agent→chris) — the negative case is
  live-verified; the positive moment arrives with the first real agent↔agent
  conversation. `Messaging-Parked-Ideas.md` seeded (idea-parking is live).
- **N6 SEALED, merged (PR #83), deployed `0e38e7b3`** (2026-07-26): the door
  is open — see §5. Also merged today: PR #82 (A-N8-1 — N8's target is
  **PartnerChris**, already in our Slack; the Slack Connect dependency is OFF
  the critical path).
- **N7 SEALED, merged (PR #85), deployed `7c78dd78`** (2026-07-26): the v0
  bridge generalized in place — one Slack channel ↔ one room Thread,
  echo-safe, owner-only inbound, edit/delete notes, 32 KiB chunking with
  mid-chunk resume, 429 Retry-After, health route
  (`/api/agents/slack-bridge/health`). Audit MODERATE, all 9 disposed at
  source; bridge suite 26 → 46. **Production runs DORMANT** (channels config
  absent — DM lanes exactly as before, live-verified post-deploy).
  Record: `Messaging-N7-Review.md`.
- **N7 channel lane LIVE 2026-07-26:** the click-work was done by the
  orchestrator via the browse bridge (manifest scopes + `message.channels`
  + reinstall, token unchanged; channel `#novakai-fleet` = `C0BKV3G4CH0`
  created by the bot; config wired `fleet:team`; bridge restarted).
  FULL DUPLEX verified: agent → #team → top-level Slack post; Chris's
  Slack post → fleet room as person_user-chris.
- **N8 SEALED, merged (PR #89), deployed `c26f06d5` — THE PROGRAM IS
  COMPLETE.** The moment is live: PartnerChris is provisioned
  (`person_ext-partnerchris`), invited to `#novakai-fleet`, his bridge door
  client holds a ws presence; an agent's #team post bridged to the channel
  and his delivery closed (`delivered adapter-effect` in the journal).
  **The law-#6 auditor was SKIPPED for N8 at Chris's explicit instruction
  (usage ceiling) — the top follow-up debt** (`Messaging-N8-Review.md`).
  His first reply exercises the external inbound path in production.
- Main is clean. Deployed snapshot `c26f06d5`. **Program: R-N4-1, N6, N7,
  N8 — all sealed. Follow-ups live in §8.**

## 3. The per-slice ritual (follow it exactly — it's what made N1–N5 elite)

1. Read this file + `Messaging-Integration-HANDOVER.md` + the plan's §5 row
   for the slice + the last review's §follow-up debt.
2. Decide the slice design; post a compact decision batch to Chris
   (recommendations baked in — **silence = accepted**, never grill, batch,
   don't drip-feed). Record decisions as D-items in the plan (law #2).
3. Branch from fresh main. Brief the implementer (coder subagent — resume
   `agent-30` if the session lives; it holds N2–N5 + hotfix context) with the
   decided design, anchors, gates, and hard rules. Regression tests shown RED
   before fixes. TDD where it helps.
4. **Personally verify every gate** (never trust the report):
   `npx tsc --noEmit`; full `src/**/*.test.ts` via `npx tsx <file>` +
   `scripts/**/*.test.mjs` via node; `npm run stores:test`; `npm run lint`
   (baseline 192 — ratchet DOWN only, after deletions, via
   `npm run lint -- --update`); `npm run stores:gate`; `npm run build`;
   `npm run messaging:test` (253/253 + NO DRIFT).
5. **Law #6: a FRESH 0-context adversarial auditor** (new explore-type
   subagent, never a resumed one) pressure-tests `main...HEAD` — briefed to
   apply `~/.agents/skills/elite-codebase-engineering/SKILL.md`, hunt
   logical/engineering/standards errors, give severity + confidence % +
   assumptions + evidence, verdict LOW/MODERATE/SEVERELY CRITICAL. (Template
   in the N5 session; see `Messaging-N5-Review.md` for the shape.)
6. **You rule on findings.** In-scope: dispose at source, RED-first
   regression tests. Out-of-scope: record as debt, do NOT chase. Write
   `Messaging-N<n>-Review.md` (N2–N5 are the template), record plan
   amendments, strike the roadmap HTML.
7. PR → **`gh pr checks <n>` green BEFORE merge, always** → merge (delegated
   to you) → `npm run redeploy` → verify live (see §6) → update this file +
   the roadmap + `Messaging-Integration-HANDOVER.md`.
8. Commit at every checkpoint. Explicit-path `git add` only — NEVER
   `git add -A`. Main is protected; everything via PR.

## 4. The laws and Chris-protocols (in force, verbatim spirit)

- **Six laws** (`Messaging-HANDOVER.md` §laws): anti-inheritance; ratification
  gate with recorded amendments; contract single-source (`packages/messaging/`
  FROZEN — a core change is an R-item surfaced to Chris, never a quiet edit);
  Chris-visual / silence-accepted / never-grill; mandatory skills; fresh
  0-context auditor per slice.
- **Skills at session start (mandatory):** `elite-codebase-engineering` +
  `codebase-design`; superpowers `verification-before-completion` +
  `requesting-code-review`; `handoff` at slice close. TDD skill when useful.
- **How Chris works:** visual thinker (keep `Messaging-Integration-Roadmap.html`
  current — that's how he understands the program); spews ideas — compile
  them, don't obey each one (see §9 idea parking); plain language, never
  dramatic-thriller style in reports; "you are in charge"; he sleeps — test
  things yourself, including live Slack.
- **Your ruling authority:** everything in-scope (messaging + what N6–N8
  need). MUST surface to Chris (R-items): any `packages/messaging/` contract
  change beyond the ratified R-N4-1 amendment; adding new external
  principals/workspaces; anything PartnerChris-facing before N8; spend.
- **Audit disposal:** regression tests shown RED pre-fix; findings disposed
  at source; debt recorded in the review's follow-up section.

## 5. The remaining slices

### R-N4-1 — owner sees agent↔agent DMs (SEALED 2026-07-26, PR #80)
- Chris RULED YES (PR #72). Shipped as contract amendment **A-R-N4-1**
  (1.0.0 → 1.1.0): the `oversight.read` grant — holder READS any direct
  Thread (assertThreadMember + subscription filtering + explicit scope +
  self-list via the new store-seam `listDirectThreads()`). READ-ONLY; the
  grant rides the app's human principal as host policy. Record:
  `Messaging-R-N4-1-Review.md` (audit LOW, 5 disposed at source).

### N6 — Open the door (SEALED 2026-07-26, PR #83, deployed `0e38e7b3`)
- The DEC-17 door lives in the app (third listener, **3032, 127.0.0.1**) via
  `createProtocolConnection` against the embedded stack; the ws presence
  transport registers alongside pty. Real tokens retire D-N2-2: `nvkt_` mints,
  SHA-256 at rest (`tokens.jsonl`, chmod 600, gitignored), printed once,
  revocable; **raw agentId is rejected**; spawn injects `NVK_AGENT_TOKEN`;
  owner CLI `nvk-agent token issue/revoke/list`. `scripts/nvk-connect.mjs` =
  the foreign-machine client (protocol-only, resume + transparent re-auth);
  `docs/operations/CONNECT-EXTERNAL.md`. Issuance triggers the policy sync
  (N4 allowlist-timing debt disposed). Record: `Messaging-N6-Review.md`
  (audit MODERATE; F1 cross-process-revocation heal + F2 briefing + F3 perms
  disposed at source; F4/F7 debt).
- LIVE-VERIFIED: door bound 3032; CLI-issued token → nvk-connect →
  authenticate → presence → subscribe (replay) → send committed (seq 78) →
  pushed back live → visible in the human lane → bridged to Slack (bridge
  cursor 78). Deploy health all green.
- N6 debt (review §follow-up): F4 doorStack Pick-shape; F7 door close race
  (inherited); boot-mint growth; nvk-connect name resolution limited.

### N7 — Slack grows up (SEALED 2026-07-26, PR #85, deployed `7c78dd78`)
- See `Messaging-N7-Review.md`. One Slack channel ↔ one room Thread,
  generalized in place; DORMANT in production until the click-work lands.
- **The click-work is DONE (orchestrator via the browse bridge, Chris's
  instruction 2026-07-26):** scopes + `message.channels` + reinstall (token
  unchanged); `#novakai-fleet` = `C0BKV3G4CH0` wired to `fleet:team`; full
  duplex live-fired. Remaining Chris-social step: invite PartnerChris to
  the channel — at N8 live-fire time, his call.

### N8 — The PartnerChris moment (IN FLIGHT — resume here)
- **A-N8-1 (Chris, 2026-07-26): the external target is PartnerChris, replacing
  Luke — and PartnerChris is ALREADY a colleague in Chris's Slack workspace.**
  The cross-company Slack Connect invite dependency (old D8) is OFF the
  critical path: no invite acceptance to wait for.
- Done-definition: a shared channel in OUR workspace (`#novakai-fleet` =
  `C0BKV3G4CH0`, live since N7); PartnerChris's team as external principals
  behind deny-by-default contact policy; a Novakai agent posts → visible in
  Slack → their reply lands in the app AS THEM, with delivery truth.
- **Ratified design (D-N8-1..5, silence-accepted 2026-07-26):**
  - **D-N8-1:** externals are a real principal kind —
    `src/backend/messagingV2/externals/` +
    `.novakai-command/messaging-v2/externals.jsonl` (append-only, 600,
    gitignored): `{ personId: person_ext_<slug>, slackUserId, displayName,
    revoked? }`. Token store resolves external tokens to personIds directly;
    authority authenticates them with NO grants (revoked → NotAuthenticated,
    revalidate re-checks §2.1); `isProvisioned` includes them (MSG-014).
    CLI: `nvk-agent external add/list/revoke`.
  - **D-N8-2:** externals join the FLEET roster ONLY (room sends reach them,
    they may send into #team, D-N2-5 policy sync covers them — deny-by-default
    stays the gate; team/mission rosters unchanged).
  - **D-N8-3:** the bridge becomes a DEC-17 client per external — config
    `externals: [{ slackUserId, personId, token }]` in slack-bridge.json;
    a mapped Slack message → frames SendMessage `thread:<fleet room>` through
    the door (3032) AS THAT PRINCIPAL (identity from the authenticated Slack
    user id, own credential — never text, never as chris). chris inbound
    stays on `/user/send`; unmapped users drop loudly; externals absent =
    dormant.
  - **D-N8-4:** real delivery truth — one held ws presence per external
    through the door; delivery effects close the loop (delivered = handed to
    the Slack lane); content posts stay on the N7 room path (NO double-post);
    presence down = pending (honest).
  - **D-N8-5:** live-fire = the moment: provision PartnerChris, invite him to
    `#novakai-fleet` (Chris's social OK), agent posts → he replies → lands as
    him. Luke Moulton can be provisioned identically, anytime.
- **STATE AT CHECKPOINT (2026-07-26, usage stop):** branch
  `kimi/n8-external-principals` pushed at `d19056f9` — WIP commit, 17 files
  (+920), the externals module + authority/membership/policy/tokens/bridge/
  CLI changes in flight. **tsc clean but NOTHING ELSE verified: no gates, no
  RED-first evidence, no auditor, NOT sealed.** RESUME: resume coder
  agent-30 if alive (it holds the build context) or a fresh implementer;
  complete the build per the brief (tests RED-first incl. bridge harness +
  door e2e), then the FULL ritual (§3): personal gates → fresh 0-context
  auditor → disposals → review → PR → merge → deploy → the PartnerChris
  live-fire.

## 6. Live infrastructure + verification playbook

- **Services (launchd, gui domain):** `com.novakai.prod` (the app: api :3031,
  app :3030, **door :3032 (N6, DEC-17 frames/ws)** — all bind 127.0.0.1),
  `com.novakai.slackbridge`, `com.novakai.shot` (screenshotter).
  `com.novakai.watchdog` is DEAD (N5; plist archived at
  `N5-watchdog-plist-archive.txt`).
- **Deploy:** `npm run redeploy` (snapshot → SIGHUP swap). Serve log:
  `.novakai-command/deploy/serve.out`. Verify after EVERY deploy:
  `curl :3030/` 200, `:3031/api/agents` 200,
  `/api/messaging/v2/user/threads` 200, v2 agent route 401 without Bearer,
  old routes 404, and `principals=` count + no error loops in serve.out.
- **Live Slack test:** send as a durable agent — post-N6 the credential is
  `NVK_AGENT_TOKEN` (issue once via `node scripts/nvk-agent.mjs token issue
  --agent agent_<id>`; raw agentId is REJECTED):
  `NVK_AGENT_TOKEN=nvkt_… node scripts/nvk-msg.mjs send --to chris "…"`
  → watch `/tmp/nvk-slack-bridge.log` for the bridge line. NOTE: follow-up
  bridges log at VERBOSE only — only "bridged new DM thread" appears in the
  normal log. Debug rig: bootout the launchd job, run the bridge foreground
  with `NVK_SLACK_BRIDGE_APP_BASE=http://localhost:3030
  NVK_SLACK_BRIDGE_STATE=/tmp/x.json --verbose --dry-run` (posts print to
  stdout, inbound off), re-bootstrap after.
- **A live agent for conversation tests:** durable agents
  (`.novakai/stores/agents.jsonl`) may be exited — mailbox accepts, nobody
  answers. For a real conversation, an agent must be RUNNING (Chris spawns
  the chief from terminal; or you spawn per the app's normal launch flow).
- **ObjectModel stores:** `.novakai/stores/*.jsonl` (append-only; records
  carry id/kind/ts/…/updated — the `updated` field is strictly forward,
  previous+1ms floor in test-side flips). The capability journal:
  `.novakai-command/messaging-v2/journal.jsonl`. The old
  `.novakai-command/messages.jsonl` is a FROZEN archive — zero production
  readers (N5 exit condition; keep it true).

## 7. Landmines (learned the hard way — don't relearn)

- **Background coder subagents SHARE your working tree.** While one runs,
  do NOT run git mutations (checkout/commit/stash) in the repo — a baseline
  commit landed on the wrong branch once this way. Do your git work before
  dispatching or after completion.
- **Human/session TTLs:** anything minted at boot dies at its TTL unless
  re-minted (PR #76). When you add a long-lived consumer, ask "what expires?"
- **Token retirement is real (N6):** raw agentId → NotAuthenticated
  everywhere. Anything still holding only NVK_AGENT_ID (old runbooks, muscle
  memory) fails flat. In-process raw tokens die at restart (hash still
  authenticates; consumers re-mint via ensure()).
- **The door binds 127.0.0.1:3032 by design (D-N6-1).** A foreign machine
  cannot reach it until Chris opts in (bind env or SSH/Tailscale tunnel);
  NO TLS in N6. Surfaced to Chris; do not "fix" it quietly.
- **Cursor semantics:** the bridge/capability cursor is the GLOBAL journal
  sequence; "left behind for replay" only works if later events can't advance
  the cursor past a failed item (delivery events advance unconditionally —
  known shape, worked at v0; revisit if bridging semantics change).
- **launchd:** manage with `launchctl bootstrap/bootout/kickstart -k
  gui/$(id -u)/<label>`; plists live in `scripts/com.novakai.*.plist`
  (tracked) + `~/Library/LaunchAgents/` (installed). KeepAlive without a
  throttle is a crash-loop — always set ThrottleInterval.
- **`stores-baseline.json`** gets ratcheted when live stores legitimately
  grow (the gate passes either way) — commit the ratchet as a chore.
- **Secrets:** never print tokens. Copy config files; chmod 600; the
  gitignored paths are `.novakai-command/slack-bridge.json` +
  `slack-bridge-state.json`.
- **CI is the full-sweep gate** (ci.yml runs every src test file) — but
  personally run gates before every PR anyway.

## 8. Debt register (carry into reviews' follow-up sections)

- Journal fold reads whole history per request (N5 F9 — core-side rotation/
  query surface question; R-item if it bites).
- Watchdog union refreshes on restart only (mid-run-created teams/missions).
- Slack-mirror: DM-lane raw-threadId fallback; FRAGILE `agentIdForPersonId`
  inverse; no `⚠ partial` line (no such delivery state exists).
- ~~ExternalSessions allowlist timing~~ — DISPOSED at N6 (issuance-time
  policy sync). F8b quiet sub-tip failures; browser presence transport (N7
  option); N1 authority revalidate disk scan.
- N6: F4 doorStack Pick-shape; F7 door close race (inherited); boot-mint
  growth; nvk-connect resolves only person:/thread:/agent_<id>.
- N7: DM-lane thread-reply visibility (agents' answers hide in Slack
  threads); UI surface for the bridge-health route; boot-time saveState
  (health 503s until the first persist after a daemon restart — honest but
  noisy on idle boots).
- Bridge polish (see N7 parked list above).
- R-N4-1 audit F4 remainder: jsonl close/reopen fold test for
  `listDirectThreads` (sound by construction — the same op-application path
  rebuilds the index §11.5 already survives restart on). Test-debt batch.

## 9. Idea parking (Chris asked for this mechanism)

Chris fires ideas constantly — compile, don't obey. Maintain
`Elite-Kimi-Audit-God-Level/Messaging/Messaging-Parked-Ideas.md` (create it on
the R-N4-1 branch): each idea one line + a "when it matters" tag (N6 / N7 /
N8 / later / never-urgent). Only ideas tagged to the current phase get
worked; promote at phase gates; nothing is lost, nothing interrupts a slice.
Seed entries: Slack thread-reply visibility (N7); bridge health surface
(N7); `<@U>` decoding (N7); agent↔agent DM visibility = R-N4-1 (NOW).

## 10. Suggested skills (mandatory at session start — law #5)

`elite-codebase-engineering` + `codebase-design` (user scope); superpowers
`verification-before-completion` + `requesting-code-review` (and
`systematic-debugging` for bugs, `test-driven-development` when it helps);
`handoff` when closing a slice. For the R-N4-1 contract amendment: the
elite-codebase-engineering contract-first discipline is the whole game —
contract surface changes are R-items with recorded amendments, never edits.
