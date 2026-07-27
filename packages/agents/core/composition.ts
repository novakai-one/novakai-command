// Composition root: bind foundation handle + provider adapters + event bus
// into one AgentsContext. Consumers (CLI, shell) call createAgentsContract(ctx).
import { composeHandle, type ScopedStoreHandle } from '@novakai/foundation/dist/contract/index.js';
import type { CapabilityId } from '@novakai/foundation/dist/contract/brands.js';
import type { ProviderName } from '../contract/schemas.js';
import type { TerminalAdapter, TerminalRuntimeLike } from './providers/adapter.js';
import { createTerminalAdapter } from './providers/terminal.js';
import { createMockAdapter, type MockTerminalAdapter } from './providers/mock.js';
import { AgentEventBus } from './events/bus.js';

export interface AgentsContext {
  handle: ScopedStoreHandle;
  adapters: Record<ProviderName, TerminalAdapter>;
  bus: AgentEventBus;
  /** sessionId → agentId for sessions this process spawned (DEC-C1: temporary). */
  sessions: Map<string, { agentId: string; provider: ProviderName }>;
  /** Sessions ended via closeSession — exit maps to offline(closed) (§7.2). */
  closedSessions: Set<string>;
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
}

export function composeAgents(options: ComposeAgentsOptions): AgentsContext {
  const handle = composeHandle({
    root: options.root,
    legacyRoot: options.legacyRoot,
    capability: 'agents' as CapabilityId,
    allowedKinds: ['agent'],
    principal: options.principal,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  const cwd = options.cwd ?? process.cwd();
  const mock = createMockAdapter();
  const adapters: Record<ProviderName, TerminalAdapter> = options.terminalRuntime
    ? {
      kimi: createTerminalAdapter(options.terminalRuntime, { cwd }),
      claude: createTerminalAdapter(options.terminalRuntime, { cwd }),
      codex: createTerminalAdapter(options.terminalRuntime, { cwd }),
      mock,
    }
    : { kimi: mock, claude: mock, codex: mock, mock };
  return {
    handle,
    adapters,
    bus: new AgentEventBus(),
    sessions: new Map(),
    closedSessions: new Set(),
  };
}

/** Test seam: reach the mock's scripting helpers. */
export function mockOf(ctx: AgentsContext): MockTerminalAdapter | null {
  const a = ctx.adapters.mock;
  return '__emit' in a ? (a as MockTerminalAdapter) : null;
}
