// packages/server/core/supervision/engine.ts — SUPERVISION v1 (§8).
//
// Four of Chris's verbatim requirements meet here, and each one is a rule the
// engine can actually enforce rather than a habit it hopes to keep:
//
//   DEC-B1-10  skills confirmed BEFORE any work            (two-turn gate)
//   DEC-B1-12  drift check-ins every 5–10 min, CHEAP FIRST (SR-1)
//   DEC-B1-13  terminate after meaningful work + restart   (+ compact option)
//   DEC-B1-11  a real per-session usage table every 5–10 min
//
// DEC-B1-15 / red gate 7 binds all four: every supervision action appends a
// system.action trace. The foundation's action enum is CLOSED
// ('hook_log' | 'context.inject' | 'hook_error' | 'session.terminate'), so
// supervision actions ride 'hook_log' with `meta.event` naming them —
// `session.terminate` keeps its own dedicated action. Widening the enum is a
// foundation schema amendment; it is recorded in NOTES.md as a ratification
// candidate rather than smuggled in here.
//
// The engine depends on SEAMS, never on the server's runtime object: a
// registry, a way to ask a session something, a usage reader, a trace sink, a
// broadcaster and an escalation channel. That is what makes the rules above
// testable without a socket, a provider or a store.
import { buildGatePrompt, buildWorkPrompt, declaresTaskComplete, hasSubagentSkillsStatement, validateSkillsMarker, type GateFailure } from './gate.js';
import type { SessionUsage, UsageReader } from './usage.js';
import type { ProviderName, SupervisionPolicy } from '../../contract/config.js';

// ── the seams ──────────────────────────────────────────────────────────────

/** The slice of the providerSession registry supervision needs. */
export interface SupervisionSessions {
  list(): Promise<SupervisionRecord[]>;
  get(sessionId: string): Promise<SupervisionRecord | null>;
  close(sessionId: string, status: 'closed' | 'exited'): Promise<{ ok: boolean; error?: unknown }>;
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
   * conversation id when context should continue (restart) and is omitted when
   * it should be dropped (compact).
   */
  spawnFresh(input: { agentId: string; resumeFrom?: string | null }):
    Promise<{ ok: true; value: { sessionId: string; model: string } } | { ok: false; error: { code: string; message: string } }>;
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
  meta?: Record<string, unknown>;
}

export interface SupervisionDeps {
  sessions: SupervisionSessions;
  lifecycle: SupervisionLifecycle;
  transport: SupervisedTransport;
  usage: UsageReader;
  trace(input: TraceInput): Promise<{ ok: boolean; error?: unknown }>;
  broadcast(name: string, data: unknown): void;
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
  /** The raw running total, when the provider reports one. */
  providerTotalInputTokens: number | null;
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
  runSupervisedTask(input: { sessionId: string; agentId: string; brief: string }): Promise<GateOutcome>;
  /** DEC-B1-12: one cheap-first check-in tick across every running session. */
  checkDrift(): Promise<DriftReport>;
  /** DEC-B1-11: the table, from real data. */
  usageTable(): Promise<UsageTable>;
  /** Emit the table: append + broadcast + trace. */
  emitUsage(): Promise<UsageTable>;
  terminate(sessionId: string, reason: string): Promise<LifecycleResult>;
  restart(sessionId: string): Promise<LifecycleResult>;
  compact(sessionId: string): Promise<LifecycleResult>;
  /** Start the two timers (usage + drift). */
  start(): void;
  stop(): void;
}

interface DriftState {
  lastSeenActivityAt: string;
  staleIntervals: number;
  consecutiveDrift: number;
  drifting: boolean;
}

const notFound = (sessionId: string): LifecycleResult => ({
  ok: false,
  error: { code: 'SessionNotFound', message: `no providerSession "${sessionId}"` },
});

