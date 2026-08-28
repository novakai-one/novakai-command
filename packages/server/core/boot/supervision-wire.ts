/** Boot step 11: compose supervision over the ProviderSession registry. */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type {
  AgentsContract,
  ProviderCliRuntime,
  ProviderSessionRegistry,
} from '../../../agents/contract/index.js';
import type { composeShellPersistence } from '../../../shell/contract/persistence.node.js';
import type { ServerConfig, ProviderName } from '../../contract/config.js';
import { createSupervisionEngine, type SupervisionRecord } from '../supervision/engine.js';
import { createUsageLog } from '../supervision/log.js';
import { createSupervisedTransport } from '../supervision/transport.js';
import { createUsageReader } from '../supervision/usage.js';
import { createWatchdogHook } from '../supervision/watchdog.js';
import type { BootNote, BootOptions } from './contract.js';

export async function composeSupervision(input: {
  options: BootOptions;
  config: ServerConfig;
  sessions: ProviderSessionRegistry;
  agents: AgentsContract;
  providerRuntimes: Partial<Record<ProviderName, ProviderCliRuntime>>;
  persistence: ReturnType<typeof composeShellPersistence>;
  appendSystemAction: typeof recordSystemAction;
  note: BootNote;
  broadcast(name: string, data: unknown): void;
}) {
  const { options, config, sessions, agents } = input;
  const watchdog = createWatchdogHook(options.watchdogDir ?? options.root);
  const usageReader = createUsageReader({
    ...(options.providerHome ? { home: options.providerHome } : {}),
    transcriptRoot: path.join(options.root, 'transcripts'),
    discoveryIntervalMs:
      Math.min(config.supervision.usageIntervalSec, config.supervision.driftIntervalSec) * 1000,
  });
  const usageLog = createUsageLog(options.root);
  const supervisionSessions = {
    list: async (): Promise<SupervisionRecord[]> =>
      (await sessions.list()) as SupervisionRecord[],
    get: async (id: string): Promise<SupervisionRecord | null> =>
      (await sessions.get(id)) as SupervisionRecord | null,
    close: async (id: string, status: 'closed' | 'exited') => {
      const result = await sessions.close(id, status);
      return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
    },
    recordUsage: async (
      id: string,
      usage: Parameters<ProviderSessionRegistry['recordUsage']>[1],
    ) => {
      const result = await sessions.recordUsage(id, usage);
      return result.ok ? { ok: true as const } : { ok: false as const, error: result.error };
    },
  };
  const transport = createSupervisedTransport({
    agents: {
      sendToSession: (sessionId, value) => agents.sendToSession(sessionId as never, value),
    },
    runtimes: input.providerRuntimes,
    providerOf: async (sessionId) => (await sessions.get(sessionId))?.provider ?? null,
  });
  const supervision = createSupervisionEngine({
    sessions: supervisionSessions,
    lifecycle: {
      closeSession: (sessionId) => agents.closeSession(sessionId as never),
      async spawnFresh(value) {
        const spawned = await agents.spawnAgent(value.agentId as never) as {
          ok: boolean;
          value?: { sessionId: string; model: string };
          error?: { code?: string; message?: string };
        };
        if (!spawned.ok || !spawned.value) {
          return {
            ok: false as const,
            error: {
              code: spawned.error?.code ?? 'SpawnFailed',
              message: spawned.error?.message ?? 'spawn failed',
            },
          };
        }
        const resumed = Boolean(value.resumeFrom) && agents.reattachSession({
          sessionId: spawned.value.sessionId,
          agentId: value.agentId,
          provider: value.provider,
          providerConversationId: value.resumeFrom ?? null,
          model: spawned.value.model || 'cli-default',
          cwd: value.cwd,
        });
        const registered = await sessions.register({
          sessionId: spawned.value.sessionId,
          agentId: value.agentId,
          provider: value.provider,
          cwd: value.cwd,
          model: spawned.value.model || 'cli-default',
          providerConversationId: resumed ? value.resumeFrom ?? null : null,
        });
        if (!registered.ok) {
          return {
            ok: false as const,
            error: { code: registered.error.code, message: registered.error.message },
          };
        }
        return { ok: true as const, value: { ...spawned.value, resumed } };
      },
    },
    transport,
    usage: usageReader,
    trace: (value) => input.appendSystemAction(input.persistence.handle, {
      action: value.action,
      target: value.target as never,
      clientOpId: (value.clientOpId ?? `op_${randomUUID()}`) as never,
      ...(value.meta ? { meta: value.meta } : {}),
    }),
    broadcast: input.broadcast,
    async appendUsage(rows) {
      const failure = usageLog.append({ at: new Date().toISOString(), rows });
      if (failure) console.error(`[nvk-server] usage.jsonl append failed: ${failure}`);
    },
    async escalate(text) {
      // The old person-to-person messaging lane is gone; an escalation is a
      // broadcast to every connected shell plus an operator log line.
      console.error(`[nvk-server] ⚠️ supervision escalation: ${text}`);
      input.broadcast('supervision-escalation', { text });
    },
    policy: config.supervision,
    skillPaths: await registeredSkillPaths(agents),
    onTraceFailure: (reason) => console.error(`[nvk-server] ${reason}`),
    onFailure: (failure) => console.error(
      `[nvk-server] supervision ${failure.operation} failed `
        + `(${failure.code}): ${failure.message}`,
    ),
  });
  input.note(
    11,
    'supervision',
    `engine up — usage every ${config.supervision.usageIntervalSec}s; drift checks are explicit only; log at ${usageLog.filePath}; watchdog registry at ${watchdog.registryPath}`,
  );
  return { supervision, watchdog, usageReader };
}

async function registeredSkillPaths(agents: AgentsContract): Promise<string[]> {
  const listed = await agents.listSkills() as {
    ok: boolean;
    value?: { items: Array<{ path?: string }> };
  };
  if (!listed.ok || !listed.value) return [];
  return listed.value.items
    .map((skill) => skill.path)
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
}
