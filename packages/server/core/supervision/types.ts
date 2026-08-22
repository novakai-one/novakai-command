// packages/server/core/supervision/types.ts — supervision seams and outputs
// (split from engine.ts, SUPFIX step 0). The engine depends on SEAMS, never on
// the server's runtime object: a registry, a way to ask a session something, a
// usage reader, a trace sink, a broadcaster and an escalation channel.
import type { GateFailure } from './gate.js';
import type { UsageReader } from './usage.js';
import type { ProviderName, SupervisionPolicy } from '../../contract/config.js';

/** The slice of the providerSession registry supervision needs. */
export interface SupervisionSessions {
  list(): Promise<SupervisionRecord[]>;
  get(sessionId: string): Promise<SupervisionRecord | null>;
  close(sessionId: string, status: 'closed' | 'exited'): Promise<{ ok: boolean; error?: unknown }>;
  recordUsage(sessionId: string, usage:
    | {
      kind: 'measured';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      source: string;
      measuredAt: string;
      usagePartial?: true;
    }
    | { kind: 'unavailable'; reason: string; checkedAt: string }
  ): Promise<{ ok: boolean; error?: unknown }>;
}

/** The registry record fields supervision reads. */
export interface SupervisionRecord {
  sessionId: string;
  agentId: string;
  provider: ProviderName;
  providerConversationId: string | null;
  cwd: string;
  model: string;
  spawnedAt: string;
  lastActivityAt: string;
  turns: number;
  status: string;
  lastInterruption: { clientOpId: string } | null;
}

export interface SupervisionLifecycle {
  /** End the live session (agents contract closeSession). */
  closeSession(sessionId: string): boolean;
  /**
   * Spawn a replacement for the same agent. `resumeFrom` carries the provider
   * conversation id when context should continue (restart) and is null when it
   * should be dropped (compact). The provider and cwd travel with the request
   * so the host never has to re-derive the dead session's identity.
   */
  spawnFresh(input: {
    agentId: string;
    provider: ProviderName;
    cwd: string;
    resumeFrom?: string | null;
  }):
    Promise<{
      ok: true;
      value: { sessionId: string; model: string; /** Provider runtime adopted resumeFrom. */ resumed: boolean };
    } | { ok: false; error: { code: string; message: string } }>;
}

export type AskResult =
  | { ok: true; text: string }
  | { ok: false; reason: 'no-reply' | 'send-failed' | 'timeout' | 'unknown-session'; text: string };

/** Send one prompt to a session and wait for the reply that turn produces. */
export interface SupervisedTransport {
  ask(sessionId: string, prompt: string, opts?: { timeoutMs?: number }): Promise<AskResult>;
}

export interface TraceInput {
  action: 'hook_log' | 'session.terminate';
  target: { kind: string; id: string };
  /** Caller operation linking a supervised gate/work lifecycle. */
  clientOpId?: string;
  meta?: Record<string, unknown>;
}

export interface SupervisionDeps {
  sessions: SupervisionSessions;
  lifecycle: SupervisionLifecycle;
  transport: SupervisedTransport;
  usage: UsageReader;
  trace(input: TraceInput): Promise<{ ok: boolean; error?: unknown }>;
  broadcast(name: string, data: unknown): void | Promise<void>;
  /** Append rows to `.novakai/supervision/usage.jsonl` — server is sole writer. */
  appendUsage(rows: UsageRow[]): Promise<void>;
  /** Tell Chris, through messaging, that a session has drifted (DEC-B1-12). */
  escalate(text: string): Promise<void>;
  policy: SupervisionPolicy;
  /** Absolute skill-file paths demanded at the gate. */
  skillPaths: string[];
  now?(): string;
  /** A trace that could not be written is reported here — never swallowed. */
  onTraceFailure?(reason: string): void;
  /** Typed, loud reporting for contained runtime/timer failures. */
  onFailure?(failure: SupervisionFailure): void;
}

