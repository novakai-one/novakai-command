# packages/shell — NOTES (S1)

> Ambiguity log, deviations, and honest open items. Updated 2026-07-28 (overnight S1 session).

## What this package is

The entire S1 user-facing slice: frame (rail │ workspace │ inspector), kit v1,
messaging screens, conversations, composer with slash dispatch, presence,
settings. Contract per `spec/pass2/S1-contracts.md` §4 + §11 rulings; UI per
`spec/diagrams/D5-ui-direction.md` + `novakai-prototype/docs/DESIGN-LAWS.md`.

## Layout

```
packages/shell/
  contract/          errors, types (zod), contrast (token source of truth),
                     mount, layout, settings (key registry), focus, presence,
                     composer (slash dispatch), renderer (speed+buffer),
                     services (UI data seam), persistence.node (foundation)
  ui/kit/            tokens.css (dark+light), kit.css, index.tsx (components)
  ui/frame/          Frame.tsx + frame.css (resizable/collapsible 3-column)
  ui/screens/messaging/  ConversationList, ThreadView, Composer, CommandPalette,
                     MessagingScreen, useRenderer
  ui/screens/settings/   SettingsScreen
  demo/              main.tsx (vite entry), bridge.ts (node, REAL messaging+
                     foundation over WS), bridgeClient.ts, mockServices.ts
  tools/             check-contrast.ts, lint-accent.mjs, demo.mjs
  tests/             6 files, 34 tests (vitest)
```

## Deviations / decisions (flagged, not silent)

1. **UI ↔ storage seam.** Pass 2 §4 shows `getLayout()`/`setLayout()` etc. as
   free functions; a browser can't hold a foundation handle. Split: contract
   functions take a small driver (`LayoutDriver`/`SettingsDriver`);
   `contract/persistence.node.ts` binds those to the real foundation store
   (enveloped, traced, CAS-guarded — R3-7 holds); the browser gets the same
   operations over the demo WS bridge. Same validation code both paths.
2. **Conversation metadata (pin/archive/title).** Pass 1 names no conversation
   CRUD (OQ-S1-9 ruled: messaging owns conversation CRUD — but messaging has
   NO pin/archive concept). Pin/archive/title are shell *view* state, kept
   ephemeral in the demo bridge (not persisted as domain truth). Needs a
   ruling: either messaging grows thread metadata, or a shell-owned kind is
   added (envelope law would allow it — currently NOT done to avoid inventing
   a kind).
3. **Presence.** `PresenceSource` interface kept exactly as instructed
   (`subscribeAgentEvents`). The demo bridge now wires the REAL packages/agents
   as the source (S1 integration pass): `composeAgents` + `createAgentsContract`
   on the node side, bus → WS broadcast → `bridgeClient` → UI `PresenceTracker`.
   No terminal runtime exists in the demo context, so every provider resolves
   to agents' mock adapter (AGT-001: seam identical); events flow for real.
   The in-browser `mockServices` fallback keeps its own in-memory source.
   Proven by `tests/presence-agents.test.ts` (agentEvent → snapshot → WS →
   client tracker transitions) and the "⚡ Spawn mock agent" rail button
   (`spawnMockAgent` bridge method + optional `ShellServices` seam) — dot /
   typing bubble / activity line move live, and the mock session's scripted
   output rides the REAL live lane into the thread as a messaging reply.
   Deviations: (a) demo adds one messaging principal `person_mock` for spawned
   mock agents and widens Chris's demo contact policy to accept agent people;
   (b) `ShellServices.spawnMockAgent?` is an optional demo-only seam, not a
   Pass-2 contract op.
4. **Provider slash commands.** Registry + dispatch order implemented;
   `onProvider` in MessagingScreen is a deliberate no-op until the agents
   package declares its slash set at registration (R3-13). Structured
   contract forwarding, never stdin injection.
5. **SHL-008/invokeAction.** `publishFocus` + `invokeAction` ship as S1
   plumbing per §4 (bus delivery is S2). Focus is published on conversation
   select; nothing consumes it yet — expected, not a violation (R3-11).
6. **SHL-010 lint.** Static, token-based: `--accent` may appear at most once
   across frame+screens+App (the runtime theme application). Liveness tokens
   excluded per R3-25. This is a proxy for "one signal per composed viewport"
   — a renderer-level viewport lint would need a browser pass (S2 candidate).
7. **Token estimate.** Renderer buffer cap counts ~4 chars/token (deterministic
   budget, not a tokenizer). Spec says "10 000 tokens default" without naming
   a tokenizer; the cap constant is the spec value.
8. **messaging node_modules symlink.** `packages/messaging/node_modules/ws`
   symlinks to shell's `ws` so the TS-source demo bridge resolves messaging's
   `ws` import (messaging's own deps were never installed in this worktree).
   Untracked, node-local only.
9. **Demo conversation seeds.** Bridge seeds two agent conversations
   (Kimi/Fable) and opens their ContactPolicies toward `person_chris`
   (each principal sets its own policy — DEC-14 respected; no policy.admin
   grant invented).
10. **Frame composer height.** Composer resize is held in React state in the
    demo (writes to `layout.composer.height` happen on panel geometry changes
    via the frame); wiring composer resize into the persisted layout record is
    a one-liner follow-up — layout round-trip itself is tested and green.

## Rulings applied (traceability)

- §11 r6: layout singleton id `layout_main` ✓
- §11 r7: shell owns the settings key registry; unknown keys rejected ✓
  (`UnknownSettingKey`, tested)
- §11 r8: presence snapshot derived from latest agentEvent per agentId ✓
  (`PresenceTracker`; never stored)
- §11 r9: conversation data via messaging's public contract ✓ (demo bridge
  calls `createEmbeddedMessaging`; no messaging internals touched)
