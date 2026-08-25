# packages/ CLIs

The root `nvk` command (`scripts/nvk.mjs`, the root package.json `bin`) is an
umbrella dispatcher: it maps a group word to a per-package adapter under
`packages/*/cli/*.ts` and runs it via `tsx`, passing the remaining arguments
through unchanged.

Invoke it from the repo root as:

```
node scripts/nvk.mjs <group> <verb> [options]
```

(or plain `nvk ...` when the root package bin is linked onto PATH; this
document writes `nvk` for brevity). Cross-package imports resolve through
`packages/<pkg>/node_modules/@novakai/*` symlinks — if those are missing
(e.g. after a fresh checkout without install), every group fails with
`ERR_MODULE_NOT_FOUND: Cannot find package '@novakai/foundation'`.

Dispatch table (from `scripts/nvk.mjs`):

| Group | Adapter |
|---|---|
| `project` | `packages/projects/cli/nvk-project.ts` |
| `artifact` | `packages/artifacts/cli/nvk-artifact.ts` |
| `spine` | `packages/spine/cli/nvk-spine.ts` |
| `agent` | `packages/server/cli/nvk-agent.ts` |
| `runtime` | `packages/server/cli/nvk-runtime.ts` |
| `terminal` | `packages/server/cli/nvk-terminal.ts` |
| `watch` | `packages/server/cli/nvk-watch.ts` |

## Common conventions

- Offline store CLIs (`project`, `artifact`, `spine`, plus
  `nvk-store` and `packages/agents`' `nvk-agent`) authenticate with a bearer
  token: `--token <bearer>` or `NOVAKAI_TOKEN`, against
  `<root>/tokens/<id>.json`. Root is `--root <dir>` or `NOVAKAI_ROOT`,
  default `.novakai`. Missing bearer exits 2 with `AuthFailed`.
- Runtime-connected CLIs (`agent`, `runtime`, `terminal`, `watch`) connect to
  the Novakai Runtime on `--port` / `NOVAKAI_RUNTIME_PORT` (default 5190) and
  take `--root` the same way. Every command accepts `--json`; mutations accept
  `--client-op-id <op_...>` so a re-run resumes the same operation. CAS
  preconditions are operator-supplied flags (`--expect-version`,
  `--expect-epoch`, `--expect-episode`), never read by the CLI.
- Errors carry a machine-readable `code` (`Usage`, `ValidationFailed`,
  `AuthFailed`, `RuntimeUnavailable`, ...). The wire shape varies by adapter:
  most emit one JSON line on stderr (`{code, message, details, retryable}`,
  built with `b3err`, `packages/foundation/contract/b3.ts`), but some print a
  plain-text `Code: message` line instead (observed: `agent` and `project`
  print plain text for usage/auth errors, `artifact`/`spine`
  print JSON). Usage failures exit 2.

## Command reference

Verbs and flags below are read from each adapter's source (COMMANDS maps,
switch statements, and usage strings).

### `nvk project` — `packages/projects/cli/nvk-project.ts`

Offline adapter over the Projects contract.

- `create --title <t> [--permission-level private|team|external] --client-op-id <op>`
- `list [--status <s>]`
- `items --project <projectId>`
- `archive --project <projectId> --client-op-id <op>`

### `nvk artifact` — `packages/artifacts/cli/nvk-artifact.ts`

Offline adapter over the Artifacts contract.

- `put <path> [--mime-type <m>] --client-op-id <op>`
- `get-meta <artifactId>`
- `list`
- `get-bytes <artifactId>` (writes raw bytes to stdout)

### `nvk spine` — `packages/spine/cli/nvk-spine.ts`

Offline adapter over the Spine host (composes messaging, projects, artifacts).

- `add-message --message <id> --project <id> [--note <t>] --client-op-id <op>`
- `attach-artifact --artifact <id> --project <id> [--note <t>] --client-op-id <op>`
- `workflows`
- `status --workflow <workflowId>`
- `continue --workflow <workflowId> --client-op-id <op>`
- `abandon --workflow <workflowId> --client-op-id <op>`

