// B1b slice 5b — the SUPERVISION ENGINE (§8, DEC-B1-10…15).
//
// The engine owns four behaviours Chris asked for by name: the skills gate
// before any work, cheap-first drift check-ins, terminate-and-restart after
// meaningful work, and a usage table every 5–10 minutes. Every one of them is a
// trace line (DEC-B1-15, red gate 7) — this suite fails if any goes silent.
//
// It runs against fakes for the four seams the engine crosses (registry,
// transport, trace, escalation), so the RULES are what is under test, not a
// provider or a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createSupervisionEngine,
  type AskResult,
  type SupervisionFailure,
  type SupervisionDeps,
} from '../core/supervision/engine.js';
import {
  createUsageReader,
  type UsageReader,
  type UsageSessionRef,
} from '../core/supervision/usage.js';
import type { ProviderSessionRecord } from '../../agents/contract/index.js';

// ── fakes ──────────────────────────────────────────────────────────────────

interface TraceLine { action: string; targetId: string; meta: Record<string, unknown> }

function record(partial: Partial<ProviderSessionRecord> = {}): ProviderSessionRecord {
  return {
    sessionId: 'sess_1', agentId: 'agent_1', provider: 'codex',
    providerConversationId: 'thread_1', cwd: '/tmp/repo', model: 'cli-default',
    spawnedAt: '2026-07-28T10:00:00.000Z', lastActivityAt: '2026-07-28T10:00:00.000Z',
    turns: 0, status: 'running',
    inFlight: { clientOpId: null, status: 'none', pid: null, pidStartedAt: null, queue: [] },
    lastInterruption: null,
    tokenUsage: null,
    usageUnavailable: null,
    ...partial,
  };
}

function harness(options: {
  records?: ProviderSessionRecord[];
  replies?: string[];
  now?: () => string;
  canResume?: boolean;
  ask?: (sessionId: string, prompt: string) => Promise<AskResult>;
  escalate?: (text: string) => Promise<void>;
  broadcast?: (name: string, data: unknown) => void | Promise<void>;
  usage?: UsageReader;
  policy?: Partial<SupervisionDeps['policy']>;
} = {}) {
  const traces: TraceLine[] = [];
  const asked: Array<{ sessionId: string; prompt: string }> = [];
  const closed: string[] = [];
  const spawned: string[] = [];
  const escalations: string[] = [];
  const broadcasts: Array<{ name: string; data: unknown }> = [];
  const appended: unknown[][] = [];
  const failures: SupervisionFailure[] = [];
  const usageReads: UsageSessionRef[] = [];
  const replies = [...(options.replies ?? [])];
  let records = options.records ?? [record()];
  let clock = Date.parse('2026-07-28T10:00:00.000Z');

  const deps: SupervisionDeps = {
    sessions: {
      list: async () => records,
      get: async (id) => records.find((r) => r.sessionId === id) ?? null,
      close: async (id) => {
        records = records.map((r) => (r.sessionId === id ? { ...r, status: 'closed' as const } : r));
        return { ok: true, value: records.find((r) => r.sessionId === id)! };
      },
      recordUsage: async (id, usage) => {
        records = records.map((current) => current.sessionId !== id
          ? current
          : usage.kind === 'measured'
            ? {
              ...current,
              tokenUsage: {
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheCreationTokens: usage.cacheCreationTokens,
                source: usage.source,
                measuredAt: usage.measuredAt,
                ...(usage.usagePartial ? { usagePartial: true as const } : {}),
              },
              usageUnavailable: null,
            }
            : {
              ...current,
              tokenUsage: null,
              usageUnavailable: {
                code: 'UsageUnavailable' as const,
                reason: usage.reason,
                checkedAt: usage.checkedAt,
              },
            });
        return { ok: true };
      },
    },
    lifecycle: {
      closeSession: (id) => { closed.push(id); return true; },
      async spawnFresh(input) {
        spawned.push(input.agentId);
        const resumed = options.canResume !== false && Boolean(input.resumeFrom);
        const fresh = record({
          sessionId: `sess_fresh_${spawned.length}`, agentId: input.agentId,
          providerConversationId: resumed ? input.resumeFrom ?? null : null,
        });
        records = [...records, fresh];
        return { ok: true, value: { sessionId: fresh.sessionId, model: fresh.model, resumed } };
      },
    },
    transport: {
      async ask(sessionId, prompt) {
        asked.push({ sessionId, prompt });
        if (options.ask) return options.ask(sessionId, prompt);
        const next = replies.shift();
        return next === undefined
          ? { ok: false as const, reason: 'no-reply' as const, text: '' }
          : { ok: true as const, text: next };
      },
    },
    usage: options.usage ?? (() => {
      const reader = createUsageReader({ home: mkdtempSync(path.join(tmpdir(), 'nvk-usage-home-')) });
      return {
        trackSession: reader.trackSession,
        forget: reader.forget,
        read(session: UsageSessionRef) {
          usageReads.push(session);
          return reader.read(session);
        },
        readMany(sessions: UsageSessionRef[]) {
          usageReads.push(...sessions);
          return reader.readMany(sessions);
        },
      };
    })(),
    async trace(input) {
      traces.push({ action: input.action, targetId: input.target.id, meta: input.meta ?? {} });
      return { ok: true };
    },
    broadcast: (name, data) => {
      broadcasts.push({ name, data });
      return options.broadcast?.(name, data);
    },
    async appendUsage(rows) { appended.push(rows); },
    async escalate(text) {
      escalations.push(text);
      await options.escalate?.(text);
    },
    policy: {
      usageIntervalSec: 300,
      driftIntervalSec: 300,
      idleTimeoutSec: 900,
      ...options.policy,
    },
    skillPaths: ['/skills/tdd/SKILL.md'],
    now: options.now ?? (() => new Date(clock).toISOString()),
    onFailure: (failure) => failures.push(failure),
  };

  return {
    engine: createSupervisionEngine(deps),
    traces, asked, closed, spawned, escalations, broadcasts, appended, usageReads, failures,
    setRecords: (next: ProviderSessionRecord[]) => { records = next; },
    getRecords: () => records,
    advance: (seconds: number) => { clock += seconds * 1000; },
  };
}