export interface SupervisionFailure {
  code:
    | 'EscalationFailed'
    | 'UsageAppendFailed'
    | 'UsageBackfillFailed'
    | 'UsageBroadcastFailed'
    | 'UsageTickFailed'
    | 'DriftTickFailed';
  operation:
    | 'escalate'
    | 'backfillUsage'
    | 'appendUsage'
    | 'broadcastUsage'
    | 'emitUsage'
    | 'checkDrift';
  message: string;
}

// ── outputs ────────────────────────────────────────────────────────────────

export interface UsageRow {
  sessionId: string;
  agentId: string;
  provider: ProviderName;
  model: string;
  turns: number;
  status: string;
  lastActivityAt: string;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  /** True when a cumulative provider total had a baseline subtracted (codex). */
  cumulativeAdjusted: boolean;
  /** True when provider evidence could only be safely attributed in part. */
  usagePartial: boolean;
  /** The raw running total, when the provider reports one. */
  providerTotalInputTokens: number | null;
  /** Exact transcript evidence used for this measurement. */
  source: string | null;
  interrupted: string | null;
  /** Set by the drift checker so the table Chris reads flags a drifting agent. */
  drift: boolean;
  note: string;
}

export interface UsageTable {
  at: string;
  rows: UsageRow[];
  /** How the counts were obtained — stated, so no number is mysterious. */
  tokenAccounting: string;
}

export type GateOutcome =
  | { ok: true; sessionId: string; confirmed: string[]; reply: string; work: string; taskComplete: boolean; subagentSkillsStated: boolean }
  | { ok: false; sessionId: string; reason: GateFailure | 'send-failed'; reply: string };

export type DriftAction = 'none' | 'pinged' | 'drift' | 'escalated';

export interface DriftRow {
  sessionId: string;
  agentId: string;
  live: boolean;
  /** Consecutive check intervals with no free evidence of activity. */
  staleIntervals: number;
  consecutiveDrift: number;
  action: DriftAction;
  lastActivityAt: string;
}

export interface DriftReport {
  at: string;
  rows: DriftRow[];
  /** SR-1's audit number: how many REAL provider turns this check-in cost. */
  providerTurnsSpent: number;
}

export type LifecycleResult =
  | { ok: true; sessionId: string; mechanism?: 'restart-fresh' | 'provider-native' }
  | { ok: false; error: { code: string; message: string } };

export interface SupervisionEngine {
  /** DEC-B1-10: the two-turn gate, then the work turn. */
  runSupervisedTask(input: {
    sessionId: string;
    agentId: string;
    brief: string;
    clientOpId?: string;
  }): Promise<GateOutcome>;
  /** DEC-B1-12: one cheap-first check-in tick across every running session. */
  checkDrift(): Promise<DriftReport>;
  /** DEC-B1-11: the table, from real data. */
  usageTable(): Promise<UsageTable>;
  /** Emit the table: append + broadcast + trace. */
  emitUsage(): Promise<UsageTable>;
  terminate(sessionId: string, reason: string, clientOpId?: string): Promise<LifecycleResult>;
  restart(sessionId: string): Promise<LifecycleResult>;
  compact(sessionId: string): Promise<LifecycleResult>;
  /** Start the two timers (usage + drift). */
  start(): void;
  stop(): void;
}

/** Per-session drift bookkeeping (internal to the drift checker). */
export interface DriftState {
  lastSeenActivityAt: string;
  staleIntervals: number;
  consecutiveDrift: number;
  drifting: boolean;
}

/** Closure state shared by the engine's split modules — internal only. */
export interface SupervisionInternals {
  deps: SupervisionDeps;
  now(): string;
  traced(event: string, sessionId: string, meta?: Record<string, unknown>, clientOpId?: string): Promise<void>;
  reportFailure(code: SupervisionFailure['code'], operation: SupervisionFailure['operation'], cause: unknown): SupervisionFailure;
  driftStates: Map<string, DriftState>;
  driftFlags: Set<string>;
  running(): Promise<SupervisionRecord[]>;
  usageRefOf(record: SupervisionRecord): {
    sessionId: string;
    provider: ProviderName;
    providerConversationId: string | null;
    cwd: string;
  };
}