### `nvk agent` — `packages/server/cli/nvk-agent.ts`

Runtime client: spawn and run governed agents. Verbs (COMMANDS map plus the
`observeCommands`/`messageCommands` tables):

- `roles` — list role profiles
- `define-role --file <role.json>`
- `spawn --role <name|id> --name <name> [--task supervised --brief <text>] [--provider claude|codex|kimi] [--model <id>] [--effort <v>] [--cwd <path>]`
- `list [--state live|final|all] [--limit <n>] [--cursor <c>]`
- `tree <agentId> [--depth <n>]` (default depth 10)
- `inspect <agentId|agentRunId>` (id prefix picks the view)
- `usage <agentId|agentRunId>`
- `attach <agentRunId>`
- `controls <agentRunId>`
- `control <agentRunId> --expect-version <n> --name model|effort|provider-setting --value <v>`
- `interrupt <agentRunId> --expect-version <n>`
- `stop <agentId> --run <agentRunId> --confirm stop-one`
- `stop-tree <agentId> --prepare` then `stop-tree <agentId> --token <t> --confirm stop-tree`
- `continue <agentId> --from <agentRunId> --mode resume|fresh|compact|handover [--config inherit-plan|refresh-role] [--handover-artifact <id>]`
- `adopt <agentId> --supervisor <agentId|human:<principal>> --expect-version <n>`
- `events [--after <cursor>] [--limit <n>]`
- `fence <agentId>`
- `repair <operationId>`
- `grants [--holder <agentRunId>]`
- `message <agentId> --thread <threadId> --text <text> [--client-op-id <op>]`
- `communications <agentId> [--with <agentId>] [--limit <n>] [--cursor <c>]`
- `open-conversation <threadId> --with <agentId[,agentId...]>`
- `operations`

An agent running inside a managed PTY authenticates as itself via
`NVK_AGENT_RUN_ID` + `NVK_AGENT_RUN_TOKEN` in its environment (both or
neither; a half credential is refused).

### `nvk runtime` — `packages/server/cli/nvk-runtime.ts`

Reach, inspect, or stop the background Novakai Runtime.

- `serve [--root .novakai] [--port 5190] [--static <dir>]` — run in foreground
- `ensure [--start]` — reach it; with `--start`, boot a detached one if absent
- `status`
- `doctor` — read-only composition of the status query
- `cutover-report [--root <path>]` — local-store read; works with no runtime
- `stop [--live-runs refuse|stop-explicitly] --expect-epoch <epoch> [--confirmed-run <agentRunId> ...]`

### `nvk terminal` — `packages/server/cli/nvk-terminal.ts`

List, inspect, attach to, and type into real terminals owned by the Runtime.

- `list [--limit <n>] [--cursor <c>] [--state live|final|all]`
- `inspect <terminalSessionId>`
- `open [--cwd <path>] [--authority plain-shell|mock-managed] [--shell-instance <id>] [--columns <n>] [--rows <n>]`
- `attach <terminalSessionId>` — follows output until interrupted, then detaches
- `detach <controllerAttachmentId> --session <terminalSessionId>`
- `write --session <id> --text <text> [--attachment <id>] [--sequence <n>] [--control-c]`
- `read <terminalSessionId> [--after <outputSequence>]`

### `nvk watch` — `packages/server/cli/nvk-watch.ts`

Durable watcher rules and the notification queue.

- `add --subject <agentId|agentRunId|children:<agentId>> --when <kind[:value]|activity-drift|{json}> --notify human|<agentId> --delivery queue-only|next-turn-context|start-turn`
- `list [--limit <n>] [--cursor <c>]`
- `notifications [--limit <n>] [--cursor <c>]`
- `acknowledge <notificationId>` (or `--id <notificationId>`)
- `update <watchRuleId> --expect-version <n> [--subject ...] [--when ...] [--notify ...] [--delivery ...] [--status active|paused|retired] [--cooldown-ms <n>]`
- `remove <watchRuleId> --expect-version <n>`
- `reset-drift <watchDeadlineId> --expect-version <n> --expect-episode <driftEpisodeId> --reason <text>`

