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
