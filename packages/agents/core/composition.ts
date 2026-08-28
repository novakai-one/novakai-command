// Composition root: bind foundation handle + provider adapters + event bus
// into one AgentsContext. Consumers (CLI, shell) call createAgentsContract(ctx).
import path from 'node:path';
import { composeHandle, type ScopedStoreHandle } from '@novakai/foundation/dist/contract/index.js';
import type { CapabilityId } from '@novakai/foundation/dist/contract/brands.js';
import type { HookAction, ProviderName } from '../contract/schemas.js';
import type { TerminalAdapter, TerminalRuntimeLike } from './providers/adapter.js';
import { createTerminalAdapter } from './providers/terminal.js';
import { createMockAdapter, type MockTerminalAdapter } from './providers/mock.js';
import { AgentEventBus } from './events/bus.js';
import type { HookRefs, PendingInjection } from './hooks/engine.js';
import type { HookEvent } from '../contract/schemas.js';
import type { StoreId } from '@novakai/foundation/dist/contract/index.js';

export interface AgentsContext {
  handle: ScopedStoreHandle;
  /** Skill path refs are constrained to this root (one store, one skills dir). */
  skillsRoot: string;
  adapters: Record<ProviderName, TerminalAdapter>;
  bus: AgentEventBus;
  /** sessionId → agentId for sessions this process spawned. */
  sessions: Map<string, { agentId: string; provider: ProviderName }>;
  /** Sessions ended via closeSession — exit maps to offline(closed). */
  closedSessions: Set<string>;
  /**
   * inject-context-text hook output buffered at onSpawn/onMessagePost,
   * prepended to the session's NEXT input. Entries carry their deferred
   * provenance-trace payload.
   */
  pendingInjections: Map<string, PendingInjection[]>;
  /** onExit fires exactly once per session (close OR natural exit). */
  exitHooksFired: Set<string>;
  /**
   * Trace-write failures that could not be surfaced even as hook_error
   * traces land here — inspectable, never silent; the host action is unaffected.
   */
  hookTraceFailures: Array<{ event: HookEvent; agentId: string; reason: string; at: string }>;
  /**
   * Sessions with an attached live lane get focus-change advisories as system
   * context lines BETWEEN turns. busyUntil tracks the streaming turn; queue
   * holds mid-turn advisories.
   */
  laneState: Map<string, { pending: { line: string; at: string } | null; busyUntil: number; timer: ReturnType<typeof setTimeout> | null }>;
  /** Quiet window that ends a turn for advisory delivery (5s in production; tests shrink it). */
  advisoryQuietMs: number;
  /** Foundation-owned identity of the `.novakai` authority that spawned this Agent. */
  storeId?: StoreId;
  /** @internal test seam: override the hook action executor (timeout/failure tests). */
  __hookExecutor?: (
    action: HookAction, refs: HookRefs & { event: HookEvent; agentId: string },
  ) => Promise<string | void>;
}

export interface ComposeAgentsOptions {
  root: string;                    // .novakai/
  /** Canonical JSONL directory (stores/). Defaults to `root` (legacy flat layout). */
  dataRoot?: string;
  legacyRoot?: string;
  principal: string;               // token-derived at the app seam; CLI passes its authed principal
  lockTimeoutMs?: number;
  /**
   * The existing terminal runtime (TerminalManager or TerminalHostClient from
   * src/backend/terminal). When omitted, every provider resolves to the mock
   * adapter — the seam is identical and no PTY is opened.
   */
  terminalRuntime?: TerminalRuntimeLike;
  /**
   * A runtime PER PROVIDER. The production server binds the kimi CLI runtime
   * to 'kimi' and leaves the others unbound until their adapters land — an
   * unbound provider fails TYPED at spawn rather than silently answering as a
   * mock. Takes precedence over terminalRuntime.
   */
  providerRuntimes?: Partial<Record<ProviderName, TerminalRuntimeLike>>;
  /**
   * Register the mock adapter at all. Defaults to true so the demo and the
   * existing suites are unchanged; the server passes config.dev.allowMock, so
   * production compositions have no mock and no `__emit` test seam.
   */
  allowMock?: boolean;
  cwd?: string;
  /** Quiet window (ms) after which a live-lane session's turn is over and
   * queued context advisories flush. Default 5000. */
  advisoryQuietMs?: number;
  /** Resolved once by the composition root; never accepted from a send caller. */
  storeId?: StoreId;
}

export function composeAgents(options: ComposeAgentsOptions): AgentsContext {
  const handle = composeHandle({
    root: options.root,
    ...(options.dataRoot === undefined ? {} : { dataRoot: options.dataRoot }),
    legacyRoot: options.legacyRoot,
    capability: 'agents' as CapabilityId,
    // Agents owns the agent + skill stores. It also owns providerSession — the
    // resumable provider handle registry — and is its sole writer.
    allowedKinds: ['agent', 'skill', 'providerSession'],
    principal: options.principal,
    lockTimeoutMs: options.lockTimeoutMs,
  });
  const cwd = options.cwd ?? process.cwd();
  const allowMock = options.allowMock ?? true;
  const mock = allowMock ? createMockAdapter() : unavailableAdapter('mock', 'mock provider is disabled (dev.allowMock is off)');
  const runtimeFor = (provider: ProviderName): TerminalRuntimeLike | undefined =>
    options.providerRuntimes?.[provider] ?? (options.providerRuntimes ? undefined : options.terminalRuntime);
  const cliAdapter = (provider: 'kimi' | 'claude' | 'codex'): TerminalAdapter => {
    const runtime = runtimeFor(provider);
    if (runtime) return createTerminalAdapter(runtime, { cwd, provider });
    // No runtime for this provider: mock only when the composition allows it,
    // otherwise a TYPED refusal — never a mock wearing a provider's name.
    return allowMock && !options.providerRuntimes
      ? mock
      : unavailableAdapter(provider, `no runtime is configured for provider "${provider}"`);
  };
  const adapters: Record<ProviderName, TerminalAdapter> = {
    kimi: cliAdapter('kimi'),
    claude: cliAdapter('claude'),
    codex: cliAdapter('codex'),
    mock,
  };
  return {
    handle,
    skillsRoot: path.join(options.root, 'skills'),
    adapters,
    bus: new AgentEventBus(),
    sessions: new Map(),
    closedSessions: new Set(),
    pendingInjections: new Map(),
    exitHooksFired: new Set(),
    hookTraceFailures: [],
    laneState: new Map(),
    advisoryQuietMs: options.advisoryQuietMs ?? 5000,
    ...(options.storeId === undefined ? {} : { storeId: options.storeId }),
  };
}

/**
 * A provider with no runtime behind it. spawn() throws so the contract turns it
 * into the typed SpawnFailed it already produces for a provider outage — the
 * failure is visible, not a mock pretending to be a CLI.
 */
function unavailableAdapter(provider: ProviderName, reason: string): TerminalAdapter {
  return {
    async spawn(): Promise<never> { throw new Error(reason); },
    attach() { return null; },
    send() { return false; },
    subscribe() { return () => undefined; },
    close() { return false; },
  };
}

/** Test seam: reach the mock's scripting helpers. */
export function mockOf(ctx: AgentsContext): MockTerminalAdapter | null {
  const a = ctx.adapters.mock;
  return '__emit' in a ? (a as MockTerminalAdapter) : null;
}