- §11 r10: screen payload zod schemas register at `contract/mount.ts` ✓
- R3-22: `lastUsedModel` requires `derivedFrom` at set time ✓ (tested)
- R3-25: liveness tokens ≠ accent (presence dot uses `--sage`; lint-gated) ✓
- R3-26: sub-AA accent blocked at set time (`ContrastBlocked`, tested) ✓
- R3-27: 10k-token cap, flush-oldest, drawn "…" gap marker ✓ (tested)
- R3-12: zod parse at the mount seam ✓ (tested)
- M-19: liveness motion only in the focused conversation (typing bubble +
  breathing ring render motion only with `live=true`; reduced-motion collapses
  all animation) ✓
- SHL-009: 36 computed pairs green on BOTH themes (tools/check-contrast.ts) ✓

## Known gaps (honest list)

- Inspector is a thin peek panel; inspector *actions* (`invokeAction`) have no
  registered handlers yet (S2 surface per §4 — declared, not consumed).
- No screen-reader audit beyond semantic roles/focus-visible (Pass-2 named
  this an obligation; only the S1 kit-level items — keyboard nav, focus
  management, reduced-motion — are done).
- No electron main; demo is the vite page + node bridge (`npm run demo`).
- 10k-message thread performance not measured (Pass-2 budget unnamed).

## Follow-ups after seal (adversarial audit — deferred, NOT fixed in S1)

- **L6** — Frame debounces setLayout by 400 ms; a crash inside the window loses the last geometry edit (acceptable for S1; consider flush-on-beforeunload).
- **L7** — settingsDriver.readAll returns [] on any store read failure (indistinguishable from "no settings"); surface a typed read-degraded flag in a follow-up.

## S2a additions (Agents screen · kit v1.1 · M5 clientOpId)

7. **Kit v1.1 (M8/DEC-S2-13, additive):** RadioGroup, Select, Swatch +
   Field/Stack/InlineError (layout/label primitives the agent-def UI needed —
   same additive versioning law). Older screens unmigrated.
8. **lint-kit (red gate 3, incremental):** tools/lint-kit.mjs covers
   ui/screens/agents/** only — the S2a screen is the first under the gate;
   pre-S2a screens migrate as touched (wired into `npm test`).
9. **M5 (DEC-S2-12):** clientOpId is a REQUIRED param on contract setLayout/
   setSetting and ShellServices setLayout/setSetting; minted at the
   interaction layer (mintShellOpId) or in bridgeClient per call; the bridge
   threads it to foundation meta. Layout first-boot default uses a
   system-minted op id (not UI-originated).
10. **AgentDefView.version:** the agents contract hides CAS versions; the
    bridge reads them via objectVersion() in persistence.node (foundation
    import stays in the contract composition file — the demo bridge itself
    still doesn't import foundation).
11. **Mock services agents seam** is in-memory (demo fallback + tests); the
    real seam is the WS bridge methods listAgents/defineAgent/updateAgent/
    setAgentModel/listSkills over the REAL agents contract.
12. **kimiCliRuntime** honors create argv/env (prepended argv — kimi's native
    `--skills-dir` is how resolved skill dirs reach the real CLI session).
13. **AgentsView provider dropdown** offers kimi/claude/codex (spec scope);
    a stored 'mock' provider displays as kimi in the editor draft (demo seed
    agents are mock) — display-only, never written back unless saved.

## S2b additions (2026-07-28)

- **Focus authority**: the shell HOST process (demo bridge today) holds current
  focus; the browser publishes every change over WS (`publishFocus`), agents in
  raw terminals pull via `nvk-context` (shell/cli, spec §8 "shell adapter").
  Default `{app:'messaging', ref:'none'}` satisfies red gate 2 from boot.
- **nvk-context placement**: spec §8 owner is "shell adapter"; shell had no CLI
  harness, so `cli/nvk-context.ts` + `npm run nvk-context` (tsx) was created
  here rather than in agents/cli. Needs Node ≥22 (global WebSocket).
- **Real-CLI advisories**: between-turn push advisories are wired for mock lane
  sessions only in the demo. For the real kimi CLI (prompt mode) each
  between-turn advisory would consume a full provider turn per focus change;
  real sessions rely on the send-time context line (ruling 1's push mechanism
  itself is proven in packages/agents tests + the mock path).
- **Inspector (S2b)**: UI-side component registry `ui/inspector/registry.ts`
  maps kind → React screen; the mount contract's `registerScreen(kindRef,
  screenId)` remains the declaration seam. Generic inspector (envelope +
  payload) is the ruling-10 fallback; message kind has a proper screen with
  Reply as its one primary action (`invokeAction` handlers are per
  (kind, actionId) — breaking change to the S1 plumbing, no prior consumers).
- **Themes (S2b)**: `motion` setting (full/reduced) added — reduced-motion is
  now an exposed setting on top of the OS media query (DEC-S2-9). Density +
  sub-AA accent blocking were already live from S1 and are now test-pinned.
- **Activity (S2b)**: adapter heuristic emits `activity: 'idle'` after the
  quiet window; PresenceTracker maps it to online (calm), not typing. Verified
  live: real kimi session emitted working → idle 5s later (2026-07-28).
