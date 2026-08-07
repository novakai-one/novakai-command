// NVK-KIMI-081 diagnostic (not a test): replay the live C6 sequence and
// instrument EVERY pump pass in the lawful delivery window.
//
// Sequence replayed:
//   1. spawn a Run with a next-turn-context watcher, fire it -> Notification queued
//   2. a controller attaches and holds the Terminal input lease
//   3. an independent controller provider turn runs to completion (generation bumps)
//   4. the lease is released (durably free)
//   5. every pump pass from here on is the "lawful window" — instrumented
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  mintClientOpId, mintTraceCorrelationId,
  type AuthenticatedPrincipal, type B3Result, type CommandContext,
  type SystemCommandContext,
} from '@novakai/foundation/contract';
import { createFakePtyHost } from '../../../terminal/adapters/pty-host/fake.js';
import { createFakeProviderAdapters } from '../../../agents/b3/contract/index.js';
import { templateDigest, type WatcherTemplate } from '../../../supervision/public/index.js';
import type { AgentRunsContract, ProviderPort } from '../../../agent-runtime/contract/index.js';
import { startRuntimeHost } from '../../core/b3/host.js';
import { connectRuntime } from '../../core/b3/client.js';
import { createNotificationDeliveryPump } from '../../core/b3/notification-delivery-pump.js';
import { governedRole } from '../governed-role.js';

const PRINCIPAL: AuthenticatedPrincipal = {
  id: 'person_chris' as never, kind: 'human', verifiedScopes: [],
};

const humanContext = (): CommandContext => ({
  principal: PRINCIPAL,
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(),
  contractVersion: 1,
});

function template(suffix: string): WatcherTemplate {
  const payload = {
    id: `watch-template/nvk081-${suffix}`,
    version: 1,
    status: 'active',
    subjectBinding: 'current-run',
    condition: { kind: 'idle-for-ms', value: 300_000 },
    recipientBinding: 'current-supervision-assignment-for-escalation',
    deliveryBinding: 'next-turn-context',
    cooldownMs: 0,
  } as const;
  return {
    templateRef: { id: payload.id, version: payload.version, digest: templateDigest(payload) },
    payload,
  };
}

const TEMPLATE = template('window');