const actions = (traces: TraceLine[]): string[] => traces.map((t) => String(t.meta.event ?? t.action));

// ── the skills gate ────────────────────────────────────────────────────────

test('a valid marker unlocks the work turn, and both turns are traced', async () => {
  const h = harness({ replies: ['SKILLS-CONFIRMED: tdd, handoff', 'working on it'] });

  const res = await h.engine.runSupervisedTask({
    sessionId: 'sess_1', agentId: 'agent_1', brief: 'Build the widget.',
  });

  assert.equal(res.ok, true);
  assert.deepEqual(res.confirmed, ['tdd', 'handoff']);
  assert.equal(h.asked.length, 2, 'turn 1 = the demand, turn 2 = the work');
  assert.match(h.asked[0]!.prompt, /SKILLS-CONFIRMED:/);
  assert.doesNotMatch(h.asked[0]!.prompt, /Build the widget/, 'the brief is withheld until the gate passes');
  assert.match(h.asked[1]!.prompt, /Build the widget/);
  assert.ok(actions(h.traces).includes('supervision.gate.pass'));
  assert.equal(h.closed.length, 0);
});

test('an invalid marker terminates the session and the work turn is NEVER sent', async () => {
  const h = harness({ replies: ['Skills applied, ready to go!'] });

  const res = await h.engine.runSupervisedTask({
    sessionId: 'sess_1', agentId: 'agent_1', brief: 'Build the widget.',
  });

  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-marker');
  assert.equal(h.asked.length, 1, 'exactly one turn was spent — the brief was never sent');
  assert.ok(h.asked.every((a) => !a.prompt.includes('Build the widget')));
  assert.deepEqual(h.closed, ['sess_1'], 'a failed gate terminates, per §13 SEVERE-3');
  const events = actions(h.traces);
  assert.ok(events.includes('supervision.gate.fail'));
  assert.ok(events.includes('supervision.drift'), 'a failed gate is also a drift event');
  assert.ok(events.includes('session.terminate'));
});

