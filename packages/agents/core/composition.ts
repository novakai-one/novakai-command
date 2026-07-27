// Composition root: bind foundation handle + provider adapters + event bus
// into one AgentsContext. Consumers (CLI, shell) call createAgentsContract(ctx).
import { composeHandle, type ScopedStoreHandle } from '@novakai/foundation/dist/contract/index.js';
import type { CapabilityId } from '@novakai/foundation/dist/contract/brands.js';
import type { HookAction, ProviderName } from '../contract/schemas.js';
import type { TerminalAdapter, TerminalRuntimeLike } from './providers/adapter.js';
import { createTerminalAdapter } from './providers/terminal.js';
import { createMockAdapter, type MockTerminalAdapter } from './providers/mock.js';
import { AgentEventBus } from './events/bus.js';
import type { HookRefs } from './hooks/engine.js';
import type { HookEvent } from '../contract/schemas.js';

export interface AgentsContext {
  handle: ScopedStoreHandle;
  adapters: Record<ProviderName, TerminalAdapter>;
  bus: AgentEventBus;
  /** sessionId → agentId for sessions this process spawned (DEC-C1: temporary). */
  sessions: Map<string, { agentId: string; provider: ProviderName }>;
  /** Sessions ended via closeSession — exit maps to offline(closed) (§7.2). */
  closedSessions: Set<string>;
  /**
   * S2a hooks: inject-context-text text buffered at onSpawn/onMessagePost,
   * prepended to the session's NEXT input (DEC-S2-2: "the agent's next input").
   */
  pendingInjections: Map<string, string[]>;
  /** S2a hooks: onExit fires exactly once per session (close OR natural exit). */
  exitHooksFired: Set<string>;
  /**
   * S2b context advisories (DEC-S2-6, §22 ruling 1): sessions with an attached
   * live lane get focus-change advisories as system context lines BETWEEN
   * turns. busyUntil tracks the streaming turn; queue holds mid-turn advisories.
   */
  laneState: Map<string, { queue: string[]; busyUntil: number; timer: ReturnType<typeof setTimeout> | null }>;
  /** Quiet window that ends a turn for advisory delivery (ruling 12's 5s; tests shrink it). */
  advisoryQuietMs: number;
  /** @internal test seam: override the hook action executor (timeout/failure tests). */
  __hookExecutor?: (
    action: HookAction, refs: HookRefs & { event: HookEvent; agentId: string },
  ) => Promise<string | void>;
}

export interface ComposeAgentsOptions {
  root: string;                    // .novakai/
  legacyRoot?: string;
  principal: string;               // token-derived at the app seam; CLI passes its authed principal
  lockTimeoutMs?: number;
  /**
   * The existing terminal runtime (TerminalManager or TerminalHostClient from
   * src/backend/terminal). When omitted, every provider resolves to the mock
   * adapter — the seam is identical (AGT-001) and no PTY is opened.
   */
  terminalRuntime?: TerminalRuntimeLike;
  cwd?: string;
  /** S2b: quiet window (ms) after which a live-lane session's turn is over and
   * queued context advisories flush. Default 5000 (§22 ruling 12's quiet window). */
  advisoryQuietMs?: number;
}

export function composeAgents(options: ComposeAgentsOptions): AgentsContext {
  const handle = composeHandle({
    root: options.root,
    legacyRoot: options.legacyRoot,
    capability: 'agents' as CapabilityId,
    allowedKinds: ['agent', 'skill'], // S2a: agents owns both stores (req 10 one-store)
    principal: options.principal,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  const cwd = options.cwd ?? process.cwd();
  const mock = createMockAdapter();
  const adapters: Record<ProviderName, TerminalAdapter> = options.terminalRuntime
    ? {
      kimi: createTerminalAdapter(options.terminalRuntime, { cwd, provider: 'kimi' }),
      claude: createTerminalAdapter(options.terminalRuntime, { cwd, provider: 'claude' }),
      codex: createTerminalAdapter(options.terminalRuntime, { cwd, provider: 'codex' }),
      mock,
    }
    : { kimi: mock, claude: mock, codex: mock, mock };
  return {
    handle,
    adapters,
    bus: new AgentEventBus(),
    sessions: new Map(),
    closedSessions: new Set(),
    pendingInjections: new Map(),
    exitHooksFired: new Set(),
    laneState: new Map(),
    advisoryQuietMs: options.advisoryQuietMs ?? 5000,
  };
}

/** Test seam: reach the mock's scripting helpers. */
export function mockOf(ctx: AgentsContext): MockTerminalAdapter | null {
  const a = ctx.adapters.mock;
  return '__emit' in a ? (a as MockTerminalAdapter) : null;
}