function unwrap<Value>(result: B3Result<Value>, label: string): Value {
  if (!result.ok) throw new Error(`${label}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}

const say = (line: string): void => { process.stdout.write(`${line}\n`); };

async function main(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-081-'));
  const ptyHost = createFakePtyHost({ composer: true, echoInput: false });
  const adapters = createFakeProviderAdapters();
  const host = await startRuntimeHost({
    root,
    port: 0,
    ptyHost,
    providers: adapters,
    watcherTemplates: [TEMPLATE],
    notificationDeliveryIntervalMs: 3_600_000,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = unwrap(await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('nvk081-window'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
      supervisionPolicy: {
        activityDrift: 'disabled-explicitly',
        requiredWatcherTemplates: [TEMPLATE.templateRef],
        parentNotificationMode: 'queue-only',
      },
    }), 'create role');
    const spawned = unwrap(await chris.call<{ run: { id: string } }>('b3.agent.spawn', {
      roleProfileId: role.id, displayName: 'NVK081 Window', workingDirectory: root,
    }), 'spawn');
    const agentRunId = spawned.run.id;

    const readRun = async () => unwrap(
      await host.runtime.runs.getAgentRun(PRINCIPAL, agentRunId as never), 'read run',
    );
    const runNow = await readRun();
    const terminalSessionId = runNow.run.terminalSessionId!;
    say(`[setup] run=${agentRunId} session=${String(terminalSessionId)} gen=${String(runNow.run.activityGeneration)}`);

    // 1. Queue the next-turn-context Notification.
    const deadlines = unwrap(
      await host.runtime.supervision.listWatchDeadlines(PRINCIPAL), 'list deadlines',
    );
    const armed = deadlines.filter((deadline) =>
      deadline.subjectKey === `agent-run:${agentRunId}` && deadline.state === 'armed');
    const latest = armed
      .map((deadline) => new Date(String(deadline.dueAt)).getTime())
      .reduce((left, right) => Math.max(left, right), 0);
    const firedAt = new Date(latest + 1).toISOString();
    unwrap(await host.runtime.supervision.evaluateEvent(runtimeContext(), {
      event: {
        eventId: 'evt_nvk081_fire', kind: 'agent.run.changed', schemaVersion: 1,
        occurredAt: firedAt as never, committedAt: firedAt as never,
        sourceOwner: 'agent-runtime', traceId: mintTraceCorrelationId(),
        cursor: 'nvk081-fire' as never, payload: { agentRunId },
      },
    }), 'queue notification');

    const listQueued = async () => {
      const listed = unwrap(
        await host.runtime.supervision.listNotifications(PRINCIPAL, { limit: 50 }),
        'list notifications',
      );
      return listed.items;
    };
    const queued = (await listQueued()).filter((n) => n.deliveryAttempt.state === 'queued');
    say(`[setup] queued notifications: ${String(queued.length)} ${queued.map((n) => `${n.id}/${n.deliveryMode}/fence=${String(n.conditionGeneration)}`).join(', ')}`);

    // 2. A controller attaches and takes the input lease.
    const attachment = unwrap(await host.runtime.terminal.attachController(humanContext(), {
      terminalSessionId, controllerKind: 'human', columns: 120, rows: 40,
    }), 'attach controller');
    const lease = unwrap(await host.runtime.terminal.acquireInputLease(humanContext(), {
      terminalSessionId, attachmentId: attachment.id, mode: 'acquire-if-free', ttlMs: 600_000,
    }), 'acquire lease');
    say(`[setup] lease held: ${String(lease.id)} gen=${String(lease.generation)}`);

    // 3. An independent controller turn, begun and completed.
    const before = await readRun();
    const begun = unwrap(await host.runtime.runs.beginProviderTurn(runtimeContext(), {
      agentRunId: agentRunId as never,
      expectedRecordVersion: before.run.recordVersion,
    }), 'begin turn');
    unwrap(await host.runtime.runs.endProviderTurn(runtimeContext(), {
      agentRunId: agentRunId as never,
      providerTurnId: begun.run.activeProviderTurn!.providerTurnId,
    }), 'end turn');
    const afterTurn = await readRun();
    say(`[setup] controller turn done: gen=${String(afterTurn.run.activityGeneration)} lifecycle=${String(afterTurn.run.lifecycle)} activity=${String(afterTurn.run.activity)} activeTurn=${String(afterTurn.run.activeProviderTurn === undefined ? 'none' : 'present')}`);

    // ---- instrumentation -------------------------------------------------
    let pass = 0;
    const publishes: string[] = [];
    const instrumentedRuns = new Proxy(host.runtime.runs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property !== 'publishCapabilityEvent') return value;
        return async (kind: string, payload: Record<string, unknown>, owner: string, trace?: unknown) => {
          let result: unknown;
          try {
            result = await (value as AgentRunsContract['publishCapabilityEvent'])(
              kind, payload, owner as never, trace as never,
            );
          } catch (error) {
            const line = `pass ${String(pass)} PUBLISH THREW ${kind}: ${String(error)}`;
            publishes.push(line);
            say(`  [publish] ${line}`);
            throw error;
          }
          const ok = (result as { ok: boolean }).ok;
          const line = `pass ${String(pass)} publish ${kind} -> ${ok ? 'ok' : `REFUSED ${String((result as { error: { code: string } }).error.code)}`} payload=${JSON.stringify(payload)}`;
          publishes.push(line);
          say(`  [publish] ${line}`);
          return result;
        };
      },
    }) as AgentRunsContract;

    const terminalCalls: string[] = [];
    const instrumentedTerminal = new Proxy(host.runtime.terminal, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        const watched = new Set([
          'getTerminalSession', 'getNotificationInputReservation',
          'reserveNotificationInput', 'commitReservedNotificationInput',
          'cancelReservedNotificationInput', 'getTerminalInputAttempt',
        ]);
        if (typeof value !== 'function' || !watched.has(String(property))) return value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          const ok = (result as { ok?: boolean }).ok;
          let detail = ok ? 'ok' : `REFUSED ${String((result as { error: { code: string } }).error.code)}`;
          if (ok && String(property) === 'getTerminalSession') {
            const view = (result as { value: { session: { status: string }; activeInputLease?: { id: string; state: string } } }).value;
            detail = `ok status=${view.session.status} lease=${view.activeInputLease === undefined ? 'none' : `${String(view.activeInputLease.id)}/${String(view.activeInputLease.state)}`}`;
          }
          const line = `pass ${String(pass)} terminal.${String(property)} -> ${detail}`;
          terminalCalls.push(line);
          say(`  [terminal] ${line}`);
          return result;
        };
      },
    });

    const supervisionCalls: string[] = [];
    const instrumentedSupervision = new Proxy(host.runtime.supervision, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        const watched = new Set([
          'claimNotificationDelivery', 'recordNotificationDeliveryOutcome',
          'recordDriftStatusSubmission',
        ]);
        if (typeof value !== 'function' || !watched.has(String(property))) return value;
        return async (...args: unknown[]) => {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          const ok = (result as { ok?: boolean }).ok;
          const line = `pass ${String(pass)} supervision.${String(property)} -> ${ok ? 'ok' : `REFUSED ${String((result as { error: { code: string } }).error.code)}`}`;
          supervisionCalls.push(line);
          say(`  [supervision] ${line}`);
          return result;
        };
      },
    });

    const reported: string[] = [];
    const pump = createNotificationDeliveryPump({
      supervision: instrumentedSupervision,
      runs: instrumentedRuns,
      terminal: instrumentedTerminal,
      providers: {
        deliverTurn: (provider: 'claude' | 'codex' | 'kimi', text: string) =>
          adapters[provider].deliverTurn(text),
      } as ProviderPort,
      reportFailure: (message) => {
        reported.push(`pass ${String(pass)} ${message}`);
        say(`  [report] pass ${String(pass)} ${message}`);
      },
    });

    const drive = async (label: string): Promise<void> => {
      pass += 1;
      say(`--- pass ${String(pass)} (${label}) ---`);
      try {
        const outcome = await pump.deliverOnce();
        say(`  [pass] considered=${String(outcome.considered)} delivered=${String(outcome.delivered)} failures=${JSON.stringify(outcome.failures)}`);
      } catch (error) {
        say(`  [pass] THREW: ${String(error)}`);
      }
    };

    // Pre-window: the lease is held. Two passes, so on-change dedupe settles.
    await drive('lease held');
    await drive('lease held');

    // 4. Free the lease — the lawful window opens here.
    unwrap(await host.runtime.terminal.releaseInputLease(humanContext(), {
      terminalSessionId, attachmentId: attachment.id, leaseId: lease.id, generation: lease.generation,
    }), 'release lease');
    const view = unwrap(
      await host.runtime.terminal.getTerminalSession(PRINCIPAL, terminalSessionId), 'read session',
    );
    const windowRun = await readRun();
    say(`[window] session status=${String(view.session.status)} lease=${view.activeInputLease === undefined ? 'FREE' : 'HELD'}`);
    say(`[window] run lifecycle=${String(windowRun.run.lifecycle)} activity=${String(windowRun.run.activity)} gen=${String(windowRun.run.activityGeneration)} activeTurn=${windowRun.run.activeProviderTurn === undefined ? 'none' : 'present'}`);

    // 5. The window.
    await drive('WINDOW 1');
    await drive('WINDOW 2');
    await drive('WINDOW 3');

    const still = (await listQueued()).filter((n) => n.deliveryAttempt.state === 'queued');
    say(`[after] still queued: ${String(still.length)}`);
    say(`[after] pty turns delivered: ${String(ptyHost.latest().turns.length)}`);
    say(`[after] publishes:\n${publishes.map((l) => `    ${l}`).join('\n') || '    (none)'}`);
    say(`[after] reports:\n${reported.map((l) => `    ${l}`).join('\n') || '    (none)'}`);
    await pump.stop();
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