### Other CLIs in packages/ (not umbrella groups)

- `nvk-token` — `packages/server/cli/nvk-server` package bin,
  `packages/server/cli/nvk-token.ts`. Offline cold-start token tool:
  `mint <principalId> --grants <kind,...> [--roles a,b]` and `list`. The
  bearer secret is printed exactly once at mint and lives only in
  `.novakai/tokens/`.
- `nvk-server` — same package, `packages/server/cli/nvk-server.ts`. Boots the
  production composition root: `nvk-server --port <n> [--root .novakai]
  [--static <dir>] [--cwd <dir>] [--watchdog-dir <dir>]` (port required; 5180
  is the live instance). Offline subcommands: `doctor`, and
  `config-set <key> <jsonValue> [--root <dir>]` (keys: `dev`, `transcript`,
  `supervision`, `provider.<name>`, `principal.<personId>`,
  `binding.<agentId>`).
- `nvk-agent-spawn` — `packages/server/cli/nvk-agent-spawn.ts`. Compatibility
  shim: prepends `spawn` to its arguments and forwards to `nvk-agent` in the
  same process; owns no policy.
- `nvk-store` — `packages/foundation` bin, `packages/foundation/cli/nvk-store.ts`.
  Foundation contract CLI: `token mint --principal <id> --grants <k,...>`,
  `create --data <json>`, `update --id <id> --patch <json> --expected-version <n>`,
  `get|list|resolve-ref --kind <k> --id <id>`, `trace query [...]`,
  `quarantine list`, `quarantine resolve --id <id> --resolution reconcile|dismiss`.
  Mutations take `--client-op-id`.
- `nvk-agent` (packages/agents) — `packages/agents/cli/nvk-agent.ts`, a
  DIFFERENT tool from `nvk agent`. Contract-parity adapter over the Agents
  package contract. Verbs in its switch: `define`, `get`, `list`, `set-model`,
  `spawn`, `send`, `attach-hook`, `detach-hook`, `register-skill`,
  `list-skills`, `events [--ms <n>]`, `close`. Its `spawn` takes
  `--agent <agentId>` — it spawns a previously `define`d agent, with optional
  `--model`/`--cwd`. It defaults to the mock terminal adapter
  (`NVK_AGENTS_ADAPTER=mock`); the real runtime is wired by the app
  composition root, so this CLI does not launch real provider PTYs.
- `nvk-context` — `packages/shell/cli/nvk-context.ts` (no package bin).
  Agent-facing focus query: asks the shell host's JSON-RPC socket
  (`NVK_SHELL_WS`, default `ws://127.0.0.1:4173`) for the current focus and
  prints it as JSON. Pull-only.

## Agent spawning

The new-path spawn is:

```
nvk agent spawn --role <name|id> --name <name> [--task supervised --brief <text>]
                [--provider claude|codex|kimi] [--model <id>] [--effort <v>] [--cwd <path>]
```

`--role` accepts a role name (resolved by the Runtime via
`b3.agent.resolveRoleByName`) or an `agentRole_` id. Roles come from
`nvk agent define-role --file <role.json>`; a fresh data root has none.
`--task supervised` requires `--brief`, and `--brief` without `--task` is
refused. The alias `nvk-agent-spawn <same args>` forwards byte-for-byte to
`nvk agent spawn`.

Do not confuse this with `packages/agents`' `nvk-agent` bin: that one
`spawn`s by `--agent <agentId>` against a `define`d record and runs on the
mock adapter by default — it is a contract-parity tool, not a real spawn.

## Usage/help behavior

There is no `nvk help` verb. Running `nvk` with no group or an unknown group
prints one JSON line to stderr and exits 2:

