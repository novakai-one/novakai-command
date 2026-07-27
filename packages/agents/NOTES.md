# packages/agents — NOTES (S1 agents-lite)

Ambiguities and judgment calls, one line each. Nothing here invents requirements.

1. **Live-lane entry point (R3-1):** messaging's public contract entry used is
   `MessagingSession.sendMessage` (`packages/messaging/public/capability.ts`)
   with `SendMessageInput { address, body, priority, clientMessageId }`
   (`packages/messaging/public/contract/commands.ts`). Agents consumes it
   structurally (`LiveLaneSender`) so no messaging internals are imported.
2. **Live-lane conversion policy:** S1 sends ONE message per PTY output chunk
   (text = raw chunk). Pass 1/2 do not specify chunk→message shaping;
   line-buffering / TUI control-sequence filtering is left to the renderer.
3. **Live-lane address:** who receives a session's output (which thread/person)
   is not specified for S1 — `attachLiveLane` takes the address as a binding
   parameter; the shell/composition root decides.
4. **Terminal runtime wiring:** the real adapter wraps the EXISTING terminal
   surface (`TerminalManager` in-process / `TerminalHostClient` over the unix
   socket — both satisfy `TerminalRuntimeLike`, verified against
   `src/backend/terminal/manager.ts` and `host/client/index.ts`). The app
   composition root hands the instance in; this package never imports `src/`
   (cross-package TS compile would drag node-pty + app config).
5. **CLI adapter default:** `nvk-agent` without a wired runtime resolves every
   provider to the mock adapter (`NVK_AGENTS_ADAPTER` reserved). Sessions are
   in-memory, so `send`/`events`/`close` only see sessions spawned in the same
   process; registry verbs (`define/get/list/set-model`) persist via
   agents.jsonl and work across processes.
6. **spawnAgent clientOpId:** accepted per §5 but not persisted — spawn mutates
   no stored object (R3-18); PTY process creation is not dedup-able by the
   store's clientOpId mechanism. Noted, not silently dropped.
7. **Session id ownership:** agents mints `sess_<uuid>` (DEC-C1: temporary,
   never durable). The provider's own session identity (kimi/codex async
   discovery in src/backend/terminal/provider/) is provider truth, not the
   contract SessionId.
8. **Foundation import path:** imported as `@novakai/foundation/dist/...`
   (file: dependency) because foundation's package.json declares no
   exports/main and cross-package relative imports break under dist mirroring.
   Foundation is NOT modified.
9. **AgentEvent drop policy:** the bus zod-validates and drops malformed
   internal events instead of crashing subscribers (A §11 spirit: never a
   throw consumers must catch).
10. **PtyEvent.spawned from the real adapter is emitted only when the runtime
    reports a pid** (`terminalPid` optional on restored/registry entries).
11. **Shell demo consumption (S1 integration):** packages/shell's demo bridge
    composes this package (`composeAgents` + `createAgentsContract`, TS source
    via tsx) as its real `PresenceSource`; with no `terminalRuntime` passed,
    every provider resolves to the mock adapter (seam identical, AGT-001).
    The bridge scripts session lifecycles through the `__emit` test seam and
    binds `attachLiveLane` with a messaging-session sender so mock output
    lands in a real thread. No agents code was changed for this; no new
    deviations on this side.

## Follow-ups after seal (adversarial audit — deferred, NOT fixed in S1)

- **M9** — `sessions`/`closedSessions` maps are in-memory per process (DEC-C1 temporary); `send`/`events`/`close` from a second CLI process can't see sessions spawned elsewhere — needs a persisted session registry.
- **M10** — mock adapter `__emit` test seam ships in production build; gate it behind an env flag or strip from dist in a follow-up.
- **L4** — CLI `events --ms` is a fixed sleep, not "until session exit"; fine for S1 demos.
- **L5** — terminal adapter close() doesn't await the runtime's exit event before reporting; state may briefly read 'running' after a successful kill.

## S2a additions (agent def v2 · hooks engine v1 · skills store v1)

10. **Lite→v2 upgrade-on-read:** S1 lite defs stored `hooks` as placeholder
    `Ref[]` — uninterpretable as v2 subscriptions, so normalization maps them
    to `[]` (in memory only; stored lines never rewritten, DEC-F10). Missing
    `skills`/`instructions` default to `[]`/`''`.
11. **Skills mechanism per adapter (§22 ruling 5):** mock RECORDS the resolved
    dir list on the session (observable proof). kimi: native `--skills-dir
    <dir>` flag (verified via `kimi --help`, repeatable). claude/codex:
    `NOVAKAI_SKILLS` env (colon-joined dirs) is the DECLARED mechanism —
    native support unverified, named gap. `TerminalRuntimeLike.create` gained
    optional `argv`/`env` channels; runtimes that cannot forward them (the
    S1 terminal host) silently ignore the fields — gap recorded here, not hidden.
12. **Unknown skill id at spawn** → typed `NotFound`, no session starts
    (never a silent drop).
13. **onExit budget:** §22 ruling 14 specifies spawn-path 2s / send-path
    500ms only; onExit rides the send-path 500ms budget (unspecified, chose
    the stricter). onExit injections are traced but dropped (session is
    ending; no next input exists).
14. **sendToSession on a session unknown to this process** (DEC-C1 in-memory
    sessions) sends WITHOUT hooks — no agent context exists; hooks require
    the def. Cross-process CLI `send` therefore runs hook-free (noted, S3
    session registry would close this).
15. **Hook trace clientOpIds** are system-minted per fired action (they are
    not retries of a user op; R3-10 dedup semantics don't apply).
16. **attachHook validation errors** reuse `InvalidEnvelope` (closed-set
    rejection) — no new error code invented.
