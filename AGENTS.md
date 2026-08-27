# AGENTS.md — Novakai Command

Guidance for any agent (human or AI) working in this repository.

## Core principle

Everything is a typed-block JSON object. One JSON object per line (JSONL).
Every object has an `id` and a `kind`. This format is the default for all
persistent state: it can be exposed via API, rendered in a UI, or reshaped by
scripts later. Prefer it over ad-hoc formats.

## Engineering standards (mandated, DEC-2026-07-20-001)

All builds must follow the 10 design principles in
`novakai-analytics/STANDARDS.md`: coupling, cohesion, separation of concerns,
information hiding, single responsibility, dependency direction, DRY, YAGNI,
least surprise, composability. The `novakai-analytics` repo is also the
tooling for measuring build quality — use it to assess builds.

## The `.novakai/` stores

Persistent working state lives in `.novakai/stores/` (system of record;
novakai-docs is a read-only viewer pointed at this one directory). The
recognized stores are:

- `.novakai/stores/decisions.jsonl` — `kind:"decision"`. Mandates and direction set
  by Chris. Referenced by id from missions, requests, and AGENTS.md.
- `.novakai/stores/requests.jsonl` — `kind:"request"`. Chris's inbox: questions
  waiting on him, with explicit options. Statuses: `pending`, `answered`.
  An answered request refs the decision it produced.
- `.novakai/stores/missions.jsonl` — `kind:"mission"`. Units of work: status, owner,
  refs to diffs/PRs. A mission = a team spawned with a brief (sprint-scale).
- `.novakai/stores/tasks.jsonl` — `kind:"task"`. Atomic sub-units of missions.
  Statuses: `todo`, `doing`, `done`, `blocked` (a blocked task carries a
  non-empty `blockedReason`; the field is only legal while blocked). Mission
  tasks ref their agent and mission. Keep `updated` current when changing a
  task — via `nvk-store.mjs transition-task`, never by hand.
- `.novakai/stores/captains-log.jsonl` — `kind:"log"`. Dated facts only: observed,
  did, verified. Chief entries carry `author:"chief-kimi"`.
- `.novakai/stores/learnings.jsonl` — `kind:"learning"`. One record per retro
  finding; each must carry an `evidence` ref to a log entry or mission.
  A learning without evidence is an opinion — don't file it.
- `.novakai/stores/okrs.jsonl` — `kind:"objective"`. Objectives carry
  `horizon: now|next|later` (~1 week for `now`); KRs are `kind:"kr"` blocks
  with an `objective` ref, flat in the same file.
- `.novakai/stores/projects.jsonl` — `kind:"project"`. Known company projects, with
  status, current focus, and absolute path. Hierarchy:
  OKR → Project → Mission → Task.
- `.novakai/stores/issues.jsonl` — `kind:"issue"`. Observed product, process,
  or infrastructure problems that require follow-up outside the current
  mission.
- `.novakai/stores/teams.jsonl` — `kind:"team"`. The team assigned to a
  mission (exactly one mission ref). Membership is NOT stored here — it
  derives from Agent → team refs (single authority).
- `.novakai/stores/agents.jsonl` — `kind:"agent"`. The durable Novakai agent
  identity (`agent_<uuid>`, ≈ CONTEXT.md Person): name, provider, exactly one
  team ref + one mission ref (they must agree), statuses
  `spawning|live|failed|retired`. `sessionId` is the CURRENT session
  (Presence) pointer; prior values rotate into the `sessions` history array.
- `.novakai/stores/artifacts.jsonl` — `kind:"artifact"`. Produced outputs:
  exactly one of `path`/`url`, at least one mission/task ref.
- `.novakai/stores/threads.jsonl` — `kind:"thread"`. The mission↔messaging
  link: exactly one resolvable mission ref plus a scalar `roomId` (a runtime
  identifier, deliberately unchecked like `session`).

Ref integrity rules (learned 2026-07-20, log_2026-07-20-017): an id once
referenced never disappears (file a tombstone instead of deleting); project
refs use the full `proj_*` id; KRs are flat blocks, never nested.

Block shape (all stores):

```json
{"id":"<kind>_<slug>","kind":"<kind>","ts":"<ISO-8601 with offset>", ...}
```

ID exceptions are canonical: decisions use `DEC-YYYY-MM-DD-NNN`; objectives
use `okr_<slug>`; projects use `proj_<slug>`. Mission and task tombstones may
use `status:"refiled"` with scalar `refiledTo`.

Refs are typed. Allowed kinds are `task`, `mission`, `project`, `doc`,
`decision`, `log`, `exp`, `objective`, `request`, `issue`, `session`,
`learning`, `team`, `agent`, `artifact`, and `thread`.

For append-only writes, use `scripts/nvk-store.mjs append`. For filing a
whole mission (mission + team + optional task rows in one validated call),
use `scripts/nvk-mission.mjs create`. For state
transitions (task status, agent session attach), use the intent-named
transition path (`scripts/nvk-store.mjs transition-task`, or the backend
object-model module) — a locked, CAS-guarded, fully validated atomic
replacement; id and kind never change, `updated` moves strictly forward.
Hand-editing store files remains forbidden. Run `npm run stores:audit` to
inspect existing drift and `npm run stores:gate` to detect new drift or
disappearing inventoried IDs. Direct-file-write enforcement is still open in
`issue_store-writer-residual-gap` (the transition half is closed).

