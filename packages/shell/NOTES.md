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
   (`subscribeAgentEvents`); packages/agents is NOT imported even though it
   now exists. The demo drives a mock presence source (documented in
   demo/bridge.ts). Wiring = orchestrator's job.
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