test('a marker buried under prose is refused exactly like no marker at all', async () => {
  const h = harness({ replies: ['Here we go!\nSKILLS-CONFIRMED: tdd'] });
  const res = await h.engine.runSupervisedTask({
    sessionId: 'sess_1', agentId: 'agent_1', brief: 'Build it.',
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'marker-not-first-line');
  assert.deepEqual(h.closed, ['sess_1']);
});

test('a silent agent fails the gate as no-reply and is terminated', async () => {
  const h = harness({ replies: [] });
  const res = await h.engine.runSupervisedTask({
    sessionId: 'sess_1', agentId: 'agent_1', brief: 'Build it.',
  });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-reply');
  assert.deepEqual(h.closed, ['sess_1']);
});

test('a work reply declaring TASK-COMPLETE is reported so the engine can terminate after it', async () => {
  const h = harness({ replies: ['SKILLS-CONFIRMED: tdd', 'all done\nSUBAGENT-SKILLS: none spawned\nTASK-COMPLETE'] });
  const res = await h.engine.runSupervisedTask({
    sessionId: 'sess_1', agentId: 'agent_1', brief: 'Build it.',
  });
  assert.equal(res.ok, true);
  assert.equal(res.taskComplete, true);
  assert.equal(res.subagentSkillsStated, true);
});

test('a work reply with no subagent statement is reported, not silently accepted', async () => {
  const h = harness({ replies: ['SKILLS-CONFIRMED: tdd', 'done, no marker'] });
  const res = await h.engine.runSupervisedTask({
    sessionId: 'sess_1', agentId: 'agent_1', brief: 'Build it.',
  });
  assert.equal(res.ok, true);
  assert.equal(res.subagentSkillsStated, false,
    'Chris made the supervisor responsible for the cascade — an unstated cascade is visible');
});

// ── cheap-first drift (DEC-B1-12 / SR-1) ───────────────────────────────────

test('a LIVE session costs ZERO provider turns to check (SR-1: never burn a turn on a timer)', async () => {
  const h = harness();
  h.advance(60);
  h.setRecords([record({ lastActivityAt: new Date(Date.parse('2026-07-28T10:00:30.000Z')).toISOString() })]);

  const report = await h.engine.checkDrift();

  assert.equal(h.asked.length, 0, 'not one provider turn was spent on a healthy session');
  assert.equal(report.rows[0]!.live, true);
  assert.equal(report.rows[0]!.action, 'none');
  assert.equal(report.providerTurnsSpent, 0);
});

test('staleness needs TWO consecutive quiet intervals before a turn is spent (§13 disposition 8)', async () => {
  const h = harness({ replies: ['still here'] });
  // Activity stopped at 10:00:00 and never resumes.
  h.setRecords([record({ lastActivityAt: '2026-07-28T10:00:00.000Z' })]);

  h.advance(301); // one interval of silence
  const first = await h.engine.checkDrift();
  assert.equal(first.providerTurnsSpent, 0, 'one quiet interval is not yet stale');
  assert.equal(first.rows[0]!.staleIntervals, 1);

  h.advance(301); // a second interval of silence
  const second = await h.engine.checkDrift();
  assert.equal(second.providerTurnsSpent, 1, 'now, and only now, a paid ping');
  assert.equal(second.rows[0]!.action, 'pinged');
  assert.ok(actions(h.traces).includes('supervision.ping'));
});

test('a stale session that answers the ping is healthy again — no drift event', async () => {
  const h = harness({ replies: ['still here, mid-build'] });
  h.setRecords([record({ lastActivityAt: '2026-07-28T10:00:00.000Z' })]);
  h.advance(301); await h.engine.checkDrift();
  h.advance(301);

  const report = await h.engine.checkDrift();

  assert.equal(report.rows[0]!.action, 'pinged');
  assert.equal(actions(h.traces).includes('supervision.drift'), false, 'it answered — that is not drift');
});

test('an overlapping slow drift tick is coalesced — one ping and one counter transition', async () => {
  let releasePing!: (answer: AskResult) => void;
  const slowPing = new Promise<AskResult>((resolve) => { releasePing = resolve; });
  const h = harness({ ask: async () => slowPing });
  h.setRecords([record({ lastActivityAt: '2026-07-28T10:00:00.000Z' })]);

  h.advance(301);
  await h.engine.checkDrift(); // first quiet interval: no paid turn
  h.advance(301);
  const first = h.engine.checkDrift();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const overlapping = h.engine.checkDrift();
  assert.equal(h.asked.length, 1, 'a second interval callback cannot start a second paid ping');

  releasePing({ ok: true, text: 'still working' });
  const [a, b] = await Promise.all([first, overlapping]);
  assert.equal(h.asked.length, 1, 'completion still contains one provider invocation');
  assert.equal(actions(h.traces).filter((event) => event === 'supervision.ping').length, 1);
  assert.deepEqual(b, a, 'the skipped caller observes the one authoritative tick result');
  assert.equal(a.providerTurnsSpent, 1);
  assert.equal(a.rows[0]!.action, 'pinged');
  assert.equal(a.rows[0]!.staleIntervals, 0, 'the state counter advances exactly once');
});

test('no reply to the ping is a drift event + trace; three in a row escalates to Chris', async () => {
  const h = harness({ replies: [] }); // the agent never answers again
  h.setRecords([record({ lastActivityAt: '2026-07-28T10:00:00.000Z' })]);

  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    h.advance(301);
    const report = await h.engine.checkDrift();
    seen.push(report.rows[0]!.action);
  }

  assert.deepEqual(seen, ['none', 'drift', 'drift', 'escalated'],
    'one quiet interval, then three unanswered pings, then Chris hears about it');
  assert.equal(h.escalations.length, 1);
  assert.match(h.escalations[0]!, /sess_1/);
  assert.ok(actions(h.traces).includes('supervision.escalate'));
});

