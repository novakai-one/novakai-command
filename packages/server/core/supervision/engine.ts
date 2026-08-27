// packages/server/core/supervision/engine.ts — SUPERVISION v1 (§8).
//
// Four of Chris's verbatim requirements meet here, and each one is a rule the
// engine can actually enforce rather than a habit it hopes to keep:
//
//   DEC-B1-10  skills confirmed BEFORE any work            (two-turn gate)
//   DEC-B1-12  legacy drift checks, explicit only (never scheduled)
//   DEC-B1-13  terminate after meaningful work + restart   (+ compact option)
//   DEC-B1-11  a real per-session usage table every 5–10 min
//
// DEC-B1-15 / red gate 7 binds all four: every supervision action appends a
// system.action trace. After the SUPFIX step-0 split this file is the
// COMPOSITION: seams/outputs live in types.ts, drift in drift.ts, the usage
// table in usage-table.ts, lifecycle in lifecycle.ts. Every name exported
// before the split keeps resolving from here.
import { buildGatePrompt, buildWorkPrompt, declaresTaskComplete, hasSubagentSkillsStatement, validateSkillsMarker, type GateFailure } from './gate.js';
import { createDriftChecker } from './drift.js';
import { createLifecycle } from './lifecycle.js';
import { createUsageTable } from './usage-table.js';
import type {
  DriftState, SupervisionDeps, SupervisionEngine, SupervisionFailure, SupervisionInternals, SupervisionRecord,
} from './types.js';

export type {
  AskResult, DriftAction, DriftReport, DriftRow, GateOutcome, LifecycleResult,
  SupervisedTransport, SupervisionDeps, SupervisionEngine, SupervisionFailure,
  SupervisionLifecycle, SupervisionRecord, SupervisionSessions, TraceInput,
  UsageRow, UsageTable,
} from './types.js';

export function createSupervisionEngine(deps: SupervisionDeps): SupervisionEngine {
  const now = deps.now ?? (() => new Date().toISOString());
  const driftStates = new Map<string, DriftState>();
  /** sessionId → drifting, so the usage table Chris reads carries the flag. */
  const driftFlags = new Set<string>();
  let usageTimer: ReturnType<typeof setInterval> | null = null;
  const seenFailureStacks = new Set<string>();
  const reportFailure = (
    code: SupervisionFailure['code'],
    operation: SupervisionFailure['operation'],
    cause: unknown,
  ): SupervisionFailure => {
    // SUPFIX-07: the FIRST occurrence of a distinct failure carries its full
    // stack; repeats stay one line. 157 identical stackless lines is how the
    // wrong-shape-record crash stayed misdiagnosed for a day.
    const base = cause instanceof Error ? cause.message : String(cause);
    const key = `${code}:${operation}:${base}`;
    const firstSighting = !seenFailureStacks.has(key);
    if (firstSighting) seenFailureStacks.add(key);
    const message = firstSighting && cause instanceof Error && cause.stack
      ? `${base}\n${cause.stack}`
      : base;
    const failure: SupervisionFailure = { code, operation, message };
    deps.onFailure?.(failure);
    return failure;
  };

  /**
   * Every supervision action lands here. A trace that cannot be written is
   * REPORTED (red gate 7 is about never being silent, and a silently dropped
   * trace is exactly that) — but it never aborts the action it describes,
   * because a terminate that half-happened is worse than an untraced one.
   */
  const traced = async (
    event: string,
    sessionId: string,
    meta: Record<string, unknown> = {},
    clientOpId?: string,
  ): Promise<void> => {
    const res = await deps.trace({
      // 'session.terminate' is the one named action foundation already carries.
      action: event === 'session.terminate' ? 'session.terminate' : 'hook_log',
      target: { kind: 'session', id: sessionId },
      ...(clientOpId ? { clientOpId } : {}),
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
  const usageRefOf = (record: SupervisionRecord) => ({
    sessionId: record.sessionId,
    provider: record.provider,
    providerConversationId: record.providerConversationId,
    cwd: record.cwd,
  });

  const internals: SupervisionInternals = {
    deps, now, traced, reportFailure, driftStates, driftFlags, running, usageRefOf,
  };
  const { checkDrift } = createDriftChecker(internals);
  const { usageTable, emitUsage } = createUsageTable(internals);
  const { terminate, respawn } = createLifecycle(internals);

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
      }, input.clientOpId);
      await traced('supervision.drift', input.sessionId, {
        agentId: input.agentId, cause: 'skills-gate', reason: verdict.reason,
      }, input.clientOpId);
      driftFlags.add(input.sessionId);
      await terminate(input.sessionId, `skills gate failed: ${verdict.reason}`, input.clientOpId);
      return { ok: false, sessionId: input.sessionId, reason: verdict.reason, reply };
    }

    await traced('supervision.gate.pass', input.sessionId, {
      agentId: input.agentId, confirmed: verdict.confirmed,
    }, input.clientOpId);

    const work = await deps.transport.ask(
      input.sessionId,
      buildWorkPrompt({ brief: input.brief, skillPaths: deps.skillPaths, confirmed: verdict.confirmed }),
    );
    const workText = work.text ?? '';
    await traced('supervision.work', input.sessionId, {
      agentId: input.agentId,
      taskComplete: declaresTaskComplete(workText),
      subagentSkillsStated: hasSubagentSkillsStatement(workText),
    }, input.clientOpId);
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
        usageTimer = setInterval(() => {
          void emitUsage().catch((cause) => {
            reportFailure('UsageTickFailed', 'emitUsage', cause);
          });
        }, deps.policy.usageIntervalSec * 1000);
        usageTimer.unref?.();
      }
    },
    stop() {
      if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
    },
  };
}
