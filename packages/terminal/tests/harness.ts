// Shared test rig. Everything below drives the PUBLIC contract only — no test
// reaches into core/, which is what makes these suites double as the
// second-host proof's warm-up.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3fail, b3ok, mintClientOpId, mintRuntimeEpochId, mintTraceCorrelationId,
  type AgentRunId, type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type HumanPrincipalId, type RuntimeEpochId, type SystemCommandContext,
} from '@novakai/foundation/contract';
import {
  composeTerminal, type Clock, type RuntimeEpochFence, type TerminalContract,
} from '../contract/index.js';
import { createFakePtyHost, type FakePtyHost } from '../adapters/pty-host/fake.js';

export interface Rig {
  readonly terminal: TerminalContract;
  readonly ptyHost: FakePtyHost;
  readonly epochId: RuntimeEpochId;
  readonly clock: MovableClock;
  readonly root: string;
  /** Swap the active epoch, as a second Runtime host winning the lease would. */
  setActiveEpoch(epochId: RuntimeEpochId | null): void;
  dispose(): Promise<void>;
}

export interface MovableClock extends Clock {
  advance(milliseconds: number): void;
  /**
   * Run something the next time the core reads the clock. The clock is read
   * while a command is mid-flight, which makes it the one precise place a test
   * can land an event INSIDE an operation without a production test seam.
   */
  onNextRead(hook: () => void): void;
}

export function movableClock(startMs = 1_760_000_000_000): MovableClock {
  let current = startMs;
  let pending: (() => void) | null = null;
  return {
    nowMs: () => {
      const hook = pending;
      pending = null;
      hook?.();
      return current;
    },
    advance: (milliseconds: number) => { current += milliseconds; },
    onNextRead: (hook: () => void) => { pending = hook; },
  };
}

export const chris = 'person_chris' as HumanPrincipalId;

export function humanPrincipal(id = chris): AuthenticatedPrincipal {
  return { id, kind: 'human', verifiedScopes: [] };
}

export function humanContext(id = chris): CommandContext {
  return {
    principal: humanPrincipal(id),
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
  };
}

export function runtimeContext(epochId?: RuntimeEpochId): SystemCommandContext<'sys_agent_runtime'> {
  return {
    principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
    clientOpId: mintClientOpId(),
    traceId: mintTraceCorrelationId(),
    contractVersion: 1,
    ...(epochId ? { runtimeEpochId: epochId } : {}),
  };
}

export function createRig(options: { replayBytes?: number } = {}): Rig {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-terminal-'));
  const ptyHost = createFakePtyHost();
  const clock = movableClock();
  const epochId = mintRuntimeEpochId();
  let active: RuntimeEpochId | null = epochId;

  const epochFence: RuntimeEpochFence = {
    activeEpochId: () => active,
    assertActive(candidate) {
      if (active === null) {
        return b3fail({
          code: 'RuntimeUnavailable', message: 'no active runtime epoch',
          details: { reason: 'no-active-epoch' }, retryable: true,
        });
      }
      if (candidate !== undefined && candidate !== active) {
        return b3fail({
          code: 'StaleRuntimeEpoch', message: 'epoch is no longer active',
          details: { received: candidate, active }, retryable: true,
        });
      }
      return b3ok(active);
    },
  };

  const terminal = composeTerminal({
    root, ptyHost, epochFence, clock,
    ...(options.replayBytes === undefined ? {} : { replayBytes: options.replayBytes }),
  });

  return {
    terminal, ptyHost, epochId, clock, root,
    setActiveEpoch(next) { active = next; },
    async dispose() {
      await terminal.dispose();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export function unwrap<T>(result: B3Result<T>, what: string): T {
  if (!result.ok) throw new Error(`${what} failed: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

export function expectError<T>(result: B3Result<T>, what: string): { code: string; details: Readonly<Record<string, unknown>> } {
  if (result.ok) throw new Error(`${what} unexpectedly succeeded`);
  return { code: result.error.code, details: result.error.details };
}

export const someAgentRunId = 'agentRun_00000000-0000-7000-8000-000000000001' as AgentRunId;

/** A plain shell — the proof case a human can actually see. */
export async function openPlainShell(harness: Rig, columns = 80, rows = 24) {
  return harness.terminal.openManagedTerminal(humanContext(), {
    owner: { kind: 'plain-shell', shellInstanceId: 'shell_1' },
    launchAuthorityRef: 'plain-shell',
    launchFingerprint: 'plain-shell:/bin/zsh',
    workingDirectory: '/tmp',
    columns, rows,
  });
}

/** The mock managed session — a session owned by an Agent Run, without B3b. */
export async function openMockManagedSession(harness: Rig, agentRunId = someAgentRunId) {
  return harness.terminal.openManagedTerminal(humanContext(), {
    owner: { kind: 'agent-run', agentRunId },
    launchAuthorityRef: 'mock-managed',
    launchFingerprint: 'mock:provider',
    workingDirectory: '/tmp',
    columns: 100, rows: 30,
  });
}