test('a rejected escalation is contained and leaves drift eligible for retry', async () => {
  const h = harness({
    replies: [],
    escalate: async () => { throw new Error('messaging offline'); },
  });
  h.setRecords([record({ lastActivityAt: '2026-07-28T10:00:00.000Z' })]);

  for (let i = 0; i < 3; i++) {
    h.advance(301);
    await h.engine.checkDrift();
  }
  h.advance(301);
  const report = await h.engine.checkDrift();

  assert.equal(report.rows[0]!.action, 'drift',
    'a failed delivery is not falsely reported as an escalation');
  assert.equal(report.rows[0]!.consecutiveDrift, 3,
    'the counter is retained so the next interval retries escalation');
  assert.deepEqual(h.failures.map((failure) => failure.code), ['EscalationFailed']);
});

test('a closed session is not checked for drift and never costs a turn', async () => {
  const h = harness({ replies: ['unused'] });
  h.setRecords([record({ status: 'closed', lastActivityAt: '2026-07-28T09:00:00.000Z' })]);
  h.advance(3600);

  const report = await h.engine.checkDrift();

  assert.equal(report.rows.length, 0);
  assert.equal(h.asked.length, 0);
});

// ── lifecycle (DEC-B1-13) ──────────────────────────────────────────────────

test('terminate closes the session, marks the registry, and traces session.terminate', async () => {
  const h = harness();
  const res = await h.engine.terminate('sess_1', 'task complete');

  assert.equal(res.ok, true);
  assert.deepEqual(h.closed, ['sess_1']);
  assert.equal(h.getRecords()[0]!.status, 'closed');
  const trace = h.traces.find((t) => t.action === 'session.terminate');
  assert.ok(trace, 'red gate 7: a termination is never silent');
  assert.equal(trace!.meta.reason, 'task complete');
});

test('restart terminates and spawns fresh CARRYING the resume handle — context continues', async () => {
  const h = harness();
  const res = await h.engine.restart('sess_1');

  assert.equal(res.ok, true);
  assert.deepEqual(h.closed, ['sess_1']);
  assert.deepEqual(h.spawned, ['agent_1']);
  assert.equal(res.sessionId, 'sess_fresh_1');
  const fresh = h.getRecords().find((r) => r.sessionId === 'sess_fresh_1')!;
  assert.equal(fresh.providerConversationId, 'thread_1', 'the provider conversation is resumed');
  const trace = h.traces.find((line) => line.meta.event === 'supervision.restart')!;
  assert.equal(trace.meta.resumed, true);
  assert.equal(trace.meta.resumedFrom, 'thread_1');
  assert.equal(h.usageReads.some((read) => read.sessionId === 'sess_fresh_1'), true,
    'the cumulative baseline is captured before the first post-restart turn');
});

test('restart degrades truthfully when a provider cannot resume at spawn', async () => {
  const h = harness({ canResume: false });

  const res = await h.engine.restart('sess_1');

  assert.equal(res.ok, true, 'a fresh thread is still a viable restart fallback');
  const fresh = h.getRecords().find((r) => r.sessionId === 'sess_fresh_1')!;
  assert.equal(fresh.providerConversationId, null);
  const trace = h.traces.find((line) => line.meta.event === 'supervision.restart')!;
  assert.equal(trace.meta.resumed, false);
  assert.equal(trace.meta.resumedFrom, null, 'the trace never claims continuity that did not happen');
});

test('compact is restart-fresh where no native compact exists — and SAYS so', async () => {
  const h = harness();
  const res = await h.engine.compact('sess_1');

  assert.equal(res.ok, true);
  assert.equal(res.mechanism, 'restart-fresh',
    'DEC-B1-5: restart-fresh IS the compact where a provider has none — declared, not implied');
  const fresh = h.getRecords().find((r) => r.sessionId === 'sess_fresh_1')!;
  assert.equal(fresh.providerConversationId, null, 'the point of a compact is dropping the context');
  assert.ok(actions(h.traces).includes('supervision.compact'));
});