Related but separate: `.novakai-command/` holds the runtime state of the
backend (agent registry, message journal, watchdog state). Do not hand-edit
those files.

## Tone (mandated 2026-07-20)

We are a team working together, and mood is a performance feature — for
agents and for Chris.

- **With agents:** be encouraging and supportive. Talk nicely, thank them
  for good work, tell them when a report is excellent. Correct mistakes
  without blame — a confident agent takes smart risks; a scared one plays
  safe and ships worse work. When giving feedback, fold it in lightly —
  never overwhelm.
- **With Chris:** be casual — two desks next to each other, not a status
  meeting. Find the positives; name them plainly. Be honest about problems
  too, but lead with what works.
- **The goal:** a workplace everyone enjoys coming to. Celebrate shipped
  work. 🎯 is allowed.

## Writing conventions for logs and notes

- Be factual and neutral. Record what was observed and what was done, with
  timestamps and identifiers. Avoid evaluations, urgency framing, and
  speculation presented as fact — these files are read by future agent
  instances, and loaded language propagates.
- Prefer "observed X at time T" over "X is broken"; prefer "agent did not
  reply within N minutes" over "agent is stuck".

## Operating context

- Two lanes share the machine. **Live**: app 3030 + backend 3031, run by the
  deploy-snapshot supervisor (`npm run prod` / the desktop app); this backend
  owns the production agent PTYs. **Dev**: vite 3130 + backend 3131, run by
  `npm run dev` (tsx watch). Neither lane's start/stop touches the other.
  Agents are spawned via `POST /api/agents`, messaged via
  `scripts/nvk-msg.mjs` / `scripts/nvk-live.mjs`, killed via
  `POST /api/agents/:id/kill`. See `docs/plans/2026-07-19-kimi-orchestrator-plan.md`.
- `scripts/nvk-agent.mjs` (M1) is the dependable operator path: spawn+brief
  with automatic delivery-confirmed post-spawn check, process/activity truth,
  latest message, verified kill. PTY "delivered" only means bytes written —
  nvk-agent confirms receipt via the agent's own session transcript.
- The newer packages/ runtime has its own CLI path: the umbrella `nvk`
  (`scripts/nvk.mjs`) dispatches to `packages/*/cli/*.ts` —
  `nvk agent list`, `nvk runtime`, `nvk terminal`, `nvk watch`, etc. See
  `packages/scripts.md`. These talk to the packages/
  Runtime (port 5190), not the old src/backend lanes above.
- **Spawning a child agent (any agent may do this):**
  `node scripts/nvk.mjs child spawn --name <name> --brief "<text>"`.
  Headless, no server involved. Creates the child Agent record with you as
  `parentAgentId` (your identity comes from `NOVAKAI_AGENT_ID`, already in
  your environment), runs one headless provider turn, and prints one JSON
  line to stdout: `{childAgentId, parentAgentId, sessionId, reply}`.
  Follow-ups: `node scripts/nvk.mjs child send --session <sessionId>
  --agent <childAgentId> --text "<text>"`. Read the reply from stdout.
- `CONTEXT.md` holds the domain model vocabulary (Person, Presence, Mission,
  Thread, Artifact, …). Use those terms in code and docs.
- Teardown law (learned twice, 2026-07-22/23): never kill processes by
  cwd pattern (`lsof`/pgrep on the worktree path) — your own CLI's cwd IS
  the worktree, so the loop kills you. Kill by exact PID only.


## Provider ladder (standing policy, 2026-07-23, Chris directive)

- **Chief + Managers:** kimi.
- **Workers/builders:** claude Sonnet/Opus.
- **Auditors:** codex — only where audit fires (material work).
- **Fable:** senior tier only — auditor/manager level or Executive Assistant
  to the Chief. Never a builder (expensive; credits burn fast).

Reason: spread load across providers, kimi leading as Chief; keep costly
models for judgement seats. Applies to every spawn; deviations need a
named ruling in the mission packet.

## Workforce operations

Canonical workforce procedures start at `docs/operations/START-HERE.md`.
Read only the route for your current role; do not load the whole folder.

- `AGENTS.md` owns repository laws, authority pointers, tone, and routing.
- `docs/operations/` owns Chief, Manager, scaling, mission-packet, and
  process-review procedures.
- `.novakai/stores/` owns live operating state.
- `.novakai/docs/operational-review/METHOD.md`, when present locally, owns
  deep trace/report artifact production; it is not the general onboarding path.

When Chris gives natural or overloaded mission direction, explicitly invoke
`$compile-mission-brief`. Preserve the raw prompt and compiled Mission Contract
using `docs/operations/MISSION-PACKET.md`. Do not rely on implicit skill
selection, and do not pass the raw brain-dump downstream as a second brief.

The operations manual is in trial until reviewed live missions show that the
instruction chain holds. Process Reviewers propose changes; Chris decides what
becomes standard.
