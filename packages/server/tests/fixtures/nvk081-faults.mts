// NVK-KIMI-081 diagnostic part 2 (not a test): which mechanism can make ONE
// Notification invisible for a whole lawful window while the pump keeps
// publishing for everything else?
//
// Same real composition as nvk081-diag.mts. The window is entered with a
// blocked reserve (the live prime suspect: the terminal live-registry split),
// so the window produces a REFUSAL outcome every pass rather than a delivery.
// Three faults are injected one at a time.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  b3err, b3fail, mintClientOpId, mintTraceCorrelationId,
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
  principal: PRINCIPAL, clientOpId: mintClientOpId(),
  traceId: mintTraceCorrelationId(), contractVersion: 1,
});
const runtimeContext = (): SystemCommandContext<'sys_agent_runtime'> => ({
  principal: { id: 'sys_agent_runtime', kind: 'system', verifiedScopes: [] },
  clientOpId: mintClientOpId(), traceId: mintTraceCorrelationId(), contractVersion: 1,
});

function template(suffix: string): WatcherTemplate {
  const payload = {
    id: `watch-template/nvk081-${suffix}`, version: 1, status: 'active',
    subjectBinding: 'current-run', condition: { kind: 'idle-for-ms', value: 300_000 },
    recipientBinding: 'current-supervision-assignment-for-escalation',
    deliveryBinding: 'next-turn-context', cooldownMs: 0,
  } as const;
  return {
    templateRef: { id: payload.id, version: payload.version, digest: templateDigest(payload) },
    payload,
  };
}
const TEMPLATE = template('faults');

function unwrap<Value>(result: B3Result<Value>, label: string): Value {
  if (!result.ok) throw new Error(`${label}: ${result.error.code} — ${result.error.message}`);
  return result.value;
}
const say = (line: string): void => { process.stdout.write(`${line}\n`); };

type Fault = 'none' | 'publish-refuses-once' | 'publish-throws-once';