test('lifecycle calls on an unknown session fail typed, never throw', async () => {
  const h = harness();
  for (const call of [
    h.engine.terminate('sess_ghost', 'x'),
    h.engine.restart('sess_ghost'),
    h.engine.compact('sess_ghost'),
  ]) {
    const res = await call;
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.error.code, 'SessionNotFound');
  }
});

// ── the usage table (DEC-B1-11) ────────────────────────────────────────────

test('the usage table is emitted, appended and broadcast — all three, every interval', async () => {
  const h = harness();
  const table = await h.engine.usageTable();

  assert.equal(table.rows.length, 1);
  assert.equal(table.rows[0]!.sessionId, 'sess_1');
  assert.equal(table.rows[0]!.provider, 'codex');

  await h.engine.emitUsage();
  assert.equal(h.appended.length, 1, 'appended to .novakai/supervision/usage.jsonl (server sole writer)');
  assert.equal(h.broadcasts.filter((b) => b.name === 'usage').length, 1, 'broadcast as the `usage` WS event');
  assert.ok(actions(h.traces).includes('supervision.usage'));
});

test('a throwing usage broadcast is contained instead of rejecting emitUsage', async () => {
  const h = harness({
    broadcast: async () => { throw new Error('socket fanout failed'); },
  });

  const table = await h.engine.emitUsage();

  assert.equal(table.rows.length, 1);
  assert.equal(h.appended.length, 1, 'the durable usage append still completed');
  assert.deepEqual(h.failures.map((failure) => failure.code), ['UsageBroadcastFailed']);
});

test('the periodic void emitUsage path reports a typed failure without an unhandled rejection', async () => {
  const h = harness({
    policy: { usageIntervalSec: 0.01, driftIntervalSec: 3600 },
    usage: {
      trackSession: () => undefined,
      forget: () => undefined,
      read: async () => { throw new Error('usage reader failed'); },
      readMany: async () => { throw new Error('usage reader failed'); },
    },
  });

  h.engine.start();
  await new Promise((resolve) => setTimeout(resolve, 35));
  h.engine.stop();

  assert.ok(h.failures.some((failure) =>
    failure.code === 'UsageTickFailed' && failure.operation === 'emitUsage'));
});

test('a session with no readable transcript reports null counts and states the gap', async () => {
  const h = harness();
  const table = await h.engine.usageTable();
  const row = table.rows[0]!;
  assert.equal(row.inputTokens, null, 'null, never a guessed zero');
  assert.match(row.note, /transcript/i);
});

test('the table carries turns, model, activity and status from the registry — always real', async () => {
  const h = harness();
  h.setRecords([record({ turns: 7, model: 'gpt-5.1-codex', status: 'running' })]);
  const row = (await h.engine.usageTable()).rows[0]!;
  assert.equal(row.turns, 7);
  assert.equal(row.model, 'gpt-5.1-codex');
  assert.equal(row.status, 'running');
});

// ── never silent (red gate 7 / DEC-B1-15) ─────────────────────────────────

test('a failing trace write is surfaced, not swallowed', async () => {
  const failures: string[] = [];
  const broken = createSupervisionEngine({
    sessions: {
      list: async () => [record()],
      get: async () => record(),
      close: async () => ({ ok: true, value: record() }),
      recordUsage: async () => ({ ok: true }),
    },
    lifecycle: {
      closeSession: () => true,
      spawnFresh: async () => ({ ok: true, value: { sessionId: 'sess_x', model: 'm', resumed: false } }),
    },
    transport: { ask: async () => ({ ok: true as const, text: 'SKILLS-CONFIRMED: tdd' }) },
    usage: createUsageReader({ home: mkdtempSync(path.join(tmpdir(), 'nvk-usage-home-')) }),
    trace: async () => ({ ok: false, error: { code: 'TraceIncomplete', message: 'disk full' } }),
    broadcast: () => undefined,
    appendUsage: async () => undefined,
    escalate: async () => undefined,
    policy: { usageIntervalSec: 300, driftIntervalSec: 300, idleTimeoutSec: 900 },
    skillPaths: ['/skills/tdd/SKILL.md'],
    onTraceFailure: (reason) => failures.push(reason),
  });

  await broken.terminate('sess_1', 'x');
  assert.ok(failures.length > 0, 'a supervision action whose trace failed must say so');
  assert.match(failures[0]!, /TraceIncomplete|disk full/);
});
