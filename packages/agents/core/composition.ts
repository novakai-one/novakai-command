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

export interface AgentsContext {
  handle: ScopedStoreHandle;
  /** M10: skill path refs are constrained to .novakai/skills/ (one store, req 10). */
  skillsRoot: string;
  adapters: Record<ProviderName, TerminalAdapter>;
  bus: AgentEventBus;
  /** sessionId → agentId for sessions this process spawned (DEC-C1: temporary). */
  sessions: Map<string, { agentId: string; provider: ProviderName }>;
  /** Sessions ended via closeSession — exit maps to offline(closed) (§7.2). */
  closedSessions: Set<string>;
  /**
   * S2a hooks: inject-context-text text buffered at onSpawn/onMessagePost,
   * prepended to the session's NEXT input (DEC-S2-2: "the agent's next input").
   * Entries carry their deferred provenance-trace payload (L14).
   */
  pendingInjections: Map<string, PendingInjection[]>;
  /** S2a hooks: onExit fires exactly once per session (close OR natural exit). */
  exitHooksFired: Set<string>;
  /**
   * M7: trace-write failures that could not be surfaced even as hook_error
   * traces land here — inspectable, never silent; the host action is unaffected.
   */
  hookTraceFailures: Array<{ event: HookEvent; agentId: string; reason: string; at: string }>;
  /**
   * S2b context advisories (DEC-S2-6, §22 ruling 1): sessions with an attached
   * live lane get focus-change advisories as system context lines BETWEEN
   * turns. busyUntil tracks the streaming turn; queue holds mid-turn advisories.
   */
  laneState: Map<string, { pending: { line: string; at: string } | null; busyUntil: number; timer: ReturnType<typeof setTimeout> | null }>;
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
  /**
   * B1 (§3 boot step 4): a runtime PER PROVIDER. The production server binds
   * the kimi CLI runtime to 'kimi' and leaves claude/codex unbound until their
   * B1b adapters land — an unbound provider fails TYPED at spawn rather than
   * silently answering as a mock. Takes precedence over terminalRuntime.
   */
  providerRuntimes?: Partial<Record<ProviderName, TerminalRuntimeLike>>;
  /**
   * B1 (closes M10): register the mock adapter at all. Defaults to true so the
   * demo and the existing suites are unchanged; the server passes
   * config.dev.allowMock, so production compositions have no mock and no
   * `__emit` test seam.
   */
  allowMock?: boolean;
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
    // S2a: agents owns the agent + skill stores (req 10 one-store).
    // B1 DEC-B1-6: it also owns providerSession — the resumable provider handle
    // registry — and is its sole writer.
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
  };
}

/**
 * A provider with no runtime behind it. spawn() throws so the contract turns it
 * into the typed ProviderSpawnFailed it already produces for a provider outage
 * (C §11) — the failure is visible, not a mock pretending to be a CLI.
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
