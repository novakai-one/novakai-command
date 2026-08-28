/** Novakai Server composition root: the ordered boot steps. Step numbers are
 *  stable identifiers — removed capabilities (3 messaging, 10 spine) leave
 *  gaps rather than renumbering the steps operators and tests know. */

import { randomUUID } from 'node:crypto';
import { recordSystemAction } from '@novakai/foundation/dist/contract/index.js';
import type { FocusSnapshot } from '../../shell/contract/context.js';
import { startTransport, type RunningTransport } from './transport/server.js';
import { buildMethods, type ServerRuntime } from './methods.js';
import { composeB3Wire } from './b3/runtime-wire.js';
import { composePrincipals } from './boot/principals.js';
import { composeCapabilities } from './boot/capabilities.js';
import { hydrateConversations } from './boot/conversation-hydration.js';
import { prepareSessions } from './boot/session-sweep.js';
import { runCapabilityBoot } from './boot/boot-traces.js';
import { composeSupervision } from './boot/supervision-wire.js';
import { wireTurnAccounting } from './boot/turn-accounting.js';
import { wireTranscriptEvents } from './boot/transcript-events.js';
import type { BootOptions, BootResult, BootStep } from './boot/contract.js';
import { refuse } from './boot/contract.js';

export type {
  BootError,
  BootOptions,
  BootResult,
  BootStep,
  NovakaiServer,
} from './boot/contract.js';

export async function bootServer(options: BootOptions): Promise<BootResult> {
  const steps: BootStep[] = [];
  const note = (step: number, name: string, detail: string): void => {
    steps.push({ step, name, detail });
    console.log(`[nvk-server] step ${step} ${name}: ${detail}`);
  };
  const cwd = options.cwd ?? process.cwd();

  const principals = await composePrincipals(options, note);
  if (!principals.ok) return principals.result;
  const { configStore, human, persistence } = principals;
  let config = principals.config;

  const capabilities = await composeCapabilities({
    options,
    note,
    configStore,
    humanPersonId: human.personId,
    cwd,
  });
  const {
    agentsCtx,
    agents,
    kimiRuntime,
    providerRuntimes,
    transcript,
  } = capabilities;
  const transcriptHost = { runtime: transcript.runtime };
  const stopMessaging = async (): Promise<void> => {
    await transcript.runtime.stop();
    await transcript.close();
  };
  const hydrated = await hydrateConversations(
    persistence.conversationViewDriver,
    transcript.runtime,
    human.personId,
  );
  const appendSystemAction = options.recordSystemAction ?? recordSystemAction;
  const prepared = await prepareSessions({
    options,
    note,
    config,
    human,
    persistence,
    conversationCount: hydrated.conversations.size,
    agentsCtx,
    appendSystemAction,
  });
  const { sessions, sweep, b2a } = prepared;

  const capabilityFailure = await runCapabilityBoot({
    b2a,
    transcript: transcriptHost,
    stopMessaging,
    persistence,
    appendSystemAction,
    note,
  });
  if (capabilityFailure) return capabilityFailure;

  const runtimeRef: { current?: ServerRuntime } = {};
  const supervisionWire = await composeSupervision({
    options,
    config,
    sessions,
    agents,
    providerRuntimes,
    persistence,
    appendSystemAction,
    note,
    broadcast(name, data) {
      runtimeRef.current?.broadcast(name, data);
    },
  });
  const { supervision, watchdog, usageReader } = supervisionWire;
  const runtime: ServerRuntime = {
    root: options.root,
    cwd,
    human: { personId: human.personId },
    agents,
    kimiRuntime,
    providerRuntimes,
    sessions,
    supervision,
    watchdog,
    b2a,
    transcript: transcriptHost,
    persistence,
    conversations: hydrated.conversations,
    configStore,
    config,
    focus: { app: 'messaging', ref: 'none' } as FocusSnapshot,
    broadcast: () => undefined,
    mintOpId: () => `op_${randomUUID()}`,
  };
  runtimeRef.current = runtime;

  await wireTurnAccounting({ providerRuntimes, sessions, usageReader });

  const b3Wire = await composeB3Wire({
    ...(options.b3 ?? {}),
    root: options.root,
    messagingRuntime: transcript.runtime,
    providerAgents: agents,
    publish(kind, payload) {
      if (kind === 'conversation.created') runtime.broadcast('conversation', payload);
    },
  });
  note(12, 'runtime', `b3.* composed on ${b3Wire.runtime.dataRoot}`);
  const methods = { ...buildMethods(runtime), ...b3Wire.methods };
  const transport: RunningTransport = await startTransport({
    root: options.root,
    port: options.port,
    ...(options.staticDir ? { staticDir: options.staticDir } : {}),
    methods,
    artifacts: b2a.artifacts,
    identifyCaller: b3Wire.identifyCaller,
    onDispatch: b3Wire.onDispatch,
    onDisconnect: b3Wire.onDisconnect,
  });
  runtime.broadcast = (name, data) => transport.broadcast(name, data);
  const transcriptEvents = wireTranscriptEvents(runtime);
  try {
    await b3Wire.serve(transport);
  } catch (cause) {
    await transport.close();
    await b3Wire.close();
    await stopMessaging();
    return refuse(
      'RuntimeUnavailable',
      `the B3 Runtime for ${options.root} refused to start: `
        + `${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  agents.subscribeAgentEvents((event) => transport.broadcast('presence', event));
  note(13, 'transport', `listening on ${transport.url} (nvk-ws v1, token-gated)`);
  if (config.transcript.ingest) void transcript.runtime.start();
  if (options.supervisionTimers ?? true) supervision.start();

  config = configStore.current();
  const configWatcher = configStore.watch((next) => {
    config = next;
    runtime.config = next;
  });
  return {
    ok: true,
    value: {
      url: transport.url,
      port: transport.port,
      token: transport.token,
      steps,
      interrupted: sweep.interrupted,
      sessions,
      supervision,
      get config() { return configStore.current(); },
      runtime,
      async close() {
        supervision.stop();
        configWatcher.close();
        transcriptEvents.close();
        await transport.close();
        await b3Wire.close();
        await stopMessaging();
      },
    },
  };
}
