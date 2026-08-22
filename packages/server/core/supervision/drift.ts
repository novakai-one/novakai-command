// packages/server/core/supervision/drift.ts — cheap-first drift check-ins
// (SR-1, DEC-B1-12; split from engine.ts, SUPFIX step 0).
import type { SessionUsage } from './usage.js';
import type {
  DriftAction, DriftReport, DriftRow, SupervisionEngine, SupervisionInternals, SupervisionRecord,
} from './types.js';

export function createDriftChecker(internals: SupervisionInternals): { checkDrift: SupervisionEngine['checkDrift'] } {
  const { deps, now, traced, reportFailure, driftStates, driftFlags, running, usageRefOf } = internals;
  let driftInFlight: Promise<DriftReport> | null = null;

  /**
   * FREE liveness evidence only: the registry's own activity stamp and the
   * provider transcript's newest line. No provider turn is spent to learn
   * whether a session is alive — that is the whole point of SR-1.
   */
  const freeActivityOf = (record: SupervisionRecord, usage: SessionUsage): string => {
    const fromTranscript = usage.lastActivityAt;
    if (!fromTranscript) return record.lastActivityAt;
    return Date.parse(fromTranscript) > Date.parse(record.lastActivityAt)
      ? fromTranscript : record.lastActivityAt;
  };

  const runDriftCheck = async (): Promise<DriftReport> => {
    const at = now();
    const intervalMs = deps.policy.driftIntervalSec * 1000;
    const rows: DriftRow[] = [];
    let providerTurnsSpent = 0;
    const records = await running();
    const usageBySession = await deps.usage.readMany(records.map(usageRefOf));

    for (const record of records) {
      const usage = usageBySession.get(record.sessionId);
      const activityAt = usage
        ? freeActivityOf(record, usage)
        : record.lastActivityAt;
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
        try {
          await deps.escalate(
            `Session ${record.sessionId} (agent ${record.agentId}, ${record.provider}) has not answered `
            + `${state.consecutiveDrift} consecutive check-ins. Last activity ${activityAt}.`,
          );
          action = 'escalated';
          await traced('supervision.escalate', record.sessionId, {
            agentId: record.agentId, consecutiveDrift: state.consecutiveDrift,
          });
          state.consecutiveDrift = 0; // escalated once; the counter restarts
          driftStates.set(record.sessionId, state);
        } catch (cause) {
          const failure = reportFailure('EscalationFailed', 'escalate', cause);
          await traced('supervision.escalate.failed', record.sessionId, {
            agentId: record.agentId,
            consecutiveDrift: state.consecutiveDrift,
            error: failure,
          });
        }
      }
      rows.push({
        sessionId: record.sessionId, agentId: record.agentId, live: false,
        staleIntervals: state.staleIntervals, consecutiveDrift: state.consecutiveDrift,
        action, lastActivityAt: activityAt,
      });
    }

    return { at, rows, providerTurnsSpent };
  };

  const checkDrift: SupervisionEngine['checkDrift'] = () => {
    if (driftInFlight) return driftInFlight;
    const tick = runDriftCheck();
    driftInFlight = tick;
    const clear = (): void => {
      if (driftInFlight === tick) driftInFlight = null;
    };
    // Observe both branches so clearing the guard never creates a second,
    // ignored rejecting promise.
    void tick.then(clear, clear);
    return tick;
  };

  return { checkDrift };
}