export function createSupervisionEngine(deps: SupervisionDeps): SupervisionEngine {
  const now = deps.now ?? (() => new Date().toISOString());
  const driftStates = new Map<string, DriftState>();
  /** sessionId → drifting, so the usage table Chris reads carries the flag. */
  const driftFlags = new Set<string>();
  let usageTimer: ReturnType<typeof setInterval> | null = null;
  let driftTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Every supervision action lands here. A trace that cannot be written is
   * REPORTED (red gate 7 is about never being silent, and a silently dropped
   * trace is exactly that) — but it never aborts the action it describes,
   * because a terminate that half-happened is worse than an untraced one.
   */
  const traced = async (event: string, sessionId: string, meta: Record<string, unknown> = {}): Promise<void> => {
    const res = await deps.trace({
      // 'session.terminate' is the one named action foundation already carries.
      action: event === 'session.terminate' ? 'session.terminate' : 'hook_log',
      target: { kind: 'session', id: sessionId },
      meta: { event, at: now(), ...meta },
    });
    if (!res.ok) {
      const error = res.error as { code?: string; message?: string } | undefined;
      deps.onTraceFailure?.(
        `supervision trace "${event}" for ${sessionId} failed: ${error?.code ?? 'unknown'} ${error?.message ?? ''}`.trim(),
      );
    }
  };

  const running = async (): Promise<SupervisionRecord[]> =>
    (await deps.sessions.list()).filter((r) => r.status === 'running');

  // ── the skills gate ──────────────────────────────────────────────────────

  const runSupervisedTask: SupervisionEngine['runSupervisedTask'] = async (input) => {
    const gatePrompt = buildGatePrompt({ brief: input.brief, skillPaths: deps.skillPaths });
    const answer = await deps.transport.ask(input.sessionId, gatePrompt);
    const reply = answer.text ?? '';
    const verdict = answer.ok ? validateSkillsMarker(reply) : { ok: false as const, reason: 'no-reply' as GateFailure, confirmed: [] };

    if (!verdict.ok) {
      // §13 SEVERE-3: terminated + drift event + trace, and NO work turn ever
      // sent. The brief has not been built into a prompt at any point above.
      await traced('supervision.gate.fail', input.sessionId, {
        agentId: input.agentId, reason: verdict.reason, replyPreview: reply.slice(0, 200),
      });
      await traced('supervision.drift', input.sessionId, {
        agentId: input.agentId, cause: 'skills-gate', reason: verdict.reason,
      });
      driftFlags.add(input.sessionId);
      await terminate(input.sessionId, `skills gate failed: ${verdict.reason}`);
      return { ok: false, sessionId: input.sessionId, reason: verdict.reason, reply };
    }

    await traced('supervision.gate.pass', input.sessionId, {
      agentId: input.agentId, confirmed: verdict.confirmed,
    });

    const work = await deps.transport.ask(
      input.sessionId,
      buildWorkPrompt({ brief: input.brief, skillPaths: deps.skillPaths, confirmed: verdict.confirmed }),
    );
    const workText = work.text ?? '';
    await traced('supervision.work', input.sessionId, {
      agentId: input.agentId,
      taskComplete: declaresTaskComplete(workText),
      subagentSkillsStated: hasSubagentSkillsStatement(workText),
    });
    return {
      ok: true,
      sessionId: input.sessionId,
      confirmed: verdict.confirmed,
      reply,
      work: workText,
      taskComplete: declaresTaskComplete(workText),
      subagentSkillsStated: hasSubagentSkillsStatement(workText),
    };
  };

  // ── cheap-first drift (SR-1) ─────────────────────────────────────────────

  /**
   * FREE liveness evidence only: the registry's own activity stamp and the
   * provider transcript's newest line. No provider turn is spent to learn
   * whether a session is alive — that is the whole point of SR-1.
   */
  const freeActivityOf = (record: SupervisionRecord): string => {
    const fromTranscript = deps.usage.read({
      sessionId: record.sessionId, provider: record.provider,
      providerConversationId: record.providerConversationId, cwd: record.cwd,
    }).lastActivityAt;
    if (!fromTranscript) return record.lastActivityAt;
    return Date.parse(fromTranscript) > Date.parse(record.lastActivityAt)
      ? fromTranscript : record.lastActivityAt;
  };

  const checkDrift: SupervisionEngine['checkDrift'] = async () => {
    const at = now();
    const intervalMs = deps.policy.driftIntervalSec * 1000;
    const rows: DriftRow[] = [];
    let providerTurnsSpent = 0;

    for (const record of await running()) {
      const activityAt = freeActivityOf(record);
      const state = driftStates.get(record.sessionId) ?? {
        lastSeenActivityAt: activityAt, staleIntervals: 0, consecutiveDrift: 0, drifting: false,
      };
      const quiet = Date.parse(at) - Date.parse(activityAt) >= intervalMs;
      const moved = Date.parse(activityAt) > Date.parse(state.lastSeenActivityAt);
      state.lastSeenActivityAt = activityAt;

      if (!quiet || moved) {
        // Alive on free evidence. Nothing is spent, nothing is escalated.
        state.staleIntervals = 0;
        state.consecutiveDrift = 0;
        state.drifting = false;
        driftFlags.delete(record.sessionId);
        driftStates.set(record.sessionId, state);
        rows.push({
          sessionId: record.sessionId, agentId: record.agentId, live: true,
          staleIntervals: 0, consecutiveDrift: 0, action: 'none', lastActivityAt: activityAt,
        });
        continue;
      }

      state.staleIntervals += 1;
      // §13 disposition 8: stale = no activity for TWO consecutive intervals.
      // One quiet interval buys no turn — a thinking agent is not a dead one.
      if (state.staleIntervals < 2) {
        driftStates.set(record.sessionId, state);
        rows.push({
          sessionId: record.sessionId, agentId: record.agentId, live: false,
          staleIntervals: state.staleIntervals, consecutiveDrift: state.consecutiveDrift,
          action: 'none', lastActivityAt: activityAt,
        });
        continue;
      }

      // Only now is a real turn spent, via the lawful ask path (never stdin
      // injection — red gate S2-3).
      providerTurnsSpent += 1;
      const ping = await deps.transport.ask(
        record.sessionId,
        'Status check: reply with one line — what are you working on right now?',
      );
      await traced('supervision.ping', record.sessionId, {
        agentId: record.agentId, staleIntervals: state.staleIntervals, answered: ping.ok,
      });

      if (ping.ok && ping.text.trim()) {
        state.staleIntervals = 0;
        state.consecutiveDrift = 0;
        state.drifting = false;
        driftFlags.delete(record.sessionId);
        driftStates.set(record.sessionId, state);
        rows.push({
          sessionId: record.sessionId, agentId: record.agentId, live: true,
          staleIntervals: 0, consecutiveDrift: 0, action: 'pinged', lastActivityAt: activityAt,
        });
        continue;
      }

      state.consecutiveDrift += 1;
      state.drifting = true;
      state.staleIntervals = 2; // stay stale so the next interval pings again
      driftFlags.add(record.sessionId);
      driftStates.set(record.sessionId, state);
      await traced('supervision.drift', record.sessionId, {
        agentId: record.agentId, consecutiveDrift: state.consecutiveDrift, cause: 'no-reply-to-ping',
      });

      let action: DriftAction = 'drift';
      if (state.consecutiveDrift >= 3) {
        action = 'escalated';
        await deps.escalate(
          `Session ${record.sessionId} (agent ${record.agentId}, ${record.provider}) has not answered `
          + `${state.consecutiveDrift} consecutive check-ins. Last activity ${activityAt}.`,
        );
        await traced('supervision.escalate', record.sessionId, {
          agentId: record.agentId, consecutiveDrift: state.consecutiveDrift,
        });
        state.consecutiveDrift = 0; // escalated once; the counter restarts
        driftStates.set(record.sessionId, state);
      }
      rows.push({
        sessionId: record.sessionId, agentId: record.agentId, live: false,
        staleIntervals: state.staleIntervals, consecutiveDrift: state.consecutiveDrift,
        action, lastActivityAt: activityAt,
      });
    }

    return { at, rows, providerTurnsSpent };
  };

  // ── the usage table ──────────────────────────────────────────────────────

  const rowFor = (record: SupervisionRecord, usage: SessionUsage): UsageRow => ({
    sessionId: record.sessionId,
    agentId: record.agentId,
    provider: record.provider,
    model: record.model,
    turns: record.turns,
    status: record.status,
    lastActivityAt: usage.lastActivityAt ?? record.lastActivityAt,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheCreationTokens: usage.cacheCreationTokens,
    cumulativeAdjusted: usage.cumulativeAdjusted,
    providerTotalInputTokens: usage.providerTotal?.inputTokens ?? null,
    interrupted: record.lastInterruption?.clientOpId ?? null,
    drift: driftFlags.has(record.sessionId),
    note: usage.note,
  });

  const usageTable: SupervisionEngine['usageTable'] = async () => {
    const records = await deps.sessions.list();
    const rows = records.map((record) => rowFor(record, deps.usage.read({
      sessionId: record.sessionId, provider: record.provider,
      providerConversationId: record.providerConversationId, cwd: record.cwd,
    })));
    return {
      at: now(),
      rows,
      tokenAccounting:
        'read from provider transcripts: claude per-message (deduped by message id), '
        + 'kimi wire.jsonl step.end, codex rollout total_token_usage with a per-session '
        + 'baseline subtracted (its totals are cumulative). null = no readable transcript.',
    };
  };

  const emitUsage: SupervisionEngine['emitUsage'] = async () => {
    const table = await usageTable();
    await deps.appendUsage(table.rows);
    deps.broadcast('usage', table);
    await traced('supervision.usage', 'all', { sessions: table.rows.length });
    return table;
  };

  // ── lifecycle ────────────────────────────────────────────────────────────

  async function terminate(sessionId: string, reason: string): Promise<LifecycleResult> {
    const record = await deps.sessions.get(sessionId);
    if (!record) return notFound(sessionId);
    deps.lifecycle.closeSession(sessionId);
    const closed = await deps.sessions.close(sessionId, 'closed');
    driftStates.delete(sessionId);
    driftFlags.delete(sessionId);
    deps.usage.forget(sessionId);
    await traced('session.terminate', sessionId, { agentId: record.agentId, reason });
    if (!closed.ok) {
      return { ok: false, error: { code: 'RegistryWriteFailed', message: `could not close "${sessionId}"` } };
    }
    return { ok: true, sessionId };
  }

  /**
   * DEC-B1-13. restart CARRIES the provider conversation id (the work
   * continues); compact DROPS it. Chris asked for "terminate after any
   * meaningful work and re-start… compact as an option" — this is both halves,
   * and the difference between them is exactly one field.
   */
  const respawn = async (sessionId: string, carryContext: boolean): Promise<LifecycleResult> => {
    const record = await deps.sessions.get(sessionId);
    if (!record) return notFound(sessionId);
    const ended = await terminate(sessionId, carryContext ? 'restart' : 'compact');
    if (!ended.ok) return ended;
    const fresh = await deps.lifecycle.spawnFresh({
      agentId: record.agentId,
      resumeFrom: carryContext ? record.providerConversationId : null,
    });
    if (!fresh.ok) return { ok: false, error: fresh.error };
    const mechanism = 'restart-fresh' as const;
    await traced(carryContext ? 'supervision.restart' : 'supervision.compact', fresh.value.sessionId, {
      agentId: record.agentId, previousSessionId: sessionId,
      resumedFrom: carryContext ? record.providerConversationId : null,
      mechanism,
    });
    // Fresh thread: bill it in full rather than baselining away its first turn.
    deps.usage.trackSession(fresh.value.sessionId, { threadPreexisting: carryContext });
    return { ok: true, sessionId: fresh.value.sessionId, mechanism };
  };

  return {
    runSupervisedTask,
    checkDrift,
    usageTable,
    emitUsage,
    terminate,
    restart: (sessionId) => respawn(sessionId, true),
    // No provider in B1 declares a native compact, so restart-fresh IS the
    // compact (DEC-B1-5) — and the result SAYS which mechanism ran.
    compact: (sessionId) => respawn(sessionId, false),
    start() {
      if (!usageTimer) {
        usageTimer = setInterval(() => { void emitUsage(); }, deps.policy.usageIntervalSec * 1000);
        usageTimer.unref?.();
      }
      if (!driftTimer) {
        driftTimer = setInterval(() => { void checkDrift(); }, deps.policy.driftIntervalSec * 1000);
        driftTimer.unref?.();
      }
    },
    stop() {
      if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
      if (driftTimer) { clearInterval(driftTimer); driftTimer = null; }
    },
  };
}