```json
{"code":"Usage","message":"usage: nvk project|artifact|spine|transcript|agent|runtime|terminal|watch <verb> [options]"}
```

That line is the umbrella help (verified). Each adapter prints its own verb
list when given no or an unknown verb — as a plain-text line, e.g.
`ValidationFailed: usage: nvk-agent roles|define-role|spawn|list|...`.

## Legacy scripts

`scripts/nvk-agent.mjs`, `scripts/nvk-msg.mjs`, and `scripts/nvk-live.mjs`
are the OLD operator path: they talk to the old `src/backend` HTTP API on
ports 3031 (live) / 3131 (dev) and manage that backend's agent PTYs. They do
not speak to the `packages/` runtime (port 5190), and the two worlds share no
state beyond the repo. Use `nvk agent ...` for the packages/ runtime; use the
legacy scripts only against the old backend lanes.

## Operating notes (from the b3 field reports)

These come from agents that drove these CLIs end-to-end during build 3
(reports under `~/Programming/kimi-work/build-reports/`, e.g. NVK-KIMI-030,
-036, -038, -090 and the holdout READMEs). Where they differ from a naive
reading of the source, trust the reports.

- **Invocation.** `nvk` is declared as the root package `bin` but was not on
  PATH during b3; operators invoked the dispatcher directly:
  `node scripts/nvk.mjs <group> <verb> ...` — this still works and is verified
  against the current checkout (all 8 groups execute; they fail only on
  expected missing-auth / no-runtime conditions). Harness scripts bypassed
  the umbrella and ran the leaf CLIs via `node_modules/.bin/tsx packages/<pkg>/cli/<cli>.ts`.
- **Isolate every run.** Use a throwaway data root and a non-standard port:
  `NOVAKAI_ROOT=/tmp/<run>/.novakai NOVAKAI_RUNTIME_PORT=52xx node scripts/nvk.mjs runtime ensure --start --json`.
  Never 5180 (live) or 5190 (default). Root resolution order is `--root` →
  `NOVAKAI_ROOT` → `<repo>/.novakai`.
- **A data root boots once.** A second boot against an already-used root dies
  with `StoreRouteConflict` — every run needs a fresh root.
- **Provider environment must be prepared or spawns fail.** The agent's cwd
  needs `CLAUDE.md`/`AGENTS.md` or claude refuses the skills handshake as
  prompt injection; skills must exist as `.claude/skills/<id>/SKILL.md`
  matching the role's `skillRefs`; codex needs `trust_level = "trusted"` in
  `~/.codex/config.toml`; strip inherited `CLAUDE_*` env vars when launching
  from inside a Claude Code session. The b3 fixture for all of this is
  `kimi-work/build-reports/holdout/prepare-env.mjs` (see its README-ENV.md).
- **Always pass `--json`.** The human-readable output omits the
  `agentId`/`agentRunId` values every later command needs.
- **Stop precisely:** `nvk agent stop <agentId> --run <agentRunId> --confirm stop-one`.
- **`runtime stop` refuses with live sessions but still exits 0** (open
  finding L-3) — scripts cannot rely on its exit code. Use
  `--live-runs stop-explicitly` when you mean it.
- **Supervise via watchers, not polling.** Roles install idle-deadline
  watchers at spawn; drain them with `nvk watch notifications --json`.
  Watchers exist server-side precisely to avoid token-burning poll loops.
- **Exit codes:** bad credential = 3 (`PermissionDenied`); unreachable
  runtime = 5 (`RuntimeUnavailable`); usage/validation = 2.
- **Skills-gate fragility (b3b finding N-1):** the skills gate strips its own
  prompt by whole-line match, but provider TUIs re-wrap lines — pass/fail
  depended on task-brief length. Fails closed in ~4s.
- **Caveat:** during b3 the build seats themselves were spawned outside nvk
  (raw `claude -p` background tasks plus watchdog scripts); nvk was the
  product under test. nvk has not yet been dogfooded as the orchestrator for
  a real build.