async function scenario(fault: Fault): Promise<void> {
  say(`\n================ FAULT: ${fault} ================`);
  const root = mkdtempSync(path.join(tmpdir(), 'nvk-b3d-081f-'));
  const ptyHost = createFakePtyHost({ composer: true, echoInput: false });
  const adapters = createFakeProviderAdapters();
  const host = await startRuntimeHost({
    root, port: 0, ptyHost, providers: adapters,
    watcherTemplates: [TEMPLATE], notificationDeliveryIntervalMs: 3_600_000,
  });
  const chris = await connectRuntime({ root, port: host.port, token: host.token });
  try {
    const role = unwrap(await chris.call<{ id: string }>('b3.agent.createRole', {
      ...governedRole('nvk081-faults'),
      skillsConfirmationGate: { mode: 'disabled', allowedFor: 'interactive-chat-only' },
      supervisionPolicy: {
        activityDrift: 'disabled-explicitly',
        requiredWatcherTemplates: [TEMPLATE.templateRef],
        parentNotificationMode: 'queue-only',
      },
    }), 'create role');
    const spawned = unwrap(await chris.call<{ run: { id: string } }>('b3.agent.spawn', {
      roleProfileId: role.id, displayName: 'NVK081 Faults', workingDirectory: root,
    }), 'spawn');
    const agentRunId = spawned.run.id;
    const readRun = async () => unwrap(
      await host.runtime.runs.getAgentRun(PRINCIPAL, agentRunId as never), 'read run',
    );
    const terminalSessionId = (await readRun()).run.terminalSessionId!;

    const deadlines = unwrap(
      await host.runtime.supervision.listWatchDeadlines(PRINCIPAL), 'list deadlines',
    );
    const latest = deadlines
      .filter((d) => d.subjectKey === `agent-run:${agentRunId}` && d.state === 'armed')
      .map((d) => new Date(String(d.dueAt)).getTime())
      .reduce((left, right) => Math.max(left, right), 0);
    const firedAt = new Date(latest + 1).toISOString();
    unwrap(await host.runtime.supervision.evaluateEvent(runtimeContext(), {
      event: {
        eventId: 'evt_nvk081f', kind: 'agent.run.changed', schemaVersion: 1,
        occurredAt: firedAt as never, committedAt: firedAt as never,
        sourceOwner: 'agent-runtime', traceId: mintTraceCorrelationId(),
        cursor: 'nvk081f' as never, payload: { agentRunId },
      },
    }), 'queue notification');

    const attachment = unwrap(await host.runtime.terminal.attachController(humanContext(), {
      terminalSessionId, controllerKind: 'human', columns: 120, rows: 40,
    }), 'attach');
    const lease = unwrap(await host.runtime.terminal.acquireInputLease(humanContext(), {
      terminalSessionId, attachmentId: attachment.id, mode: 'acquire-if-free', ttlMs: 600_000,
    }), 'acquire lease');
    const before = await readRun();
    const begun = unwrap(await host.runtime.runs.beginProviderTurn(runtimeContext(), {
      agentRunId: agentRunId as never, expectedRecordVersion: before.run.recordVersion,
    }), 'begin turn');
    unwrap(await host.runtime.runs.endProviderTurn(runtimeContext(), {
      agentRunId: agentRunId as never,
      providerTurnId: begun.run.activeProviderTurn!.providerTurnId,
    }), 'end turn');

    // ---- instrumentation + injection ------------------------------------
    let pass = 0;
    let windowOpen = false;
    let faultFired = false;
    const events: string[] = [];

    const instrumentedRuns = new Proxy(host.runtime.runs, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property !== 'publishCapabilityEvent') return value;
        return async (kind: string, payload: Record<string, unknown>, owner: string) => {
          if (windowOpen && !faultFired && fault !== 'none') {
            faultFired = true;
            if (fault === 'publish-throws-once') {
              say(`  [publish] pass ${String(pass)} INJECTED THROW for ${kind}`);
              throw new Error('injected publish failure');
            }
            say(`  [publish] pass ${String(pass)} INJECTED REFUSAL for ${kind}`);
            return b3fail(b3err('StorageUnavailable', 'injected', {}, true));
          }
          const result = await (value as AgentRunsContract['publishCapabilityEvent'])(
            kind, payload, owner as never,
          );
          const line = `pass ${String(pass)} ${kind} reason=${String(payload['reason'] ?? payload['code'] ?? '')} -> ${result.ok ? 'ok' : 'refused'}`;
          events.push(line);
          say(`  [publish] ${line}`);
          return result;
        };
      },
    }) as AgentRunsContract;

    // The window's block: the terminal live-registry split. Real durable state
    // says live and the lease is free; reserve refuses. This is the shape the
    // live run was in — a REFUSAL outcome, not a delivery.
    const instrumentedTerminal = new Proxy(host.runtime.terminal, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        if (property !== 'reserveNotificationInput') return value;
        return async (...args: unknown[]) => {
          if (windowOpen) {
            say(`  [terminal] pass ${String(pass)} reserveNotificationInput -> INJECTED TerminalNotLive`);
            return b3fail(b3err('TerminalNotLive', 'the terminal has no live process', {
              terminalSessionId: String(terminalSessionId), status: 'live',
            }, false));
          }
          return (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        };
      },
    });

    const reported: string[] = [];
    const pump = createNotificationDeliveryPump({
      supervision: host.runtime.supervision,
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
        say(`  [pass] THREW OUT OF THE PUMP: ${String(error)}`);
      }
    };

    await drive('lease held');
    unwrap(await host.runtime.terminal.releaseInputLease(humanContext(), {
      terminalSessionId, attachmentId: attachment.id,
      leaseId: lease.id, generation: lease.generation,
    }), 'release lease');
    windowOpen = true;
    say('[window] lease released — lawful window open, reserve blocked by the registry split');

    const eventsBefore = events.length;
    await drive('WINDOW 1');
    await drive('WINDOW 2');
    await drive('WINDOW 3');
    await drive('WINDOW 4');
    const inWindow = events.length - eventsBefore;
    say(`[VERDICT] durable events published for this Notification during the window: ${String(inWindow)}`);

    // After the window the state changes (the block clears differently): does
    // the pump start publishing for this Notification again?
    windowOpen = false;
    await drive('AFTER (block cleared)');
    await pump.stop();
  } finally {
    chris.close();
    await host.close();
    rmSync(root, { recursive: true, force: true });
  }
}

for (const fault of ['none', 'publish-refuses-once', 'publish-throws-once'] as const) {
  await scenario(fault);
}
